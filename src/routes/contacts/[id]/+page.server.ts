import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getMailProvider } from '$lib/server/mail';
import { enrollContactsInAutomation, listActiveAutomations, restartEnrollment } from '$lib/server/automations';
import { enrollSkipReason } from '$lib/server/enroll-reason';
import { addTagAndEnroll } from '$lib/server/contacts';
import { syncCompanyMembership } from '$lib/server/companies';
import { safeMetaJson } from '$lib/server/meta';
import { customFieldByKey, listCustomFields } from '$lib/server/custom-fields';
import { valueProblem, type FieldOption } from '$lib/custom-fields';
import { guardReportUrl, keyedContactReportUrl, reportHost } from '$lib/server/report-url';
import { snapshot } from '$lib/server/snapshot';
import { isEmail } from '$lib/csv';
import { conversationsFor } from '$lib/server/conversations';
import { companyTiming } from '$lib/server/integrations/timing';
import { githubMetrics } from '$lib/server/integrations/github';
import { mergeTimeline, setTrackingOptout, siteActivitySummary, siteTimeline } from '$lib/server/site-activity';
import { archiveContacts, restoreContacts } from '$lib/server/contact-archive';
import { engagementProfile } from '$lib/server/engagement-query';
import { automationNameFromSource, setTierOverride } from '$lib/server/tier-override';
import { normalizeTierOverride } from '$lib/tier-override';
import { cardFor, historyFor, listStages } from '$lib/server/pipeline';
import { historyByText, historyMoveText } from '$lib/pipeline';
import { runPipelineAction } from '$lib/server/pipeline-form';
import { stepTitles, timelineFor } from '$lib/server/automation-flow';
import { adjustScore, contactScores } from '$lib/server/scoring/contact';
import { contactRatings } from '$lib/server/contact-ratings';
import { contactFormSubmissions } from '$lib/server/form-reads';
import { validateAdjust } from '$lib/scoring';
import { cancelPending, pendingInfo, resendForContact } from '$lib/server/double-optin';
import { bulkResubscribe, bulkUnsubscribe } from '$lib/server/contact-bulk';
import { OPERATOR_UNSUB_REASON, UNSUBSCRIBE_REASONS } from '$lib/unsubscribe-page';

type Contact = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
	company_id: number | null;
	subscribed: number;
	confirm_pending: number;
	source: string | null;
	created_at: string;
	meta: string | null;
	tracking_optout: number;
	archived_at: string | null;
};

type EnrollmentRow = {
	id: number;
	automation_id: number;
	automation_name: string;
	status: string;
	enrolled_at: string;
	ended_at: string | null;
	next_run_at: string | null;
	last_error: string | null;
	step_type: string | null;
	step_subject: string | null;
	step_tag_name: string | null;
	step_tag_action: string | null;
	step_position: number | null;
	completed_reason: string | null; // #397: 'goal:<kind>'
};

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	if (!id) throw error(404, 'Contact not found');

	const contact = await db
		.prepare(
			`SELECT id, email, name, first_name, last_name, company, company_id, subscribed, confirm_pending, source, created_at, meta, tracking_optout, archived_at
			 FROM contacts WHERE id = ?`
		)
		.bind(id)
		.first<Contact>();
	if (!contact) throw error(404, 'Contact not found');

	// The contact's company group (kind='company'), if any — to link the name to its members.
	let companyGroupId: number | null = null;
	if (contact.company) {
		const cg = await db
			.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'company'")
			.bind(contact.company)
			.first<{ id: number }>();
		companyGroupId = cg?.id ?? null;
	}

	// Company card (#168): the linked company's name + its Timing numbers, if any.
	let companyCard: { id: number; name: string; timing: Awaited<ReturnType<typeof companyTiming>> } | null = null;
	if (contact.company_id) {
		const co = await db
			.prepare('SELECT id, name FROM companies WHERE id = ?')
			.bind(contact.company_id)
			.first<{ id: number; name: string }>();
		if (co) companyCard = { ...co, timing: await companyTiming(db, co.id) };
	}

	// Conversations (#157) replace the Email history list: one row per thread (a send plus
	// the replies it got), paged in the URL (?hpage=) like the old history (#107). The summary
	// metrics above (sent/opened/clicked) must reflect the WHOLE history, so they stay a
	// separate aggregate query.
	const HPER = 20;
	let hpage = Math.floor(Number(event.url.searchParams.get('hpage')) || 1);
	if (hpage < 1) hpage = 1;

	const summaryRow = await db
		.prepare(
			`SELECT
			   COUNT(*) AS sent,
			   SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.type = 'open') THEN 1 ELSE 0 END) AS opened,
			   SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.type = 'click') THEN 1 ELSE 0 END) AS clicked
			 FROM recipients r
			 WHERE r.contact_id = ? AND COALESCE(r.status, '') NOT IN ('queued', 'sending')`
		)
		.bind(id)
		.first<{ sent: number; opened: number; clicked: number }>();
	const summary = summaryRow ?? { sent: 0, opened: 0, clicked: 0 };
	const allConversations = await conversationsFor(db, id);
	const historyTotal = allConversations.length;
	const historyPageCount = Math.max(1, Math.ceil(historyTotal / HPER));
	if (hpage > historyPageCount) hpage = historyPageCount;
	const historyOffset = (hpage - 1) * HPER;
	const conversations = allConversations.slice(historyOffset, historyOffset + HPER);

	// Lists / segments / tags this contact belongs to (all live in list_members).
	const membershipRows = await db
		.prepare(
			`SELECT l.id, l.name, l.kind, l.archived_at
			 FROM list_members lm
			 JOIN lists l ON l.id = lm.list_id
			 WHERE lm.contact_id = ?
			 ORDER BY l.kind, l.name`
		)
		.bind(id)
		.all<{ id: number; name: string; kind: string; archived_at: string | null }>();
	// Tags are kind='tag'; keep them separate from lists/segments in the UI.
	const tags = membershipRows.results.filter((m) => m.kind === 'tag');
	const memberships = membershipRows.results.filter((m) => m.kind !== 'tag');

	// All existing tag names, for the add-tag autocomplete.
	const tagOptions = await db
		.prepare("SELECT name FROM lists WHERE kind = 'tag' ORDER BY name")
		.all<{ name: string }>();

	// Replies this contact sent back (captured via inbound).
	const replies = await db
		.prepare(
			`SELECT id, campaign_id, subject, text, received_at
			 FROM replies WHERE contact_id = ? ORDER BY received_at DESC`
		)
		.bind(id)
		.all<{ id: number; campaign_id: number | null; subject: string | null; text: string | null; received_at: string }>();

	// Our own captured unsubscribe reason(s), if any.
	const unsubs = await db
		.prepare(
			`SELECT campaign_id, reason, detail, created_at
			 FROM unsubscribes
			 WHERE contact_id = ?1 OR email = ?2
			 ORDER BY created_at DESC`
		)
		.bind(id, contact.email)
		.all<{ campaign_id: number | null; reason: string | null; detail: string | null; created_at: string }>();

	// Activity timeline (#69): merge tracking events + replies + site activity (#153) + the
	// 'added' origin into one time-sorted stream.
	const evRows = await db
		.prepare(
			`SELECT e.type, e.recorded_at AS at, e.campaign_id, c.subject AS subject,
			        json_extract(e.detail, '$.OriginalLink') AS url
			 FROM events e LEFT JOIN campaigns c ON c.id = e.campaign_id
			 WHERE e.contact_id = ? ORDER BY e.recorded_at DESC LIMIT 100`
		)
		.bind(id)
		.all<{ type: string; at: string; campaign_id: number | null; subject: string | null; url: string | null }>();

	// #604: snapshot approvals join the timeline only while SNAPSHOT_MODE turns snapshots on.
	const approvals = snapshot.enabled(event.platform?.env) ? await snapshot.contactApprovals(db, id) : [];

	const [siteRows, siteActivity, engagement, pipeline, pipelineStages, pipelineHistory] = await Promise.all([
		siteTimeline(db, id),
		siteActivitySummary(db, id),
		engagementProfile(db, id),
		cardFor(db, id), // Pipeline card (#206): stage + last 5 history rows
		listStages(db),
		historyFor(db, id, 100) // Activity timeline rows (#207)
	]);

	const activity = mergeTimeline([
		approvals.map((row) => ({
			kind: 'snapshot_approved',
			at: row.approved_at,
			campaign_id: null,
			label:
				row.approved_via === 'link' || row.approved_via === 'reply'
					? `via ${row.approved_via} · ${row.domain}`
					: row.approved_via || row.domain,
			url: null
		})),
		evRows.results.map((e) => ({
			kind: e.type,
			at: e.at,
			campaign_id: e.campaign_id,
			label: e.subject ?? (e.campaign_id ? `campaign #${e.campaign_id}` : ''),
			url: e.url
		})),
		replies.results.map((r) => ({
			kind: 'reply',
			at: r.received_at,
			campaign_id: r.campaign_id,
			label: r.subject ?? '(reply)',
			url: null
		})),
		siteRows,
		pipelineHistory.map((h) => ({
			kind: 'pipeline',
			at: h.created_at,
			campaign_id: null,
			label: `${historyMoveText(h)} · ${historyByText(h)}`,
			url: null
		})),
		[{ kind: 'added', at: contact.created_at, campaign_id: null, label: contact.source ? `via ${contact.source}` : '', url: null }]
	], 60);

	// Automation passes (active + historical) for this contact. A contact can have
	// multiple rows per automation (re-entry, migration 0028) — show them all.
	const enrollments = await db
		.prepare(
			`SELECT en.id,
			        en.automation_id,
			        a.name AS automation_name,
			        en.status,
			        en.enrolled_at,
			        en.ended_at,
			        en.next_run_at,
			        en.last_error,
			        s.type AS step_type,
			        s.subject AS step_subject,
			        s.tag_name AS step_tag_name,
			        s.tag_action AS step_tag_action,
			        s.position AS step_position,
			        en.completed_reason
			 FROM automation_enrollments en
			 JOIN automations a ON a.id = en.automation_id
			 LEFT JOIN automation_steps s ON s.id = en.current_step_id
			 WHERE en.contact_id = ?
			 ORDER BY CASE WHEN en.status = 'active' THEN 0 ELSE 1 END,
			          COALESCE(en.ended_at, en.enrolled_at) DESC`
		)
		.bind(id)
		.all<EnrollmentRow>();
	// #397: each pass's full path with timestamps (the appended timeline).
	const enrollmentTimeline = await timelineFor(db, enrollments.results.map((e) => e.id));
	const timelineStepTitles = await stepTitles(
		db,
		[...enrollmentTimeline.values()].flat().map((ev) => ev.step_id ?? 0)
	);

	// Extra form-payload fields captured at ingest (tier, score, details, ...).
	let formData: [string, string][] = [];
	try {
		if (contact.meta) {
			formData = Object.entries(JSON.parse(contact.meta) as Record<string, unknown>).map(
				([k, v]) => [k, String(v)]
			);
		}
	} catch {
		/* malformed meta — just hide the section */
	}
	// #619: only fields this contact has a value for get a row — defined ones first (position
	// order, typed inputs; an archived definition still labels its value), undefined keys after.
	// "+ Add field" offers the active definitions without a value here.
	const defs = await listCustomFields(db, { includeArchived: true });
	const values = new Map(formData);
	const hasValue = (key: string) => (values.get(key) ?? '').trim() !== '';
	const definedFields = defs
		.filter((f) => hasValue(f.key))
		.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, archived: f.archived_at !== null, value: values.get(f.key) ?? '' }));
	const addableFields: FieldOption[] = defs
		.filter((f) => !f.archived_at && !hasValue(f.key))
		.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options }));
	const definedKeys = new Set(defs.map((f) => f.key));
	formData = formData.filter(([k]) => !definedKeys.has(k));

	return {
		contact,
		companyGroupId,
		companyCard,
		// The linked company's GitHub summary (#169), null until its repos have synced.
		companyGithub: contact.company_id ? await githubMetrics(db, contact.company_id) : null,
		formData,
		definedFields,
		addableFields,
		conversations,
		historyPage: hpage,
		historyPer: HPER,
		historyTotal,
		historyPageCount,
		memberships,
		tags,
		tagOptions: tagOptions.results.map((t) => t.name),
		enrollments: enrollments.results,
		enrollmentTimeline: Object.fromEntries(enrollmentTimeline),
		timelineStepTitles: Object.fromEntries(timelineStepTitles),
		activeAutomations: await listActiveAutomations(db),
		unsubs: unsubs.results,
		activity,
		siteActivity,
		engagement,
		// #460: "set by automation “X”" — the name of the automation that set the override.
		tierSourceName: await automationNameFromSource(db, engagement.tier_override_source),
		pipeline,
		pipelineStages,
		// Scores card (#466): active custom scores + their last ledger rows; Adjust is admin-only.
		scores: await contactScores(db, id),
		// Ratings card (#589): ratings given through forms, newest first (card hidden when none).
		ratings: await contactRatings(db, id),
		// Forms card (#516): their form submissions, newest first (card hidden when none).
		formSubmissions: await contactFormSubmissions(db, id),
		isAdmin: event.locals?.user?.role === 'admin',
		// #510: double opt-in — sent date + re-sends for the Pending confirmation badge.
		confirmation: contact.confirm_pending ? await pendingInfo(db, id) : null,
		summary
	};
};

const SUB_NOTE_MAX = 200;

const pipelineAct =
	(action: 'add' | 'move' | 'mark' | 'remove'): NonNullable<Actions[string]> =>
	async (event) =>
		runPipelineAction(getDB(event), event.locals, action, await event.request.formData(), Number(event.params.id) || null);

export const actions: Actions = {
	// Pipeline card (#206) — same helpers as /pipeline, scoped to this contact.
	pipelineAdd: pipelineAct('add'),
	pipelineMove: pipelineAct('move'),
	pipelineMark: pipelineAct('mark'),
	pipelineRemove: pipelineAct('remove'),

	// Edit core contact details (#44). Email is the identity key (UNIQUE, joined on by
	// recipients/webhooks/unsubscribe) — normalize + reject collisions instead of 500ing.
	updateDetails: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();

		const email = String(data.get('email') ?? '').trim().toLowerCase();
		if (!isEmail(email)) return fail(400, { detailError: 'Enter a valid email address.' });

		const clash = await db
			.prepare('SELECT id FROM contacts WHERE email = ? AND id != ?')
			.bind(email, id)
			.first<{ id: number }>();
		if (clash) {
			return fail(409, { detailError: `Another contact (#${clash.id}) already uses ${email}.` });
		}

		const norm = (v: FormDataEntryValue | null) => String(v ?? '').trim() || null;
		const name = norm(data.get('name'));
		const first = norm(data.get('first_name'));
		const last = norm(data.get('last_name'));
		const company = norm(data.get('company'));

		const res = await db
			.prepare(
				`UPDATE contacts
				 SET email = ?, name = ?, first_name = ?, last_name = ?, company = ?
				 WHERE id = ?`
			)
			.bind(email, name, first, last, company, id)
			.run();
		if (!res.meta.changes) return fail(404, { detailError: 'Contact not found.' });
		await syncCompanyMembership(db, id, company); // keep the company group in sync (#47)
		return { detailOk: true };
	},

	// Custom fields: stored as JSON in contacts.meta — same store webhook payload extras
	// land in, so hand-managed and form-captured fields are one system.
	setField: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const name = String(data.get('field_name') ?? '').trim().slice(0, 50);
		const value = String(data.get('field_value') ?? '').trim().slice(0, 500);
		if (!name) return fail(400, { fieldError: 'Field name is required.' });
		// #661: only while a report host is configured (SNAPSHOT_REPORT_HOST); else an ordinary field.
		const host = reportHost();
		if (name === 'report_url' && host && !keyedContactReportUrl(value)) {
			return fail(400, { fieldError: `report_url needs a viewer key on ${host}.` });
		}

		// #619: a defined field checks the value against its type; clearing a typed field removes it.
		const def = await customFieldByKey(db, name);
		const typed = data.get('typed') === '1';
		if (def) {
			const problem = valueProblem(def, value);
			if (problem) return fail(400, { fieldError: problem });
		}

		const row = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(id).first<{ meta: string | null }>();
		if (!row) return fail(404, { fieldError: 'Contact not found.' });
		let meta: Record<string, unknown> = {};
		try {
			meta = row.meta ? JSON.parse(row.meta) : {};
		} catch {
			meta = {};
		}
		if (typed && value === '') delete meta[name];
		else meta[name] = value;
		guardReportUrl(meta);
		await db.prepare('UPDATE contacts SET meta = ? WHERE id = ?').bind(safeMetaJson(meta), id).run();
		return { fieldOk: true };
	},

	removeField: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const name = String((await event.request.formData()).get('field_name') ?? '');
		const row = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(id).first<{ meta: string | null }>();
		if (!row?.meta) return { fieldOk: true };
		try {
			const meta = JSON.parse(row.meta) as Record<string, unknown>;
			delete meta[name];
			await db
				.prepare('UPDATE contacts SET meta = ? WHERE id = ?')
				.bind(Object.keys(meta).length ? JSON.stringify(meta) : null, id)
				.run();
		} catch {
			/* malformed meta — leave as-is */
		}
		return { fieldOk: true };
	},

	// Add a tag to this contact (tag = a list with kind='tag'). Fires the list_added
	// automation trigger via autoEnroll, exactly like the other add-to-list paths.
	addTag: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const name = String((await event.request.formData()).get('tag') ?? '').trim();
		if (!name) return fail(400, { tagError: 'Enter a tag name.' });
		if (name.length > 60) return fail(400, { tagError: 'Tag is too long (60 chars max).' });

		await addTagAndEnroll(db, name, id);
		if (snapshot.enabled(event.platform?.env)) {
			await snapshot.releaseApproved(db, event.platform?.env, [id], name);
		}
		return { tagOk: true };
	},

	removeTag: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const tagId = Number((await event.request.formData()).get('tag_id'));
		if (!tagId) return fail(400, { tagError: 'Missing tag.' });
		await db
			.prepare("DELETE FROM list_members WHERE list_id = ? AND contact_id = ? AND list_id IN (SELECT id FROM lists WHERE kind = 'tag')")
			.bind(tagId, id)
			.run();
		return { tagOk: true };
	},

	// #460: set (or clear, tier=clear) the engagement tier override by hand.
	setTier: async (event) => {
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const n = normalizeTierOverride({ tier: String(data.get('tier') ?? ''), days: String(data.get('days') ?? '').trim() });
		if (!n.ok) return fail(400, { tierError: n.error });
		const login = event.locals?.user?.github_login ?? '';
		await setTierOverride(getDB(event), [id], { ...n.value, source: `user:${login}` });
		return { tierOk: true };
	},

	// #466: admin-only manual score adjustment → a `manual` ledger row, recomputed inline.
	adjustScore: async (event) => {
		const user = event.locals?.user ?? null;
		if (user?.role !== 'admin') return fail(403, { scoreError: 'Admins only.' });
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const scoreId = Number(data.get('score_id')) || 0;
		const v = validateAdjust({ points: data.get('points'), expires_days: data.get('expires_days'), note: data.get('note') });
		if (!v.ok) return fail(400, { scoreError: v.error, scoreId });
		const r = await adjustScore(getDB(event), id, scoreId, v.value, user.github_login ?? null);
		if (!r.ok) return fail(404, { scoreError: r.error, scoreId });
		return { scoreOk: true, scoreId };
	},

	// Per-contact Stop tracking toggle (#153): sets contacts.tracking_optout, so site
	// beacons for this contact are dropped from now on. Past events are kept.
	setTrackingOptout: async (event) => {
		const id = Number(event.params.id);
		const optout = (await event.request.formData()).get('optout') === '1';
		if (!(await setTrackingOptout(getDB(event), id, optout))) return fail(404, { trackingError: 'Contact not found.' });
		return { trackingOk: true };
	},

	// #510: double opt-in — re-send the confirm email (rate-limited) or drop the pending state.
	resendConfirmation: async (event) => {
		const id = Number(event.params.id);
		const res = await resendForContact(getDB(event), event.platform?.env ?? {}, id);
		if (!res.sent) {
			const msg =
				res.reason === 'rate_limited'
					? 'Not sent: it was sent less than 10 minutes ago, or it was already re-sent 3 times.'
					: (res.error ?? 'The confirmation email could not be sent.');
			return fail(res.reason === 'rate_limited' ? 429 : 400, { confirmError: msg });
		}
		return { confirmOk: 'Confirmation email sent again.' };
	},
	cancelConfirmation: async (event) => {
		const id = Number(event.params.id);
		await cancelPending(getDB(event), id);
		return { confirmOk: 'Pending confirmation cancelled. The contact stays unsubscribed.' };
	},

	// #280: archive (hidden from views, never sent to; history + subscription kept) / restore.
	setArchived: async (event) => {
		const id = Number(event.params.id);
		const archive = (await event.request.formData()).get('archive') === '1';
		const db = getDB(event);
		const exists = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
		if (!exists) return fail(404, { archiveError: 'Contact not found.' });
		if (archive) await archiveContacts(db, [id]);
		else await restoreContacts(db, [id]);
		return { archiveOk: true };
	},

	// #507: the header's Subscribed / Unsubscribed control — the bulk bar's unsubscribe /
	// resubscribe for one contact (members and admins alike, like the bulk bar). Unsubscribe
	// stores the chosen reason and `operator @login[: note]` as the detail.
	setSubscribed: async (event) => {
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const db = getDB(event);
		const exists = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
		if (!exists) return fail(404, { subError: 'Contact not found.' });
		const env = event.platform?.env;
		const postmark = await getMailProvider(db, env);
		const sel = { ok: true as const, ids: [id], all: false, missing: 0 };
		const want = String(data.get('subscribed') ?? '');
		if (want === '0') {
			const picked = String(data.get('reason') ?? '').trim();
			const reason = UNSUBSCRIBE_REASONS.includes(picked) ? picked : OPERATOR_UNSUB_REASON;
			const note = String(data.get('note') ?? '').trim();
			if (note.length > SUB_NOTE_MAX) return fail(400, { subError: `Note is too long (${SUB_NOTE_MAX} characters max).` });
			const login = event.locals?.user?.github_login ?? '';
			const detail = `operator @${login}${note ? `: ${note}` : ''}`;
			const out = await bulkUnsubscribe(db, sel, { reason, detail, source: 'manual', suppress: data.get('suppress') === '1', postmark });
			if (!out.ok) return fail(out.status, { subError: out.error });
			return { subOk: true, subNote: out.message };
		}
		if (want === '1') {
			const out = await bulkResubscribe(db, sel, { postmark, source: 'manual' });
			if (!out.ok) return fail(out.status, { subError: out.error });
			if (out.blocked) {
				return fail(409, { subError: "Can't resubscribe: Postmark has a hard bounce or spam complaint for this address." });
			}
			return { subOk: true, subNote: out.message };
		}
		return fail(400, { subError: 'Choose Subscribed or Unsubscribed.' });
	},

	// Enroll this one contact into an active automation (#98) — same helper the bulk
	// bars (#97) use, scoped to a single contact id from the route params.
	enrollInAutomation: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const form = await event.request.formData();
		const automationId = Number(form.get('automation_id'));
		if (!automationId) return fail(400, { enrollError: 'Choose an automation.' });
		// #642: "Enroll anyway" skips only the contact conditions (entry rules). #673: `force=1`
		// ("Enroll anyway" / "Enroll again" / "Restart") also skips once-only re-entry, and
		// `restart=1` (with force) first ends the contact's running pass. Never allowUnsubscribed —
		// an unsubscribed or archived contact stays blocked.
		const force = form.get('force') === '1';
		const restart = force && form.get('restart') === '1';
		const ignoreEntryRules = force || form.get('ignore_entry') === '1';
		const ignoreReentry = force;

		if (restart) {
			// Only end the run when a forced enroll would then succeed: the automation is active with
			// a trunk step, and the one thing in the way is that running pass (never for an
			// archived / unsubscribed contact or a missing automation).
			const auto = await db
				.prepare(
					`SELECT a.status, (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id AND s.parent_step_id IS NULL) AS trunk
					 FROM automations a WHERE a.id = ?`
				)
				.bind(automationId)
				.first<{ status: string; trunk: number }>();
			if (auto?.status === 'active' && (auto.trunk ?? 0) > 0) {
				const reason = await enrollSkipReason(db, automationId, id, { ignoreEntryRules: true, ignoreReentry: true });
				if (reason === 'active') await restartEnrollment(db, automationId, id);
			}
		}

		const result = await enrollContactsInAutomation(db, automationId, [id], { ignoreEntryRules, ignoreReentry });
		if (!result.ok) return fail(400, { enrollError: result.error });
		// #642: nothing enrolled → say exactly why (archived, unsubscribed, active pass, once only,
		// contact conditions). Null = none of those (a race, say); the page shows a plain line.
		const enrollReason =
			result.enrolled === 0
				? await enrollSkipReason(db, automationId, id, { ignoreEntryRules, ignoreReentry })
				: null;
		return {
			enrollSuccess: true,
			enrollEnrolled: result.enrolled,
			enrollSkipped: result.skipped,
			enrollReason,
			enrollName: result.automationName,
			enrollId: automationId
		};
	}
};

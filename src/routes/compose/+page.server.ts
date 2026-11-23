import { autoPublishOnSent, setArchiveAfterSend } from '$lib/server/newsletter-archive';
import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB, env } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { MERGE_TAGS, UNSUB_PLACEHOLDER } from '$lib/server/email';
import { parseBlocks } from '$lib/blocks';
import type { TemplateRow } from '$lib/server/templates';
import { readComposeBody, storedBlocks, bodyIsEmpty, bodyBlocksColumn, renderBody, renderBodyInTemplate } from '$lib/server/compose-body';
import { getSignature } from '$lib/server/email-signature';
import { sendCampaignEmail } from '$lib/server/send';
import { isEmail } from '$lib/csv';
import { getSettings, fromAllowed, getTimezone, DEFAULT_TIMEZONE } from '$lib/server/settings';
import { aiResendSubjectAvailable } from '$lib/server/ai-subject';
import { applyWeekdayOnly, parseZonedLocal, localParts } from '$lib/server/businessdays';
import { memberCount } from '$lib/server/segments';
import { audienceFromForm, existingGroups, readAudience, recipientsForAudience, writeAudience } from '$lib/server/campaign-audience';
import { runPresendChecks } from '$lib/server/presend-checks';
import { resolveTopicId, topicRows } from '$lib/server/topics';
import { parseTopicChoice, topicDisplay } from '$lib/topics';
import { sendTestEmail } from '$lib/server/test-send';
import { forPicker } from '$lib/server/group-archive';

// Shared UTC-string format for scheduled_at / resend_at — 'YYYY-MM-DD HH:MM:SS',
// directly comparable to SQLite's datetime('now').
function toUtcString(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

// #240: a saved draft as compose reads it back.
type DraftRow = {
	id: number;
	subject: string;
	body_md: string;
	body_blocks: string | null;
	from_email: string;
	list_id: number | null;
	scheduled_at: string | null;
	tag_on_open: string | null;
	tag_on_click: string | null;
	weekday_only: number;
	best_time: number;
	resend_delay: string | null;
	resend_at: string | null;
	resend_subject: string | null;
	preheader: string | null;
	template_id: number | null;
	topic_list_id: number | null;
	archive_after_send: number;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** #414: "This email belongs to topic …" — NULL = automatic, 0 = none, else a list id. */
async function writeTopic(db: D1Database, campaignId: number, topic: number | null) {
	await db.prepare('UPDATE campaigns SET topic_list_id = ? WHERE id = ?').bind(topic, campaignId).run();
}

/** The compose form value for a stored choice ('' = automatic). */
const topicValue = (t: number | null) => (t == null ? '' : String(t));

async function draftForCompose(db: D1Database, d: DraftRow, templates: { id: number }[]) {
	const templateId = d.template_id && templates.some((t) => t.id === d.template_id) ? d.template_id : null;
	// #332: every included / excluded group (legacy single list_id when the draft has no rows).
	const audience = await readAudience(db, d.id, d.list_id);
	// Sends store a placeholder body for template-only campaigns (body_md is NOT NULL);
	// don't hand that back to the editor as content.
	const bodyMd = templateId && /^\[(HTML )?[Tt]emplate: .*\]$/.test(d.body_md) ? '' : d.body_md;
	// A scheduled campaign from before 0069 has a resend time but no stored choice.
	const resendDelay = d.resend_delay === '24h' || d.resend_delay === '3d' || d.resend_delay === 'custom' ? d.resend_delay : d.resend_at ? 'custom' : '';
	let resendAtLocal = '';
	if (resendDelay === 'custom' && d.resend_at) {
		const p = localParts(new Date(`${d.resend_at.replace(' ', 'T')}Z`), await getTimezone(db));
		resendAtLocal = `${p.y}-${pad2(p.m)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
	}
	return {
		id: d.id,
		subject: d.subject,
		body_md: bodyMd,
		// #250: the editor opens these; null = body_md is converted on load (and only
		// written back as blocks when the user saves).
		body_blocks: storedBlocks(d.body_blocks),
		from: d.from_email,
		list_id: d.list_id,
		include_ids: audience.include,
		exclude_ids: audience.exclude,
		// ISO UTC; the page turns it into the browser's local picker value.
		schedule_at: d.scheduled_at ? `${d.scheduled_at.replace(' ', 'T')}Z` : '',
		tag_on_open: d.tag_on_open ?? '',
		tag_on_click: d.tag_on_click ?? '',
		weekday_only: !!d.weekday_only,
		best_time: !!d.best_time,
		resend_delay: resendDelay,
		resend_at: resendAtLocal,
		resend_subject: d.resend_subject ?? '',
		preheader: d.preheader ?? '',
		template_id: templateId,
		topic_id: topicValue(d.topic_list_id),
		archive_after_send: !!d.archive_after_send
	};
}

/** #240: Save draft — subject only is required; never sends, schedules or creates recipients. */
async function saveDraft(db: D1Database, data: FormData, fallbackFrom: string) {
	const draftId = Number(data.get('draft_id')) || 0;
	const subject = String(data.get('subject') ?? '').trim();
	const from = String(data.get('from') ?? '').trim() || fallbackFrom;
	const body = readComposeBody(data);
	const bodyMd = body.md;
	const preheader = String(data.get('preheader') ?? '').trim();
	const audienceRaw = audienceFromForm(data);
	const templateIdRaw = Number(data.get('template_id')) || 0;
	const scheduleAtIso = String(data.get('schedule_at') ?? '').trim();
	const tagOnOpen = String(data.get('tag_on_open') ?? '').trim().slice(0, 60) || null;
	const tagOnClick = String(data.get('tag_on_click') ?? '').trim().slice(0, 60) || null;
	const weekdayOnly = String(data.get('weekday_only') ?? '') === '1';
	const bestTime = String(data.get('best_time') ?? '') === '1';
	const resendDelayRaw = String(data.get('resend_delay') ?? '').trim();
	const resendAtLocal = String(data.get('resend_at') ?? '').trim();
	const resendSubject = String(data.get('resend_subject') ?? '').trim().slice(0, 500) || null;
	const topic = parseTopicChoice(data.get('topic_id'));

	const values = {
		subject,
		from,
		body_md: bodyMd,
		body_blocks: bodyBlocksColumn(body) ?? '',
		list_id: audienceRaw.include[0] ?? 0,
		include_ids: audienceRaw.include,
		exclude_ids: audienceRaw.exclude,
		topic_id: topicValue(topic),
		preheader,
		direct_to: '',
		resend_delay: resendDelayRaw,
		resend_at: resendAtLocal,
		resend_subject: resendSubject ?? '',
		weekday_only: weekdayOnly,
		best_time: bestTime
	};
	if (!subject) return fail(400, { error: 'Add a subject to save a draft.', values });

	// Optional fields are kept only when they still point at something real.
	const { audience } = await existingGroups(db, audienceRaw);
	const listId = audience.include[0] ?? null;
	const templateId = templateIdRaw
		? ((await db.prepare("SELECT id FROM templates WHERE id = ? AND kind != 'web'").bind(templateIdRaw).first<{ id: number }>())?.id ?? null)
		: null;
	let scheduledAt: string | null = null;
	if (scheduleAtIso) {
		const t = new Date(scheduleAtIso);
		if (Number.isNaN(t.getTime())) return fail(400, { error: 'Invalid schedule time.', values });
		scheduledAt = toUtcString(t);
	}
	const resendDelay = resendDelayRaw === '24h' || resendDelayRaw === '3d' || resendDelayRaw === 'custom' ? resendDelayRaw : null;
	let resendAt: string | null = null;
	if (resendDelay === 'custom' && resendAtLocal) {
		const rt = parseZonedLocal(resendAtLocal, await getTimezone(db));
		if (!rt) return fail(400, { error: 'Invalid auto-resend time.', values });
		resendAt = toUtcString(rt);
	}

	// The stored HTML/text only feed the campaign page's "View email" preview.
	const { html: bodyHtml, text: bodyText } = renderBody(body, { preheader: preheader || undefined, signature: await getSignature(db) });
	const fields = [
		subject, bodyMd, bodyBlocksColumn(body), bodyHtml, bodyText, listId, from, scheduledAt, tagOnOpen, tagOnClick,
		weekdayOnly ? 1 : 0, bestTime ? 1 : 0, resendDelay, resendAt, resendSubject, preheader || null, templateId
	];

	if (draftId) {
		const row = await db
			.prepare(
				`UPDATE campaigns SET subject = ?, body_md = ?, body_blocks = ?, body_html = ?, body_text = ?, list_id = ?, from_email = ?,
				        scheduled_at = ?, tag_on_open = ?, tag_on_click = ?, weekday_only = ?, best_time = ?,
				        resend_delay = ?, resend_at = ?, resend_subject = ?, preheader = ?, template_id = ?
				 WHERE id = ? AND status = 'draft'
				 RETURNING id`
			)
			.bind(...fields, draftId)
			.first<{ id: number }>();
		if (!row) return fail(400, { error: 'This draft was already sent or scheduled.', values });
		await writeAudience(db, row.id, audience);
		await writeTopic(db, row.id, topic);
		await setArchiveAfterSend(db, row.id, data.get('archive_after_send') === '1'); // #481
		return { id: row.id };
	}
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, body_text, list_id, from_email, scheduled_at,
			        tag_on_open, tag_on_click, weekday_only, best_time, resend_delay, resend_at, resend_subject,
			        preheader, template_id, status, recipient_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0)
			 RETURNING id`
		)
		.bind(...fields)
		.first<{ id: number }>();
	await writeAudience(db, row!.id, audience);
	await writeTopic(db, row!.id, topic);
	await setArchiveAfterSend(db, row!.id, data.get('archive_after_send') === '1'); // #481
	return { id: row!.id };
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const rows = await db
		.prepare(
			`SELECT l.id, l.name, l.kind, l.archived_at,
			        COUNT(CASE WHEN c.subscribed = 1 AND c.archived_at IS NULL THEN 1 END) AS recipients
			 FROM lists l
			 LEFT JOIN list_members lm ON lm.list_id = l.id
			 LEFT JOIN contacts c ON c.id = lm.contact_id
			 GROUP BY l.id
			 ORDER BY l.created_at DESC`
		)
		.all<{ id: number; name: string; kind: string; archived_at: string | null; recipients: number }>();

	// Contact-page "Email this person" button deep-links into 1:1 mode.
	const to = event.url.searchParams.get('to') ?? '';
	const direct = event.url.searchParams.get('direct') === '1';

	// Start-from templates (#60) for broadcast sends.
	const templates = await db
		.prepare("SELECT id, name, kind FROM templates WHERE kind != 'web' ORDER BY name") // #481: web = archive page templates
		.all<{ id: number; name: string; kind: string }>();

	const settings = await getSettings(db);

	// #238: ?draft=<id> opens a saved draft (e.g. one made via POST /api/v1/campaigns).
	// #240: everything stored on the row prefills, not just subject + body.
	const draftId = Number(event.url.searchParams.get('draft')) || 0;
	const draftRow = draftId
		? await db
				.prepare(
					`SELECT id, subject, body_md, body_blocks, from_email, list_id, scheduled_at, tag_on_open, tag_on_click,
					        weekday_only, best_time, resend_delay, resend_at, resend_subject, preheader, template_id, topic_list_id, archive_after_send
					 FROM campaigns WHERE id = ? AND status = 'draft'`
				)
				.bind(draftId)
				.first<DraftRow>()
		: null;
	const draft = draftRow ? await draftForCompose(db, draftRow, templates.results) : null;

	// Dynamic segments (#66): the JOIN count is 0 for rule-based segments — recompute.
	const segRows = await db.prepare("SELECT id, kind, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL").all<{ id: number; kind: string; rules: string | null }>();
	const dynIds = new Set(segRows.results.map((r) => r.id));
	const dynCounts = new Map<number, number>();
	for (const r of segRows.results) dynCounts.set(r.id, await memberCount(db, r));
	// #472: archived groups only when the draft being edited already uses them ("(archived)").
	const keep = draft ? [draft.list_id, ...draft.include_ids, ...draft.exclude_ids] : [];
	const withCounts = forPicker(rows.results, keep).map((r) =>
		dynIds.has(r.id) ? { ...r, recipients: dynCounts.get(r.id) ?? 0, dynamic: true } : r
	);

	return {
		// #270: the visual editor + Design panel get the wide content column.
		wideLayout: true,
		lists: withCounts.filter((r) => r.kind === 'list'),
		segments: withCounts.filter((r) => r.kind === 'segment'),
		// #414: Audience → "This email belongs to topic …" (public label; internal names never).
		topics: (await topicRows(db)).map((t) => ({ id: t.id, label: topicDisplay(t)?.label ?? `${t.name} (hidden: no label)` })),
		templates: templates.results,
		defaultFrom: settings.default_from || (event.platform?.env?.POSTMARK_FROM ?? ''),
		mergeTags: MERGE_TAGS,
		initialMode: direct ? 'direct' : 'campaign',
		initialTo: to,
		draft,
		// #246: "Suggest with Claude" on the auto-resend subject (toggle on + key set).
		aiSubject: await aiResendSubjectAvailable(db, event.platform?.env)
	};
};

export const actions: Actions = {
	// #240: park a half-built campaign. Redirects back into compose with a notice.
	saveDraft: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		if (event.locals?.user?.role !== 'admin') data.delete('archive_after_send'); // #481: admin only
		const settings = await getSettings(db);
		const res = await saveDraft(db, data, settings.default_from || (event.platform?.env?.POSTMARK_FROM ?? ''));
		if (!('id' in res)) return res;
		throw redirect(303, `/compose?draft=${res.id}&saved=1`);
	},

	// Send a one-off test/preview to a single address. No campaign, no DB writes.
	test: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();

		const subject = String(data.get('subject') ?? '').trim();
		const from = String(data.get('from') ?? '').trim();
		const body = readComposeBody(data);
		const preheader = String(data.get('preheader') ?? '').trim();
		const isDirect = String(data.get('direct') ?? '') === '1';
		const templateId = Number(data.get('template_id')) || 0;
		const testTo =
			String(data.get('test_to') ?? '').trim() || (event.platform?.env?.POSTMARK_FROM ?? '');

		if (!subject || !from || (bodyIsEmpty(body) && !templateId)) {
			return fail(400, { testError: 'Add a subject, from address, and body before testing.' });
		}
		if (!isEmail(testTo)) {
			return fail(400, { testError: 'Enter a valid test recipient email.' });
		}
		{
			const settings = await getSettings(db);
			if (!fromAllowed(from, settings.approved_senders)) {
				return fail(400, { testError: `From “${from}” isn't an approved Postmark sender (Settings → Approved senders).` });
			}
		}

		const sent = await sendTestEmail(
			db,
			{ token: env(event, 'POSTMARK_TOKEN'), stream: env(event, 'POSTMARK_STREAM'), secret: env(event, 'SESSION_SECRET'), baseUrl: await publicBaseUrlFor(event) },
			{ from, to: testTo, subject, body, preheader, templateId, direct: isDirect }
		);
		if (!sent.ok) return fail(400, { testError: sent.error });
		return { testSuccess: true, testTo };
	},

	send: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();

		const subject = String(data.get('subject') ?? '').trim();
		const from = String(data.get('from') ?? '').trim();
		const body = readComposeBody(data);
		let bodyMd = body.md;
		const preheader = String(data.get('preheader') ?? '').trim();
		// #332: included lists / segments (union) minus excluded ones.
		const { audience } = await existingGroups(db, audienceFromForm(data));
		const listId = audience.include[0] ?? 0;
		// #414: the topic this email belongs to (its opt-outs are left out of the send).
		const topic = parseTopicChoice(data.get('topic_id'));
		const templateId = Number(data.get('template_id')) || 0;
		const scheduleAtIso = String(data.get('schedule_at') ?? '').trim();
		const tagOnOpen = String(data.get('tag_on_open') ?? '').trim().slice(0, 60) || null;
		const tagOnClick = String(data.get('tag_on_click') ?? '').trim().slice(0, 60) || null;
		// #240: sending/scheduling from a draft promotes that row instead of inserting a new one.
		const draftId = Number(data.get('draft_id')) || 0;
		// #481: Publish to newsletter archive after sending (broadcasts only).
		const archiveAfterSend = data.get('archive_after_send') === '1' && event.locals?.user?.role === 'admin';

		// Auto-resend to non-openers (#82): '' (off) | '24h' | '3d' | 'custom'.
		const resendDelay = String(data.get('resend_delay') ?? '').trim();
		const resendAtLocal = String(data.get('resend_at') ?? '').trim();
		const resendSubjectRaw = String(data.get('resend_subject') ?? '').trim().slice(0, 500) || null;

		// #119: opt-in "weekdays only" — a Sat/Sun due time (operator tz) moves to Monday,
		// same local time. One checkbox, applied to BOTH the scheduled send time and the
		// auto-resend timing computed in this same action.
		const weekdayOnly = String(data.get('weekday_only') ?? '') === '1';
		// Custom picker values are operator wall-clock, not UTC. Read the zone only
		// when the weekday flag is on or a custom resend time has to be interpreted.
		const tz = weekdayOnly || resendDelay === 'custom' ? await getTimezone(db) : null;
		// #115: "Send at each contact's best time" — scheduled sends only.
		const bestTime = String(data.get('best_time') ?? '') === '1';

		const values = {
			subject,
			from,
			body_md: bodyMd,
			body_blocks: bodyBlocksColumn(body) ?? '',
			list_id: listId,
			include_ids: audience.include,
			exclude_ids: audience.exclude,
			topic_id: topicValue(topic),
			preheader,
			direct_to: '',
			resend_delay: resendDelay,
			resend_at: resendAtLocal,
			resend_subject: resendSubjectRaw ?? '',
			weekday_only: weekdayOnly,
			best_time: bestTime
		};

		// Scheduling (#35): validate up front so nothing renders for an invalid time.
		// The weekday_only shift (#119) is applied BEFORE the min-future check's result is
		// stored, so scheduledAt always reflects the REAL send time (what the UI should show).
		let scheduledAt: string | null = null;
		let scheduleMoved = false;
		if (scheduleAtIso) {
			const t = new Date(scheduleAtIso);
			if (Number.isNaN(t.getTime())) return fail(400, { error: 'Invalid schedule time.', values });
			if (t.getTime() < Date.now() + 60_000) {
				return fail(400, { error: 'Schedule time must be at least a minute in the future.', values });
			}
			let finalT = t;
			if (weekdayOnly && tz) {
				finalT = applyWeekdayOnly(t, tz);
				scheduleMoved = finalT.getTime() !== t.getTime();
			}
			scheduledAt = toUtcString(finalT); // UTC, datetime('now')-comparable
		}

		// Auto-resend timing (#82), relative to: now for an immediate send, scheduled_at
		// for a scheduled one. weekday_only (#119) shifts the final resend instant too.
		let resendAt: string | null = null;
		let resendMoved = false;
		if (resendDelay === 'custom') {
			if (!resendAtLocal) return fail(400, { error: 'Choose an auto-resend time.', values });
			const rt = parseZonedLocal(resendAtLocal, tz ?? DEFAULT_TIMEZONE);
			if (!rt) return fail(400, { error: 'Invalid auto-resend time.', values });
			if (rt.getTime() < Date.now() + 60 * 60 * 1000) {
				return fail(400, { error: 'Auto-resend time must be at least 1 hour from now.', values });
			}
			if (scheduledAt) {
				const schedMs = Date.parse(`${scheduledAt.replace(' ', 'T')}Z`);
				if (rt.getTime() < schedMs + 60 * 60 * 1000) {
					return fail(400, { error: 'Auto-resend time must be at least 1 hour after the scheduled send.', values });
				}
			}
			let finalRt = rt;
			if (weekdayOnly && tz) {
				finalRt = applyWeekdayOnly(rt, tz);
				resendMoved = finalRt.getTime() !== rt.getTime();
			}
			resendAt = toUtcString(finalRt);
		} else if (resendDelay === '24h' || resendDelay === '3d') {
			const baseMs = scheduledAt ? Date.parse(`${scheduledAt.replace(' ', 'T')}Z`) : Date.now();
			const addMs = (resendDelay === '24h' ? 1 : 3) * 24 * 60 * 60 * 1000;
			let rt = new Date(baseMs + addMs);
			if (weekdayOnly && tz) {
				const shifted = applyWeekdayOnly(rt, tz);
				resendMoved = shifted.getTime() !== rt.getTime();
				rt = shifted;
			}
			resendAt = toUtcString(rt);
		} else if (resendDelay) {
			return fail(400, { error: 'Invalid auto-resend option.', values });
		}

		if (!subject) return fail(400, { error: 'Subject is required.', values });
		if (!from) return fail(400, { error: 'From address is required.', values });
		if (!templateId && bodyIsEmpty(body)) return fail(400, { error: 'Email body is empty.', values });
		if (!listId) return fail(400, { error: 'Choose a list or segment to send to.', values });
		if (bestTime && !scheduledAt) {
			return fail(400, { error: "Sending at each contact's best time needs a scheduled start.", values });
		}
		{
			const settings = await getSettings(db);
			if (!fromAllowed(from, settings.approved_senders)) {
				return fail(400, { error: `From “${from}” isn't an approved Postmark sender (Settings → Approved senders).`, values });
			}
		}

		// Start-from template (#60/#64): builder templates are layout shells — the
		// composed content (bodyMd) lands in their content area at assembly.
		let template: TemplateRow | null = null;
		if (templateId) {
			template = await db
				.prepare('SELECT name, kind, blocks, html, use_global_header, use_global_footer, canvas FROM templates WHERE id = ?')
				.bind(templateId)
				.first();
			if (!template) return fail(400, { error: 'That template no longer exists.', values });
			if (template.kind === 'html' && !(template.html ?? '').trim()) {
				return fail(400, { error: `Template “${template.name}” has no HTML yet.`, values });
			}
			if (template.kind === 'builder' && parseBlocks(template.blocks).length === 0 && bodyIsEmpty(body)) {
				return fail(400, { error: `Template “${template.name}” is empty and so is the content.`, values });
			}
		}

		const recipientRows = await recipientsForAudience(db, audience, { topicId: await resolveTopicId(db, topic, audience) });
		if (recipientRows.length === 0) {
			return fail(400, {
				error: audience.include.length > 1 || audience.exclude.length ? 'That audience has no subscribed contacts.' : 'That list has no subscribed contacts.',
				values
			});
		}
		const recipients = { results: recipientRows };

		// #311: pre-send checks, enforced here and not only in the panel. A block (placeholder
		// link, unknown merge tag, …) needs the explicit "Send anyway" tick.
		const checks = await runPresendChecks(
			db,
			{ subject, preheader, body, templateId: templateId || null, audience, topicId: topic },
			{ media: event.platform?.env?.MEDIA, recipients: recipientRows }
		);
		if (checks.blocks > 0 && String(data.get('send_anyway') ?? '') !== '1') {
			return fail(400, {
				error: `Pre-send checks found ${checks.blocks} blocking problem${checks.blocks === 1 ? '' : 's'}. Fix ${checks.blocks === 1 ? 'it' : 'them'} or tick “Send anyway”.`,
				values,
				checks
			});
		}

		const token = env(event, 'POSTMARK_TOKEN');
		const stream = env(event, 'POSTMARK_STREAM');
		const secret = env(event, 'SESSION_SECRET');
		const baseUrl = await publicBaseUrlFor(event);

		// Permission reminder (#54): bake the audience's origin note into the footer (the
		// first included group's, #332).
		const originRow = await db
			.prepare('SELECT origin FROM lists WHERE id = ?')
			.bind(listId)
			.first<{ origin: string | null }>();
		const originNote = originRow?.origin ?? undefined;

		let htmlTemplate: string;
		let textTemplate: string;
		// #250: the editor's blocks are kept with the row (NULL for a markdown body and
		// for raw-HTML templates, which ignore the editor).
		let bodyBlocks = bodyBlocksColumn(body);
		if (template?.kind === 'builder') {
			// Layout-shell assembly (#64): global header + template (content area filled
			// with the composed content) + global footer → the standard email shell.
			({ html: htmlTemplate, text: textTemplate } = await renderBodyInTemplate(db, template, body, { preheader, originNote }));
			bodyMd = bodyMd || `[Template: ${template.name}]`; // campaigns.body_md is NOT NULL
		} else if (template?.kind === 'html') {
			// Raw HTML is sent as-is — but never without an unsubscribe path: if the
			// placeholder is missing, append the standard footer (with the reminder).
			let raw = template.html ?? '';
			if (!raw.includes(UNSUB_PLACEHOLDER)) {
				const reminder = originNote ? `You're receiving this email because: ${originNote}<br>` : '';
				const footer = `<div style="max-width:640px;padding:16px 24px 40px;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#8b949e;">${reminder}Don't want these emails? <a href="${UNSUB_PLACEHOLDER}" style="color:#8b949e;">Unsubscribe here</a>.</div>`;
				raw = raw.includes('</body>') ? raw.replace('</body>', `${footer}</body>`) : raw + footer;
			}
			htmlTemplate = raw;
			bodyMd = `[HTML template: ${template.name}]`;
			bodyBlocks = null;
			const stripped = raw
				.replace(/<style[\s\S]*?<\/style>/gi, ' ')
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s{2,}/g, ' ')
				.trim()
				.slice(0, 5000);
			textTemplate = `${stripped}\n\nUnsubscribe: ${UNSUB_PLACEHOLDER}`;
		} else {
			({ html: htmlTemplate, text: textTemplate } = renderBody(body, { preheader, originNote, signature: await getSignature(db) }));
		}

		// Scheduled (#35): store the fully-rendered campaign; the heartbeat fires it.
		// Recipients are re-resolved at send time (current membership + subscriptions).
		// A scheduled auto-resend (#82) is set up front too — resend_status='pending'
		// so processScheduledResends picks it up once this campaign lands on 'sent'.
		// #240: preheader / template / resend choice are stored too, so Edit on a scheduled
		// campaign reopens compose with them.
		if (scheduledAt) {
			const scheduledFields = [
				subject,
				bodyMd,
				htmlTemplate,
				textTemplate,
				listId,
				from,
				scheduledAt,
				recipients.results.length,
				tagOnOpen,
				tagOnClick,
				resendAt,
				resendAt ? 'pending' : null,
				resendSubjectRaw,
				weekdayOnly ? 1 : 0,
				bestTime ? 1 : 0,
				preheader || null,
				templateId || null,
				resendDelay || null,
				bodyBlocks
			];
			const scheduledCampaign = draftId
				? await db
						.prepare(
							`UPDATE campaigns SET subject = ?, body_md = ?, body_html = ?, body_text = ?, list_id = ?, from_email = ?,
							        status = 'scheduled', scheduled_at = ?, recipient_count = ?, tag_on_open = ?, tag_on_click = ?,
							        resend_at = ?, resend_status = ?, resend_subject = ?, weekday_only = ?, best_time = ?,
							        preheader = ?, template_id = ?, resend_delay = ?, body_blocks = ?, error = NULL
							 WHERE id = ? AND status = 'draft'
							 RETURNING id`
						)
						.bind(...scheduledFields, draftId)
						.first<{ id: number }>()
				: await db
						.prepare(
							`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, scheduled_at, recipient_count, tag_on_open, tag_on_click, resend_at, resend_status, resend_subject, weekday_only, best_time, preheader, template_id, resend_delay, body_blocks)
							 VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							 RETURNING id`
						)
						.bind(...scheduledFields)
						.first<{ id: number }>();
			if (!scheduledCampaign) return fail(400, { error: 'This draft was already sent or scheduled.', values });
			// #332: the scheduler resolves these groups again when it fires.
			await writeAudience(db, scheduledCampaign.id, audience);
			await writeTopic(db, scheduledCampaign.id, topic);
			// #481: "Publish to newsletter archive after sending" — applied when the scheduler sends it.
			await setArchiveAfterSend(db, scheduledCampaign.id, archiveAfterSend);
			// #119: one-time query-param flags so the campaign page can show "(moved to
			// Monday — weekdays only)" right after scheduling — not persisted beyond this redirect.
			const movedParams = new URLSearchParams();
			if (scheduleMoved) movedParams.set('sched_moved', '1');
			if (resendMoved) movedParams.set('resend_moved', '1');
			const qs = movedParams.toString();
			throw redirect(303, `/campaign/${scheduledCampaign!.id}${qs ? `?${qs}` : ''}`);
		}

		// Create the campaign first so unsubscribe links can reference its id.
		// #240: from a draft, claim that row (draft → sending) — the status guard means a
		// double submit finds nothing to claim and can't send twice.
		const campaign = draftId
			? await db
					.prepare(
						`UPDATE campaigns SET subject = ?, body_md = ?, body_blocks = ?, body_html = ?, body_text = NULL, list_id = ?, from_email = ?,
						        status = 'sending', sent_at = datetime('now'), scheduled_at = NULL, tag_on_open = ?, tag_on_click = ?,
						        weekday_only = ?, best_time = 0, resend_at = NULL, resend_status = NULL, resend_subject = NULL,
						        preheader = ?, template_id = ?, resend_delay = ?, error = NULL
						 WHERE id = ? AND status = 'draft'
						 RETURNING id`
					)
					.bind(subject, bodyMd, bodyBlocks, htmlTemplate, listId, from, tagOnOpen, tagOnClick, weekdayOnly ? 1 : 0, preheader || null, templateId || null, resendDelay || null, draftId)
					.first<{ id: number }>()
			: await db
					.prepare(
						`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, list_id, from_email, status, sent_at, tag_on_open, tag_on_click, weekday_only)
						 VALUES (?, ?, ?, ?, ?, ?, 'sending', datetime('now'), ?, ?, ?)
						 RETURNING id`
					)
					.bind(subject, bodyMd, bodyBlocks, htmlTemplate, listId, from, tagOnOpen, tagOnClick, weekdayOnly ? 1 : 0)
					.first<{ id: number }>();
		if (!campaign) return fail(400, { error: 'This draft was already sent or scheduled.', values });
		const campaignId = campaign.id;
		await writeAudience(db, campaignId, audience);
		await writeTopic(db, campaignId, topic);
		// #481: the archive reads the preheader (teaser) and template kind (raw-HTML fallback),
		// which a fresh send row doesn't otherwise store.
		await db
			.prepare('UPDATE campaigns SET archive_after_send = ?, preheader = COALESCE(preheader, ?), template_id = COALESCE(template_id, ?) WHERE id = ?')
			.bind(archiveAfterSend ? 1 : 0, preheader || null, templateId || null, campaignId)
			.run();

		const { accepted, failed, firstError } = await sendCampaignEmail(db, {
			token,
			secret,
			baseUrl,
			campaignId,
			recipients: recipients.results,
			subject,
			htmlTemplate,
			textTemplate,
			from,
			stream,
			replyToInbound: event.platform?.env?.POSTMARK_INBOUND_ADDRESS || undefined
		});

		const sentOk = accepted > 0;
		await db
			.prepare(
				`UPDATE campaigns
				 SET status = ?, recipient_count = ?, error = ?
				 WHERE id = ?`
			)
			.bind(
				sentOk ? 'sent' : 'failed',
				accepted,
				failed > 0 ? `${failed} failed. First error: ${firstError}` : null,
				campaignId
			)
			.run();

		if (sentOk) await autoPublishOnSent(db, campaignId); // #481: best-effort

		// Auto-resend to non-openers (#82): only set up once the send actually landed.
		if (resendAt && sentOk) {
			await db
				.prepare(`UPDATE campaigns SET resend_at = ?, resend_status = 'pending', resend_subject = ? WHERE id = ?`)
				.bind(resendAt, resendSubjectRaw, campaignId)
				.run();
		}

		// #119: one-time query-param flag — see the scheduled branch above for why.
		throw redirect(303, `/campaign/${campaignId}${resendMoved && sentOk ? '?resend_moved=1' : ''}`);
	},

	// Personal 1:1 send: single recipient, transactional stream, NO unsubscribe footer.
	// Logged as a campaign (list_id NULL) so it shows in the send log + contact history.
	direct: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();

		const subject = String(data.get('subject') ?? '').trim();
		const from = String(data.get('from') ?? '').trim();
		const body = readComposeBody(data);
		const bodyMd = body.md;
		const preheader = String(data.get('preheader') ?? '').trim();
		const to = String(data.get('direct_to') ?? '').trim().toLowerCase();

		const values = {
			subject,
			from,
			body_md: bodyMd,
			body_blocks: bodyBlocksColumn(body) ?? '',
			direct_to: to,
			preheader,
			list_id: 0,
			include_ids: [] as number[],
			exclude_ids: [] as number[],
			resend_delay: '',
			resend_at: '',
			resend_subject: '',
			weekday_only: false,
			best_time: false
		};
		if (!subject) return fail(400, { error: 'Subject is required.', values, mode: 'direct' });
		if (!from) return fail(400, { error: 'From address is required.', values, mode: 'direct' });
		if (bodyIsEmpty(body)) return fail(400, { error: 'Email body is empty.', values, mode: 'direct' });
		if (!isEmail(to)) return fail(400, { error: 'Enter a valid recipient email.', values, mode: 'direct' });
		{
			const settings = await getSettings(db);
			if (!fromAllowed(from, settings.approved_senders)) {
				return fail(400, { error: `From “${from}” isn't an approved Postmark sender (Settings → Approved senders).`, values, mode: 'direct' });
			}
		}

		const token = env(event, 'POSTMARK_TOKEN');
		const txStream = env(event, 'POSTMARK_STREAM_TX');
		const secret = env(event, 'SESSION_SECRET');
		const baseUrl = await publicBaseUrlFor(event);

		// Use the contact record (if any) for personalization + history linkage.
		const contact = await db
			.prepare('SELECT id, email, name, first_name, last_name, company FROM contacts WHERE email = ?')
			.bind(to)
			.first<{
				id: number;
				email: string;
				name: string | null;
				first_name: string | null;
				last_name: string | null;
				company: string | null;
			}>();
		const r = contact ?? { id: null, email: to, name: null, first_name: null, last_name: null, company: null };

		const { html: htmlTemplate, text: textTemplate } = renderBody(body, { preheader, unsubscribe: false, signature: await getSignature(db) });

		const campaign = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, list_id, from_email, status, sent_at)
				 VALUES (?, ?, ?, ?, NULL, ?, 'sending', datetime('now'))
				 RETURNING id`
			)
			.bind(subject, bodyMd, bodyBlocksColumn(body), htmlTemplate, from)
			.first<{ id: number }>();
		const campaignId = campaign!.id;

		// 1:1 has no in-body unsubscribe footer; transactional stream.
		const { accepted, firstError } = await sendCampaignEmail(db, {
			token,
			secret,
			baseUrl,
			campaignId,
			recipients: [r],
			subject,
			htmlTemplate,
			textTemplate,
			from,
			stream: txStream,
			unsubscribe: false,
			replyToInbound: event.platform?.env?.POSTMARK_INBOUND_ADDRESS || undefined
		});
		const ok = accepted > 0;

		await db
			.prepare(`UPDATE campaigns SET status = ?, recipient_count = ?, error = ? WHERE id = ?`)
			.bind(ok ? 'sent' : 'failed', accepted, ok ? null : firstError, campaignId)
			.run();

		if (!ok) return fail(400, { error: `Postmark error: ${firstError}`, values, mode: 'direct' });
		throw redirect(303, `/campaign/${campaignId}`);
	}
};

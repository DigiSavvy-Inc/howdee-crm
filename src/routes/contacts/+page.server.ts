import { fail, isActionFailure, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import Papa from 'papaparse';
import { unguardCsvCell } from '$lib/csv';
import { getDB } from '$lib/server/db';
import { getMailProvider } from '$lib/server/mail';
import { isEmail } from '$lib/csv';
import { hygieneInvalid, type Hygiene } from '$lib/email-hygiene';
import { recordHygieneMany } from '$lib/server/hygiene';
import {
	countHygiene,
	hygieneForEmails,
	parseFixes,
	parseInvalidMode,
	previewImportHygiene
} from '$lib/server/import-hygiene';
import { autoEnrollByEmails, listActiveAutomations } from '$lib/server/automations';
import { syncCompanyMembership } from '$lib/server/companies';
import { conditionLabel, encodeCondition } from '$lib/company-metrics';
import { canSeeBilling } from '$lib/server/integrations/zoho';
import {
	contactsFilterQuery,
	groupsOfIds,
	groupsOfQuery,
	runBulkForm,
	BULK_CAP,
	type BulkFormAction
} from '$lib/server/contact-bulk';
import { activeMemberCount } from '$lib/server/segments';
import { invalidateGroupRules } from '$lib/server/groups-bulk';
import { forPicker } from '$lib/server/group-archive';
import {
	contactsFilterParams,
	contactsOrder,
	contactsWhere,
	defaultContactsStatus,
	isFiltered,
	isNarrowed,
	parseContactsFilter,
	resolveContactsFilter
} from '$lib/server/contacts-query';
import { activeContactSql } from '$lib/server/active-audience';
import { filterToRules, loadContactsOverview } from '$lib/server/contacts-overview';
import { formPicker } from '$lib/server/form-reads';
import {
	ACTIVITY_TYPE_LABELS,
	CONTACT_ACTIVITY_TYPES,
	FEED_SIZES,
	activityExtras,
	getFeedSize,
	groupActivityByContact,
	parseFeedTypes,
	recentActivity,
	setFeedSize
} from '$lib/server/activity';
import { getTimezone } from '$lib/server/settings';
import { parsePeriod, periodSince, type PeriodKey } from '$lib/contacts-overview';
import { defaultSpec, encodeSpec } from '$lib/report-view';
import { parseReportSpec } from '$lib/report-spec';
import { compileSegment, type SegmentRules } from '$lib/server/segment-query';
import { stageOptions, stagesForContacts } from '$lib/server/pipeline-query';
import { topicPicker } from '$lib/server/topics';
import { scorePicker, scoresForContacts } from '$lib/server/scoring/query';
import { CAMPAIGN_WHO_LABELS } from '$lib/server/bounce-filter';
import { DELIVERY_CHIP_KINDS, contactFilterChips, pipelineChipLabel } from '$lib/contact-filter-chips';

const PER_OPTIONS = [25, 50, 100, 200];

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** #306: store `meta.hygiene` (+ the `hygiene:invalid` tag) on the contacts just written. */
async function recordForEmails(db: D1Database, byEmail: Map<string, Hygiene>, emails: string[]): Promise<void> {
	const rows: { id: number; hygiene: Hygiene }[] = [];
	for (const part of chunk(emails, 100)) {
		const ids = await db
			.prepare(`SELECT id, email FROM contacts WHERE email IN (${part.map(() => '?').join(',')})`)
			.bind(...part)
			.all<{ id: number; email: string }>();
		for (const c of ids.results) {
			const h = byEmail.get(c.email);
			if (h) rows.push({ id: c.id, hygiene: h });
		}
	}
	await recordHygieneMany(db, rows);
}

type Group = { id: number; name: string; created_at: string; count: number; dynamic?: boolean };

/** #472: archived lists / segments are left out of the sidebar, filters, bulk "add to" and the
 *  import target — except a group the current In / Not in filter names ("(archived)"). */
async function groups(db: D1Database, kind: string, keep: number[] = []): Promise<Group[]> {
	const res = await db
		.prepare(
			`SELECT l.id, l.name, l.kind, l.rules, l.created_at, l.archived_at, COUNT(c.id) AS count
			 FROM lists l
			 LEFT JOIN list_members lm ON lm.list_id = l.id
			 LEFT JOIN contacts c ON c.id = lm.contact_id AND ${activeContactSql('c')}
			 WHERE l.kind = ?
			 GROUP BY l.id
			 ORDER BY l.created_at DESC`
		)
		.bind(kind)
		.all<Group & { kind: string; rules: string | null; archived_at: string | null }>();
	// Dynamic segments (#66): the LEFT JOIN count is 0; compute from rules.
	const out: Group[] = [];
	for (const r of forPicker(res.results, keep)) {
		if (kind === 'segment' && r.rules) {
			out.push({ id: r.id, name: r.name, created_at: r.created_at, count: await activeMemberCount(db, r), dynamic: true });
		} else {
			out.push({ id: r.id, name: r.name, created_at: r.created_at, count: r.count });
		}
	}
	return out;
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);

	const keepGroups = [Number(event.url.searchParams.get('in')), Number(event.url.searchParams.get('notin'))];
	const [lists, segments, tags, companies, activeAutomations] = await Promise.all([
		groups(db, 'list', keepGroups),
		groups(db, 'segment', keepGroups),
		groups(db, 'tag'),
		groups(db, 'company'),
		listActiveAutomations(db)
	]);

	const totals = await db
		.prepare(
			// #705: `total` = the active audience (what the default view shows).
			`SELECT COALESCE(SUM(${activeContactSql()}), 0) AS total,
			        COALESCE(SUM(CASE WHEN archived_at IS NULL THEN subscribed ELSE 0 END), 0) AS subscribed,
			        COALESCE(SUM(archived_at IS NOT NULL), 0) AS archived
			 FROM contacts`
		)
		.first<{ total: number; subscribed: number; archived: number }>();

	const { sort, dir, orderExpr } = contactsOrder(event.url.searchParams);

	// Pagination + Filters popover (#94) — live search ?q= (#91) composes via contactsWhere.
	let per = Number(event.url.searchParams.get('per')) || 50;
	if (!PER_OPTIONS.includes(per)) per = 50;
	let page = Math.floor(Number(event.url.searchParams.get('page')) || 1);
	if (page < 1) page = 1;

	const filter = await resolveContactsFilter(db, parseContactsFilter(event.url.searchParams));
	const { where, params } = contactsWhere(filter);
	const narrowed = isNarrowed(filter);

	const matchRow = await db
		.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`)
		.bind(...params)
		.first<{ n: number }>();
	const matched = matchRow?.n ?? 0;
	const pageCount = Math.max(1, Math.ceil(matched / per));
	if (page > pageCount) page = pageCount;
	const offset = (page - 1) * per;

	// #705: in the default view (status `active`, not the Archived view) say how many contacts
	// the same filter would find among the unsubscribed and the archived, with links to them.
	let hidden: { unsubscribed: number; archived: number; unsubscribedHref: string; archivedHref: string } | null = null;
	if (filter.status === defaultContactsStatus(filter.archived) && !filter.archived) {
		const unsubF = { ...filter, status: 'unsubscribed' as const };
		const archF = { ...filter, status: 'all' as const, archived: 'archived' as const };
		const [u, a] = await db.batch<{ n: number }>(
			[unsubF, archF].map((f) => {
				const w = contactsWhere(f);
				return db.prepare(`SELECT COUNT(*) AS n FROM contacts ${w.where}`).bind(...w.params);
			})
		);
		const href = (f: typeof filter) => {
			const q = new URLSearchParams(contactsFilterParams(f)).toString();
			return q ? `/contacts?${q}` : '/contacts';
		};
		hidden = {
			unsubscribed: u.results[0]?.n ?? 0,
			archived: a.results[0]?.n ?? 0,
			unsubscribedHref: href(unsubF),
			archivedHref: href(archF)
		};
	}

	const contacts = await db
		.prepare(
			`SELECT id, email, name, first_name, last_name, company, company_id, subscribed, confirm_pending, source, created_at, archived_at,
			        COALESCE((SELECT ce.tier FROM contact_engagement ce WHERE ce.contact_id = contacts.id), 'new') AS tier,
			        (SELECT ce.score FROM contact_engagement ce WHERE ce.contact_id = contacts.id) AS score
			 FROM contacts ${where} ORDER BY ${orderExpr} LIMIT ? OFFSET ?`
		)
		.bind(...params, per, offset)
		.all<{
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
			archived_at: string | null;
			tier: string;
			score: number | null;
		}>();

	// Group pickers for the Filters popover's "In group" / "Not in group" selects. Dynamic
	// segments (rules-based, #66) have no list_members rows to match against — exclude them.
	const groupOptions = {
		lists: lists.map((l) => ({ id: l.id, name: l.name })),
		segments: segments.filter((s) => !s.dynamic).map((s) => ({ id: s.id, name: s.name })),
		tags: tags.map((t) => ({ id: t.id, name: t.name })),
		companies: companies.map((c) => ({ id: c.id, name: c.name }))
	};

	// ?company_id= (#166) — name for the active-filter chip.
	const companyFilter = filter.companyId
		? await db
				.prepare('SELECT id, name FROM companies WHERE id = ?')
				.bind(filter.companyId)
				.first<{ id: number; name: string }>()
		: null;

	// #170: Company section of the Filters popover — the companies table (not the derived
	// kind='company' groups) for the picker, plus labels for the active metric chips.
	const companyPicker = await db
		.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE LIMIT 500')
		.all<{ id: number; name: string }>();
	// #445: billing metrics are named only for viewers who may see billing.
	const billing = await canSeeBilling(db, event.locals?.user ?? null);
	const metricChips = filter.metrics.map((m) => ({ code: encodeCondition(m), label: conditionLabel(m, { billing }) }));

	// #207: Pipeline stage filter options + chip label, and the optional Stage column —
	// fetched for the visible rows only.
	const stagePicker = await stageOptions(db);
	// #448 / #467: topic opt-out options and named scores (Filters panel, chips, Score column,
	// the bulk "Adjust score" for admins).
	const topicOptions = await topicPicker(db);
	const scorePicks = await scorePicker(db);
	// #516: the "Submitted form" filter's picker + chip name.
	const formOptions = (await formPicker(db)).map((f) => ({ id: f.id, name: f.status === 'archived' ? `${f.name} (archived)` : f.name }));
	let campaignLabel = '';
	if (filter.campaign) {
		const camp = await db
			.prepare('SELECT subject FROM campaigns WHERE id = ?')
			.bind(filter.campaign)
			.first<{ subject: string | null }>();
		const name = camp ? `“${camp.subject || '(no subject)'}”` : `campaign #${filter.campaign} (deleted)`;
		campaignLabel = `Contacts who ${CAMPAIGN_WHO_LABELS[filter.campaignWho || 'sent']} ${name}`;
	}
	// #583: one removable chip per active filter (contact-filter-chips.ts).
	const filterChips = contactFilterChips(filter, {
		groups: [
			...lists.map((g) => ({ ...g, kind: 'list' })),
			...segments.map((g) => ({ ...g, kind: 'segment' })),
			...tags.map((g) => ({ ...g, kind: 'tag' })),
			...companies.map((g) => ({ ...g, kind: 'company' }))
		],
		company: companyFilter,
		stages: stagePicker,
		topics: topicOptions,
		scores: scorePicks,
		forms: formOptions,
		campaignLabel,
		billing
	});
	const pipelineChip = pipelineChipLabel(filter.pipeline, stagePicker);
	const deliveryChips = filterChips.filter((c) => DELIVERY_CHIP_KINDS.has(c.kind));

	const scoresByContact = Object.fromEntries(
		await scoresForContacts(
			db,
			contacts.results.map((c) => c.id)
		)
	);
	const stageByContact = await stagesForContacts(
		db,
		contacts.results.map((c) => c.id)
	);

	// #214: "Remove from list" / "Remove tag" pickers only offer groups the selection is in —
	// per visible row for checked rows, aggregated over the filter for "all matching".
	const pageGroups = await groupsOfIds(
		db,
		contacts.results.map((c) => c.id)
	);
	const matchGroups =
		matched > contacts.results.length
			? await groupsOfQuery(db, { sql: `SELECT id FROM contacts ${where}`, binds: params })
			: [];

	// #423: the Overview section + its filter-aware activity feed. Same filter as the table.
	const period = parsePeriod(event.url.searchParams.get('period'));
	const feedOpts = parseFeedOptions(event.url.searchParams);
	const [overview, feed] = await Promise.all([
		loadContactsOverview(db, filter, { period, tz: await getTimezone(db) }),
		loadFeed(db, where, params, feedOpts, period)
	]);

	// Params the Overview owns — carried by every table link so paging keeps them.
	const overviewParams: Record<string, string> = {};
	for (const k of ['period', 'feed_types', 'feed_period', 'feed_group']) {
		const v = event.url.searchParams.get(k);
		if (v) overviewParams[k] = v;
	}

	return {
		overview,
		feed,
		overviewActions: overviewActions(filter, period),
		overviewParams,
		scopeLabel: scopeLabel(filter, {
			groups: [...lists, ...segments, ...tags, ...companies],
			company: companyFilter?.name ?? null,
			pipeline: pipelineChip,
			delivery: deliveryChips.map((c) => c.label),
			metrics: metricChips.map((m) => m.label)
		}),
		lists,
		segments,
		tags,
		companies,
		companyPicker: companyPicker.results,
		metricChips,
		billing,
		stagePicker,
		topicOptions,
		scorePicks,
		formOptions,
		scoresByContact,
		adjustScores: event.locals?.user?.role === 'admin' ? scorePicks : [],
		filterChips,
		campaignLabel,
		stageByContact,
		pageGroups,
		matchGroups,
		bulkCap: BULK_CAP,
		contacts: contacts.results,
		totals: totals ?? { total: 0, subscribed: 0, archived: 0 },
		hidden,
		sort,
		dir: dir === 'ASC' ? 'asc' : 'desc',
		q: filter.q,
		matchCount: narrowed ? matched : null,
		filter,
		filterParams: contactsFilterParams(filter),
		filtered: isFiltered(filter),
		narrowed,
		matched,
		page,
		per,
		pageCount,
		perOptions: PER_OPTIONS,
		groupOptions,
		companyFilter,
		activeAutomations
	};
};

// ---------------------------------------------------------------------------
// #423: the Overview's feed and quick actions
// ---------------------------------------------------------------------------

type FeedOptions = { types: string[]; period: boolean; group: boolean };

function parseFeedOptions(src: URLSearchParams): FeedOptions {
	return {
		types: parseFeedTypes(src.get('feed_types')),
		period: src.get('feed_period') === '1',
		group: src.get('feed_group') === '1'
	};
}

/** The scoped feed: the table's filter (archived only when the filter asks), the picked types, the period. */
async function loadFeed(db: D1Database, where: string, params: unknown[], opts: FeedOptions, period: PeriodKey) {
	const size = await getFeedSize(db);
	const types = (opts.types.length ? opts.types : CONTACT_ACTIVITY_TYPES) as typeof CONTACT_ACTIVITY_TYPES;
	// Group-by-contact reads deeper so each contact can show its last 3 events.
	const items = await recentActivity(db, {
		limit: opts.group ? Math.min(size * 6, 500) : size,
		types,
		scope: { where, binds: params },
		since: opts.period ? periodSince(period, new Date()) : undefined
	});
	const groups = opts.group ? groupActivityByContact(items, 3, size) : null;
	const shown = groups ? groups.flatMap((g) => g.items) : items;
	return {
		items: groups ? [] : items,
		groups,
		extras: await activityExtras(db, shown),
		size,
		sizes: FEED_SIZES,
		types: opts.types,
		period: opts.period,
		group: opts.group,
		typeOptions: CONTACT_ACTIVITY_TYPES.map((t) => ({ key: t, label: ACTIVITY_TYPE_LABELS[t] }))
	};
}

/** The "Overview for: …" chip — the active filter in words (null = unfiltered). */
function scopeLabel(
	f: ReturnType<typeof parseContactsFilter>,
	named: { groups: { id: number; name: string }[]; company: string | null; pipeline: string | null; delivery: string[]; metrics: string[] }
): string | null {
	const group = (id: number) => named.groups.find((g) => g.id === id)?.name ?? `#${id}`;
	const parts: string[] = [];
	if (f.q) parts.push(`“${f.q}”`);
	if (f.status !== defaultContactsStatus(f.archived)) parts.push(f.status === 'all' ? 'incl. unsubscribed' : f.status);
	if (f.source) parts.push(`source ${f.source}`);
	if (f.company) parts.push(`company ${f.company}`);
	if (named.company) parts.push(`company ${named.company}`);
	if (f.addedFrom || f.addedTo) parts.push(`added ${f.addedFrom || '…'} – ${f.addedTo || 'today'}`);
	if (f.inGroup) parts.push(`in ${group(f.inGroup)}`);
	if (f.notInGroup) parts.push(`not in ${group(f.notInGroup)}`);
	if (f.visited) parts.push(`visited ${f.visited}`);
	if (f.site !== 'all') parts.push(f.site === 'any' ? 'has site activity' : 'no site activity');
	if (f.hasCompany) parts.push(f.hasCompany === 'yes' ? 'has a company' : 'no company');
	if (f.tier) parts.push(`tier ${f.tier}`);
	if (f.openedDays) parts.push(`opened in ${f.openedDays}d`);
	if (f.neverOpened) parts.push('never opened');
	if (f.openedN && f.openedOf) parts.push(`opened ${f.openedN} of last ${f.openedOf}`);
	if (named.pipeline) parts.push(named.pipeline);
	parts.push(...named.delivery, ...named.metrics);
	if (f.unsubFrom) parts.push(`unsubscribed since ${f.unsubFrom}`);
	if (f.cooledDays) parts.push(`going cold (${f.cooledDays}d)`);
	if (f.awaiting) parts.push(f.awaitingDays ? `awaiting reply > ${f.awaitingDays}d` : 'awaiting reply');
	if (f.noList) parts.push('in no list');
	if (f.archived) parts.push(f.archived === 'archived' ? 'archived' : 'incl. archived');
	return parts.length ? parts.join(' · ') : null;
}

/** "Save this view as a segment" (live when the filter maps to rules) + "Create report from this". */
function overviewActions(filter: ReturnType<typeof parseContactsFilter>, period: PeriodKey) {
	const { rules, unmapped } = filterToRules(filter);
	let reportHref = '/reports/new';
	try {
		const spec = parseReportSpec({ ...defaultSpec('contacts'), filters: { match: 'all', rules }, timeRange: { preset: period } });
		reportHref = `/reports/new?spec=${encodeSpec(spec)}`;
	} catch {
		/* a rule the report parser refuses — open the builder empty */
	}
	return { live: rules.length > 0 && unmapped.length === 0, unmapped, reportHref };
}

async function bulk(event: RequestEvent, action: BulkFormAction) {
	return bulkForm(event, await event.request.formData(), action);
}

async function bulkForm(event: RequestEvent, data: FormData, action: BulkFormAction) {
	const db = getDB(event);
	const out = await runBulkForm(db, data, action, {
		query: () => contactsFilterQuery(db, data),
		postmark: await getMailProvider(db, event.platform?.env),
		actor: event.locals?.user?.github_login
	});
	if (!out.ok) return fail(out.status, { bulkError: out.error });
	return { bulkSuccess: out.message, affected: out.affected, skipped: out.skipped, bulkHref: out.href ?? null };
}

export const actions: Actions = {
	// Explicitly create an empty list/segment/tag (#51). Kind-validated — companies are
	// derived from contacts.company and can't be hand-created (kind-leak rule, checklist §4).
	createGroup: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const kind = String(data.get('kind') ?? '');
		const name = String(data.get('name') ?? '').trim();
		if (kind !== 'list' && kind !== 'segment' && kind !== 'tag') {
			return fail(400, { groupError: 'Invalid group type.' });
		}
		if (!name) return fail(400, { groupError: 'Enter a name.' });
		if (name.length > 60) return fail(400, { groupError: 'Name is too long (60 chars max).' });

		const existing = await db
			.prepare('SELECT id FROM lists WHERE name = ? AND kind = ?')
			.bind(name, kind)
			.first<{ id: number }>();
		if (existing) return fail(400, { groupError: `A ${kind} named “${name}” already exists.` });

		const description = String(data.get('description') ?? '').trim().slice(0, 500) || null;
		const origin = String(data.get('origin') ?? '').trim().slice(0, 500) || null;
		await db
			.prepare('INSERT INTO lists (name, kind, description, origin) VALUES (?, ?, ?, ?)')
			.bind(name, kind, description, origin)
			.run();
		return { groupOk: true };
	},

	// #306: the import modal's Hygiene preview — the file's email column only, nothing written.
	importPreview: async (event) => {
		const data = await event.request.formData();
		const file = data.get('file');
		const emailCol = String(data.get('email_col') ?? '');
		if (!(file instanceof File) || file.size === 0 || !emailCol) {
			return fail(400, { previewError: 'Choose a CSV file and its email column.' });
		}
		const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: true, transform: unguardCsvCell });
		const emails = parsed.data.map((r) => String(r[emailCol] ?? ''));
		return { preview: await previewImportHygiene(emails) };
	},

	import: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();

		const file = data.get('file');
		const emailCol = String(data.get('email_col') ?? '');
		const nameCol = String(data.get('name_col') ?? '');
		const firstCol = String(data.get('first_col') ?? '');
		const lastCol = String(data.get('last_col') ?? '');
		const companyCol = String(data.get('company_col') ?? '');
		const splitName = !!data.get('split_name'); // derive first/last from the name column
		let listName = String(data.get('list_name') ?? '').trim();

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Please choose a CSV file.' });
		}
		if (!emailCol) {
			return fail(400, { error: 'Select which column holds the email address.' });
		}
		if (!listName) listName = 'Imported list';
		// #306: accepted typo fixes, and what to do with no-MX / disposable rows.
		const fixes = parseFixes(data.get('fixes'));
		const invalidMode = parseInvalidMode(data.get('invalid_mode'));

		const text = await file.text();
		const parsed = Papa.parse<Record<string, string>>(text, {
			header: true,
			skipEmptyLines: true,
			transform: unguardCsvCell
		});
		if (parsed.errors.length && parsed.data.length === 0) {
			return fail(400, { error: `Could not parse CSV: ${parsed.errors[0].message}` });
		}

		const seen = new Set<string>();
		let invalid = 0;
		let duplicates = 0;
		type Row = { email: string; name: string; first: string; last: string; company: string };
		let rows: Row[] = [];

		let fixed = 0;
		for (const r of parsed.data) {
			let email = String(r[emailCol] ?? '')
				.trim()
				.toLowerCase();
			const fix = fixes.get(email);
			if (fix) {
				email = fix;
				fixed++;
			}
			if (!isEmail(email)) {
				invalid++;
				continue;
			}
			if (seen.has(email)) {
				duplicates++;
				continue;
			}
			seen.add(email);
			const name = nameCol ? String(r[nameCol] ?? '').trim() : '';
			let first = firstCol ? String(r[firstCol] ?? '').trim() : '';
			let last = lastCol ? String(r[lastCol] ?? '').trim() : '';
			// Split a single full-name column into first/last when asked (and not already mapped).
			if (splitName && name && !first && !last) {
				const parts = name.split(/\s+/).filter(Boolean);
				first = parts[0] ?? '';
				last = parts.slice(1).join(' ');
			}
			const company = companyCol ? String(r[companyCol] ?? '').trim() : '';
			rows.push({ email, name, first, last, company });
		}

		// #306: hygiene per address. Invalid (no MX / disposable) rows are skipped, or imported
		// as unsubscribed (new contacts only) and tagged `hygiene:invalid` — the importer's choice.
		const { byEmail, unchecked } = await hygieneForEmails(rows.map((r) => r.email));
		const hygiene = { ...countHygiene(byEmail.values(), unchecked), fixed, skipped: 0, mode: invalidMode };
		if (invalidMode === 'skip') {
			const before = rows.length;
			rows = rows.filter((r) => !hygieneInvalid(byEmail.get(r.email)!));
			hygiene.skipped = before - rows.length;
		}

		if (rows.length === 0) {
			return fail(400, { error: hygiene.skipped ? 'Every address failed the hygiene check — nothing imported.' : 'No valid email addresses found in that file.' });
		}

		// Resolve (or create) the target list.
		let list = await db
			.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'list'")
			.bind(listName)
			.first<{ id: number }>();
		if (!list) {
			list = (await db
				.prepare("INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id")
				.bind(listName)
				.first<{ id: number }>())!;
		}
		const listId = list.id;

		// `subscribed` applies to new contacts only — an existing one keeps its status.
		const upsert = db.prepare(
			`INSERT INTO contacts (email, name, first_name, last_name, company, source, subscribed)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
			   first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
			   last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
			   company = COALESCE(NULLIF(excluded.company, ''), contacts.company)`
		);
		const link = db.prepare(
			`INSERT OR IGNORE INTO list_members (list_id, contact_id)
			 SELECT ?, id FROM contacts WHERE email = ?`
		);

		// Count how many of these emails already exist (before the upsert) → updated vs new.
		let updated = 0;
		for (const part of chunk(rows.map((r) => r.email), 100)) {
			const placeholders = part.map(() => '?').join(',');
			const res = await db
				.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE email IN (${placeholders})`)
				.bind(...part)
				.first<{ n: number }>();
			updated += res?.n ?? 0;
		}
		const added = rows.length - updated;

		const source = file.name.slice(0, 120);
		for (const part of chunk(rows, 50)) {
			await db.batch(
				part.map((r) =>
					upsert.bind(r.email, r.name, r.first, r.last, r.company, source, hygieneInvalid(byEmail.get(r.email)!) ? 0 : 1)
				)
			);
			await db.batch(part.map((r) => link.bind(listId, r.email)));
		}

		// Hygiene before auto-enroll, so a new invalid contact is already unsubscribed (enroll skips it).
		try {
			await recordForEmails(db, byEmail, rows.map((r) => r.email));
		} catch (e) {
			console.error('hygiene (import) failed:', e);
		}

		// Auto-enroll into any active list_added automation on this list (best-effort).
		try {
			await autoEnrollByEmails(db, listId, rows.map((r) => r.email));
		} catch (e) {
			console.error('auto-enroll (import) failed:', e);
		}

		// Sync company-group membership (#47) for imported rows that carried a company.
		if (companyCol) {
			const withCompany = rows.filter((r) => r.company);
			if (withCompany.length) {
				const byEmail = new Map(withCompany.map((r) => [r.email, r.company]));
				for (const part of chunk([...byEmail.keys()], 100)) {
					const placeholders = part.map(() => '?').join(',');
					const ids = await db
						.prepare(`SELECT id, email FROM contacts WHERE email IN (${placeholders})`)
						.bind(...part)
						.all<{ id: number; email: string }>();
					for (const c of ids.results) {
						try {
							await syncCompanyMembership(db, c.id, byEmail.get(c.email) ?? null);
						} catch (e) {
							console.error('company sync (import) failed:', e);
						}
					}
				}
			}
		}

		return { success: true, imported: rows.length, added, updated, invalid, duplicates, listName, hygiene };
	},

	addManual: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const raw = String(data.get('emails') ?? '');
		const listName = String(data.get('list_name') ?? '').trim();
		const source = String(data.get('source') ?? '').trim() || 'manual';

		const seen = new Set<string>();
		let invalid = 0;
		let duplicates = 0;
		type Row = { email: string; name: string; first: string; last: string };
		const rows: Row[] = [];

		// Accept one per line: "email", "email, Name", or "Name <email>".
		for (const lineRaw of raw.split(/\r?\n/)) {
			const line = lineRaw.trim();
			if (!line) continue;
			let email = '';
			let name = '';
			const angle = line.match(/^(.*?)<([^>]+)>$/);
			if (angle) {
				name = angle[1].trim().replace(/^["']|["']$/g, '');
				email = angle[2].trim();
			} else if (line.includes(',')) {
				const [a, b] = line.split(',');
				if (isEmail(a.trim())) {
					email = a.trim();
					name = (b ?? '').trim();
				} else if (isEmail((b ?? '').trim())) {
					email = b.trim();
					name = a.trim();
				} else {
					email = a.trim();
				}
			} else {
				email = line;
			}
			email = email.toLowerCase();
			if (!isEmail(email)) {
				invalid++;
				continue;
			}
			if (seen.has(email)) {
				duplicates++;
				continue;
			}
			seen.add(email);
			const parts = name.split(/\s+/).filter(Boolean);
			rows.push({ email, name, first: parts[0] ?? '', last: parts.slice(1).join(' ') });
		}

		if (rows.length === 0) {
			return fail(400, { manualError: 'Enter at least one valid email address.' });
		}

		let listId: number | null = null;
		if (listName) {
			let list = await db
				.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'list'")
				.bind(listName)
				.first<{ id: number }>();
			if (!list) {
				list = (await db
					.prepare("INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id")
					.bind(listName)
					.first<{ id: number }>())!;
			}
			listId = list.id;
		}

		const upsert = db.prepare(
			`INSERT INTO contacts (email, name, first_name, last_name, source)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
			   first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
			   last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name)`
		);
		const link = db.prepare(
			`INSERT OR IGNORE INTO list_members (list_id, contact_id)
			 SELECT ?, id FROM contacts WHERE email = ?`
		);
		for (const part of chunk(rows, 50)) {
			await db.batch(part.map((r) => upsert.bind(r.email, r.name, r.first, r.last, source)));
			if (listId) await db.batch(part.map((r) => link.bind(listId, r.email)));
		}

		// #306: hygiene — stored and tagged, never a reject; typo suggestions go in the banner.
		const { byEmail, unchecked } = await hygieneForEmails(rows.map((r) => r.email));
		try {
			await recordForEmails(db, byEmail, rows.map((r) => r.email));
		} catch (e) {
			console.error('hygiene (manual add) failed:', e);
		}
		const hygiene = {
			...countHygiene(byEmail.values(), unchecked),
			suggestions: [...byEmail.values()]
				.filter((h) => h.suggestion)
				.slice(0, 10)
				.map((h) => ({ email: h.email, suggestion: h.suggestion! }))
		};

		if (listId) {
			try {
				await autoEnrollByEmails(db, listId, rows.map((r) => r.email));
			} catch (e) {
				console.error('auto-enroll (manual add) failed:', e);
			}
		}

		return {
			manualSuccess: true,
			added: rows.length,
			invalid,
			duplicates,
			listName: listName || null,
			hygiene
		};
	},

	// Bulk bar (#214): every action takes the checked rows or `all=1` + the current filter,
	// and reports through the same banner. Shared logic in $lib/server/contact-bulk.
	addToList: (event) => bulk(event, 'add_list'),
	removeFromList: (event) => bulk(event, 'remove_list'),
	addToSegment: (event) => bulk(event, 'add_segment'),
	// Tag = list with kind='tag'; fires list_added autos. `snapshot:approved` is refused (#110).
	bulkTag: (event) => bulk(event, 'add_tag'),
	removeTag: (event) => bulk(event, 'remove_tag'),
	// Enroll hand-picked contacts into an active automation (#97).
	addToAutomation: (event) => bulk(event, 'enroll'),
	// Permanent delete with the shared cascade rules (deleteContactsByIds): events/recipients
	// cleared, replies + unsubscribes kept with contact_id nulled. "All matching" needs a typed
	// `delete` confirmation.
	deleteContacts: (event) => bulk(event, 'delete'),
	// #280: archive (active view) / restore (archived view) — `archived` rides the filter params.
	archiveContacts: (event) => bulk(event, 'archive'),
	restoreContacts: (event) => bulk(event, 'restore'),
	// #279: unsubscribe (reason `operator (bulk)`, active passes cancelled, optional Postmark
	// suppression) / resubscribe (subscribed = 1 only — Postmark suppressions stay).
	bulkUnsubscribe: (event) => bulk(event, 'unsubscribe'),
	bulkResubscribe: (event) => bulk(event, 'resubscribe'),
	// #460: set / clear the engagement tier override on the selection.
	bulkSetTier: (event) => bulk(event, 'set_tier'),
	// #467: ± points on a score for the selection (admin only — like the contact page's Adjust).
	bulkAdjustScore: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { bulkError: 'Only admins can adjust scores.' });
		return bulk(event, 'adjust_score');
	},

	// #423: the Overview feed's size — the same app_state setting as the dashboard's feed.
	feedSize: async (event) => {
		const data = await event.request.formData();
		const ok = await setFeedSize(getDB(event), Number(data.get('size')));
		if (!ok) return fail(400, { bulkError: 'Pick 25, 50 or 100.' });
		return { ok: true };
	},

	// #423: "Save this view as a segment". A filter that maps fully to rules becomes a live
	// (dynamic) segment; anything else is a hand-picked snapshot through the bulk add path.
	saveView: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const name = String(data.get('new_segment') ?? '').trim();
		if (!name) return fail(400, { bulkError: 'Name the segment.', viewSaved: true });
		if (name.length > 60) return fail(400, { bulkError: 'Name is too long (60 chars max).', viewSaved: true });
		const filter = parseContactsFilter(data);
		const { rules, unmapped } = filterToRules(filter);
		if (data.get('live') === '1' && rules.length && !unmapped.length) {
			const taken = await db.prepare(`SELECT id FROM lists WHERE name = ? AND kind = 'segment'`).bind(name).first();
			if (taken) return fail(400, { bulkError: `A segment named “${name}” already exists.`, viewSaved: true });
			const set: SegmentRules = { match: 'all', rules };
			const row = await db
				.prepare(`INSERT INTO lists (name, kind, rules, description) VALUES (?, 'segment', ?, ?) RETURNING id`)
				.bind(name, JSON.stringify(set), 'Saved from the contacts overview')
				.first<{ id: number }>();
			if (!row) return fail(500, { bulkError: 'The segment was not saved.', viewSaved: true });
			const compiled = compileSegment(set);
			const count = await db.prepare(`SELECT COUNT(*) AS n FROM (${compiled.sql})`).bind(...compiled.binds).first<{ n: number }>();
			return {
				bulkSuccess: `Saved live segment “${name}” · ${(count?.n ?? 0).toLocaleString('en-US')} contacts now`,
				affected: count?.n ?? 0,
				skipped: 0,
				bulkHref: `/lists/${row.id}`,
				viewSaved: true
			};
		}
		data.set('all', '1');
		const out = await bulkForm(event, data, 'add_segment');
		return isActionFailure(out) ? fail(out.status, { bulkError: (out.data as unknown as { bulkError: string }).bulkError, viewSaved: true }) : { ...out, viewSaved: true };
	},

	deleteSegment: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const id = Number(data.get('segment_id'));
		if (!id) return fail(400, { segError: 'Missing segment.' });
		// Only delete segments, never an imported list. Memberships cascade.
		const res = await db.prepare("DELETE FROM lists WHERE id = ? AND kind = 'segment'").bind(id).run();
		// #228: rules that pointed at it are marked invalid, not left dangling.
		if (res.meta.changes) await invalidateGroupRules(db, [id]);
		return { segDeleted: true };
	}
};

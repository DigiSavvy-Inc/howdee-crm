/**
 * Filtering for the full contacts table (#94) — pagination + a Filters popover on
 * `/contacts`. Distinct from `contact-filter.ts` (which filters the members of ONE
 * list/segment/tag on `/lists/[id]`): this one runs over `contacts` alone (no
 * `list_members` join/alias), and its sort keys are owned by the page's own
 * whitelist in `+page.server.ts` — don't reuse `memberQuery`'s sorts here.
 *
 * The live search `?q=` (#91) composes with everything below via `buildContactSearch`.
 */

import { buildContactSearch } from './contact-search';
import { parseMetricConditions, serializeMetricConditions, type MetricCondition } from '$lib/company-metrics';
import { metricClause } from './company-metrics';
import { isTier, type TierName } from '$lib/engagement-view';
import { neverOpenedClause, openedOfLastClause, openedWithinClause, tierClause } from './engagement-query';
import { parsePipelineFilter, pipelineClause, type PipelineFilter } from './pipeline-query';
import { hygieneClause, isHygieneFilter, type HygieneFilter } from '$lib/email-hygiene';
import { bouncedClause, campaignWhoClause, isCampaignWho, spamClause, type BounceKind, type CampaignWho } from './bounce-filter';
import { goingColdClause } from './engagement-insights';
import { awaitingContactIds } from './conversations';
import { scoreBandClause, scoreValueClause } from './scoring/query';
import { formSubmittedClause } from './form-reads';
import { activeSubscriptionSql } from './active-audience';
import { containsSql } from './sql-match';

// pending = double opt-in not confirmed yet (#510). #705: `active` = subscribed or pending — the
// default outside the Archived view; `all` (an explicit `status=all`) adds the unsubscribed.
export type ContactsStatusFilter = 'active' | 'all' | 'subscribed' | 'unsubscribed' | 'pending';

const STATUSES: readonly ContactsStatusFilter[] = ['active', 'all', 'subscribed', 'unsubscribed', 'pending'];

/** #705: the status a view has when `status` isn't in the URL — `active` (the active audience,
 *  see active-audience.ts), except in the Archived view, which shows every archived contact. */
export function defaultContactsStatus(archived: ArchivedView | undefined): ContactsStatusFilter {
	return archived ? 'all' : 'active';
}

export type ContactsFilter = {
	q: string;
	status: ContactsStatusFilter;
	source: string;
	company: string;
	companyId: number | null; // linked to this companies row (#166)
	addedFrom: string; // YYYY-MM-DD (inclusive)
	addedTo: string; // YYYY-MM-DD (inclusive)
	inGroup: number | null; // also a member of this list/segment/tag/company
	notInGroup: number | null; // NOT a member of this list/segment/tag/company
	visited: string; // site tracking (#153): a pageview whose path contains this…
	visitedDays: number | null; // …within the last N days (null = any time)
	site: 'all' | 'any' | 'none'; // has / has no site activity at all
	hasCompany: 'yes' | 'no' | ''; // #170: linked to any companies row / to none
	metrics: MetricCondition[]; // #170: company metric conditions (`cm`), ALL must match
	tier: TierName | ''; // #114: engagement tier
	openedDays: number | null; // #114: opened an email in the last N days
	neverOpened: boolean; // #114: sent ≥1 email, never opened one
	openedN: number | null; // #114: opened ≥ N…
	openedOf: number | null; // …of the last M sends (both set with N ≤ M, or neither)
	pipeline: PipelineFilter | null; // #207: on the board (any) / not on it (none) / in stage <id>
	archived?: ArchivedView; // #280: `?archived=1|all`; unset = active (non-archived) only
	bounced: BounceKind | ''; // #279: has a bounce event (hard only, or any)
	spam: boolean; // #279: has a spam complaint
	campaign: number | null; // #279: a recipient of this campaign…
	campaignWho: CampaignWho | ''; // …in this segment (blank = every accepted recipient)
	hygiene?: HygieneFilter; // #306: `meta.hygiene` invalid / role / typo-suggested
	// #423 (contacts overview tiles):
	unsubFrom?: string; // `unsub_from`: an unsubscribes row dated on/after this YYYY-MM-DD
	cooledDays?: number | null; // `cooled_days`: going cold — tier dropped into cool/cold in the last N days
	awaiting?: boolean; // `awaiting=1`: a conversation where they wrote last (conversations.ts)
	awaitingDays?: number | null; // `awaiting_days`: …and their last message is over N days old
	awaitingIds?: number[]; // resolved by `resolveContactsFilter` — the SQL can't thread conversations
	noList?: boolean; // `no_list=1`: in no list (kind='list')
	// #448 (the contact-rule kinds, as filters):
	topicOut?: number | null; // `topic_out`: opted out of this preference-page topic (topic_optouts)
	createdDays?: number | null; // `created_days`: contact created within the last N days
	// #516: `form=any|<form id>` submitted a form (any / that one), `form_days=N` in the last N days
	form?: FormFilter | null;
	formDays?: number | null;
	// #467 (named scores, the same clauses as the score_value / score_band rules):
	score?: ScoreFilter | null; // `score=<id>:<op>:<n>` (op gt|gte|lt|lte|eq; between = `<id>:between:<lo>:<hi>`)
	band?: BandFilter | null; // `band=<id>:<label>`
};

/** #516: a form id, or 'any' form. */
export type FormFilter = number | 'any';

/** `form=any|<id>` → the filter, else null. */
export function parseFormFilter(v: string | null | undefined): FormFilter | null {
	const s = (v ?? '').trim().toLowerCase();
	if (s === 'any') return 'any';
	const n = Number(s);
	return s && Number.isInteger(n) && n > 0 ? n : null;
}

export type ScoreFilter = { scoreId: number; op: string; n: number; n2?: number };
export type BandFilter = { scoreId: number; label: string };

const SCORE_FILTER_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'between'];

/** `score=<id>:<op>:<n>[:<n2>]` → a filter, or null when malformed. */
export function parseScoreFilter(raw: string): ScoreFilter | null {
	const [id, op, a, b] = raw.split(':');
	const scoreId = Number(id);
	const n = Number(a);
	if (!Number.isInteger(scoreId) || scoreId <= 0 || !SCORE_FILTER_OPS.includes(op) || a === undefined || a === '' || !Number.isFinite(n)) return null;
	if (op === 'between') {
		const n2 = Number(b);
		if (b === undefined || b === '' || !Number.isFinite(n2)) return null;
		return { scoreId, op, n, n2 };
	}
	return { scoreId, op, n };
}

export function serializeScoreFilter(f: ScoreFilter): string {
	return [f.scoreId, f.op, f.n, ...(f.op === 'between' ? [f.n2] : [])].join(':');
}

/** `band=<id>:<label>` → a filter, or null. */
export function parseBandFilter(raw: string): BandFilter | null {
	const i = raw.indexOf(':');
	if (i < 1) return null;
	const scoreId = Number(raw.slice(0, i));
	const label = raw.slice(i + 1).trim();
	if (!Number.isInteger(scoreId) || scoreId <= 0 || !label) return null;
	return { scoreId, label };
}

/** #280: which contacts a view shows — unset = active only. */
export type ArchivedView = 'archived' | 'all';

/** `archived=1` → archived only, `archived=all` → both, anything else → active (undefined). */
export function parseArchivedView(v: string | null | undefined): ArchivedView | undefined {
	const s = (v ?? '').trim().toLowerCase();
	if (s === '1' || s === 'true' || s === 'archived') return 'archived';
	if (s === 'all') return 'all';
	return undefined;
}

/** The archived predicate over `<col>` (e.g. `archived_at`, `c.archived_at`), or null for 'all'. */
export function archivedClause(view: ArchivedView | undefined, col = 'archived_at'): string | null {
	if (view === 'all') return null;
	return view === 'archived' ? `${col} IS NOT NULL` : `${col} IS NULL`;
}

/** Anything that can hand back a raw string param (URLSearchParams, FormData). */
type Source = { get(key: string): string | File | null; getAll?(key: string): (string | File)[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(src: Source, key: string, max = 120): string {
	const v = src.get(key);
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function groupId(src: Source, key: string): number | null {
	const n = Number(str(src, key));
	return Number.isInteger(n) && n > 0 ? n : null;
}

function posInt(src: Source, key: string, max: number): number | null {
	const n = Number(str(src, key, 6));
	return Number.isInteger(n) && n > 0 ? Math.min(n, max) : null;
}

function isoDate(src: Source, key: string): string {
	const v = str(src, key, 10);
	return ISO_DATE.test(v) ? v : '';
}

/**
 * `opts.defaultStatus` (#705): the status when `status` isn't given. Unset = the page default
 * (`defaultContactsStatus`); `/api/v1/contacts/bulk` passes `all` so an API filter keeps
 * matching what it matched before.
 */
export function parseContactsFilter(src: Source, opts: { defaultStatus?: ContactsStatusFilter } = {}): ContactsFilter {
	const status = str(src, 'status') as ContactsStatusFilter;
	const archived = parseArchivedView(str(src, 'archived', 10));
	const site = str(src, 'site');
	const tier = str(src, 'tier');
	const openedOf = posInt(src, 'opened_of', 50);
	const openedN = openedOf ? posInt(src, 'opened_n', openedOf) : null;
	return {
		q: str(src, 'q', 100),
		status: STATUSES.includes(status) ? status : (opts.defaultStatus ?? defaultContactsStatus(archived)),
		source: str(src, 'source'),
		company: str(src, 'company'),
		companyId: groupId(src, 'company_id'),
		addedFrom: isoDate(src, 'added_from'),
		addedTo: isoDate(src, 'added_to'),
		inGroup: groupId(src, 'in'),
		notInGroup: groupId(src, 'notin'),
		visited: str(src, 'visited', 200),
		visitedDays: posInt(src, 'visited_days', 3650),
		site: site === 'any' || site === 'none' ? site : 'all',
		hasCompany: str(src, 'has_company') === 'yes' ? 'yes' : str(src, 'has_company') === 'no' ? 'no' : '',
		metrics: parseMetricConditions(src),
		tier: isTier(tier) ? tier : '',
		openedDays: posInt(src, 'opened_days', 3650),
		neverOpened: str(src, 'never_opened') === '1',
		openedN,
		openedOf: openedN ? openedOf : null,
		pipeline: parsePipelineFilter(str(src, 'pipeline', 12)),
		archived,
		hygiene: isHygieneFilter(str(src, 'hygiene')) ? (str(src, 'hygiene') as HygieneFilter) : undefined,
		unsubFrom: isoDate(src, 'unsub_from'),
		cooledDays: posInt(src, 'cooled_days', 3650),
		awaiting: str(src, 'awaiting') === '1',
		awaitingDays: str(src, 'awaiting') === '1' ? posInt(src, 'awaiting_days', 3650) : null,
		noList: str(src, 'no_list') === '1',
		topicOut: groupId(src, 'topic_out'),
		createdDays: posInt(src, 'created_days', 3650),
		form: parseFormFilter(str(src, 'form', 12)),
		formDays: parseFormFilter(str(src, 'form', 12)) ? posInt(src, 'form_days', 3650) : null,
		score: parseScoreFilter(str(src, 'score', 60)),
		band: parseBandFilter(str(src, 'band', 60)),
		...parseDeliverability(src)
	};
}

// #279: bounce / spam / campaign-segment filters (bounce-filter.ts).
function parseDeliverability(src: Source): Pick<ContactsFilter, 'bounced' | 'spam' | 'campaign' | 'campaignWho'> {
	const bounced = str(src, 'bounced');
	const campaign = groupId(src, 'campaign');
	const who = str(src, 'campaign_who');
	return {
		bounced: bounced === 'hard' || bounced === 'any' ? bounced : '',
		spam: str(src, 'spam') === '1',
		campaign,
		campaignWho: campaign && isCampaignWho(who) ? who : ''
	};
}

/**
 * True when a NON-q field narrows the set — drives the Filters-popover dot (a live
 * search alone shouldn't light it up; it has its own always-visible input).
 */
export function isFiltered(f: ContactsFilter): boolean {
	return !!(
		f.status !== defaultContactsStatus(f.archived) ||
		f.source ||
		f.company ||
		f.companyId ||
		f.addedFrom ||
		f.addedTo ||
		f.inGroup ||
		f.notInGroup ||
		f.visited ||
		f.site !== 'all' ||
		f.hasCompany ||
		f.metrics.length ||
		f.tier ||
		f.openedDays ||
		f.neverOpened ||
		f.openedN ||
		f.pipeline ||
		f.bounced ||
		f.spam ||
		f.campaign ||
		f.hygiene ||
		f.unsubFrom ||
		f.cooledDays ||
		f.awaiting ||
		f.noList ||
		f.topicOut ||
		f.createdDays ||
		f.form ||
		f.score ||
		f.band
	);
}

/** True when ANY filter, including q, narrows the set — drives the heading + empty state. */
export function isNarrowed(f: ContactsFilter): boolean {
	return !!f.q || isFiltered(f);
}

/** Serialize back to URL params — for pagination links and form round-trips. Omits defaults. */
export function contactsFilterParams(f: ContactsFilter): Record<string, string> {
	const p: Record<string, string> = {};
	if (f.q) p.q = f.q;
	if (f.status !== defaultContactsStatus(f.archived)) p.status = f.status;
	if (f.source) p.source = f.source;
	if (f.company) p.company = f.company;
	if (f.companyId) p.company_id = String(f.companyId);
	if (f.addedFrom) p.added_from = f.addedFrom;
	if (f.addedTo) p.added_to = f.addedTo;
	if (f.inGroup) p.in = String(f.inGroup);
	if (f.notInGroup) p.notin = String(f.notInGroup);
	if (f.visited) p.visited = f.visited;
	if (f.visited && f.visitedDays) p.visited_days = String(f.visitedDays);
	if (f.site !== 'all') p.site = f.site;
	if (f.hasCompany) p.has_company = f.hasCompany;
	if (f.metrics.length) p.cm = serializeMetricConditions(f.metrics);
	if (f.tier) p.tier = f.tier;
	if (f.openedDays) p.opened_days = String(f.openedDays);
	if (f.neverOpened) p.never_opened = '1';
	if (f.openedN && f.openedOf) {
		p.opened_n = String(f.openedN);
		p.opened_of = String(f.openedOf);
	}
	if (f.pipeline) p.pipeline = String(f.pipeline);
	if (f.archived) p.archived = f.archived === 'archived' ? '1' : 'all';
	if (f.bounced) p.bounced = f.bounced;
	if (f.spam) p.spam = '1';
	if (f.campaign) p.campaign = String(f.campaign);
	if (f.campaign && f.campaignWho) p.campaign_who = f.campaignWho;
	if (f.hygiene) p.hygiene = f.hygiene;
	if (f.unsubFrom) p.unsub_from = f.unsubFrom;
	if (f.cooledDays) p.cooled_days = String(f.cooledDays);
	if (f.awaiting) p.awaiting = '1';
	if (f.awaiting && f.awaitingDays) p.awaiting_days = String(f.awaitingDays);
	if (f.noList) p.no_list = '1';
	if (f.topicOut) p.topic_out = String(f.topicOut);
	if (f.createdDays) p.created_days = String(f.createdDays);
	if (f.form) p.form = String(f.form);
	if (f.form && f.formDays) p.form_days = String(f.formDays);
	if (f.score) p.score = serializeScoreFilter(f.score);
	if (f.band) p.band = `${f.band.scoreId}:${f.band.label}`;
	return p;
}

// Sortable columns (#55) — whitelisted map only, never user SQL. Name sorts on the
// same derived display name the table shows. Shared by /contacts and /companies/[id].
const CONTACT_SORTS: Record<string, string> = {
	email: 'email',
	name: "COALESCE(NULLIF(name, ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')))",
	company: 'company',
	subscribed: 'subscribed',
	source: 'source',
	created_at: 'created_at',
	// #423: engagement — tier by ladder rank (hot first when descending), score as stored.
	tier: `COALESCE((SELECT CASE ce.tier WHEN 'hot' THEN 6 WHEN 'warm' THEN 5 WHEN 'cool' THEN 4 WHEN 'cold' THEN 3 WHEN 'never' THEN 2 ELSE 1 END FROM contact_engagement ce WHERE ce.contact_id = contacts.id), 1)`,
	score: '(SELECT ce.score FROM contact_engagement ce WHERE ce.contact_id = contacts.id)'
};

/** #467: `score:<id>` sorts by that named score's cached value (no row = 0). The id is a
 *  validated integer, so the expression stays whitelisted. */
function scoreSortExpr(sort: string): string | null {
	const m = /^score:(\d{1,9})$/.exec(sort);
	return m ? `COALESCE((SELECT cs.value FROM contact_scores cs WHERE cs.contact_id = contacts.id AND cs.score_id = ${Number(m[1])}), 0)` : null;
}

/** `?sort=` / `?dir=` → a whitelisted ORDER BY over `contacts` (default newest first). */
export function contactsOrder(src: Source): { sort: string; dir: 'ASC' | 'DESC'; orderExpr: string } {
	const sortParam = str(src, 'sort') || 'created_at';
	const sort = CONTACT_SORTS[sortParam] || scoreSortExpr(sortParam) ? sortParam : 'created_at';
	const dir = str(src, 'dir') === 'asc' ? 'ASC' : 'DESC';
	const col = CONTACT_SORTS[sort] ?? scoreSortExpr(sort)!;
	// NULLs/empties last so unset companies/sources don't crowd the top of ascending sorts.
	return { sort, dir, orderExpr: `(${col} IS NULL OR ${col} = '') ASC, ${col} ${dir}, id DESC` };
}

/**
 * SQL fragments over `contacts` alone (no alias, no join) — a full `WHERE ...` clause ready
 * to splice after `FROM contacts` (`''` only for `archived: 'all'` with nothing else set).
 * Archived contacts (#280) are excluded unless `f.archived` asks for them; unsubscribed ones
 * (#705) unless `f.status` is `all` or `unsubscribed` (the default `active` hides them).
 */
export function contactsWhere(f: ContactsFilter): { where: string; params: (string | number)[] } {
	const clauses: string[] = [];
	const params: (string | number)[] = [];

	if (f.q) {
		const { where, binds } = buildContactSearch(f.q);
		if (where) {
			// buildContactSearch returns "WHERE (...)" — splice just the parenthesized clause.
			clauses.push(where.replace(/^WHERE\s*/, ''));
			params.push(...binds);
		}
	}
	if (f.status === 'active') clauses.push(activeSubscriptionSql());
	if (f.status === 'subscribed') clauses.push('subscribed = 1');
	if (f.status === 'unsubscribed') clauses.push('subscribed = 0 AND confirm_pending = 0');
	if (f.status === 'pending') clauses.push('subscribed = 0 AND confirm_pending = 1');
	if (f.source) {
		clauses.push(containsSql("COALESCE(source, '')")); // #485: instr, no LIKE pattern cap
		params.push(f.source);
	}
	if (f.company) {
		clauses.push(containsSql("COALESCE(company, '')"));
		params.push(f.company);
	}
	if (f.companyId) {
		clauses.push('company_id = ?');
		params.push(f.companyId);
	}
	if (f.addedFrom) {
		clauses.push('date(created_at) >= ?');
		params.push(f.addedFrom);
	}
	if (f.addedTo) {
		clauses.push('date(created_at) <= ?');
		params.push(f.addedTo);
	}
	if (f.inGroup) {
		clauses.push(
			'EXISTS (SELECT 1 FROM list_members x WHERE x.contact_id = contacts.id AND x.list_id = ?)'
		);
		params.push(f.inGroup);
	}
	if (f.notInGroup) {
		clauses.push(
			'NOT EXISTS (SELECT 1 FROM list_members x WHERE x.contact_id = contacts.id AND x.list_id = ?)'
		);
		params.push(f.notInGroup);
	}
	// Site tracking (#153). `site_events.path` is stored without a query string.
	if (f.visited) {
		const window = f.visitedDays ? ` AND se.occurred_at >= datetime('now', ?)` : '';
		clauses.push(
			`EXISTS (SELECT 1 FROM site_events se WHERE se.contact_id = contacts.id AND se.kind = 'pageview'
			   AND ${containsSql("COALESCE(se.path, '')")}${window})`
		);
		params.push(f.visited);
		if (f.visitedDays) params.push(`-${f.visitedDays} days`);
	}
	if (f.site === 'any') clauses.push('EXISTS (SELECT 1 FROM site_events se WHERE se.contact_id = contacts.id)');
	if (f.site === 'none') clauses.push('NOT EXISTS (SELECT 1 FROM site_events se WHERE se.contact_id = contacts.id)');
	if (f.hasCompany === 'yes') clauses.push('company_id IS NOT NULL');
	if (f.hasCompany === 'no') clauses.push('company_id IS NULL');
	for (const cond of f.metrics) {
		const m = metricClause(cond, 'contacts.company_id');
		if (m) {
			clauses.push(m.clause);
			params.push(...m.binds);
		}
	}
	// Engagement (#114) — see engagement-query.ts for what each condition reads.
	const engagement = [
		f.tier ? tierClause(f.tier, 'contacts.id') : null,
		f.openedDays ? openedWithinClause(f.openedDays, 'contacts.id') : null,
		f.neverOpened ? neverOpenedClause('contacts.id') : null,
		f.openedN && f.openedOf ? openedOfLastClause(f.openedN, f.openedOf, 'contacts.id') : null
	];
	for (const e of engagement) {
		if (!e) continue;
		clauses.push(e.clause);
		params.push(...(e.binds as (string | number)[]));
	}
	if (f.pipeline) {
		const pc = pipelineClause(f.pipeline, 'contacts.id');
		clauses.push(pc.clause);
		params.push(...(pc.binds as (string | number)[]));
	}
	// #279: deliverability (bounce-filter.ts).
	const deliverability = [
		f.bounced ? bouncedClause(f.bounced, 'contacts.id') : null,
		f.spam ? spamClause('contacts.id') : null,
		f.campaign ? campaignWhoClause(f.campaign, f.campaignWho || 'sent', 'contacts.id') : null
	];
	for (const d of deliverability) {
		if (!d) continue;
		clauses.push(d.clause);
		params.push(...(d.binds as (string | number)[]));
	}

	if (f.hygiene) clauses.push(hygieneClause(f.hygiene));

	// #423: the contacts-overview tile filters.
	if (f.unsubFrom) {
		clauses.push('EXISTS (SELECT 1 FROM unsubscribes u WHERE u.email = contacts.email AND date(u.created_at) >= ?)');
		params.push(f.unsubFrom);
	}
	if (f.cooledDays) {
		const g = goingColdClause('contacts.id', new Date(Date.now() - f.cooledDays * 86_400_000));
		clauses.push(`subscribed = 1 AND ${g.clause}`);
		params.push(...(g.binds as (string | number)[]));
	}
	if (f.awaiting) {
		// Threading happens in JS (conversations.ts), so the ids come pre-resolved; a filter
		// nobody resolved matches nobody rather than silently everybody.
		if (f.awaitingIds) {
			clauses.push('id IN (SELECT value FROM json_each(?))');
			params.push(JSON.stringify(f.awaitingIds));
		} else {
			clauses.push('0');
		}
	}
	if (f.noList) {
		clauses.push(
			`NOT EXISTS (SELECT 1 FROM list_members x JOIN lists l ON l.id = x.list_id WHERE x.contact_id = contacts.id AND l.kind = 'list')`
		);
	}

	// #448: the same clauses as the `topic` (out) and `created` (within) segment rules.
	if (f.topicOut) {
		clauses.push('EXISTS (SELECT 1 FROM topic_optouts tpo WHERE tpo.contact_id = contacts.id AND tpo.list_id = ?)');
		params.push(f.topicOut);
	}
	if (f.createdDays) {
		clauses.push("created_at >= datetime('now', ?)");
		params.push(`-${f.createdDays} days`);
	}
	// #516: the same clause as the `form_submitted` segment rule.
	if (f.form) {
		const fc = formSubmittedClause('contacts.id', f.form === 'any' ? null : f.form, f.formDays ?? null);
		clauses.push(fc.clause);
		params.push(...fc.binds);
	}

	// #467: named scores — the same clauses as the score_value / score_band segment rules.
	const scores = [
		f.score ? scoreValueClause(f.score.scoreId, f.score.op, f.score.n, 'contacts.id', f.score.n2) : null,
		f.band ? scoreBandClause(f.band.scoreId, f.band.label, 'contacts.id') : null
	];
	for (const c of scores) {
		if (!c) continue;
		clauses.push(c.clause);
		params.push(...(c.binds as (string | number)[]));
	}

	const arch = archivedClause(f.archived);
	if (arch) clauses.push(arch);

	if (clauses.length === 0) return { where: '', params: [] };
	return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

/**
 * #423: fill in what `contactsWhere` can't compute in SQL — the `awaiting` contact ids
 * (conversation threading runs in JS). Call before `contactsWhere` wherever a filter may carry
 * `awaiting=1`; a no-op otherwise.
 */
export async function resolveContactsFilter(db: D1Database, f: ContactsFilter): Promise<ContactsFilter> {
	if (!f.awaiting || f.awaitingIds) return f;
	return { ...f, awaitingIds: await awaitingContactIds(db, { olderThanDays: f.awaitingDays ?? 0 }) };
}

// #535: the assistant never enrolls anyone, but a rule-based segment that is the `list_added`
// trigger of an active or paused automation is polled by the heartbeat (#413,
// processSegmentTriggers): whoever starts matching it is enrolled (or, paused, recorded as a
// pending trigger). So a write that can push contacts into such a segment — new segment rules,
// a tag / list membership its rules read, a field or company its rules read, a tier, a pipeline
// stage, a resubscribe, a restored or a brand-new contact, score points on a score its
// `score_value` / `score_band` rules read (#552) — waits for the user's Approve, with the
// reason on the card. A tag / list / company / pipeline write counts for a score too when a
// scoring event rule can award points for the rows it adds (`pointsScores`, #552).
//
// Read-only, engine-free (no automations / enroll import — tests/ai-no-send.test.ts).

import { eventTypeDef, parseFilter } from '$lib/scoring';
import { compileRule, compileSegment, parseRules, type SegmentRule, type SegmentRules } from '../../segment-query';

export type TriggerSegment = {
	automation_id: number;
	automation_name: string;
	status: string;
	list_id: number;
	segment_name: string;
	rules: SegmentRules;
};

/** Every dynamic segment that triggers an active or paused `list_added` automation. */
export async function triggerSegments(db: D1Database): Promise<TriggerSegment[]> {
	const rows = await db
		.prepare(
			`SELECT a.id AS automation_id, a.name AS automation_name, a.status, l.id AS list_id, l.name AS segment_name, l.rules
			 FROM automations a JOIN lists l ON l.id = a.trigger_list_id
			 WHERE a.status IN ('active', 'paused') AND a.trigger_type = 'list_added' AND l.kind = 'segment' AND l.rules IS NOT NULL
			 ORDER BY a.id`
		)
		.all<Omit<TriggerSegment, 'rules'> & { rules: string }>();
	const out: TriggerSegment[] = [];
	for (const r of rows.results) {
		const rules = parseRules(r.rules);
		if (rules) out.push({ ...r, rules });
	}
	return out;
}

/** What a write changes, in the terms segment rules read. */
export type TouchedAttrs = {
	tags?: string[]; // tag names (case-insensitive)
	listIds?: number[]; // list_members of these groups (`list` / `topic in` rules)
	fields?: string[]; // custom-field keys (`field`, `field_contains`)
	company?: boolean; // a contact's company: text + linked company (its metrics) + company group
	companyName?: boolean; // a company rename: the linked contacts' text + company group (link and metrics stay)
	email?: boolean; // the address (`spam_complaint` also matches unsubscribes by email)
	tier?: boolean; // the effective engagement tier (`engagement_tier`)
	pipeline?: boolean; // the pipeline card / stage (`pipeline_stage`)
	subscribed?: boolean; // `subscribed`
	scoreIds?: number[]; // named scores whose value / band changes (`score_value`, `score_band`; #552)
	removed?: boolean; // the tags / lists are taken away, not added (no new rows, so no event-rule points)
};

function ruleReads(r: SegmentRule, t: TouchedAttrs): boolean {
	if (r.invalid) return false;
	const v = String(r.value ?? '').trim();
	switch (r.field) {
		case 'tag':
			return !!t.tags?.some((n) => n.toLowerCase() === v.toLowerCase());
		case 'list':
			// A company change also moves the contact between company groups.
			return !!t.listIds?.includes(Number(v)) || !!t.company || !!t.companyName;
		case 'topic':
			return r.op === 'in' && !!t.listIds?.includes(Number(v));
		case 'field':
		case 'field_contains': {
			const key = String(r.value2 ?? '').trim().toLowerCase();
			return !!t.fields?.some((f) => f.toLowerCase() === key);
		}
		case 'company':
			return !!t.company || !!t.companyName;
		case 'company_id':
		case 'company_metric':
			return !!t.company;
		case 'spam_complaint':
			return !!t.email;
		case 'engagement_tier':
			return !!t.tier;
		case 'pipeline_stage':
			return !!t.pipeline;
		case 'subscribed':
			return !!t.subscribed;
		case 'score_value':
		case 'score_band':
			return !!t.scoreIds?.includes(Number(String(r.value2 ?? '').trim()));
		default:
			return false;
	}
}

/** Count of `ids` not in the segment right now (they are the ones who could enter it). */
async function notInSegment(db: D1Database, rules: SegmentRules, ids: number[]): Promise<number> {
	if (!ids.length) return 0;
	const c = compileSegment(rules);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE id IN (SELECT value FROM json_each(?)) AND id NOT IN (${c.sql})`)
		.bind(JSON.stringify(ids), ...c.binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function automationText(t: TriggerSegment): string {
	return t.status === 'paused'
		? `the trigger of paused automation “${t.automation_name}” (contacts who enter are held as pending triggers)`
		: `the trigger of active automation “${t.automation_name}” (contacts who enter are enrolled on the next heartbeat)`;
}

type FedScore = { id: number; name: string };

/**
 * #552: named scores an active scoring event rule can award points to for the rows this write
 * adds: `list_members` (a tag, list or company group) or `pipeline_history` (a stage). Those
 * points are quiet for `score_changed`, but the value still moves, so a `score_value` /
 * `score_band` trigger rule can start matching. A rule on one tag / list counts only for that
 * one; a company or pipeline change could be any company group or stage, so every rule on that
 * source counts.
 */
async function pointsScores(db: D1Database, t: TouchedAttrs): Promise<FedScore[]> {
	if (t.removed) return [];
	const anyGroup = !!t.company || !!t.companyName;
	const lists = anyGroup || !!t.tags?.length || !!t.listIds?.length;
	if (!lists && !t.pipeline) return [];
	const rules = await db
		.prepare(
			`SELECT r.score_id AS id, d.name, r.event_type, r.filter FROM score_rules r JOIN score_defs d ON d.id = r.score_id
			 WHERE d.status = 'active' AND r.active = 1 AND r.kind = 'event'`
		)
		.all<FedScore & { event_type: string; filter: string | null }>();
	if (!rules.results.length) return [];
	const groupIds = new Set(t.listIds ?? []);
	if (t.tags?.length) {
		const tags = await db
			.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND lower(name) IN (SELECT lower(value) FROM json_each(?))`)
			.bind(JSON.stringify(t.tags))
			.all<{ id: number }>();
		for (const r of tags.results) groupIds.add(r.id);
	}
	const out = new Map<number, string>();
	for (const r of rules.results) {
		const source = eventTypeDef(r.event_type)?.source;
		const listId = parseFilter(r.filter).list_id;
		const fed =
			source === 'pipeline_history'
				? !!t.pipeline
				: source === 'list_members' && lists && (anyGroup || listId == null || groupIds.has(Number(listId)));
		if (fed) out.set(r.id, r.name);
	}
	return [...out].map(([id, name]) => ({ id, name }));
}

function scoresText(s: FedScore[]): string {
	return `${s.length === 1 ? 'the score' : 'the scores'} ${s.map((x) => `“${x.name}”`).join(', ')}`;
}

/**
 * Trigger segments a contact write could push some of `ids` into. Returns one card note per
 * segment (empty = no guard needed). A segment is only counted when its rules read what the
 * write changes (or a score the write can add points to, #552) and at least one of the
 * contacts is not in it yet.
 */
export async function contactWriteTriggerNotes(db: D1Database, ids: number[], touched: TouchedAttrs): Promise<string[]> {
	const notes: string[] = [];
	const segments = await triggerSegments(db);
	const fed = segments.length ? await pointsScores(db, touched) : [];
	for (const t of segments) {
		const direct = t.rules.rules.some((r) => ruleReads(r, touched));
		const via = direct ? [] : fed.filter((s) => t.rules.rules.some((r) => ruleReads(r, { scoreIds: [s.id] })));
		if (!direct && !via.length) continue;
		const outside = await notInSegment(db, t.rules, ids);
		if (!outside) continue;
		const why = direct ? 'Its rules read what this changes' : `Its rules read ${scoresText(via)}, which this change can add points to through a scoring rule`;
		notes.push(
			`Segment “${t.segment_name}” is ${automationText(t)}. ${why}, and ${outside.toLocaleString('en-US')} of these contacts ${outside === 1 ? 'is' : 'are'} not in it yet, so they may enter it.`
		);
	}
	return notes;
}

/** What a brand-new contact is given in the same call (create_contact). */
export type NewContactAttrs = {
	tags: string[]; // incl. any the write may add on its own (hygiene:invalid)
	listIds: number[];
	company: boolean; // a company puts the contact in a company group too
};

/**
 * True only when the new contact certainly can't match `r`: a positive tag / list / topic-in
 * rule for something this call doesn't give it. Everything else (subscribed, source, created,
 * negative rules, never_opened, …) may match a new contact, so it counts as "may match".
 */
function newContactMisses(r: SegmentRule, a: NewContactAttrs): boolean {
	const v = String(r.value ?? '').trim();
	if (r.field === 'tag') return r.op !== 'not' && !!v && !a.tags.some((n) => n.toLowerCase() === v.toLowerCase());
	if (r.field === 'list' || r.field === 'topic') return r.op === 'in' && !a.company && !a.listIds.includes(Number(v));
	return false;
}

/**
 * Card notes for create_contact: one per trigger segment the new contact may enter. It can't be
 * checked against the rules before it exists, so a segment is left out only when a rule it
 * needs (ALL: any one; ANY: every one) is a positive tag / list / topic rule this call doesn't
 * satisfy. Empty = no trigger segment it could enter.
 */
export async function newContactTriggerNotes(db: D1Database, given: NewContactAttrs): Promise<string[]> {
	const notes: string[] = [];
	for (const t of await triggerSegments(db)) {
		const live = t.rules.rules.filter((r) => !r.invalid && compileRule(r));
		const misses = live.filter((r) => newContactMisses(r, given)).length;
		const ruledOut = live.length > 0 && (t.rules.match === 'any' ? misses === live.length : misses > 0);
		if (ruledOut) continue;
		notes.push(
			`Segment “${t.segment_name}” is ${automationText(t)}. A new contact can't be checked against its rules until it exists, and it may match them, so it may enter it.`
		);
	}
	return notes;
}

/**
 * Card notes for restore_contacts. Archived contacts are never in a dynamic segment
 * (compileSegment), so a restored contact whose rules already match enters it on the next
 * poll. Counts, per trigger segment, the archived contacts of `ids` that match its rules.
 */
export async function restoreTriggerNotes(db: D1Database, ids: number[]): Promise<string[]> {
	if (!ids.length) return [];
	const notes: string[] = [];
	for (const t of await triggerSegments(db)) {
		const c = compileSegment(t.rules, { includeArchived: true });
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE archived_at IS NOT NULL AND id IN (SELECT value FROM json_each(?)) AND id IN (${c.sql})`)
			.bind(JSON.stringify(ids), ...c.binds)
			.first<{ n: number }>();
		const n = row?.n ?? 0;
		if (!n) continue;
		notes.push(
			`Segment “${t.segment_name}” is ${automationText(t)}. ${n.toLocaleString('en-US')} of these archived contacts ${n === 1 ? 'matches' : 'match'} its rules, so ${n === 1 ? 'it enters' : 'they enter'} it once restored.`
		);
	}
	return notes;
}

export type SegmentChange = { before: number; after: number; entering: number; entering_subscribed: number; leaving: number };

/** The real membership change of replacing a segment's rules: who enters, who leaves. */
export async function segmentRuleChange(db: D1Database, oldRules: SegmentRules | null, newRules: SegmentRules): Promise<SegmentChange> {
	const o = compileSegment(oldRules ?? { match: 'all', rules: [] });
	const n = compileSegment(newRules);
	const oldSql = oldRules ? o.sql : 'SELECT 0 WHERE 0';
	const oldBinds = oldRules ? o.binds : [];
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM (${oldSql})) AS n_before,
				(SELECT COUNT(*) FROM (${n.sql})) AS n_after,
				(SELECT COUNT(*) FROM contacts WHERE id IN (${n.sql}) AND id NOT IN (${oldSql})) AS entering,
				(SELECT COUNT(*) FROM contacts WHERE subscribed = 1 AND id IN (${n.sql}) AND id NOT IN (${oldSql})) AS entering_subscribed,
				(SELECT COUNT(*) FROM contacts WHERE id IN (${oldSql}) AND id NOT IN (${n.sql})) AS leaving`
		)
		.bind(...oldBinds, ...n.binds, ...n.binds, ...oldBinds, ...n.binds, ...oldBinds, ...oldBinds, ...n.binds)
		.first<{ n_before: number; n_after: number; entering: number; entering_subscribed: number; leaving: number }>();
	return {
		before: row?.n_before ?? 0,
		after: row?.n_after ?? 0,
		entering: row?.entering ?? 0,
		entering_subscribed: row?.entering_subscribed ?? 0,
		leaving: row?.leaving ?? 0
	};
}

/** Card notes when this segment triggers automations, given how many contacts would enter. */
export async function segmentTriggerNotes(db: D1Database, listId: number, change: SegmentChange): Promise<string[]> {
	const hits = (await triggerSegments(db)).filter((t) => t.list_id === listId);
	return hits.map(
		(t) =>
			`This segment is ${automationText(t)}. ${change.entering.toLocaleString('en-US')} contact${change.entering === 1 ? '' : 's'} would enter it (${change.entering_subscribed.toLocaleString('en-US')} subscribed).`
	);
}

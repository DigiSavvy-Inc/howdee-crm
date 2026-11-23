// #215: bulk management of lists / segments / tags on /groups/[kind] — delete, merge,
// rename, empty. Contacts are never deleted. Every statement binds ≤ 40 ids (D1 caps a
// query at 100 vars).
//
// What references a group, and what each action does with it:
//  - `list_members`                 → delete / empty drop the rows; merge copies them.
//  - `automations.trigger_list_id`  → FK. Delete nulls it and pauses the active ones
//                                     (label "trigger deleted"); merge repoints it.
//  - `automation_steps.gate_ref_id` → list-member branch (no FK). Merge repoints; delete
//                                     turns it into a one-rule set marked invalid (#228).
//  - `campaigns.list_id`            → FK with no ON DELETE, and `list_id IS NULL` means a
//                                     1:1 send in the send log. A group a campaign was sent
//                                     to is never deleted (skipped); merge repoints it.
//  - `campaign_audiences` (#332)    → counted with campaigns (delete skips the group); merge
//                                     repoints it.
//  - Condition rule sets (`automation_steps.gate_rules`, #221) and dynamic segment rules
//    (#224) → merge repoints `list` rules; delete marks them `invalid` (#228: a segment
//    ignores them, a condition counts them false, the builders show "Deleted list").
//    Tag names are rewritten (below).
//  - tag NAMES (segment `tag` rules, tag / gate / tag-on-open|click steps, campaign
//    tag-on-open|click, webhook key default tags) and list NAMES (webhook key default
//    list, the Luma list setting) → merge and rename rewrite them to the new name.

import { addLabel } from './automation-labels';
import { DELETED_LIST, parseGateRules, type ConditionRule } from '$lib/condition-rules';
import { compileSegment, parseRules, type SegmentRules } from './segment-query';
import { segmentAudienceSql } from './active-audience';
import { snapshot } from './snapshot';

/** The SEO Snapshot release tag (#608: via the feature seam; null when not installed). */
const APPROVED_TAG = snapshot.protectedTag;

export const GROUP_CHUNK = 40;
export const MANAGEABLE_KINDS = ['list', 'segment', 'tag'] as const;
export type ManageableKind = (typeof MANAGEABLE_KINDS)[number];
/** Kinds that can be merged. Segments can't: two rule sets don't combine into one. */
export const MERGEABLE_KINDS: readonly string[] = ['list', 'tag'];
export const MAX_GROUP_NAME = 60;
/** Label put on an automation whose trigger group was deleted. */
export const TRIGGER_DELETED_LABEL = 'trigger deleted';

export function isManageableKind(k: string): k is ManageableKind {
	return (MANAGEABLE_KINDS as readonly string[]).includes(k);
}

function chunk<T>(arr: T[], size = GROUP_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function ph(n: number): string {
	return Array.from({ length: n }, () => '?').join(', ');
}

/** Positive integer ids, deduped, in input order. */
export function cleanGroupIds(ids: unknown[]): number[] {
	const out = new Set<number>();
	for (const v of ids) {
		const n = Number(v);
		if (Number.isInteger(n) && n > 0) out.add(n);
	}
	return [...out];
}

export type GroupInfo = {
	id: number;
	name: string;
	kind: string;
	rules: string | null;
	members: number; // list_members rows (a dynamic segment has none)
	campaigns: number; // campaigns sent/scheduled to it
	dynamic: boolean;
};

export type TriggerAutomation = { id: number; name: string; status: string; trigger_list_id: number };

/** The groups among `ids` (unknown ids don't come back), in id order. */
export async function loadGroups(db: D1Database, rawIds: unknown[]): Promise<GroupInfo[]> {
	const out: GroupInfo[] = [];
	for (const part of chunk(cleanGroupIds(rawIds))) {
		const res = await db
			.prepare(
				`SELECT l.id, l.name, l.kind, l.rules,
				        (SELECT COUNT(*) FROM list_members lm WHERE lm.list_id = l.id) AS members,
				        (SELECT COUNT(*) FROM campaigns c WHERE c.list_id = l.id
				           OR EXISTS (SELECT 1 FROM campaign_audiences ca WHERE ca.campaign_id = c.id AND ca.list_id = l.id)) AS campaigns
				 FROM lists l WHERE l.id IN (${ph(part.length)})`
			)
			.bind(...part)
			.all<Omit<GroupInfo, 'dynamic'>>();
		for (const r of res.results) {
			out.push({ ...r, dynamic: r.kind === 'segment' && parseRules(r.rules) !== null });
		}
	}
	return out.sort((a, b) => a.id - b.id);
}

/** Automations whose `list_added` trigger is one of `ids` (any status). */
export async function triggeringAutomations(db: D1Database, ids: number[]): Promise<TriggerAutomation[]> {
	const out: TriggerAutomation[] = [];
	for (const part of chunk(ids)) {
		const res = await db
			.prepare(
				`SELECT id, name, status, trigger_list_id FROM automations
				 WHERE trigger_list_id IN (${ph(part.length)}) ORDER BY name COLLATE NOCASE`
			)
			.bind(...part)
			.all<TriggerAutomation>();
		out.push(...res.results);
	}
	return out;
}

export type Skipped = { id: number; name: string; reason: string };

export type DeleteResult = {
	deleted: number;
	membersRemoved: number;
	automationsPaused: { id: number; name: string }[];
	skipped: Skipped[];
	rulesInvalidated: { segmentRules: number; conditions: number };
};

/** Why a group can't be deleted, or null. */
export function deleteProblem(g: Pick<GroupInfo, 'kind' | 'campaigns'>): string | null {
	if (!isManageableKind(g.kind)) return 'derived from contacts';
	if (g.campaigns > 0) return `sent to by ${g.campaigns} campaign${g.campaigns === 1 ? '' : 's'}`;
	return null;
}

/**
 * Delete groups. Memberships go, the group row goes (a segment's rules with it); contacts
 * are never touched. Automations triggering from a deleted group lose the trigger: the
 * active ones are paused (and returned), every one gets the "trigger deleted" label.
 * A company group, or one a campaign was sent to, is skipped with a reason. Segment and
 * Condition rules pointing at a deleted group are marked invalid (#228).
 */
export async function deleteGroups(db: D1Database, rawIds: unknown[], kind?: string): Promise<DeleteResult> {
	const groups = await loadGroups(db, rawIds);
	const skipped: Skipped[] = [];
	const ok: GroupInfo[] = [];
	for (const g of groups) {
		const problem = kind && g.kind !== kind ? `not a ${kind}` : deleteProblem(g);
		if (problem) skipped.push({ id: g.id, name: g.name, reason: problem });
		else ok.push(g);
	}
	const ids = ok.map((g) => g.id);
	const result: DeleteResult = {
		deleted: 0,
		membersRemoved: 0,
		automationsPaused: [],
		skipped,
		rulesInvalidated: { segmentRules: 0, conditions: 0 }
	};
	if (ids.length === 0) return result;

	const autos = await triggeringAutomations(db, ids);
	result.automationsPaused = autos.filter((a) => a.status === 'active').map((a) => ({ id: a.id, name: a.name }));
	const autoIds = autos.map((a) => a.id);
	for (const part of chunk(autoIds)) {
		await db
			.prepare(
				`UPDATE automations
				 SET status = CASE WHEN status = 'active' THEN 'paused' ELSE status END, trigger_list_id = NULL
				 WHERE id IN (${ph(part.length)})`
			)
			.bind(...part)
			.run();
	}
	for (const id of autoIds) {
		// Best-effort note; an automation already at its label cap just doesn't get it.
		await addLabel(db, id, TRIGGER_DELETED_LABEL);
	}

	result.rulesInvalidated = await invalidateGroupRules(db, ids);

	for (const part of chunk(ids)) {
		const bind = ph(part.length);
		const [members, lists] = await db.batch([
			db.prepare(`DELETE FROM list_members WHERE list_id IN (${bind})`).bind(...part),
			db.prepare(`DELETE FROM lists WHERE id IN (${bind})`).bind(...part)
		]);
		result.membersRemoved += members.meta.changes ?? 0;
		result.deleted += lists.meta.changes ?? 0;
	}
	return result;
}

// #472: archive / restore lists and segments. `lists.archived_at` (NULL = active) hides a group
// from pickers and the Groups pages; nothing else changes — members, rules, campaign history,
// triggers and rule references stay exactly as they were, so restoring is a plain un-hide.

/** Kinds that can be archived. Tags and companies are out of scope. */
export const ARCHIVABLE_KINDS: readonly string[] = ['list', 'segment'];

export type ArchiveCheck = {
	id: number;
	name: string;
	kind: string;
	public_topic: number;
	archived_at: string | null;
	liveCampaigns: number; // scheduled or sending campaigns whose audience includes it
	activeAutomations: number; // active automations triggering from it
};

/** Why a group can't be archived, or null. Sent campaigns and paused / draft automations are fine. */
export function archiveProblem(g: Pick<ArchiveCheck, 'kind' | 'public_topic' | 'archived_at' | 'liveCampaigns' | 'activeAutomations'>): string | null {
	if (!ARCHIVABLE_KINDS.includes(g.kind)) return 'only lists and segments can be archived';
	if (g.archived_at) return 'already archived';
	if (g.public_topic) return 'it is a public topic — turn the topic off first';
	if (g.liveCampaigns > 0) {
		return `audience of ${g.liveCampaigns} scheduled or sending campaign${g.liveCampaigns === 1 ? '' : 's'}`;
	}
	if (g.activeAutomations > 0) {
		return `triggers ${g.activeAutomations} active automation${g.activeAutomations === 1 ? '' : 's'}`;
	}
	return null;
}

/** What `archiveProblem` needs for the groups among `ids`, in id order. */
export async function loadArchiveChecks(db: D1Database, rawIds: unknown[]): Promise<ArchiveCheck[]> {
	const ids = cleanGroupIds(rawIds);
	const out: ArchiveCheck[] = [];
	for (const part of chunk(ids)) {
		const res = await db
			.prepare(
				`SELECT l.id, l.name, l.kind, COALESCE(l.public_topic, 0) AS public_topic, l.archived_at,
				        (SELECT COUNT(*) FROM campaigns c WHERE c.status IN ('scheduled', 'sending')
				           AND (c.list_id = l.id
				             OR EXISTS (SELECT 1 FROM campaign_audiences ca WHERE ca.campaign_id = c.id AND ca.list_id = l.id))) AS liveCampaigns
				 FROM lists l WHERE l.id IN (${ph(part.length)})`
			)
			.bind(...part)
			.all<Omit<ArchiveCheck, 'activeAutomations'>>();
		for (const r of res.results) out.push({ ...r, activeAutomations: 0 });
	}
	const autos = await triggeringAutomations(
		db,
		out.map((g) => g.id)
	);
	for (const g of out) g.activeAutomations = autos.filter((a) => a.trigger_list_id === g.id && a.status === 'active').length;
	return out.sort((a, b) => a.id - b.id);
}

export type ArchiveResult = { changed: { id: number; name: string }[]; skipped: Skipped[] };

/** Archive lists / segments. Refused ones (`archiveProblem`) come back in `skipped`. */
export async function archiveGroups(db: D1Database, rawIds: unknown[], kind?: string): Promise<ArchiveResult> {
	const result: ArchiveResult = { changed: [], skipped: [] };
	const ok: ArchiveCheck[] = [];
	for (const g of await loadArchiveChecks(db, rawIds)) {
		const problem = kind && g.kind !== kind ? `not a ${kind}` : archiveProblem(g);
		if (problem) result.skipped.push({ id: g.id, name: g.name, reason: problem });
		else ok.push(g);
	}
	for (const part of chunk(ok.map((g) => g.id))) {
		const res = await db
			.prepare(`UPDATE lists SET archived_at = datetime('now') WHERE archived_at IS NULL AND id IN (${ph(part.length)}) RETURNING id`)
			.bind(...part)
			.all<{ id: number }>();
		const done = new Set(res.results.map((r) => r.id));
		for (const g of ok) if (done.has(g.id)) result.changed.push({ id: g.id, name: g.name });
	}
	return result;
}

/** Restore archived lists / segments — exactly as they were. */
export async function restoreGroups(db: D1Database, rawIds: unknown[], kind?: string): Promise<ArchiveResult> {
	const result: ArchiveResult = { changed: [], skipped: [] };
	const ok: ArchiveCheck[] = [];
	for (const g of await loadArchiveChecks(db, rawIds)) {
		const problem =
			kind && g.kind !== kind
				? `not a ${kind}`
				: !ARCHIVABLE_KINDS.includes(g.kind)
					? 'only lists and segments can be archived'
					: !g.archived_at
						? 'not archived'
						: null;
		if (problem) result.skipped.push({ id: g.id, name: g.name, reason: problem });
		else ok.push(g);
	}
	for (const part of chunk(ok.map((g) => g.id))) {
		const res = await db
			.prepare(`UPDATE lists SET archived_at = NULL WHERE archived_at IS NOT NULL AND id IN (${ph(part.length)}) RETURNING id`)
			.bind(...part)
			.all<{ id: number }>();
		const done = new Set(res.results.map((r) => r.id));
		for (const g of ok) if (done.has(g.id)) result.changed.push({ id: g.id, name: g.name });
	}
	return result;
}

/** One rule (segment) or Condition step that references a group by id (#228). */
export type GroupRuleRef = {
	groupId: number;
	kind: 'segment' | 'condition';
	id: number; // segment id, or the Condition step's id
	name: string; // segment name, or the automation's name
	automationId: number | null;
};

function listRuleIds(rules: { field: string; value?: string; invalid?: string }[], ids: Set<number>): number[] {
	return rules.filter((r) => r.field === 'list' && !r.invalid && ids.has(Number((r.value ?? '').trim()))).map((r) => Number((r.value ?? '').trim()));
}

/**
 * Where groups are used by id in rules (#228): dynamic segment `list` rules (one entry per
 * rule) and Condition steps — rule-set `list` rules or a legacy list-member gate (one entry
 * per step and group). `name` is the segment's / the automation's name.
 */
export async function groupRuleRefs(db: D1Database, rawIds: number[]): Promise<GroupRuleRef[]> {
	const ids = new Set(rawIds);
	const out: GroupRuleRef[] = [];
	if (ids.size === 0) return out;
	const segs = await db
		.prepare("SELECT id, name, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL ORDER BY name COLLATE NOCASE")
		.all<{ id: number; name: string; rules: string }>();
	for (const s of segs.results) {
		for (const groupId of listRuleIds(parseRules(s.rules)?.rules ?? [], ids)) out.push({ groupId, kind: 'segment', id: s.id, name: s.name, automationId: null });
	}
	const steps = await db
		.prepare(
			`SELECT s.id, s.automation_id, s.gate_rules, s.gate_kind, s.gate_ref_id, a.name FROM automation_steps s
			 JOIN automations a ON a.id = s.automation_id
			 WHERE s.gate_rules IS NOT NULL OR s.gate_kind = 'list-member'
			 ORDER BY a.name COLLATE NOCASE, s.id`
		)
		.all<{ id: number; automation_id: number; gate_rules: string | null; gate_kind: string | null; gate_ref_id: number | null; name: string }>();
	for (const st of steps.results) {
		const set = parseGateRules(st.gate_rules);
		const hit = set
			? new Set(listRuleIds(set.rules, ids))
			: new Set(st.gate_kind === 'list-member' && st.gate_ref_id && ids.has(st.gate_ref_id) ? [st.gate_ref_id] : []);
		for (const groupId of hit) out.push({ groupId, kind: 'condition', id: st.id, name: st.name, automationId: st.automation_id });
	}
	return out;
}

/**
 * Mark every rule that points at the groups `ids` as invalid (#228): dynamic segment `list`
 * rules and Condition rule-set `list` rules get `invalid: DELETED_LIST`; a legacy
 * list-member gate becomes a one-rule set carrying that mark (so it reads NO instead of
 * failing open). Idempotent. Returns how many segment rules / condition steps changed.
 */
export async function invalidateGroupRules(db: D1Database, rawIds: number[]): Promise<{ segmentRules: number; conditions: number }> {
	const ids = new Set(rawIds);
	const out = { segmentRules: 0, conditions: 0 };
	if (ids.size === 0) return out;
	const hits = (r: { field: string; value?: string; invalid?: string }) =>
		r.field === 'list' && !r.invalid && ids.has(Number((r.value ?? '').trim()));

	const segs = await db
		.prepare("SELECT id, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL")
		.all<{ id: number; rules: string }>();
	for (const s of segs.results) {
		const rules = parseRules(s.rules);
		if (!rules) continue;
		const n = rules.rules.filter(hits).length;
		if (!n) continue;
		const next: SegmentRules = { match: rules.match, rules: rules.rules.map((r) => (hits(r) ? { ...r, invalid: DELETED_LIST } : r)) };
		await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(JSON.stringify(next), s.id).run();
		out.segmentRules += n;
	}

	out.conditions += await rewriteGateRules(db, (r) => (hits(r) ? { ...r, invalid: DELETED_LIST } : null));

	for (const part of chunk([...ids])) {
		const legacy = await db
			.prepare(`SELECT id, gate_ref_id FROM automation_steps WHERE gate_kind = 'list-member' AND gate_rules IS NULL AND gate_ref_id IN (${ph(part.length)})`)
			.bind(...part)
			.all<{ id: number; gate_ref_id: number }>();
		for (const st of legacy.results) {
			const set = { match: 'all', rules: [{ field: 'list', op: 'in', value: String(st.gate_ref_id), invalid: DELETED_LIST }] };
			await db
				.prepare(
					`UPDATE automation_steps
					 SET gate_rules = ?, gate_kind = NULL, gate_name = NULL, gate_value = NULL, gate_ref_id = NULL, split_pct = NULL
					 WHERE id = ?`
				)
				.bind(JSON.stringify(set), st.id)
				.run();
			out.conditions++;
		}
	}
	return out;
}

/**
 * Rules whose group vanished some other way (or before #228) are healed when a segment
 * page loads: any `list` rule in `rules` pointing at a missing group gets the same marking
 * as a delete. Returns true when something was marked (the caller re-reads the rules).
 */
export async function healDanglingListRules(db: D1Database, rules: SegmentRules | null): Promise<boolean> {
	const ids = [
		...new Set(
			(rules?.rules ?? [])
				.filter((r) => r.field === 'list' && !r.invalid)
				.map((r) => Number((r.value ?? '').trim()))
				.filter((n) => Number.isInteger(n) && n > 0)
		)
	];
	if (ids.length === 0) return false;
	const found = new Set<number>();
	for (const part of chunk(ids)) {
		const res = await db.prepare(`SELECT id FROM lists WHERE id IN (${ph(part.length)})`).bind(...part).all<{ id: number }>();
		for (const r of res.results) found.add(r.id);
	}
	const missing = ids.filter((id) => !found.has(id));
	if (missing.length === 0) return false;
	await invalidateGroupRules(db, missing);
	return true;
}

export type EmptyResult = { emptied: number; membersRemoved: number; skipped: Skipped[] };

/** Remove every member of the groups, keeping the groups. Dynamic segments (no member
 *  rows — membership is their rules) and company groups are skipped. */
export async function emptyGroup(db: D1Database, rawIds: unknown[], kind?: string): Promise<EmptyResult> {
	const groups = await loadGroups(db, rawIds);
	const result: EmptyResult = { emptied: 0, membersRemoved: 0, skipped: [] };
	const ids: number[] = [];
	for (const g of groups) {
		if (kind && g.kind !== kind) result.skipped.push({ id: g.id, name: g.name, reason: `not a ${kind}` });
		else if (!isManageableKind(g.kind)) result.skipped.push({ id: g.id, name: g.name, reason: 'derived from contacts' });
		else if (g.dynamic) result.skipped.push({ id: g.id, name: g.name, reason: 'dynamic segment (rules decide its members)' });
		else ids.push(g.id);
	}
	for (const part of chunk(ids)) {
		const res = await db.prepare(`DELETE FROM list_members WHERE list_id IN (${ph(part.length)})`).bind(...part).run();
		result.membersRemoved += res.meta.changes ?? 0;
	}
	result.emptied = ids.length;
	return result;
}

/** A usable group name, or an error message. */
export function groupNameProblem(name: string): string | null {
	if (!name) return 'Enter a name.';
	if (name.length > MAX_GROUP_NAME) return `Name is too long (${MAX_GROUP_NAME} chars max).`;
	return null;
}

/** The release tag is matched by name; nothing may become it by rename or merge (#110). */
function isApprovedTag(name: string): boolean {
	return APPROVED_TAG !== null && name.trim().toLowerCase() === APPROVED_TAG;
}

async function findByName(db: D1Database, kind: string, name: string, exceptId = 0) {
	return db
		.prepare('SELECT id, name FROM lists WHERE kind = ? AND name = ? COLLATE NOCASE AND id != ? LIMIT 1')
		.bind(kind, name, exceptId)
		.first<{ id: number; name: string }>();
}

/** Rewrite rules inside Condition rule sets (#221); `fn` returns the new rule or null for
 *  "unchanged". Returns how many steps changed. */
async function rewriteGateRules(db: D1Database, fn: (r: ConditionRule) => ConditionRule | null): Promise<number> {
	const rows = await db
		.prepare('SELECT id, gate_rules FROM automation_steps WHERE gate_rules IS NOT NULL')
		.all<{ id: number; gate_rules: string }>();
	let changed = 0;
	for (const row of rows.results) {
		const set = parseGateRules(row.gate_rules);
		if (!set) continue;
		let hit = false;
		const rules = set.rules.map((r) => {
			const next = fn(r);
			if (next) hit = true;
			return next ?? r;
		});
		if (!hit) continue;
		await db.prepare('UPDATE automation_steps SET gate_rules = ? WHERE id = ?').bind(JSON.stringify({ ...set, rules }), row.id).run();
		changed++;
	}
	return changed;
}

export type RefCounts = { segments: number; steps: number; campaigns: number; webhookKeys: number; settings: number };

function emptyRefs(): RefCounts {
	return { segments: 0, steps: 0, campaigns: 0, webhookKeys: 0, settings: 0 };
}

/** Rewrite every by-name reference to the tags `fromNames` (case-insensitive) to `toName`. */
export async function rewriteTagRefs(db: D1Database, fromNames: string[], toName: string): Promise<RefCounts> {
	const refs = emptyRefs();
	const from = new Set(fromNames.map((n) => n.trim().toLowerCase()));
	if (from.size === 0) return refs;

	// Dynamic segment `tag` rules.
	const segs = await db
		.prepare("SELECT id, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL")
		.all<{ id: number; rules: string }>();
	for (const s of segs.results) {
		const rules = parseRules(s.rules);
		if (!rules) continue;
		let changed = false;
		const next: SegmentRules = {
			match: rules.match,
			rules: rules.rules.map((r) => {
				if (r.field === 'tag' && from.has((r.value ?? '').trim().toLowerCase())) {
					changed = true;
					return { ...r, value: toName };
				}
				return r;
			})
		};
		if (changed) {
			await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(JSON.stringify(next), s.id).run();
			refs.segments++;
		}
	}

	// Tag steps, tag/no-tag conditions, engagement auto-tags; campaign auto-tags.
	for (const part of chunk([...from])) {
		const inList = `(${ph(part.length)})`;
		const res = await db.batch([
			db.prepare(`UPDATE automation_steps SET tag_name = ? WHERE LOWER(TRIM(tag_name)) IN ${inList}`).bind(toName, ...part),
			db
				.prepare(
					`UPDATE automation_steps SET gate_name = ?
					 WHERE gate_kind IN ('tag', 'no-tag') AND LOWER(TRIM(gate_name)) IN ${inList}`
				)
				.bind(toName, ...part),
			db.prepare(`UPDATE automation_steps SET tag_on_open = ? WHERE LOWER(TRIM(tag_on_open)) IN ${inList}`).bind(toName, ...part),
			db.prepare(`UPDATE automation_steps SET tag_on_click = ? WHERE LOWER(TRIM(tag_on_click)) IN ${inList}`).bind(toName, ...part),
			db.prepare(`UPDATE campaigns SET tag_on_open = ? WHERE LOWER(TRIM(tag_on_open)) IN ${inList}`).bind(toName, ...part),
			db.prepare(`UPDATE campaigns SET tag_on_click = ? WHERE LOWER(TRIM(tag_on_click)) IN ${inList}`).bind(toName, ...part)
		]);
		refs.steps += res.slice(0, 4).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
		refs.campaigns += res.slice(4).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
	}

	// Condition rule sets' tag rules (#221).
	refs.steps += await rewriteGateRules(db, (r) =>
		r.field === 'tag' && from.has((r.value ?? '').trim().toLowerCase()) ? { ...r, value: toName } : null
	);

	// Webhook keys' comma-separated default tags (same normalisation as /settings/webhooks).
	const keys = await db
		.prepare('SELECT id, default_tags FROM webhook_keys WHERE default_tags IS NOT NULL')
		.all<{ id: number; default_tags: string }>();
	for (const k of keys.results) {
		const tags = k.default_tags.split(',').map((t) => t.trim()).filter(Boolean);
		if (!tags.some((t) => from.has(t.toLowerCase()))) continue;
		const seen = new Set<string>();
		const next: string[] = [];
		for (const t of tags.map((t) => (from.has(t.toLowerCase()) ? toName : t))) {
			if (seen.has(t.toLowerCase())) continue;
			seen.add(t.toLowerCase());
			next.push(t);
		}
		await db.prepare('UPDATE webhook_keys SET default_tags = ? WHERE id = ?').bind(next.join(', ') || null, k.id).run();
		refs.webhookKeys++;
	}
	return refs;
}

/** Rewrite by-name references to the lists `fromNames`: webhook key default list and the
 *  Luma list setting. (Ingest's built-in fallback list name is code, not data.) */
export async function rewriteListRefs(db: D1Database, fromNames: string[], toName: string): Promise<RefCounts> {
	const refs = emptyRefs();
	const from = [...new Set(fromNames.map((n) => n.trim().toLowerCase()))];
	for (const part of chunk(from)) {
		const inList = `(${ph(part.length)})`;
		const [keys, setting] = await db.batch([
			db.prepare(`UPDATE webhook_keys SET default_list = ? WHERE LOWER(TRIM(default_list)) IN ${inList}`).bind(toName, ...part),
			db.prepare(`UPDATE app_state SET value = ? WHERE key = 'luma_list' AND LOWER(TRIM(value)) IN ${inList}`).bind(toName, ...part)
		]);
		refs.webhookKeys += keys.meta.changes ?? 0;
		refs.settings += setting.meta.changes ?? 0;
	}
	return refs;
}

export type RenameResult = { ok: true; name: string; refs: RefCounts } | { ok: false; error: string };

/** Rename a list / segment / tag. Unique per kind (case-insensitive); nothing may be renamed
 *  to `snapshot:approved` unless it already is (#110). Name references follow the rename. */
export async function renameGroup(db: D1Database, id: number, rawName: string, kind?: string): Promise<RenameResult> {
	const name = rawName.trim();
	const problem = groupNameProblem(name);
	if (problem) return { ok: false, error: problem };
	const g = await db.prepare('SELECT id, name, kind FROM lists WHERE id = ?').bind(id).first<{ id: number; name: string; kind: string }>();
	if (!g || (kind && g.kind !== kind)) return { ok: false, error: 'That group no longer exists.' };
	if (!isManageableKind(g.kind)) return { ok: false, error: 'Companies are renamed from the company page.' };
	if (isApprovedTag(name) && !isApprovedTag(g.name)) {
		return { ok: false, error: `Nothing can be renamed to “${APPROVED_TAG}” — it releases SEO snapshots.` };
	}
	const clash = await findByName(db, g.kind, name, g.id);
	if (clash) return { ok: false, error: `A ${g.kind} named “${clash.name}” already exists.` };
	if (name === g.name) return { ok: true, name, refs: emptyRefs() };

	await db.prepare('UPDATE lists SET name = ? WHERE id = ?').bind(name, g.id).run();
	const refs =
		g.kind === 'tag'
			? await rewriteTagRefs(db, [g.name], name)
			: g.kind === 'list'
				? await rewriteListRefs(db, [g.name], name)
				: emptyRefs();
	return { ok: true, name, refs };
}

export type MergeTarget = { intoId: number } | { newName: string };

export type MergeResult =
	| {
			ok: true;
			into: { id: number; name: string; created: boolean };
			merged: { id: number; name: string }[];
			membersAdded: number; // contacts newly added to the survivor
			duplicates: number; // memberships that were already on the survivor (or repeated)
			automations: number; // triggers repointed
			branches: number; // list-member conditions repointed
			campaigns: number; // campaign rows repointed
			refs: RefCounts;
	  }
	| { ok: false; error: string };

/**
 * Merge groups of one kind (tags or lists) into a survivor: an existing group (`intoId`) or
 * a name (an existing group of that name, else a new one). Members of the others are added
 * to the survivor (INSERT OR IGNORE, keeping their original added_at), everything that
 * points at them — triggers, list-member branches, campaign rows, by-name references — is
 * repointed, then they're deleted. Idempotent: merging again finds nothing left to move.
 *
 * Members moved by a merge do NOT fire `list_added` automations: they already were in an
 * equivalent group, and the automations triggering from it are repointed rather than lost.
 */
export async function mergeGroups(db: D1Database, target: MergeTarget, rawFromIds: unknown[], kind: string): Promise<MergeResult> {
	if (!MERGEABLE_KINDS.includes(kind)) return { ok: false, error: 'Only tags and lists can be merged.' };

	let into: { id: number; name: string; created: boolean } | null = null;
	if ('intoId' in target) {
		const row = await db
			.prepare('SELECT id, name FROM lists WHERE id = ? AND kind = ?')
			.bind(target.intoId, kind)
			.first<{ id: number; name: string }>();
		if (!row) return { ok: false, error: `Pick the ${kind} to keep.` };
		into = { ...row, created: false };
	} else {
		const name = target.newName.trim();
		const problem = groupNameProblem(name);
		if (problem) return { ok: false, error: problem };
		const row = await findByName(db, kind, name);
		if (row) into = { ...row, created: false };
		else into = { id: 0, name, created: true };
	}
	if (isApprovedTag(into.name)) {
		return { ok: false, error: `Tags can't be merged into “${APPROVED_TAG}” — it releases SEO snapshots.` };
	}

	const sources = (await loadGroups(db, rawFromIds)).filter((g) => g.id !== into.id);
	if (sources.some((g) => g.kind !== kind)) return { ok: false, error: `Only ${kind}s can be merged here.` };
	if (sources.some((g) => isApprovedTag(g.name))) {
		return { ok: false, error: `“${APPROVED_TAG}” can't be merged away — it releases SEO snapshots.` };
	}
	if (sources.length === 0) return { ok: false, error: `Select at least one other ${kind} to merge.` };

	if (into.created) {
		const row = await db
			.prepare('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id')
			.bind(into.name, kind)
			.first<{ id: number }>();
		into.id = row!.id;
	}

	const ids = sources.map((g) => g.id);
	const totalMembers = sources.reduce((n, g) => n + g.members, 0);
	let membersAdded = 0;
	let automations = 0;
	let branches = 0;
	let campaigns = 0;
	for (const part of chunk(ids)) {
		const bind = ph(part.length);
		const res = await db.batch([
			db
				.prepare(
					`INSERT OR IGNORE INTO list_members (list_id, contact_id, added_at)
					 SELECT ?, contact_id, MIN(added_at) FROM list_members WHERE list_id IN (${bind}) GROUP BY contact_id`
				)
				.bind(into.id, ...part),
			db.prepare(`UPDATE automations SET trigger_list_id = ? WHERE trigger_list_id IN (${bind})`).bind(into.id, ...part),
			db
				.prepare(`UPDATE automation_steps SET gate_ref_id = ? WHERE gate_kind = 'list-member' AND gate_ref_id IN (${bind})`)
				.bind(into.id, ...part),
			db.prepare(`UPDATE campaigns SET list_id = ? WHERE list_id IN (${bind})`).bind(into.id, ...part),
			db.prepare(`DELETE FROM list_members WHERE list_id IN (${bind})`).bind(...part),
			// #332: multi-group audiences follow (a duplicate of the target is dropped).
			db.prepare(`UPDATE OR IGNORE campaign_audiences SET list_id = ? WHERE list_id IN (${bind})`).bind(into.id, ...part),
			db.prepare(`DELETE FROM campaign_audiences WHERE list_id IN (${bind})`).bind(...part),
			db.prepare(`DELETE FROM lists WHERE id IN (${bind})`).bind(...part)
		]);
		membersAdded += res[0].meta.changes ?? 0;
		automations += res[1].meta.changes ?? 0;
		branches += res[2].meta.changes ?? 0;
		campaigns += res[3].meta.changes ?? 0;
	}

	// Condition rule sets' list rules (#221) follow the merge like gate_ref_id above.
	const merged = new Set(ids.map(String));
	const intoId = String(into.id);
	branches += await rewriteGateRules(db, (r) =>
		r.field === 'list' && merged.has((r.value ?? '').trim()) ? { ...r, value: intoId } : null
	);

	const names = sources.map((g) => g.name);
	const refs = kind === 'tag' ? await rewriteTagRefs(db, names, into.name) : await rewriteListRefs(db, names, into.name);

	// Dynamic segment `list` rules (#224) follow the merge too.
	const segs = await db
		.prepare("SELECT id, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL")
		.all<{ id: number; rules: string }>();
	for (const s of segs.results) {
		const rules = parseRules(s.rules);
		if (!rules?.rules.some((r) => r.field === 'list' && merged.has((r.value ?? '').trim()))) continue;
		const next: SegmentRules = {
			match: rules.match,
			rules: rules.rules.map((r) => (r.field === 'list' && merged.has((r.value ?? '').trim()) ? { ...r, value: intoId } : r))
		};
		await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(JSON.stringify(next), s.id).run();
		refs.segments++;
	}

	return {
		ok: true,
		into,
		merged: sources.map((g) => ({ id: g.id, name: g.name })),
		membersAdded,
		duplicates: totalMembers - membersAdded,
		automations,
		branches,
		campaigns,
		refs
	};
}

/** A rules segment's member count — the active audience (#705: unsubscribed members not counted). */
export async function dynamicMemberCount(db: D1Database, rules: string | null): Promise<number> {
	const parsed = parseRules(rules);
	if (!parsed) return 0;
	const c = compileSegment(parsed);
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE c.id IN (${c.sql}) AND ${segmentAudienceSql(parsed, 'c')}`).bind(...c.binds).first<{ n: number }>();
	return row?.n ?? 0;
}

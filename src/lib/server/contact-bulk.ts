/**
 * Bulk contact actions (#214) — shared by the `/contacts` and `/lists/[id]` bulk bars and
 * `POST /api/v1/contacts/bulk`, so selection, caps, guards and result wording live in one
 * place.
 *
 * A selection is either explicit ids (the checked rows) or "all matching": an id query the
 * caller builds from the same filter its page renders (`contactsWhere` on /contacts,
 * `memberQuery` / `compileSegment` on /lists/[id]). The query is re-run here, never a
 * client-supplied id list. Either way the set is capped at BULK_CAP (refused above it,
 * nothing is changed) and written in chunks of BULK_CHUNK.
 */

import { addScorePoints } from './scoring/contact';
import { pointsText, validateAdjust } from '$lib/scoring';
import { autoEnroll, enrollContactsInAutomation, ensureTag } from './automations';
import { deleteContactsByIds } from './contacts';
import { archiveContacts, restoreContacts } from './contact-archive';
import { contactsWhere, parseContactsFilter, resolveContactsFilter } from './contacts-query';
import { snapshot } from './snapshot';
import { asMailProvider, isHardSuppression, type MailSource } from './mail';
import { subscriptionChanged } from './subscription-trigger';
import type { SubscriptionSource } from '$lib/subscription-trigger';
import { exclusionTagName } from '$lib/segment-exclusion';
import { appendRule } from './segment-filter-rule';
import { parseRules } from './segment-query';
import { setTierOverride } from './tier-override';
import { TIER_LABELS, type TierName } from '$lib/engagement-view';
import { normalizeTierOverride } from '$lib/tier-override';

export const BULK_CHUNK = 500;
export const BULK_CAP = 20_000;
// A chunk of ids is bound as ONE JSON array, so a 500-id chunk is one statement with one
// variable (D1 caps a query at 100 bound variables, and counts statements per invocation).
const IDS = '(SELECT value FROM json_each(?))';

/** A `SELECT` whose rows carry an `id` column — one row per contact. */
export type IdQuery = { sql: string; binds: unknown[] };

/** `empty` = nothing to act on (no match / no such contacts), as opposed to a bad request. */
export type Selection =
	| { ok: true; ids: number[]; all: boolean; missing: number }
	| { ok: false; error: string; empty?: boolean };

export type BulkOutcome =
	| { ok: true; affected: number; skipped: number; message: string; href?: string; blocked?: number }
	| { ok: false; status: number; error: string };

type Group = { id: number; name: string; kind: string; rules: string | null };

/** Anything with FormData/URLSearchParams-style `get`. */
type Source = { get(key: string): string | File | null; getAll?(key: string): (string | File)[] };

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

export function fmt(n: number): string {
	return n.toLocaleString('en-US');
}

function plural(n: number, word: string): string {
	return `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** The "all matching" id query for `/contacts` — same parser + WHERE the page renders.
 *  `opts.defaultStatus` (#705): `/api/v1/contacts/bulk` passes `all` (its filter's old meaning). */
export async function contactsFilterQuery(
	db: D1Database,
	src: Source,
	opts: { defaultStatus?: 'all' } = {}
): Promise<IdQuery> {
	const { where, params } = contactsWhere(await resolveContactsFilter(db, parseContactsFilter(src, opts)));
	return { sql: `SELECT id FROM contacts ${where}`, binds: params };
}

/** True when a bulk form asks for "all matching" (`all=1`; `select_all` kept for old forms). */
export function wantsAll(src: Source): boolean {
	return src.get('all') === '1' || !!src.get('select_all');
}

/** Checked-row ids from a form (`contact_ids`). */
export function formIds(data: FormData): number[] {
	return data.getAll('contact_ids').map((v) => Number(v));
}

/**
 * Resolve a selection to contact ids. `query` = all matching (re-run server-side);
 * otherwise `ids`, deduped and checked against `contacts` (unknown ids are `missing`).
 */
export async function resolveSelection(
	db: D1Database,
	input: { ids?: unknown[]; query?: IdQuery | null }
): Promise<Selection> {
	if (input.query) {
		const { sql, binds } = input.query;
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM (${sql})`)
			.bind(...binds)
			.first<{ n: number }>();
		const n = row?.n ?? 0;
		if (n === 0) return { ok: false, error: 'No contacts match the current filter.', empty: true };
		if (n > BULK_CAP) {
			return {
				ok: false,
				error: `That filter matches ${fmt(n)} contacts. Bulk actions are capped at ${fmt(BULK_CAP)} — narrow the filter and run it in parts.`
			};
		}
		const rows = await db
			.prepare(`SELECT id FROM (${sql}) ORDER BY id`)
			.bind(...binds)
			.all<{ id: number }>();
		return { ok: true, ids: rows.results.map((r) => r.id), all: true, missing: 0 };
	}

	const wanted = [
		...new Set((input.ids ?? []).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))
	];
	if (wanted.length === 0) return { ok: false, error: 'Select at least one contact.' };
	if (wanted.length > BULK_CAP) {
		return { ok: false, error: `Too many contacts (${fmt(wanted.length)}). Bulk actions are capped at ${fmt(BULK_CAP)}.` };
	}
	const found: number[] = [];
	for (const part of chunk(wanted, BULK_CHUNK)) {
		const rows = await db
			.prepare(`SELECT id FROM contacts WHERE id IN ${IDS}`)
			.bind(JSON.stringify(part))
			.all<{ id: number }>();
		found.push(...rows.results.map((r) => r.id));
	}
	if (found.length === 0) return { ok: false, error: 'None of those contacts exist.', empty: true };
	return { ok: true, ids: found, all: false, missing: wanted.length - found.length };
}

/** A list/segment/tag by id, or by name within the given kinds (case-insensitive). */
export async function findGroup(
	db: D1Database,
	ref: string | number,
	kinds: string[]
): Promise<Group | null> {
	const kindIn = kinds.map(() => '?').join(',');
	const asId = typeof ref === 'number' ? ref : /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null;
	if (asId) {
		const byId = await db
			.prepare(`SELECT id, name, kind, rules FROM lists WHERE id = ? AND kind IN (${kindIn})`)
			.bind(asId, ...kinds)
			.first<Group>();
		if (byId) return byId;
	}
	return groupByName(db, String(ref), kinds);
}

async function groupByName(db: D1Database, raw: string, kinds: string[]): Promise<Group | null> {
	const name = raw.trim();
	if (!name) return null;
	return db
		.prepare(
			`SELECT id, name, kind, rules FROM lists WHERE name = ? COLLATE NOCASE
			   AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id LIMIT 1`
		)
		.bind(name, ...kinds)
		.first<Group>();
}

/** Find-or-create a group of `kind` by name (hand-picked lists/segments, or a tag). */
export async function ensureGroup(db: D1Database, name: string, kind: 'list' | 'segment' | 'tag'): Promise<Group | null> {
	const clean = name.trim().slice(0, 60);
	if (!clean) return null;
	const existing = await groupByName(db, clean, [kind]);
	if (existing) return existing;
	return db
		.prepare('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id, name, kind, rules')
		.bind(clean, kind)
		.first<Group>();
}

/** Membership is stored rows the operator may edit: not a company, not a dynamic segment. */
function editable(g: Group): boolean {
	if (g.kind === 'company') return false;
	if (g.kind === 'segment' && (g.rules ?? '').trim()) return false;
	return true;
}

function missingNote(missing: number): string {
	return missing ? ` · ${plural(missing, 'contact')} not found` : '';
}

/** Add contacts to a group (idempotent) and fire its `list_added` automations for the new
 *  members — unless `enroll` is false (the assistant, #301, never enrolls). */
async function addMembers(db: D1Database, ids: number[], listId: number, enroll = true): Promise<{ added: number; already: number }> {
	const added: number[] = [];
	for (const part of chunk(ids, BULK_CHUNK)) {
		// RETURNING lists only the rows actually inserted — the ones already there are ignored.
		const res = await db
			.prepare(
				`INSERT OR IGNORE INTO list_members (list_id, contact_id) SELECT ?, value FROM json_each(?)
				 RETURNING contact_id`
			)
			.bind(listId, JSON.stringify(part))
			.all<{ contact_id: number }>();
		added.push(...res.results.map((r) => r.contact_id));
	}
	if (enroll) {
		try {
			await autoEnroll(db, listId, added);
		} catch (e) {
			console.error('auto-enroll (bulk add) failed:', e);
		}
	}
	return { added: added.length, already: ids.length - added.length };
}

async function removeMembers(db: D1Database, ids: number[], listId: number): Promise<number> {
	let removed = 0;
	for (const part of chunk(ids, BULK_CHUNK)) {
		const res = await db
			.prepare(`DELETE FROM list_members WHERE list_id = ? AND contact_id IN ${IDS} RETURNING contact_id`)
			.bind(listId, JSON.stringify(part))
			.all<{ contact_id: number }>();
		removed += res.results.length;
	}
	return removed;
}

/** Add to a list or segment (the add-to-list and add-to-segment bulk actions). */
export async function bulkAddToGroup(
	db: D1Database,
	sel: Selection & { ok: true },
	group: Group,
	opts: { enroll?: boolean } = {}
): Promise<BulkOutcome> {
	if (!editable(group)) return { ok: false, status: 400, error: `Contacts can't be added to “${group.name}” by hand.` };
	const { added, already } = await addMembers(db, sel.ids, group.id, opts.enroll ?? true);
	const skipped = already + sel.missing;
	return {
		ok: true,
		affected: added,
		skipped,
		message: `Added ${fmt(added)} to “${group.name}”${already ? ` · ${fmt(already)} already there` : ''}${missingNote(sel.missing)}`
	};
}

/** Remove from a list, tag or hand-picked segment. Membership only — contacts stay. */
export async function bulkRemoveFromGroup(db: D1Database, sel: Selection & { ok: true }, group: Group): Promise<BulkOutcome> {
	if (!editable(group)) return { ok: false, status: 400, error: `Cannot remove members from “${group.name}” — its membership is derived.` };
	const removed = await removeMembers(db, sel.ids, group.id);
	const notIn = sel.ids.length - removed;
	const message =
		group.kind === 'tag'
			? `Removed tag “${group.name}” from ${fmt(removed)}${notIn ? ` · ${fmt(notIn)} didn't have it` : ''}`
			: `Removed ${fmt(removed)} from “${group.name}”${notIn ? ` · ${fmt(notIn)} weren't in it` : ''}`;
	return { ok: true, affected: removed, skipped: notIn + sel.missing, message: message + missingNote(sel.missing) };
}

/**
 * Take contacts out of a dynamic segment. Its membership is computed from rules, so there is
 * no row to delete: the selection gets the segment's exclusion tag and the segment gets a
 * `tag is absent` rule for it (once — a later run only tags). Removing the tag from a contact
 * lets them back in. Refused for a hand-picked segment (remove them instead) and, like #224's
 * Exclude, for a segment matching ANY of several rules (another rule would widen it). The rule
 * is checked and saved before anyone is tagged, so a refusal changes nothing.
 */
export async function bulkExcludeFromSegment(db: D1Database, sel: Selection & { ok: true }, group: Group): Promise<BulkOutcome> {
	const rules = group.kind === 'segment' ? parseRules(group.rules) : null;
	if (!rules) {
		return { ok: false, status: 400, error: `“${group.name}” isn't a dynamic segment — remove the contacts from it instead.` };
	}
	const tag = await ensureGroup(db, exclusionTagName(group.name), 'tag');
	if (!tag) return { ok: false, status: 400, error: 'Could not create the exclusion tag.' };
	const hasRule = rules.rules.some(
		(r) => r.field === 'tag' && r.op === 'not' && !r.invalid && (r.value ?? '').toLowerCase() === tag.name.toLowerCase()
	);
	if (!hasRule) {
		const next = appendRule(rules, { field: 'tag', op: 'not', value: tag.name });
		if (!next.ok) return { ok: false, status: 400, error: next.error };
		const json = JSON.stringify(next.rules);
		if (json.length > 8000) return { ok: false, status: 400, error: 'This segment has too many rules to add another.' };
		await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(json, group.id).run();
	}
	const { added, already } = await addMembers(db, sel.ids, tag.id);
	return {
		ok: true,
		affected: added,
		skipped: already + sel.missing,
		message:
			`Excluded ${fmt(added)} from “${group.name}”${already ? ` · ${fmt(already)} already excluded` : ''}` +
			` · they carry the tag “${tag.name}”; remove it to let someone back in${missingNote(sel.missing)}`
	};
}

/**
 * Tag contacts (find-or-create). `snapshot:approved` is refused: it releases a report to the
 * lead, so it is only ever added to one contact at a time (contact page, CRM API, review link).
 */
export async function bulkAddTag(
	db: D1Database,
	sel: Selection & { ok: true },
	name: string,
	opts: { enroll?: boolean } = {}
): Promise<BulkOutcome> {
	const tagName = name.trim();
	if (!tagName) return { ok: false, status: 400, error: 'Enter a tag name.' };
	if (tagName.length > 60) return { ok: false, status: 400, error: 'Tag is too long (60 chars max).' };
	if (snapshot.protectedTag && tagName.toLowerCase() === snapshot.protectedTag) {
		return {
			ok: false,
			status: 400,
			error: `“${snapshot.protectedTag}” can't be added in bulk — it sends a report. Approve each contact from its own page or review email.`
		};
	}
	const tagId = await ensureTag(db, tagName);
	if (!tagId) return { ok: false, status: 400, error: 'Enter a tag name.' };
	const { added, already } = await addMembers(db, sel.ids, tagId, opts.enroll ?? true);
	return {
		ok: true,
		affected: added,
		skipped: already + sel.missing,
		message: `Tagged ${fmt(added)} with “${tagName}”${already ? ` · ${fmt(already)} already had it` : ''}${missingNote(sel.missing)}`
	};
}

export async function bulkRemoveTag(db: D1Database, sel: Selection & { ok: true }, ref: string | number): Promise<BulkOutcome> {
	if (typeof ref === 'string' && !ref.trim()) return { ok: false, status: 400, error: 'Choose a tag to remove.' };
	const tag = await findGroup(db, ref, ['tag']);
	if (!tag) return { ok: false, status: 404, error: `No tag named “${String(ref).trim()}”.` };
	return bulkRemoveFromGroup(db, sel, tag);
}

/**
 * #705 (and #642): each skip reason is its own figure — " · 3 unsubscribed · 1 pending
 * confirmation · 2 archived · 4 already in it · 1 don't match the contact conditions".
 */
export function enrollSkipText(s: { unsubscribed: number; pending: number; archived: number; already: number; entry: number }): string {
	return (
		(s.unsubscribed ? ` · ${fmt(s.unsubscribed)} unsubscribed` : '') +
		(s.pending ? ` · ${fmt(s.pending)} pending confirmation` : '') +
		(s.archived ? ` · ${fmt(s.archived)} archived` : '') +
		(s.already ? ` · ${fmt(s.already)} already in it` : '') +
		(s.entry ? ` · ${fmt(s.entry)} don't match the contact conditions` : '')
	);
}

export async function bulkEnroll(db: D1Database, sel: Selection & { ok: true }, automationId: number): Promise<BulkOutcome> {
	let enrolled = 0;
	let skipped = 0;
	let name = '';
	const skips = { unsubscribed: 0, pending: 0, archived: 0, already: 0, entry: 0 };
	for (const part of chunk(sel.ids, BULK_CHUNK)) {
		const res = await enrollContactsInAutomation(db, automationId, part);
		if (!res.ok) return { ok: false, status: 400, error: res.error };
		enrolled += res.enrolled;
		skipped += res.skipped;
		for (const k of Object.keys(skips) as (keyof typeof skips)[]) skips[k] += res.skips[k];
		name = res.automationName;
	}
	return {
		ok: true,
		affected: enrolled,
		skipped: skipped + sel.missing,
		message: `Enrolled ${fmt(enrolled)} in “${name}”` + enrollSkipText(skips) + missingNote(sel.missing),
		href: `/automations/${automationId}`
	};
}

/**
 * Permanently delete contacts (shared cascade rules). "All matching" needs the typed
 * confirmation `delete`, checked here and not only in the browser.
 */
export async function bulkDelete(db: D1Database, sel: Selection & { ok: true }, confirm?: string | null): Promise<BulkOutcome> {
	if (sel.all && String(confirm ?? '').trim().toLowerCase() !== 'delete') {
		return { ok: false, status: 400, error: 'Type “delete” to confirm deleting every matching contact.' };
	}
	let deleted = 0;
	for (const part of chunk(sel.ids, BULK_CHUNK)) deleted += await deleteContactsByIds(db, part);
	return {
		ok: true,
		affected: deleted,
		skipped: sel.ids.length - deleted + sel.missing,
		message: `Deleted ${plural(deleted, 'contact')}${missingNote(sel.missing)}`
	};
}

/** Archive (#280): hidden from views and never sent to; history and `subscribed` kept. */
export async function bulkArchive(db: D1Database, sel: Selection & { ok: true }): Promise<BulkOutcome> {
	const n = await archiveContacts(db, sel.ids);
	const already = sel.ids.length - n;
	return {
		ok: true,
		affected: n,
		skipped: already + sel.missing,
		message: `Archived ${plural(n, 'contact')}${already ? ` · ${fmt(already)} already archived` : ''}${missingNote(sel.missing)}`
	};
}

/** Restore (#280): back in views and sends. */
export async function bulkRestore(db: D1Database, sel: Selection & { ok: true }): Promise<BulkOutcome> {
	const n = await restoreContacts(db, sel.ids);
	const notArchived = sel.ids.length - n;
	return {
		ok: true,
		affected: n,
		skipped: notArchived + sel.missing,
		message: `Restored ${plural(n, 'contact')}${notArchived ? ` · ${fmt(notArchived)} weren't archived` : ''}${missingNote(sel.missing)}`
	};
}

/** #460: set (tier) or clear (null) the engagement tier override on the selection. */
export async function bulkSetTier(
	db: D1Database,
	sel: Selection & { ok: true },
	op: { tier: TierName | null; days?: number | null; source: string }
): Promise<BulkOutcome> {
	const res = await setTierOverride(db, sel.ids, op);
	const n = res.changed.length;
	const already = res.unchanged.length;
	const what = op.tier
		? `Set tier to ${TIER_LABELS[op.tier]}${res.until ? ` until ${res.until.slice(0, 10)}` : ''} for ${plural(n, 'contact')}${already ? ` · ${fmt(already)} already set` : ''}`
		: `Back to automatic for ${plural(n, 'contact')}${already ? ` · ${fmt(already)} had no override` : ''}`;
	return { ok: true, affected: n, skipped: already + sel.missing, message: `${what}${missingNote(sel.missing)}` };
}

/** #467: ± points on one score for the selection — `manual` ledger rows (note + who), then
 *  recomputed inline (≤ 200) or by the heartbeat. */
export async function bulkAdjustScore(
	db: D1Database,
	sel: Selection & { ok: true },
	op: { scoreId: number; points: number; expires_days: number | null; note: string; by: string }
): Promise<BulkOutcome> {
	const score = await db.prepare('SELECT name FROM score_defs WHERE id = ?').bind(op.scoreId).first<{ name: string }>();
	if (!score) return { ok: false, status: 404, error: 'That score no longer exists.' };
	const note = [op.note, op.by ? `bulk by @${op.by}` : 'bulk'].filter(Boolean).join(' · ');
	const res = await addScorePoints(db, sel.ids, op.scoreId, { points: op.points, expires_days: op.expires_days, note, source_type: 'manual' });
	if (!res.ok) return { ok: false, status: 404, error: res.error };
	const later = res.inline ? '' : ' · totals update on the next heartbeat';
	return {
		ok: true,
		affected: res.affected,
		skipped: sel.ids.length - res.affected + sel.missing,
		message: `Adjusted ${score.name} by ${pointsText(op.points)} for ${plural(res.affected, 'contact')}${later}${missingNote(sel.missing)}`
	};
}

/**
 * Postmark credentials: POSTMARK_TOKEN + the broadcast stream ("Also suppress in Postmark"),
 * and the transactional stream (POSTMARK_STREAM_TX, default `outbound`) whose suppressions the
 * resubscribe guard also reads (#285).
 */
export type PostmarkCreds = { token?: string; stream?: string; txStream?: string };
/** #700: the active sending provider, or a Postmark credential bundle (as callers always passed). */
export type SuppressionSource = MailSource | PostmarkCreds;

/** `unsubscribes.reason` for an operator's bulk unsubscribe (#279). */
export const BULK_UNSUB_REASON = 'operator (bulk)';

/**
 * The unsubscribe write shared by bulk unsubscribe (#279) and the Postmark suppression sync
 * (#285), per chunk: `subscribed = 0`, one `unsubscribes` row (`reason` / `detail`) per
 * contact that was still subscribed, and every active automation pass of `ids` cancelled (the
 * write the engine does when it reaches an unsubscribed contact) — except passes of
 * `subscription_changed` automations (#444), which run on for unsubscribed contacts without
 * emailing them. Returns the emails of `ids` and the ids that were still subscribed.
 */
export async function unsubscribeIds(
	db: D1Database,
	ids: number[],
	reason: string,
	detail: string | null = null
): Promise<{ changed: number; cancelled: number; emails: string[]; changedIds: number[] }> {
	let changed = 0;
	let cancelled = 0;
	const emails: string[] = [];
	const changedIds: number[] = [];
	for (const part of chunk(ids, BULK_CHUNK)) {
		const json = JSON.stringify(part);
		const res = await db
			.prepare(`UPDATE contacts SET subscribed = 0 WHERE subscribed = 1 AND id IN ${IDS} RETURNING id`)
			.bind(json)
			.all<{ id: number }>();
		changed += res.results.length;
		changedIds.push(...res.results.map((r) => r.id));
		const [, ended, rows] = await db.batch([
			db
				.prepare(
					`INSERT INTO unsubscribes (contact_id, campaign_id, email, reason, detail)
					 SELECT id, NULL, email, ?, ? FROM contacts WHERE id IN ${IDS}`
				)
				.bind(reason, detail, JSON.stringify(res.results.map((r) => r.id))),
			db
				.prepare(
					`UPDATE automation_enrollments SET status='cancelled', next_run_at=NULL, ended_at=datetime('now')
					 WHERE status = 'active' AND contact_id IN ${IDS}
					   AND automation_id NOT IN (SELECT id FROM automations WHERE trigger_type = 'subscription_changed')`
				)
				.bind(json),
			db.prepare(`SELECT email FROM contacts WHERE id IN ${IDS}`).bind(json)
		]);
		cancelled += ended.meta.changes ?? 0;
		emails.push(...(rows.results as { email: string }[]).map((r) => r.email));
	}
	return { changed, cancelled, emails, changedIds };
}

/**
 * Bulk unsubscribe (#279) — the same effect as the /unsubscribe page's "unsubscribe from
 * everything" (unsubscribe.ts): `unsubscribeIds` with reason `operator (bulk)` (`opts.reason`:
 * the assistant, #322, passes `assistant (@login)`). With
 * `suppress`, the whole selection is also suppressed on the Postmark broadcast stream, 50
 * addresses per request; a failed request is counted and the rest carry on.
 */
export async function bulkUnsubscribe(
	db: D1Database,
	sel: Selection & { ok: true },
	opts: { suppress?: boolean; postmark?: SuppressionSource; reason?: string; detail?: string | null; source?: SubscriptionSource; triggers?: boolean } = {}
): Promise<BulkOutcome> {
	const { changed, cancelled, emails, changedIds } = await unsubscribeIds(
		db,
		sel.ids,
		opts.reason ?? BULK_UNSUB_REASON,
		opts.detail ?? null
	);
	// #444: "Subscription changes" trigger + tier refresh. `manual` = the bulk bar / assistant;
	// the Data API passes `api`. `triggers: false` (#551, the assistant): tier refresh only.
	await subscriptionChanged(db, changedIds, 'unsubscribed', { source: opts.source ?? 'manual', triggers: opts.triggers });
	const already = sel.ids.length - changed;
	let note = '';
	if (opts.suppress) {
		const mail = asMailProvider(opts.postmark);
		if (!mail?.suppressions || !mail.streams.broadcast) note = ' · Postmark not configured, nothing suppressed';
		else {
			const { suppressed, failed } = await mail.suppressions.addMany(emails, 'unsubscribe');
			note = ` · ${fmt(suppressed)} suppressed in ${mail.label}${failed ? ` · ${fmt(failed)} ${mail.label} suppression${failed === 1 ? '' : 's'} failed` : ''}`;
		}
	}
	return {
		ok: true,
		affected: changed,
		skipped: already + sel.missing,
		message:
			`Unsubscribed ${fmt(changed)}${already ? ` · ${fmt(already)} already unsubscribed` : ''}` +
			`${cancelled ? ` · ${fmt(cancelled)} automation pass${cancelled === 1 ? '' : 'es'} cancelled` : ''}${note}${missingNote(sel.missing)}`
	};
}

/**
 * Bulk resubscribe (#279): `subscribed = 1`, nothing else. Postmark suppressions are left
 * alone on purpose, and re-adding anyone needs their consent. #285: the stream dumps are read
 * once first and an address Postmark suppresses for a hard bounce or a spam complaint is
 * skipped (a manual suppression may be resubscribed). No token / Postmark unreachable →
 * resubscribe as before, with a note that suppressions weren't checked.
 */
export async function bulkResubscribe(
	db: D1Database,
	sel: Selection & { ok: true },
	opts: { postmark?: SuppressionSource; source?: SubscriptionSource; triggers?: boolean } = {}
): Promise<BulkOutcome> {
	let ids = sel.ids;
	let blocked = 0;
	let note = '';
	const mail = asMailProvider(opts.postmark);
	if (!mail?.suppressions) note = ' · Postmark not configured, suppressions not checked';
	else {
		const { map, errors, read } = await mail.suppressions.byEmail();
		if (!read) note = ' · Postmark unreachable, suppressions not checked';
		else {
			if (errors.length) note = ' · some Postmark streams unreachable, not all suppressions checked';
			const hard = new Set<number>();
			for (const part of chunk(ids, BULK_CHUNK)) {
				const rows = await db
					.prepare(`SELECT id, email FROM contacts WHERE subscribed = 0 AND id IN ${IDS}`)
					.bind(JSON.stringify(part))
					.all<{ id: number; email: string }>();
				for (const r of rows.results) {
					const s = map.get(r.email.trim().toLowerCase());
					if (s && isHardSuppression(s.reason)) hard.add(r.id);
				}
			}
			blocked = hard.size;
			if (blocked) ids = ids.filter((id) => !hard.has(id));
		}
	}
	let changed = 0;
	const changedIds: number[] = [];
	for (const part of chunk(ids, BULK_CHUNK)) {
		const res = await db
			.prepare(`UPDATE contacts SET subscribed = 1 WHERE subscribed = 0 AND id IN ${IDS} RETURNING id`)
			.bind(JSON.stringify(part))
			.all<{ id: number }>();
		changed += res.results.length;
		changedIds.push(...res.results.map((r) => r.id));
	}
	// #444: "Subscription changes" trigger + the score-based tier back (#551: `triggers: false` = tier only).
	await subscriptionChanged(db, changedIds, 'resubscribed', { source: opts.source ?? 'manual', triggers: opts.triggers });
	const already = ids.length - changed;
	return {
		ok: true,
		affected: changed,
		skipped: already + blocked + sel.missing,
		blocked,
		message:
			`Resubscribed ${fmt(changed)}${already ? ` · ${fmt(already)} already subscribed` : ''}` +
			`${blocked ? ` · ${fmt(blocked)} skipped: suppressed in Postmark (bounce/spam)` : ''}${note}${missingNote(sel.missing)}`
	};
}

/**
 * Groups the selection is in (lists, hand-picked segments, tags) with how many of it each
 * holds — the "Remove from list" / "Remove tag" pickers for an all-matching selection.
 */
export async function groupsOfQuery(
	db: D1Database,
	q: IdQuery
): Promise<{ id: number; name: string; kind: string; n: number }[]> {
	const rows = await db
		.prepare(
			`SELECT l.id, l.name, l.kind, COUNT(*) AS n
			 FROM list_members lm JOIN lists l ON l.id = lm.list_id
			 WHERE l.kind IN ('list', 'segment', 'tag') AND COALESCE(l.rules, '') = ''
			   AND lm.contact_id IN (${q.sql})
			 GROUP BY l.id ORDER BY l.name COLLATE NOCASE`
		)
		.bind(...q.binds)
		.all<{ id: number; name: string; kind: string; n: number }>();
	return rows.results;
}

/** Same groups for a page of rows: contact id → group ids (for a checked-rows selection). */
export async function groupsOfIds(db: D1Database, ids: number[]): Promise<Record<number, number[]>> {
	const out: Record<number, number[]> = {};
	for (const part of chunk(ids, BULK_CHUNK)) {
		const rows = await db
			.prepare(
				`SELECT lm.contact_id, lm.list_id FROM list_members lm JOIN lists l ON l.id = lm.list_id
				 WHERE l.kind IN ('list', 'segment', 'tag') AND COALESCE(l.rules, '') = ''
				   AND lm.contact_id IN ${IDS}`
			)
			.bind(JSON.stringify(part))
			.all<{ contact_id: number; list_id: number }>();
		for (const r of rows.results) (out[r.contact_id] ??= []).push(r.list_id);
	}
	return out;
}

export type BulkOp =
	| { action: 'add_list'; list: string | number; create?: boolean }
	| { action: 'add_segment'; group: string | number; create?: boolean }
	| { action: 'remove_list'; list: string | number; kinds?: string[] }
	| { action: 'exclude_segment'; segment: string | number }
	| { action: 'add_tag'; tag: string }
	| { action: 'remove_tag'; tag: string | number }
	| { action: 'enroll'; automationId: number }
	| { action: 'delete'; confirm?: string | null }
	| { action: 'archive' }
	| { action: 'restore' }
	| { action: 'unsubscribe'; suppress?: boolean; postmark?: SuppressionSource; source?: SubscriptionSource }
	| { action: 'resubscribe'; postmark?: SuppressionSource; source?: SubscriptionSource }
	| { action: 'set_tier'; tier: TierName | null; days?: number | null; source: string }
	| { action: 'adjust_score'; scoreId: number; points: number; expires_days: number | null; note: string; by: string };

/** Run one bulk operation over a resolved selection. */
export async function runBulk(db: D1Database, sel: Selection & { ok: true }, op: BulkOp): Promise<BulkOutcome> {
	switch (op.action) {
		case 'add_list': {
			let list = await findGroup(db, op.list, ['list']);
			if (!list && op.create && typeof op.list === 'string' && !/^\d+$/.test(op.list.trim())) {
				list = await ensureGroup(db, op.list, 'list');
			}
			if (!list) return { ok: false, status: 404, error: 'List not found.' };
			return bulkAddToGroup(db, sel, list);
		}
		case 'add_segment': {
			// Existing target may be a list or a segment; a typed new name is always a segment.
			let group = await findGroup(db, op.group, ['list', 'segment']);
			if (!group && op.create && typeof op.group === 'string' && op.group.trim()) {
				group = await ensureGroup(db, op.group, 'segment');
			}
			if (!group) return { ok: false, status: 404, error: 'List or segment not found.' };
			return bulkAddToGroup(db, sel, group);
		}
		case 'remove_list': {
			const list = await findGroup(db, op.list, op.kinds ?? ['list', 'segment']);
			if (!list) return { ok: false, status: 404, error: 'List not found.' };
			return bulkRemoveFromGroup(db, sel, list);
		}
		case 'exclude_segment': {
			const seg = await findGroup(db, op.segment, ['segment']);
			if (!seg) return { ok: false, status: 404, error: 'Segment not found.' };
			return bulkExcludeFromSegment(db, sel, seg);
		}
		case 'add_tag':
			return bulkAddTag(db, sel, op.tag);
		case 'remove_tag':
			return bulkRemoveTag(db, sel, op.tag);
		case 'enroll':
			return bulkEnroll(db, sel, op.automationId);
		case 'delete':
			return bulkDelete(db, sel, op.confirm);
		case 'archive':
			return bulkArchive(db, sel);
		case 'restore':
			return bulkRestore(db, sel);
		case 'unsubscribe':
			return bulkUnsubscribe(db, sel, op);
		case 'resubscribe':
			return bulkResubscribe(db, sel, op);
		case 'set_tier':
			return bulkSetTier(db, sel, op);
		case 'adjust_score':
			return bulkAdjustScore(db, sel, op);
	}
}

export type BulkFormAction = BulkOp['action'];

/**
 * The bulk-bar form contract shared by /contacts and /lists/[id]: the selection
 * (`contact_ids`, or `all=1` + the page's filter params) plus the action's own fields
 * (`list_id`/`new_list`, `segment_id`/`new_segment`, `tag`, `automation_id`, `confirm`;
 * `exclude_segment` takes the page's own group).
 * `currentGroup` is the /lists/[id] page's own group: the default "remove from" target.
 */
export async function runBulkForm(
	db: D1Database,
	data: FormData,
	action: BulkFormAction,
	opts: { query: () => IdQuery | Promise<IdQuery>; currentGroup?: number; postmark?: SuppressionSource; actor?: string }
): Promise<BulkOutcome> {
	const sel = await resolveSelection(db, wantsAll(data) ? { query: await opts.query() } : { ids: formIds(data) });
	if (!sel.ok) return { ok: false, status: 400, error: sel.error };
	const field = (k: string) => String(data.get(k) ?? '').trim();
	switch (action) {
		case 'add_list': {
			const id = Number(field('list_id'));
			if (id) return runBulk(db, sel, { action, list: id });
			const name = field('new_list');
			if (!name) return { ok: false, status: 400, error: 'Choose a list or enter a new list name.' };
			return runBulk(db, sel, { action, list: name, create: true });
		}
		case 'add_segment': {
			// `target_id` / `new_name` are the /lists/[id] "Add to" form's older field names.
			const id = Number(field('segment_id') || field('target_id'));
			if (id && id === opts.currentGroup) {
				return { ok: false, status: 400, error: 'Those contacts are already in this group.' };
			}
			if (id) return runBulk(db, sel, { action, group: id });
			const name = field('new_segment') || field('new_name');
			if (!name) return { ok: false, status: 400, error: 'Choose a list/segment or enter a new segment name.' };
			return runBulk(db, sel, { action, group: name, create: true });
		}
		case 'remove_list': {
			const id = Number(field('list_id')) || opts.currentGroup;
			if (!id) return { ok: false, status: 400, error: 'Choose a list.' };
			// The page's own group may be a tag (or a derived group, refused downstream).
			const kinds = id === opts.currentGroup ? ['list', 'segment', 'tag', 'company'] : ['list', 'segment'];
			return runBulk(db, sel, { action, list: id, kinds });
		}
		case 'exclude_segment': {
			// "Exclude from this segment" on a dynamic segment's own page (`segment_id` for other callers).
			const id = Number(field('segment_id')) || opts.currentGroup;
			if (!id) return { ok: false, status: 400, error: 'Choose a segment.' };
			return runBulk(db, sel, { action, segment: id });
		}
		case 'add_tag':
		case 'remove_tag':
			return runBulk(db, sel, { action, tag: field('tag') });
		case 'enroll':
			return runBulk(db, sel, { action, automationId: Number(field('automation_id')) });
		case 'delete':
			return runBulk(db, sel, { action, confirm: field('confirm') });
		case 'unsubscribe':
			return runBulk(db, sel, { action, suppress: field('suppress') === '1', postmark: opts.postmark });
		case 'resubscribe':
			return runBulk(db, sel, { action, postmark: opts.postmark });
		case 'archive':
		case 'restore':
			return runBulk(db, sel, { action });
		case 'set_tier': {
			// #460: `tier` (or `clear`) + optional `days` (blank = until cleared).
			const n = normalizeTierOverride({ tier: field('tier'), days: field('days') });
			if (!n.ok) return { ok: false, status: 400, error: n.error };
			return runBulk(db, sel, { action, ...n.value, source: `bulk:${opts.actor ?? ''}` });
		}
		case 'adjust_score': {
			// #467: `score_id`, `points` (±), optional `expires_days` and `note` (the caller checks admin).
			const scoreId = Number(field('score_id'));
			if (!Number.isInteger(scoreId) || scoreId <= 0) return { ok: false, status: 400, error: 'Choose a score.' };
			const n = validateAdjust({ points: field('points'), expires_days: field('expires_days'), note: field('note') });
			if (!n.ok) return { ok: false, status: 400, error: n.error };
			return runBulk(db, sel, { action, scoreId, ...n.value, by: opts.actor ?? '' });
		}
	}
}

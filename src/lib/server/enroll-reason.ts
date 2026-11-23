// #642: why one contact was not enrolled in one automation. `enroll()` (automations.ts) is the
// only place that decides who gets in; this module only explains a skip after the fact, so its
// checks mirror enroll()'s SQL in the same order the contact page reports them.

import { parseGateRules } from '$lib/condition-rules';
import { contactsMatchingRules } from './condition-eval';

export type EnrollSkipReason = 'archived' | 'unsubscribed' | 'active' | 'once' | 'conditions';

/**
 * The first reason `contactId` can't be enrolled in `automationId`, checked in this order:
 * archived, unsubscribed, already in an active pass, already went through once ("once only"
 * re-entry and any earlier pass), doesn't match the contact conditions (entry rules, #412).
 * `ignoreEntryRules` skips the last check (the "Enroll anyway" path); `ignoreReentry` (#673) skips
 * the once-only check ("Enroll again"). An active pass is still reported. Null = none of these
 * (e.g. the contact or automation is gone).
 */
export async function enrollSkipReason(
	db: D1Database,
	automationId: number,
	contactId: number,
	opts: { ignoreEntryRules?: boolean; ignoreReentry?: boolean } = {}
): Promise<EnrollSkipReason | null> {
	const contact = await db
		.prepare('SELECT subscribed, archived_at FROM contacts WHERE id = ?')
		.bind(contactId)
		.first<{ subscribed: number; archived_at: string | null }>();
	if (!contact) return null;
	if (contact.archived_at != null) return 'archived';
	if (contact.subscribed !== 1) return 'unsubscribed';

	const auto = await db
		.prepare('SELECT reentry, entry_rules FROM automations WHERE id = ?')
		.bind(automationId)
		.first<{ reentry: string; entry_rules: string | null }>();
	if (!auto) return null;

	const passes = await db
		.prepare(
			`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
			 FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?`
		)
		.bind(automationId, contactId)
		.first<{ total: number; active: number | null }>();
	if ((passes?.active ?? 0) > 0) return 'active';
	if (!opts.ignoreReentry && auto.reentry !== 'multiple' && (passes?.total ?? 0) > 0) return 'once';

	if (!opts.ignoreEntryRules) {
		const entry = parseGateRules(auto.entry_rules);
		if (entry) {
			const keep = await contactsMatchingRules(db, entry, [contactId]);
			if (!keep.includes(contactId)) return 'conditions';
		}
	}
	return null;
}

/** #678: the Enroll dialog lists at most this many skipped hand-picked contacts ("and N more"). */
export const SKIP_ROWS_CAP = 50;

export type EnrollSkipRow = { id: number; email: string; reason: EnrollSkipReason };

/**
 * #678: why each hand-picked contact in the automation's Enroll dialog would be skipped — one
 * row per contact with a reason (contact conditions included), in pick order, at most
 * SKIP_ROWS_CAP rows; `more` counts the rest. Contacts that would be enrolled (and ids that no
 * longer exist) get no row. Read-only.
 */
export async function enrollSkipRows(
	db: D1Database,
	automationId: number,
	contactIds: number[],
	opts: { ignoreEntryRules?: boolean } = {}
): Promise<{ rows: EnrollSkipRow[]; more: number }> {
	const ids = [...new Set(contactIds.filter((n) => Number.isInteger(n) && n > 0))];
	if (ids.length === 0) return { rows: [], more: 0 };
	const emails = new Map(
		(
			await db
				.prepare('SELECT id, email FROM contacts WHERE id IN (SELECT value FROM json_each(?))')
				.bind(JSON.stringify(ids))
				.all<{ id: number; email: string }>()
		).results.map((r) => [r.id, r.email])
	);
	const rows: EnrollSkipRow[] = [];
	let more = 0;
	for (const id of ids) {
		if (!emails.has(id)) continue;
		const reason = await enrollSkipReason(db, automationId, id, { ignoreEntryRules: opts.ignoreEntryRules });
		if (!reason) continue;
		if (rows.length < SKIP_ROWS_CAP) rows.push({ id, email: emails.get(id)!, reason });
		else more++;
	}
	return { rows, more };
}

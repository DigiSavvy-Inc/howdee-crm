// Shared contact mutations used by the UI actions and the /api/v1 Data API (#73), so the
// invariants live in one place.
import { autoEnroll, addTag } from '$lib/server/automations';
import { syncCompanyMembership } from '$lib/server/companies';

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/**
 * Delete contacts by id with the project's cascade rules: hard-delete `events` +
 * `recipients` (no ON DELETE on `events` → would orphan), let `list_members` +
 * `automation_enrollments` cascade, and PRESERVE `replies` + `unsubscribes` with
 * `contact_id` nulled (a reply is a record; an unsubscribe is a compliance fact).
 * Chunked at 500 ids, each chunk bound as one JSON array (`json_each`), so D1's 100-variable
 * cap doesn't apply and a bulk delete (#214) stays a few statements per 500 contacts.
 * Returns the number of contacts actually deleted.
 */
export async function deleteContactsByIds(db: D1Database, ids: number[]): Promise<number> {
	const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
	if (clean.length === 0) return 0;

	let deleted = 0;
	for (const part of chunk(clean, 500)) {
		const json = JSON.stringify(part);
		const ph = 'SELECT value FROM json_each(?)';
		// Events first (reference recipients + contacts), then recipients, then cascading
		// membership tables, then null the preserved records, then the contact.
		const res = await db.batch([
			db
				.prepare(
					`DELETE FROM events WHERE contact_id IN (${ph})
					   OR recipient_id IN (SELECT id FROM recipients WHERE contact_id IN (${ph}))`
				)
				.bind(json, json),
			db.prepare(`DELETE FROM recipients WHERE contact_id IN (${ph})`).bind(json),
			db.prepare(`DELETE FROM list_members WHERE contact_id IN (${ph})`).bind(json),
			db.prepare(`DELETE FROM automation_enrollments WHERE contact_id IN (${ph})`).bind(json),
			// #589: also ON DELETE CASCADE; explicit so the erase never depends on FK enforcement.
			db.prepare(`DELETE FROM contact_ratings WHERE contact_id IN (${ph})`).bind(json),
			db.prepare(`UPDATE replies SET contact_id = NULL WHERE contact_id IN (${ph})`).bind(json),
			db.prepare(`UPDATE unsubscribes SET contact_id = NULL WHERE contact_id IN (${ph})`).bind(json),
			// RETURNING + row count, not meta.changes: D1 reports cascaded deletes (site_events via
			// ON DELETE CASCADE) in `changes`, which inflated the count the bulk-delete UI shows.
			db.prepare(`DELETE FROM contacts WHERE id IN (${ph}) RETURNING id`).bind(json)
		]);
		deleted += res[res.length - 1].results.length;
	}
	return deleted;
}

/** Add a contact to a tag and fire any `list_added` automation on it. */
export async function addTagAndEnroll(db: D1Database, name: string, contactId: number): Promise<void> {
	const tn = name.trim();
	if (!tn) return;
	await addTag(db, tn, contactId); // find-or-create tag + idempotent membership
	const tag = await db
		.prepare("SELECT id FROM lists WHERE name = ? COLLATE NOCASE AND kind = 'tag'")
		.bind(tn)
		.first<{ id: number }>();
	if (tag) {
		try {
			await autoEnroll(db, tag.id, [contactId]);
		} catch (e) {
			console.error('addTagAndEnroll auto-enroll failed:', e);
		}
	}
}

/** Remove a contact from a tag by name (no-op if absent). */
export async function removeTag(db: D1Database, name: string, contactId: number): Promise<void> {
	const tn = name.trim();
	if (!tn) return;
	await db
		.prepare("DELETE FROM list_members WHERE contact_id = ? AND list_id IN (SELECT id FROM lists WHERE name = ? AND kind = 'tag')")
		.bind(contactId, tn)
		.run();
}

/** Find-or-create a `kind='list'` list by name and add the contact. Returns the list id. */
export async function addToList(db: D1Database, name: string, contactId: number): Promise<number | null> {
	const ln = name.trim();
	if (!ln) return null;
	let list = await db.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'list'").bind(ln).first<{ id: number }>();
	if (!list) {
		list = (await db.prepare("INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id").bind(ln).first<{ id: number }>())!;
	}
	await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list.id, contactId).run();
	return list.id;
}

export { syncCompanyMembership, autoEnroll };

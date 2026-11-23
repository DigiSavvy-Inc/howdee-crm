/**
 * Archive / restore contacts (#280). `contacts.archived_at` NULL = active; a timestamp =
 * archived at that time. An archived contact is hidden from day-to-day views and never sent
 * to, but keeps its history; `subscribed` is left as it is. No SvelteKit imports — used by
 * the bulk bars, the contact page, `/api/v1/contacts/bulk` and the ingest paths.
 */

const CHUNK = 500;
// One JSON array per chunk — one bound variable, whatever the chunk size (see contact-bulk).
const IDS = '(SELECT value FROM json_each(?))';

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** Archive the given contacts. Returns how many changed (already-archived rows are skipped). */
export async function archiveContacts(db: D1Database, ids: number[]): Promise<number> {
	let n = 0;
	for (const part of chunk(ids, CHUNK)) {
		const res = await db
			.prepare(`UPDATE contacts SET archived_at = datetime('now') WHERE archived_at IS NULL AND id IN ${IDS}`)
			.bind(JSON.stringify(part))
			.run();
		n += res.meta.changes ?? 0;
	}
	return n;
}

/** Restore the given contacts. Returns how many changed (active rows are skipped). */
export async function restoreContacts(db: D1Database, ids: number[]): Promise<number> {
	let n = 0;
	for (const part of chunk(ids, CHUNK)) {
		const res = await db
			.prepare(`UPDATE contacts SET archived_at = NULL WHERE archived_at IS NOT NULL AND id IN ${IDS}`)
			.bind(JSON.stringify(part))
			.run();
		n += res.meta.changes ?? 0;
	}
	return n;
}

/**
 * "The other way in" (#280 §3a): a contact who re-engages (ingest, Luma, a v1 POST/upsert
 * with `subscribed: true`) is restored. By id or by email; a no-op when not archived.
 */
export async function restoreIfArchived(db: D1Database, ref: { id?: number | null; email?: string | null }): Promise<boolean> {
	if (ref.id) {
		const res = await db.prepare('UPDATE contacts SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').bind(ref.id).run();
		return (res.meta.changes ?? 0) > 0;
	}
	const email = (ref.email ?? '').trim().toLowerCase();
	if (!email) return false;
	const res = await db
		.prepare('UPDATE contacts SET archived_at = NULL WHERE email = ? AND archived_at IS NOT NULL')
		.bind(email)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

import { autoEnroll } from './automations';
// Read side (list / one / serialize) lives in ./company-read so read-only callers (the
// assistant, #287) don't pull in this module's autoEnroll import.
export { listCompanies, getCompany, serializeCompany } from './company-read';
export type { Company, CompanyListRow, CompanySort } from './company-read';


/**
 * Companies (#47) are a contact grouping reusing `lists(kind='company')` + `list_members`,
 * derived from the `contacts.company` text field — **many-to-one**: a contact belongs to at
 * most one company group, mirroring its single company name.
 *
 * Sync a contact's company-group membership to match `companyName`:
 *  - empty/null  → remove from every `kind='company'` group.
 *  - a name      → find-or-create that company group, ensure membership, and remove the
 *                  contact from any *other* company group (enforces one-per-contact).
 * Idempotent. Best-effort `autoEnroll` on the (re)joined company, like every other
 * add-to-group path (FEATURE_CHECKLIST §3). Call this from any path that writes
 * `contacts.company`.
 */
export async function syncCompanyMembership(
	db: D1Database,
	contactId: number,
	companyName: string | null,
	opts: { enroll?: boolean } = {} // false: skip autoEnroll (the assistant never enrolls, #301)
): Promise<void> {
	const name = (companyName ?? '').trim();

	// #166: every writer of contacts.company lands here, so this is where the company
	// entity link (contacts.company_id) is kept in step with the text.
	await linkContactCompany(db, contactId, name);

	if (!name) {
		await db
			.prepare(
				`DELETE FROM list_members
				 WHERE contact_id = ? AND list_id IN (SELECT id FROM lists WHERE kind = 'company')`
			)
			.bind(contactId)
			.run();
		await pruneEmptyCompanies(db);
		return;
	}

	let company = await db
		.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'company'")
		.bind(name)
		.first<{ id: number }>();
	if (!company) {
		company = (await db
			.prepare("INSERT INTO lists (name, kind) VALUES (?, 'company') RETURNING id")
			.bind(name)
			.first<{ id: number }>())!;
	}

	// Enforce many-to-one: drop membership in any other company group.
	await db
		.prepare(
			`DELETE FROM list_members
			 WHERE contact_id = ? AND list_id IN (SELECT id FROM lists WHERE kind = 'company' AND id != ?)`
		)
		.bind(contactId, company.id)
		.run();

	await db
		.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)')
		.bind(company.id, contactId)
		.run();

	if (opts.enroll ?? true) {
		try {
			await autoEnroll(db, company.id, [contactId]);
		} catch (e) {
			console.error('auto-enroll (company) failed:', e);
		}
	}

	await pruneEmptyCompanies(db);
}

/** Companies are derived, so a group left with zero members (after a move/clear) is
 *  noise — delete it, UNLESS an automation trigger references it (deleting would break
 *  the trigger). Lists/segments/tags are never touched. */
async function pruneEmptyCompanies(db: D1Database): Promise<void> {
	await db
		.prepare(
			`DELETE FROM lists
			 WHERE kind = 'company'
			   AND id NOT IN (SELECT DISTINCT list_id FROM list_members)
			   AND id NOT IN (SELECT trigger_list_id FROM automations WHERE trigger_list_id IS NOT NULL)`
		)
		.run();
}

// ---- Companies entity (#166) -------------------------------------------------------------
// A first-class `companies` table (name UNIQUE NOCASE, domain, website, notes) linked from
// `contacts.company_id`. `contacts.company` text stays as the display fallback + API field;
// `syncCompanyMembership` above keeps the two in step on every write.

/** Find a company by name (case-insensitive) or create it. Null for a blank name. */
export async function findOrCreateCompany(db: D1Database, name: string | null): Promise<number | null> {
	const n = (name ?? '').trim().slice(0, 200);
	if (!n) return null;
	await db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').bind(n).run();
	const row = await db.prepare('SELECT id FROM companies WHERE name = ?').bind(n).first<{ id: number }>();
	return row?.id ?? null;
}

/** Point a contact at the company named `name` (find-or-create); blank → unlinked. */
export async function linkContactCompany(db: D1Database, contactId: number, name: string | null): Promise<number | null> {
	const companyId = await findOrCreateCompany(db, name);
	await db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').bind(companyId, contactId).run();
	return companyId;
}

/** Bare host from a domain-ish input ("https://www.Acme.com/x" → "www.acme.com"). */
export function normalizeDomain(v: string | null | undefined): string | null {
	const s = (v ?? '').trim().toLowerCase();
	if (!s) return null;
	const host = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
	return host.slice(0, 253) || null;
}

/** An http(s) URL for the website link ("acme.com" → "https://acme.com"); junk → null. */
export function normalizeWebsite(v: string | null | undefined): string | null {
	const s = (v ?? '').trim();
	if (!s) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
	try {
		const u = new URL(withScheme);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.toString().slice(0, 500);
	} catch {
		return null;
	}
}

export type CompanyInput = { name?: unknown; domain?: unknown; website?: unknown; notes?: unknown };

const hasKey = (b: object, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Create a company. `exists` when the name is taken (case-insensitive). */
export async function createCompany(
	db: D1Database,
	input: CompanyInput
): Promise<{ ok: true; id: number } | { ok: false; error: 'name_required' | 'exists'; id?: number }> {
	const name = text(input.name).slice(0, 200);
	if (!name) return { ok: false, error: 'name_required' };
	const clash = await db.prepare('SELECT id FROM companies WHERE name = ?').bind(name).first<{ id: number }>();
	if (clash) return { ok: false, error: 'exists', id: clash.id };
	try {
		const row = await db
			.prepare('INSERT INTO companies (name, domain, website, notes) VALUES (?, ?, ?, ?) RETURNING id')
			.bind(name, normalizeDomain(text(input.domain)), normalizeWebsite(text(input.website)), text(input.notes).slice(0, 5000) || null)
			.first<{ id: number }>();
		return { ok: true, id: row!.id };
	} catch (e) {
		if (String(e).includes('UNIQUE')) return { ok: false, error: 'exists' };
		throw e;
	}
}

/**
 * Partial update with key-present semantics (a key in `input` is written, "" / null clears;
 * omitted = untouched). A rename rewrites `contacts.company` on every linked contact and
 * re-syncs their company groups, so the text and the link never disagree.
 */
export async function updateCompany(
	db: D1Database,
	id: number,
	input: CompanyInput,
	opts: { enroll?: boolean } = {}
): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'name_required' | 'exists' }> {
	const cur = await db.prepare('SELECT id, name FROM companies WHERE id = ?').bind(id).first<{ id: number; name: string }>();
	if (!cur) return { ok: false, error: 'not_found' };

	const sets: string[] = [];
	const vals: unknown[] = [];
	let rename: string | null = null;
	if (hasKey(input, 'name')) {
		const name = text(input.name).slice(0, 200);
		if (!name) return { ok: false, error: 'name_required' };
		if (name !== cur.name) {
			const clash = await db
				.prepare('SELECT id FROM companies WHERE name = ? AND id != ?')
				.bind(name, id)
				.first<{ id: number }>();
			if (clash) return { ok: false, error: 'exists' };
			sets.push('name = ?');
			vals.push(name);
			rename = name;
		}
	}
	if (hasKey(input, 'domain')) {
		sets.push('domain = ?');
		vals.push(normalizeDomain(text(input.domain)));
	}
	if (hasKey(input, 'website')) {
		sets.push('website = ?');
		vals.push(normalizeWebsite(text(input.website)));
	}
	if (hasKey(input, 'notes')) {
		sets.push('notes = ?');
		vals.push(text(input.notes).slice(0, 5000) || null);
	}
	if (!sets.length) return { ok: true };

	sets.push("updated_at = datetime('now')");
	try {
		await db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
	} catch (e) {
		if (String(e).includes('UNIQUE')) return { ok: false, error: 'exists' };
		throw e;
	}

	if (rename !== null) {
		const linked = await db.prepare('SELECT id FROM contacts WHERE company_id = ?').bind(id).all<{ id: number }>();
		await db.prepare('UPDATE contacts SET company = ? WHERE company_id = ?').bind(rename, id).run();
		for (const c of linked.results) await syncCompanyMembership(db, c.id, rename, opts);
	}
	return { ok: true };
}

/** Delete a company. Linked contacts keep their `company` text; `company_id` is nulled
 *  (FK ON DELETE SET NULL — also done explicitly so it holds without FK enforcement). */
export async function deleteCompany(db: D1Database, id: number): Promise<boolean> {
	await db.prepare('UPDATE contacts SET company_id = NULL WHERE company_id = ?').bind(id).run();
	await db.prepare('DELETE FROM company_repos WHERE company_id = ?').bind(id).run(); // #169, also ON DELETE CASCADE
	const res = await db.prepare('DELETE FROM companies WHERE id = ?').bind(id).run();
	return (res.meta.changes ?? 0) > 0;
}

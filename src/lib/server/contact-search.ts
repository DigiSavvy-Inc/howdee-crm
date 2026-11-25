// Quick search (#91) for the /contacts table: a case-insensitive substring of the email /
// name fields. #485: matched with instr, not LIKE — D1 refuses LIKE patterns over 50 bytes —
// so the raw text is bound and `%` / `_` in it are literal.
import { containsSql } from './sql-match';

export function buildContactSearch(q: string): { where: string; binds: string[] } {
	const trimmed = q.trim();
	if (!trimmed) return { where: '', binds: [] };

	const fields = [
		'email',
		'name',
		'first_name',
		'last_name',
		'company',
		// Derived display name — matches a contact with only first_name/last_name set and
		// no combined `name` column value (e.g. "jane doe" should still find them).
		"TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))",
		// #583: the linked company's name too (the `company` text can lag a rename or be blank).
		// `company_id` is unqualified on purpose: companies has no such column, so it resolves
		// to the outer contacts row whatever alias the caller gives it.
		"(SELECT co.name FROM companies co WHERE co.id = company_id)"
	];

	const where = `WHERE (${fields.map((f) => containsSql(f)).join(' OR ')})`;
	const binds = fields.map(() => trimmed);

	return { where, binds };
}

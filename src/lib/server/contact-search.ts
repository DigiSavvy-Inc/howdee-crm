// Quick search (#91) for the /contacts table. Mirrors the LIKE-escape convention from
// src/routes/api/contacts/search/+server.ts: escape \, %, _ in user input so they can't
// act as SQL LIKE wildcards, then match a %substring% against email/name fields.
export function buildContactSearch(q: string): { where: string; binds: string[] } {
	const trimmed = q.trim();
	if (!trimmed) return { where: '', binds: [] };

	const esc = trimmed.replace(/[\\%_]/g, '\\$&');
	const like = `%${esc}%`;

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

	const where = `WHERE (${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
	const binds = fields.map(() => like);

	return { where, binds };
}

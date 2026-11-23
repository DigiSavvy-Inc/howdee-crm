import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';

// Typeahead for the contact page's Company picker (#166). Auth-guarded by hooks.server.ts
// (not a PUBLIC_PREFIX). Prefix matches rank first.
export const GET: RequestHandler = async (event) => {
	const q = (event.url.searchParams.get('q') ?? '').trim().slice(0, 100);
	if (q.length < 1) return json([]);

	const esc = q.replace(/[\\%_]/g, '\\$&');
	const rows = await getDB(event)
		.prepare(
			`SELECT id, name, domain FROM companies
			 WHERE name LIKE ?1 ESCAPE '\\' OR COALESCE(domain, '') LIKE ?1 ESCAPE '\\'
			 ORDER BY (name LIKE ?2 ESCAPE '\\') DESC, name COLLATE NOCASE
			 LIMIT 8`
		)
		.bind(`%${esc}%`, `${esc}%`)
		.all<{ id: number; name: string; domain: string | null }>();
	return json(rows.results);
};

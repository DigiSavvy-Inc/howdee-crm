import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { containsSql, startsWithSql } from '$lib/server/sql-match';

// Typeahead for the contact page's Company picker (#166). Auth-guarded by hooks.server.ts
// (not a PUBLIC_PREFIX). Prefix matches rank first. #485: instr, not LIKE — D1 caps LIKE
// patterns at 50 bytes — so the raw text is bound and `%` / `_` in it are literal.
export const GET: RequestHandler = async (event) => {
	const q = (event.url.searchParams.get('q') ?? '').trim().slice(0, 100);
	if (q.length < 1) return json([]);

	const rows = await getDB(event)
		.prepare(
			`SELECT id, name, domain FROM companies
			 WHERE ${containsSql('name', '?1')} OR ${containsSql("COALESCE(domain, '')", '?1')}
			 ORDER BY (${startsWithSql('name', '?1')}) DESC, name COLLATE NOCASE
			 LIMIT 8`
		)
		.bind(q)
		.all<{ id: number; name: string; domain: string | null }>();
	return json(rows.results);
};

import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { containsSql, startsWithSql } from '$lib/server/sql-match';

// Typeahead for the 1:1 composer. Auth-guarded by hooks.server.ts (not a PUBLIC_PREFIX).
export const GET: RequestHandler = async (event) => {
	const q = (event.url.searchParams.get('q') ?? '').trim();
	if (q.length < 1) return json([]);

	// Match anywhere, prefix matches rank first. #485: instr, not LIKE — D1 caps LIKE patterns
	// at 50 bytes — so the raw text is bound and `%` / `_` in it are literal.
	const has = (col: string) => containsSql(col, '?1');
	const starts = (col: string) => startsWithSql(col, '?1');

	const db = getDB(event);
	const rows = await db
		.prepare(
			`SELECT id, email, name, first_name, last_name, subscribed
			 FROM contacts
			 WHERE archived_at IS NULL -- #280: archived contacts aren't offered
			   AND (${has('email')}
			    OR ${has('name')}
			    OR ${has('first_name')}
			    OR ${has('last_name')})
			 ORDER BY (${starts('email')}) DESC,
			          (${starts('name')}) DESC,
			          email
			 LIMIT 8`
		)
		.bind(q)
		.all<{
			id: number;
			email: string;
			name: string | null;
			first_name: string | null;
			last_name: string | null;
			subscribed: number;
		}>();

	return json(rows.results);
};

import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';

// Typeahead for the 1:1 composer. Auth-guarded by hooks.server.ts (not a PUBLIC_PREFIX).
export const GET: RequestHandler = async (event) => {
	const q = (event.url.searchParams.get('q') ?? '').trim();
	if (q.length < 1) return json([]);

	// Escape LIKE wildcards in user input; match anywhere, prefix matches rank first.
	const esc = q.replace(/[\\%_]/g, '\\$&');
	const like = `%${esc}%`;
	const prefix = `${esc}%`;

	const db = getDB(event);
	const rows = await db
		.prepare(
			`SELECT id, email, name, first_name, last_name, subscribed
			 FROM contacts
			 WHERE archived_at IS NULL -- #280: archived contacts aren't offered
			   AND (email LIKE ?1 ESCAPE '\\'
			    OR name LIKE ?1 ESCAPE '\\'
			    OR first_name LIKE ?1 ESCAPE '\\'
			    OR last_name LIKE ?1 ESCAPE '\\')
			 ORDER BY (email LIKE ?2 ESCAPE '\\') DESC,
			          (name LIKE ?2 ESCAPE '\\') DESC,
			          email
			 LIMIT 8`
		)
		.bind(like, prefix)
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

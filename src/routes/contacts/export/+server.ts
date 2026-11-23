import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { csvCell } from '$lib/report-view';

/**
 * Full contacts export (#49) — the manual backup path. Session-authed (NOT in
 * PUBLIC_PREFIXES). One row per contact with memberships rolled up and custom
 * fields as JSON, so the file round-trips back through CSV import if ever needed.
 */
export const GET: RequestHandler = async (event) => {
	const db = getDB(event);

	const rows = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.subscribed,
			        c.source, c.created_at, c.meta,
			        (SELECT GROUP_CONCAT(l.name, '; ') FROM list_members lm JOIN lists l ON l.id = lm.list_id
			          WHERE lm.contact_id = c.id AND l.kind = 'list') AS lists,
			        (SELECT GROUP_CONCAT(l.name, '; ') FROM list_members lm JOIN lists l ON l.id = lm.list_id
			          WHERE lm.contact_id = c.id AND l.kind = 'segment') AS segments,
			        (SELECT GROUP_CONCAT(l.name, '; ') FROM list_members lm JOIN lists l ON l.id = lm.list_id
			          WHERE lm.contact_id = c.id AND l.kind = 'tag') AS tags
			 FROM contacts c ORDER BY c.id`
		)
		.all<Record<string, unknown>>();

	const header = [
		'email', 'name', 'first_name', 'last_name', 'company', 'subscribed', 'source',
		'created_at', 'lists', 'segments', 'tags', 'custom_fields_json'
	];
	const lines = [header.join(',')];
	for (const r of rows.results) {
		lines.push(
			[
				csvCell(r.email), csvCell(r.name), csvCell(r.first_name), csvCell(r.last_name), csvCell(r.company),
				csvCell(r.subscribed), csvCell(r.source), csvCell(r.created_at), csvCell(r.lists), csvCell(r.segments),
				csvCell(r.tags), csvCell(r.meta)
			].join(',')
		);
	}

	const today = new Date().toISOString().slice(0, 10);
	return new Response(lines.join('\r\n') + '\r\n', {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="contacts-${today}.csv"`
		}
	});
};

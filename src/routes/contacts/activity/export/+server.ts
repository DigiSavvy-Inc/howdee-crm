import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { feedExportCsv } from '$lib/server/contacts-overview';

/**
 * #423: "Export feed CSV" on the contacts Overview — the activity feed for the contacts the
 * `/contacts` filter matches (same query string: filter, `feed_types`, `feed_period`,
 * `period`), newest first, capped at 5,000 rows. Session-authed (not in PUBLIC_PREFIXES).
 */
export const GET: RequestHandler = async (event) => {
	const { csv } = await feedExportCsv(getDB(event), event.url.searchParams);
	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="contact-activity-${new Date().toISOString().slice(0, 10)}.csv"`,
			'Cache-Control': 'no-store'
		}
	});
};

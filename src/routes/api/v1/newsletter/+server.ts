import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, parsePaging, buildPagination } from '$lib/server/api-v1';
import { apiBaseUrl } from '$lib/server/campaigns-api';
import { countIssues, getArchiveSettings, listIssues } from '$lib/server/newsletter-archive';
import { archiveUrl } from '$lib/newsletter-archive';

// GET /api/v1/newsletter (#481, read) — the published newsletter archive issues, newest first,
// paged: { id, slug, number (#499, null = none), url, title, teaser, subject, edited_for_web, sent_at } — title / teaser are
// what the page shows (the web version's, #483), subject the email's. The X-Newsletter-Archive header (on | off) says
// whether the public pages are on. Publishing is admin-UI only (no write endpoint).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	const db = getDB(event);
	const { limit, offset } = parsePaging(event.url);
	const [rows, total, settings, base] = await Promise.all([
		listIssues(db, { limit, offset }),
		countIssues(db),
		getArchiveSettings(db),
		apiBaseUrl(event)
	]);
	const res = apiData(
		rows.map((r) => ({
			id: r.id,
			slug: r.slug,
			number: r.number,
			url: archiveUrl(base, r.slug),
			title: r.subject,
			teaser: r.teaser,
			subject: r.email_subject,
			edited_for_web: r.edited,
			sent_at: r.sent_at
		})),
		buildPagination(limit, offset, total)
	);
	res.headers.set('X-Newsletter-Archive', settings.enabled ? 'on' : 'off');
	return res;
};

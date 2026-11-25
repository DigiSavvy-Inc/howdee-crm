import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError, apiData } from '$lib/server/api-v1';
import { presendInputForCampaign, runPresendChecks } from '$lib/server/presend-checks';
import { getPresendPolicy } from '$lib/server/presend-policy';
import { applyPolicy } from '$lib/presend-policy';

// POST /api/v1/campaigns/:id/checks (#311, read) — the compose pre-send checks for a stored
// campaign: `{ data: { checks, blocks, warns, passes, links_checked } }`. Read-only: it
// never sends, schedules, edits or releases a hold. #479: the live link check runs by default
// (≤ 60 links, 5 s timeout each, one retry for a 5xx / no answer, public http(s) hosts only);
// body `{ "check_links": false }` skips it. The policy from Settings → General → Pre-send
// checks is applied, so the levels returned are the levels a send enforces.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(400, 'Invalid id.');

	let checkLinks = true;
	const raw = await event.request.text();
	if (raw.trim()) {
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return apiError(400, 'Body must be valid JSON.');
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'Body must be a JSON object.');
		const v = (body as Record<string, unknown>).check_links;
		if (v !== undefined && typeof v !== 'boolean') return apiError(400, 'check_links must be a boolean.');
		checkLinks = v !== false;
	}

	const db = getDB(event);
	const input = await presendInputForCampaign(db, id);
	if (!input) return apiError(404, 'No campaign with that id.');
	const r = applyPolicy(await runPresendChecks(db, input, { media: event.platform?.env?.MEDIA, checkLinks }), await getPresendPolicy(db));
	return apiData({ campaign_id: id, checks: r.checks, blocks: r.blocks, warns: r.warns, passes: r.passes, links_checked: r.linksChecked });
};

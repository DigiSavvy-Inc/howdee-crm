import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { searchCampaignRecipients } from '$lib/server/render-preview';

// #155: "Viewing as" search in the View email dialog — replaces the first-100 <select>.
// ?q= (2+ chars) matches this campaign's recipients by email or contact name, top 10.
// Session-gated by hooks.server.ts (not a PUBLIC_PREFIX) — the explicit guard below is
// defense-in-depth, same convention as ./render.
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const campaignId = Number(event.params.id);
	if (!Number.isInteger(campaignId) || campaignId <= 0) {
		return json({ error: 'invalid campaign id' }, { status: 400 });
	}

	const q = (event.url.searchParams.get('q') ?? '').trim().slice(0, 200);
	if (q.length < 2) return json({ results: [] });

	const results = await searchCampaignRecipients(getDB(event), campaignId, q, 10);
	return json({ results });
};

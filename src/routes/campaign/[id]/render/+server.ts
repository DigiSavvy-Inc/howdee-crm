import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB, env } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { renderForRecipient } from '$lib/server/render-preview';

// #127: "View email" dialog's "Viewing as" picker — renders the campaign through the
// exact send-time pipeline for a given recipient (or the template as authored).
// Session-gated by hooks.server.ts (not a PUBLIC_PREFIX) — the explicit guard below is
// defense-in-depth, same convention as /api/tour/dismiss.
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const campaignId = Number(event.params.id);
	if (!Number.isInteger(campaignId) || campaignId <= 0) {
		return json({ error: 'invalid campaign id' }, { status: 400 });
	}

	const as = event.url.searchParams.get('as');
	let recipientId: number | null;
	if (as === 'template') {
		recipientId = null;
	} else {
		const n = Number(as);
		if (as === null || as === '' || !Number.isInteger(n) || n <= 0) {
			return json({ error: 'invalid as parameter' }, { status: 400 });
		}
		recipientId = n;
	}

	const db = getDB(event);
	const secret = env(event, 'SESSION_SECRET');
	const baseUrl = await publicBaseUrlFor(event);

	const rendered = await renderForRecipient(db, { campaignId, recipientId, secret, baseUrl });
	if (!rendered) return json({ error: 'not found' }, { status: 404 });

	return json(rendered);
};

import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { loadZohoEnv } from '$lib/server/integrations/secrets';
import { canSeeBilling, customerSearch, ZohoRateLimitError } from '$lib/server/integrations/zoho';

// Zoho customer search for the company page's Billing panel (#353). Session-gated by
// hooks.server.ts (not a PUBLIC_PREFIX) and by billing access: admins, or members when the
// Settings → Integrations switch is on. #439: filters the cached customer list first (no Zoho
// request); a live search (≤ 2 requests, daily cap) only when the cache is cold or finds nothing.
// → { customers, total, source: 'cache' | 'live' | 'both' }
export const GET: RequestHandler = async (event) => {
	const db = getDB(event);
	if (!(await canSeeBilling(db, event.locals.user))) return json({ error: 'Billing is admin-only.' }, { status: 403 });
	const q = (event.url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ customers: [], total: 0, source: 'cache' });
	const env = await loadZohoEnv(db, event.platform?.env?.MAIL_TOKEN_KEY);
	if (!env?.organization_id) return json({ error: 'Zoho Books is not connected.' }, { status: 409 });
	try {
		return json(await customerSearch(db, env, q));
	} catch (e) {
		const msg = e instanceof ZohoRateLimitError ? 'Zoho is rate limiting — try again shortly.' : 'Could not search Zoho customers.';
		console.error('zoho customer search failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		return json({ error: msg }, { status: 502 });
	}
};

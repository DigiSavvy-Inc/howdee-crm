import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { TimingRateLimited, timingProjects } from '$lib/server/integrations/timing';
import { getProviderToken } from '$lib/server/integrations/secrets';

// Project list for the company page's Timing picker (#168). Session-gated by hooks.server.ts
// (not a PUBLIC_PREFIX). Served from the 10-minute app_state cache; the client filters.
export const GET: RequestHandler = async (event) => {
	const db = getDB(event);
	const e = event.platform?.env;
	// In-app token (#175) first, then the Worker secret.
	const token = await getProviderToken(db, { TIMING_API_TOKEN: e?.TIMING_API_TOKEN, MAIL_TOKEN_KEY: e?.MAIL_TOKEN_KEY }, 'timing');
	if (!token) return json({ error: 'Timing is not connected.' }, { status: 409 });
	try {
		return json({ projects: await timingProjects(db, { TIMING_API_TOKEN: token }) });
	} catch (e) {
		const msg = e instanceof TimingRateLimited ? 'Timing is rate limiting — try again shortly.' : 'Could not load Timing projects.';
		console.error('timing projects failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		return json({ error: msg }, { status: 502 });
	}
};

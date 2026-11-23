import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { runSetupChecks } from '$lib/server/setup-checks';

// Settings → Setup (#609). Admin-only: each piece a working install needs, ready or not, with
// one line on how to fix it. Secrets are reported as set / not set only — never a value.
export const load: PageServerLoad = async (event) => {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
	const env = event.platform?.env as unknown as Record<string, unknown> | undefined;
	const report = await runSetupChecks(getDB(event), env);
	return { checks: report.checks, attention: report.attention, first: event.url.searchParams.get('first') === '1' };
};

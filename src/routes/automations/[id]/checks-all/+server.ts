import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { automationPresendChecks } from '$lib/server/automation-checks';

// #398 / #534: "Check all emails" / "Check links" in the editor (AutomationChecks.svelte) —
// the pre-send checks of every email step (and variant B of an A/B test), the same report
// `activate` uses. `check_links=1` adds the live link check. Session-gated (not in
// PUBLIC_PREFIXES); the guard below is defense-in-depth like the other routes here.
export const POST: RequestHandler = async (event) => {
	if (!(event.locals?.user ?? null)) throw error(401, 'Sign in first.');
	const automationId = Number(event.params.id);
	if (!Number.isInteger(automationId) || automationId <= 0) throw error(400, 'Invalid automation id.');
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		data = new FormData();
	}
	const db = getDB(event);
	const exists = await db.prepare('SELECT 1 AS ok FROM automations WHERE id = ?').bind(automationId).first();
	if (!exists) throw error(404, 'Automation not found.');
	const report = await automationPresendChecks(db, automationId, {
		media: event.platform?.env?.MEDIA,
		checkLinks: String(data.get('check_links') ?? '') === '1'
	});
	return json(report, { headers: { 'cache-control': 'no-store' } });
};

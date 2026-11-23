import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { readComposeBody } from '$lib/server/compose-body';
import { runPresendChecks } from '$lib/server/presend-checks';
import { summarize } from '$lib/presend-checks';

// #396: the email step drawer's pre-send checks — the same rules as Compose's panel (#311,
// POST /compose/checks), run on the drawer's current fields. Session-gated (not in
// PUBLIC_PREFIXES). A step has no list of its own (the trigger decides who reaches it), so
// the audience checks are left out. `check_links=1` adds the live link check.
export const POST: RequestHandler = async (event) => {
	if (!event.locals.user) throw error(401, 'Sign in first.');
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		throw error(400, 'Expected form data.');
	}
	const report = await runPresendChecks(
		getDB(event),
		{
			subject: String(data.get('subject') ?? ''),
			preheader: String(data.get('preheader') ?? '').trim(),
			body: readComposeBody(data),
			templateId: null,
			audience: { include: [], exclude: [] }
		},
		{ media: event.platform?.env?.MEDIA, checkLinks: String(data.get('check_links') ?? '') === '1' }
	);
	const checks = report.checks.filter((c) => c.category !== 'audience');
	return json(summarize(checks, report.linksChecked), { headers: { 'cache-control': 'no-store' } });
};

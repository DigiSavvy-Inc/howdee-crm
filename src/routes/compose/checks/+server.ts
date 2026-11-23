import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { readComposeBody } from '$lib/server/compose-body';
import { runPresendChecks } from '$lib/server/presend-checks';
import { audienceFromForm } from '$lib/server/campaign-audience';
import { parseTopicChoice } from '$lib/topics';

// #311: the compose panel's "Run checks" / "Check links". Session-gated (not in
// PUBLIC_PREFIXES); takes the compose form fields and returns the ChecksReport as JSON.
// `check_links=1` adds the live link check (≤ 30 links, 5 s each, SSRF-guarded).
export const POST: RequestHandler = async (event) => {
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
			templateId: Number(data.get('template_id')) || null,
			audience: audienceFromForm(data),
			topicId: parseTopicChoice(data.get('topic_id'))
		},
		{ media: event.platform?.env?.MEDIA, checkLinks: String(data.get('check_links') ?? '') === '1' }
	);
	return json(report, { headers: { 'cache-control': 'no-store' } });
};

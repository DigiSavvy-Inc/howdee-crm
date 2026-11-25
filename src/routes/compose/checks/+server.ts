import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { readComposeBody } from '$lib/server/compose-body';
import { runPresendChecks } from '$lib/server/presend-checks';
import { getPresendPolicy } from '$lib/server/presend-policy';
import { applyPolicy, canSendAnyway } from '$lib/presend-policy';
import { audienceFromForm } from '$lib/server/campaign-audience';
import { parseTopicChoice } from '$lib/topics';

// #311: the compose panel's checks. Session-gated (not in PUBLIC_PREFIXES); takes the compose
// form fields and returns the ChecksReport as JSON. `check_links=1` adds the live link check
// (≤ 60 links, 5 s each, SSRF-guarded); #479: the panel sends it on its own (debounced) and
// the report carries the policy's levels plus whether this user may "Send anyway". With a
// `schedule_at`, a failing live link is a warning (it's checked again at send time).
export const POST: RequestHandler = async (event) => {
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		throw error(400, 'Expected form data.');
	}
	const db = getDB(event);
	const policy = await getPresendPolicy(db);
	const report = applyPolicy(
		await runPresendChecks(
			db,
			{
				subject: String(data.get('subject') ?? ''),
				preheader: String(data.get('preheader') ?? '').trim(),
				body: readComposeBody(data),
				templateId: Number(data.get('template_id')) || null,
				audience: audienceFromForm(data),
				topicId: parseTopicChoice(data.get('topic_id'))
			},
			{
				media: event.platform?.env?.MEDIA,
				checkLinks: String(data.get('check_links') ?? '') === '1'
			}
		),
		policy,
		{ scheduling: !!String(data.get('schedule_at') ?? '').trim() }
	);
	return json(
		{ ...report, canOverride: canSendAnyway(policy, event.locals?.user?.role), enforcement: policy.enforcement },
		{ headers: { 'cache-control': 'no-store' } }
	);
};

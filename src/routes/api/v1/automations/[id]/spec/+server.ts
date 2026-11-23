import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError } from '$lib/server/api-v1';
import { replaceSpec } from '$lib/server/automation-write';
import { actorFor, automationRecord, baseUrl, defaultFrom, failureResponse, parseId, readBody } from '$lib/server/automations-api';
import type { AutomationSpec } from '$lib/automation-spec';

// PUT /api/v1/automations/:id/spec (#347, automations:draft or read_write) — replace the whole
// flow (name, trigger, reentry, steps; labels when given) of a DRAFT with no enrollments.
// Paused / active, or any enrollment → 409; a bad spec → 400 with `problems`.
export const PUT: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const parsed = await readBody(event);
	if ('response' in parsed) return parsed.response;

	const db = getDB(event);
	const r = await replaceSpec(db, id, parsed.body as unknown as AutomationSpec, actorFor(gate.key), {
		defaultFrom: await defaultFrom(event, db)
	});
	if (!r.ok) return failureResponse(r);
	const record = await automationRecord(db, id, await baseUrl(event));
	return json({ data: { ...record, step_ids: r.data.step_ids } });
};

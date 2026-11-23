import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { deleteStep, updateStep } from '$lib/server/automation-write';
import {
	API_WRITE_OPTS,
	STEP_FIELD_KEYS,
	actorFor,
	automationRecord,
	baseUrl,
	defaultFrom,
	failureResponse,
	parseId,
	readBody
} from '$lib/server/automations-api';
import type { StepFields } from '$lib/automation-spec';

// PATCH /api/v1/automations/:id/steps/:stepId (#347, automations:draft or read_write) —
// replace the step's configuration with the body's StepFields (not a patch: an omitted field
// takes its default; read `spec` first). Type and place can't change here (reorder moves).
export const PATCH: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	const stepId = parseId(event.params.stepId);
	if (!id || !stepId) return apiError(400, 'Invalid id.');
	const parsed = await readBody(event);
	if ('response' in parsed) return parsed.response;
	const unknown = Object.keys(parsed.body).filter((k) => !STEP_FIELD_KEYS.includes(k));
	if (unknown.length) return apiError(400, `Unknown or read-only key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);

	const db = getDB(event);
	const fields = parsed.body as StepFields;
	const step = await db
		.prepare('SELECT type FROM automation_steps WHERE id = ? AND automation_id = ?')
		.bind(stepId, id)
		.first<{ type: string }>();
	if (step?.type === 'email' && !fields.from_email) fields.from_email = await defaultFrom(event, db);
	const r = await updateStep(db, id, { step_id: stepId, fields }, actorFor(gate.key), API_WRITE_OPTS);
	if (!r.ok) return failureResponse(r);
	return apiData({ step_id: stepId, automation: await automationRecord(db, id, await baseUrl(event)) });
};

// DELETE /api/v1/automations/:id/steps/:stepId (#347, automations:draft or read_write) — a
// branch takes its whole subtree. → { deleted: step ids, automation }.
export const DELETE: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	const stepId = parseId(event.params.stepId);
	if (!id || !stepId) return apiError(400, 'Invalid id.');
	const db = getDB(event);
	const r = await deleteStep(db, id, { step_id: stepId }, actorFor(gate.key), API_WRITE_OPTS);
	if (!r.ok) return failureResponse(r);
	return apiData({ deleted: r.data.deleted, automation: await automationRecord(db, id, await baseUrl(event)) });
};

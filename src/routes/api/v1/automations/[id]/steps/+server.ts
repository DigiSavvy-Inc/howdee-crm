import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError } from '$lib/server/api-v1';
import { addStep } from '$lib/server/automation-write';
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
import { STEP_TYPES, type StepFields, type StepType } from '$lib/automation-spec';

const PLACE_KEYS = ['type', 'parent_step_id', 'branch_label', 'position'];

// POST /api/v1/automations/:id/steps (#347, automations:draft or read_write) — add one fully
// configured step: { type, parent_step_id?, branch_label?, position?, ...fields } (the
// StepFields of that type; step references are real ids — `step_id`). An email step without
// `from_email` gets the default From. 201 { step_id, automation }.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const parsed = await readBody(event);
	if ('response' in parsed) return parsed.response;
	const body = parsed.body;
	const type = String(body.type ?? '') as StepType;
	if (!(STEP_TYPES as readonly string[]).includes(type)) return apiError(400, `type must be one of: ${STEP_TYPES.join(', ')}.`);
	const unknown = Object.keys(body).filter((k) => !PLACE_KEYS.includes(k) && !STEP_FIELD_KEYS.includes(k));
	if (unknown.length) return apiError(400, `Unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
	if (body.branch_label !== undefined && body.branch_label !== null && body.branch_label !== 'yes' && body.branch_label !== 'no') {
		return apiError(400, 'branch_label must be yes or no.');
	}

	const db = getDB(event);
	const fields = Object.fromEntries(Object.entries(body).filter(([k]) => STEP_FIELD_KEYS.includes(k))) as StepFields;
	if (type === 'email' && !fields.from_email) fields.from_email = await defaultFrom(event, db);
	const r = await addStep(
		db,
		id,
		{
			type,
			parent_step_id: body.parent_step_id == null ? null : Number(body.parent_step_id),
			branch_label: (body.branch_label as 'yes' | 'no' | null | undefined) ?? null,
			position: body.position == null ? null : Number(body.position),
			fields: type === 'end' ? undefined : fields
		},
		actorFor(gate.key),
		API_WRITE_OPTS
	);
	if (!r.ok) return failureResponse(r);
	return json({ data: { step_id: r.data.step_id, automation: await automationRecord(db, id, await baseUrl(event)) } }, { status: 201 });
};

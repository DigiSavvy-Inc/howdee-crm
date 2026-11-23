import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError } from '$lib/server/api-v1';
import { duplicateAutomation } from '$lib/server/automation-write';
import { actorFor, automationRecord, baseUrl, failureResponse, parseId } from '$lib/server/automations-api';

// POST /api/v1/automations/:id/duplicate (#347, automations:draft or read_write) — copy any
// automation (steps, branches, labels) into a new DRAFT named "<name> (copy)". 201.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const db = getDB(event);
	const r = await duplicateAutomation(db, id, actorFor(gate.key));
	if (!r.ok) return failureResponse(r);
	return json({ data: await automationRecord(db, r.data.automation_id, await baseUrl(event)) }, { status: 201 });
};

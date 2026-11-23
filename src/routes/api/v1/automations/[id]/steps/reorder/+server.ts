import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { reorderSteps } from '$lib/server/automation-write';
import { API_WRITE_OPTS, actorFor, automationRecord, baseUrl, failureResponse, parseId, readBody } from '$lib/server/automations-api';

// POST /api/v1/automations/:id/steps/reorder (#347, automations:draft or read_write) —
// { order: step ids, parent_step_id?, branch_label? }: `order` must be exactly that lane's
// step ids (default lane: the trunk).
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const parsed = await readBody(event);
	if ('response' in parsed) return parsed.response;
	const { order, parent_step_id, branch_label } = parsed.body;
	if (!Array.isArray(order) || order.some((n) => !Number.isInteger(n))) return apiError(400, 'order must be a list of step ids.');
	if (branch_label !== undefined && branch_label !== null && branch_label !== 'yes' && branch_label !== 'no') {
		return apiError(400, 'branch_label must be yes or no.');
	}

	const db = getDB(event);
	const r = await reorderSteps(
		db,
		id,
		{
			order: order as number[],
			parent_step_id: parent_step_id == null ? null : Number(parent_step_id),
			branch_label: (branch_label as 'yes' | 'no' | null | undefined) ?? null
		},
		actorFor(gate.key),
		API_WRITE_OPTS
	);
	if (!r.ok) return failureResponse(r);
	return apiData(await automationRecord(db, id, await baseUrl(event)));
};

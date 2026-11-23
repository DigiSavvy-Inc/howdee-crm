import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { normalizeLabel } from '$lib/server/automation-labels';
import { listAutomations } from '$lib/server/automation-read';
import { createFromSpec } from '$lib/server/automation-write';
import { actorFor, automationRecord, baseUrl, defaultFrom, failureResponse, readBody } from '$lib/server/automations-api';
import type { AutomationSpec } from '$lib/automation-spec';

const VALID_STATUSES = new Set(['active', 'paused', 'draft']);

// GET /api/v1/automations — list automations (read scope), ordered by name (NOCASE).
// Optional ?status=active|paused|draft filter (invalid value -> 400). Optional ?label=
// (normalized exact NOCASE match against automation_labels, combinable with ?status=).
// Each row includes `labels: string[]` (#74).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const status = event.url.searchParams.get('status');
	if (status !== null && !VALID_STATUSES.has(status)) {
		return apiError(400, 'Invalid status filter. Use one of: active, paused, draft.');
	}
	const label = normalizeLabel(event.url.searchParams.get('label') ?? '');

	const db = getDB(event);
	const data = await listAutomations(db, { status, label });

	return apiData(data);
};

// POST /api/v1/automations (#347, automations:draft or read_write) — body = an AutomationSpec
// → a DRAFT (never active), 201 with the record + `editor_url` + `step_ids` (ref → id).
// 400 with every `validateSpec` problem ({ path, message }) on bad input.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const parsed = await readBody(event);
	if ('response' in parsed) return parsed.response;

	const db = getDB(event);
	const r = await createFromSpec(db, parsed.body as unknown as AutomationSpec, actorFor(gate.key), {
		defaultFrom: await defaultFrom(event, db)
	});
	if (!r.ok) return failureResponse(r);
	const record = await automationRecord(db, r.data.automation_id, await baseUrl(event));
	return json({ data: { ...record, step_ids: r.data.step_ids } }, { status: 201 });
};

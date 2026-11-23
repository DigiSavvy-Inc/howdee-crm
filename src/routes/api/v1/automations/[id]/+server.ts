import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { MAX_LABELS_PER_AUTOMATION, listLabels, normalizeLabel } from '$lib/server/automation-labels';
import {
	addLabel,
	deleteDraftAutomation,
	removeLabel,
	renameAutomation,
	setEntryRules,
	setReentry,
	setTrigger,
	type WriteFailure
} from '$lib/server/automation-write';
import { API_WRITE_OPTS, actorFor, automationRecord, baseUrl, failureResponse, parseId, readBody } from '$lib/server/automations-api';
import type { TriggerSpec } from '$lib/automation-spec';

const PATCH_KEYS = ['name', 'trigger', 'reentry', 'labels', 'entry_rules'];

// GET /api/v1/automations/:id (#347, read) — the automation, its whole flow as `spec`, the
// flat step list (real ids) and stats.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const record = await automationRecord(getDB(event), id, await baseUrl(event));
	if (!record) return apiError(404, 'Automation not found.');
	return apiData(record);
};

// PATCH /api/v1/automations/:id (#347, automations:draft or read_write) — key-present edits of
// name / trigger / reentry / labels (labels = the whole new set) on a draft or paused
// automation. `status` (or any other key) is 400; never activates, pauses or enrolls.
export const PATCH: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'automations:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const parsed = await readBody(event);
	if ('response' in parsed) return parsed.response;
	const body = parsed.body;
	const unknown = Object.keys(body).filter((k) => !PATCH_KEYS.includes(k));
	if (unknown.length) return apiError(400, `Unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Editable: ${PATCH_KEYS.join(', ')}.`);

	// Check what can be checked before anything is written.
	if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) return apiError(400, 'name must be a non-empty string.');
	if ('trigger' in body && (!body.trigger || typeof body.trigger !== 'object' || Array.isArray(body.trigger))) {
		return apiError(400, 'trigger must be an object.');
	}
	let labels: string[] | null = null;
	if ('labels' in body) {
		if (!Array.isArray(body.labels)) return apiError(400, 'labels must be a list of strings.');
		const clean = body.labels.map((l) => normalizeLabel(String(l ?? '')) ?? '');
		if (clean.some((l) => !l)) return apiError(400, 'Labels are 1–30 characters.');
		labels = [...new Map(clean.map((l) => [l.toLowerCase(), l])).values()];
		if (labels.length > MAX_LABELS_PER_AUTOMATION) return apiError(400, `An automation can have up to ${MAX_LABELS_PER_AUTOMATION} labels.`);
	}

	const db = getDB(event);
	const actor = actorFor(gate.key);
	const steps: (() => Promise<{ ok: true } | WriteFailure>)[] = [];
	if ('trigger' in body) steps.push(() => setTrigger(db, id, body.trigger as TriggerSpec, actor, API_WRITE_OPTS));
	if ('reentry' in body) steps.push(() => setReentry(db, id, { reentry: String(body.reentry) }, actor, API_WRITE_OPTS));
	// #412: entry conditions (null = none).
	if ('entry_rules' in body) steps.push(() => setEntryRules(db, id, { rules: body.entry_rules }, actor, API_WRITE_OPTS));
	if ('name' in body) steps.push(() => renameAutomation(db, id, { name: String(body.name) }, actor, API_WRITE_OPTS));
	if (labels) {
		const want = labels;
		steps.push(async () => {
			const have = await listLabels(db, id);
			const wantLower = new Set(want.map((l) => l.toLowerCase()));
			for (const l of have.filter((h) => !wantLower.has(h.toLowerCase()))) {
				const r = await removeLabel(db, id, { label: l }, actor, API_WRITE_OPTS);
				if (!r.ok) return r;
			}
			for (const l of want) {
				const r = await addLabel(db, id, { label: l }, actor, API_WRITE_OPTS);
				if (!r.ok) return r;
			}
			return { ok: true };
		});
	}
	for (const step of steps) {
		const r = await step();
		if (!r.ok) return failureResponse(r);
	}
	const record = await automationRecord(db, id, await baseUrl(event));
	if (!record) return apiError(404, 'Automation not found.');
	return apiData(record);
};

// DELETE /api/v1/automations/:id (#347, read_write only) — a draft with no enrollments and no
// campaign rows; anything else is 409.
export const DELETE: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid automation id.');
	const r = await deleteDraftAutomation(getDB(event), id, actorFor(gate.key));
	if (!r.ok) return failureResponse(r);
	return new Response(null, { status: 204 });
};

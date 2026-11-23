import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError } from '$lib/server/api-v1';
import {
	addToPipeline,
	moveCard,
	parseValue,
	removeFromPipeline,
	updateCard,
	type Actor,
	type CardOpts
} from '$lib/server/pipeline';
import { contactPipeline, resolveOwner, resolveStage } from '$lib/server/pipeline-api';

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

async function contactExists(db: D1Database, id: number): Promise<boolean> {
	return !!(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>());
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// GET /api/v1/contacts/:id/pipeline — the contact's card (or null) + its pipeline history,
// newest first, ≤200 rows (#207, read scope). 404 if the contact doesn't exist.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');
	const db = getDB(event);
	if (!(await contactExists(db, id))) return apiError(404, 'Contact not found.');
	return json({ data: await contactPipeline(db, id) });
};

// POST /api/v1/contacts/:id/pipeline — add or update the contact's card (#207, read_write).
// Body { stage_id | stage_name, value?, note?, owner? }. No card yet → added (stage required,
// 201); otherwise a stage moves it and value/note/owner are edited with key-present
// semantics (omitted = untouched, null clears) → 200. Stage/history writes go through
// $lib/server/pipeline with actor { kind: 'api', id: <api key id> }.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Invalid JSON body.');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'Body must be a JSON object.');
	const b = body as Record<string, unknown>;

	const db = getDB(event);
	if (!(await contactExists(db, id))) return apiError(404, 'Contact not found.');

	// Stage: stage_id wins over stage_name; a given-but-unknown stage is a 400.
	let stageId: number | undefined;
	const hasStageId = has(b, 'stage_id') && b.stage_id !== null && b.stage_id !== '';
	const hasStageName = has(b, 'stage_name') && b.stage_name !== null && b.stage_name !== '';
	if (hasStageId || hasStageName) {
		const stage = await resolveStage(db, hasStageId ? { id: b.stage_id } : { name: b.stage_name });
		if (!stage) return apiError(400, 'Unknown stage.');
		stageId = stage.id;
	}

	const opts: CardOpts = {};
	if (has(b, 'value')) {
		const v = parseValue(b.value);
		if (v === undefined) return apiError(400, 'Invalid value (a non-negative number, or null to clear).');
		opts.value = v;
	}
	if (has(b, 'note')) {
		if (b.note !== null && typeof b.note !== 'string') return apiError(400, 'Invalid note (a string, or null to clear).');
		opts.note = b.note ? b.note : null;
	}
	if (has(b, 'owner')) {
		const owner = await resolveOwner(db, b.owner);
		if (owner === undefined) return apiError(400, 'Unknown owner.');
		opts.owner = owner;
	}

	const actor: Actor = { kind: 'api', id: gate.key.id };
	const existing = await db.prepare('SELECT id FROM pipeline_cards WHERE contact_id = ?').bind(id).first<{ id: number }>();

	let created = false;
	if (!existing) {
		if (stageId === undefined) return apiError(400, 'stage_id or stage_name is required to add a contact to the pipeline.');
		const res = await addToPipeline(db, id, stageId, actor, opts);
		if (!res.ok) return apiError(400, res.error);
		created = res.created;
	} else {
		if (stageId !== undefined) {
			const moved = await moveCard(db, id, stageId, actor);
			if (!moved.ok) return apiError(400, moved.error);
		}
		const upd = await updateCard(db, id, opts);
		if (!upd.ok) return apiError(400, upd.error);
	}

	return json({ data: await contactPipeline(db, id) }, { status: created ? 201 : 200 });
};

// DELETE /api/v1/contacts/:id/pipeline — take the contact off the board (#207, read_write).
// { data: { removed } } — false when there was no card. History keeps a "removed" row.
export const DELETE: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');
	const db = getDB(event);
	if (!(await contactExists(db, id))) return apiError(404, 'Contact not found.');

	const res = await removeFromPipeline(db, id, { kind: 'api', id: gate.key.id });
	if (!res.ok) return apiError(400, res.error);
	return json({ data: { removed: res.removed } });
};

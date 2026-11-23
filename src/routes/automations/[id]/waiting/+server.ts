import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';

// #124: the step card's "N waiting here" pill opens a popover listing the contacts
// currently parked at that step. Session-gated by hooks.server.ts (not a PUBLIC_PREFIX) —
// the explicit guard below is defense-in-depth, same convention as /api/tour/dismiss.
type WaitingRow = {
	enrollment_id: number;
	contact_id: number;
	email: string;
	name: string | null;
	next_run_at: string | null;
	attempts: number;
	last_error: string | null;
};

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function parseIntParam(raw: string | null, def: number, min: number, max: number): number {
	if (raw === null || raw === '') return def;
	const n = Math.floor(Number(raw));
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, n));
}

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const automationId = Number(event.params.id);
	if (!Number.isInteger(automationId) || automationId <= 0) {
		return json({ error: 'invalid automation id' }, { status: 400 });
	}

	const rawStep = event.url.searchParams.get('step');
	const stepId = Number(rawStep);
	if (rawStep === null || rawStep === '' || !Number.isInteger(stepId) || stepId <= 0) {
		return json({ error: 'invalid step' }, { status: 400 });
	}

	const limit = parseIntParam(event.url.searchParams.get('limit'), DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
	const offset = parseIntParam(event.url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

	const db = getDB(event);

	const rows = await db
		.prepare(
			`SELECT e.id AS enrollment_id, e.contact_id, c.email,
			        COALESCE(NULLIF(c.name,''), TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,''))) AS name,
			        e.next_run_at, e.attempts, e.last_error
			 FROM automation_enrollments e JOIN contacts c ON c.id = e.contact_id
			 WHERE e.automation_id = ? AND e.current_step_id = ? AND e.status = 'active'
			 ORDER BY e.next_run_at IS NULL, e.next_run_at, e.id
			 LIMIT ? OFFSET ?`
		)
		.bind(automationId, stepId, limit, offset)
		.all<WaitingRow>();

	const totalRow = await db
		.prepare(
			`SELECT COUNT(*) AS total
			 FROM automation_enrollments e JOIN contacts c ON c.id = e.contact_id
			 WHERE e.automation_id = ? AND e.current_step_id = ? AND e.status = 'active'`
		)
		.bind(automationId, stepId)
		.first<{ total: number }>();

	return json({
		total: totalRow?.total ?? 0,
		rows: rows.results,
		limit,
		offset,
		now: new Date().toISOString()
	});
};

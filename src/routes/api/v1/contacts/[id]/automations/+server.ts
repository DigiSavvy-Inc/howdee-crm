import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

type ContactAutomationRow = {
	enrollment_id: number;
	automation_id: number;
	automation_name: string;
	status: string;
	current_step_id: number | null;
	next_run_at: string | null;
	enrolled_at: string;
	last_step_at: string | null;
	ended_at: string | null;
};

// GET /api/v1/contacts/:id/automations — one contact's enrollment passes (read scope),
// active passes first, then most-recently-enrolled first. 404 if the contact doesn't exist.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');

	const db = getDB(event);
	const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
	if (!contact) return apiError(404, 'Contact not found.');

	const rows = await db
		.prepare(
			`SELECT e.id AS enrollment_id, e.automation_id, a.name AS automation_name, e.status,
			        e.current_step_id, e.next_run_at, e.enrolled_at, e.last_step_at, e.ended_at
			 FROM automation_enrollments e
			 JOIN automations a ON a.id = e.automation_id
			 WHERE e.contact_id = ?
			 ORDER BY (e.status = 'active') DESC, e.enrolled_at DESC`
		)
		.bind(id)
		.all<ContactAutomationRow>();

	return apiData(rows.results);
};

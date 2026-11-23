import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { simulateContact } from '$lib/server/automation-simulate';

// #398 / #534: the editor's "Simulate a contact" card (SimulateContact.svelte) posts
// `contact_id` here. Read-only: simulateContact enrolls, sends and writes nothing. Session-gated
// (not in PUBLIC_PREFIXES); the guard below is defense-in-depth like the other routes here.
function positiveInt(raw: unknown): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export const POST: RequestHandler = async (event) => {
	if (!(event.locals?.user ?? null)) throw error(401, 'Sign in first.');
	const automationId = positiveInt(event.params.id);
	if (!automationId) throw error(400, 'Invalid automation id.');
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		throw error(400, 'Expected form data.');
	}
	const contactId = positiveInt(data.get('contact_id'));
	if (!contactId) throw error(400, 'Pick a contact.');
	const result = await simulateContact(getDB(event), automationId, contactId);
	if (!result) throw error(404, 'Automation or contact not found.');
	return json(result, { headers: { 'cache-control': 'no-store' } });
};

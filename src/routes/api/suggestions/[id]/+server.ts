import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { suggestionViewer } from '$lib/server/suggestions/visibility';
import { applyPanelAction } from '$lib/server/suggestions/panel';
import { parsePanelAction } from '$lib/suggestions-panel';

// Suggestions panel (#714): Done / Snooze / Dismiss one suggestion. Session-gated; body JSON
// { op: 'done' }, { op: 'snooze', days: 1 | 7 | 30 } or { op: 'dismiss', reason? }.
// A status change only — nothing is sent, scheduled, activated or enrolled.
export const POST: RequestHandler = async (event) => {
	if (!event.locals?.user) error(401, 'Sign in first');
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(400, 'Bad id');
	const db = getDB(event);
	const viewer = await suggestionViewer(db, event.locals.user);
	if (!viewer) error(403, 'Suggestions are off');
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		error(400, 'Send a JSON object.');
	}
	const input = parsePanelAction(body);
	if (typeof input === 'string') error(400, input);
	const res = await applyPanelAction(db, viewer, id, input);
	if (!res.ok) error(res.status, res.error);
	return json({ ok: true, status: res.status }, { headers: { 'cache-control': 'private, no-store' } });
};

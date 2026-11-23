import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { validateAdjust } from '$lib/scoring';
import { addScorePoints } from '$lib/server/scoring/contact';

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

// POST /api/v1/contacts/:id/scores/:scoreId/adjust (#467, read_write) — body
// `{ points, expires_days?, note? }` → one `manual` ledger row (note prefixed `api:<key id>`),
// recomputed at once. Returns the new value and band.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	const scoreId = parseId(event.params.scoreId);
	if (id === null) return apiError(400, 'Invalid contact id.');
	if (scoreId === null) return apiError(400, 'Invalid score id.');

	let body: Record<string, unknown>;
	try {
		const raw = await event.request.json();
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return apiError(400, 'Body must be a JSON object.');
		body = raw as Record<string, unknown>;
	} catch {
		return apiError(400, 'Body must be a JSON object.');
	}
	const n = validateAdjust({ points: body.points, expires_days: body.expires_days ?? '', note: body.note ?? '' });
	if (!n.ok) return apiError(400, n.error);

	const db = getDB(event);
	const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
	if (!contact) return apiError(404, 'Contact not found.');
	const score = await db.prepare('SELECT id, slug FROM score_defs WHERE id = ?').bind(scoreId).first<{ id: number; slug: string }>();
	if (!score) return apiError(404, 'Score not found.');

	const note = [`api:${gate.key.id}`, n.value.note].filter(Boolean).join(' ');
	const res = await addScorePoints(db, [id], scoreId, { points: n.value.points, expires_days: n.value.expires_days, note, source_type: 'manual' });
	if (!res.ok) return apiError(404, res.error);
	const row = await db
		.prepare('SELECT value, band FROM contact_scores WHERE contact_id = ? AND score_id = ?')
		.bind(id, scoreId)
		.first<{ value: number; band: string | null }>();
	return apiData({ contact_id: id, score_id: scoreId, slug: score.slug, points: n.value.points, value: row?.value ?? 0, band: row?.band ?? null });
};

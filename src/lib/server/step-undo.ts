// #396: "Undo" after deleting an automation step. The delete action reads the step's subtree
// (stepSnapshot) and parks it here under a one-time token; the Undo toast posts the token
// back and restoreStepSnapshot re-creates the steps. Kept server-side in app_state (no
// migration) so the browser never supplies raw step rows.

import type { StepSnapshot } from './automation-write';

/** How long a token can be redeemed. The toast shows for 10 s; this leaves slack for a slow request. */
export const UNDO_TTL_MINUTES = 10;
const PREFIX = 'step_undo:';

/** Store a snapshot; returns the token. Expired snapshots are pruned on the way. */
export async function saveStepUndo(db: D1Database, snap: StepSnapshot): Promise<string> {
	await db
		.prepare(`DELETE FROM app_state WHERE key LIKE ? AND updated_at < datetime('now', ?)`)
		.bind(`${PREFIX}%`, `-${UNDO_TTL_MINUTES} minutes`)
		.run();
	const token = crypto.randomUUID();
	await db
		.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
		.bind(`${PREFIX}${snap.automation_id}:${token}`, JSON.stringify(snap))
		.run();
	return token;
}

/** Redeem a token once (deleted on read); null when unknown, expired or for another automation. */
export async function takeStepUndo(db: D1Database, automationId: number, token: string): Promise<StepSnapshot | null> {
	if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
	const key = `${PREFIX}${automationId}:${token}`;
	const row = await db
		.prepare(`DELETE FROM app_state WHERE key = ? AND updated_at >= datetime('now', ?) RETURNING value`)
		.bind(key, `-${UNDO_TTL_MINUTES} minutes`)
		.first<{ value: string }>();
	await db.prepare('DELETE FROM app_state WHERE key = ?').bind(key).run();
	if (!row) return null;
	try {
		const snap = JSON.parse(row.value) as StepSnapshot;
		return snap.automation_id === automationId ? snap : null;
	} catch {
		return null;
	}
}

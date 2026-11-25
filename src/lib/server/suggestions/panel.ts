// Suggestions panel (#714) — the reads and the one write behind SuggestionsPanel.svelte.
//
//   - `panelSummary` (root layout load): the count of open suggestions in this user's panel
//     (team rows + rows assigned to them) and the newest change, or null when the feature is
//     off / not open to them. Same visibility as every other reader (visibility.ts).
//   - `panelSuggestions` (GET /api/suggestions): the cards, each with a link for its subject.
//   - `applyPanelAction` (POST /api/suggestions/<id>): Done, Snooze or Dismiss — a status change
//     only (`closed_by = 'user'`). Nothing here sends, schedules, activates or enrolls
//     (tests/suggestions-714.test.ts walks the imports).

import type { SubjectType } from '$lib/suggestions';
import type { PanelActionInput } from '$lib/suggestions-panel';
import { sqlStamp } from './rules';
import { listVisibleSuggestions, rowAllowed, suggestionViewer, visibleSuggestion, type SuggestionView, type SuggestionViewer, type ViewerUser } from './visibility';

/** The panel never lists more than this many cards. */
export const PANEL_LIMIT = 100;

export type PanelSummary = { count: number; latest: string | null };

export type PanelItem = SuggestionView & { subject_url: string | null };

export async function panelSummary(db: D1Database, user: ViewerUser | null | undefined): Promise<PanelSummary | null> {
	const viewer = await suggestionViewer(db, user);
	if (!viewer) return null;
	const rows = await listVisibleSuggestions(db, viewer, { panel: true, limit: PANEL_LIMIT });
	let latest: string | null = null;
	for (const r of rows) if (!latest || r.updated_at > latest) latest = r.updated_at;
	return { count: rows.length, latest };
}

function subjectPath(type: SubjectType, id: number, dealContacts: Map<number, number>): string | null {
	if (type === 'contact') return `/contacts/${id}`;
	if (type === 'company') return `/companies/${id}`;
	if (type === 'group') return `/lists/${id}`;
	const cid = dealContacts.get(id);
	return cid ? `/contacts/${cid}#pipeline` : null;
}

export async function panelSuggestions(db: D1Database, viewer: SuggestionViewer): Promise<PanelItem[]> {
	const rows = await listVisibleSuggestions(db, viewer, { panel: true, limit: PANEL_LIMIT });
	const dealIds = rows.filter((r) => r.subject_type === 'deal').map((r) => r.subject_id);
	const dealContacts = new Map<number, number>();
	if (dealIds.length) {
		const res = await db
			.prepare('SELECT id, contact_id FROM pipeline_cards WHERE id IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(dealIds))
			.all<{ id: number; contact_id: number }>();
		for (const r of res.results) dealContacts.set(r.id, r.contact_id);
	}
	return rows.map((r) => ({ ...r, subject_url: subjectPath(r.subject_type, r.subject_id, dealContacts) }));
}

export type PanelActionResult = { ok: true; status: 'done' | 'dismissed' | 'snoozed' } | { ok: false; status: 404 | 409; error: string };

/**
 * Done / Snooze / Dismiss one suggestion this viewer sees in their panel. Only an open (or
 * snoozed) row changes; Done and Dismiss start the cooldown (`closed_by = 'user'`).
 */
export async function applyPanelAction(
	db: D1Database,
	viewer: SuggestionViewer,
	id: number,
	input: PanelActionInput,
	now: Date = new Date()
): Promise<PanelActionResult> {
	const view = await visibleSuggestion(db, viewer, id);
	if (!view || !rowAllowed(viewer, view, { panel: true }) || !viewer.user) return { ok: false, status: 404, error: 'Suggestion not found.' };
	const nowSql = sqlStamp(now);
	let res: D1Result;
	let status: 'done' | 'dismissed' | 'snoozed';
	if (input.op === 'snooze') {
		status = 'snoozed';
		const until = sqlStamp(now, -(input.days ?? 1) * 86_400_000);
		res = await db
			.prepare(
				`UPDATE suggestions SET status = 'snoozed', snooze_until = ?, updated_at = ?
				  WHERE id = ? AND status IN ('open', 'snoozed')`
			)
			.bind(until, nowSql, id)
			.run();
	} else {
		status = input.op === 'done' ? 'done' : 'dismissed';
		res = await db
			.prepare(
				`UPDATE suggestions SET status = ?, closed_by = 'user', closed_by_user_id = ?, closed_at = ?,
				        dismiss_reason = ?, snooze_until = NULL, updated_at = ?
				  WHERE id = ? AND status IN ('open', 'snoozed')`
			)
			.bind(status, viewer.user.id, nowSql, input.op === 'dismiss' && input.reason ? input.reason : null, nowSql, id)
			.run();
	}
	if (!(res.meta?.changes ?? 0)) return { ok: false, status: 409, error: 'This suggestion was already closed.' };
	return { ok: true, status };
}

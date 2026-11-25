// Who sees which suggestion (#712). Shared by the panel (#714), the API and the assistant tool
// (#716), so every reader applies the same rules:
//
//   - the feature is on, and Who sees suggestions lets this user in (admins only by default);
//   - the suggestion's kind and rule are on (a switched-off one is hidden, not deleted);
//   - its subject still exists and is visible: an active contact (#705: never unsubscribed or
//     archived), a deal whose contact is active, a live (not archived) list / tag / segment, a
//     company;
//   - in the panel, only team rows (no assignee) and rows assigned to this user;
//   - evidence marked `billing` only with `canSeeBilling`. Billing is never in title / why / draft.

import {
	RULE_KEYS,
	type EvidenceItem,
	type RuleKey,
	type SubjectType,
	type SuggestionAction,
	type SuggestionKind,
	type SuggestionsConfig,
	type SuggestionStatus
} from '$lib/suggestions';
import { activeContactSql } from '../active-audience';
import { canSeeBilling } from '../integrations/zoho';
import { getSuggestionsConfig } from './config';
import { suggestionsPanelOn } from './panel-pref';

export type ViewerUser = { id: number; role: string };

export type SuggestionViewer = {
	user: ViewerUser | null; // null = an API key (reads as a member, #716)
	admin: boolean;
	billing: boolean;
	cfg: SuggestionsConfig;
};

export type SuggestionRow = {
	id: number;
	kind: SuggestionKind;
	subject_type: SubjectType;
	subject_id: number;
	subject_label: string | null;
	rule: RuleKey;
	evidence: string;
	title: string;
	why: string;
	action: string;
	draft_opening: string | null;
	assigned_user_id: number | null;
	status: SuggestionStatus;
	snooze_until: string | null;
	dismiss_reason: string | null;
	since_at: string | null;
	model: string | null;
	created_at: string;
	updated_at: string;
};

export type SuggestionView = Omit<SuggestionRow, 'evidence' | 'action'> & {
	evidence: Omit<EvidenceItem, 'ref' | 'billing'>[];
	action: SuggestionAction | null;
};

/**
 * The viewer for a signed-in user, or null when the feature is off or not open to them.
 * By default this is the panel's viewer (#715): a user who turned off Account → Show the
 * suggestions panel gets null (no panel, no count). The assistant tool passes `{ panel: false }`
 * so it can still read suggestions for them (docs/suggestions.md).
 */
export async function suggestionViewer(
	db: D1Database,
	user: ViewerUser | null | undefined,
	opts: { panel?: boolean } = {}
): Promise<SuggestionViewer | null> {
	const cfg = await getSuggestionsConfig(db);
	if (!cfg.enabled || !user) return null;
	const admin = user.role === 'admin';
	if (cfg.audience === 'admins' && !admin) return null;
	if (opts.panel !== false && !(await suggestionsPanelOn(db, user.id))) return null;
	return { user, admin, billing: await canSeeBilling(db, user), cfg };
}

/** An API key's viewer: reads as a member (never billing). Null when off or admins-only. */
export async function apiSuggestionViewer(db: D1Database): Promise<SuggestionViewer | null> {
	const cfg = await getSuggestionsConfig(db);
	if (!cfg.enabled || cfg.audience === 'admins') return null;
	return { user: null, admin: false, billing: false, cfg };
}

/** Kind + rule on, and (panel) team or mine. Subject visibility is checked separately. */
export function rowAllowed(viewer: SuggestionViewer, row: Pick<SuggestionRow, 'kind' | 'rule' | 'assigned_user_id'>, opts: { panel?: boolean } = {}): boolean {
	if (!viewer.cfg.kinds[row.kind]) return false;
	if (!RULE_KEYS.includes(row.rule) || !viewer.cfg.rules[row.rule]?.on) return false;
	if (opts.panel && row.assigned_user_id != null && row.assigned_user_id !== viewer.user?.id) return false;
	return true;
}

const SUBJECT_SQL: Record<SubjectType, string> = {
	contact: `SELECT c.id FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?)) AND ${activeContactSql('c')}`,
	deal: `SELECT pc.id FROM pipeline_cards pc JOIN contacts c ON c.id = pc.contact_id
	        WHERE pc.id IN (SELECT value FROM json_each(?)) AND ${activeContactSql('c')}`,
	group: `SELECT id FROM lists WHERE id IN (SELECT value FROM json_each(?)) AND kind IN ('list', 'tag', 'segment') AND archived_at IS NULL`,
	company: `SELECT id FROM companies WHERE id IN (SELECT value FROM json_each(?))`
};

/** Keys (`type:id`) of the subjects among `rows` that still exist and are visible. */
export async function visibleSubjects(db: D1Database, rows: Pick<SuggestionRow, 'subject_type' | 'subject_id'>[]): Promise<Set<string>> {
	const out = new Set<string>();
	const byType = new Map<SubjectType, number[]>();
	for (const r of rows) byType.set(r.subject_type, [...(byType.get(r.subject_type) ?? []), r.subject_id]);
	for (const [type, ids] of byType) {
		const sql = SUBJECT_SQL[type];
		if (!sql) continue;
		const uniq = [...new Set(ids)];
		for (let i = 0; i < uniq.length; i += 500) {
			const res = await db.prepare(sql).bind(JSON.stringify(uniq.slice(i, i + 500))).all<{ id: number }>();
			for (const r of res.results) out.add(`${type}:${r.id}`);
		}
	}
	return out;
}

function parseJson<T>(s: string | null | undefined, d: T): T {
	try {
		return s ? (JSON.parse(s) as T) : d;
	} catch {
		return d;
	}
}

/** The row as a viewer gets it: billing evidence dropped unless allowed, hash refs stripped. */
export function viewOf(row: SuggestionRow, viewer: SuggestionViewer): SuggestionView {
	const evidence = parseJson<EvidenceItem[]>(row.evidence, [])
		.filter((e) => e && (!e.billing || viewer.billing))
		.map(({ ref: _ref, billing: _billing, ...e }) => e);
	const action = parseJson<SuggestionAction | null>(row.action, null);
	return { ...row, evidence, action: action && typeof action === 'object' && action.url ? action : null };
}

export type ListOpts = {
	status?: SuggestionStatus | 'all';
	kind?: SuggestionKind;
	/** Only rows assigned to the viewer. */
	mine?: boolean;
	/** The panel: team rows + the viewer's own. */
	panel?: boolean;
	/** `none` = team rows only. */
	assigned?: number | 'none';
	limit?: number;
	offset?: number;
};

/** Visible suggestions, in the no-AI order: rule order (follow-ups first), oldest wait first. */
export async function listVisibleSuggestions(db: D1Database, viewer: SuggestionViewer, opts: ListOpts = {}): Promise<SuggestionView[]> {
	const where: string[] = [];
	const binds: unknown[] = [];
	const status = opts.status ?? 'open';
	if (status !== 'all') {
		where.push('status = ?');
		binds.push(status);
	}
	if (opts.kind) {
		where.push('kind = ?');
		binds.push(opts.kind);
	}
	if (opts.mine) {
		if (!viewer.user) return [];
		where.push('assigned_user_id = ?');
		binds.push(viewer.user.id);
	} else if (opts.assigned === 'none') {
		where.push('assigned_user_id IS NULL');
	} else if (typeof opts.assigned === 'number') {
		where.push('assigned_user_id = ?');
		binds.push(opts.assigned);
	}
	const rows = (
		await db
			.prepare(
				`SELECT id, kind, subject_type, subject_id, subject_label, rule, evidence, title, why, action, draft_opening,
				        assigned_user_id, status, snooze_until, dismiss_reason, since_at, model, created_at, updated_at
				   FROM suggestions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
			)
			.bind(...binds)
			.all<SuggestionRow>()
	).results.filter((r) => rowAllowed(viewer, r, { panel: opts.panel }));
	const subjects = await visibleSubjects(db, rows);
	const ms = (s: string | null) => (s ? Date.parse(s.replace(' ', 'T') + (/[zZ]$/.test(s) ? '' : 'Z')) || 0 : 0);
	const visible = rows
		.filter((r) => subjects.has(`${r.subject_type}:${r.subject_id}`))
		.sort((a, b) => RULE_KEYS.indexOf(a.rule) - RULE_KEYS.indexOf(b.rule) || ms(a.since_at) - ms(b.since_at) || a.id - b.id);
	const offset = Math.max(0, opts.offset ?? 0);
	const limit = Math.max(0, opts.limit ?? 50);
	return visible.slice(offset, offset + limit).map((r) => viewOf(r, viewer));
}

/** One suggestion if this viewer may see it (any status), else null. */
export async function visibleSuggestion(db: D1Database, viewer: SuggestionViewer, id: number): Promise<SuggestionView | null> {
	const row = await db
		.prepare(
			`SELECT id, kind, subject_type, subject_id, subject_label, rule, evidence, title, why, action, draft_opening,
			        assigned_user_id, status, snooze_until, dismiss_reason, since_at, model, created_at, updated_at
			   FROM suggestions WHERE id = ?`
		)
		.bind(id)
		.first<SuggestionRow>();
	if (!row || !rowAllowed(viewer, row)) return null;
	if (!(await visibleSubjects(db, [row])).has(`${row.subject_type}:${row.subject_id}`)) return null;
	return viewOf(row, viewer);
}

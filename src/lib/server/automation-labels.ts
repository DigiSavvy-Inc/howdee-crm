// #74: free-form labels on automations — lightweight organisation (not taxonomy), so the
// operator can see at a glance what an automation does and filter the list by them.
// Deliberately a dedicated `automation_labels` table, NOT `lists(kind='tag')` — those are
// contact tags and mean something different (FEATURE_CHECKLIST §4's `kind` leak doesn't
// apply here since this never touches `lists`).

import { containsSql } from './sql-match';

export const MAX_LABELS_PER_AUTOMATION = 10;

/** Trim, collapse internal whitespace to one space, and enforce a 1–30 char length.
 *  Returns null for anything that doesn't normalize to a usable label. */
export function normalizeLabel(raw: string): string | null {
	const normalized = raw.trim().replace(/\s+/g, ' ');
	if (normalized.length < 1 || normalized.length > 30) return null;
	return normalized;
}

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** Labels on one automation, NOCASE-ordered. */
export async function listLabels(db: D1Database, automationId: number): Promise<string[]> {
	const rows = await db
		.prepare('SELECT label FROM automation_labels WHERE automation_id = ? ORDER BY label')
		.bind(automationId)
		.all<{ label: string }>();
	return rows.results.map((r) => r.label);
}

export type AddLabelResult = { ok: true; label: string } | { ok: false; error: string };

/** Add a label to an automation. Invalid input and the per-automation cap are rejected;
 *  a case-insensitive duplicate is a no-op success (INSERT OR IGNORE — the table's
 *  PRIMARY KEY (automation_id, label COLLATE NOCASE) already dedupes). */
export async function addLabel(db: D1Database, automationId: number, raw: string): Promise<AddLabelResult> {
	const label = normalizeLabel(raw);
	if (!label) return { ok: false, error: 'Tags are 1–30 characters.' };

	const existing = await db
		.prepare('SELECT 1 FROM automation_labels WHERE automation_id = ? AND label = ?')
		.bind(automationId, label)
		.first();
	if (!existing) {
		const countRow = await db
			.prepare('SELECT COUNT(*) AS n FROM automation_labels WHERE automation_id = ?')
			.bind(automationId)
			.first<{ n: number }>();
		if ((countRow?.n ?? 0) >= MAX_LABELS_PER_AUTOMATION) {
			return { ok: false, error: `An automation can have up to ${MAX_LABELS_PER_AUTOMATION} tags.` };
		}
	}

	await db
		.prepare('INSERT OR IGNORE INTO automation_labels (automation_id, label) VALUES (?, ?)')
		.bind(automationId, label)
		.run();
	return { ok: true, label };
}

export async function removeLabel(db: D1Database, automationId: number, label: string): Promise<void> {
	await db
		.prepare('DELETE FROM automation_labels WHERE automation_id = ? AND label = ?')
		.bind(automationId, label)
		.run();
}

/** Copy every label from one automation to another (used by `duplicate`). */
export async function copyLabels(db: D1Database, fromId: number, toId: number): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO automation_labels (automation_id, label)
			 SELECT ?, label FROM automation_labels WHERE automation_id = ?`
		)
		.bind(toId, fromId)
		.run();
}

export type LabelCount = { label: string; count: number };

/** Every distinct label in use, with how many automations carry it — for the list page's
 *  filter chips and the detail page's add-label datalist. Ordered by popularity. */
export async function allLabelsWithCounts(db: D1Database): Promise<LabelCount[]> {
	const rows = await db
		.prepare(
			`SELECT label, COUNT(*) AS count FROM automation_labels GROUP BY label ORDER BY count DESC, label`
		)
		.all<LabelCount>();
	return rows.results;
}

/** Labels for a batch of automation ids, chunked at 90 per `IN (...)` (D1 caps a query at
 *  100 bound vars). Automations with no labels are simply absent from the map. */
export async function labelsByAutomation(db: D1Database, ids: number[]): Promise<Map<number, string[]>> {
	const map = new Map<number, string[]>();
	const unique = [...new Set(ids)];
	for (const part of chunk(unique, 90)) {
		if (part.length === 0) continue;
		const ph = part.map(() => '?').join(', ');
		const rows = await db
			.prepare(
				`SELECT automation_id, label FROM automation_labels WHERE automation_id IN (${ph}) ORDER BY label`
			)
			.bind(...part)
			.all<{ automation_id: number; label: string }>();
		for (const r of rows.results) {
			const list = map.get(r.automation_id) ?? [];
			list.push(r.label);
			map.set(r.automation_id, list);
		}
	}
	return map;
}

// ---- List page query (testable without a RequestEvent) -------------------------------------

export type AutomationsListFilter = { label: string | null; status: string | null; /** #477: name or tag contains (the search palette's See all). */ q?: string | null };

export type AutomationListRow = {
	id: number;
	name: string;
	status: string;
	trigger_type: string;
	created_at: string;
	trigger_list_name: string | null;
	trigger_metric: string | null; // #170: company_metric trigger
	trigger_direction: string | null;
	trigger_threshold: number | null;
	trigger_path_op: string | null; // #154: site_visit trigger
	trigger_path: string | null;
	trigger_cooldown_hours: number | null;
	trigger_site_name: string | null;
	trigger_stage_name: string | null; // #207: pipeline_stage_entered
	// #396: the raw trigger ids + re-entry, for the shared triggerSummary helper.
	trigger_list_id: number | null;
	trigger_site_id: number | null;
	trigger_stage_id: number | null;
	trigger_config: string | null; // #412: email_opened / email_clicked
	reentry: string;
	step_count: number;
	active_count: number;
	completed_count: number;
	failed_count: number; // #396
	/** #396: newest enrolment / step / end time across its passes (UTC), null = never ran. */
	last_activity_at: string | null;
	campaign_count: number; // > 0 = has sent; delete refuses it (#164)
};

export type AutomationsListResult = {
	automations: AutomationListRow[];
	total: number;
	matched: number;
	/** #200: per-status counts with the label filter applied but not the status filter. */
	statusCounts: StatusCounts;
};

export type StatusCounts = { all: number; active: number; paused: number; draft: number };

export const AUTOMATION_STATUSES = new Set(['active', 'paused', 'draft']);

/** #200: the `/automations` status filter persists in this cookie (`all|active|paused|draft`). */
export const STATUS_COOKIE = 'automations_status';

/** #200: which status filter applies, and what (if anything) to write to the cookie.
 *  An explicit valid `?status=` wins and is written (`all` clears the filter and writes
 *  `all`); otherwise a valid cookie value applies without rewriting. Anything invalid is
 *  ignored. */
export function resolveStatusFilter(
	param: string | null,
	cookie: string | null | undefined
): { status: string | null; write: string | null } {
	if (param === 'all') return { status: null, write: 'all' };
	if (param && AUTOMATION_STATUSES.has(param)) return { status: param, write: param };
	if (cookie && AUTOMATION_STATUSES.has(cookie)) return { status: cookie, write: null };
	return { status: null, write: null };
}

/** The `/automations` list query with optional status + label filters — pulled out of the
 *  page's `load` so it's directly testable. `filter.label` must already be normalized
 *  (case-insensitive exact match against `automation_labels.label`). */
export async function automationsListQuery(
	db: D1Database,
	filter: AutomationsListFilter
): Promise<AutomationsListResult> {
	const conditions: string[] = [];
	const binds: unknown[] = [];
	if (filter.label) {
		conditions.push('EXISTS (SELECT 1 FROM automation_labels al WHERE al.automation_id = a.id AND al.label = ?)');
		binds.push(filter.label);
	}
	if (filter.q) {
		// #485: instr, not LIKE (D1 caps LIKE patterns at 50 bytes).
		conditions.push(`(${containsSql('a.name')} OR EXISTS (SELECT 1 FROM automation_labels al WHERE al.automation_id = a.id AND ${containsSql('al.label')}))`);
		binds.push(filter.q, filter.q);
	}
	// Status counts see the label (and #477 search) filter only — "how many of each within this label".
	const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	const countRows = await db
		.prepare(`SELECT a.status, COUNT(*) AS n FROM automations a ${countWhere} GROUP BY a.status`)
		.bind(...binds)
		.all<{ status: string; n: number }>();
	const statusCounts: StatusCounts = { all: 0, active: 0, paused: 0, draft: 0 };
	for (const r of countRows.results) {
		statusCounts.all += r.n;
		if (AUTOMATION_STATUSES.has(r.status)) statusCounts[r.status as 'active' | 'paused' | 'draft'] = r.n;
	}

	if (filter.status) {
		conditions.push('a.status = ?');
		binds.push(filter.status);
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

	const rows = await db
		.prepare(
			`SELECT a.id, a.name, a.status, a.trigger_type, a.created_at,
			        l.name AS trigger_list_name, a.trigger_metric, a.trigger_direction, a.trigger_threshold,
			        a.trigger_path_op, a.trigger_path, a.trigger_cooldown_hours,
			        a.trigger_list_id, a.trigger_site_id, a.trigger_stage_id, a.trigger_config, a.reentry,
			        (SELECT ts.name FROM tracking_sites ts WHERE ts.id = a.trigger_site_id) AS trigger_site_name,
			        (SELECT ps.name FROM pipeline_stages ps WHERE ps.id = a.trigger_stage_id) AS trigger_stage_name,
			        (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id) AS step_count,
			        (SELECT COUNT(*) FROM automation_enrollments e WHERE e.automation_id = a.id AND e.status = 'active') AS active_count,
			        (SELECT COUNT(*) FROM automation_enrollments e WHERE e.automation_id = a.id AND e.status = 'completed') AS completed_count,
			        (SELECT COUNT(*) FROM automation_enrollments e WHERE e.automation_id = a.id AND e.status = 'failed') AS failed_count,
			        (SELECT MAX(MAX(e.enrolled_at, COALESCE(e.last_step_at, ''), COALESCE(e.ended_at, '')))
			           FROM automation_enrollments e WHERE e.automation_id = a.id) AS last_activity_at,
			        (SELECT COUNT(*) FROM campaigns c WHERE c.automation_id = a.id) AS campaign_count
			 FROM automations a
			 LEFT JOIN lists l ON l.id = a.trigger_list_id
			 ${where}
			 ORDER BY a.created_at DESC, a.id DESC`
		)
		.bind(...binds)
		.all<AutomationListRow>();

	const totalRow = await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>();

	return {
		automations: rows.results,
		total: totalRow?.n ?? 0,
		matched: rows.results.length,
		statusCounts
	};
}

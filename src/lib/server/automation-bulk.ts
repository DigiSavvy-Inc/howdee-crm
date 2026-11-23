// #164: bulk management on the /automations list — status, labels, delete. The single
// actions on /automations/[id] share `activationProblems` (#395) and `deleteAutomations` so both
// paths apply the same rules. Every statement binds ≤ 40 ids (D1 caps a query at 100 vars).

import { MAX_LABELS_PER_AUTOMATION, normalizeLabel } from './automation-labels';
import { STEP_COLS } from './automation-tree';
import { storedStepProblem, storedTriggerProblem, type StoredStep } from './automation-write';
import { numberedStepTitle, stepNumbers, stepShortTitle } from '$lib/automation-action-labels';
import { logStatusChanges } from './automation-flow';

export const BULK_CHUNK = 40;

export type Skipped = { id: number; name: string; reason: string };
export type BulkResult = { changed: number; skipped: Skipped[] };

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** Positive integer ids, deduped, in input order. */
export function cleanIds(ids: unknown[]): number[] {
	const out = new Set<number>();
	for (const v of ids) {
		const n = Number(v);
		if (Number.isInteger(n) && n > 0) out.add(n);
	}
	return [...out];
}

/** Why an automation can't be activated, or null when it can — the quick shape check
 *  (`activationProblems` below runs it first, then the full one). */
export function activationProblem(
	a: { trigger_type: string; trigger_list_id: number | null },
	stepCount: number
): 'no steps' | 'no trigger list' | null {
	if (stepCount === 0) return 'no steps';
	if (a.trigger_type === 'list_added' && !a.trigger_list_id) return 'no trigger list';
	return null;
}

/** One reason an automation can't go live. `step_id` = the step to open (null = the
 *  automation itself: no steps, the trigger). `code` keeps #164's short bulk reasons. */
export type ActivationProblem = { step_id: number | null; message: string; code?: 'no steps' | 'no trigger list' };

/**
 * #395: everything that must be true before an automation is activated — the single
 * `activate` action and `bulkSetStatus` both go through this. Steps: every one finished
 * (`ready`) and complete as the drawer's save would require (email subject / body /
 * approved From; tag name; a configured condition or rule set; action / go-to targets that
 * exist and aren't itself; pipeline stages). Trigger: configured, and its list / segment /
 * tag / company, stage or site still exists. Problems come in canvas order (step ids, so
 * the editor can link to each).
 */
export async function activationProblems(db: D1Database, automationId: number): Promise<ActivationProblem[]> {
	const a = await db
		.prepare(
			`SELECT trigger_type, trigger_list_id, trigger_metric, trigger_direction, trigger_threshold, trigger_site_id,
			        trigger_path_op, trigger_path, trigger_cooldown_hours, trigger_stage_id, trigger_config
			 FROM automations WHERE id = ?`
		)
		.bind(automationId)
		.first<Parameters<typeof storedTriggerProblem>[1]>();
	if (!a) return [{ step_id: null, message: 'Automation not found.' }];
	const steps = (
		await db
			.prepare(`SELECT ${STEP_COLS}, tag_on_open, tag_on_click FROM automation_steps WHERE automation_id = ?`)
			.bind(automationId)
			.all<StoredStep>()
	).results;

	const problems: ActivationProblem[] = [];
	const shape = activationProblem(a, steps.length);
	if (shape === 'no steps') return [{ step_id: null, code: shape, message: 'Add at least one step before activating.' }];
	if (shape === 'no trigger list') {
		problems.push({ step_id: null, code: shape, message: 'Set a trigger list before activating, or switch the trigger to Manual.' });
	} else {
		const t = await storedTriggerProblem(db, a);
		if (t) problems.push({ step_id: null, message: `Trigger: ${t}` });
	}

	const numbers = stepNumbers(steps);
	const ordered = [...steps].sort((x, y) => (numbers.get(x.id) ?? 0) - (numbers.get(y.id) ?? 0));
	for (const s of ordered) {
		const p = await storedStepProblem(db, automationId, s);
		if (p) problems.push({ step_id: s.id, message: `${numberedStepTitle(numbers.get(s.id), stepShortTitle(s))}: ${p}` });
	}
	return problems;
}

/** Contacts mid-flow whose next step is already due — they go out within minutes of activation. */
export async function overdueEnrollments(db: D1Database, automationId: number): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM automation_enrollments
			 WHERE automation_id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= datetime('now')`
		)
		.bind(automationId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

type BulkRow = {
	id: number;
	name: string;
	status: string;
	trigger_type: string;
	trigger_list_id: number | null;
	step_count: number;
	campaign_count: number;
	label_count: number;
	has_label: number;
};

/** Existing automations among `ids` (unknown ids simply don't come back), with the
 *  counts every bulk action needs. `label` feeds `has_label` (pass null if unused). */
async function loadRows(db: D1Database, ids: number[], label: string | null = null): Promise<BulkRow[]> {
	const rows: BulkRow[] = [];
	for (const part of chunk(ids, BULK_CHUNK)) {
		const ph = part.map(() => '?').join(', ');
		const res = await db
			.prepare(
				`SELECT a.id, a.name, a.status, a.trigger_type, a.trigger_list_id,
				        (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id) AS step_count,
				        (SELECT COUNT(*) FROM campaigns c WHERE c.automation_id = a.id) AS campaign_count,
				        (SELECT COUNT(*) FROM automation_labels al WHERE al.automation_id = a.id) AS label_count,
				        EXISTS (SELECT 1 FROM automation_labels al WHERE al.automation_id = a.id AND al.label = ?) AS has_label
				 FROM automations a WHERE a.id IN (${ph})`
			)
			.bind(label ?? '', ...part)
			.all<BulkRow>();
		rows.push(...res.results);
	}
	return rows;
}

/** Activate or pause many automations. Activation skips (never fails) an automation that
 *  `activationProblems` rejects; one already in the target status is left alone. */
export async function bulkSetStatus(
	db: D1Database,
	rawIds: unknown[],
	status: 'active' | 'paused',
	opts: { userId?: number | null; reason?: string | null } = {}
): Promise<BulkResult> {
	const rows = await loadRows(db, cleanIds(rawIds));
	const fromStatus = new Map(rows.map((r) => [r.id, r.status]));
	const skipped: Skipped[] = [];
	const toChange: number[] = [];
	for (const r of rows) {
		if (r.status === status) continue;
		if (status === 'active') {
			const problems = await activationProblems(db, r.id);
			if (problems.length) {
				const first = problems[0];
				const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : '';
				skipped.push({ id: r.id, name: r.name, reason: `${first.code ?? first.message}${more}` });
				continue;
			}
		}
		toChange.push(r.id);
	}
	let changed = 0;
	for (const part of chunk(toChange, BULK_CHUNK)) {
		const ph = part.map(() => '?').join(', ');
		const res = await db
			.prepare(`UPDATE automations SET status = ? WHERE id IN (${ph}) RETURNING id`)
			.bind(status, ...part)
			.all<{ id: number }>();
		changed += res.results.length;
		await noteStatusChange(db, res.results.map((r) => r.id));
		// #397: status history.
		await logStatusChanges(
			db,
			res.results.map((r) => ({ id: r.id, from: fromStatus.get(r.id) ?? null, to: status })),
			opts.reason ?? null,
			opts.userId ?? null
		);
	}
	return { changed, skipped };
}

// #396: when an automation last changed status, for the editor's status strip ("Live since …").
// Kept in app_state (no migration); unknown for changes made before this shipped.
const STATUS_AT = 'automation_status_at:';

export async function noteStatusChange(db: D1Database, ids: number[]): Promise<void> {
	if (!ids.length) return;
	const stmt = db.prepare(
		`INSERT INTO app_state (key, value, updated_at) VALUES (?, datetime('now'), datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	);
	await db.batch(ids.map((id) => stmt.bind(`${STATUS_AT}${id}`)));
}

/** 'YYYY-MM-DD HH:MM:SS' UTC, or null when it was never recorded. */
export async function statusChangedAt(db: D1Database, id: number): Promise<string | null> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(`${STATUS_AT}${id}`).first<{ value: string }>();
	return row?.value ?? null;
}

/** Add or remove one label across many automations. Add enforces
 *  MAX_LABELS_PER_AUTOMATION per automation (over the cap → skipped); an automation that
 *  already has the label (case-insensitive) is left alone, as is removing a label an
 *  automation doesn't have. Returns `{ error }` when the label doesn't normalize. */
export async function bulkLabel(
	db: D1Database,
	rawIds: unknown[],
	raw: string,
	op: 'add' | 'remove'
): Promise<BulkResult | { error: string }> {
	const label = normalizeLabel(raw);
	if (!label) return { error: 'Tags are 1–30 characters.' };
	const ids = cleanIds(rawIds);

	if (op === 'remove') {
		let changed = 0;
		for (const part of chunk(ids, BULK_CHUNK)) {
			const ph = part.map(() => '?').join(', ');
			const res = await db
				.prepare(`DELETE FROM automation_labels WHERE label = ? AND automation_id IN (${ph}) RETURNING automation_id`)
				.bind(label, ...part)
				.all();
			changed += res.results.length;
		}
		return { changed, skipped: [] };
	}

	const rows = await loadRows(db, ids, label);
	const skipped: Skipped[] = [];
	const toAdd: number[] = [];
	for (const r of rows) {
		if (r.has_label) continue;
		if (r.label_count >= MAX_LABELS_PER_AUTOMATION) {
			skipped.push({ id: r.id, name: r.name, reason: `already has ${MAX_LABELS_PER_AUTOMATION} tags` });
			continue;
		}
		toAdd.push(r.id);
	}
	let changed = 0;
	for (const part of chunk(toAdd, BULK_CHUNK)) {
		const values = part.map(() => '(?, ?)').join(', ');
		const res = await db
			.prepare(`INSERT OR IGNORE INTO automation_labels (automation_id, label) VALUES ${values} RETURNING automation_id`)
			.bind(...part.flatMap((id) => [id, label]))
			.all();
		changed += res.results.length;
	}
	return { changed, skipped };
}

export const DELETE_SENT_REASON = 'already sent emails — pause it instead';

/** Delete automations — the one path behind both the single `delete` action and
 *  `bulkDelete`. An automation that has sent anything (a campaign row references it, no
 *  cascade) is skipped. Steps, enrollments (→ branch hits) and labels cascade via FK; the
 *  two FKs pointing INTO automation_steps (enrollments.current_step_id, steps.parent_step_id
 *  / target_step_id) are nulled first because cascade order is unspecified. */
export async function deleteAutomations(db: D1Database, rawIds: unknown[]): Promise<BulkResult> {
	const rows = await loadRows(db, cleanIds(rawIds));
	const skipped: Skipped[] = [];
	const toDelete: number[] = [];
	for (const r of rows) {
		if (r.campaign_count > 0) skipped.push({ id: r.id, name: r.name, reason: DELETE_SENT_REASON });
		else toDelete.push(r.id);
	}
	let changed = 0;
	for (const part of chunk(toDelete, BULK_CHUNK)) {
		const ph = part.map(() => '?').join(', ');
		const res = await db.batch([
			db.prepare(`UPDATE automation_enrollments SET current_step_id = NULL WHERE automation_id IN (${ph})`).bind(...part),
			db
				.prepare(`UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL WHERE automation_id IN (${ph})`)
				.bind(...part),
			// RETURNING, not meta.changes — cascaded rows inflate `changes`.
			db.prepare(`DELETE FROM automations WHERE id IN (${ph}) RETURNING id`).bind(...part)
		]);
		changed += res[res.length - 1].results.length;
	}
	return { changed, skipped };
}

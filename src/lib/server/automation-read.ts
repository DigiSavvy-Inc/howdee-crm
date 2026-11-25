// Read-only automation queries shared by the automation page, GET /api/v1/automations and
// the assistant's read tools (#287). Moved verbatim out of those routes. Nothing here
// enrolls, ticks or writes — keep it that way (the assistant imports this module).

import { labelsByAutomation } from './automation-labels';
import { classifyProxyOpen } from './engagement';
import { contactsMatchingRules } from './condition-eval';
import { parseGateRules } from '$lib/condition-rules';
import { containsSql } from './sql-match';

export type AutomationListRow = {
	id: number;
	name: string;
	status: string;
	trigger: string;
	trigger_list_id: number | null;
	reentry: string;
	step_count: number;
	active_enrollments: number;
	created_at: string;
	labels: string[];
};

/** Automations by name (NOCASE), optionally one status and/or one (normalised) label. */
export async function listAutomations(
	db: D1Database,
	opts: { status?: string | null; label?: string | null } = {}
): Promise<AutomationListRow[]> {
	const conditions: string[] = [];
	const binds: unknown[] = [];
	if (opts.status) {
		conditions.push('a.status = ?');
		binds.push(opts.status);
	}
	if (opts.label) {
		conditions.push('EXISTS (SELECT 1 FROM automation_labels al WHERE al.automation_id = a.id AND al.label = ?)');
		binds.push(opts.label);
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

	const rows = await db
		.prepare(
			`SELECT a.id, a.name, a.status, a.trigger_type AS trigger, a.trigger_list_id, a.reentry, a.created_at,
			        (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id) AS step_count,
			        (SELECT COUNT(*) FROM automation_enrollments e WHERE e.automation_id = a.id AND e.status = 'active') AS active_enrollments
			 FROM automations a
			 ${where}
			 ORDER BY a.name COLLATE NOCASE`
		)
		.bind(...binds)
		.all<Omit<AutomationListRow, 'labels'>>();

	const labelMap = await labelsByAutomation(db, rows.results.map((r) => r.id));
	return rows.results.map((r) => ({ ...r, labels: labelMap.get(r.id) ?? [] }));
}

export type AutomationStepRow = {
	id: number;
	position: number;
	delay_before_seconds: number;
	type: string;
	tag_action: string | null;
	tag_name: string | null;
	tag_on_open: string | null;
	tag_on_click: string | null;
	gate_kind: string | null;
	gate_name: string | null;
	gate_value: string | null;
	gate_rules: string | null;
	subject: string;
	body_md: string;
	body_blocks: string | null;
	preheader: string | null;
	from_email: string;
	parent_step_id: number | null;
	branch_label: string | null;
	gate_ref_id: number | null;
	split_pct: number | null;
	weekday_only: number;
	action_kind: string | null;
	target_automation_id: number | null;
	target_name: string | null;
	target_status: string | null;
	target_step_id: number | null;
	target_stage_id: number | null;
	only_from_stage_id: number | null;
	ready: number; // #395: 0 = never saved valid (canvas "Unfinished", the engine holds contacts here)
	wait_config: string | null; // #397: a wait step's config (JSON)
	target_tier: string | null; // #460: set_tier's tier, or 'clear'
	tier_days: number | null; // #460: set_tier's days (NULL = until cleared)
	action_config: string | null; // #467: adjust_score's JSON { score_id, points, expires_days }
};

/** Every step of an automation in position order (with an action step's target name). */
export async function automationStepRows(db: D1Database, automationId: number): Promise<AutomationStepRow[]> {
	const steps = await db
		.prepare(
			`SELECT s.id, s.position, s.delay_before_seconds, s.type, s.tag_action, s.tag_name, s.tag_on_open, s.tag_on_click,
			        s.gate_kind, s.gate_name, s.gate_value, s.gate_rules, s.subject, s.body_md, s.body_blocks, s.preheader, s.from_email,
			        s.parent_step_id, s.branch_label, s.gate_ref_id, s.split_pct, s.weekday_only,
			        s.action_kind, s.target_automation_id, ta.name AS target_name, ta.status AS target_status,
			        s.target_step_id, s.target_stage_id, s.only_from_stage_id, s.ready, s.wait_config, s.target_tier, s.tier_days, s.action_config
			 FROM automation_steps s
			 LEFT JOIN automations ta ON ta.id = s.target_automation_id
			 WHERE s.automation_id = ? ORDER BY s.position`
		)
		.bind(automationId)
		.all<AutomationStepRow>();
	return steps.results;
}

export type EnrollmentCounts = { active: number; completed: number; cancelled: number; failed: number };

export async function enrollmentCounts(db: D1Database, automationId: number): Promise<EnrollmentCounts> {
	const counts = await db
		.prepare(
			`SELECT
			   COALESCE(SUM(status = 'active'), 0)    AS active,
			   COALESCE(SUM(status = 'completed'), 0) AS completed,
			   COALESCE(SUM(status = 'cancelled'), 0) AS cancelled,
			   COALESCE(SUM(status = 'failed'), 0)    AS failed
			 FROM automation_enrollments WHERE automation_id = ?`
		)
		.bind(automationId)
		.first<EnrollmentCounts>();
	return counts ?? { active: 0, completed: 0, cancelled: 0, failed: 0 };
}

export type StepStatRow = {
	step_id: number;
	position: number;
	type: string;
	waiting: number;
	campaign_id: number | null;
	sent: number | null;
	opens: number | null;
	clicks: number | null;
	unsubs: number | null;
	went_yes: number;
	went_no: number;
	act_enrolled: number;
	act_ended: number;
	act_jumped: number;
	act_pipeline: number;
	act_tier: number; // #460: set_tier steps that set or cleared an override
	act_score: number; // #467: adjust_score steps that added points
	act_skipped: number;
};

/** Per-step funnel (#14): waiting-at-step + the step campaign's send/engagement stats.
 *  Branch steps (#75/#76) add went-yes/went-no counts from automation_branch_hits. */
export async function automationStepStats(db: D1Database, automationId: number): Promise<StepStatRow[]> {
	const stepStats = await db
		.prepare(
			`SELECT s.id AS step_id, s.position, s.type,
			        (SELECT COUNT(*) FROM automation_enrollments ae
			           WHERE ae.automation_id = s.automation_id AND ae.status = 'active' AND ae.current_step_id = s.id) AS waiting,
			        c.id AS campaign_id,
			        (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = c.id AND r.status = 'accepted') AS sent,
			        (SELECT COUNT(DISTINCT ev.recipient_id) FROM events ev WHERE ev.campaign_id = c.id AND ev.type = 'open') AS opens,
			        (SELECT COUNT(DISTINCT ev.recipient_id) FROM events ev WHERE ev.campaign_id = c.id AND ev.type = 'click') AS clicks,
			        (SELECT COUNT(*) FROM events ev WHERE ev.campaign_id = c.id AND ev.type = 'unsubscribe') AS unsubs,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND bh.label = 'yes') AS went_yes,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND bh.label = 'no') AS went_no,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND bh.label = 'enrolled') AS act_enrolled,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND (bh.label = 'ended' OR bh.label LIKE 'ended % automations')) AS act_ended,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND bh.label LIKE 'jumped to %') AS act_jumped,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND (bh.label LIKE 'moved to «%' OR bh.label LIKE 'added to «%' OR bh.label = 'removed from pipeline')) AS act_pipeline,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND (bh.label LIKE 'tier set to «%' OR bh.label = 'tier override cleared')) AS act_tier,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND bh.label LIKE 'Adjusted %') AS act_score,
			        (SELECT COUNT(*) FROM automation_branch_hits bh WHERE bh.step_id = s.id AND bh.label NOT IN ('enrolled', 'ended', 'removed from pipeline', 'tier override cleared') AND bh.label NOT LIKE 'ended % automations' AND bh.label NOT LIKE 'jumped to %'
			           AND bh.label NOT LIKE 'moved to «%' AND bh.label NOT LIKE 'added to «%' AND bh.label NOT LIKE 'tier set to «%' AND bh.label NOT LIKE 'Adjusted %') AS act_skipped
			 FROM automation_steps s
			 LEFT JOIN campaigns c ON c.automation_step_id = s.id
			 WHERE s.automation_id = ?
			 ORDER BY s.position`
		)
		.bind(automationId)
		.all<StepStatRow>();
	// #395: opens without Apple Mail / prefetch auto-opens (the opened branch uses the same rule).
	const campaignIds = stepStats.results.map((r) => r.campaign_id).filter((c): c is number => c !== null);
	const human = await realOpenCounts(db, campaignIds);
	return stepStats.results.map((r) => (r.campaign_id === null ? r : { ...r, opens: human.get(r.campaign_id) ?? 0 }));
}

/**
 * #395: per campaign, recipients with a real open — a click (it implies one), or an open
 * `classifyProxyOpen` doesn't flag as an Apple Mail / prefetch auto-open. The same filter
 * the campaign page uses for its "auto-opens" note and the engine's opened branch.
 */
export async function realOpenCounts(db: D1Database, campaignIds: number[]): Promise<Map<number, number>> {
	const seen = new Map<number, Set<number>>();
	for (let i = 0; i < campaignIds.length; i += 50) {
		const rows = await db
			.prepare(
				`SELECT ev.campaign_id, ev.recipient_id, ev.type, ev.detail, ev.recorded_at,
				        (SELECT MIN(d.recorded_at) FROM events d
				          WHERE d.campaign_id = ev.campaign_id AND d.type = 'delivery' AND d.recipient_id = ev.recipient_id) AS delivered_at
				 FROM events ev
				 WHERE ev.campaign_id IN (SELECT value FROM json_each(?)) AND ev.type IN ('open', 'click') AND ev.recipient_id IS NOT NULL`
			)
			.bind(JSON.stringify(campaignIds.slice(i, i + 50)))
			.all<{ campaign_id: number; recipient_id: number; type: string; detail: string | null; recorded_at: string; delivered_at: string | null }>();
		for (const r of rows.results) {
			const set = seen.get(r.campaign_id) ?? new Set<number>();
			seen.set(r.campaign_id, set);
			if (set.has(r.recipient_id)) continue;
			let detail: unknown = {};
			try {
				detail = r.detail ? JSON.parse(r.detail) : {};
			} catch {
				/* truncated payload — no UA to judge by */
			}
			if (r.type === 'click' || !classifyProxyOpen(detail, r.delivered_at, r.recorded_at)) set.add(r.recipient_id);
		}
	}
	return new Map([...seen].map(([c, s]) => [c, s.size]));
}

export type EnrollmentRow = {
	id: number;
	status: string;
	current_step_id: number | null;
	next_run_at: string | null;
	attempts: number;
	last_error: string | null;
	enrolled_at: string;
	last_step_at: string | null;
	ended_at: string | null;
	email: string;
	contact_id: number;
	wait_started_at?: string | null; // #397
	completed_reason?: string | null; // #397: 'goal:<kind>'
};

export const INSPECTOR_PAGE_SIZE = 50;
export const ENROLLMENT_STATUSES = ['active', 'completed', 'cancelled', 'failed'] as const;

export type EnrollmentFilter = {
	/** Email or name contains (case-insensitive). */
	q?: string | null;
	status?: string | null;
	/** Only passes currently at this step. */
	stepId?: number | null;
	limit?: number;
	offset?: number;
};

/** #396: the inspector's page — filtered in SQL so any enrollment can be found, not just the newest 100. */
export async function enrollmentPage(
	db: D1Database,
	automationId: number,
	f: EnrollmentFilter = {}
): Promise<{ rows: EnrollmentRow[]; total: number; limit: number; offset: number }> {
	const where = ['e.automation_id = ?'];
	const binds: unknown[] = [automationId];
	const q = (f.q ?? '').trim().toLowerCase();
	if (q) {
		// #485: instr, not LIKE (D1 caps LIKE patterns at 50 bytes).
		where.push(
			`(${containsSql('c.email')} OR ${containsSql("COALESCE(c.name, '')")} OR ${containsSql("TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))")})`
		);
		binds.push(q, q, q);
	}
	if (f.status && (ENROLLMENT_STATUSES as readonly string[]).includes(f.status)) {
		where.push('e.status = ?');
		binds.push(f.status);
	}
	if (f.stepId) {
		where.push('e.current_step_id = ?');
		binds.push(f.stepId);
	}
	const limit = Math.min(Math.max(1, Math.floor(f.limit ?? INSPECTOR_PAGE_SIZE)), 200);
	const offset = Math.max(0, Math.floor(f.offset ?? 0));
	const sqlWhere = where.join(' AND ');
	const total = await db
		.prepare(`SELECT COUNT(*) AS n FROM automation_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE ${sqlWhere}`)
		.bind(...binds)
		.first<{ n: number }>();
	const rows = await db
		.prepare(
			`SELECT e.id, e.status, e.current_step_id, e.next_run_at, e.attempts, e.last_error,
			        e.enrolled_at, e.last_step_at, e.ended_at, c.email, c.id AS contact_id, e.wait_started_at, e.completed_reason
			 FROM automation_enrollments e
			 JOIN contacts c ON c.id = e.contact_id
			 WHERE ${sqlWhere}
			 ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.enrolled_at DESC, e.id DESC
			 LIMIT ? OFFSET ?`
		)
		.bind(...binds, limit, offset)
		.all<EnrollmentRow>();
	return { rows: rows.results, total: total?.n ?? 0, limit, offset };
}

/** #396: how many of `contactIds` enroll() would actually start — subscribed, not archived,
 *  and not blocked by the re-entry policy (once: any earlier pass; multiple: an active one). */
export async function enrollPreviewCount(
	db: D1Database,
	automationId: number,
	contactIds: number[]
): Promise<{ total: number; eligible: number; entry_blocked: number }> {
	const ids = [...new Set(contactIds.filter((n) => Number.isInteger(n) && n > 0))];
	const auto = await db
		.prepare('SELECT reentry, entry_rules FROM automations WHERE id = ?')
		.bind(automationId)
		.first<{ reentry: string; entry_rules: string | null }>();
	const passFilter = auto?.reentry === 'multiple' ? "AND p.status = 'active'" : '';
	const open: number[] = [];
	for (let i = 0; i < ids.length; i += 5000) {
		const rows = await db
			.prepare(
				`SELECT c.id FROM contacts c
				 WHERE c.id IN (SELECT value FROM json_each(?)) AND c.subscribed = 1 AND c.archived_at IS NULL
				   AND NOT EXISTS (SELECT 1 FROM automation_enrollments p WHERE p.automation_id = ? AND p.contact_id = c.id ${passFilter})`
			)
			.bind(JSON.stringify(ids.slice(i, i + 5000)), automationId)
			.all<{ id: number }>();
		open.push(...rows.results.map((r) => r.id));
	}
	// #412: `eligible` already leaves out who the entry conditions turn away (`entry_blocked`).
	const set = parseGateRules(auto?.entry_rules);
	const entryBlocked = set ? open.length - (await contactsMatchingRules(db, set, open)).length : 0;
	return { total: ids.length, eligible: open.length - entryBlocked, entry_blocked: entryBlocked };
}

/** Latest enrollments for the inspector: active first, then most recently enrolled. */
export async function recentEnrollments(
	db: D1Database,
	automationId: number,
	opts: { limit?: number; status?: string | null } = {}
): Promise<EnrollmentRow[]> {
	const statusSql = opts.status ? 'AND e.status = ?' : '';
	const binds: unknown[] = [automationId];
	if (opts.status) binds.push(opts.status);
	const enrollments = await db
		.prepare(
			`SELECT e.id, e.status, e.current_step_id, e.next_run_at, e.attempts, e.last_error,
			        e.enrolled_at, e.last_step_at, e.ended_at, c.email, c.id AS contact_id
			 FROM automation_enrollments e
			 JOIN contacts c ON c.id = e.contact_id
			 WHERE e.automation_id = ? ${statusSql}
			 ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.enrolled_at DESC
			 LIMIT ?`
		)
		.bind(...binds, opts.limit ?? 100)
		.all<EnrollmentRow>();
	return enrollments.results;
}

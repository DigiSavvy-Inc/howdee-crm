// #395: enroll a whole list / segment into an automation from the builder's Enroll modal.
// Refused unless the automation is active (403). The modal asks for a preview first
// (`listEnrollPreview`) and the action needs `confirm=1`. One request enrolls at most
// ENROLL_REQUEST_CAP contacts (in enroll()'s batches of 90); the rest are queued in
// app_state `automation_enroll_queue` and drained by the heartbeat tick, ENROLL_REQUEST_CAP
// per tick, by ascending contact id (`after_id` cursor). A queued job re-resolves the
// list's members each tick and is dropped once the automation is no longer active.

import { enroll } from './automations';
import { memberIds } from './segments';
import { contactsMatchingRules } from './condition-eval';
import { parseGateRules } from '$lib/condition-rules';

export const ENROLL_REQUEST_CAP = 2000;
const QUEUE_KEY = 'automation_enroll_queue';
const IN_CHUNK = 500;

type ListRow = { id: number; name: string; kind: string; rules: string | null };
type QueueJob = { automation_id: number; list_id: number; after_id: number; ignore_entry?: boolean };

export type EnrollProblem = { ok: false; status: 400 | 403 | 404; error: string };

async function readyAutomation(
	db: D1Database,
	automationId: number
): Promise<{ ok: true; name: string; reentry: string } | EnrollProblem> {
	const a = await db
		.prepare('SELECT name, status, reentry FROM automations WHERE id = ?')
		.bind(automationId)
		.first<{ name: string; status: string; reentry: string }>();
	if (!a) return { ok: false, status: 404, error: 'Automation not found.' };
	if (a.status !== 'active') {
		return { ok: false, status: 403, error: `“${a.name}” is ${a.status}. Activate it before enrolling contacts.` };
	}
	const steps = await db
		.prepare('SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ?')
		.bind(automationId)
		.first<{ n: number }>();
	if (!steps?.n) return { ok: false, status: 400, error: 'Add at least one step before enrolling contacts.' };
	return { ok: true, name: a.name, reentry: a.reentry };
}

async function loadList(db: D1Database, listId: number): Promise<ListRow | null> {
	if (!listId) return null;
	return db.prepare('SELECT id, name, kind, rules FROM lists WHERE id = ?').bind(listId).first<ListRow>();
}

/** Subscribed, non-archived members, ascending id (the queue cursor needs a stable order). */
async function eligibleIds(db: D1Database, list: ListRow): Promise<number[]> {
	return (await memberIds(db, list, true)).filter((id) => Number.isInteger(id)).sort((a, b) => a - b);
}

export type EnrollPreview = {
	ok: true;
	list_id: number;
	list_name: string;
	/** Members of the list / segment (any status). */
	members: number;
	/** Subscribed, not archived — the ones enroll() may take. */
	eligible: number;
	/** Eligible but blocked by the re-entry policy (a prior pass for 'once', an active one for 'multiple'). */
	already: number;
	/** #412: eligible, not already in, but not matching the entry conditions (0 = none set).
	 *  Ticking "ignore entry conditions" adds them back. */
	entry_blocked: number;
	/** eligible − already − entry_blocked: what a confirmed enroll would add. */
	will_enroll: number;
	/** How many of those go in this request; the rest are queued for the heartbeat. */
	now: number;
	queued: number;
};

/** The count the Enroll modal shows before asking for confirmation. */
export async function listEnrollPreview(db: D1Database, automationId: number, listId: number): Promise<EnrollPreview | EnrollProblem> {
	const a = await readyAutomation(db, automationId);
	if (!a.ok) return a;
	const list = await loadList(db, listId);
	if (!list) return { ok: false, status: 400, error: 'Choose a list or segment to enroll.' };
	const members = (await memberIds(db, list)).length;
	const ids = await eligibleIds(db, list);
	const blocked = new Set<number>();
	const activeOnly = a.reentry === 'multiple' ? "AND status = 'active'" : '';
	for (let i = 0; i < ids.length; i += IN_CHUNK) {
		const rows = await db
			.prepare(
				`SELECT DISTINCT contact_id FROM automation_enrollments
				 WHERE automation_id = ? ${activeOnly} AND contact_id IN (SELECT value FROM json_each(?))`
			)
			.bind(automationId, JSON.stringify(ids.slice(i, i + IN_CHUNK)))
			.all<{ contact_id: number }>();
		for (const r of rows.results) blocked.add(r.contact_id);
	}
	const already = blocked.size;
	// #412: of the rest, the ones the entry conditions would turn away.
	const entryBlocked = await entryBlockedCount(db, automationId, ids.filter((id) => !blocked.has(id)));
	const willEnroll = Math.max(0, ids.length - already - entryBlocked);
	return {
		ok: true,
		list_id: list.id,
		list_name: list.name,
		members,
		eligible: ids.length,
		already,
		entry_blocked: entryBlocked,
		will_enroll: willEnroll,
		now: Math.min(ids.length, ENROLL_REQUEST_CAP),
		queued: Math.max(0, ids.length - ENROLL_REQUEST_CAP)
	};
}

/** #412: how many of these contacts the automation's entry conditions turn away (0 when it
 *  has none). */
export async function entryBlockedCount(db: D1Database, automationId: number, contactIds: number[]): Promise<number> {
	if (contactIds.length === 0) return 0;
	const row = await db.prepare('SELECT entry_rules FROM automations WHERE id = ?').bind(automationId).first<{ entry_rules: string | null }>();
	const set = parseGateRules(row?.entry_rules);
	if (!set) return 0;
	return contactIds.length - (await contactsMatchingRules(db, set, contactIds)).length;
}

export type ListEnrollResult = { ok: true; enrolled: number; skipped: number; queued: number };

/** Enroll a list / segment's eligible members: the first ENROLL_REQUEST_CAP now, the rest queued.
 *  #412: `ignoreEntryRules` = the operator ticked "ignore entry conditions" (kept for the queue). */
export async function enrollFromList(
	db: D1Database,
	automationId: number,
	listId: number,
	opts: { ignoreEntryRules?: boolean } = {}
): Promise<ListEnrollResult | EnrollProblem> {
	const a = await readyAutomation(db, automationId);
	if (!a.ok) return a;
	const list = await loadList(db, listId);
	if (!list) return { ok: false, status: 400, error: 'Choose a list or segment to enroll.' };
	const ids = await eligibleIds(db, list);
	const batch = ids.slice(0, ENROLL_REQUEST_CAP);
	const { enrolled, skipped } = await enroll(db, automationId, batch, { ignoreEntryRules: opts.ignoreEntryRules });
	const queued = ids.length - batch.length;
	if (queued > 0) {
		const jobs = (await readQueue(db)).filter((j) => !(j.automation_id === automationId && j.list_id === list.id));
		const job: QueueJob = { automation_id: automationId, list_id: list.id, after_id: batch[batch.length - 1] };
		if (opts.ignoreEntryRules) job.ignore_entry = true;
		jobs.push(job);
		await writeQueue(db, jobs);
	}
	return { ok: true, enrolled, skipped, queued };
}

export type EnrollQueueSummary = { jobs: number; enrolled: number; skipped: number; remaining: number };

/** Heartbeat: drain queued list enrollments, at most ENROLL_REQUEST_CAP contacts per tick. */
export async function processEnrollQueue(db: D1Database): Promise<EnrollQueueSummary> {
	const jobs = await readQueue(db);
	const summary: EnrollQueueSummary = { jobs: jobs.length, enrolled: 0, skipped: 0, remaining: 0 };
	if (jobs.length === 0) return summary;
	let budget = ENROLL_REQUEST_CAP;
	const keep: QueueJob[] = [];
	for (const job of jobs) {
		if (budget <= 0) {
			keep.push(job);
			continue;
		}
		const a = await readyAutomation(db, job.automation_id);
		const list = a.ok ? await loadList(db, job.list_id) : null;
		if (!a.ok || !list) continue; // paused / deleted automation or list — drop the job
		const ids = (await eligibleIds(db, list)).filter((id) => id > job.after_id);
		const batch = ids.slice(0, budget);
		if (batch.length) {
			const r = await enroll(db, job.automation_id, batch, { ignoreEntryRules: job.ignore_entry === true });
			summary.enrolled += r.enrolled;
			summary.skipped += r.skipped;
			budget -= batch.length;
		}
		if (ids.length > batch.length) keep.push({ ...job, after_id: batch[batch.length - 1] ?? job.after_id });
	}
	summary.remaining = keep.length;
	await writeQueue(db, keep);
	return summary;
}

async function readQueue(db: D1Database): Promise<QueueJob[]> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(QUEUE_KEY).first<{ value: string }>();
	if (!row?.value) return [];
	try {
		const parsed = JSON.parse(row.value);
		return Array.isArray(parsed)
			? parsed.filter((j) => j && Number.isInteger(j.automation_id) && Number.isInteger(j.list_id) && Number.isInteger(j.after_id))
			: [];
	} catch {
		return [];
	}
}

async function writeQueue(db: D1Database, jobs: QueueJob[]): Promise<void> {
	if (jobs.length === 0) {
		await db.prepare('DELETE FROM app_state WHERE key = ?').bind(QUEUE_KEY).run();
		return;
	}
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(QUEUE_KEY, JSON.stringify(jobs))
		.run();
}

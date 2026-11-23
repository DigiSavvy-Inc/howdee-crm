// #398: "Simulate a contact" — the path one contact would take through an automation if they
// were enrolled today. Read-only: nothing is enrolled, sent, tagged or recorded. Branch
// decisions are the engine's own (`previewBranch` → `branchLabel` → condition-eval.ts) against
// live data; waits are shown as durations from enrollment. What can't be known today is said
// so: an event wait is shown as timing out (the event hasn't happened yet), an A/B split with
// no pass yet uses a stand-in, and a branch that tests an email the contact hasn't received
// yet reads today's data (usually NO).

import { stepNumbers, numberedStepTitle, stepShortTitle } from '$lib/automation-action-labels';
import { durationText, parseExitRules, parseWait, waitText, WAIT_DELAY_DEFAULT, WAIT_TIMEOUT_DEFAULT, WAIT_LANE_LABELS } from '$lib/automation-flow';
import { applyWeekdayOnly } from './businessdays';
import { abVariantFor } from '$lib/automation-ab';
import { STEP_COLS, nextStep, type StepRow } from './automation-tree';
import { fieldDateTarget, goalHit, waitDateTarget, windowNextOpen } from './automation-flow';
import { previewBranch } from './automations';
import { evaluateRules } from './condition-eval';
import { getTimezone } from './settings';

export type SimStep = {
	step_id: number;
	/** "3. Welcome, {{first_name}}" */
	title: string;
	type: string;
	/** Lane depth (0 = trunk) for indenting. */
	depth: number;
	/** The wait before this step ("waits 2 days"), or null. */
	wait: string | null;
	/** Time since enrollment when the step runs ("right away", "after 3 days"). */
	at: string;
	/** What happens here ("YES", "Variant B", "Jumps to 2. …"), or null. */
	decision: string | null;
	/** A caveat ("assumes they don't click in time"), or null. */
	note: string | null;
};

export type SimResult = {
	contact: { id: number; email: string; name: string | null };
	/** Why they wouldn't be enrolled / would stop early (empty = they would be). */
	notes: string[];
	path: SimStep[];
	/** How the walk ends: "Completes after step 7", "Ends at 5. End automation", … */
	end: string;
};

const MAX_VISITS = 200;
const MAX_JUMPS = 25;

function atText(seconds: number): string {
	return seconds <= 0 ? 'right away' : `after ${durationText(seconds)}`;
}

export async function simulateContact(db: D1Database, automationId: number, contactId: number, now: Date = new Date()): Promise<SimResult | null> {
	const auto = await db
		.prepare('SELECT id, reentry, exit_rules FROM automations WHERE id = ?')
		.bind(automationId)
		.first<{ id: number; reentry: string; exit_rules: string | null }>();
	const contact = await db
		.prepare('SELECT id, email, name, subscribed, archived_at FROM contacts WHERE id = ?')
		.bind(contactId)
		.first<{ id: number; email: string; name: string | null; subscribed: number; archived_at: string | null }>();
	if (!auto || !contact) return null;

	const notes: string[] = [];
	if (contact.subscribed !== 1) notes.push('Unsubscribed — they wouldn’t be enrolled.');
	if (contact.archived_at) notes.push('Archived — they wouldn’t be enrolled.');
	const passes = (
		await db
			.prepare('SELECT id, status FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id DESC')
			.bind(automationId, contactId)
			.all<{ id: number; status: string }>()
	).results;
	const active = passes.find((p) => p.status === 'active');
	if (active) notes.push('Already in this automation (an active pass) — they wouldn’t be enrolled again until it ends.');
	else if (passes.length && auto.reentry !== 'multiple') notes.push('Already went through once and re-entry is “once” — they wouldn’t be enrolled again.');
	// Split / A/B hashes use the pass id: their active pass, else a stand-in for a new one.
	const passId = active?.id ?? 0;

	const all = (await db.prepare(`SELECT ${STEP_COLS} FROM automation_steps WHERE automation_id = ?`).bind(automationId).all<StepRow>()).results;
	const numbers = stepNumbers(all);
	const byId = new Map(all.map((s) => [s.id, s]));
	const depthOf = (s: StepRow): number => {
		let d = 0;
		let p = s.parent_step_id;
		while (p && d < 20) {
			d++;
			p = byId.get(p)?.parent_step_id ?? null;
		}
		return d;
	};
	const stageNames = new Map(
		(await db.prepare('SELECT id, name FROM pipeline_stages').all<{ id: number; name: string }>()).results.map((r) => [r.id, r.name])
	);
	const title = (s: StepRow) =>
		numberedStepTitle(
			numbers.get(s.id),
			stepShortTitle({ ...s, target_stage_name: s.action_kind === 'pipeline_move' ? (stageNames.get(s.target_stage_id ?? 0) ?? null) : undefined })
		);
	const result = (path: SimStep[], end: string): SimResult => ({ contact: { id: contact.id, email: contact.email, name: contact.name }, notes, path, end });

	// Exit goals that are already met (tag / segment — reply and stage only count after enrolling).
	const rules = parseExitRules(auto.exit_rules);
	if (rules.length) {
		const kind = await goalHit(db, rules, { contact_id: contactId, enrolled_at: now.toISOString().replace('T', ' ').slice(0, 19) });
		if (kind) return result([], `An exit goal (${kind}) is already met — the pass would complete before the first step.`);
	}

	const firstLane = (parentId: number, label: 'yes' | 'no') =>
		all.filter((s) => s.parent_step_id === parentId && s.branch_label === label).sort((a, b) => a.position - b.position)[0] ?? null;
	let tz: string | null = null;
	let step: StepRow | null = all.filter((s) => s.parent_step_id === null).sort((a, b) => a.position - b.position)[0] ?? null;
	if (!step) return result([], 'This automation has no steps yet.');

	const path: SimStep[] = [];
	let elapsed = 0;
	let jumps = 0;
	while (step) {
		if (path.length >= MAX_VISITS) return result(path, 'Stopped: the preview reached its step limit (a loop?).');
		const s: StepRow = step;
		const delay = Math.max(0, s.delay_before_seconds ?? 0);
		elapsed += delay;
		const row: SimStep = {
			step_id: s.id,
			title: title(s),
			type: s.type,
			depth: depthOf(s),
			wait: delay > 0 ? `waits ${durationText(delay)}${s.weekday_only ? ' (weekdays only)' : ''}` : null,
			at: atText(elapsed),
			decision: null,
			note: null
		};
		path.push(row);
		if (s.ready === 0) {
			row.note = 'Unfinished step — the contact would be held here until it’s saved.';
			return result(path, `Held at ${row.title}.`);
		}
		let next: StepRow | null = null;
		let decided = false;

		if (s.type === 'end') return result(path, `Ends at ${row.title}.`);
		if (s.type === 'email') {
			if (s.ab_enabled && s.ab_subject) {
				const v = abVariantFor(passId, s.id);
				row.decision = `Variant ${v.toUpperCase()}: “${v === 'b' ? s.ab_subject : s.subject}”`;
				if (!active) row.note = 'A/B variant is picked per pass; a new pass may get the other one.';
			} else row.decision = `Sends “${s.subject}”`;
		} else if (s.type === 'branch') {
			const label = await previewBranch(db, s, contactId, passId);
			const lane = label === 'yes' ? 'yes' : 'no';
			row.decision = label === 'misconfigured' ? 'NO — the condition isn’t configured' : lane.toUpperCase();
			if (s.gate_kind === 'split' && !active) row.note = `Split ${s.split_pct ?? 50}% YES — picked per pass; a new pass may go the other way.`;
			else if (!s.gate_rules && (s.gate_kind === 'opened' || s.gate_kind === 'clicked')) row.note = 'Checked against today’s data — engagement after enrolling isn’t known yet.';
			next = firstLane(s.id, lane);
			decided = !!next;
		} else if (s.type === 'wait') {
			const w = parseWait(s.wait_config ?? null);
			if (w?.mode === 'delay') {
				// #625: a set period (weekdays_only moves a weekend end to Monday).
				const start = new Date(now.getTime() + elapsed * 1000);
				let until = new Date(start.getTime() + (w.seconds ?? WAIT_DELAY_DEFAULT) * 1000);
				if (w.weekdays_only) {
					tz ??= await getTimezone(db);
					until = applyWeekdayOnly(until, tz);
				}
				const extra = Math.max(0, Math.round((until.getTime() - start.getTime()) / 1000));
				elapsed += extra;
				row.decision = waitText(w);
			} else if (w?.mode === 'rules') {
				// #626: today's data — a match goes "Did it" now; else the time limit, or no limit.
				const { pass } = w.rules ? await evaluateRules(db, contactId, w.rules, { stepId: s.id, enrollmentId: passId || null }) : { pass: false };
				if (pass) {
					row.decision = `${WAIT_LANE_LABELS.yes} — matches the conditions today`;
					next = firstLane(s.id, 'yes');
				} else if (w.timeout_seconds) {
					elapsed += w.timeout_seconds;
					row.decision = `${WAIT_LANE_LABELS.no} after ${durationText(w.timeout_seconds)}`;
					row.note = 'Doesn’t match the conditions today — the preview assumes nothing changes in time.';
					next = firstLane(s.id, 'no');
				} else {
					row.decision = 'Waits — doesn’t match the conditions today (no time limit)';
					return result(path, `Waits at ${row.title} until the contact matches its conditions (no time limit).`);
				}
				decided = !!next;
			} else if (w?.mode === 'event') {
				const timeout = w.timeout_seconds ?? WAIT_TIMEOUT_DEFAULT;
				elapsed += timeout;
				row.decision = `${WAIT_LANE_LABELS.no} after ${durationText(timeout)}`;
				row.note = `${waitText(w)} — the preview assumes it doesn’t happen in time.`;
				next = firstLane(s.id, 'no');
				decided = !!next;
			} else if (w?.mode === 'field_date') {
				// #627: today's value of the contact's field; missing / passed follows if_passed.
				tz ??= await getTimezone(db);
				const c = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(contactId).first<{ meta: string | null }>();
				let value: unknown = null;
				try {
					value = (JSON.parse(c?.meta ?? '{}') ?? {})[w.field ?? ''];
				} catch {
					/* missing */
				}
				const start = new Date(now.getTime() + elapsed * 1000);
				const target = fieldDateTarget(w, value, tz);
				if (!target || target.getTime() <= start.getTime()) {
					if (w.if_passed === 'exit') {
						row.decision = `${waitText(w)} — the date has passed (or is missing): the pass ends here`;
						return result(path, `Ends at ${row.title} (date passed).`);
					}
					row.decision = `${waitText(w)} — the date has passed (or is missing): continues right away`;
				} else {
					const extra = Math.round((target.getTime() - start.getTime()) / 1000);
					elapsed += extra;
					row.decision = `${waitText(w)} (about ${durationText(extra)})`;
				}
			} else if (w) {
				tz ??= await getTimezone(db);
				const start = new Date(now.getTime() + elapsed * 1000);
				const until = w.mode === 'date' ? waitDateTarget(w, start, tz) : windowNextOpen(w, start, tz);
				const extra = until ? Math.max(0, Math.round((until.getTime() - start.getTime()) / 1000)) : 0;
				elapsed += extra;
				row.decision = extra > 0 ? `${waitText(w)} (about ${durationText(extra)})` : `${waitText(w)} — continues right away`;
			}
		} else if (s.type === 'tag') {
			row.decision = s.tag_action === 'remove' ? 'Removes the tag' : 'Adds the tag';
		} else if (s.type === 'action') {
			if (s.action_kind === 'goto_step') {
				const target = s.target_step_id ? byId.get(s.target_step_id) : undefined;
				if (!target || target.id === s.id) row.decision = 'Skipped: no valid target step';
				else if (++jumps > MAX_JUMPS) row.decision = 'Skipped: jump limit';
				else {
					row.decision = `Jumps to ${title(target)}`;
					next = target;
					decided = true;
				}
			} else row.decision = 'Runs this action';
		}

		step = decided ? next : await nextStep(db, s);
	}
	return result(path, `Completes after ${path[path.length - 1].title}.`);
}

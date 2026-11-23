// #221: compound Condition steps — evaluate a rule set for one contact. No SvelteKit imports
// (the tick engine and tests call it directly).
//
// Each rule compiles to a clause over the alias `c` (contacts) — the segment compiler for
// the segment kinds, plus the automation-only kinds below — and runs as
// `SELECT 1 FROM contacts c WHERE c.id = ? AND (<clause>)`. All rules of a step go in one
// db.batch. A rule that can't be compiled (unknown kind, incomplete, deleted list) counts as
// false and is logged once per step id.

import { formAnswerOp, formAnswerRef, isDeletedListRule, ruleSetProblem, type ConditionRule, type ConditionRuleSet } from '$lib/condition-rules';
import { evaluateRule } from '$lib/form-logic';
import { normalizeFormSpec } from '$lib/forms';
import { compileRule, compileSegment, parseRules } from './segment-query';
import { proxyOpenSql } from './engagement';
import { submissionForRule } from './form-reads';

export type CompiledRule = { clause: string; binds: unknown[] };
type ListInfo = { kind: string; rules: string | null };

function likeEscape(s: string): string {
	return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function positiveId(v: string | undefined): number | null {
	const id = Number((v ?? '').trim());
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * One rule → clause, or null when it can't be built. `lists` holds the list/segment rows the
 * set references (a dynamic segment compiles through its own rules); a missing id = deleted.
 */
export function compileConditionRule(r: ConditionRule, lists: Map<number, ListInfo>): CompiledRule | null {
	if (r.invalid) return null; // #228: deleted list → counts as false
	const v = (r.value ?? '').trim();
	switch (r.field) {
		// Tag names match case-insensitively, the same as the legacy tag / no-tag gate.
		case 'tag': {
			if (!v || (r.op !== 'has' && r.op !== 'not')) return null;
			const inner = `SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id
				WHERE lm.contact_id = c.id AND l.kind = 'tag' AND l.name = ? COLLATE NOCASE`;
			return { clause: r.op === 'not' ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`, binds: [v] };
		}

		case 'list': {
			const id = positiveId(r.value);
			if (!id || (r.op !== 'in' && r.op !== 'not')) return null;
			const list = lists.get(id);
			if (!list) return null; // deleted
			const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
			let clause: string;
			let binds: unknown[];
			if (rules) {
				const seg = compileSegment(rules);
				clause = `c.id IN (${seg.sql})`;
				binds = seg.binds;
			} else {
				clause = 'EXISTS (SELECT 1 FROM list_members lm WHERE lm.list_id = ? AND lm.contact_id = c.id)';
				binds = [id];
			}
			return { clause: r.op === 'not' ? `NOT (${clause})` : clause, binds };
		}

		case 'email': {
			if (!v) return null;
			const needle = likeEscape(v.toLowerCase());
			if (r.op === 'contains') return { clause: "LOWER(c.email) LIKE ? ESCAPE '\\'", binds: [`%${needle}%`] };
			if (r.op === 'not_contains') return { clause: "LOWER(c.email) NOT LIKE ? ESCAPE '\\'", binds: [`%${needle}%`] };
			if (r.op === 'ends') return { clause: "LOWER(c.email) LIKE ? ESCAPE '\\'", binds: [`%${needle}`] };
			return null;
		}

		// Engagement with an email step of this automation (its lazily created campaign).
		// #412: an Apple Mail / prefetch auto-open doesn't count as opened (proxyOpenSql, the
		// same rule as the legacy opened gate's classifyProxyOpen). Clicks count as they are.
		case 'step_opened':
		case 'step_clicked': {
			const id = positiveId(r.value);
			if (!id || (r.op !== 'yes' && r.op !== 'no')) return null;
			const real = r.field === 'step_opened' ? ` AND NOT ${proxyOpenSql('ev')}` : '';
			const inner = `SELECT 1 FROM events ev JOIN campaigns cp ON cp.id = ev.campaign_id
				WHERE cp.automation_step_id = ? AND ev.contact_id = c.id AND ev.type = ?${real}`;
			return {
				clause: r.op === 'no' ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`,
				binds: [id, r.field === 'step_opened' ? 'open' : 'click']
			};
		}

		// #516: read in JS against one submission's answers (evaluateRules) — never SQL, so an
		// entry-condition / bulk check counts it false.
		case 'form_answer':
			return null;

		default:
			return compileRule(r);
	}
}

/** #516: one `form_answer` rule for one contact — the pass's submission to that form, else the
 *  contact's latest one; no submission (or a malformed rule) = false. */
export async function evaluateFormAnswer(
	db: D1Database,
	contactId: number,
	r: ConditionRule,
	enrollmentId?: number | null
): Promise<boolean> {
	const ref = formAnswerRef(r.value2);
	const op = formAnswerOp(r.op);
	if (!ref || !op) return false;
	const answers = await submissionForRule(db, contactId, ref.formId, enrollmentId);
	if (!answers) return false;
	return evaluateRule({ field: ref.key, op, value: r.value ?? '' }, answers);
}

/** The list/segment rows a set's `list` rules point at (missing = deleted). */
export async function loadRuleLists(db: D1Database, set: ConditionRuleSet): Promise<Map<number, ListInfo>> {
	const ids = [
		...new Set(set.rules.filter((r) => r.field === 'list').map((r) => positiveId(r.value)).filter((n): n is number => n !== null))
	];
	const out = new Map<number, ListInfo>();
	if (ids.length === 0) return out;
	const rows = await db
		.prepare(`SELECT id, kind, rules FROM lists WHERE id IN (${ids.map(() => '?').join(',')})`)
		.bind(...ids)
		.all<{ id: number; kind: string; rules: string | null }>();
	for (const row of rows.results) out.set(row.id, { kind: row.kind, rules: row.rules });
	return out;
}

/**
 * Save-time check for a Condition step's rule set (#221): at least one rule, each complete,
 * list rules pointing at an existing list/segment, email-step rules at an email step of this
 * automation, and every rule compilable. Returns the first problem, or null.
 */
export async function conditionRulesProblem(
	db: D1Database,
	automationId: number,
	set: ConditionRuleSet | null,
	// #345: a whole-flow spec names email steps by local ref, not id — the caller checks the
	// value instead of the DB (and the compile check uses a stand-in id).
	opts: { emailStepRef?: (value: string) => boolean } = {}
): Promise<string | null> {
	const shape = ruleSetProblem(set);
	if (shape || !set) return shape ?? 'Add at least one rule.';
	const lists = await loadRuleLists(db, set);
	for (const [i, r] of set.rules.entries()) {
		const n = i + 1;
		if (isDeletedListRule(r)) return `Rule ${n}: its list was deleted — pick another list or remove the rule.`;
		if (r.field === 'list') {
			const list = lists.get(positiveId(r.value) ?? 0);
			if (!list || (list.kind !== 'list' && list.kind !== 'segment')) return `Rule ${n}: that list or segment no longer exists.`;
		}
		if (r.field === 'form_answer') {
			const ref = formAnswerRef(r.value2);
			const form = ref ? await db.prepare('SELECT spec FROM forms WHERE id = ?').bind(ref.formId).first<{ spec: string }>() : null;
			if (!ref || !form) return `Rule ${n}: that form no longer exists.`;
			if (!normalizeFormSpec(form.spec).fields.some((f) => f.key === ref.key)) return `Rule ${n}: that question is no longer on the form.`;
			continue;
		}
		const stepRule = r.field === 'step_opened' || r.field === 'step_clicked';
		if (stepRule && opts.emailStepRef) {
			if (!opts.emailStepRef((r.value ?? '').trim())) return `Rule ${n}: no email step has the ref “${r.value ?? ''}”.`;
		} else if (stepRule) {
			const ref = await db
				.prepare("SELECT id FROM automation_steps WHERE id = ? AND automation_id = ? AND type = 'email'")
				.bind(positiveId(r.value) ?? 0, automationId)
				.first<{ id: number }>();
			if (!ref) return `Rule ${n}: that email step no longer exists.`;
		}
		const compiled = stepRule && opts.emailStepRef ? { ...r, value: '1' } : r;
		if (!compileConditionRule(compiled, lists)) return `Rule ${n} isn't a valid condition — check its operator and value.`;
	}
	return null;
}

/**
 * #412: which of these contacts match a rule set (an automation's entry conditions). Same
 * compile rules as `evaluateRules` — a rule that can't be compiled counts as false — but one
 * query per 500 ids instead of one per contact. Order of `contactIds` is kept.
 */
export async function contactsMatchingRules(db: D1Database, set: ConditionRuleSet, contactIds: number[]): Promise<number[]> {
	if (contactIds.length === 0) return [];
	const lists = await loadRuleLists(db, set);
	const parts: string[] = [];
	const binds: unknown[] = [];
	for (const r of set.rules) {
		const c = compileConditionRule(r, lists);
		if (!c) {
			parts.push('0');
			continue;
		}
		parts.push(`(${c.clause})`);
		binds.push(...c.binds);
	}
	const where = parts.length ? parts.join(set.match === 'any' ? ' OR ' : ' AND ') : set.match === 'any' ? '0' : '1';
	const hit = new Set<number>();
	for (let i = 0; i < contactIds.length; i += 500) {
		try {
			const rows = await db
				.prepare(`SELECT c.id FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?)) AND (${where})`)
				.bind(JSON.stringify(contactIds.slice(i, i + 500)), ...binds)
				.all<{ id: number }>();
			for (const r of rows.results) hit.add(r.id);
		} catch (err) {
			console.warn(`entry conditions failed (${err instanceof Error ? err.message : String(err)}) — nobody matches`);
		}
	}
	return contactIds.filter((id) => hit.has(id));
}

const warned = new Set<string>();
function warnOnce(stepId: number | undefined, index: number, r: ConditionRule, why: string) {
	const key = `${stepId ?? '-'}`;
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(`condition step ${stepId ?? '?'}: rule ${index + 1} (${r.field}/${r.op}) ${why} — counted as false`);
}

/**
 * Evaluate a rule set for one contact. `results[i]` is rule i's outcome; `pass` is
 * every rule (`all`) or at least one (`any`). An empty set passes `all` and fails `any`.
 */
export async function evaluateRules(
	db: D1Database,
	contactId: number,
	set: ConditionRuleSet,
	// #516: `enrollmentId` = the pass, so a `form_answer` rule reads the submission that started it.
	opts: { stepId?: number; enrollmentId?: number | null } = {}
): Promise<{ pass: boolean; results: boolean[] }> {
	const lists = await loadRuleLists(db, set);
	const results: boolean[] = set.rules.map(() => false);
	const stmts: { index: number; stmt: D1PreparedStatement }[] = [];
	for (const [i, r] of set.rules.entries()) {
		if (r.field !== 'form_answer') continue;
		try {
			results[i] = await evaluateFormAnswer(db, contactId, r, opts.enrollmentId);
		} catch (err) {
			warnOnce(opts.stepId, i, r, `failed (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	set.rules.forEach((r, i) => {
		if (r.field === 'form_answer') return;
		const c = compileConditionRule(r, lists);
		if (!c) {
			warnOnce(opts.stepId, i, r, "can't be compiled");
			return;
		}
		stmts.push({
			index: i,
			stmt: db.prepare(`SELECT 1 AS hit FROM contacts c WHERE c.id = ? AND (${c.clause}) LIMIT 1`).bind(contactId, ...c.binds)
		});
	});

	if (stmts.length) {
		try {
			const res = await db.batch<{ hit: number }>(stmts.map((s) => s.stmt));
			res.forEach((r, j) => (results[stmts[j].index] = r.results.length > 0));
		} catch {
			// One bad statement fails the batch — run them one by one so only it counts false.
			for (const s of stmts) {
				try {
					results[s.index] = !!(await s.stmt.first<{ hit: number }>());
				} catch (err) {
					warnOnce(opts.stepId, s.index, set.rules[s.index], `failed (${err instanceof Error ? err.message : String(err)})`);
				}
			}
		}
	}

	const pass = set.match === 'any' ? results.some(Boolean) : results.every(Boolean);
	return { pass, results };
}

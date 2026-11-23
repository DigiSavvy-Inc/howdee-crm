// #346: what the assistant writes for an automation → the write layer's vocabulary
// ($lib/automation-spec, #345). The model may name lists, tags, segments, pipeline stages,
// sites and other automations instead of giving ids; they resolve case-insensitively here,
// and an unknown or ambiguous name comes back as a problem listing the candidates. Waits can
// be given as days / hours / minutes; email bodies as Markdown or blocks (./draft-body.ts).
// Also: the card's outline of a whole flow, and readable problem lines.
//
// Read-only: nothing here writes. The tools in ./write-automations.ts call the write layer.

import { getSettings } from '../../settings';
import { validateSpec } from '../../automation-write';
import { triggerSummary } from '$lib/automation-trigger';
import { isEngagementKind } from '$lib/engagement-trigger';
import { triggerEmailNames } from '../../engagement-trigger-read';
import { ruleText, tierActionTitle } from '$lib/automation-action-labels';
import { DEFAULT_WAIT, waitText as flowWaitText, type WaitSpec } from '$lib/automation-flow';
import { specHasLanes, walkSpec, type ActionSpec, type AutomationSpec, type BranchCondition, type SpecProblem, type StepSpec, type TriggerSpec } from '$lib/automation-spec';
import type { ConditionRule } from '$lib/condition-rules';
import { blocksArg, bodyOf } from './draft-body';
import { ToolInputError } from './types';

const WAIT_MAX_SECONDS = 365 * 86400;
const SUGGEST_MAX = 5;

type Named = { id: number; name: string; kind?: string };

type Lookup = {
	what: string; // "list, segment or tag"
	byId: (db: D1Database, id: number) => Promise<Named | null>;
	byName: (db: D1Database, name: string) => Promise<Named[]>;
	like: (db: D1Database, name: string) => Promise<Named[]>;
};

const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function groups(kinds: string[], what: string): Lookup {
	const inKinds = kinds.map(() => '?').join(', ');
	return {
		what,
		byId: (db, id) => db.prepare(`SELECT id, name, kind FROM lists WHERE id = ? AND kind IN (${inKinds})`).bind(id, ...kinds).first<Named>(),
		byName: async (db, name) =>
			(await db.prepare(`SELECT id, name, kind FROM lists WHERE name = ? COLLATE NOCASE AND kind IN (${inKinds}) ORDER BY id`).bind(name, ...kinds).all<Named>()).results,
		like: async (db, name) =>
			(
				await db
					.prepare(`SELECT id, name, kind FROM lists WHERE name LIKE ? ESCAPE '\\' AND kind IN (${inKinds}) ORDER BY name LIMIT ${SUGGEST_MAX}`)
					.bind(likeOf(name), ...kinds)
					.all<Named>()
			).results
	};
}

function table(sql: { table: string; what: string; extraName?: string }): Lookup {
	const match = sql.extraName ? `(name = ? COLLATE NOCASE OR ${sql.extraName} = ? COLLATE NOCASE)` : 'name = ? COLLATE NOCASE';
	const binds = (name: string) => (sql.extraName ? [name, name] : [name]);
	return {
		what: sql.what,
		byId: (db, id) => db.prepare(`SELECT id, name FROM ${sql.table} WHERE id = ?`).bind(id).first<Named>(),
		byName: async (db, name) => (await db.prepare(`SELECT id, name FROM ${sql.table} WHERE ${match} ORDER BY id`).bind(...binds(name)).all<Named>()).results,
		like: async (db, name) =>
			(await db.prepare(`SELECT id, name FROM ${sql.table} WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ${SUGGEST_MAX}`).bind(likeOf(name)).all<Named>()).results
	};
}

/** Trigger lists and list-member conditions: a list, segment or tag. */
const GROUPS = groups(['list', 'segment', 'tag'], 'list, segment or tag');
/** `list` rules (#224/#221) also take a company group. */
const RULE_GROUPS = groups(['list', 'segment', 'tag', 'company'], 'list, segment, tag or company');
/** #444: a "Subscription changes" trigger's topic (a list). */
const TOPIC_LISTS = groups(['list'], 'list');
const STAGES = table({ table: 'pipeline_stages', what: 'pipeline stage' });
const SITES = table({ table: 'tracking_sites', what: 'tracking site', extraName: 'domain' });
const AUTOMATIONS = table({ table: 'automations', what: 'automation' });

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function candidate(n: Named): string {
	return `“${n.name}” (${n.kind ? `${n.kind} ` : ''}#${n.id})`;
}

/** Wait in seconds from `wait_seconds` or `wait_days` / `wait_hours` / `wait_minutes`; null when none given. */
export function waitArg(o: Record<string, unknown>): number | null {
	const parts = ['wait_days', 'wait_hours', 'wait_minutes'];
	if (!has(o, 'wait_seconds') && !parts.some((k) => has(o, k))) return null;
	const n = (k: string) => {
		const v = Number(o[k] ?? 0);
		if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new ToolInputError(`"${k}" must be a whole number, 0 or more.`);
		return v;
	};
	const s = has(o, 'wait_seconds') ? n('wait_seconds') : n('wait_days') * 86400 + n('wait_hours') * 3600 + n('wait_minutes') * 60;
	if (s > WAIT_MAX_SECONDS) throw new ToolInputError('A wait can be at most 365 days.');
	return s;
}

/** Collects problems and tag names while turning the model's input into spec objects. */
export class AutomationInput {
	problems: SpecProblem[] = [];
	private tags = new Map<string, string>();

	constructor(private db: D1Database) {}

	private problem(path: string, message: string) {
		this.problems.push({ path, message });
	}

	private tag(name: unknown) {
		const n = String(name ?? '').trim().slice(0, 60);
		if (n && !this.tags.has(n.toLowerCase())) this.tags.set(n.toLowerCase(), n);
	}

	/** A reference by id or by name → the id, or null (a problem is recorded when it doesn't resolve). */
	private async ref(path: string, lookup: Lookup, value: unknown): Promise<number | null> {
		if (value === undefined || value === null || value === '') return null;
		if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
			const id = Number(value);
			if (await lookup.byId(this.db, id)) return id;
			this.problem(path, `No ${lookup.what} with id ${id}.`);
			return null;
		}
		const name = String(value).trim().slice(0, 200);
		const hits = await lookup.byName(this.db, name);
		if (hits.length === 1) return hits[0].id;
		if (hits.length > 1) {
			this.problem(path, `“${name}” matches several: ${hits.slice(0, SUGGEST_MAX).map(candidate).join(', ')}. Give the id.`);
			return null;
		}
		const near = await lookup.like(this.db, name);
		this.problem(path, `No ${lookup.what} named “${name}”.${near.length ? ` Did you mean ${near.map(candidate).join(', ')}?` : ''}`);
		return null;
	}

	async trigger(raw: unknown, legacy: Record<string, unknown> = {}): Promise<TriggerSpec> {
		const t: Record<string, unknown> = isObj(raw)
			? { ...raw }
			: legacy.trigger_type !== undefined
				? { type: legacy.trigger_type, list_id: legacy.trigger_list_id }
				: { type: 'manual' };
		const out = { ...t } as TriggerSpec & Record<string, unknown>;
		delete out.list;
		delete out.stage;
		delete out.site;
		if (t.type === 'list_added') out.list_id = await this.ref('trigger.list', GROUPS, t.list_id ?? t.list);
		if (t.type === 'pipeline_stage_entered') out.stage_id = await this.ref('trigger.stage', STAGES, t.stage_id ?? t.stage);
		// #412: opens / clicks — the optional list by id or name; emails stay ids (campaign_id / step_id / step_ref).
		if ((t.type === 'email_opened' || t.type === 'email_clicked') && (t.list_id ?? t.list) !== undefined && (t.list_id ?? t.list) !== null) {
			out.list_id = await this.ref('trigger.list', GROUPS, t.list_id ?? t.list);
		}
		// #444: the optional topic of a "Subscription changes" trigger, by id or name.
		if (t.type === 'subscription_changed') {
			delete out.topic;
			const topic = t.topic_list_id ?? t.topic;
			if (topic !== undefined && topic !== null && topic !== 'any') out.topic_list_id = await this.ref('trigger.topic', TOPIC_LISTS, topic);
		}
		if (t.type === 'site_visit' || t.type === 'site_activity') {
			const site = t.site_id ?? t.site;
			out.site_id = site === 'any' ? null : await this.ref('trigger.site', SITES, site);
		}
		return out;
	}

	async condition(raw: unknown, path: string): Promise<BranchCondition> {
		if (!isObj(raw)) return raw as BranchCondition;
		const c = { ...raw } as BranchCondition & Record<string, unknown>;
		delete c.list;
		delete c.stage;
		if (c.kind === 'tag' || c.kind === 'no-tag') this.tag(c.name);
		if (c.kind === 'list-member') c.list_id = await this.ref(`${path}.list`, GROUPS, raw.list_id ?? raw.list);
		if (c.kind === 'pipeline-stage' && (c.mode === undefined || c.mode === 'in')) c.stage_id = await this.ref(`${path}.stage`, STAGES, raw.stage_id ?? raw.stage);
		if (c.kind === 'rules' && Array.isArray(raw.rules)) {
			const rules: ConditionRule[] = [];
			for (let i = 0; i < raw.rules.length; i++) {
				const r = raw.rules[i];
				if (!isObj(r)) {
					rules.push(r as ConditionRule);
					continue;
				}
				const rule = { ...r } as ConditionRule;
				const at = `${path}.rules[${i}]`;
				if (r.field === 'tag') this.tag(r.value);
				if (r.field === 'list') rule.value = String((await this.ref(at, RULE_GROUPS, r.value)) ?? '');
				if (r.field === 'pipeline_stage' && (r.op === 'is' || r.op === 'not')) rule.value = String((await this.ref(at, STAGES, r.value)) ?? '');
				rules.push(rule);
			}
			c.rules = rules;
		}
		return c;
	}

	async action(raw: unknown, path: string): Promise<ActionSpec> {
		if (!isObj(raw)) return raw as ActionSpec;
		const a = { ...raw } as ActionSpec & Record<string, unknown>;
		delete a.automation;
		delete a.stage;
		delete a.only_from_stage;
		if (a.kind === 'enroll_automation' || a.kind === 'end_automation') a.automation_id = await this.ref(`${path}.automation`, AUTOMATIONS, raw.automation_id ?? raw.automation);
		if (a.kind === 'pipeline_move') {
			a.stage_id = await this.ref(`${path}.stage`, STAGES, raw.stage_id ?? raw.stage);
			a.only_from_stage_id = await this.ref(`${path}.only_from_stage`, STAGES, raw.only_from_stage_id ?? raw.only_from_stage);
		}
		return a;
	}

	/** One step. `lanes` = a whole-flow spec (a branch may carry yes / no); else a single step. */
	async step(raw: unknown, path: string, lanes: boolean): Promise<StepSpec> {
		if (!isObj(raw)) return raw as StepSpec;
		const type = (raw.type === undefined ? 'email' : String(raw.type)) as StepSpec['type'];
		const out: StepSpec = { type };
		if (raw.ref !== undefined) out.ref = raw.ref as string;
		try {
			out.wait_seconds = waitArg(raw) ?? 0;
		} catch (e) {
			if (!(e instanceof ToolInputError)) throw e;
			this.problem(path, e.message);
		}
		out.weekday_only = raw.weekday_only === true;
		if (type === 'email') {
			for (const k of ['subject', 'preheader', 'tag_on_open', 'tag_on_click'] as const) if (has(raw, k)) out[k] = raw[k] as string;
			if (typeof raw.from_email === 'string' && raw.from_email.trim()) out.from_email = raw.from_email;
			this.tag(raw.tag_on_open);
			this.tag(raw.tag_on_click);
			try {
				const blocks = blocksArg({ body_blocks: raw.body_blocks, body_markdown: raw.body_markdown ?? raw.body_md });
				if (blocks) {
					const body = bodyOf(blocks);
					out.body_blocks = body.blocks;
					out.body_md = body.md;
				}
			} catch (e) {
				if (!(e instanceof ToolInputError)) throw e;
				this.problem(path, e.message);
			}
		} else if (type === 'tag') {
			out.tag_action = raw.tag_action === 'remove' ? 'remove' : 'add';
			out.tag_name = String(raw.tag_name ?? '');
			if (out.tag_action === 'add') this.tag(raw.tag_name);
		} else if (type === 'branch') {
			out.condition = await this.condition(raw.condition, `${path}.condition`);
		} else if (type === 'action') {
			out.action = await this.action(raw.action, `${path}.action`);
		} else if (type === 'wait') {
			// #625: the WaitSpec as given (the write layer validates it); none = the default delay.
			const wait = (isObj(raw.wait) ? { ...raw.wait } : { ...DEFAULT_WAIT }) as WaitSpec;
			// #626: a rules wait's list / stage names resolve like a Condition step's rules.
			const set = wait.rules as unknown;
			if (wait.mode === 'rules' && isObj(set) && Array.isArray(set.rules)) {
				const c = await this.condition({ kind: 'rules', match: set.match, rules: set.rules }, `${path}.wait.rules`);
				wait.rules = { match: set.match === 'any' ? 'any' : 'all', rules: c.kind === 'rules' ? (c.rules ?? []) : [] };
			}
			out.wait = wait;
		}
		if (raw.yes !== undefined || raw.no !== undefined) {
			if (!lanes) this.problem(path, 'Add the branch first, then add steps to its lanes with parent_step_id + branch_label.');
			else if (!specHasLanes(out)) this.problem(path, 'Only a branch step or an event / rules wait has yes / no lanes.');
			else {
				for (const lane of ['yes', 'no'] as const) {
					const steps = raw[lane];
					if (steps === undefined) continue;
					out[lane] = Array.isArray(steps) ? await this.steps(steps, `${path}.${lane}`) : (steps as StepSpec[]);
				}
			}
		}
		return out;
	}

	async steps(raw: unknown[], base: string): Promise<StepSpec[]> {
		const out: StepSpec[] = [];
		for (let i = 0; i < raw.length; i++) out.push(await this.step(raw[i], `${base}[${i}]`, true));
		return out;
	}

	/** A whole flow: `{ name, trigger, reentry, labels, steps }` (plus the older
	 *  `trigger_type` / `trigger_list_id` of create_automation_draft). */
	async spec(input: Record<string, unknown>): Promise<AutomationSpec> {
		const spec: AutomationSpec = {
			name: typeof input.name === 'string' ? input.name.trim() : '',
			trigger: await this.trigger(input.trigger, input),
			steps: Array.isArray(input.steps) ? await this.steps(input.steps, 'steps') : (input.steps as StepSpec[])
		};
		if (input.reentry !== undefined) spec.reentry = input.reentry as AutomationSpec['reentry'];
		if (input.labels !== undefined) spec.labels = input.labels as string[];
		if (input.entry_rules !== undefined) spec.entry_rules = input.entry_rules as AutomationSpec['entry_rules']; // #412
		return spec;
	}

	/** Tag names used (added, tested, tag-on-open / click) that don't exist yet. */
	async missingTags(): Promise<string[]> {
		const out: string[] = [];
		for (const name of this.tags.values()) {
			const hit = await this.db.prepare("SELECT id FROM lists WHERE kind = 'tag' AND name = ? COLLATE NOCASE").bind(name).first();
			if (!hit) out.push(name);
		}
		return out;
	}
}

/** The default From for email steps that omit one: Settings → Default From. */
export async function defaultFrom(db: D1Database): Promise<string> {
	return (await getSettings(db)).default_from ?? '';
}

export type PreparedSpec = { spec: AutomationSpec; problems: SpecProblem[]; newTags: string[] };

/** Resolve names, then validate the whole flow (nothing is written). A write-layer problem at
 *  a path that already has a resolution problem is dropped (it is the same mistake). */
export async function prepareSpec(db: D1Database, input: Record<string, unknown>): Promise<PreparedSpec> {
	const r = new AutomationInput(db);
	const spec = await r.spec(input);
	const checked = await validateSpec(db, spec, { defaultFrom: await defaultFrom(db) });
	const covered = (p: SpecProblem) => !!p.path && r.problems.some((q) => q.path === p.path || q.path.startsWith(`${p.path}.`));
	const problems = [...r.problems, ...checked.filter((p) => !covered(p))];
	return { spec, problems, newTags: problems.length ? [] : await r.missingTags() };
}

/** `steps[2].yes[0].condition` → "Step 3 › YES step 1". */
export function humanPath(path: string): string {
	const parts: string[] = [];
	for (const m of path.matchAll(/(steps|yes|no)\[(\d+)\]/g)) {
		const n = Number(m[2]) + 1;
		parts.push(m[1] === 'steps' ? `Step ${n}` : `${m[1].toUpperCase()} step ${n}`);
	}
	if (!parts.length) return path ? path.charAt(0).toUpperCase() + path.slice(1) : 'Spec';
	return parts.join(' › ');
}

/** Problems as lines for the model ("Step 1 (steps[0]): Step body is empty."). */
export function problemLines(problems: SpecProblem[]): string {
	return problems.map((p) => `- ${humanPath(p.path)}${p.path && /\[/.test(p.path) ? ` (${p.path})` : ''}: ${p.message}`).join('\n');
}

// ── Outline (the plan card) ──────────────────────────────────────────────────────────────

export function waitText(sec: number): string {
	if (!sec) return 'no wait';
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
	return [part(d, 'day'), part(h, 'hour'), part(m, 'minute')].filter(Boolean).join(' ');
}

type Names = { lists: Map<number, Named>; stages: Map<number, string>; sites: Map<number, string>; automations: Map<number, string> };

async function namesFor(db: D1Database, ids: { lists: number[]; stages: number[]; sites: number[]; automations: number[] }): Promise<Names> {
	const load = async (sql: string, list: number[]) =>
		list.length ? (await db.prepare(sql).bind(JSON.stringify([...new Set(list)])).all<Named>()).results : [];
	const [lists, stages, sites, automations] = await Promise.all([
		load('SELECT id, name, kind FROM lists WHERE id IN (SELECT value FROM json_each(?))', ids.lists),
		load('SELECT id, name FROM pipeline_stages WHERE id IN (SELECT value FROM json_each(?))', ids.stages),
		load('SELECT id, name FROM tracking_sites WHERE id IN (SELECT value FROM json_each(?))', ids.sites),
		load('SELECT id, name FROM automations WHERE id IN (SELECT value FROM json_each(?))', ids.automations)
	]);
	return {
		lists: new Map(lists.map((l) => [l.id, l])),
		stages: new Map(stages.map((s) => [s.id, s.name])),
		sites: new Map(sites.map((s) => [s.id, s.name])),
		automations: new Map(automations.map((a) => [a.id, a.name]))
	};
}

function stepTitle(s: StepSpec): string {
	if (s.type === 'email') return `Email “${s.subject ?? ''}”`;
	if (s.type === 'tag') return `${s.tag_action === 'remove' ? 'Remove' : 'Add'} tag “${s.tag_name ?? ''}”`;
	if (s.type === 'end') return 'End';
	if (s.type === 'branch') return 'Condition';
	if (s.type === 'wait') return flowWaitText(s.wait ?? null); // #625
	return 'Action';
}

/**
 * The whole flow as indented lines: the trigger, then each step (number, wait, what it does),
 * a branch's YES / NO lanes under it. For the plan card and the applied card.
 */
export async function outlineLines(db: D1Database, spec: AutomationSpec): Promise<string[]> {
	const all = walkSpec(spec.steps);
	const ids = { lists: [] as number[], stages: [] as number[], sites: [] as number[], automations: [] as number[] };
	const t = spec.trigger;
	if (t.list_id) ids.lists.push(Number(t.list_id));
	if (t.stage_id) ids.stages.push(Number(t.stage_id));
	if (t.site_id) ids.sites.push(Number(t.site_id));
	for (const { step } of all) {
		const c = step.condition;
		if (c?.list_id) ids.lists.push(Number(c.list_id));
		if (c?.stage_id) ids.stages.push(Number(c.stage_id));
		for (const r of c?.rules ?? []) {
			if (r.field === 'list' && Number(r.value)) ids.lists.push(Number(r.value));
			if (r.field === 'pipeline_stage' && Number(r.value)) ids.stages.push(Number(r.value));
		}
		const a = step.action;
		if (a?.automation_id) ids.automations.push(Number(a.automation_id));
		if (a?.stage_id) ids.stages.push(Number(a.stage_id));
		if (a?.only_from_stage_id) ids.stages.push(Number(a.only_from_stage_id));
	}
	const names = await namesFor(db, ids);

	// Step numbers in depth-first order (the order readSpec numbers refs in).
	const number = new Map<StepSpec, number>();
	const byRef = new Map<string, number>();
	const titles = new Map<number, string>();
	all.forEach(({ step }, i) => {
		number.set(step, i + 1);
		titles.set(i + 1, `${i + 1}. ${stepTitle(step)}`);
		if (step.ref) byRef.set(step.ref, i + 1);
	});
	const stepName = (ref: string | null | undefined) => (ref && byRef.has(ref) ? `«${titles.get(byRef.get(ref)!)}»` : '«(choose a step)»');
	const stage = (id: number | null | undefined) => (id ? (names.stages.get(Number(id)) ?? `#${id}`) : '(choose a stage)');

	const condText = (c: BranchCondition | undefined): string => {
		if (!c) return 'has tag “”';
		if (c.kind === 'rules') {
			const rules = (c.rules ?? []).map((r) => {
				const rule = { ...r };
				if ((r.field === 'step_opened' || r.field === 'step_clicked') && byRef.has(String(r.value ?? ''))) rule.value = String(byRef.get(String(r.value)));
				return ruleText(rule, {
					list: (id) => names.lists.get(id)?.name,
					stage: (id) => names.stages.get(id),
					step: (n) => titles.get(n)
				});
			});
			return rules.join(c.match === 'any' ? ' OR ' : ' AND ');
		}
		const name = c.name ?? '';
		switch (c.kind) {
			case 'tag':
				return `has tag “${name}”`;
			case 'no-tag':
				return `does not have tag “${name}”`;
			case 'field-exists':
				return `field “${name}” is set`;
			case 'field-not-exists':
				return `field “${name}” is empty`;
			case 'field-eq':
				return `field “${name}” = “${c.value ?? ''}”`;
			case 'field-contains':
				return `field “${name}” contains “${c.value ?? ''}”`;
			case 'field-not-contains':
				return `field “${name}” does not contain “${c.value ?? ''}”`;
			case 'list-member': {
				const l = c.list_id ? names.lists.get(Number(c.list_id)) : null;
				return `is in ${l ? `${l.kind} “${l.name}”` : '(choose a list)'}`;
			}
			case 'opened':
				return `opened ${stepName(c.step_ref)}`;
			case 'clicked':
				return `clicked ${stepName(c.step_ref)}`;
			case 'split':
				return `random split, ${Math.min(100, Math.max(0, Math.floor(Number(c.pct) || 50)))}% to YES`;
			case 'company-metric':
				return `company ${c.metric ?? ''} ${c.op ?? ''} ${c.value ?? ''}`;
			case 'visited': {
				const days = Number(c.days) > 0 ? ` in the last ${c.days} days` : '';
				return c.mode === 'event' ? `did «${name}»${days}` : `visited a page containing “${name}”${days}`;
			}
			case 'pipeline-stage':
				return c.mode === 'any' ? 'is in the pipeline' : c.mode === 'none' ? 'is not in the pipeline' : `is in pipeline stage “${stage(c.stage_id)}”`;
			default:
				return String(c.kind);
		}
	};

	const actionText = (a: ActionSpec | undefined): string => {
		const auto = (id: number | null | undefined) => (id ? `“${names.automations.get(Number(id)) ?? `#${id}`}”` : '(choose an automation)');
		switch (a?.kind) {
			case 'end_automation':
				return `End automation ${auto(a.automation_id)}`;
			case 'end_all_automations':
				return 'End all other automations';
			case 'goto_step':
				return `Go to ${stepName(a.step_ref)}`;
			case 'pipeline_move':
				return `Move to pipeline stage “${stage(a.stage_id)}”${a.only_from_stage_id ? ` (only from “${stage(a.only_from_stage_id)}”)` : ''}`;
			case 'pipeline_remove':
				return 'Remove from pipeline';
			case 'set_tier':
				return tierActionTitle(a.tier, a.days);
			case 'adjust_score': // #467
				return `Adjust score #${a.score_id ?? '?'} by ${(a.points ?? 0) > 0 ? '+' : ''}${a.points ?? 0}${a.expires_days ? ` (expires in ${a.expires_days} days)` : ''}`;
			default:
				return `Start automation ${auto(a?.automation_id)}`;
		}
	};

	const lines: string[] = [];
	const lists = [...names.lists.values()].map((l) => ({ id: l.id, name: l.name, kind: l.kind ?? 'list' }));
	lines.push(
		`Trigger: ${triggerSummary(
			{
				trigger_type: t.type,
				trigger_list_id: t.list_id ?? null,
				trigger_metric: t.metric ?? null,
				trigger_direction: t.direction ?? null,
				trigger_threshold: t.threshold ?? null,
				trigger_site_id: t.site_id ?? null,
				trigger_path_op: t.path_op ?? null,
				trigger_path: t.path ?? null,
				trigger_cooldown_hours: t.cooldown_hours ?? null,
				trigger_stage_id: t.stage_id ?? null,
				// #412: the engagement kinds' fields, as stored.
				trigger_config:
					isEngagementKind(t.type) || t.type === 'site_activity' || t.type === 'subscription_changed' || t.type === 'score_changed' || t.type === 'form_submitted'
						? JSON.stringify(t)
						: null,
				reentry: spec.reentry ?? 'once'
			},
			{
				lists,
				sites: [...names.sites].map(([id, name]) => ({ id, name })),
				stages: [...names.stages].map(([id, name]) => ({ id, name })),
				emails: await triggerEmailNames(db, [{ trigger_type: t.type, trigger_config: isEngagementKind(t.type) ? JSON.stringify(t) : null }])
			}
		)}`
	);
	const pad = (level: number) => '  '.repeat(level);
	const lane = (steps: StepSpec[] | undefined, level: number) => {
		for (const s of steps ?? []) {
			const wait = s.wait_seconds ? `Wait ${waitText(s.wait_seconds)}${s.weekday_only ? ' (weekdays)' : ''} → ` : '';
			const what =
				s.type === 'branch'
					? `If ${condText(s.condition)}?`
					: s.type === 'action'
						? actionText(s.action)
						: s.type === 'wait' && s.wait?.mode === 'rules' && s.wait.rules
							? flowWaitText(s.wait, { rulesText: condText({ kind: 'rules', match: s.wait.rules.match, rules: s.wait.rules.rules }) })
							: stepTitle(s);
			lines.push(`${pad(level)}${number.get(s)}. ${wait}${what}`);
			if (specHasLanes(s)) {
				for (const l of ['yes', 'no'] as const) {
					lines.push(`${pad(level + 1)}${s.type === 'wait' ? (l === 'yes' ? 'DID IT' : 'TIMED OUT') : l.toUpperCase()}:`);
					if (!s[l]?.length) lines.push(`${pad(level + 2)}(continues below)`);
					lane(s[l], level + 2);
				}
			}
		}
	};
	lane(spec.steps, 0);
	return lines;
}

/** "7 steps · 3 emails". */
export function stepCountText(spec: AutomationSpec): string {
	const all = walkSpec(spec.steps);
	const emails = all.filter((s) => s.step.type === 'email').length;
	return `${all.length} step${all.length === 1 ? '' : 's'} · ${emails} email${emails === 1 ? '' : 's'}`;
}

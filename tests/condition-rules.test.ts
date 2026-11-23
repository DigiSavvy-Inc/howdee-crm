import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick, addTag } from '../src/lib/server/automations';
import { evaluateRules } from '../src/lib/server/condition-eval';
import { legacyGateToRules, parseGateRules, ruleSetProblem, type ConditionRuleSet } from '../src/lib/condition-rules';
import { conditionLabel, conditionTitle, ruleText } from '../src/lib/automation-action-labels';
import { mergeGroups, renameGroup } from '../src/lib/server/groups-bulk';
import { actions } from '../src/routes/automations/[id]/+page.server';

// #221: compound Condition steps — a rule set (ALL/ANY) on a branch step.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeContact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}

async function makeList(name: string, kind = 'list'): Promise<number> {
	return (await db.prepare('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id').bind(name, kind).first<{ id: number }>())!.id;
}

async function join(listId: number, contactId: number) {
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, contactId).run();
}

async function makeAutomation(status = 'active'): Promise<number> {
	return (await db
		.prepare("INSERT INTO automations (name, status) VALUES ('Rules', ?) RETURNING id")
		.bind(status)
		.first<{ id: number }>())!.id;
}

type StepOpts = { parent?: number; label?: string; delay?: number; rules?: ConditionRuleSet; kind?: string; name?: string; subject?: string };
async function step(aid: number, position: number, type: string, o: StepOpts = {}): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, gate_kind, gate_name,
			    gate_rules, parent_step_id, branch_label)
			 VALUES (?, ?, ?, ?, ?, 'f@x.example.net', ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			aid,
			position,
			o.delay ?? 0,
			o.subject ?? '',
			type === 'email' ? 'hi' : '',
			type,
			o.kind ?? null,
			o.name ?? null,
			o.rules ? JSON.stringify(o.rules) : null,
			o.parent ?? null,
			o.label ?? null
		)
		.first<{ id: number }>())!.id;
}

function actionEvent(automationId: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env },
		params: { id: String(automationId) },
		request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
	} as any;
}

async function drain(maxTicks = 10) {
	for (let i = 0; i < maxTicks; i++) if ((await tick(db, cfg)).processed === 0) return;
}

describe('evaluateRules (#221)', () => {
	it('all / any over list membership + email contains + has-tag', async () => {
		const newsletter = await makeList('Newsletter');
		const both = await makeContact('ann@acme.example.net');
		const some = await makeContact('bob@other.example.net');
		await join(newsletter, both);
		await join(newsletter, some);
		await addTag(db, 'VIP', both); // tag names match case-insensitively
		await addTag(db, 'vip', some);

		const rules = [
			{ field: 'list', op: 'in', value: String(newsletter) },
			{ field: 'email', op: 'contains', value: '@acme' },
			{ field: 'tag', op: 'has', value: 'vip' }
		];
		const all: ConditionRuleSet = { match: 'all', rules };
		const any: ConditionRuleSet = { match: 'any', rules };

		expect(await evaluateRules(db, both, all)).toEqual({ pass: true, results: [true, true, true] });
		expect(await evaluateRules(db, some, all)).toEqual({ pass: false, results: [true, false, true] });
		expect((await evaluateRules(db, some, any)).pass).toBe(true);

		const stranger = await makeContact('zed@nowhere.example.net');
		expect(await evaluateRules(db, stranger, any)).toEqual({ pass: false, results: [false, false, false] });
	});

	it('an unknown kind (or a deleted list) counts as false', async () => {
		const c = await makeContact('a@acme.example.net');
		const res = await evaluateRules(
			db,
			c,
			{
				match: 'any',
				rules: [
					{ field: 'bogus', op: 'is', value: 'x' },
					{ field: 'list', op: 'in', value: '999999' },
					{ field: 'email', op: 'ends', value: 'acme.example.net' }
				]
			},
			{ stepId: 1 }
		);
		expect(res.results).toEqual([false, false, true]);
		expect(res.pass).toBe(true);
		expect((await evaluateRules(db, c, { match: 'all', rules: [{ field: 'bogus', op: 'is' }] })).pass).toBe(false);
	});

	it('resolves a dynamic segment and negated rules', async () => {
		const seg = (await db
			.prepare("INSERT INTO lists (name, kind, rules) VALUES ('Acme people', 'segment', ?) RETURNING id")
			.bind(JSON.stringify({ match: 'all', rules: [{ field: 'source', op: 'is', value: 'acme' }] }))
			.first<{ id: number }>())!.id;
		const c = await makeContact('x@y.example.net');
		await db.prepare("UPDATE contacts SET source = 'acme', meta = '{\"plan\":\"Pro Annual\"}' WHERE id = ?").bind(c).run();
		const res = await evaluateRules(db, c, {
			match: 'all',
			rules: [
				{ field: 'list', op: 'in', value: String(seg) },
				{ field: 'tag', op: 'not', value: 'vip' },
				{ field: 'field_contains', op: 'contains', value: 'annual', value2: 'plan' },
				{ field: 'email', op: 'not_contains', value: 'acme' }
			]
		});
		expect(res.results).toEqual([true, true, true, true]);
	});
});

describe('Condition step with a rule set in the tick (#221)', () => {
	it('acceptance: wait 4 days → all{list, email contains, tag} → YES email / NO end', async () => {
		const newsletter = await makeList('Newsletter');
		const aid = await makeAutomation();
		const cond = await step(aid, 0, 'branch', {
			delay: 4 * 86400,
			rules: {
				match: 'all',
				rules: [
					{ field: 'list', op: 'in', value: String(newsletter) },
					{ field: 'email', op: 'contains', value: '@acme' },
					{ field: 'tag', op: 'has', value: 'vip' }
				]
			}
		});
		const email = await step(aid, 0, 'email', { parent: cond, label: 'yes', subject: 'Hello VIP', delay: 86400 });
		await step(aid, 0, 'end', { parent: cond, label: 'no' });

		const yes = await makeContact('ann@acme.example.net');
		const no = await makeContact('bob@acme.example.net');
		await join(newsletter, yes);
		await join(newsletter, no);
		await addTag(db, 'vip', yes);
		await enroll(db, aid, [yes, no]);
		// The 4-day wait has elapsed.
		await db.prepare("UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute')").run();
		await drain();

		const rows = await db
			.prepare('SELECT contact_id, status, current_step_id FROM automation_enrollments WHERE automation_id = ?')
			.bind(aid)
			.all<{ contact_id: number; status: string; current_step_id: number | null }>();
		const byContact = new Map(rows.results.map((r) => [r.contact_id, r]));
		expect(byContact.get(yes)).toMatchObject({ status: 'active', current_step_id: email });
		expect(byContact.get(no)?.status).toBe('completed');

		const hits = await db
			.prepare('SELECT label, COUNT(*) AS n FROM automation_branch_hits WHERE step_id = ? GROUP BY label ORDER BY label')
			.bind(cond)
			.all<{ label: string; n: number }>();
		expect(hits.results).toEqual([
			{ label: 'no', n: 1 },
			{ label: 'yes', n: 1 }
		]);
	});

	it('a legacy single gate (gate_rules NULL) still evaluates', async () => {
		const aid = await makeAutomation();
		const cond = await step(aid, 0, 'branch', { kind: 'tag', name: 'hot' });
		const yesStep = await step(aid, 0, 'email', { parent: cond, label: 'yes', subject: 'Hot', delay: 86400 });
		await step(aid, 0, 'end', { parent: cond, label: 'no' });
		const hot = await makeContact('hot@x.example.net');
		const cold = await makeContact('cold@x.example.net');
		await addTag(db, 'hot', hot);
		await enroll(db, aid, [hot, cold]);
		await drain();
		const r = await db
			.prepare('SELECT contact_id, status, current_step_id FROM automation_enrollments ORDER BY contact_id')
			.all<{ contact_id: number; status: string; current_step_id: number | null }>();
		expect(r.results.find((x) => x.contact_id === hot)).toMatchObject({ status: 'active', current_step_id: yesStep });
		expect(r.results.find((x) => x.contact_id === cold)?.status).toBe('completed');
	});
});

describe('editor save + duplicate (#221)', () => {
	it('updateStep saves a rule set and clears the legacy columns; an empty set is rejected', async () => {
		const list = await makeList('Newsletter');
		const aid = await makeAutomation('draft');
		const cond = await step(aid, 0, 'branch', { kind: 'tag', name: 'old' });
		const set = { match: 'any', rules: [{ field: 'list', op: 'in', value: String(list) }, { field: 'email', op: 'ends', value: '@acme.example.net' }] };

		const ok = await actions.updateStep(
			actionEvent(aid, { step_id: String(cond), delay_value: '4', delay_unit: 'days', gate_mode: 'rules', gate_rules: JSON.stringify(set) })
		);
		expect(ok).toMatchObject({ ok: true, savedStep: cond });
		const row = await db
			.prepare('SELECT gate_rules, gate_kind, gate_name, delay_before_seconds FROM automation_steps WHERE id = ?')
			.bind(cond)
			.first<{ gate_rules: string; gate_kind: string | null; gate_name: string | null; delay_before_seconds: number }>();
		expect(parseGateRules(row!.gate_rules)).toEqual(set);
		expect(row!.gate_kind).toBeNull();
		expect(row!.gate_name).toBeNull();
		expect(row!.delay_before_seconds).toBe(4 * 86400);

		const empty: any = await actions.updateStep(
			actionEvent(aid, { step_id: String(cond), delay_value: '0', delay_unit: 'days', gate_mode: 'rules', gate_rules: JSON.stringify({ match: 'all', rules: [] }) })
		);
		expect(empty.status).toBe(400);
		expect(empty.data.error).toMatch(/at least one rule/i);

		const incomplete: any = await actions.updateStep(
			actionEvent(aid, {
				step_id: String(cond),
				delay_value: '0',
				delay_unit: 'days',
				gate_mode: 'rules',
				gate_rules: JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: 'vip' }, { field: 'email', op: 'contains', value: '' }] })
			})
		);
		expect(incomplete.status).toBe(400);
		expect(incomplete.data.error).toMatch(/Rule 2/);

		const missingList: any = await actions.updateStep(
			actionEvent(aid, {
				step_id: String(cond),
				delay_value: '0',
				delay_unit: 'days',
				gate_mode: 'rules',
				gate_rules: JSON.stringify({ match: 'all', rules: [{ field: 'list', op: 'in', value: '999999' }] })
			})
		);
		expect(missingList.status).toBe(400);
		// The saved set is unchanged by the rejected posts.
		const after = await db.prepare('SELECT gate_rules FROM automation_steps WHERE id = ?').bind(cond).first<{ gate_rules: string }>();
		expect(parseGateRules(after!.gate_rules)).toEqual(set);

		// Switching to an A/B split clears the rule set.
		await actions.updateStep(actionEvent(aid, { step_id: String(cond), delay_value: '0', delay_unit: 'days', gate_mode: 'split', gate_kind: 'split', split_pct: '30' }));
		const split = await db.prepare('SELECT gate_rules, gate_kind, split_pct FROM automation_steps WHERE id = ?').bind(cond).first<any>();
		expect(split).toMatchObject({ gate_rules: null, gate_kind: 'split', split_pct: 30 });
	});

	it('duplicate automation copies gate_rules with email-step refs remapped', async () => {
		const list = await makeList('Newsletter');
		const aid = await makeAutomation();
		const email = await step(aid, 0, 'email', { subject: 'Welcome' });
		const set = {
			match: 'all',
			rules: [
				{ field: 'step_opened', op: 'yes', value: String(email) },
				{ field: 'list', op: 'in', value: String(list) }
			]
		};
		await step(aid, 1, 'branch', { rules: set as ConditionRuleSet });

		let location = '';
		try {
			await actions.duplicate(actionEvent(aid, {}));
		} catch (r: any) {
			location = r?.location ?? '';
		}
		const newId = Number(location.split('/').pop());
		const steps = await db
			.prepare('SELECT id, type, gate_rules FROM automation_steps WHERE automation_id = ?')
			.bind(newId)
			.all<{ id: number; type: string; gate_rules: string | null }>();
		const newEmail = steps.results.find((s) => s.type === 'email')!;
		const newBranch = steps.results.find((s) => s.type === 'branch')!;
		expect(parseGateRules(newBranch.gate_rules)).toEqual({
			match: 'all',
			rules: [
				{ field: 'step_opened', op: 'yes', value: String(newEmail.id) },
				{ field: 'list', op: 'in', value: String(list) }
			]
		});
	});
});

describe('group rename/merge follow rule sets (#221)', () => {
	it('rewrites tag names and repoints merged lists inside gate_rules', async () => {
		const tag = await makeList('vip', 'tag');
		const a = await makeList('List A');
		const b = await makeList('List B');
		const aid = await makeAutomation();
		const cond = await step(aid, 0, 'branch', {
			rules: { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'VIP' }, { field: 'list', op: 'in', value: String(b) }] }
		});
		expect((await renameGroup(db, tag, 'very-important')).ok).toBe(true);
		expect((await mergeGroups(db, { intoId: a }, [b], 'list')).ok).toBe(true);
		const row = await db.prepare('SELECT gate_rules FROM automation_steps WHERE id = ?').bind(cond).first<{ gate_rules: string }>();
		expect(parseGateRules(row!.gate_rules)?.rules).toEqual([
			{ field: 'tag', op: 'has', value: 'very-important' },
			{ field: 'list', op: 'in', value: String(a) }
		]);
	});
});

describe('rule-set vocabulary (#221)', () => {
	it('maps a legacy single gate to a one-rule set', () => {
		expect(legacyGateToRules({ gate_kind: 'no-tag', gate_name: 'x', gate_value: null, gate_ref_id: null })).toEqual({
			match: 'all',
			rules: [{ field: 'tag', op: 'not', value: 'x' }]
		});
		expect(legacyGateToRules({ gate_kind: 'list-member', gate_name: null, gate_value: null, gate_ref_id: 7 })?.rules[0]).toEqual({
			field: 'list',
			op: 'in',
			value: '7'
		});
		expect(legacyGateToRules({ gate_kind: 'visited', gate_name: '/pricing', gate_value: 'page:7', gate_ref_id: null })?.rules[0]).toEqual({
			field: 'visited',
			op: 'in',
			value: '/pricing',
			value2: '7'
		});
		expect(legacyGateToRules({ gate_kind: 'split', gate_name: null, gate_value: null, gate_ref_id: null })).toBeNull();
	});

	it('validates and labels a set', () => {
		expect(ruleSetProblem({ match: 'all', rules: [] })).toMatch(/at least one/);
		expect(ruleSetProblem({ match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }] })).toMatch(/Rule 1/);
		const set: ConditionRuleSet = {
			match: 'all',
			rules: [
				{ field: 'list', op: 'in', value: '3' },
				{ field: 'email', op: 'contains', value: '@acme' },
				{ field: 'tag', op: 'has', value: 'vip' }
			]
		};
		const names = { list: (id: number) => (id === 3 ? 'Newsletter' : null) };
		expect(ruleText(set.rules[1])).toBe('email contains “@acme”');
		expect(conditionLabel(set, names)).toBe('is in “Newsletter” +2 more (all)');
		expect(conditionLabel({ match: 'any', rules: [set.rules[2]] })).toBe('has tag “vip”?');
		expect(conditionTitle(set, names)).toBe('Match all of:\n• is in “Newsletter”\n• email contains “@acme”\n• has tag “vip”');
	});
});

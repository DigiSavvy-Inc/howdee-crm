import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	deleteGroups,
	dynamicMemberCount,
	groupRuleRefs,
	healDanglingListRules,
	invalidateGroupRules
} from '../src/lib/server/groups-bulk';
import { compileSegment, parseRules } from '../src/lib/server/segment-query';
import { conditionRulesProblem, evaluateRules } from '../src/lib/server/condition-eval';
import { DELETED_LIST, isDeletedListRule, normalizeRuleSet, parseGateRules } from '../src/lib/condition-rules';
import { ruleText } from '../src/lib/automation-action-labels';
import { actions } from '../src/routes/groups/[kind]/+page.server';

// #228: "in / not in group" rules (segments #224, Condition rule sets #221) whose group was
// deleted are marked invalid — listed in the delete modal, ignored when compiled.
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function group(name: string, kind: string, rules: unknown = null): Promise<number> {
	return (await db
		.prepare('INSERT INTO lists (name, kind, rules) VALUES (?, ?, ?) RETURNING id')
		.bind(name, kind, rules === null ? null : JSON.stringify(rules))
		.first<{ id: number }>())!.id;
}

async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}

async function add(listId: number, ...contactIds: number[]) {
	for (const c of contactIds) {
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c).run();
	}
}

async function automation(name: string): Promise<number> {
	return (await db
		.prepare("INSERT INTO automations (name, status, trigger_type) VALUES (?, 'draft', 'manual') RETURNING id")
		.bind(name)
		.first<{ id: number }>())!.id;
}

async function ruleStep(automationId: number, rules: unknown): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, type, gate_rules, subject, body_md, from_email)
			 VALUES (?, 0, 'branch', ?, '', '', '') RETURNING id`
		)
		.bind(automationId, JSON.stringify(rules))
		.first<{ id: number }>())!.id;
}

async function legacyStep(automationId: number, listId: number): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, type, gate_kind, gate_ref_id, subject, body_md, from_email)
			 VALUES (?, 1, 'branch', 'list-member', ?, '', '', '') RETURNING id`
		)
		.bind(automationId, listId)
		.first<{ id: number }>())!.id;
}

async function segRules(id: number) {
	return parseRules((await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(id).first<{ rules: string }>())!.rules)!;
}

async function stepRow(id: number) {
	return (await db
		.prepare('SELECT gate_kind, gate_ref_id, gate_rules FROM automation_steps WHERE id = ?')
		.bind(id)
		.first<{ gate_kind: string | null; gate_ref_id: number | null; gate_rules: string | null }>())!;
}

function formEvent(kind: string, action: string, fields: [string, string][]) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test/groups/${kind}?/${action}`);
	return {
		platform: { env },
		params: { kind },
		url,
		locals: { user: { id: 2, role: 'member' } },
		request: new Request(url, { method: 'POST', body: fd })
	} as any;
}

describe('compiling a rule marked invalid', () => {
	it('leaves it out of a segment; only-invalid rules select nobody', () => {
		const set = {
			match: 'all' as const,
			rules: [
				{ field: 'subscribed', op: 'yes' },
				{ field: 'list', op: 'in', value: '9', invalid: DELETED_LIST }
			]
		};
		const c = compileSegment(set);
		expect(c.sql).toBe('SELECT c.id FROM contacts c WHERE c.archived_at IS NULL AND ((c.subscribed = ?))');
		expect(c.binds).toEqual([1]);
		expect(compileSegment({ match: 'all', rules: [set.rules[1]] }).sql).toContain('0=1');
		expect(compileSegment({ match: 'all', rules: [] }).sql).toContain('1=1');
	});

	it('survives rule-set normalisation and labels as a deleted list', () => {
		const set = normalizeRuleSet({ match: 'all', rules: [{ field: 'list', op: 'not', value: '4', invalid: DELETED_LIST, x: 1 }] })!;
		expect(set.rules[0]).toEqual({ field: 'list', op: 'not', value: '4', invalid: DELETED_LIST });
		expect(isDeletedListRule(set.rules[0])).toBe(true);
		expect(ruleText(set.rules[0])).toBe('is not in (deleted list)');
	});
});

describe('deleting a group (#228)', () => {
	it('lists, then marks, the segment rules and conditions that use it', async () => {
		const gone = await group('Old list', 'list');
		const kept = await group('Kept', 'list');
		const seg = await group('Seg', 'segment', {
			match: 'all',
			rules: [
				{ field: 'subscribed', op: 'yes' },
				{ field: 'list', op: 'not', value: String(gone) },
				{ field: 'list', op: 'in', value: String(kept) }
			]
		});
		const auto = await automation('Flow');
		const rs = await ruleStep(auto, { match: 'any', rules: [{ field: 'list', op: 'in', value: String(gone) }, { field: 'tag', op: 'has', value: 'x' }] });
		const legacy = await legacyStep(auto, gone);

		const refs = await groupRuleRefs(db, [gone]);
		expect(refs.filter((r) => r.kind === 'segment')).toEqual([{ groupId: gone, kind: 'segment', id: seg, name: 'Seg', automationId: null }]);
		expect(refs.filter((r) => r.kind === 'condition').map((r) => r.id).sort()).toEqual([rs, legacy].sort());
		expect(refs.every((r) => r.kind === 'segment' || r.automationId === auto)).toBe(true);
		expect(await groupRuleRefs(db, [kept])).toHaveLength(1);

		const res = await deleteGroups(db, [gone], 'list');
		expect(res.deleted).toBe(1);
		expect(res.rulesInvalidated).toEqual({ segmentRules: 1, conditions: 2 });

		const rules = await segRules(seg);
		expect(rules.rules[1]).toEqual({ field: 'list', op: 'not', value: String(gone), invalid: DELETED_LIST });
		expect(rules.rules[2].invalid).toBeUndefined();

		const set = parseGateRules((await stepRow(rs)).gate_rules)!;
		expect(set.rules[0].invalid).toBe(DELETED_LIST);
		expect(set.rules[1].invalid).toBeUndefined();

		const lg = await stepRow(legacy);
		expect(lg.gate_kind).toBeNull();
		expect(lg.gate_ref_id).toBeNull();
		expect(parseGateRules(lg.gate_rules)).toEqual({
			match: 'all',
			rules: [{ field: 'list', op: 'in', value: String(gone), invalid: DELETED_LIST }]
		});

		// Nothing left to list or mark.
		expect(await groupRuleRefs(db, [gone])).toEqual([]);
		expect(await invalidateGroupRules(db, [gone])).toEqual({ segmentRules: 0, conditions: 0 });
	});

	it('the ignored rule no longer narrows the segment; a condition counts it false', async () => {
		const gone = await group('Old', 'list');
		const kept = await group('Kept', 'list');
		const [a, b] = [await contact('a@x.example.net'), await contact('b@x.example.net')];
		await add(gone, a);
		await add(kept, a, b);
		const seg = await group('Seg', 'segment', {
			match: 'all',
			rules: [
				{ field: 'list', op: 'in', value: String(kept) },
				{ field: 'list', op: 'in', value: String(gone) }
			]
		});
		const only = await group('Only', 'segment', { match: 'all', rules: [{ field: 'list', op: 'in', value: String(gone) }] });
		expect(await dynamicMemberCount(db, JSON.stringify(await segRules(seg)))).toBe(1);

		await deleteGroups(db, [gone], 'list');
		expect(await dynamicMemberCount(db, JSON.stringify(await segRules(seg)))).toBe(2);
		expect(await dynamicMemberCount(db, JSON.stringify(await segRules(only)))).toBe(0);

		const auto = await automation('Flow');
		const step = await ruleStep(auto, { match: 'all', rules: [{ field: 'list', op: 'not', value: String(gone), invalid: DELETED_LIST }] });
		const set = parseGateRules((await stepRow(step)).gate_rules)!;
		expect(await evaluateRules(db, b, set, { stepId: step })).toEqual({ pass: false, results: [false] });
		expect(await conditionRulesProblem(db, auto, set)).toMatch(/deleted/);
	});

	it('the delete action reports the marked rules', async () => {
		const gone = await group('Old', 'tag');
		await group('Seg', 'segment', { match: 'all', rules: [{ field: 'list', op: 'in', value: String(gone) }] });
		const res = await actions.delete(formEvent('tag', 'delete', [['id', String(gone)]]));
		expect((res as { bulkMessage: string }).bulkMessage).toContain('Marked 1 segment rule as using a deleted list.');
	});
});

describe('healDanglingListRules', () => {
	it('marks a list rule whose group is already gone', async () => {
		const seg = await group('Seg', 'segment', {
			match: 'all',
			rules: [
				{ field: 'list', op: 'in', value: '987654' },
				{ field: 'subscribed', op: 'yes' }
			]
		});
		expect(await healDanglingListRules(db, await segRules(seg))).toBe(true);
		const rules = await segRules(seg);
		expect(rules.rules.filter(isDeletedListRule)).toHaveLength(1);
		expect(await healDanglingListRules(db, rules)).toBe(false);
	});
});

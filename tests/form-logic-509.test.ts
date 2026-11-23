import { describe, it, expect } from 'vitest';
import {
	evaluateRule,
	evaluateRuleSet,
	formPath,
	normalizeRuleSet,
	opLabel,
	opsForKind,
	ruleFieldKind,
	ruleSetText,
	visibleFields,
	type FormRule
} from '../src/lib/form-logic';

// #509: form rule ops, rule sets and visibleFields.

const answers = { color: 'Blue', tags: ['a', 'B'], age: 30, note: 'Hello World', agree: true, empty: '' };

describe('evaluateRule ops', () => {
	const cases: [FormRule, boolean][] = [
		[{ field: 'color', op: 'eq', value: 'blue' }, true],
		[{ field: 'color', op: 'eq', value: 'red' }, false],
		[{ field: 'tags', op: 'eq', value: 'b' }, true],
		[{ field: 'color', op: 'neq', value: 'red' }, true],
		[{ field: 'color', op: 'neq', value: 'Blue' }, false],
		[{ field: 'missing', op: 'neq', value: 'x' }, true],
		[{ field: 'color', op: 'in', value: ['red', 'BLUE'] }, true],
		[{ field: 'color', op: 'in', value: 'red, green' }, false],
		[{ field: 'tags', op: 'in', value: ['z', 'a'] }, true],
		[{ field: 'note', op: 'contains', value: 'world' }, true],
		[{ field: 'note', op: 'contains', value: 'moon' }, false],
		[{ field: 'note', op: 'contains', value: '' }, false],
		[{ field: 'tags', op: 'contains', value: 'a' }, true],
		[{ field: 'age', op: 'gt', value: '18' }, true],
		[{ field: 'age', op: 'gt', value: 30 }, false],
		[{ field: 'age', op: 'lt', value: 31 }, true],
		[{ field: 'color', op: 'lt', value: 5 }, false],
		[{ field: 'empty', op: 'empty' }, true],
		[{ field: 'missing', op: 'empty' }, true],
		[{ field: 'tags', op: 'empty' }, false],
		[{ field: 'color', op: 'not_empty' }, true],
		[{ field: 'empty', op: 'not_empty' }, false],
		[{ field: 'agree', op: 'checked' }, true],
		[{ field: 'missing', op: 'checked' }, false],
		[{ field: 'missing', op: 'unchecked' }, true],
		[{ field: 'agree', op: 'unchecked' }, false]
	];
	for (const [rule, want] of cases) {
		it(`${rule.field} ${rule.op} ${JSON.stringify(rule.value ?? '')} → ${want}`, () => {
			expect(evaluateRule(rule, answers)).toBe(want);
		});
	}

	it('reads contact values with contact:', () => {
		expect(evaluateRule({ field: 'contact:tags', op: 'contains', value: 'vip' }, {}, { tags: ['vip'] })).toBe(true);
		expect(evaluateRule({ field: 'contact:first_name', op: 'not_empty' }, {}, null)).toBe(false);
	});
});

describe('evaluateRuleSet', () => {
	it('null or empty is true; all / any', () => {
		expect(evaluateRuleSet(null, {})).toBe(true);
		const all = { match: 'all' as const, rules: [{ field: 'color', op: 'eq' as const, value: 'blue' }, { field: 'age', op: 'gt' as const, value: 40 }] };
		expect(evaluateRuleSet(all, answers)).toBe(false);
		expect(evaluateRuleSet({ ...all, match: 'any' }, answers)).toBe(true);
	});

	it('normalizeRuleSet drops junk', () => {
		expect(normalizeRuleSet(null)).toBeNull();
		expect(normalizeRuleSet({ rules: [] })).toBeNull();
		expect(normalizeRuleSet({ match: 'x', rules: [{ field: 'a', op: 'bogus' }, { field: 'a', op: 'empty', value: 'ignored' }] })).toEqual({
			match: 'all',
			rules: [{ field: 'a', op: 'empty' }]
		});
	});
});

describe('visibleFields', () => {
	const fields = [
		{ id: '1', key: 'role', show_when: null },
		{ id: '2', key: 'team', show_when: { match: 'all' as const, rules: [{ field: 'role', op: 'eq' as const, value: 'manager' }] } },
		{ id: '3', key: 'size', show_when: { match: 'all' as const, rules: [{ field: 'team', op: 'not_empty' as const }] } }
	];
	it('shows dependants only when their rule holds', () => {
		expect(visibleFields({ fields }, { role: 'manager', team: 'Ops' }).map((f) => f.id)).toEqual(['1', '2', '3']);
	});
	it('a hidden question hides what depends on it, even with a stale answer', () => {
		expect(visibleFields({ fields }, { role: 'ic', team: 'Ops' }).map((f) => f.id)).toEqual(['1']);
	});
});

// #514: page jumps (formPath) and the "Known contact" rule fields.
describe('formPath (#514)', () => {
	type F = { id: string; type: 'short_text' | 'radio' | 'page_break'; key: string; show_when: null };
	const f = (id: string, type: F['type'], key = ''): F => ({ id, type, key, show_when: null });
	const fields: F[] = [
		f('a', 'radio', 'plan'),
		f('p2', 'page_break'),
		f('b', 'short_text', 'team'),
		f('p3', 'page_break'),
		f('c', 'short_text', 'budget'),
		f('p4', 'page_break'),
		f('d', 'short_text', 'note')
	];
	const when = (value: string) => ({ match: 'all' as const, rules: [{ field: 'plan', op: 'eq' as const, value }] });

	it('no jumps: every page in order', () => {
		expect(formPath({ fields }, {}).pages).toEqual([0, 1, 2, 3]);
	});

	it('follows the first matching jump and skips the pages between', () => {
		const pages = [{ id: 'start', next: [{ when: when('free'), goto: 'p4' }, { when: when('pro'), goto: 'p3' }] }];
		const free = formPath({ fields, pages }, { plan: 'free', team: 'x', budget: '9' });
		expect(free.pages).toEqual([0, 3]);
		expect(free.fields.map((x) => x.id)).toEqual(['a', 'p4', 'd']);
		expect(formPath({ fields, pages }, { plan: 'pro' }).pages).toEqual([0, 2, 3]);
		expect(formPath({ fields, pages }, { plan: 'other' }).pages).toEqual([0, 1, 2, 3]);
	});

	it('chains jumps across pages; end = straight to submit', () => {
		const pages = [
			{ id: 'start', next: [{ when: when('pro'), goto: 'p3' }] },
			{ id: 'p3', next: [{ when: { match: 'all' as const, rules: [{ field: 'budget', op: 'gt' as const, value: 100 }] }, goto: 'end' }] }
		];
		expect(formPath({ fields, pages }, { plan: 'pro', budget: 500 }).pages).toEqual([0, 2]);
		expect(formPath({ fields, pages }, { plan: 'pro', budget: 5 }).pages).toEqual([0, 2, 3]);
		// A jump never reads a skipped page's stale answer.
		const p2 = [{ id: 'p2', next: [{ when: { match: 'all' as const, rules: [{ field: 'team', op: 'not_empty' as const }] }, goto: 'end' }] }, ...pages];
		expect(formPath({ fields, pages: p2 }, { plan: 'pro', team: 'stale', budget: 5 }).pages).toEqual([0, 2, 3]);
	});

	it('an unconditional jump is always taken; a backwards or unknown target goes to the next page', () => {
		expect(formPath({ fields, pages: [{ id: 'start', next: [{ when: null, goto: 'p4' }] }] }, {}).pages).toEqual([0, 3]);
		expect(formPath({ fields, pages: [{ id: 'p3', next: [{ when: null, goto: 'start' }] }] }, {}).pages).toEqual([0, 1, 2, 3]);
		expect(formPath({ fields, pages: [{ id: 'start', next: [{ when: null, goto: 'nope' }] }] }, {}).pages).toEqual([0, 1, 2, 3]);
	});
});

describe('contact rules (#514)', () => {
	const contact = { has_tag: ['vip', 'lead'], in_list: ['7'], 'field:plan': 'Pro' };
	it('has tag / in list / custom field', () => {
		expect(evaluateRule({ field: 'contact.has_tag', op: 'eq', value: 'VIP' }, {}, contact)).toBe(true);
		expect(evaluateRule({ field: 'contact.has_tag', op: 'neq', value: 'vip' }, {}, contact)).toBe(false);
		expect(evaluateRule({ field: 'contact.has_tag', op: 'neq', value: 'cold' }, {}, contact)).toBe(true);
		expect(evaluateRule({ field: 'contact.in_list', op: 'eq', value: '7' }, {}, contact)).toBe(true);
		expect(evaluateRule({ field: 'contact.in_list', op: 'eq', value: '8' }, {}, contact)).toBe(false);
		expect(evaluateRule({ field: 'contact.field:plan', op: 'eq', value: 'pro' }, {}, contact)).toBe(true);
		expect(evaluateRule({ field: 'contact.field:plan', op: 'empty' }, {}, contact)).toBe(false);
	});
	it('every contact rule is false without a contact, negations included', () => {
		for (const op of ['eq', 'neq', 'empty', 'not_empty'] as const) {
			expect(evaluateRule({ field: 'contact.has_tag', op, value: 'vip' }, {}, null)).toBe(false);
			expect(evaluateRule({ field: 'contact.field:plan', op, value: 'x' }, {}, undefined)).toBe(false);
		}
		expect(evaluateRuleSet({ match: 'any', rules: [{ field: 'contact.in_list', op: 'neq', value: '1' }] }, {}, null)).toBe(false);
	});
	it('ops and words per field kind', () => {
		expect(ruleFieldKind('contact.has_tag')).toBe('tag');
		expect(ruleFieldKind('contact.in_list')).toBe('list');
		expect(ruleFieldKind('contact.field:x')).toBe('contact_field');
		expect(ruleFieldKind('q', { type: 'rating' })).toBe('number');
		expect(ruleFieldKind('q', { type: 'consent' })).toBe('tick');
		expect(ruleFieldKind('q', { type: 'select' })).toBe('choice');
		expect(opsForKind('tag')).toEqual(['eq', 'neq']);
		expect(opsForKind('tick')).toEqual(['checked', 'unchecked']);
		expect(opLabel('eq', 'tag')).toBe('has');
		const set = { match: 'any' as const, rules: [{ field: 'role', op: 'eq' as const, value: 'mgr' }, { field: 'ok', op: 'checked' as const }] };
		expect(ruleSetText(set, (k) => k.toUpperCase())).toBe('ROLE is “mgr” or OK is ticked');
	});
});

import { describe, it, expect } from 'vitest';
import {
	FORM_LIMITS,
	blankField,
	emptyForm,
	normalizeFormSpec,
	pageLabel,
	pagesOf,
	validateFormSpec,
	type FormField,
	type FormSpec
} from '../src/lib/forms';
import type { FormRuleSet } from '../src/lib/form-logic';

// #514: the Logic tab's validator rules (show-when ordering, page jumps, outcome rules, the new
// actions) and the new spec fields round-tripping through normalizeFormSpec.

function q(type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField {
	return { ...blankField(type, label), key, ...extra };
}
// An explicit undefined value means "no value" (a default parameter would turn it back into 'x').
const rule = (field: string, op = 'eq', ...rest: [value?: string]): FormRuleSet => {
	const value = rest.length > 0 ? rest[0] : 'x';
	return { match: 'all', rules: [value === undefined ? { field, op } : { field, op, value }] } as FormRuleSet;
};
function form(fields: FormField[], mutate: (s: FormSpec) => void = () => {}): FormSpec {
	const s = emptyForm('Logic');
	s.fields.push(...fields);
	s.pages = pagesOf(s.fields, s.title);
	mutate(s);
	return s;
}
const problems = (s: FormSpec) => validateFormSpec(s);
const at = (s: FormSpec, path: string) => problems(s).filter((p) => p.path === path).map((p) => p.message);

describe('show when: ordering', () => {
	it('a rule may read a question before it', () => {
		const s = form([q('radio', 'Role', 'role', { options: [{ value: 'x', label: 'X' }] }), q('short_text', 'Team', 'team', { show_when: rule('role') })]);
		expect(problems(s)).toEqual([]);
	});

	it('a rule on itself or a later question is refused at fields[i].show_when.rules[j].field', () => {
		const s = form([
			q('short_text', 'Team', 'team', { show_when: rule('role') }),
			q('radio', 'Role', 'role', { options: [{ value: 'x', label: 'X' }], show_when: { match: 'all', rules: [{ field: 'email', op: 'not_empty' }, { field: 'role', op: 'eq', value: 'x' }] } })
		]);
		expect(at(s, 'fields[1].show_when.rules[0].field')[0]).toMatch(/before it/);
		expect(at(s, 'fields[2].show_when.rules[1].field')[0]).toMatch(/before it/);
		expect(at(s, 'fields[2].show_when.rules[0].field')).toEqual([]);
	});

	it('an unknown key, a contact field or a missing value is refused', () => {
		const s = form([q('short_text', 'A', 'a'), q('short_text', 'B', 'b', { show_when: { match: 'any', rules: [{ field: 'nope', op: 'eq', value: 'x' }, { field: 'contact.has_tag', op: 'eq', value: 'vip' }, { field: 'a', op: 'eq', value: '' }] } })]);
		expect(at(s, 'fields[2].show_when.rules[0].field')[0]).toMatch(/No question/);
		expect(at(s, 'fields[2].show_when.rules[1].field')[0]).toMatch(/not the contact/);
		expect(at(s, 'fields[2].show_when.rules[2].value')[0]).toMatch(/Enter a value/);
	});
});

describe('page jumps', () => {
	const fields = () => [
		q('radio', 'Plan', 'plan', { options: [{ value: 'free', label: 'Free' }] }),
		{ ...blankField('page_break', 'Two'), id: 'p2' },
		q('short_text', 'Team', 'team'),
		{ ...blankField('page_break', 'Three'), id: 'p3' },
		q('short_text', 'Note', 'note')
	];

	it('a forward jump on this page’s answers is fine; end is fine', () => {
		const s = form(fields(), (x) => {
			x.pages[0].next = [{ when: rule('plan', 'eq', 'free'), goto: 'p3' }];
			x.pages[1].next = [{ when: rule('plan', 'eq', 'free'), goto: 'end' }, { when: null, goto: 'p3' }];
		});
		expect(problems(s)).toEqual([]);
	});

	it('refuses a backwards / unknown target, a later page’s question, a contact field and too many rules', () => {
		const s = form(fields(), (x) => {
			x.pages[1].next = [
				{ when: null, goto: 'start' },
				{ when: null, goto: 'gone' },
				{ when: rule('note'), goto: 'p3' },
				{ when: rule('contact.has_tag'), goto: 'p3' },
				{ when: null, goto: 'end' },
				{ when: null, goto: 'end' }
			];
		});
		expect(at(s, 'pages[1].next[0].goto')[0]).toMatch(/later page/);
		expect(at(s, 'pages[1].next[1].goto')[0]).toMatch(/later page/);
		expect(at(s, 'pages[1].next[2].when.rules[0].field')[0]).toMatch(/this page or before/);
		expect(at(s, 'pages[1].next[3].when.rules[0].field')[0]).toMatch(/not the contact/);
		expect(at(s, 'pages[1].next')[0]).toMatch(`At most ${FORM_LIMITS.jumps}`);
	});

	it('round-trips through normalizeFormSpec, kept by page id; a removed page drops its rules', () => {
		const s = form(fields(), (x) => {
			x.pages[0].next = [{ when: rule('plan', 'eq', 'free'), goto: 'p3' }];
			x.pages[2].next = [{ when: null, goto: 'end' }];
		});
		const back = normalizeFormSpec(JSON.parse(JSON.stringify(s)));
		expect(back.pages[0].next).toEqual([{ when: rule('plan', 'eq', 'free'), goto: 'p3' }]);
		expect(back.pages[1].next).toBeUndefined();
		expect(back.pages[2]).toEqual({ id: 'p3', title: 'Three', next: [{ when: null, goto: 'end' }] });
		// Remove the second page break: its rules go, p3's stay (now page 2).
		const raw = JSON.parse(JSON.stringify(s));
		raw.fields = raw.fields.filter((f: FormField) => f.id !== 'p3');
		expect(normalizeFormSpec(raw).pages.map((p) => p.id)).toEqual(['start', 'p2']);
		expect(normalizeFormSpec({ ...raw, pages: 'junk' }).pages[0].next).toBeUndefined();
		expect(pageLabel(back.pages, 'p3')).toBe('Page 3: Three');
		expect(pageLabel(back.pages, 'end')).toBe('Submit');
	});
});

describe('outcomes', () => {
	it('rules read any question or the known contact; tag / list rules take is / is not', () => {
		const s = form([q('short_text', 'A', 'a')], (x) => {
			x.outcomes.push({
				id: 'o1',
				when: {
					match: 'all',
					rules: [
						{ field: 'a', op: 'eq', value: '1' },
						{ field: 'contact.has_tag', op: 'eq', value: 'vip' },
						{ field: 'contact.in_list', op: 'neq', value: '3' },
						{ field: 'contact.field:plan', op: 'contains', value: 'pro' }
					]
				},
				actions: [{ type: 'remove_tag', tag: 'cold' }]
			});
		});
		expect(problems(s)).toEqual([]);
		const bad = form([q('short_text', 'A', 'a')], (x) => {
			x.outcomes.push({
				id: 'o1',
				when: { match: 'all', rules: [{ field: 'zzz', op: 'eq', value: '1' }, { field: 'contact.has_tag', op: 'contains', value: 'v' }, { field: 'contact.field:', op: 'empty' }] },
				actions: [{ type: 'notify', user_ids: [] }]
			});
		});
		expect(at(bad, 'outcomes[1].when.rules[0].field')[0]).toMatch(/No question/);
		expect(at(bad, 'outcomes[1].when.rules[1].op')[0]).toMatch(/is not/);
		expect(at(bad, 'outcomes[1].when.rules[2].field')[0]).toMatch(/contact/);
		expect(at(bad, 'outcomes[1].actions[0]')[0]).toMatch(/who to notify/);
	});

	it('at most 10 outcomes', () => {
		const s = form([], (x) => {
			for (let i = 0; i < 10; i++) x.outcomes.push({ id: `o${i}`, when: null, actions: [] });
		});
		expect(at(s, 'outcomes')[0]).toMatch('At most 10');
	});

	it('outcomes_mode and the new actions round-trip; junk falls back', () => {
		const s = form([], (x) => {
			x.settings.outcomes_mode = 'first';
			x.outcomes.push({
				id: 'o1',
				when: rule('email', 'not_empty', undefined),
				actions: [
					{ type: 'remove_tag', tag: 'cold' },
					{ type: 'enroll_automation', automation_id: 7 },
					{ type: 'notify', user_ids: [2, 2, 3] }
				]
			});
		});
		const back = normalizeFormSpec(JSON.parse(JSON.stringify(s)));
		expect(back.settings.outcomes_mode).toBe('first');
		expect(back.outcomes[1]).toEqual({
			id: 'o1',
			when: rule('email', 'not_empty', undefined),
			actions: [
				{ type: 'remove_tag', tag: 'cold' },
				{ type: 'enroll_automation', automation_id: 7 },
				{ type: 'notify', user_ids: [2, 3] }
			]
		});
		const junk = normalizeFormSpec({ ...JSON.parse(JSON.stringify(s)), settings: { outcomes_mode: 'bogus' } });
		expect(junk.settings.outcomes_mode).toBe('all');
		expect(normalizeFormSpec({ outcomes: [{ id: 'x', when: null, actions: [{ type: 'enroll_automation', automation_id: 'no' }] }] }).outcomes[0].actions).toEqual([]);
	});
});

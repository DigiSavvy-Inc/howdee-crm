import { describe, it, expect } from 'vitest';
import {
	createCandidate,
	filterOptions,
	groupOptions,
	groupOptionsFromLists,
	labelFor,
	searchRows,
	type SearchOption
} from '../src/lib/search-select';
import page from '../src/routes/automations/[id]/+page.svelte?raw';
import engagementFields from '../src/lib/components/automations/EngagementTriggerFields.svelte?raw';
import searchSelect from '../src/lib/components/SearchSelect.svelte?raw';

// #431: the automation builder's shared searchable picker. The matching is pure
// ($lib/search-select); the page wiring is checked at source level (no Svelte compiler here).

const opts: SearchOption[] = [
	{ value: 1, label: 'Newsletter', group: 'Lists' },
	{ value: 2, label: 'Customers', detail: 'paid', group: 'Lists' },
	{ value: 3, label: 'Hot leads', group: 'Segments' },
	{ value: 4, label: 'vip', group: 'Tags' }
];

describe('#431 search-select matching', () => {
	it('filters case-insensitively on label and detail; blank = all', () => {
		expect(filterOptions(opts, '').length).toBe(4);
		expect(filterOptions(opts, '  NEWS ').map((o) => o.value)).toEqual([1]);
		expect(filterOptions(opts, 'PAID').map((o) => o.value)).toEqual([2]);
		expect(filterOptions(opts, 'zzz')).toEqual([]);
	});

	it('groups by first appearance, keeping order inside a group', () => {
		const g = groupOptions(opts);
		expect(g.map((x) => x.title)).toEqual(['Lists', 'Segments', 'Tags']);
		expect(g[0].items.map((o) => o.value)).toEqual([1, 2]);
		expect(groupOptions([{ value: 'a', label: 'a' }])[0].title).toBe('');
	});

	it('offers Create only for new, non-blank text', () => {
		expect(createCandidate(opts, '')).toBeNull();
		expect(createCandidate(opts, '  VIP ')).toBeNull();
		expect(createCandidate(opts, ' vip-2 ')).toBe('vip-2');
	});

	it('builds rows: empty row only without a query, create row last', () => {
		const blank = searchRows(opts, '', { allowEmpty: { label: 'Any list' } });
		expect(blank.flat[0]).toEqual({ kind: 'empty', value: '', label: 'Any list' });
		expect(blank.flat.length).toBe(5);
		const typed = searchRows(opts, 'lea', { allowEmpty: { label: 'Any list' }, allowCreate: true });
		expect(typed.flat.map((r) => r.kind)).toEqual(['option', 'create']);
		expect(typed.flat[1]).toEqual({ kind: 'create', value: 'lea', label: 'Create “lea”' });
		expect(typed.groups.map((g) => g.title)).toEqual(['Segments', '']);
		expect(searchRows(opts, 'lea').flat.map((r) => r.kind)).toEqual(['option']);
	});

	it('labels the closed field from the option, else the free text', () => {
		expect(labelFor(opts, 3)).toBe('Hot leads');
		expect(labelFor(opts, '3')).toBe('Hot leads');
		expect(labelFor(opts, 'brand-new')).toBe('brand-new');
		expect(labelFor(opts, '')).toBe('');
	});

	it('groups lists rows by kind: Lists, Segments, Tags, Companies', () => {
		const out = groupOptionsFromLists([
			{ id: 9, name: 'Acme', kind: 'company' },
			{ id: 5, name: 'vip', kind: 'tag' },
			{ id: 1, name: 'News', kind: 'list' },
			{ id: 2, name: 'Hot', kind: 'segment' }
		]);
		expect(out.map((o) => [o.group, o.value])).toEqual([
			['Lists', 1],
			['Segments', 2],
			['Tags', 5],
			['Companies', 9]
		]);
		expect(groupOptionsFromLists([{ id: 1, name: 'News', kind: 'list' }], String)[0].value).toBe('1');
	});
});

describe('#431 builder wiring', () => {
	it('has no datalist left on the automation page', () => {
		expect(page).not.toContain('<datalist');
		expect(page).not.toMatch(/\blist="(step-tag-options|label-options)/);
	});

	it('still posts every adopted field name through a SearchSelect', () => {
		for (const name of ['tag_name', 'tag_on_open', 'tag_on_click', 'trigger_list_id', 'target_automation_id', 'label']) {
			expect(page).toMatch(new RegExp(`<SearchSelect\\s+name="${name}"`));
		}
		for (const name of ['tag_name', 'tag_on_open', 'tag_on_click']) {
			expect(page).toMatch(new RegExp(`name="${name}"[^/]*allowCreate`));
		}
	});

	it('goal, topic and engagement list pickers use SearchSelect', () => {
		expect(page).toMatch(/<SearchSelect bind:value=\{\(\) => goalTag/);
		expect(page).toMatch(/<SearchSelect\s+bind:value=\{\(\) => goalList/);
		expect(page).toMatch(/<SearchSelect\s+bind:value=\{\(\) => topicChoice/);
		expect(engagementFields).toMatch(/<SearchSelect\s+bind:value=\{\(\) => listId/);
	});

	it('the component always renders its hidden input when named, and is a real combobox', () => {
		expect(searchSelect).toContain('{#if name}<input type="hidden" {name}');
		expect(searchSelect).toContain('role="combobox"');
		expect(searchSelect).toContain('role="listbox"');
		expect(searchSelect).toContain('aria-activedescendant');
	});
});

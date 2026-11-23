import { describe, expect, it } from 'vitest';
import { isImplicitSubmit } from '../src/lib/no-implicit-submit';

// Page sources are bundled at build time: the Workers test runtime has no repo filesystem.
const pages = import.meta.glob('../src/routes/**/+page.svelte', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const enter = { key: 'Enter', isComposing: false };
const el = (tagName: string, type = 'text') => ({ tagName, type }) as unknown as EventTarget;

describe('noImplicitSubmit (#559)', () => {
	it('blocks Enter in single-line text fields', () => {
		for (const t of ['text', 'url', 'email', 'search', 'number', 'date']) {
			expect(isImplicitSubmit(enter, el('INPUT', t))).toBe(true);
		}
	});
	it('leaves buttons, checkboxes, textareas and other keys alone', () => {
		expect(isImplicitSubmit(enter, el('INPUT', 'submit'))).toBe(false);
		expect(isImplicitSubmit(enter, el('INPUT', 'checkbox'))).toBe(false);
		expect(isImplicitSubmit(enter, el('TEXTAREA'))).toBe(false);
		expect(isImplicitSubmit(enter, el('BUTTON'))).toBe(false);
		expect(isImplicitSubmit({ key: 'a', isComposing: false }, el('INPUT'))).toBe(false);
		expect(isImplicitSubmit({ key: 'Enter', isComposing: true }, el('INPUT'))).toBe(false);
	});
	it('is attached to every form that holds a block editor', () => {
		for (const f of [
			'compose/+page.svelte',
			'campaign/[id]/archive/+page.svelte',
			'templates/[id]/+page.svelte',
			'templates/global/+page.svelte',
			'pages/[id]/+page.svelte',
			'automations/[id]/+page.svelte'
		]) {
			const key = `../src/routes/${f}`;
			expect(Object.keys(pages), `${key} is missing from the page glob`).toContain(key);
			expect(pages[key]).toContain('use:noImplicitSubmit');
		}
	});
});

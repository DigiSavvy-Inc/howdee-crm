// #520: the floating Save / Preview bar on the long editor forms (newsletter archive version,
// template editor, page editor). Sources are read raw, like the other component tests.
import { describe, expect, it } from 'vitest';
// #558: the editor is @digisavvy/block-editor; read the installed component (globs skip node_modules).
import blockEditor from '../node_modules/@digisavvy/block-editor/dist/components/BlockEditor.svelte?raw';

const raw = import.meta.glob(
	[
		'../src/lib/components/StickyActions.svelte',
		'../src/lib/components/AssistantFab.svelte',
		'../src/routes/campaign/[[]id]/archive/+page.svelte',
		'../src/routes/templates/[[]id]/+page.svelte',
		'../src/routes/pages/[[]id]/+page.svelte'
	],
	{ query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

const src = (suffix: string) => {
	const key = Object.keys(raw).find((k) => k.endsWith(suffix));
	if (!key) throw new Error(`missing ${suffix}`);
	return raw[key];
};

const component = src('components/StickyActions.svelte');
const archive = src('archive/+page.svelte');
const template = src('templates/[id]/+page.svelte');
const page = src('pages/[id]/+page.svelte');

/** The markup between <StickyActions …> and </StickyActions>. */
function barMarkup(file: string): string {
	const m = file.match(/<StickyActions\b[^>]*>([\s\S]*?)<\/StickyActions>/);
	if (!m) throw new Error('no StickyActions');
	return m[1];
}

describe('StickyActions component', () => {
	it('renders its children inside the bar', () => {
		expect(component).toMatch(/\{@render children\(\)\}/);
		expect(component).toMatch(/class="sticky-actions"/);
	});

	it('exposes the dirty text (default "Unsaved changes") and a saved status', () => {
		expect(component).toMatch(/dirtyText = 'Unsaved changes'/);
		expect(component).toMatch(/\{#if dirty\}[\s\S]*\{dirtyText\}/);
		expect(component).toMatch(/\{:else if status\}/);
		expect(component).toMatch(/class:is-dirty=\{dirty\}/);
		expect(component).toMatch(/role="status"/);
	});

	it('is sticky under the app header on desktop and fixed to the bottom on phones', () => {
		expect(component).toMatch(/\.sticky-actions \{[^}]*position: sticky;[^}]*top: var\(--header-h, 64px\)/);
		const phone = component.slice(component.indexOf('@media (max-width: 768px)'));
		expect(phone).toMatch(/position: fixed;/);
		expect(phone).toMatch(/bottom: 0;/);
		expect(phone).toMatch(/env\(safe-area-inset-bottom/);
		expect(phone).toMatch(/main:has\(\.sticky-actions\)\)[^}]*padding-bottom: calc\(.*var\(--sticky-actions-bottom/);
		expect(component).not.toMatch(/100vh/);
		expect(component).not.toMatch(/transition|animation/);
	});

	it('stacks above the block editor\'s Design panel and handles (5) but below the app header (10)', () => {
		const desktop = component.match(/\.sticky-actions \{([^}]*)\}/)?.[1] ?? '';
		expect(desktop).toMatch(/z-index: 6;/);
		const be = blockEditor;
		expect(be).toMatch(/\.be-body\.editing \.be-panel \{[^}]*position: sticky;[^}]*z-index: 5;/);
		expect(be).toMatch(/\.be-handle \{[^}]*z-index: 5;/);
	});

	it('publishes its height so the editor toolbar, Design sheet and assistant bubble move aside', () => {
		expect(component).toMatch(/--sticky-actions-top/);
		expect(component).toMatch(/--sticky-actions-bottom/);
		expect(blockEditor).toMatch(/--be-sticky-top: calc\(var\(--header-h, 64px\) \+ var\(--sticky-actions-top, 0px\)/);
		expect(blockEditor).toMatch(/bottom: var\(--sticky-actions-bottom, 0px\)/);
		expect(src('AssistantFab.svelte')).toMatch(/var\(--sticky-actions-bottom, 0px\)\);/);
	});
});

describe('editor pages use it', () => {
	it('archive editor: Save (submit), Preview targeting the preview form, dirty state', () => {
		expect(archive).toMatch(/<StickyActions \{dirty\}/);
		const bar = barMarkup(archive);
		expect(bar).toMatch(/<button type="submit" disabled=\{busy\}>Save<\/button>/);
		expect(bar).toMatch(/<button type="submit" form="arch-preview" class="secondary">Preview<\/button>/);
		expect(bar.indexOf('>Save<')).toBeLessThan(bar.indexOf('>Preview<'));
		expect(archive).toMatch(/<form id="arch-preview"[^>]*target="_blank"/);
		// Still the last thing in the save form (DOM / tab order unchanged).
		expect(archive).toMatch(/<\/StickyActions>\s*<\/form>/);
		expect(archive).toMatch(/\.arch-form > :global\(\.sticky-actions\) \{ order: -1; \}/);
	});

	it('template editor: Save plus its secondary actions keep their type / form attributes', () => {
		const bar = barMarkup(template);
		expect(bar).toMatch(/<button type="submit">Save<\/button>/);
		expect(bar).toMatch(/<button type="submit" class="secondary" form="copy-as-web"/);
		expect(bar).toMatch(/<button type="button" class="secondary" onclick=\{\(\) => \(emailPreview = !emailPreview\)\}>/);
		expect(template).toMatch(/status=\{form\?\.saved \? 'Saved\.' : ''\}/);
		expect(template).toMatch(/\{#if form\?\.saved\}<p class="ok">Saved\.<\/p>\{\/if\}/);
	});

	it('page editor: Save inside the bar, Saved. feedback kept', () => {
		const bar = barMarkup(page);
		expect(bar).toMatch(/<button type="submit">Save<\/button>/);
		expect(page).toMatch(/status=\{form\?\.saved \? 'Saved\.' : ''\}/);
		expect(page).toMatch(/\{#if form\?\.saved\}<p class="ok">Saved\.<\/p>\{\/if\}/);
	});
});

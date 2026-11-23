// #523: Write mode. The editor side (toggle, shortcut, Escape, the <html data-write-mode>
// stamp) lives in @digisavvy/block-editor and is tested there (#558); this file keeps the
// app's reaction to the stamp: the root layout and the assistant button.
import { describe, expect, it } from 'vitest';

const raw = import.meta.glob(['../src/lib/components/AssistantFab.svelte', '../src/routes/+layout.svelte'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;
const src = (suffix: string) => {
	const key = Object.keys(raw).find((k) => k.endsWith(suffix));
	if (!key) throw new Error(`missing ${suffix}`);
	return raw[key];
};
const fab = src('components/AssistantFab.svelte');
const layout = src('routes/+layout.svelte');

describe('app chrome in Write mode', () => {
	it('the root layout hides the header and nav for html[data-write-mode]', () => {
		const css = layout.slice(layout.indexOf('<style>'));
		expect(css).toMatch(/:global\(html\[data-write-mode\]\) #app-nav \{\s*display: none;/);
		expect(css).toMatch(/:global\(html\[data-write-mode\]\) \.shell \{\s*--header-h: 0px;\s*padding-left: 0;/);
		expect(css).toMatch(/:global\(html\[data-write-mode\]\) main\.wide \{\s*max-width: 1600px;/);
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:global\(html\[data-write-mode\]\) main/);
		// After the #134 sidebar rules so it wins at equal specificity.
		expect(css.lastIndexOf("html[data-nav='left']")).toBeLessThan(css.indexOf('html[data-write-mode]'));
		expect(layout).toMatch(/<header id="app-nav"/);
	});

	it('the assistant button hides in write mode', () => {
		expect(fab).toMatch(/:global\(html\[data-write-mode\]\) \.af \{\s*display: none;/);
	});
});

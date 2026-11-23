// #572: platform-aware shortcut labels, one list in Help, and no "Cmd/Ctrl" hints.
import { describe, it, expect } from 'vitest';
import { detectMac, isMacPlatform, keyLabel, SHORTCUTS, shortcutKeysHtml, shortcutKeysText, shortcutsTableHtml } from '../src/lib/shortcuts';
import { searchShortcutHint } from '../src/lib/site-search';
import helpPanel from '../src/lib/components/HelpPanel.svelte?raw';
import layout from '../src/routes/+layout.svelte?raw';
import conversations from '../src/routes/conversations/+page.svelte?raw';

const sources = import.meta.glob(['../src/**/*.svelte', '../src/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Drop whole-line comments (`//`, `/*`, ` *`, `<!--`) — hints live in code and markup. */
function withoutComments(src: string): string {
	return src
		.split('\n')
		.filter((l) => !/^\s*(\/\/|\/\*|\*|<!--)/.test(l))
		.join('\n');
}

describe('keyLabel', () => {
	it('Mac: symbols, no plus signs, ⌃⌥⇧⌘ order', () => {
		expect(keyLabel('Mod+K', true)).toBe('⌘K');
		expect(keyLabel('Mod+J', true)).toBe('⌘J');
		expect(keyLabel('Mod+Shift+F', true)).toBe('⇧⌘F');
		expect(keyLabel('Shift+Mod+f', true)).toBe('⇧⌘F');
		expect(keyLabel('Mod+Alt+2', true)).toBe('⌥⌘2');
		expect(keyLabel('Mod+Enter', true)).toBe('⌘Enter');
	});

	it('Windows / Linux: Ctrl+… with plus signs', () => {
		expect(keyLabel('Mod+K', false)).toBe('Ctrl+K');
		expect(keyLabel('Mod+Shift+F', false)).toBe('Ctrl+Shift+F');
		expect(keyLabel('Shift+Mod+F', false)).toBe('Ctrl+Shift+F');
		expect(keyLabel('Mod+Enter', false)).toBe('Ctrl+Enter');
		expect(keyLabel('Mod+S', false)).toBe('Ctrl+S');
	});

	it('plain keys stay as they are on both', () => {
		for (const mac of [true, false]) {
			expect(keyLabel('/', mac)).toBe('/');
			expect(keyLabel('+', mac)).toBe('+');
			expect(keyLabel('-', mac)).toBe('-');
			expect(keyLabel('j', mac)).toBe('J');
			expect(keyLabel('Enter', mac)).toBe('Enter');
		}
		expect(keyLabel('Mod++', false)).toBe('Ctrl++');
	});

	it('search hint goes through it', () => {
		expect(searchShortcutHint(true)).toBe('⌘K');
		expect(searchShortcutHint(false)).toBe('Ctrl+K');
	});
});

describe('platform detection', () => {
	it('isMacPlatform', () => {
		expect(isMacPlatform('MacIntel')).toBe(true);
		expect(isMacPlatform('macOS')).toBe(true);
		expect(isMacPlatform('iPhone')).toBe(true);
		expect(isMacPlatform('Win32')).toBe(false);
		expect(isMacPlatform('Linux x86_64')).toBe(false);
		expect(isMacPlatform('')).toBe(false);
	});

	it('detectMac never throws and answers a boolean (server / worker: no Mac)', () => {
		expect(typeof detectMac()).toBe('boolean');
	});
});

describe('the shortcut list (Help)', () => {
	it('covers the app shortcuts from the audit', () => {
		const keys = SHORTCUTS.flatMap((s) => s.keys);
		for (const k of ['Mod+K', '/', 'Mod+J', 'Mod+Shift+F', 'Mod+S', 'Mod+Enter', 'J', 'K', 'X', '+', '-', '0']) expect(keys).toContain(k);
	});

	it('cells resolve Mod in notes too', () => {
		const zoom = SHORTCUTS.find((s) => s.action === 'Zoom in / out')!;
		expect(shortcutKeysText(zoom, true)).toBe('+ / - (or ⌘scroll)');
		expect(shortcutKeysText(zoom, false)).toBe('+ / - (or Ctrl+scroll)');
	});

	it('one table with Mac and Windows columns', () => {
		const html = shortcutsTableHtml();
		expect(html).toContain('<th scope="col">Mac</th><th scope="col">Windows</th>');
		expect(html).toContain('<kbd>⌘K</kbd></td><td><kbd>Ctrl+K</kbd>');
		expect(html).toContain(
			'<td><kbd>⇧⌘F</kbd> <span class="hp-note">Esc exits</span></td><td><kbd>Ctrl+Shift+F</kbd> <span class="hp-note">Esc exits</span></td>'
		);
		expect((html.match(/<tr>/g) ?? []).length).toBe(SHORTCUTS.length + 1);
		expect(html).not.toMatch(/Cmd\/Ctrl/);
	});

	it('a multi-combo row gets one <kbd> per combo, and the note sits outside them', () => {
		const pan = SHORTCUTS.find((s) => s.action === 'Pan')!;
		const html = shortcutsTableHtml([pan]);
		const cell = '<kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>←</kbd> / <kbd>→</kbd> <span class="hp-note">or Space+drag</span>';
		expect(html).toContain(`<td>${cell}</td><td>${cell}</td>`);
		expect((html.match(/<kbd>/g) ?? []).length).toBe(pan.keys.length * 2);
		expect(html).not.toMatch(/<kbd>[^<]*(Space|drag|\/)[^<]*<\/kbd>/);

		const zoom = SHORTCUTS.find((s) => s.action === 'Zoom in / out')!;
		expect(shortcutKeysHtml(zoom, true)).toBe('<kbd>+</kbd> / <kbd>-</kbd> <span class="hp-note">or ⌘scroll</span>');
		expect(shortcutKeysHtml(zoom, false)).toBe('<kbd>+</kbd> / <kbd>-</kbd> <span class="hp-note">or Ctrl+scroll</span>');
	});

	it('the table escapes action, where, keys and note', () => {
		const html = shortcutsTableHtml([{ action: 'a <b>', where: 'x & y', keys: ['<'], note: '> z' }]);
		expect(html).toContain('a &lt;b&gt;<br><span class="hp-where">x &amp; y</span>');
		expect(html).toContain('<kbd>&lt;</kbd> <span class="hp-note">&gt; z</span>');
		expect(html).not.toContain('<b>');
	});

	it('Help has a "Keyboard shortcuts" entry built from it, per platform', () => {
		expect(helpPanel).toContain("title: 'Keyboard shortcuts'");
		expect(helpPanel).toContain('${shortcutsTableHtml()}');
		expect(helpPanel).toContain('const SECTIONS = $derived(buildSections(platform.mac));');
	});
});

describe('no hint says "Cmd/Ctrl" (structural)', () => {
	it('every .svelte / .ts under src', () => {
		const offenders: string[] = [];
		for (const [path, src] of Object.entries(sources)) {
			const code = withoutComments(src);
			if (/(?:Cmd|⌘)\s*\/\s*Ctrl/.test(code)) offenders.push(path);
		}
		expect(offenders).toEqual([]);
		expect(Object.keys(sources).length).toBeGreaterThan(50);
	});
});

describe('handlers', () => {
	it('the layout sets the platform on mount and labels the header buttons with it', () => {
		expect(layout).toContain('onMount(initPlatform);');
		expect(layout).toContain("title=\"Assistant ({kbd('Mod+J')})\"");
		expect(layout).toContain("const searchHint = $derived(kbd('Mod+K'));");
		// The assistant accepts either modifier, so Ctrl+J works on Windows (and on a Mac).
		expect(layout).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\)[^\n]*'j'/);
	});

	it('Conversations claims `/` before the site search does', () => {
		expect(conversations).toContain('<svelte:window onkeydowncapture={onKeydown} />');
		expect(layout).toMatch(/e\.key === '\/' && !e\.defaultPrevented/);
	});
});

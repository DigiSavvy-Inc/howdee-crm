// #476: select text and paste a link to link it, and Cmd/Ctrl+K left free for the
// site-wide search (#477). The editor side lives in @digisavvy/block-editor and is tested
// there (#558); this file keeps the app's help text, checked against the installed editor.
import { describe, it, expect } from 'vitest';
import blockEditor from '../node_modules/@digisavvy/block-editor/dist/components/BlockEditor.svelte?raw';
import helpPanel from '../src/lib/components/HelpPanel.svelte?raw';

describe('Cmd/Ctrl+K belongs to search, not the editor (#477)', () => {
	it('the editor binds no K shortcut', () => {
		expect(blockEditor).toContain('Cmd/Ctrl+K is left free for the site-wide search');
		expect(blockEditor).not.toMatch(/\.key\s*===\s*['"][kK]['"]|KeyK|Mod-k/i);
	});

	it('the help documents Cmd/Ctrl+K as the search shortcut and never as a link shortcut', () => {
		expect(helpPanel).toContain("title: `Search (${k('Mod+K')})`");
		// Every line naming the Mod+K shortcut (#572: built per platform) is about search; none mentions links.
		const kLines = helpPanel.split('\n').filter((l) => /Mod\+K\b/.test(l));
		expect(kLines.length).toBeGreaterThan(0);
		for (const l of kLines) expect(l, l).not.toMatch(/\blink/i);
	});

	it('mentions the paste trick in the editor hint row and the help', () => {
		expect(blockEditor).toContain('select text and paste a link to link it');
		expect(helpPanel).toContain('select text and paste a link to link it');
	});
});

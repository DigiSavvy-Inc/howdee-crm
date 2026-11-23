// #524: quiet chrome + the selection bubble. The editor side lives in
// @digisavvy/block-editor and is tested there (#558); this file keeps the app's help text.
import { describe, expect, it } from 'vitest';
import help from '../src/lib/components/HelpPanel.svelte?raw';

describe('help', () => {
	it('help explains the quiet chrome and the bubble', () => {
		expect(help).toMatch(/fade while you type/);
	});
});

import { describe, it, expect } from 'vitest';
import logicTab from '../src/lib/components/forms/FormLogicTab.svelte?raw';
import shareTab from '../src/lib/components/forms/FormShareTab.svelte?raw';
import { EMBED_SCRIPT_MAX_AGE } from '../src/lib/form-embed';

// #669: Logic tab cards follow #590 (no left accent bar); embed.js follows allowed origins sooner.

const styleOf = (src: string) => src.slice(src.indexOf('<style'));

describe('Logic tab cards (#669)', () => {
	it('has no inset left accent bar', () => {
		const css = styleOf(logicTab);
		expect(css).not.toMatch(/inset\s+\d+px\s+0\s+0/);
		expect(css).not.toMatch(/border-left\s*:/);
	});

	it('marks a card with conditions with the builder accent hairline', () => {
		expect(styleOf(logicTab)).toContain('.item.on { box-shadow: 0 0 0 var(--border-s) var(--btn-primary-bg); }');
	});
});

describe('embed.js cache (#669)', () => {
	it('caches for about a minute, not five', () => {
		expect(EMBED_SCRIPT_MAX_AGE).toBe(60);
	});

	it('says so in the Share & embed help text', () => {
		expect(shareTab).toContain('pick it up within a minute');
	});
});

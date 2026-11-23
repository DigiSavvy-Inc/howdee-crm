import { describe, expect, it } from 'vitest';
import overview from '../src/lib/components/ContactsOverview.svelte?raw';

// #577: at 375px the Overview grid's 300px minimum plus page padding pushed /contacts wider than the window.
describe('contacts overview on phones (#577)', () => {
	it('lets grid columns shrink below 300px', () => {
		expect(overview).toContain('minmax(min(300px, 100%), 1fr)');
		expect(overview).not.toContain('minmax(300px, 1fr)');
	});
	it('keeps cells shrinkable and scrolls a wide table inside its card on phones', () => {
		expect(overview).toMatch(/\.sub \{\s*min-width: 0;/);
		const phone = overview.slice(overview.indexOf('@media (max-width: 640px)'));
		expect(phone).toMatch(/\.sub \{\s*overflow-x: auto;/);
	});
});

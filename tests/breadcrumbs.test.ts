import { describe, it, expect } from 'vitest';
import { crumbParent, crumbView } from '../src/lib/breadcrumbs';
// The test pool has no Svelte plugin, so the markup contract is checked on the source.
import source from '../src/lib/components/Breadcrumbs.svelte?raw';

describe('crumbView (#265)', () => {
	it('makes only the last item current, and never a link', () => {
		const v = crumbView([
			{ label: 'Campaigns', href: '/campaigns' },
			{ label: 'Spring launch', href: '/campaign/4' }
		]);
		expect(v).toEqual([
			{ label: 'Campaigns', href: '/campaigns', current: false },
			{ label: 'Spring launch', href: null, current: true }
		]);
	});

	it('keeps an ancestor without an href as plain text', () => {
		const v = crumbView([{ label: 'Creative' }, { label: 'Templates', href: '/templates' }, { label: 'Welcome' }]);
		expect(v[0]).toEqual({ label: 'Creative', href: null, current: false });
		expect(v[1].href).toBe('/templates');
		expect(v[2].current).toBe(true);
	});
});

describe('crumbParent (#265)', () => {
	it('is the second-to-last item', () => {
		expect(crumbParent([{ label: 'Contacts', href: '/contacts' }, { label: 'Ann' }])).toEqual({
			label: 'Contacts',
			href: '/contacts'
		});
	});

	it('skips a non-link ancestor', () => {
		expect(crumbParent([{ label: 'Creative' }, { label: 'Pages', href: '/pages' }, { label: 'Home' }])?.href).toBe(
			'/pages'
		);
		expect(crumbParent([{ label: 'Creative' }, { label: 'Home' }])).toBeNull();
		expect(crumbParent([{ label: 'Only' }])).toBeNull();
	});
});

describe('Breadcrumbs.svelte markup (#265)', () => {
	it('is a labelled nav with an ordered list', () => {
		expect(source).toContain('<nav class="crumbs" aria-label="Breadcrumb">');
		expect(source).toContain('<ol class="trail">');
	});

	it('marks the current page and hides separators from assistive tech', () => {
		expect(source).toMatch(/<span aria-current="page"[^>]*>\{c\.label\}<\/span>/);
		expect(source).toContain('<span class="sep" aria-hidden="true">›</span>');
	});

	it('collapses to the parent link at 640px', () => {
		expect(source).toMatch(/@media \(max-width: 640px\)/);
		expect(source).toContain('← {parent.label}');
	});
});

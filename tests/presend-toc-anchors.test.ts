import { describe, it, expect } from 'vitest';
import { renderBlocksEmailHtml } from '@digisavvy/block-editor/blocks';
import { anchorTargets, extractLinks, linkChecks, placeholderReason, type Check } from '$lib/presend-checks';
import type { Block } from '$lib/blocks';

// #560: a table of contents renders jump links (`#slug`) to anchors in the same email. The
// pre-send link checks must accept those and still block `#` and a jump to a missing section.

const byId = (cs: Check[], id: string) => cs.find((c) => c.id === id);

describe('pre-send checks: table of contents jump links', () => {
	it('drops jump links whose <a name> or id target is in the email', () => {
		const html = `<ul><li><a href="#a">Section A</a></li><li><a href="#b">Section B</a></li></ul>
<a name="a"></a><div>Section A</div>
<div id="b">Section B</div>`;
		expect(anchorTargets(html)).toEqual(new Set(['a', 'b']));
		expect(extractLinks(html)).toEqual([]);
		expect(byId(linkChecks(extractLinks(html)), 'links.placeholder')!.level).toBe('pass');
	});

	it('still blocks a bare #', () => {
		const c = byId(linkChecks(extractLinks(`<a href="#">Nowhere</a><a name="a"></a>`)), 'links.placeholder')!;
		expect(c.level).toBe('block');
		expect(c.items![0]).toContain('goes nowhere (#)');
		expect(placeholderReason('#')).toBe('goes nowhere (#)');
	});

	it('blocks a jump to a section that is not in the email, with its own reason', () => {
		const links = extractLinks(`<a href="#missing">Gone</a><a name="other"></a>`);
		expect(links).toEqual([{ href: '#missing', text: 'Gone' }]);
		const c = byId(linkChecks(links), 'links.placeholder')!;
		expect(c.level).toBe('block');
		expect(c.items![0]).toContain('#missing — no matching section in this email');
	});

	it('matches a percent-encoded fragment against its decoded target', () => {
		expect(extractLinks(`<a href="#caf%C3%A9">Café</a><a name="café"></a>`)).toEqual([]);
		// A malformed escape doesn't throw; it is compared as is.
		expect(extractLinks(`<a href="#bad%E0">x</a><a name="bad%E0"></a>`)).toEqual([]);
	});

	it('keeps real links next to toc links', () => {
		const html = `<a href="#a">A</a><a name="a"></a><a href="https://ourco.example/pricing">Pricing</a>`;
		expect(extractLinks(html)).toEqual([{ href: 'https://ourco.example/pricing', text: 'Pricing' }]);
	});

	it('passes a real email rendered with a toc block', () => {
		const t = (text: string) => [{ type: 'text', text }];
		const blocks = [
			{ id: 't', type: 'toc', levels: [2] },
			{ id: 'h1', type: 'heading', level: 2, content: t('Two things happening in LA') },
			{ id: 'p1', type: 'paragraph', content: t('Details here.') },
			{ id: 'h2', type: 'heading', level: 2, content: t('Next steps') },
			{ id: 'p2', type: 'paragraph', content: [{ type: 'text', text: 'Book', marks: [{ type: 'link', href: 'https://ourco.example/book' }] }] }
		] as unknown as Block[];
		const html = renderBlocksEmailHtml(blocks);
		expect(html).toContain('href="#two-things-happening-in-la"');
		expect(html).toContain('<a name="two-things-happening-in-la"></a>');
		const links = extractLinks(html);
		expect(links.map((l) => l.href)).toEqual(['https://ourco.example/book']);
		const checks = linkChecks(links);
		expect(checks.filter((c) => c.level === 'block')).toEqual([]);
	});
});

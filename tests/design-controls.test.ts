import { describe, it, expect } from 'vitest';
import {
	sanitizeBlocks,
	sanitizeCanvas,
	parseCanvas,
	canvasIsSet,
	cleanImageUrl,
	renderBlocksEmailHtml,
	renderBlocksEmailText,
	renderPageHtml,
	type Block
} from '../src/lib/blocks';
import { renderEmailHtmlFromContent } from '../src/lib/server/email';
import { assembleBuilderEmail, readTemplateCanvas, type TemplateRow } from '../src/lib/server/templates';
import { KITCHEN_SINK } from './fixtures/kitchen-sink-blocks';
import { LEGACY_SIGNATURE } from './fixtures/legacy-signature';

// #270: editor design controls v2 — the email canvas, per-block alignment and space
// below, custom section padding / radius / border / background image / accent, button
// colours / radius / size / full width, divider + spacer + columns options, heading
// colour. Sanitiser ranges, renderer snapshots and back-compat.

const t = (text: string) => [{ type: 'text' as const, text }];
const one = (b: unknown): Record<string, unknown> => sanitizeBlocks([b])[0] as unknown as Record<string, unknown>;
const sec = (extra: Record<string, unknown>, blocks: unknown[] = [{ id: 'p', type: 'paragraph', content: t('Hi') }]) =>
	one({ id: 's', type: 'section', bg: '#1a9ec4', padding: 'lg', width: 'full', blocks, ...extra });

describe('sanitiser: canvas', () => {
	it('keeps allowed values and normalises colours', () => {
		expect(sanitizeCanvas({ backdrop: '#0B1F3A', width: 600, radius: 16, text: '333', link: '#CE423B', fontSize: 17, padding: 0 })).toEqual({
			backdrop: '#0b1f3a',
			width: 600,
			radius: 16,
			text: '#333333',
			link: '#ce423b',
			fontSize: 17,
			padding: 0
		});
	});
	it('drops bad hex, out-of-list numbers, strings for numbers and unknown keys', () => {
		expect(sanitizeCanvas({ backdrop: 'navy', width: 700, radius: 4, text: '#12345', link: 'url(x)', fontSize: '16', padding: 8, evil: '<script>' })).toEqual({});
		for (const junk of [null, 'x', 42, [], [{ backdrop: '#000' }]]) expect(sanitizeCanvas(junk)).toEqual({});
	});
	it('parses stored JSON defensively; an empty canvas is "not set"', () => {
		expect(parseCanvas('{"width":560}')).toEqual({ width: 560 });
		expect(parseCanvas('not json')).toEqual({});
		expect(parseCanvas(null)).toEqual({});
		expect(canvasIsSet({})).toBe(false);
		expect(canvasIsSet({ radius: 0 })).toBe(true);
	});
	it('stores NULL for an empty or junk canvas, sanitised JSON otherwise', () => {
		expect(readTemplateCanvas('{}')).toBeNull();
		expect(readTemplateCanvas('{"width":999}')).toBeNull();
		expect(readTemplateCanvas('garbage')).toBeNull();
		expect(readTemplateCanvas(null)).toBeNull();
		expect(readTemplateCanvas('{"backdrop":"#0B1F3A","x":1}')).toBe('{"backdrop":"#0b1f3a"}');
	});
});

describe('sanitiser: block attributes', () => {
	it('align: left / center / right on text blocks and images; junk dropped', () => {
		for (const type of ['paragraph', 'quote', 'callout', 'eyebrow']) {
			expect(one({ id: 'a', type, content: t('x'), align: 'center' }).align).toBe('center');
			expect(one({ id: 'a', type, content: t('x'), align: 'justify' })).not.toHaveProperty('align');
		}
		expect(one({ id: 'h', type: 'heading', level: 2, text: 'x', align: 'right' }).align).toBe('right');
		expect(one({ id: 'l', type: 'list', ordered: false, items: [t('x')], align: 'center' }).align).toBe('center');
		expect(one({ id: 'm', type: 'milestones', rule: true, items: [], align: 'left' }).align).toBe('left');
		expect(one({ id: 'i', type: 'image', src: 'https://a.test/x.png', alt: '', align: 'center' }).align).toBe('center');
		expect(one({ id: 'i', type: 'image', src: 'https://a.test/x.png', alt: '', align: 'middle' })).not.toHaveProperty('align');
		// Button keeps its own required align (unknown → left).
		expect(one({ id: 'b', type: 'button', label: 'x', href: 'https://a.test', align: 'nope' }).align).toBe('left');
	});
	it('spaceBelow: only 0/8/16/24/32/48, never on a content area', () => {
		for (const v of [0, 8, 16, 24, 32, 48]) expect(one({ id: 'p', type: 'paragraph', content: [], spaceBelow: v }).spaceBelow).toBe(v);
		for (const v of [10, -8, '16', 100, null, true]) expect(one({ id: 'p', type: 'paragraph', content: [], spaceBelow: v })).not.toHaveProperty('spaceBelow');
		expect(one({ id: 'c', type: 'content', spaceBelow: 16 })).toEqual({ id: 'c', type: 'content' });
		expect(sec({ spaceBelow: 24 }).spaceBelow).toBe(24);
	});
	it('heading colour: hex only', () => {
		expect(one({ id: 'h', type: 'heading', level: 1, text: 'x', color: '#0B1F3A' }).color).toBe('#0b1f3a');
		for (const bad of ['navy', '#12', 'red;x:y', 5]) expect(one({ id: 'h', type: 'heading', level: 1, text: 'x', color: bad })).not.toHaveProperty('color');
	});
	it('button: colours, radius, size, full width, link colour', () => {
		const b = one({ id: 'b', type: 'button', label: 'Go', href: 'https://a.test', align: 'center', bg: '#0B1F3A', fg: 'FCB900', radius: 999, btnSize: 'lg', full: true, linkColor: '#fff' });
		expect(b).toMatchObject({ bg: '#0b1f3a', fg: '#fcb900', radius: 999, btnSize: 'lg', full: true, linkColor: '#ffffff' });
		const bad = one({ id: 'b', type: 'button', label: 'Go', href: 'https://a.test', align: 'left', bg: 'blue', fg: '#xyz', radius: 5, btnSize: 'xl', full: 'yes', linkColor: '' });
		for (const k of ['bg', 'fg', 'radius', 'btnSize', 'full', 'linkColor']) expect(bad).not.toHaveProperty(k);
	});
	it('divider: colour, thickness clamped to 1–4, short only when true', () => {
		expect(one({ id: 'd', type: 'divider', color: '#0b1f3a', thickness: 3, short: true })).toEqual({ id: 'd', type: 'divider', color: '#0b1f3a', thickness: 3, short: true });
		expect(one({ id: 'd', type: 'divider', thickness: 9 }).thickness).toBe(4);
		expect(one({ id: 'd', type: 'divider', thickness: 0 }).thickness).toBe(1);
		expect(one({ id: 'd', type: 'divider', thickness: 'x', short: 'yes', color: 'red' })).toEqual({ id: 'd', type: 'divider' });
	});
	it('spacer: custom px clamped to 0–200', () => {
		expect(one({ id: 's', type: 'spacer', size: 'md', px: 40 }).px).toBe(40);
		expect(one({ id: 's', type: 'spacer', size: 'md', px: 500 }).px).toBe(200);
		expect(one({ id: 's', type: 'spacer', size: 'md', px: -5 }).px).toBe(0);
		expect(one({ id: 's', type: 'spacer', size: 'md', px: 'big' })).not.toHaveProperty('px');
	});
	it('columns: gap from the list, valign top/middle, stack only false', () => {
		const c = one({ id: 'c', type: 'columns', cells: [[], []], gap: 24, valign: 'middle', stack: false });
		expect(c).toMatchObject({ gap: 24, valign: 'middle', stack: false });
		const bad = one({ id: 'c', type: 'columns', cells: [[], []], gap: 13, valign: 'bottom', stack: true });
		for (const k of ['gap', 'valign', 'stack']) expect(bad).not.toHaveProperty(k);
	});
	it('section: padding clamped to 0–96, radius list, border needs a colour, accent hex', () => {
		expect(sec({ padTop: 200, padBottom: -4, padX: 30.6 })).toMatchObject({ padTop: 96, padBottom: 0, padX: 31 });
		expect(sec({ padTop: 'x' })).not.toHaveProperty('padTop');
		expect(sec({ radius: 8 }).radius).toBe(8);
		expect(sec({ radius: 12 })).not.toHaveProperty('radius');
		expect(sec({ borderColor: '#0B1F3A' })).toMatchObject({ borderColor: '#0b1f3a', borderWidth: 1 });
		expect(sec({ borderColor: '#000', borderWidth: 7 }).borderWidth).toBe(4);
		const noColour = sec({ borderColor: 'black', borderWidth: 2 });
		expect(noColour).not.toHaveProperty('borderColor');
		expect(noColour).not.toHaveProperty('borderWidth');
		expect(sec({ accent: '#CE423B' }).accent).toBe('#ce423b');
		expect(sec({ accent: 'orange' })).not.toHaveProperty('accent');
	});
	it('section background image: http(s) only, nothing that breaks out of url() or an attribute', () => {
		expect(sec({ bgImage: 'https://img.test/hero.jpg' }).bgImage).toBe('https://img.test/hero.jpg');
		for (const bad of ['javascript:alert(1)', 'https://x.test/a b.jpg', "https://x.test/a'.jpg", 'https://x.test/a).jpg', 'https://x.test/"a', 'data:image/png;base64,xx', 'https://x.test/a\\b'])
			expect(sec({ bgImage: bad })).not.toHaveProperty('bgImage');
		expect(cleanImageUrl('https://ok.test/x.png')).toBe('https://ok.test/x.png');
	});
	it('is idempotent', () => {
		const doc = [
			sec({ padTop: 12, padX: 24, radius: 16, borderColor: '#000', borderWidth: 2, bgImage: 'https://img.test/a.jpg', accent: '#ce423b', spaceBelow: 16 }),
			{ id: 'b', type: 'button', label: 'Go', href: 'https://a.test', align: 'left', bg: '#000000', radius: 0 }
		];
		const once = sanitizeBlocks(doc);
		expect(sanitizeBlocks(once)).toEqual(once);
	});
});

// The editor round trip and the initial selection (#270) are tested in @digisavvy/block-editor
// (tests/design-controls-270.test.ts there, #558).

describe('back-compat: no design attributes = unchanged output', () => {
	it('kitchen sink: email, page and text snapshots', () => {
		expect(renderBlocksEmailHtml(KITCHEN_SINK)).toMatchSnapshot();
		expect(renderPageHtml('Page', KITCHEN_SINK)).toMatchSnapshot();
		expect(renderBlocksEmailText(KITCHEN_SINK)).toMatchSnapshot();
	});
	it('an empty canvas renders exactly like no canvas', () => {
		expect(renderBlocksEmailHtml(KITCHEN_SINK, {})).toBe(renderBlocksEmailHtml(KITCHEN_SINK));
		const inner = renderBlocksEmailHtml(KITCHEN_SINK);
		expect(renderEmailHtmlFromContent(inner, { unsubscribe: true, canvas: {} })).toBe(renderEmailHtmlFromContent(inner, { unsubscribe: true }));
		expect(renderEmailHtmlFromContent(inner, { canvas: null })).toBe(renderEmailHtmlFromContent(inner));
	});
});

describe('renderers', () => {
	const CANVAS = { backdrop: '#0b1f3a', width: 600, radius: 16, text: '#333333', link: '#ce423b', fontSize: 17, padding: 0 } as const;

	it('canvas: full-width backdrop table + centred card; font size and link colour reach the blocks', () => {
		const inner = renderBlocksEmailHtml([{ id: 'p', type: 'paragraph', content: [...t('Hi '), { type: 'text', text: 'there', marks: [{ type: 'link', href: 'https://a.test' }] }] }], CANVAS);
		expect(inner).toContain('font-size:17px');
		expect(inner).toContain('style="color:#ce423b;text-decoration:underline;"');
		// #594: with the seeded signature, so the snapshot stays the pre-setting output.
		const html = renderEmailHtmlFromContent(inner, { unsubscribe: true, canvas: CANVAS, signature: LEGACY_SIGNATURE });
		expect(html).toContain('<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0b1f3a" style="background-color:#0b1f3a;">');
		expect(html).toContain('width="600" align="center" bgcolor="#ffffff"');
		expect(html).toContain('max-width:600px');
		expect(html).toContain('border-radius:16px');
		expect(html).toContain('color:#333333;font-size:17px');
		// The footer sits on the backdrop: muted grey while that stays readable…
		expect(html).toContain('class="footer" style="max-width:600px;margin:0 auto;color:#8b949e;"');
		expect(html).toMatchSnapshot();
		// …else black or white.
		expect(renderEmailHtmlFromContent(inner, { canvas: { backdrop: '#8b949e' } })).toContain('class="footer" style="max-width:600px;margin:0 auto;color:#000000;"');
	});
	it('canvas width sets the block layout width', () => {
		const img: Block[] = [{ id: 'i', type: 'image', src: 'https://a.test/x.png', alt: '' }];
		// Default card padding (24px a side) narrows the run; padding 0 = the card width.
		expect(renderBlocksEmailHtml(img, { width: 560 })).toContain('width="512"');
		expect(renderBlocksEmailHtml(img, { width: 560, padding: 0 })).toContain('width="560"');
	});

	describe('canvas card layout: full-bleed sections, padded runs, milestones fit', () => {
		const hero = (extra: Record<string, unknown> = {}, blocks: unknown[] = [{ id: 'p', type: 'paragraph', content: t('Hero') }]) =>
			({ id: 'h', type: 'section', bg: '#fcb900', padding: 'lg', width: 'full', blocks, ...extra }) as unknown as Block;
		const para = (id: string) => ({ id, type: 'paragraph', content: t(id) }) as Block;
		const ms4 = { id: 'm', type: 'milestones', rule: true, items: ['1', '2', '3', '4'].map((x) => ({ title: t(x), label: t(x) })) };
		const msWidths = (html: string) => [...html.matchAll(/class="ds-ms" style="display:inline-block;width:100%;max-width:(\d+)px;/g)].map((m) => Number(m[1]));
		const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

		it('a full section sits outside the padded runs and spans the card; the card cell has no padding', () => {
			const canvas = { backdrop: '#0b1f3a', width: 600 } as const;
			const inner = renderBlocksEmailHtml([hero(), para('after')], canvas);
			// The section table is a direct child of the card body, not inside a padding wrapper.
			expect(inner.startsWith('<!--ds-canvas--><table role="presentation"')).toBe(true);
			expect(inner).toContain('<div class="ds-pad" style="padding:0 24px;"><p ');
			expect(inner.indexOf('ds-pad')).toBeGreaterThan(inner.indexOf('bgcolor="#fcb900"'));
			const html = renderEmailHtmlFromContent(inner, { canvas, signature: LEGACY_SIGNATURE });
			expect(html).toContain('<td class="email" style="max-width:none;padding:0;');
			expect(html).toContain('<div class="signature" style="padding:0 24px 32px;">');
			// Content first: the card's top padding leads the document.
			expect(renderBlocksEmailHtml([para('a'), hero()], canvas)).toContain('<!--ds-canvas--><div style="height:32px;');
		});
		it('an inset section keeps its inset: inside the padded run', () => {
			const inner = renderBlocksEmailHtml([hero({ width: 'inset' })], { width: 600 });
			expect(inner).toMatch(/<div class="ds-pad" style="padding:0 24px;"><table [^>]*bgcolor="#fcb900"[^>]*border-radius:12px;/);
		});
		it('4 milestones in an lg section fit the inner width at cards 600 and 560 (and custom padding / columns)', () => {
			for (const width of [600, 560] as const) {
				const w = msWidths(renderBlocksEmailHtml([hero({}, [ms4])], { width }));
				expect(w).toHaveLength(4);
				expect(sum(w)).toBeLessThanOrEqual(width - 2 * 36);
				// Inset (in the padded run): card − card padding − section padding.
				const wi = msWidths(renderBlocksEmailHtml([hero({ width: 'inset' }, [ms4])], { width }));
				expect(sum(wi)).toBeLessThanOrEqual(width - 48 - 72);
			}
			const wc = msWidths(renderBlocksEmailHtml([hero({ padX: 60 }, [ms4])], { width: 560 }));
			expect(sum(wc)).toBeLessThanOrEqual(560 - 120);
			const cols = { id: 'c', type: 'columns', gap: 12, cells: [[ms4], [para('r')]] };
			const wk = msWidths(renderBlocksEmailHtml([hero({}, [cols])], { width: 560 }));
			expect(sum(wk)).toBeLessThanOrEqual(Math.floor((560 - 72) / 2) - 12 - 12);
		});
		it('no canvas: unchanged (no layout mark, no padding wrappers)', () => {
			const html = renderBlocksEmailHtml([hero({}, [ms4]), para('x')]);
			expect(html).not.toContain('ds-canvas');
			expect(html).not.toContain('ds-pad');
			expect(html.startsWith('<table role="presentation"')).toBe(true);
		});
		it('template content in a top-level area lays itself out; markdown content is padded', async () => {
			const tpl: TemplateRow = {
				name: 'T',
				kind: 'builder',
				blocks: JSON.stringify([hero(), { id: 'c', type: 'content' }]),
				html: null,
				use_global_header: 0,
				use_global_footer: 0,
				canvas: JSON.stringify({ width: 600 })
			};
			const blocks = await assembleBuilderEmail({} as D1Database, tpl, [hero({ bg: '#0b1f3a' }), para('body')], { header: [], footer: [] });
			expect(blocks.innerHtml).toMatch(/line-height:1\.6;"><table [^>]*bgcolor="#0b1f3a"/); // content's full section: edge to edge
			expect(blocks.innerHtml).toContain('<div class="ds-pad" style="padding:0 24px;"><p ');
			expect(blocks.innerHtml.match(/ds-canvas/g)).toHaveLength(1);
			const md = await assembleBuilderEmail({} as D1Database, tpl, 'Hello', { header: [], footer: [] });
			expect(md.innerHtml).toContain('<div class="ds-pad" style="padding:0 24px;"><p>Hello</p>');
		});
	});

	it('section custom padding, radius, border, background image, accent', () => {
		const blocks = [
			sec(
				{ padTop: 8, padBottom: 48, padX: 24, radius: 16, borderColor: '#0b1f3a', borderWidth: 2, bgImage: 'https://img.test/hero.jpg', accent: '#ce423b' },
				[
					{ id: 'e', type: 'eyebrow', content: t('Label') },
					{ id: 'm', type: 'milestones', rule: true, items: [{ title: t('1'), label: t('a') }, { title: t('2'), label: t('b') }] },
					{ id: 'st', type: 'list', ordered: true, style: 'steps', items: [t('A'), t('B')] },
					{ id: 'd', type: 'divider' }
				]
			)
		];
		const html = renderBlocksEmailHtml(blocks as Block[]);
		expect(html).toContain('padding:8px 24px 48px');
		expect(html).toContain('class="ds-sec"'); // no preset class: the phone media query would override custom padding
		expect(html).toContain('border-radius:16px;border:2px solid #0b1f3a;');
		expect(html).toContain('background="https://img.test/hero.jpg"');
		expect(html).toContain('background-image:url(https://img.test/hero.jpg)');
		expect(html).toContain('bgcolor="#1a9ec4"'); // the colour fallback stays
		expect(html).toContain('border-top:2px solid #ce423b'); // eyebrow rule
		expect(html).toContain('border-top:4px solid #ce423b'); // milestones rule
		expect(html).toContain('border:2px solid #ce423b;border-radius:50%'); // step circles
		expect(html).toContain('border-top:1px solid #ce423b;margin:24px 0;'); // divider
		expect(html).toMatchSnapshot();
		const page = renderPageHtml('P', blocks as Block[]);
		expect(page).toContain('padding:8px 24px 48px');
		expect(page).toContain('--acc:#ce423b');
		expect(page).toContain('border:2px solid #0b1f3a;');
	});

	it('button colours, radius, size, full width and link colour', () => {
		const b: Block[] = [
			{ id: 'b', type: 'button', label: 'Book', href: 'https://a.test', align: 'center', bg: '#0b1f3a', fg: '#fcb900', radius: 999, btnSize: 'lg' },
			{ id: 'b2', type: 'button', label: 'Wide', href: 'https://a.test', align: 'left', full: true, radius: 0, linkLabel: 'or reply', linkHref: 'mailto:a@b.test', linkColor: '#ce423b' }
		];
		const html = renderBlocksEmailHtml(b);
		expect(html).toContain('background:#0b1f3a;border-radius:999px;font-size:18px;line-height:24px;');
		expect(html).toContain('padding:15px 30px');
		expect(html).toContain('color:#fcb900;text-decoration:none;');
		expect(html).toContain(' width="100%"');
		expect(html).toContain('display:block;padding:11px 22px');
		expect(html).toContain('color:#ce423b;text-decoration:underline;');
		expect(html).toMatchSnapshot();
		const page = renderPageHtml('P', b);
		expect(page).toContain('style="background:#0b1f3a;color:#fcb900;border-radius:999px;padding:15px 30px;font-size:18px;line-height:24px;"');
		expect(page).toContain('display:block;text-align:center;');
	});

	it('per-block alignment overrides the section default; space below replaces the margin', () => {
		const blocks = [
			sec({ align: 'center' }, [
				{ id: 'h', type: 'heading', level: 2, text: 'Left', content: t('Left'), align: 'left', color: '#0b1f3a' },
				{ id: 'p', type: 'paragraph', content: t('Right'), align: 'right', spaceBelow: 48 },
				{ id: 'e', type: 'eyebrow', content: t('Eyebrow'), align: 'right' },
				{ id: 'i', type: 'image', src: 'https://a.test/x.png', alt: '', align: 'left' },
				{ id: 'i2', type: 'image', src: 'https://a.test/y.png', alt: '', width: 100, align: 'right', spaceBelow: 8 },
				{ id: 'm', type: 'milestones', rule: false, items: [{ title: t('1'), label: t('a') }, { title: t('2'), label: t('b') }], align: 'center' }
			])
		];
		const html = renderBlocksEmailHtml(blocks as Block[]);
		expect(html).toContain('margin:0 0 14px;text-align:left;color:#0b1f3a;');
		expect(html).toContain('margin:0 0 48px;text-align:right;');
		expect(html).toContain('style="margin:0 0 16px auto;"'); // eyebrow table pushed right
		expect(html).toContain('style="display:block;width:100%;max-width:'); // left image: no auto margins
		expect(html).toContain('<div style="margin:0 0 8px;"><img'); // image + space below
		expect(html).toContain('margin:0 0 0 auto;width:100%;max-width:100px');
		expect(html).toMatchSnapshot();
		const page = renderPageHtml('P', blocks as Block[]);
		expect(page).toContain('<h2 style="text-align:left;color:#0b1f3a;">');
		expect(page).toContain('<p style="text-align:right;margin-bottom:48px;">');
	});

	it('divider, spacer and columns options', () => {
		const html = renderBlocksEmailHtml([
			{ id: 'd', type: 'divider', color: '#0b1f3a', thickness: 3, short: true },
			{ id: 's', type: 'spacer', size: 'md', px: 40 },
			{ id: 'c', type: 'columns', gap: 24, valign: 'middle', stack: false, cells: [[{ id: 'a', type: 'paragraph', content: t('L') }], [{ id: 'b', type: 'paragraph', content: t('R') }]] },
			{ id: 'c2', type: 'columns', gap: 0, cells: [[], []] }
		]);
		expect(html).toContain('border-top:3px solid #0b1f3a;margin:24px 0;font-size:0;line-height:0;width:25%;');
		expect(html).toContain('height:40px;');
		expect(html).toContain('<td width="50%" valign="middle" style="padding:0 12px;');
		expect(html).toContain('max-width:300px;vertical-align:top;'); // gap 0
		expect(html).toMatchSnapshot();
	});

	it('a template canvas reaches the assembled email (content area included)', async () => {
		const tpl: TemplateRow = {
			name: 'T',
			kind: 'builder',
			blocks: JSON.stringify([{ id: 'c', type: 'content' }]),
			html: null,
			use_global_header: 0,
			use_global_footer: 0,
			canvas: JSON.stringify({ fontSize: 15, link: '#ce423b' })
		};
		const { innerHtml } = await assembleBuilderEmail({} as D1Database, tpl, [{ id: 'p', type: 'paragraph', content: t('Body') }], { header: [], footer: [] });
		expect(innerHtml).toContain('font-size:15px;line-height:1.6;">');
		const plain = await assembleBuilderEmail({} as D1Database, { ...tpl, canvas: null }, [{ id: 'p', type: 'paragraph', content: t('Body') }], { header: [], footer: [] });
		expect(plain.innerHtml).not.toContain('15px');
	});
});

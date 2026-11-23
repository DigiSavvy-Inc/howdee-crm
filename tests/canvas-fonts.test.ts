import { describe, it, expect } from 'vitest';
import {
	EMAIL_FONT,
	EMAIL_FONTS,
	fontStack,
	parseCanvas,
	renderBlocksEmailHtml,
	sanitizeCanvas,
	type Block
} from '../src/lib/blocks';
import { BRAND_FONT } from '../src/lib/brand';
import { renderEmailHtmlFromContent } from '../src/lib/server/email';
import { assembleBuilderEmail, type TemplateRow } from '../src/lib/server/templates';
import { KITCHEN_SINK } from './fixtures/kitchen-sink-blocks';

// #275: canvas typography — body font, heading font (defaults to the body font) and
// body line height, all chosen from fixed presets (no free-form CSS).

const t = (text: string) => [{ type: 'text' as const, text }];
const GEORGIA = fontStack('georgia');
const COURIER = fontStack('courier');
const blocks: Block[] = [
	{ id: 'h', type: 'heading', level: 2, text: 'Title', content: t('Title') },
	{ id: 'p', type: 'paragraph', content: t('Body') }
] as Block[];

describe('sanitizeCanvas: fonts', () => {
	it('keeps preset keys and line heights', () => {
		expect(sanitizeCanvas({ font: 'georgia', headingFont: 'courier', lineHeight: 1.8 })).toEqual({ font: 'georgia', headingFont: 'courier', lineHeight: 1.8 });
		for (const f of EMAIL_FONTS) expect(sanitizeCanvas({ font: f.key }).font).toBe(f.key);
	});
	it('drops anything else: free-form CSS, unknown keys, other line heights', () => {
		expect(
			sanitizeCanvas({
				font: 'Comic Sans MS',
				headingFont: "Georgia;}</style><script>alert(1)</script>",
				lineHeight: 2
			})
		).toEqual({});
		expect(sanitizeCanvas({ font: { key: 'georgia' }, headingFont: ['times'], lineHeight: '1.6' })).toEqual({});
		expect(parseCanvas(JSON.stringify({ font: 'verdana', lineHeight: 1.4 }))).toEqual({ font: 'verdana', lineHeight: 1.4 });
	});
	it('the system preset is the classic stack; unknown keys fall back to it', () => {
		expect(fontStack('system')).toBe(EMAIL_FONT);
		expect(fontStack(undefined)).toBe(EMAIL_FONT);
		expect(fontStack('nope')).toBe(EMAIL_FONT);
	});
});

describe('email render with the chosen fonts', () => {
	it('body font and line height reach the blocks; headings follow the body font by default', () => {
		const html = renderBlocksEmailHtml(blocks, { font: 'georgia', lineHeight: 1.8 });
		expect(html).toContain(`<p style="font-family:${GEORGIA};font-size:16px;line-height:1.8;`);
		expect(html).toContain(`<div style="font-family:${GEORGIA};font-size:`);
		expect(html).not.toContain(EMAIL_FONT);
	});
	it('a heading font applies to headings only', () => {
		const html = renderBlocksEmailHtml(blocks, { headingFont: 'courier' });
		expect(html).toContain(`<div style="font-family:${COURIER};font-size:`);
		expect(html).toContain(`<p style="font-family:${EMAIL_FONT};font-size:16px;line-height:1.6;`);
	});
	it('sections use the chosen body font instead of the brand font', () => {
		const sec = [{ id: 's', type: 'section', bg: '#0b1f3a', padding: 'md', width: 'full', blocks: [{ id: 'p', type: 'paragraph', content: t('Hi') }] }] as unknown as Block[];
		expect(renderBlocksEmailHtml(sec, { width: 600 })).toContain(`font-family:${BRAND_FONT}`);
		const html = renderBlocksEmailHtml(sec, { font: 'georgia' });
		expect(html).not.toContain(BRAND_FONT);
		expect(html).toContain(`font-family:${GEORGIA};`);
	});
	it('the canvas shell carries the body font, line height and heading font', () => {
		const canvas = { font: 'georgia', headingFont: 'courier', lineHeight: 1.4 } as const;
		const html = renderEmailHtmlFromContent(renderBlocksEmailHtml(blocks, canvas), { unsubscribe: true, canvas });
		expect(html).toContain(`font-size:16px;font-family:${GEORGIA};line-height:1.4;border-radius:0px;">`);
		expect(html).toContain(`.email h1, .email h2, .email h3 { font-family:${COURIER}; }`);
	});
	it('no font settings = the output is unchanged', () => {
		const before = renderBlocksEmailHtml(KITCHEN_SINK, { width: 600 });
		expect(renderBlocksEmailHtml(KITCHEN_SINK, sanitizeCanvas({ width: 600, font: 'bogus', lineHeight: 3 }))).toBe(before);
		expect(renderEmailHtmlFromContent('<p>x</p>', { canvas: { width: 600 } })).not.toContain('h3 { font-family');
	});
	it('markdown content in a template wears the canvas font', async () => {
		const tpl: TemplateRow = {
			name: 'T',
			kind: 'builder',
			blocks: JSON.stringify([{ id: 'c', type: 'content' }]),
			html: null,
			use_global_header: 0,
			use_global_footer: 0,
			canvas: JSON.stringify({ font: 'verdana', lineHeight: 1.8 })
		};
		const { innerHtml } = await assembleBuilderEmail({} as D1Database, tpl, 'Hello', { header: [], footer: [] });
		expect(innerHtml).toContain(`<div style="font-family:${fontStack('verdana')};font-size:16px;line-height:1.8;">`);
	});
});

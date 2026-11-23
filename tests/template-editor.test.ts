import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #255: email templates + the global header/footer use the visual editor. Old rows
// (markdown `text` blocks) still render as before; the editor opens them as rich blocks
// and Save writes the new shape.
import { load as templateLoad, actions as templateActions } from '../src/routes/templates/[id]/+page.server';
import { load as globalLoad, actions as globalActions } from '../src/routes/templates/global/+page.server';
import { POST as previewPOST } from '../src/routes/templates/preview/+server';
import { assembleBuilderEmail, blocksForEditor, readTemplateBlocks, SAMPLE_CONTENT, type TemplateRow } from '../src/lib/server/templates';
import { renderBodyInTemplate } from '../src/lib/server/compose-body';
import { CONTENT_PLACEHOLDER, renderBlocksEmailHtml, sanitizeBlocks, type Block } from '../src/lib/blocks';
import { markdownToBlocks, upgradeLegacyBlocks } from '../src/lib/blocks-markdown';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), PUBLIC_BASE_URL: 'https://app.test' };

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return fd;
}
function ev(path: string, params: Record<string, string> = {}, fields?: Record<string, string>) {
	const url = new URL(`https://app.test${path}`);
	const request = fields ? new Request(url, { method: 'POST', body: form(fields) }) : new Request(url);
	return { platform: { env: platformEnv }, params, url, request } as any;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// The pre-#255 shape: markdown inside text blocks, a content area in the middle.
const OLD_BLOCKS = [
	{ id: 'h1', type: 'heading', level: 1, text: 'Acme news' },
	{ id: 't1', type: 'text', md: 'Hello **{{first_name}}**, see [our site](https://acme.test).' },
	{ id: 'c1', type: 'content' },
	{ id: 't2', type: 'text', md: 'Thanks for reading', visibility: { kind: 'tag', name: 'vip' } }
];

const tplRow = (blocks: unknown, header = 0, footer = 0): TemplateRow => ({
	name: 'T',
	kind: 'builder',
	blocks: JSON.stringify(blocks),
	html: null,
	use_global_header: header,
	use_global_footer: footer
});

async function setChrome(header: unknown[], footer: unknown[]) {
	const up = db.prepare(
		`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
	);
	await db.batch([up.bind('global_email_header', JSON.stringify(header)), up.bind('global_email_footer', JSON.stringify(footer))]);
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM templates'),
		db.prepare("DELETE FROM app_state WHERE key IN ('global_email_header', 'global_email_footer')")
	]);
});

describe('old-shape templates render as before', () => {
	it('markdown text blocks, the content area and visibility render to the same HTML', async () => {
		const { innerHtml, text } = await assembleBuilderEmail(db, tplRow(OLD_BLOCKS), 'Body **here**');
		expect(innerHtml).toBe(
			[
				`<div style="font-family:${FONT};font-size:26px;font-weight:700;line-height:1.25;margin:0 0 14px;">Acme news</div>`,
				`<div style="font-family:${FONT};font-size:16px;line-height:1.6;"><p>Hello <strong>{{first_name}}</strong>, see <a href="https://acme.test">our site</a>.</p>\n</div>`,
				`<div style="font-family:${FONT};font-size:16px;line-height:1.6;"><p>Body <strong>here</strong></p>\n</div>`,
				`{{#if tag:vip}}<div style="font-family:${FONT};font-size:16px;line-height:1.6;"><p>Thanks for reading</p>\n</div>{{/if}}`
			].join('\n')
		);
		expect(text).toBe(
			'Acme news\n\nHello **{{first_name}}**, see [our site](https://acme.test).\n\nBody **here**\n\n{{#if tag:vip}}Thanks for reading\n{{/if}}'
		);
	});

	it('an old row nobody re-saved still sends through renderBodyInTemplate', async () => {
		const out = await renderBodyInTemplate(db, tplRow(OLD_BLOCKS), { blocks: null, md: 'Old body' });
		expect(out.html).toContain('Acme news');
		expect(out.html).toContain('<strong>{{first_name}}</strong>');
		expect(out.html).toContain('<p>Old body</p>');
		expect(out.html).not.toContain(CONTENT_PLACEHOLDER);
	});
});

describe('new shape', () => {
	it('the editor opens old rows as rich blocks (ids + visibility kept)', () => {
		const rich = blocksForEditor(JSON.stringify(OLD_BLOCKS), { allowContent: true });
		expect(rich.some((b) => b.type === 'text')).toBe(false);
		expect(rich.map((b) => b.type)).toEqual(['heading', 'paragraph', 'content', 'paragraph']);
		expect(rich[1].id).toBe('t1');
		expect(rich[3].visibility).toEqual({ kind: 'tag', name: 'vip' });
		expect(rich[1]).toMatchObject({
			content: [
				{ type: 'text', text: 'Hello ' },
				{ type: 'mergeTag', tag: 'first_name', marks: [{ type: 'bold' }] },
				{ type: 'text', text: ', see ' },
				{ type: 'text', text: 'our site', marks: [{ type: 'link', href: 'https://acme.test' }] },
				{ type: 'text', text: '.' }
			]
		});
	});

	it('converts text blocks inside columns too', () => {
		const up = upgradeLegacyBlocks([{ id: 'col', type: 'columns', cells: [[{ id: 'a', type: 'text', md: '# Hi\n\nthere' }], []] }]);
		expect(up[0]).toMatchObject({ type: 'columns', cells: [[{ type: 'heading', level: 1 }, { type: 'paragraph' }], []] });
	});

	it('round-trips: stored JSON → editor → stored JSON, and renders the same text', async () => {
		// #558: the editor document round trip itself is tested in @digisavvy/block-editor
		// (tests/template-editor.test.ts there); here the editor posts back what it opened.
		const rich = blocksForEditor(JSON.stringify(OLD_BLOCKS), { allowContent: true });
		const stored = readTemplateBlocks(JSON.stringify(rich), { allowContent: true });
		expect(stored.map((b) => b.id)).toEqual(rich.map((b) => b.id));
		expect(stored).toEqual(rich);
		const reopened = blocksForEditor(JSON.stringify(stored), { allowContent: true });
		expect(reopened).toEqual(stored);

		const { innerHtml } = await assembleBuilderEmail(db, tplRow(stored), 'Body');
		expect(innerHtml).toContain('Acme news');
		expect(innerHtml).toContain('<strong>{{first_name}}</strong>');
		expect(innerHtml).toContain('href="https://acme.test"');
		expect(innerHtml).toMatch(/\{\{#if tag:vip\}\}<p [^>]*>Thanks for reading<\/p>\{\{\/if\}\}/);
	});
});

describe('content-area substitution', () => {
	const tpl = tplRow([
		{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'TOP' }] },
		{ id: 'c', type: 'content' },
		{ id: 'q', type: 'paragraph', content: [{ type: 'text', text: 'BOTTOM' }] }
	]);

	it('fills the content area with campaign blocks', async () => {
		const body: Block[] = [{ id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'CAMPAIGN', marks: [{ type: 'bold' }] }] }];
		const out = await renderBodyInTemplate(db, tpl, { blocks: body, md: '' });
		const top = out.html.indexOf('TOP');
		const mid = out.html.indexOf('<strong>CAMPAIGN</strong>');
		const bot = out.html.indexOf('BOTTOM');
		expect(top).toBeGreaterThan(-1);
		expect(mid).toBeGreaterThan(top);
		expect(bot).toBeGreaterThan(mid);
		expect(out.text).toMatch(/TOP[\s\S]*CAMPAIGN[\s\S]*BOTTOM/);
		expect(out.html).not.toContain(CONTENT_PLACEHOLDER);
	});

	it('fills the content area with markdown content', async () => {
		const out = await renderBodyInTemplate(db, tpl, { blocks: null, md: 'Plain *markdown*' });
		expect(out.html).toMatch(/TOP[\s\S]*<em>markdown<\/em>[\s\S]*BOTTOM/);
		expect(out.text).toMatch(/TOP[\s\S]*Plain \*markdown\*[\s\S]*BOTTOM/);
	});

	it("a campaign body's own content block is dropped, not treated as a second area", async () => {
		const out = await renderBodyInTemplate(db, tpl, { blocks: [{ id: 'c2', type: 'content' }], md: '' });
		expect(out.html).not.toContain(CONTENT_PLACEHOLDER);
	});
});

describe('sanitiser: content area only in templates', () => {
	const doc = [{ id: 'a', type: 'content' }, { id: 'p', type: 'paragraph', content: [] }, { id: 'b', type: 'content' }];

	it('drops content blocks when not allowed', () => {
		expect(sanitizeBlocks(doc, { allowContent: false }).map((b) => b.type)).toEqual(['paragraph']);
		expect(readTemplateBlocks(JSON.stringify(doc), { allowContent: false }).map((b) => b.type)).toEqual(['paragraph']);
	});

	it('a template keeps one content area (the first)', () => {
		const out = readTemplateBlocks(JSON.stringify(doc), { allowContent: true });
		expect(out.map((b) => `${b.type}:${b.id}`)).toEqual(['content:a', 'paragraph:p']);
	});

	it('never inside columns', () => {
		const out = readTemplateBlocks(JSON.stringify([{ id: 'k', type: 'columns', cells: [[{ id: 'c', type: 'content' }], []] }]), { allowContent: true });
		expect(out[0]).toMatchObject({ type: 'columns', cells: [[], []] });
	});

	it('strips script URLs and unknown blocks on save', () => {
		const out = readTemplateBlocks(
			JSON.stringify([{ id: 'x', type: 'html', html: '<script>' }, { id: 'b', type: 'button', label: 'Go', href: 'javascript:alert(1)', align: 'left' }]),
			{ allowContent: true }
		);
		expect(out).toEqual([{ id: 'b', type: 'button', label: 'Go', href: '', align: 'left' }]);
	});
});

describe('template page', () => {
	async function insertTemplate(blocks: unknown): Promise<number> {
		const r = await db
			.prepare("INSERT INTO templates (name, kind, blocks, use_global_header, use_global_footer) VALUES ('T', 'builder', ?, 1, 1) RETURNING id")
			.bind(JSON.stringify(blocks))
			.first<{ id: number }>();
		return r!.id;
	}

	it('load converts the old shape; save writes the new shape with one content area', async () => {
		const id = await insertTemplate(OLD_BLOCKS);
		const loaded = (await templateLoad(ev(`/templates/${id}`, { id: String(id) }))) as any;
		expect(loaded.template.blocks.some((b: Block) => b.type === 'text')).toBe(false);
		expect(loaded.mergeTags.length).toBeGreaterThan(0);

		const posted = [...loaded.template.blocks, { id: 'extra', type: 'content' }];
		const res = await templateActions.save(ev(`/templates/${id}?/save`, { id: String(id) }, { name: 'Renamed', blocks: JSON.stringify(posted), use_global_footer: '1' }));
		expect(res).toEqual({ saved: true });
		const row = await db.prepare('SELECT name, blocks, use_global_header, use_global_footer FROM templates WHERE id = ?').bind(id).first<any>();
		expect(row.name).toBe('Renamed');
		expect(row.use_global_header).toBe(0);
		expect(row.use_global_footer).toBe(1);
		const stored = JSON.parse(row.blocks) as Block[];
		expect(stored).toEqual(loaded.template.blocks);
		expect(stored.filter((b) => b.type === 'content')).toHaveLength(1);
	});

	it('raw HTML templates are unchanged', async () => {
		const r = await db.prepare("INSERT INTO templates (name, kind, html) VALUES ('H', 'html', '<p>x</p>') RETURNING id").first<{ id: number }>();
		const loaded = (await templateLoad(ev(`/templates/${r!.id}`, { id: String(r!.id) }))) as any;
		expect(loaded.template.html).toBe('<p>x</p>');
		await templateActions.save(ev(`/templates/${r!.id}?/save`, { id: String(r!.id) }, { name: 'H', html: '<p>y</p>' }));
		const row = await db.prepare('SELECT html, blocks FROM templates WHERE id = ?').bind(r!.id).first<any>();
		expect(row).toEqual({ html: '<p>y</p>', blocks: null });
	});
});

describe('global header / footer', () => {
	const header: Block[] = [{ id: 'hh', type: 'paragraph', content: [{ type: 'text', text: 'HEADER' }] }];
	const footer: Block[] = [{ id: 'ff', type: 'paragraph', content: [{ type: 'text', text: 'FOOTER' }] }];

	it('load converts old markdown header/footer', async () => {
		await setChrome([{ id: 'oh', type: 'text', md: '**Logo**' }], [{ id: 'of', type: 'text', md: 'Bye' }]);
		const loaded = (await globalLoad(ev('/templates/global'))) as any;
		expect(loaded.header).toEqual([{ id: 'oh', type: 'paragraph', content: [{ type: 'text', text: 'Logo', marks: [{ type: 'bold' }] }] }]);
		expect(loaded.footer).toEqual(markdownToBlocks('Bye').map((b) => ({ ...b, id: 'of' })));
	});

	it('old markdown header/footer still render in a send', async () => {
		await setChrome([{ id: 'oh', type: 'text', md: '**Logo**' }], [{ id: 'of', type: 'text', md: 'Bye' }]);
		const { innerHtml } = await assembleBuilderEmail(db, tplRow([{ id: 'c', type: 'content' }], 1, 1), 'Mid');
		expect(innerHtml).toMatch(/<strong>Logo<\/strong>[\s\S]*<p>Mid<\/p>[\s\S]*<p>Bye<\/p>/);
	});

	it('save stores sanitised blocks (no content area) and sends wrap with them', async () => {
		const res = await globalActions.save(
			ev('/templates/global?/save', {}, { header: JSON.stringify([...header, { id: 'c', type: 'content' }]), footer: JSON.stringify(footer) })
		);
		expect(res).toEqual({ saved: true });
		const loaded = (await globalLoad(ev('/templates/global'))) as any;
		expect(loaded.header).toEqual(header);
		expect(loaded.footer).toEqual(footer);

		const out = await renderBodyInTemplate(db, tplRow([{ id: 'c', type: 'content' }], 1, 1), { blocks: null, md: 'MIDDLE' });
		expect(out.html).toMatch(/HEADER[\s\S]*MIDDLE[\s\S]*FOOTER/);
		const off = await renderBodyInTemplate(db, tplRow([{ id: 'c', type: 'content' }], 0, 0), { blocks: null, md: 'MIDDLE' });
		expect(off.html).not.toContain('HEADER');
		expect(off.html).not.toContain('FOOTER');
	});
});

describe('preview endpoint', () => {
	it('template: saved chrome + unsaved blocks + sample content', async () => {
		await setChrome(
			[{ id: 'hh', type: 'paragraph', content: [{ type: 'text', text: 'HEADER' }] }],
			[{ id: 'ff', type: 'paragraph', content: [{ type: 'text', text: 'FOOTER' }] }]
		);
		const blocks = [
			{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'TEMPLATE' }] },
			{ id: 'c', type: 'content' }
		];
		const res = await previewPOST(ev('/templates/preview', {}, { blocks: JSON.stringify(blocks), use_global_header: '1' }));
		const html = await res.text();
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(html).toMatch(/HEADER[\s\S]*TEMPLATE[\s\S]*Your campaign headline/);
		expect(html).not.toContain('FOOTER');
		expect(html).not.toContain(CONTENT_PLACEHOLDER);
		expect(html).toContain('<html');
	});

	it('global page: unsaved header + sample content + unsaved footer', async () => {
		const res = await previewPOST(
			ev('/templates/preview', {}, {
				header: JSON.stringify([{ id: 'h', type: 'paragraph', content: [{ type: 'text', text: 'NEWHEAD' }] }]),
				footer: JSON.stringify([{ id: 'f', type: 'paragraph', content: [{ type: 'text', text: 'NEWFOOT' }] }])
			})
		);
		const html = await res.text();
		expect(html).toMatch(/NEWHEAD[\s\S]*Your campaign headline[\s\S]*NEWFOOT/);
	});

	it('sample content is the real markdown renderer output', () => {
		expect(renderBlocksEmailHtml(markdownToBlocks(SAMPLE_CONTENT))).toContain('Your campaign headline');
	});
});

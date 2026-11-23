import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #261: landing pages use the visual editor, plus the editor polish (image width,
// keyboard block moves, paste cleanup, buttons without a link).
// #558: the editor itself is @digisavvy/block-editor; its document round trip, block
// moves and paste cleanup are tested there (tests/page-editor.test.ts). Here the editor
// posts back the blocks it opened.
import { load as pageLoad, actions as pageActions } from '../src/routes/pages/[id]/+page.server';
import { GET as publicGET } from '../src/routes/p/[slug]/+server';
import { pageBlocksForEditor, readPageBlocks } from '../src/lib/server/pages';
import { renderBody, readComposeBody } from '../src/lib/server/compose-body';
import { assembleBuilderEmail } from '../src/lib/server/templates';
import {
	clampImageWidthPct,
	renderBlocksEmailHtml,
	renderBlocksEmailText,
	renderPageHtml,
	sanitizeBlocks,
	type Block
} from '../src/lib/blocks';
import { blocksToMarkdown } from '../src/lib/blocks-markdown';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), PUBLIC_BASE_URL: 'https://app.test' };

function ev(path: string, params: Record<string, string> = {}, fields?: Record<string, string>) {
	const url = new URL(`https://app.test${path}`);
	let request = new Request(url);
	if (fields) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.append(k, v);
		request = new Request(url, { method: 'POST', body: fd });
	}
	return { platform: { env: platformEnv }, params, url, request } as any;
}

/** The <main> of a rendered page. */
const bodyOf = (html: string) => /<main class="page">\n([\s\S]*)\n<\/main>/.exec(html)?.[1] ?? '';
/** Visible text of some HTML, whitespace collapsed. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// A page saved by the old PageBuilder: markdown text blocks, inside columns too.
const OLD_PAGE: Block[] = [
	{ id: 'h', type: 'heading', level: 1, text: 'Welcome' },
	{ id: 't1', type: 'text', md: 'Thanks for **signing up**. Read [the guide](https://acme.test/guide).\n\n- one\n- two' },
	{ id: 'img', type: 'image', src: 'https://cdn.test/a.png', alt: 'A', href: 'https://acme.test', width: 300 },
	{ id: 'b', type: 'button', label: 'Book a call', href: 'https://acme.test/book', align: 'center' },
	{ id: 'd', type: 'divider' },
	{ id: 's', type: 'spacer', size: 'lg' },
	{ id: 'c', type: 'columns', cells: [[{ id: 'c1', type: 'text', md: '## Left\n\nleft text' }], [{ id: 'c2', type: 'text', md: 'right *text*' }]] }
];

describe('old-shape pages', () => {
	it('render exactly as before (render accepts the legacy shape forever)', () => {
		expect(bodyOf(renderPageHtml('Old', OLD_PAGE))).toBe(
			[
				'<h1>Welcome</h1>',
				'<div class="b-text"><p>Thanks for <strong>signing up</strong>. Read <a href="https://acme.test/guide">the guide</a>.</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</div>',
				'<div class="b-img"><a href="https://acme.test"><img src="https://cdn.test/a.png" alt="A" loading="lazy" style="max-width:300px"></a></div>',
				'<div class="b-btn" style="text-align:center"><a class="btn" href="https://acme.test/book">Book a call</a></div>',
				'<hr>',
				'<div style="height:56px"></div>',
				'<div class="cols cols-2"><div class="col"><div class="b-text"><h2>Left</h2>\n<p>left text</p>\n</div></div>\n<div class="col"><div class="b-text"><p>right <em>text</em></p>\n</div></div></div>'
			].join('\n')
		);
	});

	it('open converted, and the converted page renders the same content', () => {
		const rich = pageBlocksForEditor(JSON.stringify(OLD_PAGE));
		expect(JSON.stringify(rich)).not.toContain('"type":"text","md"');
		expect(rich.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'image', 'button', 'divider', 'spacer', 'columns']);
		expect(rich[1].id).toBe('t1');
		const before = bodyOf(renderPageHtml('Old', OLD_PAGE));
		const after = bodyOf(renderPageHtml('Old', rich));
		expect(textOf(after)).toBe(textOf(before));
		for (const bit of ['<strong>signing up</strong>', '<a href="https://acme.test/guide">the guide</a>', '<li>one</li>', '<h2>Left</h2>', '<em>text</em>', 'max-width:300px', 'href="https://acme.test/book"']) {
			expect(after).toContain(bit);
		}
	});
});

describe('new-shape pages', () => {
	it('round-trip: stored → editor → stored is stable and renders the same', () => {
		const rich = pageBlocksForEditor(JSON.stringify(OLD_PAGE));
		const stored = readPageBlocks(JSON.stringify(rich));
		expect(stored.map((b) => b.id)).toEqual(rich.map((b) => b.id));
		expect(stored).toEqual(rich);
		expect(pageBlocksForEditor(JSON.stringify(stored))).toEqual(stored);
		expect(renderPageHtml('P', stored)).toBe(renderPageHtml('P', rich));
	});

	it('every page block survives save and renders as web HTML; a content area does not', () => {
		const all: Block[] = [
			{ id: 'h3', type: 'heading', level: 3, text: 'Small', content: [{ type: 'text', text: 'Small' }] },
			{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'underline' }] }] },
			{ id: 'l', type: 'list', ordered: true, items: [[{ type: 'text', text: 'a' }]] },
			{ id: 'q', type: 'quote', content: [{ type: 'text', text: 'quoted' }] },
			{ id: 'co', type: 'callout', content: [{ type: 'text', text: 'note' }] },
			{ id: 'i', type: 'image', src: 'https://cdn.test/b.png', alt: 'B', href: 'https://acme.test', widthPct: 50 },
			{ id: 'b', type: 'button', label: 'Go', href: 'https://acme.test', align: 'right' },
			{ id: 'd', type: 'divider' },
			{ id: 's', type: 'spacer', size: 'sm' },
			{
				id: 'c',
				type: 'columns',
				cells: ['x', 'y', 'z'].map((t) => [{ id: t, type: 'paragraph', content: [{ type: 'text', text: t }] }] as Block[])
			},
			{ id: 'ca', type: 'content' }
		];
		const stored = readPageBlocks(JSON.stringify(all));
		expect(stored.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'callout', 'image', 'button', 'divider', 'spacer', 'columns']);
		const html = bodyOf(renderPageHtml('All', stored));
		for (const bit of ['<h3>Small</h3>', '<u>Hi</u>', '<ol><li>a</li></ol>', '<blockquote>quoted</blockquote>', '<div class="b-callout">note</div>', 'style="width:50%"', 'class="btn" href="https://acme.test">Go</a>', '<hr>', 'height:12px', 'cols cols-3']) {
			expect(html).toContain(bit);
		}
	});
});

describe('/pages/[id] + /p/[slug]', () => {
	beforeEach(async () => {
		await db.prepare('DELETE FROM pages').run();
	});

	it('loads an old row converted, saves the new shape, and serves it publicly', async () => {
		const row = await db
			.prepare("INSERT INTO pages (slug, title, blocks, published) VALUES ('hello', 'Hello', ?, 1) RETURNING id")
			.bind(JSON.stringify(OLD_PAGE))
			.first<{ id: number }>();
		const id = String(row!.id);
		const loaded = (await pageLoad(ev(`/pages/${id}`, { id }))) as any;
		expect(loaded.page.blocks.some((b: Block) => b.type === 'text')).toBe(false);

		// Before anyone re-saves, the public page is the old render.
		const oldRes = await publicGET(ev('/p/hello', { slug: 'hello' }));
		expect(await oldRes.text()).toContain('<div class="b-text">');

		const edited: Block[] = loaded.page.blocks;
		const res = (await pageActions.save!(ev(`/pages/${id}`, { id }, { title: 'Hello', slug: 'hello', blocks: JSON.stringify(edited) }))) as any;
		expect(res).toEqual({ saved: true });
		const stored = await db.prepare('SELECT blocks FROM pages WHERE id = ?').bind(id).first<{ blocks: string }>();
		expect(JSON.parse(stored!.blocks)).toEqual(edited);

		const html = await (await publicGET(ev('/p/hello', { slug: 'hello' }))).text();
		expect(html).not.toContain('b-text');
		expect(html).toContain('<strong>signing up</strong>');
	});

	it('refuses a page too long to store instead of saving broken JSON', async () => {
		const row = await db.prepare("INSERT INTO pages (slug, title) VALUES ('big', 'Big') RETURNING id").first<{ id: number }>();
		const id = String(row!.id);
		const huge = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(400) }] }));
		const res = (await pageActions.save!(ev(`/pages/${id}`, { id }, { title: 'Big', slug: 'big', blocks: JSON.stringify(huge) }))) as any;
		expect(res.status).toBe(400);
		const stored = await db.prepare('SELECT blocks FROM pages WHERE id = ?').bind(id).first<{ blocks: string }>();
		expect(stored!.blocks).toBe('[]');
	});
});

describe('image width', () => {
	it('clamps to 10–100 % and drops full width / junk', () => {
		expect(clampImageWidthPct(50)).toBe(50);
		expect(clampImageWidthPct('33.6')).toBe(34);
		expect(clampImageWidthPct(3)).toBe(10);
		expect(clampImageWidthPct(-20)).toBe(10);
		expect(clampImageWidthPct(250)).toBeUndefined();
		expect(clampImageWidthPct(100)).toBeUndefined();
		expect(clampImageWidthPct('wide')).toBeUndefined();
		expect(clampImageWidthPct(null)).toBeUndefined();
	});

	it('the sanitiser clamps it, and % wins over the legacy pixel width', () => {
		const [a, b, c] = sanitizeBlocks([
			{ id: 'a', type: 'image', src: 'https://cdn.test/a.png', alt: '', widthPct: 4 },
			{ id: 'b', type: 'image', src: 'https://cdn.test/a.png', alt: '', widthPct: 60, width: 300 },
			{ id: 'c', type: 'image', src: 'https://cdn.test/a.png', alt: '', widthPct: 'x', width: 300 }
		]);
		expect(a).toMatchObject({ widthPct: 10 });
		expect(b).toMatchObject({ widthPct: 60 });
		expect(b).not.toHaveProperty('width');
		expect(c).toMatchObject({ width: 300 });
		expect(c).not.toHaveProperty('widthPct');
	});

	it('renders as a share of the column in email and on pages', () => {
		const img: Block = { id: 'i', type: 'image', src: 'https://cdn.test/a.png', alt: 'A', widthPct: 50 };
		expect(renderBlocksEmailHtml([img])).toContain('width="300" style="display:block;width:100%;max-width:300px;');
		const inCell = renderBlocksEmailHtml([{ id: 'c', type: 'columns', cells: [[img], []] }]);
		expect(inCell).toContain('width="138"'); // (288 - 12) / 2
		expect(renderPageHtml('P', [img])).toContain('style="width:50%"');
	});
});

describe('buttons without a link', () => {
	const blocks: Block[] = [
		{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] },
		{ id: 'b1', type: 'button', label: 'Nowhere', href: '', align: 'left' },
		{ id: 'b2', type: 'button', label: 'Bad', href: 'javascript:alert(1)', align: 'left' }
	];

	it('are skipped by every renderer: email html/text, markdown export, page', () => {
		for (const out of [renderBlocksEmailHtml(blocks), renderBlocksEmailText(blocks), blocksToMarkdown(sanitizeBlocks(blocks)), renderPageHtml('P', blocks)]) {
			expect(out).not.toContain('Nowhere');
			expect(out).not.toContain('Bad');
			expect(out).toContain('Hi');
		}
	});

	it('are skipped the same way for campaigns / steps (compose body) and templates', async () => {
		const fd = new FormData();
		fd.set('body_blocks', JSON.stringify(blocks));
		const sent = renderBody(readComposeBody(fd));
		expect(sent.html).not.toContain('Nowhere');
		expect(sent.text).not.toContain('Nowhere');
		const tpl = await assembleBuilderEmail(
			db,
			{ name: 'T', kind: 'builder', blocks: JSON.stringify([...blocks, { id: 'ca', type: 'content' }]), html: null, use_global_header: 0, use_global_footer: 0 },
			blocks
		);
		expect(tpl.innerHtml).not.toContain('Nowhere');
		expect(tpl.innerHtml).toContain('Hi');
	});
});

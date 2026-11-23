import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #493: "Copy as newsletter archive page" turns a builder email template into a web template.
import { actions, load } from '../src/routes/templates/[id]/+page.server';
import { GET as indexGET } from '../src/routes/newsletter/+server';
import { archiveTemplate, getArchiveSettings, saveArchiveSettings } from '../src/lib/server/newsletter-archive';
import { countContentAreas, type Block } from '../src/lib/blocks';
import { webCanvasFromEmail } from '../src/lib/newsletter-archive';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), PUBLIC_BASE_URL: 'https://app.test' };

function ev(path: string, params: Record<string, string>, post = false) {
	const url = new URL(`https://app.test${path}`);
	const request = post ? new Request(url, { method: 'POST', body: new FormData() }) : new Request(url);
	return { platform: { env: platformEnv }, params, url, locals: {}, request } as any;
}

async function copy(id: number): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await actions.copyAsWeb!(ev(`/templates/${id}?/copyAsWeb`, { id: String(id) }, true)) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}

const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ type: 'text', text }] });

async function insert(name: string, kind: string, blocks: unknown[], o: { canvas?: unknown; header?: number; footer?: number } = {}) {
	const r = await db
		.prepare('INSERT INTO templates (name, kind, blocks, canvas, use_global_header, use_global_footer) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(name, kind, JSON.stringify(blocks), o.canvas ? JSON.stringify(o.canvas) : null, o.header ?? 0, o.footer ?? 0)
		.first<{ id: number }>();
	return r!.id;
}

const row = (id: number) =>
	db.prepare('SELECT name, kind, blocks, canvas FROM templates WHERE id = ?').bind(id).first<{ name: string; kind: string; blocks: string; canvas: string | null }>();
const newId = (redirect: string) => Number(/\/templates\/(\d+)\?copied=1$/.exec(redirect)![1]);

function allIds(blocks: Block[]): string[] {
	return blocks.flatMap((b) => [
		b.id,
		...(b.type === 'section' ? allIds(b.blocks) : []),
		...(b.type === 'columns' ? b.cells.flatMap(allIds) : [])
	]);
}

beforeEach(async () => {
	const up = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
	await db.batch([
		db.prepare('DELETE FROM templates'),
		up.bind('global_email_header', JSON.stringify([para('gh', 'GLOBAL HEADER')])),
		up.bind('global_email_footer', JSON.stringify([para('gf', 'GLOBAL FOOTER')]))
	]);
});

describe('copyAsWeb', () => {
	it('copies header + blocks + footer into a web template with one content area and fresh ids', async () => {
		const src = [
			para('a', 'SOURCE TOP'),
			{ id: 'sec', type: 'section', bg: '#ffffff', padding: 'md', width: 'inset', blocks: [para('in', 'IN SECTION')] },
			{ id: 'c1', type: 'content' },
			{ id: 'c2', type: 'content' },
			para('z', 'SOURCE BOTTOM')
		];
		const sid = await insert('Foo', 'builder', src, { header: 1, footer: 1 });
		const { redirect } = await copy(sid);
		expect(redirect).toMatch(/^\/templates\/\d+\?copied=1$/);
		const t = (await row(newId(redirect!)))!;
		expect(t.kind).toBe('web');
		expect(t.name).toBe('Foo (web)');
		const blocks = JSON.parse(t.blocks) as Block[];
		const text = JSON.stringify(blocks);
		const order = ['GLOBAL HEADER', 'SOURCE TOP', 'IN SECTION', 'SOURCE BOTTOM', 'GLOBAL FOOTER'].map((s) => text.indexOf(s));
		expect(order.every((i) => i > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(countContentAreas(blocks)).toBe(1);
		const ids = allIds(blocks);
		expect(new Set(ids).size).toBe(ids.length);
		for (const old of ['a', 'sec', 'in', 'c1', 'c2', 'z', 'gh', 'gf']) expect(ids).not.toContain(old);
	});

	it('appends a content area when the source has none; skips chrome when the toggles are off', async () => {
		const sid = await insert('NoContent', 'builder', [para('a', 'ONLY')]);
		const t = (await row(newId((await copy(sid)).redirect!)))!;
		const blocks = JSON.parse(t.blocks) as Block[];
		expect(blocks.at(-1)!.type).toBe('content');
		expect(t.blocks).not.toContain('GLOBAL HEADER');
		expect(t.blocks).not.toContain('GLOBAL FOOTER');
	});

	it('maps the email canvas (ties go to the larger width); an empty canvas stores NULL', async () => {
		const sid = await insert('Canvas', 'builder', [], { canvas: { backdrop: '#112233', width: 640, fontSize: 15, link: '#445566', font: 'georgia', radius: 8 } });
		const t = (await row(newId((await copy(sid)).redirect!)))!;
		expect(JSON.parse(t.canvas!)).toEqual({ bg: '#112233', width: 680, fontSize: 16, link: '#445566', font: 'serif' });
		expect(webCanvasFromEmail({ width: 560, fontSize: 17, font: 'verdana' })).toEqual({ width: 600, fontSize: 17 });

		const eid = await insert('Plain', 'builder', []);
		expect((await row(newId((await copy(eid)).redirect!)))!.canvas).toBeNull();
	});

	it('picks the next free name on a collision', async () => {
		await insert('Foo (web)', 'web', []);
		await insert('Foo (web) 2', 'web', []);
		const sid = await insert('Foo', 'builder', []);
		expect((await row(newId((await copy(sid)).redirect!)))!.name).toBe('Foo (web) 3');
	});

	it('refuses html and web sources (400, nothing inserted)', async () => {
		const h = await insert('Html', 'html', []);
		const w = await insert('Web', 'web', []);
		for (const sid of [h, w]) {
			const { result, redirect } = await copy(sid);
			expect(redirect).toBeUndefined();
			expect(result.status).toBe(400);
		}
		const n = await db.prepare('SELECT COUNT(*) AS n FROM templates').first<{ n: number }>();
		expect(n!.n).toBe(2);
	});

	it('the new page shows the copied notice', async () => {
		const sid = await insert('Foo', 'builder', []);
		const nid = newId((await copy(sid)).redirect!);
		const data = (await load(ev(`/templates/${nid}?copied=1`, { id: String(nid) }))) as any;
		expect(data.copied).toBe(true);
		expect(data.template.kind).toBe('web');
	});

	it('the archive renders the copy: header blocks in nl-head, footer blocks in nl-foot', async () => {
		const sid = await insert('Foo', 'builder', [para('a', 'SOURCE TOP'), { id: 'c', type: 'content' }], { header: 1, footer: 1 });
		const nid = newId((await copy(sid)).redirect!);
		expect(
			await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: nid, indexable: true, autoGroups: [] })
		).toBeNull();
		const tpl = await archiveTemplate(db, await getArchiveSettings(db), 'https://app.test');
		expect(JSON.stringify(tpl.blocks)).toContain('GLOBAL HEADER');
		const res = await indexGET(ev('/newsletter', {}));
		const body = await res.text();
		expect(body).toMatch(/<header class="nl-head">[\s\S]*GLOBAL HEADER[\s\S]*SOURCE TOP[\s\S]*<\/header>/);
		expect(body).toMatch(/<footer class="nl-foot">[\s\S]*GLOBAL FOOTER[\s\S]*<\/footer>/);
	});
});

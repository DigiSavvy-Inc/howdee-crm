import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #250: compose with the visual editor — body_blocks drives send / test / draft /
// schedule / preview; a body_md-only row falls back exactly as before.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { actions as compose, load as composeLoad } from '../src/routes/compose/+page.server';
import { POST as previewPOST } from '../src/routes/compose/preview/+server';
import { createDraft } from '../src/lib/server/campaign-drafts';
import { renderEmailHtml, renderEmailText } from '../src/lib/server/email';
import type { Block } from '../src/lib/blocks';

const db = (env as any).DB as D1Database;
const platformEnv = {
	...(env as any),
	POSTMARK_TOKEN: 'test',
	POSTMARK_STREAM: 'broadcast',
	SESSION_SECRET: 'secret',
	PUBLIC_BASE_URL: 'https://app.test'
};

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return fd;
}
function actionEvent(action: string, fields: Record<string, string>) {
	const url = new URL(`https://app.test/compose?/${action}`);
	return { platform: { env: platformEnv }, params: {}, url, request: new Request(url, { method: 'POST', body: form(fields) }) } as any;
}
async function run(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}
const row = (id: number) => db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<any>();
const loadDraft = async (id: number): Promise<any> =>
	((await composeLoad({ platform: { env: platformEnv }, url: new URL(`https://app.test/compose?draft=${id}`) } as any)) as any).draft;

const blocks: Block[] = [
	{ id: 'h', type: 'heading', level: 2, text: 'Hi {{first_name}}', content: [{ type: 'text', text: 'Hi ' }, { type: 'mergeTag', tag: 'first_name' }] },
	{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Read ' }, { type: 'text', text: 'this', marks: [{ type: 'link', href: 'https://example.com/x' }] }] },
	{ id: 'b', type: 'button', label: 'Go', href: 'https://example.com/go', align: 'center' }
];
const blocksJson = JSON.stringify(blocks);

let listId: number;
beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockResolvedValue({ accepted: 1, failed: 0, firstError: null });
	spies.sendBatch.mockResolvedValue([{ ErrorCode: 0, Message: 'OK', MessageID: 'm-1' }]);
	await db.batch([
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	const c = await db.prepare("INSERT INTO contacts (email, first_name, subscribed) VALUES ('ann@example.com', 'Ann', 1) RETURNING id").first<{ id: number }>();
	listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c!.id).run();
});

// #311: the fixtures link to example.com, which the pre-send checks block.
const base = { subject: 'Hello', from: 'alan@ourco.example', send_anyway: '1' };

describe('body_blocks send path', () => {
	it('sends the block render and stores blocks + a markdown export', async () => {
		const r = await run(compose.send!, actionEvent('send', { ...base, body_blocks: blocksJson, list_id: String(listId) }));
		const id = Number(r.redirect!.match(/campaign\/(\d+)/)![1]);
		const sent = spies.sendCampaignEmail.mock.calls[0][1];
		expect(sent.htmlTemplate).toContain('Hi {{first_name}}');
		expect(sent.htmlTemplate).toContain('<a href="https://example.com/x" style="color:#2563eb;text-decoration:underline;">this</a>');
		expect(sent.htmlTemplate).toContain('role="presentation" border="0" cellpadding="0" cellspacing="0" align="center"');
		expect(sent.textTemplate).toContain('Go: https://example.com/go');
		const c = await row(id);
		expect(JSON.parse(c.body_blocks)).toEqual(blocks);
		expect(c.body_md).toBe('## Hi {{first_name}}\n\nRead [this](https://example.com/x)\n\n[Go](https://example.com/go)');
		expect(c.body_html).toBe(sent.htmlTemplate);
	});

	it('sanitises posted blocks before they are stored or sent', async () => {
		const evil = JSON.stringify([
			{ id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'link', href: 'javascript:alert(1)' }] }] },
			{ id: 'y', type: 'html', html: '<script>alert(1)</script>' }
		]);
		const r = await run(compose.send!, actionEvent('send', { ...base, body_blocks: evil, list_id: String(listId) }));
		const id = Number(r.redirect!.match(/campaign\/(\d+)/)![1]);
		const c = await row(id);
		expect(c.body_blocks).toBe(JSON.stringify([{ id: 'x', type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }]));
		expect(c.body_html).not.toMatch(/javascript:|<script/);
	});

	it('refuses an empty block document', async () => {
		const empty = JSON.stringify([{ id: 'e', type: 'paragraph', content: [] }]);
		const r = await run(compose.send!, actionEvent('send', { ...base, body_blocks: empty, list_id: String(listId) }));
		expect(r.result?.status).toBe(400);
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('schedules with blocks (the heartbeat sends the stored render)', async () => {
		const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
		const r = await run(compose.send!, actionEvent('send', { ...base, body_blocks: blocksJson, list_id: String(listId), schedule_at: when }));
		const id = Number(r.redirect!.match(/campaign\/(\d+)/)![1]);
		const c = await row(id);
		expect(c.status).toBe('scheduled');
		expect(JSON.parse(c.body_blocks)).toEqual(blocks);
		expect(c.body_html).toContain('Hi {{first_name}}');
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});
});

describe('body_md fallback', () => {
	it('a markdown-only post sends exactly as before and leaves body_blocks NULL', async () => {
		const md = 'Hello **{{first_name}}**';
		const r = await run(compose.send!, actionEvent('send', { ...base, body_md: md, list_id: String(listId) }));
		const id = Number(r.redirect!.match(/campaign\/(\d+)/)![1]);
		const sent = spies.sendCampaignEmail.mock.calls[0][1];
		expect(sent.htmlTemplate).toBe(renderEmailHtml(md, { preheader: '', originNote: undefined }));
		expect(sent.textTemplate).toBe(renderEmailText(md, { originNote: undefined }));
		expect((await row(id)).body_blocks).toBeNull();
	});

	it('an old markdown draft opens without blocks and is not written by loading', async () => {
		const id = await createDraft(db, { subject: 'Old', body: '# Hi\n\nOld body' }, 'alan@ourco.example');
		const before = await row(id);
		const draft = await loadDraft(id);
		expect(draft.body_blocks).toBeNull();
		expect(draft.body_md).toBe('# Hi\n\nOld body');
		expect(await row(id)).toEqual(before);
	});
});

describe('drafts keep the blocks', () => {
	it('save → reload gives the identical block document; send promotes it', async () => {
		const saved = await run(compose.saveDraft!, actionEvent('saveDraft', { ...base, body_blocks: blocksJson }));
		const id = Number(saved.redirect!.match(/draft=(\d+)/)![1]);
		expect((await loadDraft(id)).body_blocks).toEqual(blocks);
		expect((await row(id)).body_md).toContain('## Hi {{first_name}}');

		const r = await run(compose.send!, actionEvent('send', { ...base, draft_id: String(id), body_blocks: blocksJson, list_id: String(listId) }));
		expect(r.redirect).toBe(`/campaign/${id}`);
		expect(JSON.parse((await row(id)).body_blocks)).toEqual(blocks);
	});
});

describe('test send and preview share the renderer', () => {
	it('test HTML is the preview HTML, personalised', async () => {
		const r = await run(compose.test!, actionEvent('test', { ...base, body_blocks: blocksJson, test_to: 'ann@example.com' }));
		expect(r.result).toMatchObject({ testSuccess: true });
		const msg = spies.sendBatch.mock.calls[0][1][0];

		const res = await previewPOST({ platform: { env: platformEnv }, request: new Request('https://app.test/compose/preview', { method: 'POST', body: form({ body_blocks: blocksJson }) }) } as any);
		const preview = await res.text();
		expect(preview).toContain('Hi {{first_name}}');
		expect(msg.HtmlBody).toContain('Hi Ann');
		// Same document once the per-recipient fills are applied.
		const strip = (s: string) => s.replace(/Hi (\{\{first_name\}\}|Ann)/, 'Hi X').replace(/href="[^"]*unsubscribe[^"]*"|href="%%UNSUB_URL%%"/, 'href="U"');
		expect(strip(msg.HtmlBody)).toBe(strip(preview));
	});
});

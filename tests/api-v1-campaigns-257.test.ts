import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #257: PATCH /api/v1/campaigns/:id respects campaigns.body_blocks (#250). A body change
// from the API is markdown and drops the blocks; a preheader-only change re-renders from
// the blocks; GET reports body_format.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { generateApiKey } from '../src/lib/server/api-keys';
import { GET as oneGET, PATCH } from '../src/routes/api/v1/campaigns/[id]/+server';
import { load as composeLoad } from '../src/routes/compose/+page.server';
import { renderEmailHtml } from '../src/lib/server/email';
import type { Block } from '../src/lib/blocks';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), PUBLIC_BASE_URL: 'https://app.test' };

async function makeKey(): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, 'read_write')`)
		.bind(k.tokenHash, k.prefix, k.last4)
		.run();
	return k.token;
}

function ev(id: number, method: string, token: string, body?: unknown) {
	const url = new URL(`https://app.test/api/v1/campaigns/${id}`);
	return {
		request: new Request(url, {
			method,
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		platform: { env: platformEnv },
		url,
		params: { id: String(id) }
	} as any;
}
const jsonOf = async (res: Response) => JSON.parse(await res.text());
const row = (id: number) => db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<any>();
const loadDraft = async (id: number): Promise<any> =>
	((await composeLoad({ platform: { env: platformEnv }, url: new URL(`https://app.test/compose?draft=${id}`) } as any)) as any).draft;

const blocks: Block[] = [
	{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] },
	{ id: 'b', type: 'button', label: 'Book a call', href: 'https://example.com/book', align: 'center' }
];
const blocksJson = JSON.stringify(blocks);

async function insertDraft(withBlocks: boolean): Promise<number> {
	const md = withBlocks ? 'Hello there\n\n[Book a call](https://example.com/book)' : '# Markdown draft';
	const r = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, body_text, from_email, status, recipient_count)
			 VALUES ('Draft', ?, ?, '<p>old</p>', 'old', 'alan@ourco.example', 'draft', 0) RETURNING id`
		)
		.bind(md, withBlocks ? blocksJson : null)
		.first<{ id: number }>();
	return r!.id;
}

let token: string;
beforeEach(async () => {
	vi.clearAllMocks();
	await db.batch([db.prepare('DELETE FROM api_keys'), db.prepare('DELETE FROM recipients'), db.prepare('DELETE FROM campaigns')]);
	token = await makeKey();
});

describe('PATCH /api/v1/campaigns/:id with body_blocks', () => {
	it('a body change on a blocks draft drops the blocks; compose loads the new markdown', async () => {
		const id = await insertDraft(true);
		const res = await PATCH(ev(id, 'PATCH', token, { body: '## From the **API**' }));
		expect(res.status).toBe(200);
		const r = await row(id);
		expect(r.body_blocks).toBeNull();
		expect(r.body_md).toBe('## From the **API**');
		expect(r.body_html).toContain('<strong>API</strong>');
		expect(r.body_html).not.toContain('background:#2563eb');
		const draft = await loadDraft(id);
		expect(draft.body_md).toBe('## From the **API**');
		expect(draft.body_blocks).toBeNull();
		expect((await jsonOf(await oneGET(ev(id, 'GET', token)))).data.body_format).toBe('markdown');
	});

	it('a preheader-only change on a blocks draft keeps the blocks and renders from them', async () => {
		const id = await insertDraft(true);
		const before = await row(id);
		const res = await PATCH(ev(id, 'PATCH', token, { preheader: 'Peek inside' }));
		expect(res.status).toBe(200);
		const r = await row(id);
		expect(r.body_blocks).toBe(blocksJson);
		expect(r.body_md).toBe(before.body_md);
		expect(r.preheader).toBe('Peek inside');
		expect(r.body_html).toContain('Peek inside');
		// The button block's own email markup, not the markdown export's plain link.
		expect(r.body_html).toMatch(/<td style="background:#2563eb;border-radius:8px;[^"]*"><a href="https:\/\/example\.com\/book"[^>]*>Book a call<\/a>/);
		expect(r.body_html).not.toBe(renderEmailHtml(before.body_md, { preheader: 'Peek inside' }));
		expect(r.body_text).toContain('Book a call');
		expect((await jsonOf(await oneGET(ev(id, 'GET', token)))).data.body_format).toBe('blocks');
	});

	it('a markdown draft behaves as before', async () => {
		const id = await insertDraft(false);
		expect((await jsonOf(await oneGET(ev(id, 'GET', token)))).data.body_format).toBe('markdown');
		await PATCH(ev(id, 'PATCH', token, { preheader: 'Peek' }));
		let r = await row(id);
		expect(r.body_blocks).toBeNull();
		expect(r.body_md).toBe('# Markdown draft');
		expect(r.body_html).toBe(renderEmailHtml('# Markdown draft', { preheader: 'Peek' }));
		await PATCH(ev(id, 'PATCH', token, { body: 'New *text*' }));
		r = await row(id);
		expect(r.body_md).toBe('New *text*');
		expect(r.body_html).toBe(renderEmailHtml('New *text*', { preheader: 'Peek' }));
		expect((await jsonOf(await oneGET(ev(id, 'GET', token)))).data.body_format).toBe('markdown');
	});
});

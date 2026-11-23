import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #238: every send/schedule entry point is mocked so we can prove none is ever called.
const spies = vi.hoisted(() => ({
	sendBatch: vi.fn(),
	suppress: vi.fn(),
	sendCampaignEmail: vi.fn(),
	fetch: vi.fn(),
	processScheduledCampaigns: vi.fn(),
	processScheduledResends: vi.fn()
}));
vi.mock('../src/lib/server/scheduled', async (orig) => ({
	...(await orig<any>()),
	processScheduledCampaigns: spies.processScheduledCampaigns,
	processScheduledResends: spies.processScheduledResends
}));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: spies.suppress }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));

import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { POST } from '../src/routes/api/v1/campaigns/+server';
import { DELETE } from '../src/routes/api/v1/campaigns/[id]/+server';
import { GET as listContacts } from '../src/routes/api/v1/contacts/+server';

const db = (env as any).DB as D1Database;

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, method: string, token: string | undefined, body?: unknown, params: Record<string, string> = {}) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		platform: { env },
		url,
		params
	} as any;
}
const jsonOf = async (res: Response) => JSON.parse(await res.text());
const draftBody = { subject: 'Hello draft', body: '# Hi\n\nSome **markdown**.' };

beforeEach(async () => {
	vi.clearAllMocks();
	globalThis.fetch = spies.fetch as any;
	await db.batch([db.prepare('DELETE FROM api_keys'), db.prepare("DELETE FROM campaigns WHERE subject LIKE 'Hello draft%'")]);
});

describe('POST /api/v1/campaigns', () => {
	it('401 without a key, 403 with a read key', async () => {
		expect((await POST(ev('/api/v1/campaigns', 'POST', undefined, draftBody))).status).toBe(401);
		const read = await makeKey('read');
		expect((await POST(ev('/api/v1/campaigns', 'POST', read, draftBody))).status).toBe(403);
	});

	it('400 on missing subject/body or any recipient/schedule field', async () => {
		const t = await makeKey('read_write');
		expect((await POST(ev('/api/v1/campaigns', 'POST', t, { body: 'x' }))).status).toBe(400);
		expect((await POST(ev('/api/v1/campaigns', 'POST', t, { subject: 'x' }))).status).toBe(400);
		expect((await POST(ev('/api/v1/campaigns', 'POST', t, { ...draftBody, list_id: 1 }))).status).toBe(400);
		expect((await POST(ev('/api/v1/campaigns', 'POST', t, { ...draftBody, scheduled_at: '2030-01-01' }))).status).toBe(400);
	});

	for (const scope of ['read_write', 'campaigns:draft'] as ApiScope[]) {
		it(`creates a 0-recipient draft with a ${scope} key and never sends or schedules`, async () => {
			const t = await makeKey(scope);
			const res = await POST(ev('/api/v1/campaigns', 'POST', t, draftBody));
			expect(res.status).toBe(201);
			const d = (await jsonOf(res)).data;
			expect(d.status).toBe('draft');
			expect(d.recipient_count).toBe(0);
			expect(d.compose_url).toMatch(new RegExp(`/compose\\?draft=${d.id}$`));

			const row = await db
				.prepare('SELECT status, list_id, recipient_count, scheduled_at, sent_at, body_md FROM campaigns WHERE id = ?')
				.bind(d.id)
				.first<any>();
			expect(row).toMatchObject({ status: 'draft', list_id: null, recipient_count: 0, scheduled_at: null, sent_at: null, body_md: draftBody.body });
			const rc = await db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?').bind(d.id).first<{ n: number }>();
			expect(rc!.n).toBe(0);

			expect(spies.sendBatch).not.toHaveBeenCalled();
			expect(spies.suppress).not.toHaveBeenCalled();
			expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
			expect(spies.processScheduledCampaigns).not.toHaveBeenCalled();
			expect(spies.processScheduledResends).not.toHaveBeenCalled();
			expect(spies.fetch).not.toHaveBeenCalled(); // no outbound HTTP (Postmark) at all
		});
	}
});

describe('campaigns:draft key is draft-only', () => {
	it('cannot read other /api/v1 resources', async () => {
		const t = await makeKey('campaigns:draft');
		expect((await listContacts(ev('/api/v1/contacts', 'GET', t))).status).toBe(403);
	});
});

describe('DELETE /api/v1/campaigns/:id', () => {
	it('a campaigns:draft key gets 403 on DELETE', async () => {
		const d = await makeKey('campaigns:draft');
		const { id } = (await jsonOf(await POST(ev('/api/v1/campaigns', 'POST', d, draftBody)))).data;
		expect((await DELETE(ev(`/api/v1/campaigns/${id}`, 'DELETE', d, undefined, { id: String(id) }))).status).toBe(403);
		expect(await db.prepare('SELECT id FROM campaigns WHERE id = ?').bind(id).first()).not.toBeNull();
	});

	it('read_write key deletes a draft, refuses non-drafts', async () => {
		const t = await makeKey('read_write');
		const { id } = (await jsonOf(await POST(ev('/api/v1/campaigns', 'POST', t, draftBody)))).data;
		expect((await DELETE(ev(`/api/v1/campaigns/${id}`, 'DELETE', t, undefined, { id: String(id) }))).status).toBe(204);
		expect(await db.prepare('SELECT id FROM campaigns WHERE id = ?').bind(id).first()).toBeNull();

		const sent = await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Hello draft sent', 'x', 'x', 'a@b.c', 'sent') RETURNING id")
			.first<{ id: number }>();
		expect((await DELETE(ev(`/api/v1/campaigns/${sent!.id}`, 'DELETE', t, undefined, { id: String(sent!.id) }))).status).toBe(404);
		expect(spies.fetch).not.toHaveBeenCalled();
	});
});

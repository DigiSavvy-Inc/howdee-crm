import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #252: read + edit campaign drafts over /api/v1. Every send entry point is mocked so we
// can prove none is ever called; the scheduler itself stays real (it must ignore drafts).
const spies = vi.hoisted(() => ({
	sendBatch: vi.fn(),
	suppress: vi.fn(),
	sendCampaignEmail: vi.fn(),
	fetch: vi.fn()
}));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: spies.suppress }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));

import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listGET, POST } from '../src/routes/api/v1/campaigns/+server';
import { GET as oneGET, PATCH, DELETE } from '../src/routes/api/v1/campaigns/[id]/+server';
import { GET as discovery } from '../src/routes/api/v1/+server';
import { updateDraft } from '../src/lib/server/campaign-drafts';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';

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
const patch = (id: number, token: string, body: unknown) =>
	PATCH(ev(`/api/v1/campaigns/${id}`, 'PATCH', token, body, { id: String(id) }));
const getOne = (id: number, token: string) => oneGET(ev(`/api/v1/campaigns/${id}`, 'GET', token, undefined, { id: String(id) }));

async function insertCampaign(subject: string, status: string, extra: { list_id?: number } = {}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, sent_at)
			 VALUES (?, 'body', '<p>body</p>', 'alan@ourco.example', ?, ?, CASE WHEN ? = 'sent' THEN datetime('now') END) RETURNING id`
		)
		.bind(subject, status, extra.list_id ?? null, status)
		.first<{ id: number }>();
	return row!.id;
}

async function newDraft(token: string, subject = 'Agent draft'): Promise<number> {
	return (await jsonOf(await POST(ev('/api/v1/campaigns', 'POST', token, { subject, body: '# Hi' })))).data.id;
}

let listId: number;
let segmentId: number;
let tagId: number;
let templateId: number;

beforeEach(async () => {
	vi.clearAllMocks();
	globalThis.fetch = spies.fetch as any;
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM templates'),
		db.prepare("DELETE FROM app_state WHERE key = 'approved_senders'")
	]);
	listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	segmentId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Hot', 'segment') RETURNING id").first<{ id: number }>())!.id;
	tagId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('vip', 'tag') RETURNING id").first<{ id: number }>())!.id;
	templateId = (await db.prepare("INSERT INTO templates (name, kind) VALUES ('Shell', 'builder') RETURNING id").first<{ id: number }>())!.id;
});

describe('GET /api/v1/campaigns', () => {
	it('lists newest first with filters and pagination', async () => {
		const t = await makeKey('read');
		const d1 = await insertCampaign('Spring news', 'draft', { list_id: listId });
		const s1 = await insertCampaign('Spring sale', 'sent', { list_id: listId });
		await insertCampaign('Autumn update', 'scheduled');
		const d2 = await insertCampaign('Winter 100% off_', 'draft');

		const all = await jsonOf(await listGET(ev('/api/v1/campaigns', 'GET', t)));
		expect(all.pagination).toEqual({ limit: 50, offset: 0, total: 4, has_more: false });
		expect(all.data[0].id).toBe(d2);

		const drafts = await jsonOf(await listGET(ev('/api/v1/campaigns?status=draft', 'GET', t)));
		expect(drafts.data.map((c: any) => c.id)).toEqual([d2, d1]);
		const d1row = drafts.data[1];
		expect(d1row).toMatchObject({
			subject: 'Spring news',
			status: 'draft',
			audience: { list_id: listId, name: 'Newsletter', kind: 'list' },
			template_id: null,
			recipient_count: 0
		});
		expect(d1row.compose_url).toMatch(new RegExp(`/compose\\?draft=${d1}$`));

		const spring = await jsonOf(await listGET(ev('/api/v1/campaigns?q=spring', 'GET', t)));
		expect(spring.data.map((c: any) => c.id)).toEqual([s1, d1]);
		expect(spring.data[0].compose_url).toBeNull();
		// LIKE wildcards in q are literal.
		expect((await jsonOf(await listGET(ev('/api/v1/campaigns?q=100%25', 'GET', t)))).data.map((c: any) => c.id)).toEqual([d2]);
		expect((await jsonOf(await listGET(ev('/api/v1/campaigns?q=_', 'GET', t)))).data.map((c: any) => c.id)).toEqual([d2]);

		const page = await jsonOf(await listGET(ev('/api/v1/campaigns?limit=2&offset=2', 'GET', t)));
		expect(page.pagination).toEqual({ limit: 2, offset: 2, total: 4, has_more: false });
		expect(page.data).toHaveLength(2);
		const page1 = await jsonOf(await listGET(ev('/api/v1/campaigns?limit=2', 'GET', t)));
		expect(page1.pagination.has_more).toBe(true);

		expect((await listGET(ev('/api/v1/campaigns?status=canceled', 'GET', t))).status).toBe(400);
	});

	it('401 without a key; a campaigns:draft key cannot read', async () => {
		expect((await listGET(ev('/api/v1/campaigns', 'GET', undefined))).status).toBe(401);
		const d = await makeKey('campaigns:draft');
		expect((await listGET(ev('/api/v1/campaigns', 'GET', d))).status).toBe(403);
	});
});

describe('GET /api/v1/campaigns/:id', () => {
	it('returns a draft with its full record and no stats', async () => {
		const rw = await makeKey('read_write');
		const id = await newDraft(rw);
		const res = await getOne(id, rw);
		expect(res.status).toBe(200);
		const d = (await jsonOf(res)).data;
		expect(d).toMatchObject({ id, subject: 'Agent draft', body: '# Hi', status: 'draft', preheader: null, audience: null, stats: null, resend_delay: null, scheduled_at: null });
		expect(d.compose_url).toMatch(/\/compose\?draft=\d+$/);
		expect((await getOne(999999, rw)).status).toBe(404);
		expect((await oneGET(ev('/api/v1/campaigns/x', 'GET', rw, undefined, { id: 'x' }))).status).toBe(400);
	});

	it('a sent campaign includes the campaign-page stats', async () => {
		const t = await makeKey('read');
		const id = await insertCampaign('Sent one', 'sent', { list_id: listId });
		const r = [];
		for (let i = 0; i < 4; i++) {
			r.push(
				(await db
					.prepare("INSERT INTO recipients (campaign_id, email, status) VALUES (?, ?, 'accepted') RETURNING id")
					.bind(id, `r${i}@x.test`)
					.first<{ id: number }>())!.id
			);
		}
		await db.batch([
			db.prepare("INSERT INTO events (campaign_id, recipient_id, type) VALUES (?, ?, 'open')").bind(id, r[0]),
			db.prepare("INSERT INTO events (campaign_id, recipient_id, type) VALUES (?, ?, 'open')").bind(id, r[0]),
			db.prepare("INSERT INTO events (campaign_id, recipient_id, type) VALUES (?, ?, 'click')").bind(id, r[1])
		]);
		const d = (await jsonOf(await getOne(id, t))).data;
		expect(d.compose_url).toBeNull();
		expect(d.stats).toMatchObject({ sent: 4, unique_opens: 2, unique_clicks: 1, open_rate: 0.5, click_rate: 0.25 });
	});
});

describe('PATCH /api/v1/campaigns/:id', () => {
	it('updates every editable field on a draft and re-renders the body', async () => {
		const t = await makeKey('campaigns:draft');
		const id = await newDraft(t);
		const steps: [Record<string, unknown>, Record<string, unknown>][] = [
			[{ subject: '  New subject ' }, { subject: 'New subject' }],
			[{ preheader: 'Peek' }, { preheader: 'Peek' }],
			[{ body: '## Changed **body**' }, { body_md: '## Changed **body**' }],
			[{ list_id: listId }, { list_id: listId }],
			[{ list_id: segmentId }, { list_id: segmentId }],
			[{ template_id: templateId }, { template_id: templateId }],
			[{ from_email: 'news@ourco.example' }, { from_email: 'news@ourco.example' }],
			[{ scheduled_at: '2030-01-02T09:30:00Z' }, { scheduled_at: '2030-01-02 09:30:00', status: 'draft' }],
			[{ resend_delay: '3d' }, { resend_delay: '3d' }],
			[{ resend_delay: null, list_id: null, template_id: null, scheduled_at: null }, { resend_delay: null, list_id: null, template_id: null, scheduled_at: null }]
		];
		for (const [body, expected] of steps) {
			const res = await patch(id, t, body);
			expect(res.status, JSON.stringify(body)).toBe(200);
			const row = await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<any>();
			expect(row).toMatchObject({ ...expected, status: 'draft', recipient_count: 0 });
		}
		const row = await db.prepare('SELECT body_html, body_text FROM campaigns WHERE id = ?').bind(id).first<any>();
		expect(row.body_html).toContain('<strong>body</strong>');
		expect(row.body_html).toContain('Peek');
		expect(row.body_text).toContain('Changed');

		const out = (await jsonOf(await patch(id, t, { list_id: listId }))).data;
		expect(out).toMatchObject({ id, subject: 'New subject', body: '## Changed **body**', audience: { list_id: listId, kind: 'list' } });

		const rc = await db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?').bind(id).first<{ n: number }>();
		expect(rc!.n).toBe(0);
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(spies.fetch).not.toHaveBeenCalled();
	});

	it('409 for any non-draft', async () => {
		const t = await makeKey('read_write');
		for (const status of ['scheduled', 'sending', 'sent', 'failed', 'canceled']) {
			const id = await insertCampaign(`c ${status}`, status);
			const res = await patch(id, t, { subject: 'hijack' });
			expect(res.status).toBe(409);
			expect((await jsonOf(res)).error).toBe('Only drafts can be edited via the API.');
			expect((await db.prepare('SELECT subject FROM campaigns WHERE id = ?').bind(id).first<any>()).subject).toBe(`c ${status}`);
		}
		expect((await patch(999999, t, { subject: 'x' })).status).toBe(404);
	});

	it('409 when the draft is scheduled between the read and the UPDATE (race)', async () => {
		const t = await makeKey('read_write');
		const id = await newDraft(t);
		// A db whose UPDATE first lets "the human" schedule the row, as a concurrent compose send would.
		const racing = {
			prepare(sql: string) {
				const stmt = db.prepare(sql);
				if (!sql.startsWith('UPDATE campaigns SET')) return stmt;
				return {
					bind: (...args: unknown[]) => ({
						first: async () => {
							await db.prepare("UPDATE campaigns SET status = 'scheduled' WHERE id = ?").bind(id).run();
							return stmt.bind(...args).first();
						}
					})
				};
			}
		} as unknown as D1Database;
		expect(await updateDraft(racing, id, { subject: 'late edit' })).toEqual({ ok: false, status: 409, error: 'Only drafts can be edited via the API.' });
		expect((await db.prepare('SELECT subject, status FROM campaigns WHERE id = ?').bind(id).first<any>())).toEqual({ subject: 'Agent draft', status: 'scheduled' });
	});

	it('400 for forbidden keys, unknown keys and bad values or references', async () => {
		const t = await makeKey('read_write');
		const id = await newDraft(t);
		for (const k of ['status', 'send', 'schedule', 'recipients', 'to']) {
			const res = await patch(id, t, { [k]: k === 'status' ? 'scheduled' : true });
			expect(res.status, k).toBe(400);
			expect((await jsonOf(res)).error).toContain(`"${k}"`);
		}
		await db.prepare("INSERT INTO app_state (key, value) VALUES ('approved_senders', 'ourco.example')").run();
		const bad: Record<string, unknown>[] = [
			{ bogus: 1 },
			{ subject: '' },
			{ body: 5 },
			{ list_id: 999999 },
			{ list_id: tagId }, // a tag is not an audience
			{ list_id: 'abc' },
			{ template_id: 999999 },
			{ from_email: 'not-an-email' },
			{ from_email: 'someone@gmail.com' }, // not an approved sender
			{ scheduled_at: 'next tuesday' },
			{ resend_delay: '1w' }
		];
		for (const body of bad) expect((await patch(id, t, body)).status, JSON.stringify(body)).toBe(400);
		expect((await patch(id, t, { from_email: 'team@ourco.example' })).status).toBe(200);
		expect((await db.prepare('SELECT subject FROM campaigns WHERE id = ?').bind(id).first<any>()).subject).toBe('Agent draft');
	});

	it('scopes: read key 403 on PATCH; campaigns:draft can PATCH but not DELETE', async () => {
		const rw = await makeKey('read_write');
		const id = await newDraft(rw);
		const read = await makeKey('read');
		expect((await patch(id, read, { subject: 'x' })).status).toBe(403);
		const d = await makeKey('campaigns:draft');
		expect((await patch(id, d, { subject: 'by draft key' })).status).toBe(200);
		expect((await DELETE(ev(`/api/v1/campaigns/${id}`, 'DELETE', d, undefined, { id: String(id) }))).status).toBe(403);
		expect((await patch(id, undefined as any, { subject: 'x' })).status).toBe(401);
	});
});

describe('scheduler never fires a draft', () => {
	it('a draft with a past scheduled_at stays a draft', async () => {
		const t = await makeKey('read_write');
		const id = await newDraft(t);
		expect((await patch(id, t, { list_id: listId, scheduled_at: '2020-01-01T00:00:00Z' })).status).toBe(200);
		const res = await processScheduledCampaigns(db, { token: 't', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' });
		expect(res).toEqual({ fired: 0, failed: 0 });
		expect(await db.prepare('SELECT status, scheduled_at FROM campaigns WHERE id = ?').bind(id).first()).toEqual({
			status: 'draft',
			scheduled_at: '2020-01-01 00:00:00'
		});
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});
});

describe('GET /api/v1 discovery', () => {
	it('includes campaigns with send: false', async () => {
		const rw = await makeKey('read_write');
		const r1 = (await jsonOf(await discovery(ev('/api/v1', 'GET', rw)))).resources.campaigns;
		expect(r1).toMatchObject({ read: true, write: true, send: false });
		const read = await makeKey('read');
		const r2 = (await jsonOf(await discovery(ev('/api/v1', 'GET', read)))).resources.campaigns;
		expect(r2).toMatchObject({ read: true, write: false, send: false });
	});
});

// Structural: the campaign API handlers' whole module graph imports nothing that can send
// or schedule. Sources are bundled at build time (no fs in workerd), like no-emoji.test.ts.
const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function resolve(from: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith('$lib/')) base = `../src/lib/${spec.slice(5)}`;
	else if (spec.startsWith('.')) {
		const parts = from.split('/').slice(0, -1);
		for (const seg of spec.split('/')) {
			if (seg === '..') parts.pop();
			else if (seg !== '.') parts.push(seg);
		}
		base = parts.join('/');
	} else return null; // a package
	for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (c in sources) return c;
	return null;
}

function moduleGraph(entries: string[]): Set<string> {
	const seen = new Set<string>();
	const stack = [...entries];
	while (stack.length) {
		const f = stack.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const text = sources[f];
		expect(text, f).toBeDefined();
		for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
		for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
	}
	return seen;
}

describe('structural: campaign API cannot send or schedule', () => {
	it('module graph of the handlers excludes send/postmark/scheduled/resend', () => {
		const graph = moduleGraph([
			'../src/routes/api/v1/campaigns/+server.ts',
			'../src/routes/api/v1/campaigns/[id]/+server.ts',
			'../src/routes/api/v1/campaigns/[id]/checks/+server.ts'
		]);
		expect(graph.has('../src/lib/server/campaign-drafts.ts')).toBe(true);
		expect(graph.has('../src/lib/server/campaigns-api.ts')).toBe(true);
		expect(graph.has('../src/lib/server/campaign-engagement.ts')).toBe(true);
		const banned = ['send.ts', 'postmark.ts', 'scheduled.ts', 'resend.ts'].map((f) => `../src/lib/server/${f}`);
		expect([...graph].filter((f) => banned.includes(f))).toEqual([]);
	});

	it('the walker does see a sending import (sanity)', () => {
		expect(moduleGraph(['../src/lib/server/scheduled.ts']).has('../src/lib/server/send.ts')).toBe(true);
	});
});

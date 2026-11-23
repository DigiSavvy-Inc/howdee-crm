import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #332: a campaign sends to several lists / segments (union, one email per contact) minus
// optional exclusions. Sends are mocked; the scheduler is real.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import migration0089 from '../migrations/0089_campaign_audiences.sql?raw';
import { actions as compose, load as composeLoad } from '../src/routes/compose/+page.server';
import { POST as countPOST } from '../src/routes/compose/audience/+server';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import { duplicateAsDraft, reopenAsDraft, updateDraft, parseDraftPatch } from '../src/lib/server/campaign-drafts';
import { getCampaign } from '../src/lib/server/campaigns-api';
import { loadAudience, audienceLabel as describeLabel } from '../src/lib/server/audience';
import {
	audienceCount,
	normalizeAudience,
	readAudience,
	recipientsForAudience,
	writeAudience,
	multiGroupLabels
} from '../src/lib/server/campaign-audience';
import { audienceLabel } from '../src/lib/campaign-audience';
import { TOOLS, runTool } from '../src/lib/server/ai/tools';
import type { ToolContext } from '../src/lib/server/ai/tools/types';
import { createThread } from '../src/lib/server/ai/threads';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), POSTMARK_TOKEN: 'test', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const cfg = { token: 't', secret: 'test-secret', baseUrl: 'https://app.test', stream: 'broadcast' };

function actionEvent(action: string, fields: [string, string][]) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test/compose?/${action}`);
	return { platform: { env: platformEnv }, params: {}, url, request: new Request(url, { method: 'POST', body: fd }) } as any;
}
async function run(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}
const para = (text: string) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text }] });
const body = JSON.stringify([para('A real update with plenty of words. '.repeat(8))]);
const base: [string, string][] = [
	['subject', 'Hello'],
	['from', 'alan@ourco.example'],
	['preheader', 'p'],
	['body_blocks', body],
	['send_anyway', '1']
];
const sentEmails = (call = 0) => (spies.sendCampaignEmail.mock.calls[call][1].recipients as { email: string }[]).map((r) => r.email).sort();

const id = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;

let customers: number, newsletter: number, vip: number, segWeb: number, segEvent: number;
let ann: number, bob: number, cat: number, dan: number, eve: number;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockImplementation(async (_db: unknown, o: { recipients: unknown[] }) => ({ accepted: o.recipients.length, failed: 0, firstError: null }));
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	const contact = (email: string, sub: number, source: string, archived = false) =>
		id(`INSERT INTO contacts (email, subscribed, source, archived_at) VALUES (?, ?, ?, ${archived ? "datetime('now')" : 'NULL'}) RETURNING id`, email, sub, source);
	ann = await contact('ann@x.example.net', 1, 'web');
	bob = await contact('bob@x.example.net', 1, 'event');
	cat = await contact('cat@x.example.net', 1, 'web');
	dan = await contact('dan@x.example.net', 0, 'web'); // unsubscribed (suppressed), in every group
	eve = await contact('eve@x.example.net', 1, 'event', true); // archived
	customers = await id("INSERT INTO lists (name, kind) VALUES ('Customers', 'list') RETURNING id");
	newsletter = await id("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id");
	vip = await id("INSERT INTO lists (name, kind) VALUES ('VIP', 'segment') RETURNING id");
	const rules = (source: string) => JSON.stringify({ match: 'all', rules: [{ field: 'source', op: 'is', value: source }] });
	segWeb = await id("INSERT INTO lists (name, kind, rules) VALUES ('Web', 'segment', ?) RETURNING id", rules('web'));
	segEvent = await id("INSERT INTO lists (name, kind, rules) VALUES ('Event', 'segment', ?) RETURNING id", rules('event'));
	const member = db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)');
	await db.batch([
		member.bind(customers, ann),
		member.bind(customers, bob),
		member.bind(customers, dan),
		member.bind(customers, eve),
		member.bind(newsletter, ann),
		member.bind(newsletter, cat),
		member.bind(newsletter, dan),
		member.bind(vip, cat),
		member.bind(vip, dan)
	]);
});

describe('resolution', () => {
	it('union de-duplicates by contact: each person once', async () => {
		const r = await recipientsForAudience(db, { include: [customers, newsletter], exclude: [] });
		expect(r.map((x) => x.email).sort()).toEqual(['ann@x.example.net', 'bob@x.example.net', 'cat@x.example.net']);
		expect(await audienceCount(db, { include: [customers, newsletter], exclude: [] })).toBe(3);
	});

	it('exclusions are subtracted after the union', async () => {
		const a = { include: [customers, newsletter], exclude: [vip] };
		expect((await recipientsForAudience(db, a)).map((x) => x.email).sort()).toEqual(['ann@x.example.net', 'bob@x.example.net']);
		expect(await audienceCount(db, a)).toBe(2);
	});

	it('an unsubscribed or archived contact in several groups is never a recipient', async () => {
		const r = await recipientsForAudience(db, { include: [customers, newsletter, vip, segWeb, segEvent], exclude: [] });
		const got = r.map((x) => x.id);
		expect(got).not.toContain(dan);
		expect(got).not.toContain(eve);
		expect(new Set(got).size).toBe(got.length);
		expect(await audienceCount(db, { include: [customers, newsletter, vip, segWeb, segEvent], exclude: [] })).toBe(got.length);
	});

	it('normalizes: de-dupes, drops junk, exclude wins over include', () => {
		expect(normalizeAudience({ include: [3, '3', 4, -1, 'x', 5], exclude: [5, 5] })).toEqual({ include: [3, 4], exclude: [5] });
	});

	it('labels "Customers + Newsletter, excluding VIP"', () => {
		const g = (id: number, name: string) => ({ id, name, kind: 'list' });
		expect(audienceLabel({ include: [g(1, 'Customers'), g(2, 'Newsletter')], exclude: [g(3, 'VIP')] })).toBe('Customers + Newsletter, excluding VIP');
		expect(audienceLabel({ include: [g(1, 'Customers')], exclude: [] })).toBe('Customers');
		expect(audienceLabel({ include: [], exclude: [g(3, 'VIP')] })).toBe('');
	});
});

describe('legacy campaigns (list_id only)', () => {
	it('fall back to list_id, and the 0089 backfill gives them one include row', async () => {
		const legacy = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id) VALUES ('Old', 'x', 'x', 'a@b.example.net', 'scheduled', ?) RETURNING id",
			newsletter
		);
		expect(await readAudience(db, legacy)).toEqual({ include: [newsletter], exclude: [] });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM campaign_audiences WHERE campaign_id = ?').bind(legacy).first<{ n: number }>())!.n).toBe(0);

		const backfill = migration0089.slice(migration0089.indexOf('INSERT OR IGNORE INTO campaign_audiences'));
		await db.prepare(backfill).run();
		const rows = await db.prepare('SELECT list_id, mode, position FROM campaign_audiences WHERE campaign_id = ?').bind(legacy).all();
		expect(rows.results).toEqual([{ list_id: newsletter, mode: 'include', position: 0 }]);
		expect(await readAudience(db, legacy)).toEqual({ include: [newsletter], exclude: [] });
	});

	it('a scheduled legacy campaign sends exactly as before', async () => {
		await db
			.prepare(
				"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, scheduled_at) VALUES ('Old', 'x', 'x', 'a@b.example.net', 'scheduled', ?, datetime('now', '-1 minute'))"
			)
			.bind(newsletter)
			.run();
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		expect(sentEmails()).toEqual(['ann@x.example.net', 'cat@x.example.net']);
	});
});

describe('compose', () => {
	it('send now: union minus exclusions, one email each; audience stored, list_id = first include', async () => {
		const r = await run(
			compose.send!,
			actionEvent('send', [...base, ['include_id', String(customers)], ['include_id', String(newsletter)], ['exclude_id', String(vip)]])
		);
		const cid = Number(r.redirect!.match(/\/campaign\/(\d+)/)![1]);
		expect(spies.sendCampaignEmail).toHaveBeenCalledTimes(1);
		expect(sentEmails()).toEqual(['ann@x.example.net', 'bob@x.example.net']);
		expect(await readAudience(db, cid)).toEqual({ include: [customers, newsletter], exclude: [vip] });
		expect((await db.prepare('SELECT list_id, status FROM campaigns WHERE id = ?').bind(cid).first())).toEqual({ list_id: customers, status: 'sent' });
	});

	it('an audience that leaves nobody is refused', async () => {
		const r = await run(compose.send!, actionEvent('send', [...base, ['include_id', String(vip)], ['exclude_id', String(newsletter)]]));
		expect(r.result?.status).toBe(400);
		expect(r.result?.data.error).toBe('That audience has no subscribed contacts.');
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('scheduled send with two dynamic segments resolves membership when it fires', async () => {
		const when = new Date(Date.now() + 3600_000).toISOString();
		const r = await run(
			compose.send!,
			actionEvent('send', [...base, ['schedule_at', when], ['include_id', String(segWeb)], ['include_id', String(segEvent)]])
		);
		const cid = Number(r.redirect!.match(/\/campaign\/(\d+)/)![1]);
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect(await readAudience(db, cid)).toEqual({ include: [segWeb, segEvent], exclude: [] });

		// Joins a segment after scheduling: in. Unsubscribes after scheduling: out.
		await db.prepare("INSERT INTO contacts (email, subscribed, source) VALUES ('new@x.example.net', 1, 'event')").run();
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(cat).run();
		await db.prepare("UPDATE campaigns SET scheduled_at = datetime('now', '-1 minute') WHERE id = ?").bind(cid).run();

		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		expect(sentEmails()).toEqual(['ann@x.example.net', 'bob@x.example.net', 'new@x.example.net']);
		expect((await db.prepare('SELECT status, recipient_count FROM campaigns WHERE id = ?').bind(cid).first())).toEqual({ status: 'sent', recipient_count: 3 });
	});

	it('save draft keeps every group; compose reloads them; the count endpoint matches', async () => {
		const r = await run(
			compose.saveDraft!,
			actionEvent('saveDraft', [['subject', 'Half'], ['include_id', String(customers)], ['include_id', String(newsletter)], ['exclude_id', String(vip)]])
		);
		const did = Number(r.redirect!.match(/draft=(\d+)/)![1]);
		const data: any = await composeLoad({ platform: { env: platformEnv }, url: new URL(`https://app.test/compose?draft=${did}`) } as any);
		expect(data.draft).toMatchObject({ list_id: customers, include_ids: [customers, newsletter], exclude_ids: [vip] });

		const fd = new FormData();
		fd.append('include_id', String(customers));
		fd.append('include_id', String(newsletter));
		fd.append('exclude_id', String(vip));
		const url = new URL('https://app.test/compose/audience');
		const res = await countPOST({ platform: { env: platformEnv }, url, request: new Request(url, { method: 'POST', body: fd }) } as any);
		expect(await res.json()).toEqual({ count: 2 });
	});

	it('a bare list_id (old form / tests) still works', async () => {
		const r = await run(compose.send!, actionEvent('send', [...base, ['list_id', String(newsletter)]]));
		expect(r.redirect).toMatch(/^\/campaign\/\d+$/);
		expect(sentEmails()).toEqual(['ann@x.example.net', 'cat@x.example.net']);
	});
});

describe('everywhere the audience shows', () => {
	async function multi(status = 'draft') {
		const cid = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id) VALUES ('Multi', 'x', 'x', 'a@b.example.net', ?, ?) RETURNING id",
			status,
			customers
		);
		await writeAudience(db, cid, { include: [customers, newsletter], exclude: [vip] });
		return cid;
	}

	it('campaign page, send log and API label it', async () => {
		const cid = await multi('sent');
		const a = await loadAudience(db, cid);
		expect(describeLabel(a)).toBe('Customers + Newsletter, excluding VIP');
		expect((await multiGroupLabels(db, [{ id: cid, list_id: customers }])).get(cid)).toBe('Customers + Newsletter, excluding VIP');
		const api = await getCampaign(db, cid, 'https://app.test');
		expect(api!.audience).toMatchObject({ list_id: customers, name: 'Customers' });
		expect(api!.audiences).toEqual({
			include: [
				{ list_id: customers, name: 'Customers', kind: 'list' },
				{ list_id: newsletter, name: 'Newsletter', kind: 'list' }
			],
			exclude: [{ list_id: vip, name: 'VIP', kind: 'segment' }],
			label: 'Customers + Newsletter, excluding VIP'
		});
	});

	it('duplicate copies the groups; reopening a canceled campaign keeps them', async () => {
		const cid = await multi('canceled');
		const copy = (await duplicateAsDraft(db, cid))!;
		expect(await readAudience(db, copy)).toEqual({ include: [customers, newsletter], exclude: [vip] });
		expect(await reopenAsDraft(db, cid)).toEqual({ ok: true });
		expect(await readAudience(db, cid)).toEqual({ include: [customers, newsletter], exclude: [vip] });
	});

	it('Data API PATCH: audience replaces both; list_id replaces the includes and keeps exclusions', async () => {
		const cid = await multi();
		const p = parseDraftPatch({ audience: { include: [segWeb, segEvent], exclude: [customers] } });
		expect('error' in p).toBe(false);
		expect(await updateDraft(db, cid, p as any)).toEqual({ ok: true });
		expect(await readAudience(db, cid)).toEqual({ include: [segWeb, segEvent], exclude: [customers] });
		expect((await db.prepare('SELECT list_id FROM campaigns WHERE id = ?').bind(cid).first())).toEqual({ list_id: segWeb });

		expect(await updateDraft(db, cid, { list_id: newsletter })).toEqual({ ok: true });
		expect(await readAudience(db, cid)).toEqual({ include: [newsletter], exclude: [customers] });
		expect(parseDraftPatch({ audience: { include: ['x'] } })).toHaveProperty('error');
		expect((await updateDraft(db, cid, { audience: { include: [999999], exclude: [] } })).ok).toBe(false);
	});
});

describe('assistant drafting tools', () => {
	let seq = 0;
	async function ctx(): Promise<ToolContext> {
		const login = `ai332-${Date.now()}-${++seq}`;
		const uid = await id("INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id", login);
		const user = { id: uid, github_login: login, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
		const threadId = await createThread(db, uid, 'claude-sonnet-5-5', 'medium', 'test');
		return { db, user, baseUrl: 'https://app.test', now: new Date(), threadId };
	}
	const call = (c: ToolContext, name: string, input: Record<string, unknown>) => runTool(c, name, input, TOOLS, `tu332_${++seq}`);

	it('create + update read and write the multi-group shape (drafts only)', async () => {
		const c = await ctx();
		const created = await call(c, 'create_campaign_draft', {
			subject: 'Launch',
			body_markdown: 'Hello there',
			include_list_ids: [customers, newsletter],
			exclude_list_ids: [vip]
		});
		expect(created.ok).toBe(true);
		const cid = JSON.parse(created.content).campaign_id as number;
		expect(await readAudience(db, cid)).toEqual({ include: [customers, newsletter], exclude: [vip] });
		expect((await db.prepare('SELECT status, list_id, recipient_count FROM campaigns WHERE id = ?').bind(cid).first())).toEqual({ status: 'draft', list_id: customers, recipient_count: 0 });

		const sections = await call(c, 'get_draft_sections', { campaign_id: cid });
		expect(JSON.parse(sections.content).audience.label).toBe('Customers + Newsletter, excluding VIP');
		const got = await call(c, 'get_campaign', { campaign_id: cid });
		expect(JSON.parse(got.content).audiences.label).toBe('Customers + Newsletter, excluding VIP');

		const upd = await call(c, 'update_campaign_draft', { campaign_id: cid, exclude_list_ids: [] });
		expect(upd.ok).toBe(true);
		expect(upd.action!.changes).toEqual([{ field: 'audience', from: 'Customers + Newsletter, excluding VIP', to: 'Customers + Newsletter' }]);
		expect(await readAudience(db, cid)).toEqual({ include: [customers, newsletter], exclude: [] });

		const bad = await call(c, 'update_campaign_draft', { campaign_id: cid, include_list_ids: [999999] });
		expect(bad.ok).toBe(false);
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #313: a canceled campaign reopens as a draft (Edit & reschedule) or is duplicated.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { actions as compose } from '../src/routes/compose/+page.server';
import { actions as campaignPage } from '../src/routes/campaign/[id]/+page.server';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import { PARTLY_SENT } from '../src/lib/server/campaign-drafts';

const db = (env as any).DB as D1Database;
const platformEnv = {
	...(env as any),
	POSTMARK_TOKEN: 'test',
	POSTMARK_STREAM: 'broadcast',
	SESSION_SECRET: 'secret',
	PUBLIC_BASE_URL: 'https://app.test'
};

function actionEvent(path: string, action: string, fields: Record<string, string>, params: Record<string, string> = {}) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = new URL(`https://app.test${path}?/${action}`);
	return { platform: { env: platformEnv }, params, url, request: new Request(url, { method: 'POST', body: fd }) } as any;
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
const page = (action: 'editScheduled' | 'duplicate' | 'cancelSchedule', id: number) =>
	run(campaignPage[action]!, actionEvent(`/campaign/${id}`, action, {}, { id: String(id) }));

let listId: number;
let contactId: number;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockResolvedValue({ accepted: 1, failed: 0, firstError: null });
	await db.batch([
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	contactId = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('ann@example.com', 1) RETURNING id").first<{ id: number }>())!.id;
	listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, contactId).run();
});

const future = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

async function scheduleOne(): Promise<{ id: number; when: string }> {
	const when = future();
	const r = await run(
		compose.send!,
		actionEvent('/compose', 'send', {
			subject: 'Launch',
			from: 'alan@ourco.example',
			body_md: 'Hello **there**',
			preheader: 'Peek',
			list_id: String(listId),
			schedule_at: when,
			resend_delay: '24h',
			tag_on_open: 'opened-launch'
		})
	);
	return { id: Number(r.redirect!.match(/campaign\/(\d+)/)![1]), when };
}

async function cancelOne() {
	const s = await scheduleOne();
	expect((await page('cancelSchedule', s.id)).result).toEqual({ ok: true });
	expect((await row(s.id)).status).toBe('canceled');
	return s;
}

describe('reopen a canceled campaign', () => {
	it('never sent → draft, content and time kept, resend cleared', async () => {
		const { id, when } = await cancelOne();
		const before = await row(id);
		const r = await page('editScheduled', id);
		expect(r.redirect).toBe(`/compose?draft=${id}`);
		expect(await row(id)).toMatchObject({
			status: 'draft',
			subject: 'Launch',
			preheader: 'Peek',
			body_md: before.body_md,
			body_html: before.body_html,
			list_id: listId,
			from_email: 'alan@ourco.example',
			tag_on_open: 'opened-launch',
			resend_delay: '24h',
			scheduled_at: `${when.slice(0, 10)} ${when.slice(11, 19)}`,
			resend_status: null,
			recipient_count: 0
		});
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('partly sent → refused, Duplicate offered', async () => {
		const { id } = await cancelOne();
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@example.com', 'm-1', 'accepted')")
			.bind(id, contactId)
			.run();
		const r = await page('editScheduled', id);
		expect(r.result?.status).toBe(400);
		expect(r.result?.data).toMatchObject({ error: PARTLY_SENT, partlySent: true });
		expect((await row(id)).status).toBe('canceled');
	});

	it('a sent_at stamp also refuses', async () => {
		const { id } = await cancelOne();
		await db.prepare("UPDATE campaigns SET sent_at = datetime('now') WHERE id = ?").bind(id).run();
		expect((await page('editScheduled', id)).result?.data).toMatchObject({ partlySent: true });
	});

	it('a sent campaign cannot be reopened', async () => {
		const { id } = await scheduleOne();
		await db.prepare("UPDATE campaigns SET status = 'sent' WHERE id = ?").bind(id).run();
		const r = await page('editScheduled', id);
		expect(r.result?.status).toBe(400);
		expect(r.result?.data?.partlySent).toBe(false);
		expect((await row(id)).status).toBe('sent');
	});

	it('a reopened draft with a past scheduled_at does not send on the tick', async () => {
		const { id } = await cancelOne();
		await page('editScheduled', id);
		await db.prepare("UPDATE campaigns SET scheduled_at = '2020-01-01 00:00:00' WHERE id = ?").bind(id).run();
		const res = await processScheduledCampaigns(db, { token: 't', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' });
		expect(res).toEqual({ fired: 0, failed: 0 });
		expect((await row(id)).status).toBe('draft');
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();

		// Rescheduling with that past time is refused; a new time promotes the same row.
		const past = await run(
			compose.send!,
			actionEvent('/compose', 'send', { draft_id: String(id), subject: 'Launch', from: 'alan@ourco.example', body_md: 'Hi', list_id: String(listId), schedule_at: '2020-01-01T00:00:00.000Z' })
		);
		expect(past.result?.status).toBe(400);
		const ok = await run(
			compose.send!,
			actionEvent('/compose', 'send', { draft_id: String(id), subject: 'Launch', from: 'alan@ourco.example', body_md: 'Hi', list_id: String(listId), schedule_at: future() })
		);
		expect(ok.redirect).toBe(`/campaign/${id}`);
		expect((await row(id)).status).toBe('scheduled');
	});
});

describe('scheduled campaigns still reopen (#240 regression)', () => {
	it('scheduled → draft', async () => {
		const { id } = await scheduleOne();
		expect((await page('editScheduled', id)).redirect).toBe(`/compose?draft=${id}`);
		expect(await row(id)).toMatchObject({ status: 'draft', resend_status: null, list_id: listId });
	});
});

describe('duplicate', () => {
	it('creates a new draft with the same content and no schedule', async () => {
		const { id } = await cancelOne();
		const src = await row(id);
		const r = await page('duplicate', id);
		const newId = Number(r.redirect!.match(/draft=(\d+)/)![1]);
		expect(newId).not.toBe(id);
		expect(await row(newId)).toMatchObject({
			status: 'draft',
			subject: src.subject,
			preheader: src.preheader,
			body_md: src.body_md,
			body_html: src.body_html,
			body_blocks: src.body_blocks,
			list_id: listId,
			from_email: src.from_email,
			tag_on_open: 'opened-launch',
			resend_delay: '24h',
			scheduled_at: null,
			sent_at: null,
			resend_status: null,
			recipient_count: 0
		});
		expect((await row(id)).status).toBe('canceled');
	});

	it('works for a partly sent campaign', async () => {
		const { id } = await cancelOne();
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@example.com', 'm-1', 'accepted')")
			.bind(id, contactId)
			.run();
		const r = await page('duplicate', id);
		expect(r.redirect).toMatch(/^\/compose\?draft=\d+$/);
	});
});

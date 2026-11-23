import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #240: drafts → edit / save / schedule / send, and scheduled → back to draft.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { actions as compose, load as composeLoad } from '../src/routes/compose/+page.server';
import { actions as campaignPage } from '../src/routes/campaign/[id]/+page.server';
import { createDraft } from '../src/lib/server/campaign-drafts';

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

async function row(id: number) {
	return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<any>();
}
const campaignCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>())!.n;

let listId: number;

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
	const c = await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('ann@example.com', 1) RETURNING id").first<{ id: number }>();
	listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c!.id).run();
});

const future = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

describe('saveDraft', () => {
	it('needs only a subject, inserts a draft, never sends', async () => {
		const missing = await run(compose.saveDraft!, actionEvent('/compose', 'saveDraft', { subject: '' }));
		expect(missing.result?.status).toBe(400);

		const r = await run(compose.saveDraft!, actionEvent('/compose', 'saveDraft', { subject: 'Half built' }));
		const id = Number(r.redirect!.match(/draft=(\d+)/)![1]);
		expect(r.redirect).toBe(`/compose?draft=${id}&saved=1`);
		expect(await row(id)).toMatchObject({ status: 'draft', subject: 'Half built', list_id: null, scheduled_at: null, recipient_count: 0 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('updates the same draft and keeps everything for compose to reload', async () => {
		const first = await run(compose.saveDraft!, actionEvent('/compose', 'saveDraft', { subject: 'v1' }));
		const id = Number(first.redirect!.match(/draft=(\d+)/)![1]);
		const when = future();
		const second = await run(
			compose.saveDraft!,
			actionEvent('/compose', 'saveDraft', {
				draft_id: String(id),
				subject: 'v2',
				from: 'alan@ourco.example',
				body_md: 'Hello **there**',
				preheader: 'Peek',
				list_id: String(listId),
				schedule_at: when,
				tag_on_open: 'opened-x',
				tag_on_click: 'clicked-x',
				weekday_only: '1',
				best_time: '1',
				resend_delay: '3d',
				resend_subject: 'Again'
			})
		);
		expect(second.redirect).toBe(`/compose?draft=${id}&saved=1`);
		expect(await campaignCount()).toBe(1);
		const r = await row(id);
		expect(r).toMatchObject({ status: 'draft', subject: 'v2', list_id: listId, recipient_count: 0, resend_status: null });

		const data: any = await composeLoad({ platform: { env: platformEnv }, url: new URL(`https://app.test/compose?draft=${id}`) } as any);
		expect(data.draft).toMatchObject({
			id,
			subject: 'v2',
			from: 'alan@ourco.example',
			body_md: 'Hello **there**',
			preheader: 'Peek',
			list_id: listId,
			schedule_at: `${when.slice(0, 19)}Z`,
			tag_on_open: 'opened-x',
			tag_on_click: 'clicked-x',
			weekday_only: true,
			best_time: true,
			resend_delay: '3d',
			resend_subject: 'Again'
		});
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('refuses to overwrite a row that is no longer a draft', async () => {
		const id = await createDraft(db, { subject: 'Gone', body: 'x' }, 'a@b.example.net');
		await db.prepare("UPDATE campaigns SET status = 'scheduled' WHERE id = ?").bind(id).run();
		const r = await run(compose.saveDraft!, actionEvent('/compose', 'saveDraft', { draft_id: String(id), subject: 'Overwrite' }));
		expect(r.result?.status).toBe(400);
		expect((await row(id)).subject).toBe('Gone');
	});
});

describe('send from a draft promotes that row', () => {
	it('scheduling an API draft keeps the same id and adds no row', async () => {
		const id = await createDraft(db, { subject: 'API draft', body: 'Body' }, 'alan@ourco.example');
		const fields = { draft_id: String(id), subject: 'API draft', from: 'alan@ourco.example', body_md: 'Body', list_id: String(listId), schedule_at: future() };
		const r = await run(compose.send!, actionEvent('/compose', 'send', fields));
		expect(r.redirect).toBe(`/campaign/${id}`);
		expect(await campaignCount()).toBe(1);
		expect(await row(id)).toMatchObject({ status: 'scheduled', list_id: listId, recipient_count: 1 });

		// A second submit of the same form finds no draft to promote.
		const again = await run(compose.send!, actionEvent('/compose', 'send', fields));
		expect(again.result?.status).toBe(400);
		expect(again.result?.data.error).toBe('This draft was already sent or scheduled.');
		expect(await campaignCount()).toBe(1);
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('sending now claims the draft once; a double submit sends only once', async () => {
		const id = await createDraft(db, { subject: 'Now', body: 'Body' }, 'alan@ourco.example');
		const fields = { draft_id: String(id), subject: 'Now', from: 'alan@ourco.example', body_md: 'Body', list_id: String(listId) };
		const [a, b] = await Promise.all([
			run(compose.send!, actionEvent('/compose', 'send', fields)),
			run(compose.send!, actionEvent('/compose', 'send', fields))
		]);
		const redirects = [a, b].filter((x) => x.redirect);
		const failures = [a, b].filter((x) => x.result?.status === 400);
		expect(redirects.map((x) => x.redirect)).toEqual([`/campaign/${id}`]);
		expect(failures).toHaveLength(1);
		expect(spies.sendCampaignEmail).toHaveBeenCalledTimes(1);
		expect(spies.sendCampaignEmail.mock.calls[0][1].campaignId).toBe(id);
		expect(await campaignCount()).toBe(1);
		expect(await row(id)).toMatchObject({ status: 'sent', recipient_count: 1 });
	});

	it('existing validation still applies (list required, future schedule)', async () => {
		const id = await createDraft(db, { subject: 'V', body: 'Body' }, 'alan@ourco.example');
		const base = { draft_id: String(id), subject: 'V', from: 'alan@ourco.example', body_md: 'Body' };
		expect((await run(compose.send!, actionEvent('/compose', 'send', base))).result?.status).toBe(400);
		const past = new Date(Date.now() - 60_000).toISOString();
		expect((await run(compose.send!, actionEvent('/compose', 'send', { ...base, list_id: String(listId), schedule_at: past }))).result?.status).toBe(400);
		expect((await row(id)).status).toBe('draft');
	});
});

describe('edit a scheduled campaign', () => {
	it('flips it back to a draft with list and time kept, then re-schedules the same row', async () => {
		const when = future();
		const sched = await run(
			compose.send!,
			actionEvent('/compose', 'send', { subject: 'Sched', from: 'alan@ourco.example', body_md: 'Body', list_id: String(listId), schedule_at: when, resend_delay: '24h' })
		);
		const id = Number(sched.redirect!.match(/campaign\/(\d+)/)![1]);
		expect((await row(id)).resend_status).toBe('pending');

		const edit = await run(campaignPage.editScheduled!, actionEvent(`/campaign/${id}`, 'editScheduled', {}, { id: String(id) }));
		expect(edit.redirect).toBe(`/compose?draft=${id}`);
		const r = await row(id);
		expect(r).toMatchObject({ status: 'draft', list_id: listId, scheduled_at: `${when.slice(0, 10)} ${when.slice(11, 19)}`, resend_status: null });

		// Not scheduled any more → a second Edit is refused.
		const again = await run(campaignPage.editScheduled!, actionEvent(`/campaign/${id}`, 'editScheduled', {}, { id: String(id) }));
		expect(again.result?.status).toBe(400);

		const data: any = await composeLoad({ platform: { env: platformEnv }, url: new URL(`https://app.test/compose?draft=${id}`) } as any);
		expect(data.draft).toMatchObject({ id, list_id: listId, schedule_at: `${when.slice(0, 19)}Z`, resend_delay: '24h' });

		const resched = await run(
			compose.send!,
			actionEvent('/compose', 'send', { draft_id: String(id), subject: 'Sched 2', from: 'alan@ourco.example', body_md: 'Body', list_id: String(listId), schedule_at: future() })
		);
		expect(resched.redirect).toBe(`/campaign/${id}`);
		expect(await row(id)).toMatchObject({ status: 'scheduled', subject: 'Sched 2' });
		expect(await campaignCount()).toBe(1);
	});
});

describe('delete draft', () => {
	it('deletes a draft and redirects to /campaigns; refuses a non-draft', async () => {
		const id = await createDraft(db, { subject: 'Bye', body: 'x' }, 'a@b.example.net');
		const r = await run(campaignPage.deleteDraft!, actionEvent(`/campaign/${id}`, 'deleteDraft', {}, { id: String(id) }));
		expect(r.redirect).toBe('/campaigns');
		expect(await row(id)).toBeNull();

		const sent = await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('S', 'x', 'x', 'a@b.example.net', 'sent') RETURNING id")
			.first<{ id: number }>();
		const refused = await run(campaignPage.deleteDraft!, actionEvent(`/campaign/${sent!.id}`, 'deleteDraft', {}, { id: String(sent!.id) }));
		expect(refused.result?.status).toBe(400);
		expect(await row(sent!.id)).not.toBeNull();
	});
});

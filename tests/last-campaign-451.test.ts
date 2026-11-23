import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { lastCampaign } from '../src/lib/server/dashboard';
import {
	rate,
	rateText,
	delta,
	deltaText,
	deltaWarn,
	unsubWarn,
	resendBadge,
	passText,
	plural
} from '../src/lib/last-campaign';

const db = (env as any).DB as D1Database;
const TZ = 'America/Los_Angeles';

async function makeList(name: string, kind = 'list'): Promise<number> {
	return (await db.prepare('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id').bind(name, kind).first<{ id: number }>())!.id;
}

async function makeCampaign(
	subject: string,
	sentOffset: string,
	opts: { listId?: number | null; stepId?: number | null; status?: string; resentAt?: boolean; resendSubject?: string | null; resendStatus?: string | null; resendAt?: string | null } = {}
): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status, sent_at, recipient_count, list_id,
			                        automation_step_id, resent_at, resend_subject, resend_status, resend_at)
			 VALUES (?, 'md', '<p>x</p>', 'x', 'alan@ourco.example', ?, datetime('now', ?), 0, ?, ?,
			         CASE WHEN ? THEN datetime('now') END, ?, ?, ?)
			 RETURNING id`
		)
		.bind(
			subject,
			opts.status ?? 'sent',
			sentOffset,
			opts.listId ?? null,
			opts.stepId ?? null,
			opts.resentAt ? 1 : 0,
			opts.resendSubject ?? null,
			opts.resendStatus ?? null,
			opts.resendAt ?? null
		)
		.first<{ id: number }>();
	return c!.id;
}

let n = 0;
async function recipient(campaignId: number, pass: string | null = null, status = 'accepted'): Promise<{ rid: number; cid: number }> {
	n++;
	const email = `p${n}@example.com`;
	const cid = (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
	const rid = (await db
		.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status, message_id, send_pass) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(campaignId, cid, email, status, `m-${n}`, pass)
		.first<{ id: number }>())!.id;
	return { rid, cid };
}

async function event(campaignId: number, r: { rid: number; cid: number }, type: string): Promise<void> {
	await db.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, ?)').bind(campaignId, r.rid, r.cid, type).run();
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('lastCampaign (#451)', () => {
	it('is null when nothing was sent', async () => {
		await makeCampaign('Draft', '-1 hour', { status: 'draft' });
		expect(await lastCampaign(db, TZ)).toBeNull();
	});

	it('ignores automation-step campaigns', async () => {
		const a = (await db.prepare(`INSERT INTO automations (name, status) VALUES ('Flow', 'active') RETURNING id`).first<{ id: number }>())!.id;
		const s = (await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
				 VALUES (?, 0, 0, 'Step', 'b', 'alan@ourco.example', 'email') RETURNING id`
			)
			.bind(a)
			.first<{ id: number }>())!.id;
		await makeCampaign('Step email', '-1 minute', { stepId: s });
		expect(await lastCampaign(db, TZ)).toBeNull();
		const list = await makeList('Newsletter');
		const b = await makeCampaign('Broadcast', '-1 day', { listId: list });
		const last = await lastCampaign(db, TZ);
		expect(last?.id).toBe(b);
		expect(last?.audience).toBe('Newsletter');
		expect(last?.prev).toBeNull();
		expect(last?.open_delta).toBeNull();
	});

	it('campaign-wide rates plus the original / resend split', async () => {
		const list = await makeList('Customers');
		const id = await makeCampaign('Launch', '-2 hours', { listId: list, resentAt: true, resendSubject: 'Did you see this?' });
		// Original pass: 4 accepted, 1 errored; 2 opened, 1 clicked, 1 unsub.
		const o = [await recipient(id), await recipient(id), await recipient(id), await recipient(id)];
		await recipient(id, null, 'error');
		await event(id, o[0], 'open');
		await event(id, o[0], 'open');
		await event(id, o[0], 'click');
		await event(id, o[1], 'open');
		await event(id, o[2], 'unsubscribe');
		await event(id, o[3], 'bounce');
		// Resend pass: 2 accepted, 1 opened, 1 spam.
		const r = [await recipient(id, 'resend'), await recipient(id, 'resend')];
		await event(id, r[0], 'open');
		await event(id, r[1], 'spam');
		await db.prepare(`INSERT INTO replies (contact_id, campaign_id, from_email, text) VALUES (?, ?, 'p1@example.com', 'hi')`).bind(o[0].cid, id).run();

		const last = (await lastCampaign(db, TZ))!;
		expect(last.id).toBe(id);
		expect(last.sent).toBe(6);
		expect(last.errored).toBe(1);
		expect(last.opens).toBe(3);
		expect(last.clicks).toBe(1);
		expect(last.open_rate).toBe(50);
		expect(last.click_rate).toBe(16.7);
		expect(last.unsubs).toBe(1);
		expect(last.unsub_rate).toBe(16.7);
		expect(last.bounces).toBe(1);
		expect(last.spam).toBe(1);
		expect(last.replies).toBe(1);
		expect(last.passes).toEqual({ original: { sent: 4, opens: 2, clicks: 1 }, resend: { sent: 2, opens: 1, clicks: 0 } });
		expect(last.resend_subject).toBe('Did you see this?');
		expect(resendBadge(last, last.resend_scheduled)).toBe('Resent to non-openers');
	});

	it('no split without a resend; direct send label; pending resend time', async () => {
		const id = await makeCampaign('1:1', '-1 hour', { resendStatus: 'pending', resendAt: '2026-11-02 17:00:00' });
		await recipient(id);
		const last = (await lastCampaign(db, TZ))!;
		expect(last.passes).toBeNull();
		expect(last.audience).toBe('direct');
		expect(last.resend_scheduled).toMatch(/Nov 2/);
		expect(resendBadge(last, last.resend_scheduled)).toMatch(/^Resend scheduled Mon, Nov 2/);
	});

	it('deltas against the previous campaign', async () => {
		const prev = await makeCampaign('Older', '-3 days');
		const p = [await recipient(prev), await recipient(prev), await recipient(prev), await recipient(prev)];
		await event(prev, p[0], 'open');
		await event(prev, p[1], 'open');
		await event(prev, p[0], 'click');
		const cur = await makeCampaign('Newer', '-1 day');
		const c = [await recipient(cur), await recipient(cur), await recipient(cur), await recipient(cur)];
		await event(cur, c[0], 'open');
		const last = (await lastCampaign(db, TZ))!;
		expect(last.id).toBe(cur);
		expect(last.prev?.id).toBe(prev);
		expect(last.open_delta).toBe(-25);
		expect(last.click_delta).toBe(-25);
		expect(deltaWarn(last.open_delta)).toBe(true);
	});
});

describe('last-campaign helpers (#451)', () => {
	it('rate / rateText', () => {
		expect(rate(1, 3)).toBe(33.3);
		expect(rate(0, 0)).toBeNull();
		expect(rateText(null)).toBe('—');
		expect(rateText(12.5)).toBe('12.5%');
	});

	it('delta / deltaText / deltaWarn', () => {
		expect(delta(30, 25.5)).toBe(4.5);
		expect(delta(null, 10)).toBeNull();
		expect(deltaText(4.5)).toBe('+4.5 pts vs previous');
		expect(deltaText(-3)).toBe('−3.0 pts vs previous');
		expect(deltaText(0)).toBe('no change vs previous');
		expect(deltaText(null)).toBeNull();
		expect(deltaWarn(-5)).toBe(false);
		expect(deltaWarn(-5.1)).toBe(true);
	});

	it('unsubWarn, badge, passText, plural', () => {
		expect(unsubWarn(0.5)).toBe(true);
		expect(unsubWarn(0.4)).toBe(false);
		expect(unsubWarn(null)).toBe(false);
		expect(resendBadge({ resent_at: null, resend_status: null }, null)).toBeNull();
		expect(resendBadge({ resent_at: null, resend_status: 'pending' }, 'Mon 9:00')).toBe('Resend scheduled Mon 9:00');
		expect(resendBadge({ resent_at: '2026-10-01 00:00:00', resend_status: 'sent' }, null)).toBe('Resent to non-openers');
		expect(passText({ sent: 4, opens: 1, clicks: 0 })).toBe('4 sent · 1 opened (25%) · 0 clicked (0%)');
		expect(plural(1, 'contact')).toBe('1 contact');
		expect(plural(2, 'contact')).toBe('2 contacts');
	});
});

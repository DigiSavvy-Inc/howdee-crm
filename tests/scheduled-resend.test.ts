import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { processScheduledResends, claimScheduledResend } from '../src/lib/server/scheduled';
import type { EngineConfig } from '../src/lib/server/automations';

// #82: scheduled auto-resend to non-openers — processScheduledResends().
//
// cfg.token is Postmark's real 'POSTMARK_API_TEST' token: the vitest-pool-workers
// sandbox DOES have outbound network access, and Postmark's servers recognize this
// magic token and return a real ErrorCode:0 "Test job accepted" response without
// actually delivering mail — so these tests exercise the real send path end to end
// (accepted > 0) rather than only the state transitions around a thrown/blocked send.
const db = (env as any).DB as D1Database;
const cfg: EngineConfig = { token: 'POSTMARK_API_TEST', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeCampaign(opts: {
	status?: string;
	resendStatus?: string | null;
	resendAt?: string; // SQL offset expression, e.g. "-1 minute" (past) or "+1 hour" (future)
	resendSubject?: string | null;
	recipientCount?: number;
}): Promise<number> {
	const {
		status = 'sent',
		resendStatus = 'pending',
		resendAt = '-1 minute',
		resendSubject = null,
		recipientCount = 1
	} = opts;
	const c = await db
		.prepare(
			`INSERT INTO campaigns
			   (subject, body_md, body_html, body_text, from_email, status, sent_at, recipient_count,
			    resend_at, resend_status, resend_subject)
			 VALUES ('Hello', 'md', '<p>hi %%UNSUB_URL%%</p>', 'hi %%UNSUB_URL%%', 'alan@ourco.example', ?, datetime('now'), ?,
			         datetime('now', ?), ?, ?)
			 RETURNING id`
		)
		.bind(status, recipientCount, resendAt, resendStatus, resendSubject)
		.first<{ id: number }>();
	return c!.id;
}

async function makeContact(email: string, subscribed = 1): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id')
		.bind(email, subscribed)
		.first<{ id: number }>();
	return c!.id;
}

async function makeRecipient(campaignId: number, contactId: number | null, email: string, status = 'accepted'): Promise<number> {
	const r = await db
		.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status, message_id) VALUES (?, ?, ?, ?, ?) RETURNING id')
		.bind(campaignId, contactId, email, status, `msg-${email}-${Math.random()}`)
		.first<{ id: number }>();
	return r!.id;
}

async function addEvent(campaignId: number, recipientId: number, contactId: number | null, type: string): Promise<void> {
	await db
		.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, ?)')
		.bind(campaignId, recipientId, contactId, type)
		.run();
}

async function campaignRow(id: number) {
	return db
		.prepare(
			`SELECT status, resend_status, resend_at, resent_at, resend_recipients, resend_subject, recipient_count, error
			 FROM campaigns WHERE id = ?`
		)
		.bind(id)
		.first<{
			status: string;
			resend_status: string | null;
			resend_at: string | null;
			resent_at: string | null;
			resend_recipients: number | null;
			resend_subject: string | null;
			recipient_count: number;
			error: string | null;
		}>();
}

describe('claimScheduledResend (#82)', () => {
	it('only one claimer wins; a non-pending row is unclaimable', async () => {
		const id = await makeCampaign({ resendStatus: 'pending' });
		expect(await claimScheduledResend(db, id)).toBe(true);
		expect(await claimScheduledResend(db, id)).toBe(false); // already 'sending'
		const row = await campaignRow(id);
		expect(row?.resend_status).toBe('sending');
	});
});

describe('processScheduledResends (#82)', () => {
	it('due + pending + parent sent + non-openers exist → sends, bumps recipient_count, marks sent', async () => {
		const id = await makeCampaign({ status: 'sent', resendStatus: 'pending', recipientCount: 2 });

		// One opener (excluded), one laggard (targeted).
		const opener = await makeContact('opener@x.example.net');
		const rOpener = await makeRecipient(id, opener, 'opener@x.example.net');
		await addEvent(id, rOpener, opener, 'open');
		const laggard = await makeContact('laggard@x.example.net');
		await makeRecipient(id, laggard, 'laggard@x.example.net');

		const summary = await processScheduledResends(db, cfg);
		expect(summary).toEqual({ sent: 1, canceled: 0, skipped: 0, failed: 0 });

		const row = await campaignRow(id);
		expect(row?.resend_status).toBe('sent');
		expect(row?.resent_at).not.toBeNull();
		expect(row?.resend_recipients).toBe(1); // only the laggard
		expect(row?.recipient_count).toBe(3); // 2 original + 1 resent

		// A fresh `recipients` row for the laggard on the SAME campaign (no new campaign row).
		const laggardRows = await db
			.prepare(`SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND email = 'laggard@x.example.net' AND status = 'accepted'`)
			.bind(id)
			.first<{ n: number }>();
		expect(laggardRows!.n).toBe(2); // original send + resend
		const campaignCount = await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>();
		expect(campaignCount!.n).toBe(1);

		// It's no longer due — a second tick is a no-op.
		const again = await processScheduledResends(db, cfg);
		expect(again).toEqual({ sent: 0, canceled: 0, skipped: 0, failed: 0 });
	});

	it('resend_subject overrides the original subject when set; falls back to it when blank', async () => {
		const withOverride = await makeCampaign({ resendSubject: 'Reminder!' });
		const c = await makeContact('c1@x.example.net');
		await makeRecipient(withOverride, c, 'c1@x.example.net');

		const withoutOverride = await makeCampaign({ resendSubject: null });
		const c2 = await makeContact('c2@x.example.net');
		await makeRecipient(withoutOverride, c2, 'c2@x.example.net');

		await processScheduledResends(db, cfg);

		const a = await campaignRow(withOverride);
		expect(a?.resend_subject).toBe('Reminder!'); // differs from original 'Hello' → recorded
		const b = await campaignRow(withoutOverride);
		expect(b?.resend_subject).toBeNull(); // same as original 'Hello' → not recorded (matches #81 convention)
	});

	it('pending + parent still scheduled/sending → left untouched (skipped), retried on a later tick', async () => {
		const scheduledParent = await makeCampaign({ status: 'scheduled', resendStatus: 'pending' });
		const sendingParent = await makeCampaign({ status: 'sending', resendStatus: 'pending' });

		const summary = await processScheduledResends(db, cfg);
		expect(summary.skipped).toBe(2);
		expect(summary.sent).toBe(0);
		expect(summary.canceled).toBe(0);

		const a = await campaignRow(scheduledParent);
		expect(a?.resend_status).toBe('pending'); // untouched, will fire once the parent lands on 'sent'
		const b = await campaignRow(sendingParent);
		expect(b?.resend_status).toBe('pending');
	});

	it("parent 'failed' or 'canceled' → the auto-resend is canceled too", async () => {
		const failedParent = await makeCampaign({ status: 'failed', resendStatus: 'pending' });
		const canceledParent = await makeCampaign({ status: 'canceled', resendStatus: 'pending' });

		const summary = await processScheduledResends(db, cfg);
		expect(summary.canceled).toBe(2);

		const a = await campaignRow(failedParent);
		expect(a?.resend_status).toBe('canceled');
		const b = await campaignRow(canceledParent);
		expect(b?.resend_status).toBe('canceled');
	});

	it('due + zero non-openers → marks sent with 0 recipients, no send attempted', async () => {
		const id = await makeCampaign({ status: 'sent', resendStatus: 'pending' });
		// The only original recipient already opened — nobody left to resend to.
		const opener = await makeContact('everyone-opened@x.example.net');
		const r = await makeRecipient(id, opener, 'everyone-opened@x.example.net');
		await addEvent(id, r, opener, 'open');

		const summary = await processScheduledResends(db, cfg);
		expect(summary).toEqual({ sent: 1, canceled: 0, skipped: 0, failed: 0 });

		const row = await campaignRow(id);
		expect(row?.resend_status).toBe('sent');
		expect(row?.resend_recipients).toBe(0);
		expect(row?.resent_at).not.toBeNull();

		// No second `recipients` row was inserted for the opener.
		const rows = await db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?').bind(id).first<{ n: number }>();
		expect(rows!.n).toBe(1); // just the original
	});

	it('not yet due (resend_at in the future) is not picked up', async () => {
		const id = await makeCampaign({ resendAt: '+1 hour' });
		const c = await makeContact('future@x.example.net');
		await makeRecipient(id, c, 'future@x.example.net');

		const summary = await processScheduledResends(db, cfg);
		expect(summary).toEqual({ sent: 0, canceled: 0, skipped: 0, failed: 0 });
		const row = await campaignRow(id);
		expect(row?.resend_status).toBe('pending');
	});

	it('#83: re-pending a previously-sent resend (manual scheduled resend replacing a completed one) fires again when due, targeting only current non-openers', async () => {
		// Simulate a campaign whose FIRST resend already completed (resend_status='sent').
		const id = await makeCampaign({ status: 'sent', resendStatus: 'sent' });
		await db
			.prepare(`UPDATE campaigns SET resent_at = datetime('now', '-2 hours'), resend_recipients = 1 WHERE id = ?`)
			.bind(id)
			.run();

		// Original opener — excluded from any resend, then and now.
		const opener = await makeContact('opener2@x.example.net');
		const rOpener = await makeRecipient(id, opener, 'opener2@x.example.net');
		await addEvent(id, rOpener, opener, 'open');

		// Opened only after the first resend (fresh recipient row from that resend, with
		// an open event) — should be excluded from a second resend too.
		const lateOpener = await makeContact('lateopener@x.example.net');
		await makeRecipient(id, lateOpener, 'lateopener@x.example.net'); // original send row
		const rLateResend = await makeRecipient(id, lateOpener, 'lateopener@x.example.net'); // first-resend row
		await addEvent(id, rLateResend, lateOpener, 'open');

		// Still hasn't opened either send — eligible for the new resend.
		const laggard = await makeContact('laggard2@x.example.net');
		await makeRecipient(id, laggard, 'laggard2@x.example.net');

		// This is the state contract the ?/resend action writes when scheduling a NEW
		// resend on top of a campaign whose previous auto/manual resend already finished:
		// resend_status flips back 'sent' → 'pending' with a fresh due resend_at (the
		// intended "replace" semantics — overwriting a completed or canceled schedule).
		await db
			.prepare(`UPDATE campaigns SET resend_at = datetime('now', '-1 minute'), resend_status = 'pending', resend_subject = NULL WHERE id = ?`)
			.bind(id)
			.run();

		const summary = await processScheduledResends(db, cfg);
		expect(summary).toEqual({ sent: 1, canceled: 0, skipped: 0, failed: 0 });

		const row = await campaignRow(id);
		expect(row?.resend_status).toBe('sent');
		expect(row?.resend_recipients).toBe(1); // only the laggard, this time

		// The laggard got a fresh `recipients` row from THIS resend (original + this one).
		const laggardRows = await db
			.prepare(`SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND email = 'laggard2@x.example.net' AND status = 'accepted'`)
			.bind(id)
			.first<{ n: number }>();
		expect(laggardRows!.n).toBe(2);

		// Neither opener got a new recipients row from this second resend.
		const openerRows = await db
			.prepare(`SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND email IN ('opener2@x.example.net', 'lateopener@x.example.net')`)
			.bind(id)
			.first<{ n: number }>();
		expect(openerRows!.n).toBe(3); // opener2 (1) + lateopener (original + first resend = 2)
	});

	it('resend_status IS NULL (no auto-resend configured) is never touched', async () => {
		const id = await makeCampaign({ resendStatus: null });
		const summary = await processScheduledResends(db, cfg);
		expect(summary).toEqual({ sent: 0, canceled: 0, skipped: 0, failed: 0 });
		const row = await campaignRow(id);
		expect(row?.resend_status).toBeNull();
	});
});

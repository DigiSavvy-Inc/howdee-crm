import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { nonOpenerRecipients, nonOpenerCount } from '../src/lib/server/resend';

// #81: "Resend to non-openers" — nonOpenerRecipients/nonOpenerCount filtering.
const db = (env as any).DB as D1Database;

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

async function makeCampaign(): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES ('Hello', 'md', '<p>hi %%UNSUB_URL%%</p>', 'alan@ourco.example', 'sent', datetime('now'))
			 RETURNING id`
		)
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

describe('nonOpenerRecipients / nonOpenerCount (#81)', () => {
	it('excludes openers, bouncers/spam, and unsubscribed contacts; includes clicked-only and untouched', async () => {
		const campaignId = await makeCampaign();

		// A: opened.
		const a = await makeContact('a@x.example.net');
		const rA = await makeRecipient(campaignId, a, 'a@x.example.net');
		await addEvent(campaignId, rA, a, 'open');

		// B: clicked only (no open) — should be included.
		const b = await makeContact('b@x.example.net');
		const rB = await makeRecipient(campaignId, b, 'b@x.example.net');
		await addEvent(campaignId, rB, b, 'click');

		// C: bounced.
		const c = await makeContact('c@x.example.net');
		const rC = await makeRecipient(campaignId, c, 'c@x.example.net');
		await addEvent(campaignId, rC, c, 'bounce');

		// D: unsubscribed since the send (contacts.subscribed = 0).
		const d = await makeContact('d@x.example.net', 0);
		await makeRecipient(campaignId, d, 'd@x.example.net');

		// E: untouched — should be included.
		const e = await makeContact('e@x.example.net');
		await makeRecipient(campaignId, e, 'e@x.example.net');

		const recipients = await nonOpenerRecipients(db, campaignId);
		const emails = recipients.map((r) => r.email).sort();
		expect(emails).toEqual(['b@x.example.net', 'e@x.example.net']);

		// Tags/meta fields present on the SendableRecipient shape (may be null, but the
		// keys must exist — this is what feeds conditional content at send time).
		for (const r of recipients) {
			expect(r).toHaveProperty('tags');
			expect(r).toHaveProperty('meta');
			expect(r).toHaveProperty('id');
		}

		const count = await nonOpenerCount(db, campaignId);
		expect(count).toBe(2);
	});

	it('drops rows with no contact record (no fallback email match), and dedupes by email', async () => {
		const campaignId = await makeCampaign();

		// A recipient row whose email matches no contact at all — can't verify consent.
		await makeRecipient(campaignId, null, 'stranger@x.example.net');

		// A recipient row with NULL contact_id but a matching contact by email — should
		// still resolve via the email fallback and be included.
		const matched = await makeContact('matched@x.example.net');
		await makeRecipient(campaignId, null, 'matched@x.example.net');

		// Two recipient rows for the same contact_id (e.g. a duplicate accepted row) —
		// the result should still contain that contact only once.
		const dup = await makeContact('dup@x.example.net');
		await makeRecipient(campaignId, dup, 'dup@x.example.net');
		await makeRecipient(campaignId, dup, 'dup@x.example.net');

		const recipients = await nonOpenerRecipients(db, campaignId);
		const emails = recipients.map((r) => r.email).sort();
		expect(emails).toEqual(['dup@x.example.net', 'matched@x.example.net']);
		expect(recipients.find((r) => r.id === matched)).toBeTruthy();
	});

	it('a non-"accepted" original recipient row (e.g. a delivery error) is not resend-eligible', async () => {
		const campaignId = await makeCampaign();
		const f = await makeContact('f@x.example.net');
		await makeRecipient(campaignId, f, 'f@x.example.net', 'error');

		expect(await nonOpenerRecipients(db, campaignId)).toEqual([]);
		expect(await nonOpenerCount(db, campaignId)).toBe(0);
	});

	it('a resend (new recipients rows on the SAME campaign) still excludes openers and keeps still-unopened contacts eligible', async () => {
		const campaignId = await makeCampaign();

		const opener = await makeContact('op@x.example.net');
		const rOpener = await makeRecipient(campaignId, opener, 'op@x.example.net');
		await addEvent(campaignId, rOpener, opener, 'open');

		const laggard = await makeContact('lag@x.example.net');
		await makeRecipient(campaignId, laggard, 'lag@x.example.net');

		// Sanity: before any resend, only the laggard is targetable.
		expect((await nonOpenerRecipients(db, campaignId)).map((r) => r.email)).toEqual(['lag@x.example.net']);

		// Simulate what the ?/resend action does: sendCampaignEmail inserts a fresh
		// `recipients` row per recipient on the SAME campaign id (new message_id, status
		// 'accepted') — it does NOT create a new campaign row.
		await makeRecipient(campaignId, laggard, 'lag@x.example.net');

		// The opener is still excluded (their open event still matches this campaign);
		// the laggard — who still hasn't opened either send — remains eligible, which is
		// exactly what would let a second resend target them again.
		const after = await nonOpenerRecipients(db, campaignId);
		expect(after.map((r) => r.email)).toEqual(['lag@x.example.net']);
		expect(await nonOpenerCount(db, campaignId)).toBe(1);

		// Still only ONE campaign row exists — the resend reused it.
		const campaignCount = await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>();
		expect(campaignCount!.n).toBe(1);
	});
});

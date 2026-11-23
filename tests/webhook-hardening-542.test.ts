import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST as webhook } from '../src/routes/api/webhook/+server';
import { webhookDedupeKey } from '../src/lib/server/webhook-dedupe';

// #542: the Postmark webhook fails closed without WEBHOOK_KEY, only suppresses an address we
// sent that MessageID to, and treats a Postmark retry of the same record as a no-op.
const db = (env as any).DB as D1Database;
const KEY = 'test-key-542';

function hook(payload: object, opts: { key?: string | null; envKey?: string } = {}) {
	const envKey = opts.envKey ?? KEY;
	const qs = opts.key === null ? '' : `?key=${encodeURIComponent(opts.key ?? KEY)}`;
	return webhook({
		platform: { env: { ...env, WEBHOOK_KEY: envKey } },
		url: new URL(`https://app.test/api/webhook${qs}`),
		request: new Request(`https://app.test/api/webhook${qs}`, { method: 'POST', body: JSON.stringify(payload) })
	} as any);
}

let seq = 0;
async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
}
async function sentTo(email: string): Promise<string> {
	const cid = (await db
		.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'alan@ourco.example', 'sent') RETURNING id`)
		.first<{ id: number }>())!.id;
	const mid = `msg-542-${++seq}`;
	await db
		.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, (SELECT id FROM contacts WHERE email = ?), ?, ?, 'accepted')")
		.bind(cid, email, email, mid)
		.run();
	return mid;
}
const subscribed = async (id: number) =>
	(await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed;
const unsubRows = async (email: string) =>
	(await db.prepare('SELECT COUNT(*) AS n FROM unsubscribes WHERE email = ?').bind(email).first<{ n: number }>())!.n;
const eventRows = async (mid: string) =>
	(await db.prepare('SELECT COUNT(*) AS n FROM events WHERE message_id = ?').bind(mid).first<{ n: number }>())!.n;

describe('key gate', () => {
	it('refuses every request when WEBHOOK_KEY is unset, even without a key in the URL', async () => {
		const id = await contact('nokey@542.test');
		const mid = await sentTo('nokey@542.test');
		const payload = { RecordType: 'Bounce', ID: 1, Type: 'HardBounce', Email: 'nokey@542.test', MessageID: mid, BouncedAt: '2026-11-09T10:00:00Z' };
		expect((await hook(payload, { envKey: '', key: null })).status).toBe(401);
		expect((await hook(payload, { envKey: '', key: '' })).status).toBe(401);
		expect(await subscribed(id)).toBe(1);
		expect(await eventRows(mid)).toBe(0);
	});

	it('refuses a wrong or missing key, accepts the right one', async () => {
		expect((await hook({ RecordType: 'Open', MessageID: 'x' }, { key: 'wrong' })).status).toBe(401);
		expect((await hook({ RecordType: 'Open', MessageID: 'x' }, { key: null })).status).toBe(401);
		expect((await hook({ RecordType: 'Open', MessageID: 'x' })).status).toBe(200);
	});
});

describe('forged suppression', () => {
	it('a bounce naming an address with no MessageID changes nobody', async () => {
		const id = await contact('victim1@542.test');
		await hook({ RecordType: 'Bounce', ID: 11, Type: 'HardBounce', Email: 'victim1@542.test', BouncedAt: '2026-11-09T10:00:00Z' });
		await hook({ RecordType: 'SpamComplaint', ID: 12, Email: 'victim1@542.test', BouncedAt: '2026-11-09T10:00:00Z' });
		expect(await subscribed(id)).toBe(1);
		expect(await unsubRows('victim1@542.test')).toBe(0);
	});

	it('a bounce whose MessageID was sent to someone else changes nobody', async () => {
		const victim = await contact('victim2@542.test');
		await contact('attacker@542.test');
		const mid = await sentTo('attacker@542.test');
		await hook({ RecordType: 'Bounce', ID: 21, Type: 'HardBounce', Email: 'victim2@542.test', MessageID: mid, BouncedAt: '2026-11-09T10:00:00Z' });
		await hook({ RecordType: 'SubscriptionChange', Recipient: 'victim2@542.test', MessageID: mid, SuppressSending: true, ChangedAt: '2026-11-09T10:00:00Z' });
		expect(await subscribed(victim)).toBe(1);
		expect(await unsubRows('victim2@542.test')).toBe(0);
	});

	it('an unknown MessageID changes nobody', async () => {
		const id = await contact('victim3@542.test');
		await hook({ RecordType: 'Bounce', ID: 31, Type: 'HardBounce', Email: 'victim3@542.test', MessageID: 'made-up', BouncedAt: '2026-11-09T10:00:00Z' });
		expect(await subscribed(id)).toBe(1);
	});

	it('a real bounce for that send (address case-insensitive) suppresses', async () => {
		const id = await contact('real@542.test');
		const mid = await sentTo('real@542.test');
		await hook({ RecordType: 'Bounce', ID: 41, Type: 'HardBounce', Email: 'Real@542.TEST', MessageID: mid, BouncedAt: '2026-11-09T10:00:00Z' });
		expect(await subscribed(id)).toBe(0);
		expect(await unsubRows('real@542.test')).toBe(1);
	});
});

describe('repeated delivery', () => {
	it('a Postmark retry of the same bounce is a no-op', async () => {
		const id = await contact('retry@542.test');
		const mid = await sentTo('retry@542.test');
		const payload = { RecordType: 'Bounce', ID: 51, Type: 'HardBounce', Email: 'retry@542.test', MessageID: mid, BouncedAt: '2026-11-09T10:00:00Z' };
		const first = await hook(payload);
		expect(await first.json()).toEqual({ ok: true });
		const second = await hook(payload);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ ok: true, duplicate: true });
		expect(await subscribed(id)).toBe(0);
		expect(await eventRows(mid)).toBe(1);
		expect(await unsubRows('retry@542.test')).toBe(1);
	});

	it('a retried open is stored once; a later open of the same message is a new event', async () => {
		await contact('opens@542.test');
		const mid = await sentTo('opens@542.test');
		const open = { RecordType: 'Open', MessageID: mid, Recipient: 'opens@542.test', ReceivedAt: '2026-11-09T10:00:00Z' };
		await hook(open);
		await hook(open);
		expect(await eventRows(mid)).toBe(1);
		await hook({ ...open, ReceivedAt: '2026-11-09T11:00:00Z' });
		expect(await eventRows(mid)).toBe(2);
	});

	it('dedupe key: stable per record, null without an ID or timestamp', async () => {
		const a = await webhookDedupeKey({ RecordType: 'Click', MessageID: 'm', ReceivedAt: 't', OriginalLink: 'https://a' });
		const b = await webhookDedupeKey({ RecordType: 'Click', MessageID: 'm', ReceivedAt: 't', OriginalLink: 'https://b' });
		expect(a).toMatch(/^pm:[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
		expect(await webhookDedupeKey({ RecordType: 'Click', MessageID: 'm', ReceivedAt: 't', OriginalLink: 'https://a' })).toBe(a);
		expect(await webhookDedupeKey({ RecordType: 'Open', MessageID: 'm' })).toBeNull();
	});
});

describe('migration 0117', () => {
	it('indexes recipients(contact_id)', async () => {
		const idx = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_recipients_contact'").first();
		expect(idx).toBeTruthy();
	});
});

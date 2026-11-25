import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { actions as deliverabilityActions } from '../src/routes/deliverability/+page.server';
import { POST as webhook } from '../src/routes/api/webhook/+server';
import { bulkResubscribe, resolveSelection } from '../src/lib/server/contact-bulk';
import {
	lastSuppressionSync,
	runSuppressionSync,
	runSuppressionSyncDaily,
	syncSuppressions
} from '../src/lib/server/suppression-sync';

// #285: sync suppressions from Postmark, hard-bounce audit row, resubscribe guard.
const db = (env as any).DB as D1Database;
const creds = { token: 't', stream: 'broadcast', txStream: 'outbound' };

type Supp = { EmailAddress: string; SuppressionReason: string };
/** Mock Postmark: `dumps[stream]` is that stream's dump; `down` = every request throws. */
function mockPostmark(dumps: Record<string, Supp[]>, opts: { down?: boolean } = {}) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (opts.down) throw new Error('network down');
		const m = /\/message-streams\/([^/]+)\/suppressions\/dump$/.exec(url);
		if (!m || (init?.method && init.method !== 'GET')) return new Response('unexpected', { status: 500 });
		return new Response(JSON.stringify({ Suppressions: dumps[decodeURIComponent(m[1])] ?? [] }), { status: 200 });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}
async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const r = await db.prepare(sql).bind(...binds).first<{ n: number }>();
	return r?.n ?? 0;
}
async function contact(email: string, subscribed = 1, archived = false): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO contacts (email, subscribed, archived_at) VALUES (?, ?, ${archived ? "datetime('now')" : 'NULL'}) RETURNING id`
		)
		.bind(email, subscribed)
		.first<{ id: number }>())!.id;
}
const subscribed = async (id: number) => count('SELECT subscribed AS n FROM contacts WHERE id = ?', id);

async function activePass(contactId: number): Promise<void> {
	const auto = (await db
		.prepare("INSERT INTO automations (name, status) VALUES ('Nurture', 'active') RETURNING id")
		.first<{ id: number }>())!.id;
	const step = (await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
			 VALUES (?, 0, 0, 'Hi', 'md', 'alan@ourco.example', 'email') RETURNING id`
		)
		.bind(auto)
		.first<{ id: number }>())!.id;
	await db
		.prepare(
			`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, next_run_at)
			 VALUES (?, ?, ?, 'active', datetime('now'))`
		)
		.bind(auto, contactId, step)
		.run();
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key IN ('last_suppression_sync', 'suppression_sync_cron_at')")
	]);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await db.prepare('DELETE FROM unsubscribes').run();
});

describe('syncSuppressions', () => {
	it('unsubscribes matching subscribed contacts with a reason row and cancels their passes', async () => {
		const hard = await contact('hard@b.test');
		const spam = await contact('Spam@B.test');
		const manual = await contact('manual@b.test');
		const fine = await contact('fine@b.test');
		await activePass(hard);
		await activePass(fine);
		const fetchMock = mockPostmark({
			broadcast: [
				{ EmailAddress: 'HARD@b.test', SuppressionReason: 'HardBounce' },
				{ EmailAddress: 'spam@b.test', SuppressionReason: 'SpamComplaint' },
				{ EmailAddress: 'nobody@b.test', SuppressionReason: 'HardBounce' }
			],
			outbound: [{ EmailAddress: 'manual@b.test', SuppressionReason: 'ManualSuppression' }]
		});

		const out = await syncSuppressions(db, creds);
		expect(out).toMatchObject({
			ok: true,
			checked: 4,
			matched: 3,
			unsubscribed: 3,
			alreadyUnsubscribed: 0,
			byReason: { HardBounce: 1, SpamComplaint: 1, ManualSuppression: 1 }
		});
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
			'https://api.postmarkapp.com/message-streams/broadcast/suppressions/dump',
			'https://api.postmarkapp.com/message-streams/outbound/suppressions/dump'
		]);
		// Only dump reads — never a suppress() POST.
		for (const [, init] of fetchMock.mock.calls) expect(init?.method ?? 'GET').toBe('GET');

		expect([await subscribed(hard), await subscribed(spam), await subscribed(manual), await subscribed(fine)]).toEqual([0, 0, 0, 1]);
		const rows = await db
			.prepare('SELECT contact_id, reason, detail FROM unsubscribes ORDER BY contact_id')
			.all<{ contact_id: number; reason: string; detail: string }>();
		expect(rows.results).toEqual([
			{ contact_id: hard, reason: 'postmark:HardBounce', detail: 'Postmark sync (broadcast)' },
			{ contact_id: spam, reason: 'postmark:SpamComplaint', detail: 'Postmark sync (broadcast)' },
			{ contact_id: manual, reason: 'postmark:ManualSuppression', detail: 'Postmark sync (outbound)' }
		]);
		expect(await count("SELECT COUNT(*) AS n FROM automation_enrollments WHERE contact_id = ? AND status = 'cancelled'", hard)).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM automation_enrollments WHERE contact_id = ? AND status = 'active'", fine)).toBe(1);
	});

	it('leaves already-unsubscribed contacts untouched, and a second run is a no-op', async () => {
		const gone = await contact('gone@b.test', 0);
		await activePass(gone);
		const a = await contact('a@b.test');
		mockPostmark({
			broadcast: [
				{ EmailAddress: 'gone@b.test', SuppressionReason: 'HardBounce' },
				{ EmailAddress: 'a@b.test', SuppressionReason: 'HardBounce' }
			]
		});
		const first = await syncSuppressions(db, creds);
		expect(first).toMatchObject({ ok: true, matched: 2, unsubscribed: 1, alreadyUnsubscribed: 1 });
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes WHERE contact_id = ?', gone)).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM automation_enrollments WHERE contact_id = ? AND status = 'active'", gone)).toBe(1);
		expect(await subscribed(a)).toBe(0);

		const second = await syncSuppressions(db, creds);
		expect(second).toMatchObject({ ok: true, matched: 2, unsubscribed: 0, alreadyUnsubscribed: 2, byReason: {} });
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes')).toBe(1);
	});

	it('keeps archived contacts archived', async () => {
		const arch = await contact('arch@b.test', 1, true);
		mockPostmark({ broadcast: [{ EmailAddress: 'arch@b.test', SuppressionReason: 'HardBounce' }] });
		await syncSuppressions(db, creds);
		const row = await db.prepare('SELECT subscribed, archived_at FROM contacts WHERE id = ?').bind(arch).first<{ subscribed: number; archived_at: string | null }>();
		expect(row?.subscribed).toBe(0);
		expect(row?.archived_at).toBeTruthy();
	});

	it('reports Postmark failures without throwing, and needs a token', async () => {
		await contact('a@b.test');
		mockPostmark({}, { down: true });
		const out = await syncSuppressions(db, creds);
		expect(out.ok).toBe(false);
		expect(await syncSuppressions(db, {})).toEqual({ ok: false, error: 'Postmark is not configured (no POSTMARK_TOKEN).' });
	});
});

describe('Sync from Postmark (Deliverability) and the daily run', () => {
	it('the form action returns the counts and stores the last sync', async () => {
		await contact('a@b.test');
		mockPostmark({ broadcast: [{ EmailAddress: 'a@b.test', SuppressionReason: 'HardBounce' }] });
		const event = {
			platform: { env: { DB: db, POSTMARK_TOKEN: 't', POSTMARK_STREAM: 'broadcast' } },
			request: new Request('https://app.test/deliverability?/syncSuppressions', { method: 'POST', body: new FormData() })
		} as any;
		const out = (await deliverabilityActions.syncSuppressions(event)) as any;
		expect(out.sync).toMatchObject({ checked: 1, matched: 1, unsubscribed: 1, byReason: { HardBounce: 1 } });
		const last = await lastSuppressionSync(db);
		expect(last).toMatchObject({ trigger: 'manual', unsubscribed: 1, checked: 1 });
		expect(typeof last?.at).toBe('string');
	});

	it('runs at most once a day and never throws', async () => {
		await contact('a@b.test');
		const fetchMock = mockPostmark({ broadcast: [{ EmailAddress: 'a@b.test', SuppressionReason: 'HardBounce' }] });
		const now = Date.parse('2026-10-17T12:00:00Z');
		expect(await runSuppressionSyncDaily(db, creds, now)).toMatchObject({ ok: true, unsubscribed: 1 });
		const calls = fetchMock.mock.calls.length;
		expect(await runSuppressionSyncDaily(db, creds, now + 60_000)).toEqual({ skipped: 'ran in the last 24h' });
		expect(fetchMock.mock.calls.length).toBe(calls);
		expect((await lastSuppressionSync(db))?.trigger).toBe('cron');

		mockPostmark({}, { down: true });
		const failed = await runSuppressionSyncDaily(db, creds, now + 25 * 3600_000);
		expect(failed).toMatchObject({ ok: false });
		expect(await runSuppressionSyncDaily(db, {}, now)).toEqual({ skipped: 'not configured' });
	});

	it('#729: two clocks ticking at once run the daily sync once', async () => {
		await contact('twice@b.test');
		mockPostmark({ broadcast: [{ EmailAddress: 'twice@b.test', SuppressionReason: 'HardBounce' }] });
		const now = Date.parse('2026-10-18T12:00:00Z');
		const results = await Promise.all([runSuppressionSyncDaily(db, creds, now), runSuppressionSyncDaily(db, creds, now)]);
		const ran = results.filter((r) => 'ok' in r);
		expect(ran).toHaveLength(1);
		expect(results.filter((r) => 'skipped' in r)).toEqual([{ skipped: 'ran in the last 24h' }]);
		// Whichever read first, only one call wins the compare-and-set on the stamp.
		const stamp = await db.prepare(`SELECT value FROM app_state WHERE key = 'suppression_sync_cron_at'`).first<{ value: string }>();
		expect(stamp?.value).toBe(new Date(now).toISOString());
	});

	it('runSuppressionSync does not store a failed run', async () => {
		mockPostmark({}, { down: true });
		await runSuppressionSync(db, creds, 'manual');
		expect(await lastSuppressionSync(db)).toBeNull();
	});
});

// #542: a bounce / complaint only suppresses an address we sent that MessageID to.
let sentSeq = 0;
async function sentTo(email: string): Promise<string> {
	const cid = (await db.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'alan@ourco.example', 'sent') RETURNING id`).first<{ id: number }>())!.id;
	const mid = `pm-${++sentSeq}`;
	await db
		.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, (SELECT id FROM contacts WHERE email = ?), ?, ?, 'accepted')")
		.bind(cid, email, email, mid)
		.run();
	return mid;
}

describe('webhook hard bounce', () => {
	function hook(payload: object) {
		return webhook({
			platform: { env: { ...env, WEBHOOK_KEY: 'test-key' } },
			url: new URL('https://app.test/api/webhook?key=test-key'),
			request: new Request('https://app.test/api/webhook', { method: 'POST', body: JSON.stringify(payload) })
		} as any);
	}

	it('writes an unsubscribes row for a HardBounce or Inactive bounce, not for a soft bounce', async () => {
		const hard = await contact('hard@b.test');
		const inactive = await contact('inactive@b.test');
		const soft = await contact('soft@b.test');
		await hook({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'hard@b.test', MessageID: await sentTo('hard@b.test') });
		await hook({ RecordType: 'Bounce', Type: 'Transient', Inactive: true, Email: 'inactive@b.test', MessageID: await sentTo('inactive@b.test') });
		await hook({ RecordType: 'Bounce', Type: 'SoftBounce', Email: 'soft@b.test', MessageID: await sentTo('soft@b.test') });
		expect([await subscribed(hard), await subscribed(inactive), await subscribed(soft)]).toEqual([0, 0, 1]);
		const rows = await db
			.prepare('SELECT email, reason, detail FROM unsubscribes ORDER BY email')
			.all<{ email: string; reason: string; detail: string }>();
		expect(rows.results).toEqual([
			{ email: 'hard@b.test', reason: 'HardBounce', detail: 'via Postmark' },
			{ email: 'inactive@b.test', reason: 'HardBounce', detail: 'via Postmark' }
		]);
	});
});

describe('resubscribe guard', () => {
	it('skips HardBounce and SpamComplaint suppressions, allows ManualSuppression', async () => {
		const hard = await contact('hard@b.test', 0);
		const spam = await contact('spam@b.test', 0);
		const manual = await contact('manual@b.test', 0);
		const clean = await contact('clean@b.test', 0);
		mockPostmark({
			broadcast: [
				{ EmailAddress: 'hard@b.test', SuppressionReason: 'HardBounce' },
				{ EmailAddress: 'manual@b.test', SuppressionReason: 'ManualSuppression' },
				{ EmailAddress: 'spam@b.test', SuppressionReason: 'ManualSuppression' }
			],
			// spam@ is manual on broadcast but a spam complaint on outbound: the complaint wins.
			outbound: [
				{ EmailAddress: 'spam@b.test', SuppressionReason: 'SpamComplaint' },
				{ EmailAddress: 'manual@b.test', SuppressionReason: 'ManualSuppression' }
			]
		});
		const sel = await resolveSelection(db, { ids: [hard, spam, manual, clean] });
		if (!sel.ok) throw new Error(sel.error);
		const out = await bulkResubscribe(db, sel, { postmark: creds });
		expect(out).toMatchObject({ ok: true, affected: 2, skipped: 2 });
		if (out.ok) expect(out.message).toBe('Resubscribed 2 · 2 skipped: suppressed in Postmark (bounce/spam)');
		expect([await subscribed(hard), await subscribed(spam), await subscribed(manual), await subscribed(clean)]).toEqual([0, 0, 1, 1]);
	});

	it('proceeds with a note when Postmark is down or not configured', async () => {
		const a = await contact('a@b.test', 0);
		const b = await contact('b@b.test', 0);
		mockPostmark({}, { down: true });
		let sel = await resolveSelection(db, { ids: [a] });
		if (!sel.ok) throw new Error(sel.error);
		const down = await bulkResubscribe(db, sel, { postmark: creds });
		if (down.ok) expect(down.message).toBe('Resubscribed 1 · Postmark unreachable, suppressions not checked');
		expect(await subscribed(a)).toBe(1);

		sel = await resolveSelection(db, { ids: [b] });
		if (!sel.ok) throw new Error(sel.error);
		const none = await bulkResubscribe(db, sel, {});
		if (none.ok) expect(none.message).toBe('Resubscribed 1 · Postmark not configured, suppressions not checked');
		expect(await subscribed(b)).toBe(1);
	});
});

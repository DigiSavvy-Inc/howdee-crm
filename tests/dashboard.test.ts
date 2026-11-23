import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	recentActivity,
	feedTypes,
	parseFeedFilter,
	getFeedSize,
	setFeedSize,
	DEFAULT_ACTIVITY_TYPES
} from '../src/lib/server/activity';
import { tileMath, pct, loadTiles, upcomingSends, recentCampaigns, recentUnsubscribes } from '../src/lib/server/dashboard';
import { relTime } from '../src/lib/reltime';

const db = (env as any).DB as D1Database;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM webhook_events'),
		db.prepare('DELETE FROM webhook_keys'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key = 'dashboard_feed_size'")
	]);
});

/** One row per source, each at a distinct, known time (t01 oldest … newest last). */
async function seedAllSources() {
	const ann = await id(
		"INSERT INTO contacts (email, name, source, created_at) VALUES ('ann@x.example.net', 'Ann A', 'csv', '2026-01-01 00:01:00') RETURNING id"
	);
	const list = await id("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id");
	const camp = await id(
		"INSERT INTO campaigns (subject, body_md, body_html, from_email, list_id, status, recipient_count, sent_at) VALUES ('Hello', 'm', 'h', 'f@x.example.net', ?, 'sent', 1, '2026-01-01 00:02:00') RETURNING id",
		list
	);
	const rcp = await id(
		"INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'm1', 'accepted') RETURNING id",
		camp,
		ann
	);
	const ev = (type: string, at: string, detail: string | null = null) =>
		db
			.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type, message_id, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.bind(camp, rcp, ann, type, 'm1', detail, at)
			.run();
	await ev('delivery', '2026-01-01 00:03:00');
	await ev('open', '2026-01-01 00:04:00');
	await ev('click', '2026-01-01 00:05:00', JSON.stringify({ OriginalLink: 'https://ourco.example/x' }));
	await ev('bounce', '2026-01-01 00:06:00', '{"Type": "HardBou'); // truncated JSON must not break the query
	// Webhook unsubscribe writes BOTH an event and an unsubscribes row — only the row shows.
	await ev('unsubscribe', '2026-01-01 00:07:00');
	await db
		.prepare("INSERT INTO unsubscribes (contact_id, campaign_id, email, reason, created_at) VALUES (?, ?, 'ann@x.example.net', 'Too many emails', '2026-01-01 00:07:00')")
		.bind(ann, camp)
		.run();
	await db
		.prepare("INSERT INTO unsubscribes (contact_id, campaign_id, email, reason, detail, created_at) VALUES (NULL, ?, 'gone@x.example.net', 'Marked as spam', 'via Postmark', '2026-01-01 00:08:00')")
		.bind(camp)
		.run();
	await db
		.prepare("INSERT INTO replies (contact_id, campaign_id, from_email, subject, received_at) VALUES (?, ?, 'ann@x.example.net', 'Re: Hello', '2026-01-01 00:09:00')")
		.bind(ann, camp)
		.run();
	const key = await id("INSERT INTO webhook_keys (label, token) VALUES ('Site form', 'tok') RETURNING id");
	await db
		.prepare("INSERT INTO webhook_events (key_id, email, status, created_at) VALUES (?, 'ann@x.example.net', 'added', '2026-01-01 00:10:00')")
		.bind(key)
		.run();
	await db
		.prepare("INSERT INTO webhook_events (key_id, email, status, detail, created_at) VALUES (?, 'bot@x.example.net', 'rejected', 'honeypot', '2026-01-01 00:10:30')")
		.bind(key)
		.run();
	const auto = await id("INSERT INTO automations (name, status) VALUES ('Welcome', 'active') RETURNING id");
	await db
		.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status, enrolled_at, ended_at) VALUES (?, ?, 'completed', '2026-01-01 00:11:00', '2026-01-01 00:12:00')")
		.bind(auto, ann)
		.run();
	return { ann, camp, auto };
}

describe('recentActivity (#133)', () => {
	it('maps each source to the normalized shape, newest first, delivery excluded by default', async () => {
		const { ann, camp, auto } = await seedAllSources();
		const rows = await recentActivity(db, { limit: 50 });
		expect(rows.map((r) => r.type)).toEqual([
			'completed',
			'enrolled',
			'form',
			'reply',
			'spam',
			'unsubscribe',
			'bounce',
			'click',
			'open',
			'contact'
		]);
		const by = Object.fromEntries(rows.map((r) => [r.type, r]));

		expect(by.open).toMatchObject({ at: '2026-01-01 00:04:00', contact_id: ann, email: 'ann@x.example.net', name: 'Ann A', campaign_id: camp, subject: 'Hello' });
		expect(by.click.detail).toBe('https://ourco.example/x');
		expect(by.bounce.detail).toBeNull();
		expect(by.unsubscribe).toMatchObject({ contact_id: ann, campaign_id: camp, subject: 'Hello', detail: 'Too many emails' });
		expect(by.spam).toMatchObject({ contact_id: null, email: 'gone@x.example.net', detail: 'Marked as spam' });
		expect(by.reply).toMatchObject({ contact_id: ann, campaign_id: camp, subject: 'Hello', detail: 'Re: Hello' });
		expect(by.form).toMatchObject({ contact_id: ann, email: 'ann@x.example.net', detail: 'Site form', campaign_id: null });
		expect(by.contact).toMatchObject({ contact_id: ann, detail: 'csv', at: '2026-01-01 00:01:00' });
		expect(by.enrolled).toMatchObject({ automation_id: auto, automation_name: 'Welcome', at: '2026-01-01 00:11:00' });
		expect(by.completed).toMatchObject({ automation_id: auto, at: '2026-01-01 00:12:00' });
	});

	it('filters by type and includes delivery only when asked', async () => {
		await seedAllSources();
		expect((await recentActivity(db, { types: feedTypes('opens') })).map((r) => r.type)).toEqual(['open']);
		expect((await recentActivity(db, { types: feedTypes('unsubs') })).map((r) => r.type)).toEqual(['spam', 'unsubscribe']);
		expect((await recentActivity(db, { types: feedTypes('automations') })).map((r) => r.type)).toEqual(['completed', 'enrolled']);
		expect((await recentActivity(db, { types: ['unsubscribe'] })).map((r) => r.type)).toEqual(['unsubscribe']);
		expect((await recentActivity(db, { types: ['delivery'] })).map((r) => r.type)).toEqual(['delivery']);
		expect(DEFAULT_ACTIVITY_TYPES).not.toContain('delivery');
		expect(await recentActivity(db, { types: [] })).toEqual([]);
	});

	it('applies the limit across sources', async () => {
		await seedAllSources();
		const rows = await recentActivity(db, { limit: 3 });
		expect(rows.map((r) => r.type)).toEqual(['completed', 'enrolled', 'form']);
	});

	it('parses ?feed= and persists the feed size', async () => {
		expect(parseFeedFilter('clicks')).toBe('clicks');
		expect(parseFeedFilter('nope')).toBe('all');
		expect(parseFeedFilter(null)).toBe('all');
		expect(await getFeedSize(db)).toBe(25);
		expect(await setFeedSize(db, 77)).toBe(false);
		expect(await setFeedSize(db, 100)).toBe(true);
		expect(await getFeedSize(db)).toBe(100);
	});
});

describe('tile math (#133)', () => {
	it('computes the subscriber delta and guards rates against zero sends', () => {
		const t = tileMath({
			subscribers: 10,
			new_subscribed_30d: 4,
			unsubscribes_30d: 6,
			sent_7d: 0,
			opens_7d: 0,
			awaiting_reply: 0,
			active_automations: 0,
			active_enrollments: 0
		});
		expect(t.subscriber_delta).toBe(-2);
		expect(t.open_rate_7d).toBeNull();
		expect(pct(1, 3)).toBe(33);
		expect(pct(5, 0)).toBeNull();
	});

	it('loadTiles counts from the database', async () => {
		const a = await id("INSERT INTO contacts (email) VALUES ('a@x.example.net') RETURNING id");
		const b = await id("INSERT INTO contacts (email) VALUES ('b@x.example.net') RETURNING id");
		await db.prepare("INSERT INTO contacts (email, subscribed, created_at) VALUES ('old@x.example.net', 1, '2020-01-01 00:00:00')").run();
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('u@x.example.net', 0)").run();
		await db.prepare("INSERT INTO unsubscribes (email, reason) VALUES ('u@x.example.net', 'x'), ('u@x.example.net', 'again')").run();
		await db.prepare("INSERT INTO unsubscribes (email, created_at) VALUES ('ancient@x.example.net', '2020-01-01 00:00:00')").run();
		const camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('s', 'm', 'h', 'f@x.example.net', 'sent', datetime('now')) RETURNING id"
		);
		const r1 = await id("INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'a@x.example.net', 'accepted') RETURNING id", camp, a);
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'b@x.example.net', 'accepted')").bind(camp, b).run();
		await db.prepare("INSERT INTO recipients (campaign_id, email, status) VALUES (?, 'bad@x.example.net', 'error')").bind(camp).run();
		// Two opens by the same recipient = one unique open.
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, type) VALUES (?, ?, 'open'), (?, ?, 'open')").bind(camp, r1, camp, r1).run();
		// An old campaign is outside the 7-day window.
		const old = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('o', 'm', 'h', 'f@x.example.net', 'sent', '2020-01-01 00:00:00') RETURNING id"
		);
		await db.prepare("INSERT INTO recipients (campaign_id, email, status) VALUES (?, 'a@x.example.net', 'accepted')").bind(old).run();
		await db.prepare("INSERT INTO replies (from_email) VALUES ('a@x.example.net')").run();
		const auto = await id("INSERT INTO automations (name, status) VALUES ('A', 'active') RETURNING id");
		await db.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status) VALUES (?, ?, 'active')").bind(auto, a).run();

		const t = await loadTiles(db);
		expect(t).toMatchObject({
			subscribers: 3,
			new_subscribed_30d: 2,
			unsubscribes_30d: 1,
			subscriber_delta: 1,
			sent_7d: 2,
			opens_7d: 1,
			open_rate_7d: 50,
			awaiting_reply: 1,
			active_automations: 1,
			active_enrollments: 1
		});
	});
});

describe('dashboard cards (#133)', () => {
	it('upcoming lists scheduled sends and pending resends soonest first', async () => {
		await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, scheduled_at, weekday_only) VALUES
				 ('later', 'm', 'h', 'f', 'scheduled', '2030-01-03 10:00:00', 1),
				 ('sooner', 'm', 'h', 'f', 'scheduled', '2030-01-01 10:00:00', 0)`
			)
			.run();
		await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, resend_status, resend_at) VALUES ('re', 'm', 'h', 'f', 'sent', 'pending', '2030-01-02 10:00:00')")
			.run();
		const up = await upcomingSends(db);
		expect(up.map((u) => [u.subject, u.kind, u.weekday_only])).toEqual([
			['sooner', 'scheduled', 0],
			['re', 'resend', 0],
			['later', 'scheduled', 1]
		]);
	});

	it('recent campaigns skip automation steps and compute rates', async () => {
		const auto = await id("INSERT INTO automations (name) VALUES ('A') RETURNING id");
		const step = await id("INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email) VALUES (?, 0, 's', 'm', 'f@x.example.net') RETURNING id", auto);
		await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id) VALUES ('step', 'm', 'h', 'f', 'sent', ?, ?)")
			.bind(auto, step)
			.run();
		await db.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, recipient_count) VALUES ('none', 'm', 'h', 'f', 'sent', 0)").run();
		const rc = await recentCampaigns(db);
		expect(rc.map((c) => c.subject)).toEqual(['none']);
		expect(rc[0]).toMatchObject({ direct: 1, open_pct: null, click_pct: null });
	});

	it('recent unsubscribes link the contact by email', async () => {
		const c = await id("INSERT INTO contacts (email, subscribed) VALUES ('u@x.example.net', 0) RETURNING id");
		await db.prepare("INSERT INTO unsubscribes (email, reason) VALUES ('u@x.example.net', 'Not relevant')").run();
		const rows = await recentUnsubscribes(db);
		expect(rows[0]).toMatchObject({ email: 'u@x.example.net', contact_id: c, reason: 'Not relevant' });
	});
});

describe('relTime', () => {
	const now = new Date('2026-01-02T00:00:00Z');
	it('formats past and future UTC times', () => {
		expect(relTime('2026-01-01 23:59:30', now)).toBe('just now');
		expect(relTime('2026-01-01 23:55:00', now)).toBe('5m ago');
		expect(relTime('2026-01-01 21:00:00', now)).toBe('3h ago');
		expect(relTime('2025-12-30 00:00:00', now)).toBe('3d ago');
		expect(relTime('2025-10-01 00:00:00', now)).toBe('2025-10-01');
		expect(relTime('2026-01-02 02:00:00', now)).toBe('in 2h');
	});
});

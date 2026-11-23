import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	ENGAGEMENT_DEFAULTS,
	computeEngagement,
	getEngagementConfig,
	setEngagementConfig,
	parseEngagementConfig,
	validateEngagementConfig,
	runEngagementJob,
	snapshotTierCounts
} from '../src/lib/server/engagement';
import {
	bucketHeatmap,
	engagementHeatmap,
	fillTrend,
	goingCold,
	goingColdIds,
	lastDays,
	tierTrend
} from '../src/lib/server/engagement-insights';
import { heatLevel, heatPeak, sparkPoints, trendEnds, signed, monthDay } from '../src/lib/engagement-insights-view';

const db = (env as any).DB as D1Database;
const NOW = new Date('2026-10-06T12:00:00Z');

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM engagement_tier_daily'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key IN ('engagement_config', 'engagement_full_at')")
	]);
});

async function contact(email: string, subscribed = 1): Promise<number> {
	return (await db
		.prepare(`INSERT INTO contacts (email, subscribed, source) VALUES (?, ?, 'test') RETURNING id`)
		.bind(email, subscribed)
		.first<{ id: number }>())!.id;
}

describe('engagement config (tunable, #116)', () => {
	it('validates ranges and the hot > warm > cool order; blank = default', () => {
		expect(validateEngagementConfig({})).toEqual({ ok: true, cfg: ENGAGEMENT_DEFAULTS });
		const v = validateEngagementConfig({ wClick: '4', halfLifeDays: '30', hot: '70' });
		expect(v.ok && v.cfg.wClick).toBe(4);
		expect(v.ok && v.cfg.halfLifeDays).toBe(30);
		expect(v.ok && v.cfg.tiers).toEqual({ hot: 70, warm: 30, cool: 10 });
		expect(validateEngagementConfig({ wOpen: '-1' }).ok).toBe(false);
		expect(validateEngagementConfig({ halfLifeDays: '0' }).ok).toBe(false);
		expect(validateEngagementConfig({ wReply: 'lots' }).ok).toBe(false);
		expect(validateEngagementConfig({ warm: '80' }).ok).toBe(false); // warm above hot
	});

	it('bad stored JSON falls back to the defaults', () => {
		expect(parseEngagementConfig('not json')).toBe(ENGAGEMENT_DEFAULTS);
		expect(parseEngagementConfig(JSON.stringify({ hot: 5, warm: 50 }))).toBe(ENGAGEMENT_DEFAULTS);
		expect(parseEngagementConfig(null)).toBe(ENGAGEMENT_DEFAULTS);
	});

	it('save marks everyone dirty, compute uses the new thresholds, reset restores defaults', async () => {
		const id = await contact('cfg@test.example.net');
		const cp = await campaign('2026-10-01 09:00:00');
		await recipient(cp, id, 'cfg@test.example.net');
		await event(id, cp, 'click', '2026-10-06 12:00:00', {});

		await computeEngagement(db, { now: NOW });
		expect((await row(id)).tier).toBe('warm'); // 1 fresh click ≈ 53

		const v = validateEngagementConfig({ hot: '50' });
		if (!v.ok) throw new Error(v.error);
		await setEngagementConfig(db, v.cfg);
		expect((await getEngagementConfig(db)).tiers.hot).toBe(50);
		expect((await row(id)).dirty).toBe(1);

		await computeEngagement(db, { now: NOW });
		const r = await row(id);
		expect(r.tier).toBe('hot');
		expect(r.prev_tier).toBe('warm');
		expect(r.tier_changed_at).toBe(NOW.toISOString());

		await setEngagementConfig(db, null);
		expect(await getEngagementConfig(db)).toEqual(ENGAGEMENT_DEFAULTS);
	});
});

async function campaign(sentAt: string): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES ('insights', 'body', '<p>body</p>', 'a@b.example.net', 'sent', ?) RETURNING id`
		)
		.bind(sentAt)
		.first<{ id: number }>())!.id;
}

async function recipient(campaignId: number, contactId: number, email: string): Promise<void> {
	await db
		.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted')`)
		.bind(campaignId, contactId, email)
		.run();
}

async function event(contactId: number, campaignId: number, type: string, at: string, detail: unknown): Promise<void> {
	const d = typeof detail === 'string' ? detail : detail == null ? null : JSON.stringify(detail);
	await db
		.prepare(`INSERT INTO events (campaign_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(campaignId, contactId, type, d, at)
		.run();
}

type Row = { tier: string; prev_tier: string | null; tier_changed_at: string | null; dirty: number };
async function row(id: number): Promise<Row> {
	return (await db
		.prepare(`SELECT tier, prev_tier, tier_changed_at, dirty FROM contact_engagement WHERE contact_id = ?`)
		.bind(id)
		.first<Row>())!;
}

describe('going cold (#116)', () => {
	it('lists subscribed contacts that moved down into cool/cold in the last 30 days', async () => {
		const cooling = await contact('cooling@test.example.net');
		const unsub = await contact('unsub@test.example.net');
		const cp = await campaign('2026-10-01 09:00:00');
		await recipient(cp, cooling, 'cooling@test.example.net');
		await event(cooling, cp, 'click', '2026-10-06 12:00:00', {});
		await recipient(cp, unsub, 'unsub@test.example.net');
		await event(unsub, cp, 'click', '2026-10-06 12:00:00', {});
		await computeEngagement(db, { now: NOW });
		expect((await row(cooling)).tier).toBe('warm');
		await db.prepare(`UPDATE contacts SET subscribed = 0 WHERE id = ?`).bind(unsub).run();

		// 120 days on, the click has decayed two half-lives → cool.
		const later = new Date(NOW.getTime() + 120 * 86_400_000);
		await computeEngagement(db, { contactIds: [cooling, unsub], now: later });
		expect((await row(cooling)).tier).toBe('cool');
		expect((await row(cooling)).prev_tier).toBe('warm');

		// Never engaged (new → cold) and an old drop (40 days ago) don't count.
		const fresh = await contact('fresh@test.example.net');
		const old = await contact('old@test.example.net');
		const ins = `INSERT INTO contact_engagement (contact_id, tier, prev_tier, tier_changed_at, dirty) VALUES (?, 'cold', ?, ?, 0)`;
		await db.batch([
			db.prepare(ins).bind(fresh, 'new', later.toISOString()),
			db.prepare(ins).bind(old, 'hot', new Date(later.getTime() - 40 * 86_400_000).toISOString())
		]);

		const res = await goingCold(db, { now: later });
		expect(res.total).toBe(1);
		expect(res.contacts.map((c) => c.email)).toEqual(['cooling@test.example.net']);
		expect(res.contacts[0]).toMatchObject({ prev_tier: 'warm', tier: 'cool' });
		expect(await goingColdIds(db, later)).toEqual([cooling]);

		// Recomputing at the same tier doesn't move tier_changed_at.
		const stamped = (await row(cooling)).tier_changed_at;
		await computeEngagement(db, { contactIds: [cooling], now: new Date(later.getTime() + 60_000) });
		expect((await row(cooling)).tier_changed_at).toBe(stamped);
	});
});

describe('tier snapshots + trend (#116)', () => {
	it('the heartbeat writes one snapshot per UTC day once the backlog is drained', async () => {
		await contact('a@test.example.net');
		await contact('b@test.example.net');
		const first = await runEngagementJob(db, NOW);
		expect(first.remaining).toBe(0);
		expect(first.snapshot).toBe(true);
		const again = await runEngagementJob(db, new Date(NOW.getTime() + 60_000));
		expect(again.snapshot).toBe(false);

		const rows = await db.prepare(`SELECT day, tier, n FROM engagement_tier_daily`).all<{ day: string; tier: string; n: number }>();
		expect(rows.results).toEqual([{ day: '2026-10-06', tier: 'new', n: 2 }]);

		const trend = await tierTrend(db, NOW);
		expect(trend.days).toHaveLength(90);
		expect(trend.days[89]).toBe('2026-10-06');
		expect(trend.snapshots).toBe(1);
		expect(trend.series.new[89]).toBe(2);
		expect(trend.series.hot[89]).toBe(0);
		expect(trend.series.new[88]).toBeNull();
	});

	it('prunes snapshots older than ~400 days', async () => {
		await db.prepare(`INSERT INTO engagement_tier_daily (day, tier, n) VALUES ('2024-01-01', 'hot', 1)`).run();
		expect(await snapshotTierCounts(db, NOW)).toBe(true);
		const old = await db.prepare(`SELECT COUNT(*) AS n FROM engagement_tier_daily WHERE day = '2024-01-01'`).first<{ n: number }>();
		expect(old!.n).toBe(0);
	});

	it('fillTrend / lastDays are dense and oldest-first', () => {
		const days = lastDays(new Date('2026-03-01T05:00:00Z'), 3);
		expect(days).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
		const t = fillTrend(days, [{ day: '2026-02-28', tier: 'warm', n: 4 }]);
		expect(t.series.warm).toEqual([null, 4, null]);
		expect(t.series.hot).toEqual([null, 0, null]);
		expect(t.snapshots).toBe(1);
	});
});

describe('day × hour heatmap (#116)', () => {
	const base = { ua: null, client_name: null, client_family: null, first_open: null, delivered_at: null };

	it('buckets real opens/clicks in the operator timezone and skips proxy opens', () => {
		const r = bucketHeatmap(
			[
				// 16:00 UTC Tue = 9am Tue in Los Angeles (PDT)
				{ ...base, type: 'open', recorded_at: '2026-10-06 16:00:00', client_name: 'Gmail' },
				{ ...base, type: 'click', recorded_at: '2026-10-06 16:30:00' },
				// Apple Mail → proxy
				{ ...base, type: 'open', recorded_at: '2026-10-06 16:00:00', client_name: 'Apple Mail' },
				// first open 10s after delivery → proxy
				{ ...base, type: 'open', recorded_at: '2026-10-06 16:00:10', first_open: 1, delivered_at: '2026-10-06 16:00:00' },
				// 03:00 UTC Wed = 8pm Tue in LA
				{ ...base, type: 'click', recorded_at: '2026-10-07 03:00:00' }
			],
			'America/Los_Angeles'
		);
		expect(r.total).toBe(3);
		expect(r.proxySkipped).toBe(2);
		expect(r.grid[2][9]).toBe(2);
		expect(r.grid[2][20]).toBe(1);
		expect(heatPeak(r.grid)).toEqual({ dow: 2, hour: 9, n: 2 });
	});

	it('reads the last 90 days from D1, tolerating malformed detail JSON', async () => {
		const id = await contact('heat@test.example.net');
		const other = await contact('heat2@test.example.net');
		const cp = await campaign('2026-09-01 09:00:00');
		// #457: a broadcast (has a list); a direct / review send (no list, no automation) is left out.
		const list = (await db.prepare(`INSERT INTO lists (name, kind) VALUES ('Heat', 'list') RETURNING id`).first<{ id: number }>())!.id;
		await db.prepare(`UPDATE campaigns SET list_id = ? WHERE id = ?`).bind(list, cp).run();
		const direct = await campaign('2026-09-01 09:00:00');
		await event(id, cp, 'delivery', '2026-10-05 10:00:00', null);
		await event(id, cp, 'open', '2026-10-05 10:00:05', { FirstOpen: true, Client: { Name: 'Gmail' } }); // fast first open → proxy
		await event(id, cp, 'open', '2026-10-05 15:00:00', 'not json');
		await event(id, cp, 'click', '2026-10-05 15:05:00', { OriginalLink: 'https://x.test' });
		await event(id, cp, 'open', '2026-06-01 15:00:00', {}); // > 90 days ago
		await event(other, direct, 'open', '2026-10-05 15:10:00', {});
		const h = await engagementHeatmap(db, 'UTC', NOW);
		// #457: people, not events: the open and the click at Monday 15:00 are one person.
		expect(h.total).toBe(1);
		expect(h.proxySkipped).toBe(1);
		expect(h.grid[1][15]).toBe(1); // Monday 15:00 UTC
		expect(h.truncated).toBe(false);
	});
});

describe('insight view helpers (#116)', () => {
	it('heatLevel scales 1–4 against the max, 0 for empty', () => {
		expect(heatLevel(0, 10)).toBe(0);
		expect(heatLevel(1, 10)).toBe(1);
		expect(heatLevel(5, 10)).toBe(2);
		expect(heatLevel(10, 10)).toBe(4);
	});

	it('sparkPoints skips nulls but keeps their x position', () => {
		expect(sparkPoints([null, 1], 10, 10)).toBe('');
		expect(sparkPoints([0, null, 2], 10, 10)).toBe('0,10 10,0');
	});

	it('trendEnds / signed / monthDay', () => {
		expect(trendEnds([null, 3, null, 5, null])).toEqual({ first: 3, last: 5, firstIdx: 1 });
		expect(trendEnds([null, null])).toBeNull();
		expect(signed(2)).toBe('+2');
		expect(signed(-2)).toBe('−2');
		expect(signed(0)).toBe('±0');
		expect(monthDay('2026-07-08')).toBe('Jul 8');
	});
});

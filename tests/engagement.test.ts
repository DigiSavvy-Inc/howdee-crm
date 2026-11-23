import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	ENGAGEMENT_DEFAULTS,
	classifyProxyOpen,
	scoreFromEvents,
	normalizeScore,
	tierFor,
	histograms,
	peak,
	inferTz,
	computeEngagement,
	markDirty,
	engagementStatus,
	runEngagementJob
} from '../src/lib/server/engagement';

const db = (env as any).DB as D1Database;
const cfg = ENGAGEMENT_DEFAULTS;

// ---------------------------------------------------------------------------
// classifyProxyOpen
// ---------------------------------------------------------------------------

describe('classifyProxyOpen', () => {
	it('Apple Mail UA -> true', () => {
		const detail = {
			UserAgent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Mail/3826',
			FirstOpen: false
		};
		expect(classifyProxyOpen(detail)).toBe(true);
	});

	it('Gmail web client -> false', () => {
		const detail = {
			UserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0 Safari/537.36',
			Client: { Name: 'Gmail', Family: 'Gmail' },
			FirstOpen: false
		};
		expect(classifyProxyOpen(detail)).toBe(false);
	});

	it('FirstOpen 20s after delivery -> true', () => {
		const detail = { FirstOpen: true, UserAgent: 'SomeClient/1.0', Client: { Name: 'Outlook' } };
		expect(classifyProxyOpen(detail, '2026-01-01 10:00:00', '2026-01-01 10:00:20')).toBe(true);
	});

	it('FirstOpen 2h after delivery -> false', () => {
		const detail = { FirstOpen: true, UserAgent: 'SomeClient/1.0', Client: { Name: 'Outlook' } };
		expect(classifyProxyOpen(detail, '2026-01-01 10:00:00', '2026-01-01 12:00:00')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// scoreFromEvents / normalizeScore
// ---------------------------------------------------------------------------

describe('scoreFromEvents / normalizeScore', () => {
	const now = new Date('2026-09-23T00:00:00Z');

	it('one click today ~= 53', () => {
		const raw = scoreFromEvents([{ type: 'click', at: now.toISOString() }], now, cfg);
		const score = normalizeScore(raw, cfg);
		expect(score).toBeGreaterThan(52);
		expect(score).toBeLessThan(54);
	});

	it('one fresh open ~= 22', () => {
		const raw = scoreFromEvents([{ type: 'open', at: now.toISOString() }], now, cfg);
		const score = normalizeScore(raw, cfg);
		expect(score).toBeGreaterThan(21);
		expect(score).toBeLessThan(23);
	});

	it('one open 60 days ago -> half weight (raw)', () => {
		const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000).toISOString();
		const raw = scoreFromEvents([{ type: 'open', at: sixtyDaysAgo }], now, cfg);
		expect(raw).toBeCloseTo(cfg.wOpen * 0.5, 2);
	});

	it('3 fresh clicks + 1 reply ~= 97', () => {
		const events = [
			{ type: 'click' as const, at: now.toISOString() },
			{ type: 'click' as const, at: now.toISOString() },
			{ type: 'click' as const, at: now.toISOString() },
			{ type: 'reply' as const, at: now.toISOString() }
		];
		const raw = scoreFromEvents(events, now, cfg);
		const score = normalizeScore(raw, cfg);
		expect(score).toBeGreaterThan(96);
		expect(score).toBeLessThan(98);
	});

	it('empty -> 0', () => {
		expect(scoreFromEvents([], now, cfg)).toBe(0);
		expect(normalizeScore(0, cfg)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// tierFor
// ---------------------------------------------------------------------------

describe('tierFor', () => {
	it('sent 0 -> new', () => {
		expect(tierFor(0, { sentCount: 0, firstSentAt: null, lastEngagedAt: null }, cfg)).toBe('new');
	});

	it('sent 5, no engagement -> never', () => {
		expect(
			tierFor(0, { sentCount: 5, firstSentAt: '2026-01-01 00:00:00', lastEngagedAt: null }, cfg)
		).toBe('never');
	});

	it('score 70 -> hot', () => {
		expect(
			tierFor(70, { sentCount: 5, firstSentAt: '2026-01-01 00:00:00', lastEngagedAt: '2026-02-01 00:00:00' }, cfg)
		).toBe('hot');
	});

	it('score 35 -> warm', () => {
		expect(
			tierFor(35, { sentCount: 5, firstSentAt: '2026-01-01 00:00:00', lastEngagedAt: '2026-02-01 00:00:00' }, cfg)
		).toBe('warm');
	});

	it('score 15 -> cool', () => {
		expect(
			tierFor(15, { sentCount: 5, firstSentAt: '2026-01-01 00:00:00', lastEngagedAt: '2026-02-01 00:00:00' }, cfg)
		).toBe('cool');
	});

	it('score 5 with some engagement -> cold', () => {
		expect(
			tierFor(5, { sentCount: 5, firstSentAt: '2026-01-01 00:00:00', lastEngagedAt: '2026-02-01 00:00:00' }, cfg)
		).toBe('cold');
	});
});

// ---------------------------------------------------------------------------
// histograms / peak
// ---------------------------------------------------------------------------

describe('histograms / peak', () => {
	// All three dates below are Tuesdays (UTC).
	const tuesdays14h = ['2026-09-01T14:15:00Z', '2026-09-15T14:45:00Z', '2026-09-22T14:05:00Z'];

	it('3 opens at 14:xx UTC on Tuesdays -> best_hour 14, best_dow 2', () => {
		const { hour, dow } = histograms(tuesdays14h);
		expect(peak(hour)).toBe(14);
		expect(peak(dow)).toBe(2);
	});

	it('2 events -> null (min 3)', () => {
		const { hour, dow } = histograms(tuesdays14h.slice(0, 2));
		expect(peak(hour)).toBeNull();
		expect(peak(dow)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// inferTz
// ---------------------------------------------------------------------------

describe('inferTz', () => {
	it('US/CA -> -8, high-ish confidence', () => {
		const { offset, confidence } = inferTz('US', 'CA');
		expect(offset).toBe(-8);
		expect(confidence).toBeGreaterThanOrEqual(0.7);
	});

	it('GB -> 0', () => {
		const { offset } = inferTz('GB', null);
		expect(offset).toBe(0);
	});

	it('unknown -> null, low confidence', () => {
		const { offset, confidence } = inferTz('ZZ', null);
		expect(offset).toBeNull();
		expect(confidence).toBeLessThanOrEqual(0.2);
	});
});

// ---------------------------------------------------------------------------
// D1 round-trip
// ---------------------------------------------------------------------------

type ContactRow = { id: number };
type EngagementRow = {
	contact_id: number;
	sent_count: number;
	delivered_count: number;
	open_count: number;
	proxy_open_count: number;
	unique_open_campaigns: number;
	click_count: number;
	unique_click_campaigns: number;
	reply_count: number;
	open_rate: number | null;
	click_rate: number | null;
	best_hour_utc: number | null;
	best_dow: number | null;
	tz_offset_guess: number | null;
	tz_confidence: number | null;
	top_client: string | null;
	top_platform: string | null;
	top_country: string | null;
	score: number;
	tier: string;
	dirty: number;
	computed_at: string | null;
};

async function insertCampaign(subject: string, sentAt: string): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES (?, 'body', '<p>body</p>', 'a@b.example.net', 'sent', ?) RETURNING id`
		)
		.bind(subject, sentAt)
		.first<{ id: number }>();
	return row!.id;
}

async function insertRecipient(campaignId: number, contactId: number, email: string): Promise<void> {
	await db
		.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted')`)
		.bind(campaignId, contactId, email)
		.run();
}

async function insertEvent(
	contactId: number,
	campaignId: number,
	type: string,
	recordedAt: string,
	detail: Record<string, unknown> | null
): Promise<void> {
	await db
		.prepare(`INSERT INTO events (campaign_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(campaignId, contactId, type, detail ? JSON.stringify(detail) : null, recordedAt)
		.run();
}

const NOW = new Date('2026-09-23T00:00:00Z');

async function cleanup(): Promise<void> {
	await db.batch([
		db.prepare(`DELETE FROM contact_engagement`),
		db.prepare(`DELETE FROM replies WHERE from_email LIKE '%@test.example.net'`),
		db.prepare(`DELETE FROM events WHERE contact_id IN (SELECT id FROM contacts WHERE email LIKE '%@test.example.net')`),
		db.prepare(`DELETE FROM recipients WHERE contact_id IN (SELECT id FROM contacts WHERE email LIKE '%@test.example.net')`),
		db.prepare(`DELETE FROM campaigns WHERE subject LIKE 'engagement-test%'`),
		db.prepare(`DELETE FROM contacts WHERE email LIKE '%@test.example.net'`),
		db.prepare(`DELETE FROM app_state WHERE key = 'engagement_full_at'`)
	]);
}

beforeEach(cleanup);

describe('computeEngagement (D1 round-trip)', () => {
	it('rolls up counts, proxy detection, rates, best hour, and tier ordering', async () => {
		const engaged = await db
			.prepare(`INSERT INTO contacts (email, subscribed, source) VALUES ('engaged@test.example.net', 1, 'test') RETURNING id`)
			.first<ContactRow>();
		const quiet = await db
			.prepare(`INSERT INTO contacts (email, subscribed, source) VALUES ('quiet@test.example.net', 1, 'test') RETURNING id`)
			.first<ContactRow>();
		const engagedId = engaged!.id;
		const quietId = quiet!.id;

		const camp1 = await insertCampaign('engagement-test-1', '2026-09-20 09:00:00');
		const camp2 = await insertCampaign('engagement-test-2', '2026-09-21 09:00:00');
		const camp3 = await insertCampaign('engagement-test-3', '2026-09-22 09:00:00');

		for (const campaignId of [camp1, camp2, camp3]) {
			await insertRecipient(campaignId, engagedId, 'engaged@test.example.net');
			await insertRecipient(campaignId, quietId, 'quiet@test.example.net');
			await insertEvent(quietId, campaignId, 'delivery', '2026-09-20 09:00:01', null);
		}

		// engaged@test.example.net: a real (Gmail) open on camp1, a proxy (Apple Mail) open also on
		// camp1, a click on camp2, a real open on camp3, and a reply. The three real
		// open/click events all land at 14:xx UTC on a Tuesday (2026-09-22).
		const gmail = { Client: { Name: 'Gmail', Family: 'Gmail' }, Platform: 'WebMail', Geo: { Country: 'United States', CountryISOCode: 'US', Region: 'CA' } };
		const appleMail = {
			UserAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) Mobile/15E148 Mail/3826',
			FirstOpen: true,
			Client: { Name: 'Apple Mail', Family: 'Apple Mail' },
			Platform: 'Mobile',
			Geo: { Country: 'United States', CountryISOCode: 'US', Region: 'CA' }
		};

		await insertEvent(engagedId, camp1, 'delivery', '2026-09-20 09:00:00', null);
		await insertEvent(engagedId, camp1, 'open', '2026-09-22 14:05:00', { RecordType: 'Open', FirstOpen: false, ...gmail });
		await insertEvent(engagedId, camp1, 'open', '2026-09-20 09:00:05', { RecordType: 'Open', ...appleMail });
		await insertEvent(engagedId, camp2, 'delivery', '2026-09-21 09:00:00', null);
		await insertEvent(engagedId, camp2, 'click', '2026-09-22 14:10:00', { RecordType: 'Click', OriginalLink: 'https://x.test', ...gmail });
		await insertEvent(engagedId, camp3, 'delivery', '2026-09-22 09:00:00', null);
		await insertEvent(engagedId, camp3, 'open', '2026-09-22 14:20:00', { RecordType: 'Open', FirstOpen: false, ...gmail });
		await db
			.prepare(`INSERT INTO replies (contact_id, from_email, text, received_at) VALUES (?, 'engaged@test.example.net', 'thanks!', ?)`)
			.bind(engagedId, '2026-09-22 15:00:00')
			.run();

		const { computed, remaining } = await computeEngagement(db, { contactIds: [engagedId, quietId], now: NOW });
		expect(computed).toBe(2);
		expect(remaining).toBe(0);

		const rows = await db
			.prepare(`SELECT * FROM contact_engagement WHERE contact_id IN (?, ?)`)
			.bind(engagedId, quietId)
			.all<EngagementRow>();
		const engagedRow = rows.results.find((r) => r.contact_id === engagedId)!;
		const quietRow = rows.results.find((r) => r.contact_id === quietId)!;

		// Counts.
		expect(engagedRow.sent_count).toBe(3);
		expect(engagedRow.delivered_count).toBe(3);
		expect(engagedRow.open_count).toBe(3); // 2 real + 1 proxy
		expect(engagedRow.proxy_open_count).toBe(1);
		expect(engagedRow.unique_open_campaigns).toBe(2); // camp1, camp3
		expect(engagedRow.click_count).toBe(1);
		expect(engagedRow.unique_click_campaigns).toBe(1);
		expect(engagedRow.reply_count).toBe(1);

		// Rates: unique campaigns engaged / sent_count.
		expect(engagedRow.open_rate).toBeCloseTo(2 / 3, 4);
		expect(engagedRow.click_rate).toBeCloseTo(1 / 3, 4);

		// Best hour/day from the 3 non-proxy open/click events (all Tue 14:xx UTC).
		expect(engagedRow.best_hour_utc).toBe(14);
		expect(engagedRow.best_dow).toBe(2);

		// Geo-derived tz guess (US/CA).
		expect(engagedRow.tz_offset_guess).toBe(-8);
		expect(engagedRow.tz_confidence).toBeCloseTo(0.8, 4);

		// Top client/platform dominated by the 3 real Gmail/WebMail events.
		expect(engagedRow.top_client).toBe('Gmail');
		expect(engagedRow.top_platform).toBe('WebMail');
		expect(engagedRow.top_country).toBe('US');

		// Tier ordering: a genuinely engaged contact clearly outscores a sent-but-silent one.
		expect(quietRow.sent_count).toBe(3);
		expect(quietRow.open_count).toBe(0);
		expect(quietRow.tier).toBe('never');
		expect(quietRow.score).toBe(0);
		expect(engagedRow.score).toBeGreaterThan(quietRow.score);
		expect(['hot', 'warm']).toContain(engagedRow.tier);

		// Both rows are clean after compute.
		expect(engagedRow.dirty).toBe(0);
		expect(quietRow.dirty).toBe(0);
		expect(engagedRow.computed_at).toBeTruthy();
	});

	it('markDirty flags a row for recompute; computeEngagement clears it again', async () => {
		const c = await db
			.prepare(`INSERT INTO contacts (email, subscribed, source) VALUES ('dirty@test.example.net', 1, 'test') RETURNING id`)
			.first<ContactRow>();
		const contactId = c!.id;

		await computeEngagement(db, { contactIds: [contactId], now: NOW });
		let row = await db
			.prepare(`SELECT dirty FROM contact_engagement WHERE contact_id = ?`)
			.bind(contactId)
			.first<{ dirty: number }>();
		expect(row?.dirty).toBe(0);

		await markDirty(db, [contactId]);
		row = await db.prepare(`SELECT dirty FROM contact_engagement WHERE contact_id = ?`).bind(contactId).first<{ dirty: number }>();
		expect(row?.dirty).toBe(1);

		const { computed } = await computeEngagement(db, { contactIds: [contactId], now: NOW });
		expect(computed).toBe(1);
		row = await db.prepare(`SELECT dirty FROM contact_engagement WHERE contact_id = ?`).bind(contactId).first<{ dirty: number }>();
		expect(row?.dirty).toBe(0);
	});
});

describe('runEngagementJob + engagementStatus', () => {
	it('sets engagement_full_at on first run and does not redo the full mark within 24h', async () => {
		const c = await db
			.prepare(`INSERT INTO contacts (email, subscribed, source) VALUES ('job@test.example.net', 1, 'test') RETURNING id`)
			.first<ContactRow>();
		const contactId = c!.id;

		const first = await runEngagementJob(db, NOW);
		expect(first.full).toBe(true);
		expect(first.computed).toBeGreaterThanOrEqual(1);

		const stateAfterFirst = await db
			.prepare(`SELECT value FROM app_state WHERE key = 'engagement_full_at'`)
			.first<{ value: string }>();
		expect(stateAfterFirst?.value).toBe(NOW.toISOString());

		// A later run, same day (well within 24h) -> no re-mark.
		const soonAfter = new Date(NOW.getTime() + 5 * 60 * 1000);
		const second = await runEngagementJob(db, soonAfter);
		expect(second.full).toBe(false);

		// A run >24h later -> full mark again.
		const muchLater = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
		const third = await runEngagementJob(db, muchLater);
		expect(third.full).toBe(true);

		const status = await engagementStatus(db);
		expect(status.total).toBeGreaterThanOrEqual(1);
		expect(status.dirty).toBe(0);
		expect(status.tiers[(await db.prepare(`SELECT tier FROM contact_engagement WHERE contact_id = ?`).bind(contactId).first<{ tier: string }>())!.tier]).toBeGreaterThanOrEqual(1);
	});
});

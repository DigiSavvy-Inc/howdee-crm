// #564: company dashboard data layer — tiles, engaged / last-touch rules, weekly series,
// billing visibility, empty company, timezone buckets, and the "Last activity" fix.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { loadCompanyDashboard } from '../src/lib/server/company-dashboard';
import { getCompany } from '../src/lib/server/company-read';
import { engagementBuckets, fillEngagement, isGoingQuiet, newestOf, visibleTiles } from '../src/lib/company-dashboard';

const db = (env as any).DB as D1Database;
const NOW = new Date('2026-11-16T18:00:00Z');
const TZ = 'America/Los_Angeles';

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM conversation_state'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

const company = (name: string) => id(`INSERT INTO companies (name) VALUES (?) RETURNING id`, name);
const contact = (email: string, companyId: number, opts: { archived?: boolean; subscribed?: number } = {}) =>
	id(
		`INSERT INTO contacts (email, company_id, subscribed, archived_at) VALUES (?, ?, ?, ?) RETURNING id`,
		email,
		companyId,
		opts.subscribed ?? 1,
		opts.archived ? '2026-01-01 00:00:00' : null
	);
async function event(contactId: number, type: string, at: string, detail: object = {}) {
	await db
		.prepare('INSERT INTO events (contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?)')
		.bind(contactId, type, JSON.stringify(detail), at)
		.run();
}

const APPLE = { UserAgent: 'Mozilla/5.0 (Macintosh) Apple Mail (16.0)' };

describe('loadCompanyDashboard (#564)', () => {
	it('an empty company shows only the Contacts tile', async () => {
		const co = await company('Empty');
		const d = await loadCompanyDashboard(db, co, { billing: true, now: NOW, tz: TZ });
		expect(d.tiles).toEqual(['contacts']);
		expect(d.contacts).toEqual({ total: 0, subscribed: 0 });
		expect(d.engaged30d).toBe(0);
		expect(d.lastTouchAt).toBeNull();
		expect(d.billing).toBeNull();
		expect(d.goingQuiet).toBe(false);
		expect(d.series.length).toBeGreaterThan(12);
		expect(d.series.every((p) => p.opens + p.clicks + p.replies + p.visits === 0)).toBe(true);
		expect(d.tiers.new).toBe(0);
	});

	it('counts human engagement only: proxy opens, deliveries and scanner clicks are left out', async () => {
		const co = await company('Acme');
		const human = await contact('human@acme.test', co);
		const proxy = await contact('proxy@acme.test', co);
		const scanned = await contact('scanned@acme.test', co, { subscribed: 0 });
		const replier = await contact('replier@acme.test', co);
		await event(human, 'open', '2026-11-10 09:00:00', { UserAgent: 'Mozilla/5.0 Thunderbird' });
		await event(proxy, 'open', '2026-11-12 09:00:00', APPLE);
		await event(proxy, 'delivery', '2026-11-15 09:00:00');
		await event(scanned, 'scanner_click', '2026-11-15 10:00:00', { OriginalLink: 'https://x.test' });
		await db.prepare('INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, ?, ?, ?, ?)')
			.bind(replier, 'replier@acme.test', 'Re: hi', 'Thanks', '2026-11-11 08:00:00').run();

		const d = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		expect(d.contacts).toEqual({ total: 4, subscribed: 3 });
		expect(d.engaged30d).toBe(2); // human + replier
		expect(d.lastTouchAt).toBe('2026-11-11 08:00:00'); // not the delivery / scanner click / proxy open
		const total = d.series.reduce((a, p) => ({ opens: a.opens + p.opens, clicks: a.clicks + p.clicks, replies: a.replies + p.replies }), { opens: 0, clicks: 0, replies: 0 });
		expect(total).toEqual({ opens: 1, clicks: 0, replies: 1 });
		expect(d.tiles).toEqual(['contacts', 'engaged', 'last_touch', 'awaiting']);

		// "Last activity" on the company row ignores deliveries and scanner clicks too.
		expect((await getCompany(db, co))!.last_activity_at).toBe('2026-11-12 09:00:00');
	});

	it('leaves archived contacts out of every figure', async () => {
		const co = await company('Arch');
		const live = await contact('live@arch.test', co);
		const gone = await contact('gone@arch.test', co, { archived: true });
		await event(gone, 'click', '2026-11-14 09:00:00');
		await db.prepare(`INSERT INTO contact_engagement (contact_id, score, tier) VALUES (?, 80, 'hot'), (?, 40, 'warm')`).bind(gone, live).run();
		const stage = (await db.prepare(`SELECT id FROM pipeline_stages WHERE kind = 'open' ORDER BY position LIMIT 1`).first<{ id: number }>())!.id;
		await db.prepare(`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 5000, datetime('now'))`).bind(gone, stage).run();

		const d = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		expect(d.contacts.total).toBe(1);
		expect(d.engaged30d).toBe(0);
		expect(d.lastTouchAt).toBeNull();
		expect(d.topContacts.map((c) => c.id)).toEqual([live]);
		expect(d.openDeals).toEqual([]);
		expect(d.tiles).not.toContain('deals');
		expect(d.tiers.hot).toBe(0);
		expect(d.tiers.warm).toBe(1);
	});

	it('shows deals, hours and issues when their sources exist; billing only with access', async () => {
		const co = await company('Full');
		const c = await contact('a@full.test', co);
		const stage = (await db.prepare(`SELECT id FROM pipeline_stages WHERE kind = 'open' ORDER BY position LIMIT 1`).first<{ id: number }>())!.id;
		await db.prepare(`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 1200, datetime('now'))`).bind(c, stage).run();
		await db
			.prepare(
				`INSERT INTO company_metrics (company_id, hours_30d, hours_90d, last_tracked_at, timing_synced_at, issues_open, github_synced_at,
				   ar_outstanding, ar_overdue, billing_currency, zoho_synced_at)
				 VALUES (?, 0, 12, '2026-09-01T10:00:00Z', '2026-11-16 00:00:00', 3, '2026-11-16 00:00:00', 900, 300, 'USD', '2026-11-16 00:00:00')`
			)
			.bind(co)
			.run();

		const admin = await loadCompanyDashboard(db, co, { billing: true, now: NOW, tz: TZ });
		expect(admin.tiles).toEqual(['contacts', 'engaged', 'last_touch', 'awaiting', 'deals', 'hours', 'issues', 'outstanding', 'overdue']);
		expect(admin.deals).toEqual({ open: 1, value: 1200 });
		expect(admin.issuesOpen).toBe(3);
		expect(admin.billing).toEqual({ outstanding: 900, overdue: 300, currency: 'USD' });
		expect(admin.goingQuiet).toBe(true); // 12 h in 90 d, none in 30, last touch Sep 1

		const member = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		expect(member.billing).toBeNull();
		expect(member.tiles).not.toContain('outstanding');
		expect(member.tiles).not.toContain('overdue');
		expect(JSON.stringify(member)).not.toContain('900');
		expect(member.deals.value).toBe(1200); // deal value stays visible, like the pipeline board
		expect(member.hours).toEqual({ hours_30d: 0, hours_90d: 12 });

		// A recent touch ends "going quiet".
		await event(c, 'click', '2026-11-15 09:00:00');
		expect((await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ })).goingQuiet).toBe(false);
	});

	it('buckets the series by local week in the account timezone', async () => {
		const co = await company('TZ');
		const c = await contact('tz@tz.test', co);
		// Monday 2026-11-16 03:00 UTC = Sunday 2026-11-15 19:00 in Los Angeles → the week of Nov 9.
		await event(c, 'click', '2026-11-16 03:00:00');
		const la = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		expect(la.series.find((p) => p.clicks)!.start).toBe('2026-11-09');
		const utc = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: 'UTC' });
		expect(utc.series.find((p) => p.clicks)!.start).toBe('2026-11-16');
	});
});

describe('company dashboard helpers (#564)', () => {
	it('fills weekly buckets and drops unknown kinds / days outside the range', () => {
		const buckets = engagementBuckets(NOW, 0);
		expect(buckets[buckets.length - 1].start).toBe('2026-11-16');
		const pts = fillEngagement(buckets, [
			{ d: '2026-11-17', kind: 'opens', n: 2 },
			{ d: '2026-11-18', kind: 'opens', n: 1 },
			{ d: '2026-11-18', kind: 'delivery', n: 9 },
			{ d: '2020-01-01', kind: 'clicks', n: 5 }
		]);
		expect(pts[pts.length - 1].opens).toBe(3);
		expect(pts.reduce((a, p) => a + p.clicks, 0)).toBe(0);
	});

	it('picks tiles by source and computes the quiet rule', () => {
		const none = { contacts: false, pipeline: false, timing: false, github: false, billing: false };
		expect(visibleTiles(none, false)).toEqual(['contacts']);
		expect(visibleTiles({ ...none, billing: true }, true)).toEqual(['contacts', 'last_touch', 'outstanding', 'overdue']);
		expect(newestOf('2026-11-01 10:00:00', '2026-11-01T11:00:00Z', null)).toBe('2026-11-01T11:00:00Z');
		expect(isGoingQuiet({ hours_90d: 5, hours_30d: 0, last_touch_at: null }, NOW)).toBe(true);
		expect(isGoingQuiet({ hours_90d: 5, hours_30d: 1, last_touch_at: null }, NOW)).toBe(false);
		expect(isGoingQuiet({ hours_90d: 0, hours_30d: 0, last_touch_at: null }, NOW)).toBe(false);
		expect(isGoingQuiet({ hours_90d: 5, hours_30d: 0, last_touch_at: '2026-11-10 00:00:00' }, NOW)).toBe(false);
	});
});

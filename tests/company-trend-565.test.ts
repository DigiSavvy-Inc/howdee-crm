// #565: company dashboard 2/4 — the weekly engagement trend (delivered + touches) and the top
// engaged contacts (ordering, Lead score, last activity), plus the trend chart's pure math.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { loadCompanyDashboard } from '../src/lib/server/company-dashboard';
import { ENGAGEMENT_SERIES, engagementBuckets, fillEngagement } from '../src/lib/company-dashboard';
import { trendEmpty, trendLine, trendPeak, trendPointText, trendTotals, trendX, type TrendPoint } from '../src/lib/trend-chart';

const db = (env as any).DB as D1Database;
const NOW = new Date('2026-11-16T18:00:00Z');
const TZ = 'UTC';

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM contact_scores'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

const company = (name: string) => id(`INSERT INTO companies (name) VALUES (?) RETURNING id`, name);
const contact = (email: string, companyId: number, opts: { archived?: boolean; name?: string } = {}) =>
	id(
		`INSERT INTO contacts (email, name, company_id, archived_at) VALUES (?, ?, ?, ?) RETURNING id`,
		email,
		opts.name ?? null,
		companyId,
		opts.archived ? '2026-01-01 00:00:00' : null
	);
const event = (contactId: number, type: string, at: string, detail: object = {}) =>
	db.prepare('INSERT INTO events (contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?)').bind(contactId, type, JSON.stringify(detail), at).run();
const engagement = (contactId: number, score: number, tier: string) =>
	db.prepare('INSERT INTO contact_engagement (contact_id, score, tier) VALUES (?, ?, ?)').bind(contactId, score, tier).run();
const leadScore = async (contactId: number, value: number) => {
	const sid = (await db.prepare(`SELECT id FROM score_defs WHERE slug = 'lead-score'`).first<{ id: number }>())!.id;
	await db
		.prepare(`INSERT INTO contact_scores (contact_id, score_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))`)
		.bind(contactId, sid, value)
		.run();
};

describe('engagement trend series (#565)', () => {
	it('adds deliveries as their own series; they never count as a touch', async () => {
		const co = await company('Trend');
		const c = await contact('t@trend.test', co);
		await event(c, 'delivery', '2026-11-10 09:00:00');
		await event(c, 'delivery', '2026-11-11 09:00:00');
		await event(c, 'delivery', '2026-07-01 09:00:00'); // before the 90-day window (starts Mon 2026-08-17)
		await event(c, 'open', '2026-11-11 10:00:00', { UserAgent: 'Mozilla/5.0 Thunderbird' });
		await event(c, 'open', '2026-11-11 10:05:00', { UserAgent: 'Mozilla/5.0 (Macintosh) Apple Mail (16.0)' });

		const d = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		const week = d.series.find((p) => p.start === '2026-11-09')!;
		expect(week).toMatchObject({ delivered: 2, opens: 1, clicks: 0, replies: 0, visits: 0 });
		expect(d.series.reduce((a, p) => a + p.delivered, 0)).toBe(2);
		expect(d.engaged30d).toBe(1);
	});

	it('only counts active contacts of this company', async () => {
		const co = await company('Mine');
		const other = await company('Other');
		const gone = await contact('gone@mine.test', co, { archived: true });
		const theirs = await contact('x@other.test', other);
		await event(gone, 'delivery', '2026-11-10 09:00:00');
		await event(theirs, 'delivery', '2026-11-10 09:00:00');
		const d = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		expect(d.series.every((p) => p.delivered === 0)).toBe(true);
	});

	it('fillEngagement takes the delivered kind', () => {
		const pts = fillEngagement(engagementBuckets(NOW, 0), [{ d: '2026-11-16', kind: 'delivered', n: 4 }]);
		expect(pts[pts.length - 1].delivered).toBe(4);
		expect(ENGAGEMENT_SERIES.map((s) => s.key)).toEqual(['delivered', 'opens', 'clicks', 'replies', 'visits']);
		// Every series is told apart without colour: no two share both hue and dash.
		const looks = new Set(ENGAGEMENT_SERIES.map((s) => `${s.color}|${s.dash}`));
		expect(looks.size).toBe(ENGAGEMENT_SERIES.length);
		expect(ENGAGEMENT_SERIES.every((s) => s.color.startsWith('var(--viz-'))).toBe(true);
	});
});

describe('top engaged contacts (#565)', () => {
	it('orders by engagement score, then Lead score, then id; shows Lead score and last activity', async () => {
		const co = await company('Top');
		const a = await contact('a@top.test', co, { name: 'Ann' });
		const b = await contact('b@top.test', co);
		const c = await contact('c@top.test', co);
		const zero = await contact('zero@top.test', co);
		const arch = await contact('arch@top.test', co, { archived: true });
		const extra = await Promise.all([1, 2, 3, 4].map((i) => contact(`e${i}@top.test`, co)));
		await engagement(a, 40, 'warm');
		await engagement(b, 70, 'hot');
		await engagement(c, 40, 'warm');
		await engagement(zero, 0, 'never');
		await engagement(arch, 99, 'hot');
		for (const e of extra) await engagement(e, 10, 'cool');
		await leadScore(c, 25);
		await leadScore(a, 5);
		await event(b, 'click', '2026-11-12 08:00:00');
		await event(b, 'delivery', '2026-11-15 08:00:00'); // not activity

		const d = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
		expect(d.topContacts.map((t) => t.id)).toEqual([b, c, a, extra[0], extra[1]]);
		expect(d.topContacts.find((t) => t.id === c)!.lead_score).toBe(25);
		expect(d.topContacts.find((t) => t.id === b)!.lead_score).toBe(0); // no row = 0
		expect(d.topContacts.find((t) => t.id === b)!.last_activity_at).toBe('2026-11-12 08:00:00');
		expect(d.topContacts.find((t) => t.id === a)!.last_activity_at).toBeNull();
		expect(d.leadScoreName).toBe('Lead score');
	});

	it('Lead score is null when the score was deleted', async () => {
		const co = await company('NoLead');
		const a = await contact('a@nolead.test', co);
		await engagement(a, 30, 'warm');
		const def = await db.prepare(`SELECT * FROM score_defs WHERE slug = 'lead-score'`).first<Record<string, unknown>>();
		await db.prepare(`UPDATE score_defs SET slug = 'renamed-lead' WHERE slug = 'lead-score'`).run();
		try {
			const d = await loadCompanyDashboard(db, co, { billing: false, now: NOW, tz: TZ });
			expect(d.topContacts[0].lead_score).toBeNull();
			expect(d.leadScoreName).toBeNull();
		} finally {
			await db.prepare(`UPDATE score_defs SET slug = 'lead-score' WHERE id = ?`).bind(def!.id).run();
		}
	});
});

describe('trend chart math (#565)', () => {
	const series = [
		{ key: 'a', label: 'Delivered', color: 'var(--viz-3)', dash: null },
		{ key: 'b', label: 'Clicks', color: 'var(--viz-1)', dash: '2 3' }
	];
	const pts: TrendPoint[] = [
		{ start: '2026-11-02', label: 'Nov 2', a: 4, b: 1 },
		{ start: '2026-11-09', label: 'Nov 9', a: 8, b: 0 },
		{ start: '2026-11-16', label: 'Nov 16', a: 0, b: 2 }
	];
	const g = { width: 100, base: 50, pad: 0 };

	it('totals, peak and empty state', () => {
		expect(trendTotals(pts, series)).toEqual({ a: 12, b: 3 });
		expect(trendPeak(pts, series)).toBe(8);
		expect(trendPeak([], series)).toBe(1);
		expect(trendEmpty(pts, series)).toBe(false);
		expect(trendEmpty(pts.map((p) => ({ ...p, a: 0, b: 0 })), series)).toBe(true);
	});

	it('places every series on one shared scale', () => {
		expect(trendX(0, 3, g)).toBe(0);
		expect(trendX(2, 3, g)).toBe(100);
		expect(trendX(0, 1, g)).toBe(50);
		expect(trendLine(pts, 'a', 8, g)).toBe('0.0,25.0 50.0,0.0 100.0,50.0');
		expect(trendLine(pts, 'b', 8, g)).toBe('0.0,43.8 50.0,50.0 100.0,37.5');
	});

	it('reads out every series for one point', () => {
		expect(trendPointText(pts[0], series, 'Week of ')).toBe('Week of Nov 2: Delivered 4 · Clicks 1');
	});
});

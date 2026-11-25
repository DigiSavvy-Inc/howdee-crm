// Site tracking C (#153): the read surfaces over `site_events` — contact timeline merge +
// Site activity card, the dashboard `visited` feed type, the Contacts filters, the
// visited/event segment rules, and the engagement weights.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { mergeTimeline, propsSummary, siteTimeline, siteActivitySummary, setTrackingOptout } from '../src/lib/server/site-activity';
import { recentActivity, feedTypes, DEFAULT_ACTIVITY_TYPES } from '../src/lib/server/activity';
import { contactsWhere, contactsFilterParams, isFiltered, parseContactsFilter } from '../src/lib/server/contacts-query';
import { compileSegment, type SegmentRules } from '../src/lib/server/segment-query';
import { scoreFromEvents, ENGAGEMENT_DEFAULTS, computeEngagement } from '../src/lib/server/engagement';

const db = (env as any).DB as D1Database;

let ann: number;
let bob: number;
let carol: number;
let site: number;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

async function siteEvent(
	contact: number,
	kind: 'pageview' | 'event',
	name: string,
	path: string | null,
	ago: string,
	extra: { utm?: string; props?: string } = {}
) {
	await db
		.prepare(
			`INSERT INTO site_events (site_id, contact_id, kind, name, path, utm, props, occurred_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
		)
		.bind(site, contact, kind, name, path, extra.utm ?? null, extra.props ?? null, ago)
		.run();
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM webhook_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	site = await id(`INSERT INTO tracking_sites (name, domain, site_key) VALUES ('Ourco', 'ourco.example', 'sk_c') RETURNING id`);
	ann = await id(`INSERT INTO contacts (email, name, created_at) VALUES ('ann@x.example.net', 'Ann Lee', datetime('now', '-60 days')) RETURNING id`);
	bob = await id(`INSERT INTO contacts (email, created_at) VALUES ('bob@x.example.net', datetime('now', '-60 days')) RETURNING id`);
	carol = await id(`INSERT INTO contacts (email, created_at) VALUES ('carol@x.example.net', datetime('now', '-60 days')) RETURNING id`);
	// ann: /pricing 2 days ago + booked_call; bob: /pricing 40 days ago; carol: nothing.
	await siteEvent(ann, 'pageview', 'pageview', '/blog/post', '-10 days', { utm: '{"source":"newsletter","campaign":"oct"}' });
	await siteEvent(ann, 'pageview', 'pageview', '/pricing', '-2 days');
	await siteEvent(ann, 'pageview', 'pageview', '/pricing', '-1 days');
	await siteEvent(ann, 'event', 'booked_call', '/book', '-1 hours', { props: '{"plan":"pro","seats":3}' });
	await siteEvent(bob, 'pageview', 'pageview', '/pricing', '-40 days');
});

describe('contact timeline merge', () => {
	it('merges sources newest first, drops untimed rows, and cuts to the limit', () => {
		const a = (kind: string, at: string) => ({ kind, at, campaign_id: null, label: kind, url: null });
		const merged = mergeTimeline(
			[
				[a('open', '2026-01-02 00:00:00'), a('click', '2026-01-04 00:00:00')],
				[a('visited', '2026-01-03 00:00:00'), a('site_event', '2026-01-05 00:00:00')],
				[a('added', '2026-01-01 00:00:00'), a('reply', '')]
			],
			4
		);
		expect(merged.map((m) => m.kind)).toEqual(['site_event', 'click', 'visited', 'open']);
	});

	it('labels pageviews with path + site and events with «name» + props', async () => {
		const rows = await siteTimeline(db, ann);
		expect(rows[0]).toMatchObject({ kind: 'site_event', label: '«booked_call» · plan: pro, seats: 3' });
		expect(rows[1]).toMatchObject({ kind: 'visited', label: '/pricing · ourco.example' });
		expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort().reverse());
		expect(propsSummary('not json')).toBe('');
		expect(propsSummary('[1]')).toBe('');
	});
});

describe('Site activity card', () => {
	it('summarises last seen, 30-day pageviews, top paths and first-touch UTM', async () => {
		const s = await siteActivitySummary(db, ann);
		expect(s.lastSeen).not.toBeNull();
		expect(s.pageviews30d).toBe(3);
		expect(s.topPaths[0]).toEqual({ path: '/pricing', n: 2 });
		expect(s.topPaths).toHaveLength(2);
		expect(s.firstTouch?.utm).toEqual({ source: 'newsletter', campaign: 'oct' });
		const empty = await siteActivitySummary(db, carol);
		expect(empty).toEqual({ lastSeen: null, pageviews30d: 0, topPaths: [], firstTouch: null });
	});

	it('Stop tracking toggles contacts.tracking_optout', async () => {
		expect(await setTrackingOptout(db, ann, true)).toBe(true);
		const row = await db.prepare('SELECT tracking_optout FROM contacts WHERE id = ?').bind(ann).first<{ tracking_optout: number }>();
		expect(row?.tracking_optout).toBe(1);
		await setTrackingOptout(db, ann, false);
		const back = await db.prepare('SELECT tracking_optout FROM contacts WHERE id = ?').bind(ann).first<{ tracking_optout: number }>();
		expect(back?.tracking_optout).toBe(0);
		expect(await setTrackingOptout(db, 999999, true)).toBe(false);
	});
});

describe('dashboard feed: visited', () => {
	it('is in the default feed and behind the Site chip, with path/event + site name', async () => {
		expect(DEFAULT_ACTIVITY_TYPES).toContain('visited');
		const rows = await recentActivity(db, { types: feedTypes('site') });
		expect(rows.every((r) => r.type === 'visited')).toBe(true);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toMatchObject({ contact_id: ann, name: 'Ann Lee', detail: 'booked_call', site_kind: 'event', site_name: 'Ourco' });
		expect(rows[1]).toMatchObject({ detail: '/pricing', site_kind: 'pageview' });
	});
});

describe('Contacts filters', () => {
	async function matching(qs: string): Promise<string[]> {
		const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(qs)));
		const r = await db.prepare(`SELECT email FROM contacts ${where} ORDER BY email`).bind(...params).all<{ email: string }>();
		return r.results.map((x) => x.email);
	}

	it('parses + round-trips the params', () => {
		const f = parseContactsFilter(new URLSearchParams('visited=/pricing&visited_days=7&site=any'));
		expect(f).toMatchObject({ visited: '/pricing', visitedDays: 7, site: 'any' });
		expect(isFiltered(f)).toBe(true);
		expect(contactsFilterParams(f)).toEqual({ visited: '/pricing', visited_days: '7', site: 'any' });
		expect(parseContactsFilter(new URLSearchParams('site=bogus&visited_days=-3')).site).toBe('all');
		expect(parseContactsFilter(new URLSearchParams('visited_days=abc')).visitedDays).toBeNull();
	});

	it('builds bound SQL (no user text in the query)', () => {
		const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams('visited=%27x&visited_days=30')));
		expect(where).toContain('site_events');
		expect(where).not.toContain("'x");
		expect(params).toEqual(["'x", '-30 days']); // raw text, matched with instr (#485)
	});

	it('visited path contains … in the last N days', async () => {
		expect(await matching('visited=pricing')).toEqual(['ann@x.example.net', 'bob@x.example.net']);
		expect(await matching('visited=pricing&visited_days=30')).toEqual(['ann@x.example.net']);
		expect(await matching('visited=%25')).toEqual([]); // a literal %, not a wildcard
	});

	it('has / no site activity', async () => {
		expect(await matching('site=any')).toEqual(['ann@x.example.net', 'bob@x.example.net']);
		expect(await matching('site=none')).toEqual(['carol@x.example.net']);
	});
});

describe('segment rules: visited / event', () => {
	async function emails(rules: SegmentRules): Promise<string[]> {
		const c = compileSegment(rules);
		const r = await db
			.prepare(`SELECT email FROM contacts WHERE id IN (${c.sql}) ORDER BY email`)
			.bind(...c.binds)
			.all<{ email: string }>();
		return r.results.map((x) => x.email);
	}

	it('compiles to bound parameters', () => {
		const c = compileSegment({ match: 'all', rules: [{ field: 'visited', op: 'in', value: '/pri_ing', value2: '14' }] });
		expect(c.sql).toContain('site_events');
		expect(c.binds).toEqual(['/pri_ing', '-14 days']); // raw text, matched with instr (#485)
		expect(compileSegment({ match: 'all', rules: [{ field: 'event', op: 'in', value: '' }] }).sql).not.toContain('site_events');
	});

	it('visited:<path-contains> with and without a window', async () => {
		expect(await emails({ match: 'all', rules: [{ field: 'visited', op: 'in', value: '/pricing' }] })).toEqual(['ann@x.example.net', 'bob@x.example.net']);
		expect(await emails({ match: 'all', rules: [{ field: 'visited', op: 'in', value: '/pricing', value2: '30' }] })).toEqual(['ann@x.example.net']);
		expect(await emails({ match: 'all', rules: [{ field: 'visited', op: 'not', value: '/pricing', value2: '30' }] })).toEqual([
			'bob@x.example.net',
			'carol@x.example.net'
		]);
	});

	it('event:<name>, combinable with other rules', async () => {
		expect(await emails({ match: 'all', rules: [{ field: 'event', op: 'in', value: 'booked_call' }] })).toEqual(['ann@x.example.net']);
		expect(await emails({ match: 'all', rules: [{ field: 'event', op: 'in', value: 'booked_call', value2: '0' }] })).toEqual(['ann@x.example.net']);
		expect(await emails({ match: 'all', rules: [{ field: 'event', op: 'in', value: 'booked' }] })).toEqual([]); // exact name
		expect(
			await emails({
				match: 'any',
				rules: [
					{ field: 'event', op: 'in', value: 'booked_call' },
					{ field: 'visited', op: 'in', value: 'pricing' }
				]
			})
		).toEqual(['ann@x.example.net', 'bob@x.example.net']);
	});
});

describe('engagement weights', () => {
	const now = new Date('2026-06-01T00:00:00Z');

	it('pageview ×0.5, site event ×2, same half-life, behind constants', () => {
		expect(ENGAGEMENT_DEFAULTS.wPageview).toBe(0.5);
		expect(ENGAGEMENT_DEFAULTS.wSiteEvent).toBe(2);
		expect(scoreFromEvents([{ type: 'pageview', at: '2026-06-01 00:00:00' }], now)).toBeCloseTo(0.5);
		expect(scoreFromEvents([{ type: 'site_event', at: '2026-06-01 00:00:00' }], now)).toBeCloseTo(2);
		expect(scoreFromEvents([{ type: 'pageview', at: '2026-04-02 00:00:00', n: 4 }], now)).toBeCloseTo(1); // 60 days → half
	});

	it('computeEngagement folds site activity into the score', async () => {
		await computeEngagement(db, { contactIds: [ann, carol] });
		const rows = await db
			.prepare('SELECT contact_id, score FROM contact_engagement WHERE contact_id IN (?, ?)')
			.bind(ann, carol)
			.all<{ contact_id: number; score: number }>();
		const by = new Map(rows.results.map((r) => [r.contact_id, r.score]));
		expect(by.get(carol)).toBe(0);
		// ≈ 3 pageviews ×0.5 + 1 event ×2, slightly decayed → raw ≈ 3.4.
		expect(by.get(ann)!).toBeGreaterThan(50);
		expect(by.get(ann)!).toBeLessThan(60);
	});
});

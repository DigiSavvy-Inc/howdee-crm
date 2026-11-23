// Engagement 2/4 (#114): the read surfaces over the #113 rollup — Contacts filters,
// dynamic-segment rules, the contact profile, the Data API, and the pure view helpers.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { contactsWhere, contactsFilterParams, isFiltered, parseContactsFilter } from '../src/lib/server/contacts-query';
import { compileSegment, type SegmentRule } from '../src/lib/server/segment-query';
import { computeEngagement } from '../src/lib/server/engagement';
import { engagementProfile, engagementSummary } from '../src/lib/server/engagement-query';
import { barHeights, bestTimeText, fillMonths, lastMonths, monthLabel, proxyShare } from '../src/lib/engagement-view';
import { generateApiKey } from '../src/lib/server/api-keys';
import { GET as contactEngagement } from '../src/routes/api/v1/contacts/[id]/engagement/+server';
import { GET as engagementSummaryGet } from '../src/routes/api/v1/engagement/summary/+server';
import { GET as getContact } from '../src/routes/api/v1/contacts/[id]/+server';

const db = (env as any).DB as D1Database;

let ann: number; // 3 sends, opened the last two → warm-ish
let bob: number; // 3 sends, never opened → never
let carol: number; // never mailed → new

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	ann = await id(`INSERT INTO contacts (email) VALUES ('ann@x.example.net') RETURNING id`);
	bob = await id(`INSERT INTO contacts (email) VALUES ('bob@x.example.net') RETURNING id`);
	carol = await id(`INSERT INTO contacts (email) VALUES ('carol@x.example.net') RETURNING id`);
	const camps: number[] = [];
	for (const ago of ['-30 days', '-20 days', '-10 days']) {
		camps.push(
			await id(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
				 VALUES ('s', 'b', 'b', 'f@x.example.net', 'sent', datetime('now', ?)) RETURNING id`,
				ago
			)
		);
	}
	for (const c of camps) {
		for (const [contact, email] of [
			[ann, 'ann@x.example.net'],
			[bob, 'bob@x.example.net']
		] as const) {
			await db
				.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted')`)
				.bind(c, contact, email)
				.run();
		}
	}
	// ann opened campaigns 2 and 3 (19 and 9 days ago).
	await db
		.prepare(`INSERT INTO events (campaign_id, contact_id, type, recorded_at) VALUES (?, ?, 'open', datetime('now', '-19 days'))`)
		.bind(camps[1], ann)
		.run();
	await db
		.prepare(`INSERT INTO events (campaign_id, contact_id, type, recorded_at) VALUES (?, ?, 'open', datetime('now', '-9 days'))`)
		.bind(camps[2], ann)
		.run();
	await computeEngagement(db, { contactIds: [ann, bob, carol] });
});

async function filterEmails(qs: string): Promise<string[]> {
	const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(qs)));
	const rows = await db.prepare(`SELECT email FROM contacts ${where} ORDER BY email`).bind(...params).all<{ email: string }>();
	return rows.results.map((r) => r.email);
}

async function ruleEmails(rule: SegmentRule): Promise<string[]> {
	const c = compileSegment({ match: 'all', rules: [rule] });
	const rows = await db
		.prepare(`SELECT email FROM contacts WHERE id IN (${c.sql}) ORDER BY email`)
		.bind(...c.binds)
		.all<{ email: string }>();
	return rows.results.map((r) => r.email);
}

describe('Contacts filters', () => {
	it('parses, validates and round-trips the engagement params', () => {
		const f = parseContactsFilter(new URLSearchParams('tier=hot&opened_days=14&never_opened=1&opened_n=2&opened_of=5'));
		expect(f).toMatchObject({ tier: 'hot', openedDays: 14, neverOpened: true, openedN: 2, openedOf: 5 });
		expect(isFiltered(f)).toBe(true);
		expect(contactsFilterParams(f)).toMatchObject({ tier: 'hot', opened_days: '14', never_opened: '1', opened_n: '2', opened_of: '5' });

		const junk = parseContactsFilter(new URLSearchParams('tier=lukewarm&opened_days=-1&never_opened=yes&opened_n=3'));
		expect(junk).toMatchObject({ tier: '', openedDays: null, neverOpened: false, openedN: null, openedOf: null });
		expect(isFiltered(junk)).toBe(false);
		// N is capped at M.
		expect(parseContactsFilter(new URLSearchParams('opened_n=4&opened_of=2'))).toMatchObject({ openedN: 2, openedOf: 2 });
	});

	it('filters by tier (no rollup row counts as new)', async () => {
		expect(await filterEmails('tier=never')).toEqual(['bob@x.example.net']);
		expect(await filterEmails('tier=new')).toEqual(['carol@x.example.net']);
		await db.prepare('DELETE FROM contact_engagement WHERE contact_id = ?').bind(carol).run();
		expect(await filterEmails('tier=new')).toEqual(['carol@x.example.net']);
	});

	it('last opened within N days', async () => {
		expect(await filterEmails('opened_days=15')).toEqual(['ann@x.example.net']);
		expect(await filterEmails('opened_days=5')).toEqual([]);
	});

	it('never opened = mailed at least once, no opens', async () => {
		expect(await filterEmails('never_opened=1')).toEqual(['bob@x.example.net']);
	});

	it('opened ≥ N of the last M sends', async () => {
		expect(await filterEmails('opened_n=2&opened_of=2')).toEqual(['ann@x.example.net']);
		expect(await filterEmails('opened_n=3&opened_of=3')).toEqual([]);
		expect(await filterEmails('opened_n=1&opened_of=1')).toEqual(['ann@x.example.net']);
		expect(await filterEmails('opened_n=2&opened_of=2&tier=never')).toEqual([]);
	});
});

describe('segment rules', () => {
	it('engagement_tier is / is not', async () => {
		expect(await ruleEmails({ field: 'engagement_tier', op: 'is', value: 'never' })).toEqual(['bob@x.example.net']);
		expect(await ruleEmails({ field: 'engagement_tier', op: 'not', value: 'never' })).toEqual(['ann@x.example.net', 'carol@x.example.net']);
		// An unknown tier is skipped (matches everyone, like any empty rule).
		expect((await ruleEmails({ field: 'engagement_tier', op: 'is', value: 'bogus' })).length).toBe(3);
	});

	it('last_open_within_days', async () => {
		expect(await ruleEmails({ field: 'last_open_within_days', op: 'within', value: '15' })).toEqual(['ann@x.example.net']);
		expect(await ruleEmails({ field: 'last_open_within_days', op: 'not', value: '15' })).toEqual(['bob@x.example.net', 'carol@x.example.net']);
	});

	it('opens_last_90d compares a count', async () => {
		expect(await ruleEmails({ field: 'opens_last_90d', op: 'gte', value: '2' })).toEqual(['ann@x.example.net']);
		expect(await ruleEmails({ field: 'opens_last_90d', op: 'lt', value: '1' })).toEqual(['bob@x.example.net', 'carol@x.example.net']);
		expect((await ruleEmails({ field: 'opens_last_90d', op: 'drop', value: '1' })).length).toBe(3);
	});

	it('never_opened yes / no', async () => {
		expect(await ruleEmails({ field: 'never_opened', op: 'yes' })).toEqual(['bob@x.example.net']);
		expect(await ruleEmails({ field: 'never_opened', op: 'no' })).toEqual(['ann@x.example.net']);
	});
});

describe('profile + Data API', () => {
	async function makeKey(): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, 'read')`)
			.bind(k.tokenHash, k.prefix, k.last4)
			.run();
		return k.token;
	}
	function ev(path: string, token: string | null, params: Record<string, string> = {}) {
		const url = new URL(`https://app.test${path}`);
		const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
		return { request: new Request(url, { headers }), platform: { env }, url, params } as any;
	}

	it('engagementProfile: counts, 12-month series, defaults without a row', async () => {
		const p = await engagementProfile(db, ann);
		expect(p.sent_count).toBe(3);
		expect(p.open_count).toBe(2);
		expect(p.monthly).toHaveLength(12);
		expect(p.monthly.reduce((a, m) => a + m.opens, 0)).toBe(2);
		expect(p.last_activity_at).toBe(p.last_open_at);
		expect(p.stale).toBe(false);

		await db.prepare('DELETE FROM contact_engagement WHERE contact_id = ?').bind(carol).run();
		const none = await engagementProfile(db, carol);
		expect(none).toMatchObject({ tier: 'new', score: 0, sent_count: 0, computed_at: null, stale: true });
	});

	it('GET /api/v1/contacts/:id/engagement', async () => {
		const token = await makeKey();
		expect((await contactEngagement(ev(`/api/v1/contacts/${bob}/engagement`, null, { id: String(bob) }))).status).toBe(401);
		const res = await contactEngagement(ev(`/api/v1/contacts/${bob}/engagement`, token, { id: String(bob) }));
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.data).toMatchObject({ contact_id: bob, tier: 'never', sent_count: 3, open_count: 0 });
		expect((await contactEngagement(ev('/api/v1/contacts/999999/engagement', token, { id: '999999' }))).status).toBe(404);
		expect((await contactEngagement(ev('/api/v1/contacts/x/engagement', token, { id: 'x' }))).status).toBe(400);
	});

	it('contact serialization carries tier + score', async () => {
		const token = await makeKey();
		const res = await getContact(ev(`/api/v1/contacts/${bob}`, token, { id: String(bob) }));
		const body = await res.json<any>();
		expect(body.data.tier).toBe('never');
		expect(body.data.score).toBe(0);
	});

	it('GET /api/v1/engagement/summary', async () => {
		const token = await makeKey();
		const res = await engagementSummaryGet(ev('/api/v1/engagement/summary', token));
		expect(res.status).toBe(200);
		const { data } = await res.json<any>();
		expect(data.total_contacts).toBe(3);
		expect(data.tiers.never).toBe(1);
		expect(data.tiers.new).toBe(1);
		expect(data.tiers.hot + data.tiers.warm + data.tiers.cool + data.tiers.cold).toBe(1);
		expect(data.opened_last_30d).toBe(1);
		expect(await engagementSummary(db)).toEqual(data);
	});
});

describe('engagement-view helpers', () => {
	it('bestTimeText shifts the UTC peak into the guessed local time', () => {
		expect(bestTimeText(null, 2, -8, 0.8)).toBeNull();
		expect(bestTimeText(17, 2, -8, 0.8)).toEqual({ text: 'usually opens around 9am on Tuesday', zone: 'local', confidence: 'high' });
		// 03:00 UTC Tuesday at UTC-8 is 7pm Monday.
		expect(bestTimeText(3, 2, -8, 0.5)?.text).toBe('usually opens around 7pm on Monday');
		expect(bestTimeText(14, null, null, null)).toEqual({ text: 'usually opens around 2pm', zone: 'UTC', confidence: 'low' });
		expect(bestTimeText(0, 0, 0, 0.2)?.text).toBe('usually opens around 12am on Sunday');
	});

	it('month series helpers', () => {
		expect(lastMonths(new Date('2026-01-15T00:00:00Z'), 3)).toEqual(['2025-11', '2025-12', '2026-01']);
		expect(fillMonths(['2025-12', '2026-01'], [{ month: '2026-01', opens: 2, clicks: 1 }])).toEqual([
			{ month: '2025-12', opens: 0, clicks: 0 },
			{ month: '2026-01', opens: 2, clicks: 1 }
		]);
		expect(monthLabel('2026-05')).toBe('May 2026');
		expect(barHeights([{ month: 'a', opens: 10, clicks: 1 }, { month: 'b', opens: 0, clicks: 0 }], 36)).toEqual([
			{ opens: 36, clicks: 4 },
			{ opens: 0, clicks: 0 }
		]);
		expect(proxyShare(0, 0)).toBeNull();
		expect(proxyShare(4, 1)).toBe(0.25);
	});
});

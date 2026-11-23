// #423: contacts Overview — scoped activity feed, period math, tile round-trips, group-by-contact,
// feed export cap, engagementSummary scope/archived, the new filter keys and indexes.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	recentActivity,
	groupActivityByContact,
	parseFeedTypes,
	CONTACT_ACTIVITY_TYPES,
	type ActivityItem
} from '../src/lib/server/activity';
import {
	contactsFilterParams,
	contactsOrder,
	contactsWhere,
	parseContactsFilter,
	resolveContactsFilter
} from '../src/lib/server/contacts-query';
import { feedExportCsv, filterToRules, loadContactsOverview, mergedFilter } from '../src/lib/server/contacts-overview';
import { engagementSummary } from '../src/lib/server/engagement-query';
import {
	bucketOf,
	fillGrowth,
	growthBuckets,
	growthSince,
	parsePeriod,
	periodStartDate,
	topWithOther,
	tzOffsetMinutes
} from '../src/lib/contacts-overview';

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
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM conversation_state'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function contact(email: string, opts: { source?: string; archived?: boolean; created?: string; subscribed?: number } = {}) {
	return id(
		`INSERT INTO contacts (email, source, subscribed, created_at, archived_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?) RETURNING id`,
		email,
		opts.source ?? null,
		opts.subscribed ?? 1,
		opts.created ?? null,
		opts.archived ? '2026-01-01 00:00:00' : null
	);
}

async function reply(contactId: number | null, from: string, at: string) {
	await db
		.prepare('INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, ?, ?, ?, ?)')
		.bind(contactId, from, 'Hi', 'Hello there', at)
		.run();
}

async function countFor(qs: string): Promise<number> {
	const f = await resolveContactsFilter(db, parseContactsFilter(new URLSearchParams(qs)));
	const { where, params } = contactsWhere(f);
	return (await db.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`).bind(...params).first<{ n: number }>())!.n;
}

describe('scoped activity feed (#423)', () => {
	it('limits every source to the filtered contacts and leaves archived ones out', async () => {
		const ann = await contact('ann@x.example.net', { source: 'csv' });
		const bob = await contact('bob@x.example.net', { source: 'form' });
		const cara = await contact('cara@x.example.net', { source: 'csv', archived: true });
		await reply(ann, 'ann@x.example.net', '2026-10-01 10:00:00');
		await reply(bob, 'bob@x.example.net', '2026-10-02 10:00:00');
		await reply(cara, 'cara@x.example.net', '2026-10-03 10:00:00');

		const scoped = (qs: string) => {
			const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(qs)));
			return recentActivity(db, { limit: 50, types: ['reply', 'contact'], scope: { where, binds: params } });
		};
		const csv = await scoped('source=csv');
		expect(new Set(csv.map((a) => a.contact_id))).toEqual(new Set([ann]));
		const all = await scoped('');
		expect(new Set(all.map((a) => a.contact_id))).toEqual(new Set([ann, bob]));
		const archived = await scoped('archived=1');
		expect(new Set(archived.map((a) => a.contact_id))).toEqual(new Set([cara]));
	});

	it('excludeArchived keeps rows with no contact; since narrows by time; contactless sources skip under a scope', async () => {
		const ann = await contact('ann@x.example.net');
		const cara = await contact('cara@x.example.net', { archived: true });
		await reply(ann, 'ann@x.example.net', '2026-10-01 10:00:00');
		await reply(cara, 'cara@x.example.net', '2026-10-02 10:00:00');
		await reply(null, 'stranger@y.example.net', '2026-10-03 10:00:00');

		const rows = await recentActivity(db, { types: ['reply'], excludeArchived: true });
		expect(rows.map((r) => r.email).sort()).toEqual(['ann@x.example.net', 'stranger@y.example.net']);

		const recent = await recentActivity(db, { types: ['reply'], since: '2026-10-02 00:00:00' });
		expect(recent.map((r) => r.email).sort()).toEqual(['cara@x.example.net', 'stranger@y.example.net']);

		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('domain_auth_events', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(JSON.stringify([{ at: '2026-10-04 00:00:00', domain: 'x.example.net', text: 'DMARC broke' }]))
			.run();
		const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams('')));
		const scoped = await recentActivity(db, { types: ['reply', 'domain_auth'], scope: { where, binds: params } });
		expect(scoped.some((r) => r.type === 'domain_auth')).toBe(false);
		expect((await recentActivity(db, { types: ['domain_auth'] })).length).toBe(1);
	});

	it('groups by contact with the last 3 events each', () => {
		const ev = (contact_id: number | null, at: string): ActivityItem => ({
			at,
			type: 'open',
			contact_id,
			email: `${contact_id}@x.example.net`,
			name: null,
			campaign_id: null,
			subject: null,
			automation_id: null,
			automation_name: null,
			detail: null
		});
		const items = [ev(1, '5'), ev(2, '4'), ev(1, '3'), ev(1, '2'), ev(1, '1'), ev(null, '0'), ev(3, '0')];
		const groups = groupActivityByContact(items, 3, 2);
		expect(groups.map((g) => g.contact_id)).toEqual([1, 2]);
		expect(groups[0].items.map((i) => i.at)).toEqual(['5', '3', '2']);
		expect(groups[0].more).toBe(1);
		expect(parseFeedTypes('open,click,bogus,domain_auth,open')).toEqual(['open', 'click']);
		expect(CONTACT_ACTIVITY_TYPES).not.toContain('domain_auth');
	});

	it('feed CSV export is scoped and capped', async () => {
		const ann = await contact('ann@x.example.net', { source: 'csv' });
		await db.prepare(`UPDATE contacts SET name = '=HYPERLINK("x")' WHERE id = ?`).bind(ann).run();
		const bob = await contact('bob@x.example.net', { source: 'form' });
		for (let i = 0; i < 6; i++) await reply(ann, 'ann@x.example.net', `2026-10-0${i + 1} 10:00:00`);
		await reply(bob, 'bob@x.example.net', '2026-10-09 10:00:00');

		const capped = await feedExportCsv(db, new URLSearchParams('source=csv&feed_types=reply'), { cap: 4 });
		expect(capped.rows).toBe(4);
		const lines = capped.csv.trim().split('\r\n');
		expect(lines[0]).toBe('at_utc,type,contact_id,email,name,company,tier,campaign_id,subject,automation,detail');
		expect(lines).toHaveLength(5);
		expect(capped.csv).not.toContain('bob@x.example.net');
		expect(capped.csv).toContain(`"'=HYPERLINK(""x"")"`); // formula guard
		const full = await feedExportCsv(db, new URLSearchParams('feed_types=reply'), { cap: 100_000 });
		expect(full.rows).toBe(7);
	});
});

describe('period math (#423)', () => {
	const now = new Date('2026-10-22T03:00:00Z'); // Oct 21, 20:00 in Los Angeles

	it('periods start on UTC days; unknown periods fall back to 30d', () => {
		expect(parsePeriod('90d')).toBe('90d');
		expect(parsePeriod('bogus')).toBe('30d');
		expect(periodStartDate('7d', now)).toBe('2026-10-16');
		expect(periodStartDate('30d', now)).toBe('2026-09-23');
		expect(periodStartDate('12m', now)).toBe('2025-10-23');
	});

	it('buckets weeks from Monday and months from the 1st, in the Settings timezone', () => {
		expect(tzOffsetMinutes('UTC', now)).toBe(0);
		expect(tzOffsetMinutes('America/Los_Angeles', now)).toBe(-420);
		expect(tzOffsetMinutes('Not/AZone', now)).toBe(0);
		expect(bucketOf('2026-10-22', 'week')).toBe('2026-10-19');
		expect(bucketOf('2026-10-18', 'week')).toBe('2026-10-12');
		expect(bucketOf('2026-10-22', 'month')).toBe('2026-10-01');

		// In UTC the last day is Oct 22; in Los Angeles it is still Oct 21.
		expect(growthBuckets('7d', now, 0).at(-1)!.start).toBe('2026-10-22');
		expect(growthBuckets('7d', now, -420).at(-1)!.start).toBe('2026-10-21');
		const weeks = growthBuckets('30d', now, -420);
		expect(weeks.map((b) => b.start)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
		expect(growthSince(weeks, -420)).toBe('2026-09-21 07:00:00'); // local midnight as UTC
		const months = growthBuckets('12m', now, 0);
		expect(months).toHaveLength(13);
		expect(months[0]).toEqual({ start: '2025-10-01', label: 'Oct 2025' });

		const pts = fillGrowth(weeks, 'week', [{ d: '2026-10-20', n: 2 }, { d: '2026-10-21', n: 1 }, { d: '2025-01-01', n: 9 }], [{ d: '2026-10-14', n: 1 }]);
		expect(pts.at(-1)).toMatchObject({ added: 3, unsubscribed: 0 });
		expect(pts.at(-2)).toMatchObject({ added: 0, unsubscribed: 1 });
		expect(topWithOther([{ label: 'a', n: 1 }, { label: 'b', n: 5 }, { label: 'c', n: 3 }], 2)).toEqual([
			{ label: 'b', n: 5 },
			{ label: 'c', n: 3 },
			{ label: 'Other', n: 1, other: true }
		]);
	});
});

describe('overview tiles (#423)', () => {
	async function seed() {
		const list = await id(`INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id`);
		const ann = await contact('ann@x.example.net', { source: 'csv' });
		const bob = await contact('bob@x.example.net', { source: 'csv', created: '2025-01-01 00:00:00' });
		const cara = await contact('cara@x.example.net', { source: 'form', subscribed: 0 });
		const dan = await contact('dan@x.example.net', { source: 'csv', archived: true });
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, ann).run();
		await db.prepare(`INSERT INTO unsubscribes (email, reason, created_at) VALUES ('cara@x.example.net', 'x', datetime('now'))`).run();
		await db.prepare(`INSERT INTO contact_engagement (contact_id, tier, score) VALUES (?, 'hot', 80)`).bind(ann).run();
		await db.prepare(`INSERT INTO contact_engagement (contact_id, tier, score) VALUES (?, 'hot', 70)`).bind(dan).run();
		const camp = await id(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, list_id, status, recipient_count) VALUES ('S', 'm', 'h', 'f@x.example.net', ?, 'sent', 1) RETURNING id`,
			list
		);
		await db
			.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'bob@x.example.net', 'm1', 'accepted')`)
			.bind(camp, bob)
			.run();
		await reply(bob, 'bob@x.example.net', '2026-10-01 10:00:00');
		return { list, ann, bob, cara, dan };
	}

	it('each tile link reproduces its count when applied as a filter', async () => {
		await seed();
		const ov = await loadContactsOverview(db, parseContactsFilter(new URLSearchParams('')), { period: '30d', tz: 'UTC' });
		expect(ov.scopeCount).toBe(2); // dan is archived, cara unsubscribed (#705: hidden by default)
		const tile = (k: string) => ov.tiles.find((t) => t.key === k)!;
		expect(tile('new').value).toBe(1);
		expect(tile('unsubscribed').value).toBe(1);
		expect(tile('never_opened').value).toBe(1);
		expect(tile('hot_no_pipeline').value).toBe(1);
		expect(tile('awaiting').value).toBe(1);
		for (const k of ['new', 'unsubscribed', 'never_opened', 'hot_no_pipeline', 'awaiting', 'subscribed']) {
			const href = tile(k).href!;
			expect(await countFor(href.split('?')[1] ?? '')).toBe(tile(k).value);
		}
		expect(ov.sources.map((s) => [s.label, s.n])).toEqual([['csv', 2]]);
		expect(ov.lists.map((l) => [l.label, l.n])).toEqual([['Newsletter', 1]]);
		expect(ov.engagement.tiers.hot).toBe(1);
		expect(ov.trend).not.toBeNull();
	});

	it('a filter narrows every number and drops the audience-wide trend', async () => {
		await seed();
		const ov = await loadContactsOverview(db, parseContactsFilter(new URLSearchParams('source=csv')), { period: '30d', tz: 'UTC' });
		expect(ov.scopeCount).toBe(2);
		expect(ov.tiles.find((t) => t.key === 'new')!.value).toBe(1);
		expect(ov.tiles.find((t) => t.key === 'unsubscribed')!.value).toBe(0);
		expect(ov.trend).toBeNull();
		const href = ov.tiles.find((t) => t.key === 'never_opened')!.href!;
		expect(href).toContain('source=csv');
		expect(ov.attention.every((a) => a.n > 0)).toBe(true);
	});

	it('awaiting needs resolving; unresolved it matches nobody', async () => {
		const { bob } = await seed();
		const raw = parseContactsFilter(new URLSearchParams('awaiting=1'));
		const { where, params } = contactsWhere(raw);
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`).bind(...params).first<{ n: number }>())!.n).toBe(0);
		const resolved = await resolveContactsFilter(db, raw);
		expect(resolved.awaitingIds).toEqual([bob]);
		expect(await countFor('awaiting=1&awaiting_days=3')).toBe(1);
		expect(await countFor('awaiting=1&awaiting_days=3650')).toBe(0);
		expect(await countFor('no_list=1')).toBe(1); // bob (cara is unsubscribed, #705)
		expect(await countFor('no_list=1&status=all')).toBe(2);
		expect(contactsFilterParams(parseContactsFilter(new URLSearchParams('awaiting=1&awaiting_days=3&no_list=1&unsub_from=2026-10-01&cooled_days=30')))).toEqual({
			awaiting: '1',
			awaiting_days: '3',
			no_list: '1',
			unsub_from: '2026-10-01',
			cooled_days: '30'
		});
	});

	it('sorts by tier and score', async () => {
		const { ann, bob } = await seed();
		await db.prepare(`INSERT INTO contact_engagement (contact_id, tier, score) VALUES (?, 'cool', 20)`).bind(bob).run();
		for (const sort of ['tier', 'score']) {
			const { orderExpr, sort: s } = contactsOrder(new URLSearchParams(`sort=${sort}&dir=desc`));
			expect(s).toBe(sort);
			const rows = await db.prepare(`SELECT id FROM contacts WHERE archived_at IS NULL ORDER BY ${orderExpr}`).all<{ id: number }>();
			expect(rows.results.slice(0, 2).map((r) => r.id)).toEqual([ann, bob]);
		}
	});

	it('maps the filter to segment / report rules, and names what it cannot', () => {
		const f = parseContactsFilter(new URLSearchParams('status=subscribed&tier=hot&pipeline=none&in=4&added_to=2026-10-01'));
		const { rules, unmapped } = filterToRules(f);
		expect(unmapped).toEqual([]);
		expect(rules).toContainEqual({ field: 'engagement_tier', op: 'is', value: 'hot' });
		expect(rules).toContainEqual({ field: 'pipeline_stage', op: 'none' });
		expect(rules).toContainEqual({ field: 'created', op: 'before', value: '2026-10-02' });
		expect(filterToRules(parseContactsFilter(new URLSearchParams('q=ann&awaiting=1'))).unmapped).toEqual(['search', 'awaiting']);
		expect(contactsFilterParams(mergedFilter(f, { tier: 'cold', status: '' }))).toMatchObject({ tier: 'cold' });
		expect(contactsFilterParams(mergedFilter(f, { status: '' })).status).toBeUndefined();
	});
});

describe('engagementSummary scope + archived (#423)', () => {
	it('excludes archived contacts and narrows to a scope; the default stays audience-wide', async () => {
		const ann = await contact('ann@x.example.net', { source: 'csv' });
		const dan = await contact('dan@x.example.net', { archived: true });
		await db.prepare(`INSERT INTO contact_engagement (contact_id, tier, score, sent_count) VALUES (?, 'hot', 80, 1)`).bind(ann).run();
		await db.prepare(`INSERT INTO contact_engagement (contact_id, tier, score, sent_count) VALUES (?, 'warm', 40, 1)`).bind(dan).run();
		const all = await engagementSummary(db);
		expect(all.total_contacts).toBe(2);
		const active = await engagementSummary(db, { excludeArchived: true });
		expect(active.total_contacts).toBe(1);
		expect(active.tiers.warm).toBe(0);
		expect(active.average_score).toBe(80);
		const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams('archived=1')));
		const scoped = await engagementSummary(db, { scope: { where, binds: params } });
		expect(scoped.tiers).toMatchObject({ warm: 1, hot: 0 });
	});
});

describe('migration 0105 (#423)', () => {
	it('adds the overview indexes', async () => {
		const rows = await db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?) ORDER BY name`)
			.bind('idx_contacts_created_at', 'idx_contacts_source', 'idx_replies_received_at', 'idx_unsubscribes_created_at')
			.all<{ name: string }>();
		expect(rows.results.map((r) => r.name)).toEqual([
			'idx_contacts_created_at',
			'idx_contacts_source',
			'idx_replies_received_at',
			'idx_unsubscribes_created_at'
		]);
	});
});

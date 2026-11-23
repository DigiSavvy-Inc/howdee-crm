// #434: the "Visits the site often" (`site_activity`) trigger — config, session counting,
// trigger text, firing at ingest, and the write layer.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	countVisits,
	defaultSiteActivityConfig,
	normalizeSiteActivityConfig,
	parseSiteActivityConfig,
	siteActivityTriggerText,
	type SiteActivityConfig
} from '../src/lib/site-activity-trigger';
import { TRIGGER_TYPES, triggerText, type TriggerFields } from '../src/lib/automation-trigger';
import { fireSiteActivityTriggers } from '../src/lib/server/site-activity-trigger';
import { sqlTime } from '../src/lib/server/site-tracking';
import { readSpec, setTrigger, storedTriggerProblem } from '../src/lib/server/automation-write';

const db = (env as any).DB as D1Database;
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-01T09:00:00Z');

describe('countVisits', () => {
	it('a single pageview is one visit; nothing is zero', () => {
		expect(countVisits([])).toBe(0);
		expect(countVisits([T0])).toBe(1);
	});
	it('a gap of exactly 30 minutes stays in the visit, a longer one starts another', () => {
		expect(countVisits([T0, T0 + 30 * MIN])).toBe(1);
		expect(countVisits([T0, T0 + 30 * MIN + 1000])).toBe(2);
		// a chain of 20-minute steps is one long visit
		expect(countVisits([T0, T0 + 20 * MIN, T0 + 40 * MIN, T0 + 60 * MIN])).toBe(1);
	});
	it('overnight gaps split visits, in any input order', () => {
		expect(countVisits([T0 + 14 * HOUR, T0, T0 + 5 * MIN, T0 + 14 * HOUR + MIN, T0 + 24 * HOUR])).toBe(3);
	});
});

describe('site_activity config', () => {
	it('defaults: pages, 10, 30 days, any site, 168 h', () => {
		expect(defaultSiteActivityConfig()).toEqual({
			measure: 'pages',
			threshold: 10,
			days: 30,
			site_id: null,
			path_op: 'contains',
			path: '',
			cooldown_hours: 168
		});
		expect(normalizeSiteActivityConfig({})).toEqual({ ok: true, config: defaultSiteActivityConfig() });
	});
	it('refuses out-of-range values', () => {
		expect(normalizeSiteActivityConfig({ threshold: 0 }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ threshold: 1001 }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ days: 181 }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ days: 0 }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ cooldown_hours: 8761 }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ cooldown_hours: -1 }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ measure: 'clicks' }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ path_op: 'regex' }).ok).toBe(false);
		expect(normalizeSiteActivityConfig({ threshold: 2.5 }).ok).toBe(false);
	});
	it('accepts strings from a form and the bounds themselves', () => {
		const r = normalizeSiteActivityConfig({ measure: 'visits', threshold: '1000', days: '180', cooldown_hours: '0', site_id: '3', path: ' /blog ' });
		expect(r).toEqual({
			ok: true,
			config: { measure: 'visits', threshold: 1000, days: 180, site_id: 3, path_op: 'contains', path: '/blog', cooldown_hours: 0 }
		});
	});
	it('parse clamps stored values and falls back to defaults on junk', () => {
		expect(parseSiteActivityConfig(JSON.stringify({ threshold: 5000, days: 400, cooldown_hours: 99999 }))).toMatchObject({
			threshold: 1000,
			days: 180,
			cooldown_hours: 8760
		});
		expect(parseSiteActivityConfig('not json')).toEqual(defaultSiteActivityConfig());
		expect(parseSiteActivityConfig(null)).toEqual(defaultSiteActivityConfig());
	});
});

describe('site_activity trigger text', () => {
	const sites = (id: number) => (id === 7 ? 'Site X' : null);
	it('visits, any site, a week cooldown', () => {
		const cfg: SiteActivityConfig = { ...defaultSiteActivityConfig(), measure: 'visits' };
		expect(siteActivityTriggerText(cfg, sites)).toBe('Visits the site 10+ times in 30 days on any site · 7d cooldown');
	});
	it('pages with a path on a named site', () => {
		const cfg: SiteActivityConfig = { ...defaultSiteActivityConfig(), path: '/blog', days: 14, site_id: 7, cooldown_hours: 24 };
		expect(siteActivityTriggerText(cfg, sites)).toBe('Views 10+ pages containing “/blog” in 14 days on Site X · 24h cooldown');
		expect(siteActivityTriggerText({ ...cfg, cooldown_hours: 0 }, sites)).toContain('· no cooldown');
		expect(siteActivityTriggerText({ ...cfg, cooldown_hours: 12 }, sites)).toBe('Views 10+ pages containing “/blog” in 14 days on Site X · 12h cooldown');
		expect(siteActivityTriggerText({ ...cfg, site_id: 9 }, sites)).toContain('on (deleted site)');
	});
	it('triggerText reads trigger_config; the picker has the eighth card', () => {
		const a: TriggerFields = {
			trigger_type: 'site_activity',
			trigger_list_id: null,
			trigger_metric: null,
			trigger_direction: null,
			trigger_threshold: null,
			trigger_site_id: null,
			trigger_path_op: null,
			trigger_path: null,
			trigger_cooldown_hours: null,
			trigger_stage_id: null,
			trigger_config: JSON.stringify({ measure: 'visits', threshold: 10, days: 30, cooldown_hours: 168 }),
			reentry: 'once'
		};
		expect(triggerText(a, { lists: [], sites: [], stages: [] })).toBe('Visits the site 10+ times in 30 days on any site · 7d cooldown');
		expect(TRIGGER_TYPES.length).toBeGreaterThanOrEqual(8);
		expect(TRIGGER_TYPES[7]).toMatchObject({ type: 'site_activity', label: 'Visits the site often', icon: 'site-visit' });
	});
});

// ── D1 ───────────────────────────────────────────────────────────────────────────────────

let siteId: number;
let otherSiteId: number;
let contactId: number;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM site_visit_fires'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts')
	]);
	siteId = (await db
		.prepare(`INSERT INTO tracking_sites (name, domain, origins, site_key) VALUES ('DS', 'ourco.example', '[]', 'sk_434a') RETURNING id`)
		.first<{ id: number }>())!.id;
	otherSiteId = (await db
		.prepare(`INSERT INTO tracking_sites (name, domain, origins, site_key) VALUES ('Other', 'other.example.net', '[]', 'sk_434b') RETURNING id`)
		.first<{ id: number }>())!.id;
	contactId = (await db.prepare("INSERT INTO contacts (email) VALUES ('often@x.example.net') RETURNING id").first<{ id: number }>())!.id;
});

async function automation(cfg: Partial<SiteActivityConfig>, o: { status?: string; reentry?: string } = {}): Promise<number> {
	const config = { ...defaultSiteActivityConfig(), ...cfg };
	const id = (await db
		.prepare(`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry) VALUES ('Often', ?, 'site_activity', ?, ?) RETURNING id`)
		.bind(o.status ?? 'active', JSON.stringify(config), o.reentry ?? 'once')
		.first<{ id: number }>())!.id;
	await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
			 VALUES (?, 0, 'tag', 'add', 'browses-a-lot', '', '', '', 3600)`
		)
		.bind(id)
		.run();
	return id;
}

const passes = async (aid: number) =>
	(await db.prepare('SELECT status FROM automation_enrollments WHERE automation_id = ? ORDER BY id').bind(aid).all<{ status: string }>()).results;

/** Store a pageview at `at` (ms) and run the hook as /api/track does (row first, then the hook). */
async function view(at: number, path = '/pricing', site = siteId) {
	await db
		.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, path, occurred_at) VALUES (?, ?, 'pageview', 'pageview', ?, ?)`)
		.bind(site, contactId, path, sqlTime(at))
		.run();
	return fireSiteActivityTriggers(db, { siteId: site, contactId, path }, new Date(at));
}

describe('fireSiteActivityTriggers', () => {
	it('9 pageviews → nothing; the 10th enrolls; the 11th within the cooldown does not', async () => {
		const aid = await automation({});
		for (let i = 0; i < 9; i++) await view(T0 + i * MIN);
		expect(await passes(aid)).toHaveLength(0);
		const s = await view(T0 + 9 * MIN);
		expect(s.enrolled).toBe(1);
		expect(await passes(aid)).toHaveLength(1);
		const s2 = await view(T0 + 10 * MIN);
		expect(s2.cooling).toBe(1);
		expect(await passes(aid)).toHaveLength(1);
	});

	it('after the cooldown, re-entry multiple enrolls again', async () => {
		const aid = await automation({ cooldown_hours: 24 }, { reentry: 'multiple' });
		for (let i = 0; i < 10; i++) await view(T0 + i * MIN);
		expect(await passes(aid)).toHaveLength(1);
		await db.prepare("UPDATE automation_enrollments SET status = 'completed', ended_at = ? WHERE automation_id = ?").bind(sqlTime(T0 + HOUR), aid).run();
		await view(T0 + 12 * HOUR); // still cooling
		expect(await passes(aid)).toHaveLength(1);
		await view(T0 + 25 * HOUR); // 10+ pages in the window, cooldown over
		expect(await passes(aid)).toHaveLength(2);
	});

	it('visits: three bursts two hours apart = 3 visits', async () => {
		const aid = await automation({ measure: 'visits', threshold: 3 });
		for (const burst of [0, 2, 4]) {
			for (let i = 0; i < 4; i++) await view(T0 + burst * HOUR + i * 5 * MIN);
			if (burst < 4) expect(await passes(aid)).toHaveLength(0);
		}
		expect(await passes(aid)).toHaveLength(1);
	});

	it('the path filter leaves non-matching pages out (and they never fire it)', async () => {
		const aid = await automation({ threshold: 3, path: '/blog' });
		for (let i = 0; i < 5; i++) await view(T0 + i * MIN, '/pricing');
		await view(T0 + 6 * MIN, '/blog/a');
		await view(T0 + 7 * MIN, '/blog/b');
		expect(await passes(aid)).toHaveLength(0);
		await view(T0 + 8 * MIN, '/blog/c');
		expect(await passes(aid)).toHaveLength(1);
	});

	it('a site filter only counts that site; old pageviews fall out of the window', async () => {
		const aid = await automation({ threshold: 2, days: 7, site_id: siteId });
		await view(T0 - 8 * 24 * HOUR); // outside the 7-day window
		await view(T0, '/x', otherSiteId); // other site
		expect(await passes(aid)).toHaveLength(0);
		await view(T0 + MIN);
		expect(await passes(aid)).toHaveLength(0);
		await view(T0 + 2 * MIN);
		expect(await passes(aid)).toHaveLength(1);
	});

	it('a paused automation records a pending trigger instead of enrolling; drafts are ignored', async () => {
		const paused = await automation({ threshold: 2 }, { status: 'paused' });
		const draft = await automation({ threshold: 2 }, { status: 'draft' });
		await view(T0);
		expect(await db.prepare('SELECT COUNT(*) AS n FROM automation_pending_triggers WHERE automation_id = ?').bind(paused).first<{ n: number }>()).toEqual({ n: 0 });
		await view(T0 + MIN);
		const pending = await db
			.prepare('SELECT contact_id, source FROM automation_pending_triggers WHERE automation_id = ?')
			.bind(paused)
			.all<{ contact_id: number; source: string }>();
		expect(pending.results).toEqual([{ contact_id: contactId, source: 'site_activity' }]);
		expect(await passes(paused)).toHaveLength(0);
		expect(await passes(draft)).toHaveLength(0);
	});

	it('entry conditions apply (a tag the contact lacks blocks enrollment)', async () => {
		const aid = await automation({ threshold: 1 });
		await db
			.prepare('UPDATE automations SET entry_rules = ? WHERE id = ?')
			.bind(JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: 'vip' }] }), aid)
			.run();
		await view(T0);
		expect(await passes(aid)).toHaveLength(0);
	});
});

describe('write layer', () => {
	it('setTrigger stores the config, clears it when the type changes, refuses bad input', async () => {
		const aid = (await db.prepare("INSERT INTO automations (name, status, trigger_type) VALUES ('W', 'draft', 'manual') RETURNING id").first<{ id: number }>())!.id;
		const actor = { kind: 'user' as const };
		const ok = await setTrigger(db, aid, { type: 'site_activity', measure: 'visits', threshold: 5, days: 14, site_id: siteId }, actor);
		expect(ok.ok).toBe(true);
		const row = await db.prepare('SELECT trigger_type, trigger_config, trigger_site_id FROM automations WHERE id = ?').bind(aid).first<Record<string, unknown>>();
		expect(row!.trigger_type).toBe('site_activity');
		expect(row!.trigger_site_id).toBeNull();
		expect(JSON.parse(String(row!.trigger_config))).toEqual({
			measure: 'visits',
			threshold: 5,
			days: 14,
			site_id: siteId,
			path_op: 'contains',
			path: '',
			cooldown_hours: 168
		});
		const spec = await readSpec(db, aid);
		expect(spec.ok && spec.data.trigger).toMatchObject({ type: 'site_activity', measure: 'visits', threshold: 5, days: 14, site_id: siteId });

		expect((await setTrigger(db, aid, { type: 'site_activity', days: 365 }, actor)).ok).toBe(false);
		expect((await setTrigger(db, aid, { type: 'site_activity', site_id: 999999 }, actor)).ok).toBe(false);

		await setTrigger(db, aid, { type: 'manual' }, actor);
		const cleared = await db.prepare('SELECT trigger_config FROM automations WHERE id = ?').bind(aid).first<{ trigger_config: string | null }>();
		expect(cleared!.trigger_config).toBeNull();
	});

	it('activation check accepts a valid stored config and flags a deleted site', async () => {
		const cols = {
			trigger_type: 'site_activity',
			trigger_list_id: null,
			trigger_metric: null,
			trigger_direction: null,
			trigger_threshold: null,
			trigger_site_id: null,
			trigger_path_op: null,
			trigger_path: null,
			trigger_cooldown_hours: null,
			trigger_stage_id: null,
			trigger_config: JSON.stringify({ ...defaultSiteActivityConfig(), site_id: siteId })
		};
		expect(await storedTriggerProblem(db, cols)).toBeNull();
		await db.prepare('DELETE FROM tracking_sites WHERE id = ?').bind(siteId).run();
		expect(await storedTriggerProblem(db, cols)).toMatch(/tracking site/);
	});
});

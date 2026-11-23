// #468 (Scoring 3/3): the Score distribution / movers / rule activity built-ins, their
// readback, and the dashboard Scores module — against an empty DB and a seeded ledger.
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { builtInByKey, resolveParams, runBuiltIn } from '../src/lib/server/reports/builtins';
import { computePairs, markPairsDirty, type Pair } from '../src/lib/server/scoring/engine';
import { distributionRows, scoresOverview } from '../src/lib/server/scoring/reports';
import { scoreReportReadback } from '../src/lib/report-nl';
import { load as loadBuiltIn } from '../src/routes/reports/b/[key]/+page.server';
import dashboardSource from '../src/routes/+page.svelte?raw';

const db = (env as { DB: D1Database }).DB;
const admin = { role: 'admin' as const };
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

async function report(key: string, params: Record<string, string> = {}) {
	const def = builtInByKey(key)!;
	const source = new URLSearchParams(Object.entries(params).map(([k, v]) => [`p_${k}`, v]));
	return runBuiltIn(db, def, resolveParams(def, source), admin, NOW);
}

function pageEvent(path: string) {
	const url = new URL(`https://crm.test${path}`);
	const key = url.pathname.split('/').pop()!;
	return { request: new Request(url), url, params: { key }, locals: { user: { id: 1, role: 'admin' } }, platform: { env } } as any;
}

describe('#468 empty DB', () => {
	it('each scoring report runs on the seeded Lead score with nothing in it', async () => {
		expect((await report('score-distribution')).rows).toEqual([]);
		expect((await report('score-movers')).rows).toEqual([]);
		const rules = await report('score-rule-activity');
		expect(rules.rows.length).toBeGreaterThan(0);
		expect(rules.rows.every((r) => r.awarded === 0 && r.share === null)).toBe(true);
		expect(rules.rows.map((r) => r.rule)).toContain('Opened an email');
	});

	it('buckets: 10-point ranges when a score has no bands', () => {
		expect(distributionRows([], [])).toEqual([]);
		const rows = distributionRows(
			[
				{ value: 3, n: 2 },
				{ value: 27, n: 1 },
				{ value: -4, n: 1 }
			],
			[]
		);
		expect(rows.map((r) => [r.label, r.contacts])).toEqual([
			['-10–-1', 1],
			['0–9', 2],
			['10–19', 0],
			['20–29', 1]
		]);
	});
});

describe('#468 seeded ledger', () => {
	let scoreId = 0;
	let clicked = 0;
	let opened = 0;
	let ann = 0;
	let bob = 0;
	let cat = 0;

	beforeAll(async () => {
		const s = await db
			.prepare(
				`INSERT INTO score_defs (name, slug, status, decay_mode, bands, position)
				 VALUES ('Test 468', 'test-468', 'active', 'expire', '[{"label":"Hot","min":20},{"label":"Warm","min":5}]', 5) RETURNING id`
			)
			.first<{ id: number }>();
		scoreId = s!.id;
		const rule = (label: string, type: string, pts: number, pos: number) =>
			db
				.prepare(`INSERT INTO score_rules (score_id, kind, label, event_type, points, position) VALUES (?, 'event', ?, ?, ?, ?) RETURNING id`)
				.bind(scoreId, label, type, pts, pos)
				.first<{ id: number }>()
				.then((r) => r!.id);
		clicked = await rule('Clicked', 'email_click', 5, 0);
		opened = await rule('Opened', 'email_open', 1, 1);
		const contact = (email: string, archived = false) =>
			db
				.prepare(`INSERT INTO contacts (email, name, subscribed, archived_at) VALUES (?, ?, 1, ?) RETURNING id`)
				.bind(email, email.split('@')[0], archived ? NOW.toISOString() : null)
				.first<{ id: number }>()
				.then((r) => r!.id);
		ann = await contact('ann468@example.com');
		bob = await contact('bob468@example.com');
		cat = await contact('cat468@example.com');
		const dan = await contact('dan468@example.com', true);
		let n = 0;
		const point = (contactId: number, ruleId: number | null, pts: number, earned: string, expires: string | null = null) =>
			db
				.prepare(
					`INSERT INTO score_points (score_id, rule_id, contact_id, points, source_type, source_id, earned_at, expires_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(scoreId, ruleId, contactId, pts, ruleId ? 'events' : 'manual', `s${++n}`, earned, expires)
				.run();
		for (let d = 1; d <= 5; d++) await point(ann, clicked, 5, daysAgo(d)); // 25, all this week
		await point(bob, clicked, 5, daysAgo(60)); // held
		await point(bob, opened, 1, daysAgo(40), daysAgo(3)); // expired this week
		await point(cat, null, 3, daysAgo(1)); // manual
		await point(dan, clicked, 50, daysAgo(1)); // archived: left out
		const pairs: Pair[] = [ann, bob, cat, dan].map((c) => [c, scoreId]);
		await markPairsDirty(db, pairs, NOW);
		await computePairs(db, pairs, NOW);
	});

	it('distribution: contacts per band, "No band" below the lowest, top contacts linked', async () => {
		const r = await report('score-distribution', { score: 'test-468' });
		expect(r.rows).toEqual([
			{ band: 'Hot', range: '20+', contacts: 1, share: 33.3 },
			{ band: 'Warm', range: '5–19', contacts: 1, share: 33.3 },
			{ band: 'No band', range: 'under 5', contacts: 1, share: 33.3 }
		]);
		expect(r.chartSeries?.xKey).toBe('band');
		expect(r.secondary?.rows.map((x) => x.value)).toEqual([25, 5, 3]);
		expect(r.secondary?.links?.email).toEqual([`/contacts/${ann}`, `/contacts/${bob}`, `/contacts/${cat}`]);
	});

	it('movers: change in range, current value and the main rule', async () => {
		const r = await report('score-movers', { score: 'test-468', range: '7' });
		expect(r.rows).toEqual([
			{ email: 'ann468@example.com', name: 'ann468', value: 25, delta: 25, top_rule: 'Clicked', top_rule_points: 25 },
			{ email: 'cat468@example.com', name: 'cat468', value: 3, delta: 3, top_rule: 'Manual adjustments', top_rule_points: 3 },
			{ email: 'bob468@example.com', name: 'bob468', value: 5, delta: -1, top_rule: 'Opened', top_rule_points: -1 }
		]);
		expect(r.links?.email[0]).toBe(`/contacts/${ann}`);
		const quarter = await report('score-movers', { score: 'test-468', range: '90' });
		expect(quarter.rows.find((x) => x.email === 'bob468@example.com')?.delta).toBe(5);
	});

	it('rule activity: points, awards, contacts and share per rule', async () => {
		const week = await report('score-rule-activity', { score: 'test-468', range: '7' });
		expect(week.rows.map((x) => [x.rule, x.awarded, x.awards, x.contacts, x.share])).toEqual([
			['Clicked', 25, 5, 1, 89.3],
			['Opened', 0, 0, 0, 0],
			['Manual adjustments', 3, 1, 1, 10.7]
		]);
		const quarter = await report('score-rule-activity', { score: 'test-468', range: '90' });
		expect(quarter.rows.map((x) => [x.rule, x.awarded, x.contacts])).toEqual([
			['Clicked', 30, 2],
			['Opened', 1, 1],
			['Manual adjustments', 3, 1]
		]);
	});

	it('an unknown score slug falls back to the first active score', async () => {
		const r = await report('score-distribution', { score: 'nope' });
		expect(r.note).toMatch(/^Lead score/);
	});

	it('the built-in page shows the score picker value and a readback', async () => {
		const page = await loadBuiltIn(pageEvent('/reports/b/score-movers?p_score=test-468&p_range=7'));
		expect(page.error).toBeNull();
		expect(page.pickers.scores.map((s) => s.slug)).toContain('test-468');
		expect(page.builtIn?.readback).toBe(scoreReportReadback('score-movers', { score: 'test-468', range: '7' }, 'Test 468'));
		expect(page.builtIn?.readback).toMatch(/Test 468 changed the most in the last 7 days/);
		expect(scoreReportReadback('campaign-performance', {}, null)).toBeNull();
	});

	it('dashboard: band counts and contacts that moved band in 7 days', async () => {
		const overview = (await scoresOverview(db, NOW)).find((s) => s.slug === 'test-468')!;
		expect(overview.total).toBe(3);
		expect(overview.bands.map((b) => [b.label, b.contacts])).toEqual([
			['Hot', 1],
			['Warm', 1],
			['No band', 1]
		]);
		// ann 0 → Hot and bob 0 → Warm changed band; cat stayed below every band.
		expect(overview.moved).toBe(2);
		expect(dashboardSource).toContain('<ScoresOverview');
	});
});

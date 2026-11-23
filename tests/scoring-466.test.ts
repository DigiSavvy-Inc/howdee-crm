// #466 (Scoring 1/3): score definitions + rules, the ledger, the engine in the tick,
// Settings → Scoring (admin-only) and the contact page's Adjust action.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	EVENT_TYPES,
	SOURCE_TABLES,
	bandFor,
	parseBands,
	slugify,
	validateAdjust,
	validateRule,
	validateScore,
	decayText
} from '../src/lib/scoring';
import { createRule, createScore, deleteRule, listRules, updateRule } from '../src/lib/server/scoring/store';
import {
	computePairs,
	ingestBacklog,
	processConditions,
	queueConditionRules,
	rebuildScore,
	runScoringJob,
	setWatermarks,
	type Watermarks
} from '../src/lib/server/scoring/engine';
import { contactScores } from '../src/lib/server/scoring/contact';
import * as listPage from '../src/routes/settings/scoring/+page.server';
import * as editPage from '../src/routes/settings/scoring/[id]/+page.server';
import * as contactPage from '../src/routes/contacts/[id]/+page.server';
import { POST as tickPOST } from '../src/routes/api/automations/tick/+server';

const db = (env as any).DB as D1Database;

let admin: any;
let member: any;
let seq = 0;

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function makeUser(login: string, role: 'admin' | 'member') {
	const r = await db.prepare('INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id').bind(login, role).first<{ id: number }>();
	return sessionUser({ id: r!.id, github_login: login, role });
}

function ev(path: string, action: string | null, opts: { user: any; params?: Record<string, string>; form?: Record<string, string> }) {
	const url = new URL(`https://app.test${path}${action ? `?/${action}` : ''}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(opts.form ?? {})) fd.append(k, v);
	return {
		url,
		params: opts.params ?? {},
		request: new Request(url, action ? { method: 'POST', body: fd } : undefined),
		locals: { user: opts.user, authed: !!opts.user },
		platform: { env: env as any }
	} as any;
}

async function thrown(fn: () => Promise<unknown>): Promise<any> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return null;
}

async function contact(): Promise<number> {
	seq++;
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(`score-${seq}-${Date.now()}@test.example.net`).first<{ id: number }>())!.id;
}

async function list(kind: 'list' | 'tag', name = `L-${++seq}-${Date.now()}`): Promise<number> {
	return (await db.prepare('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id').bind(name, kind).first<{ id: number }>())!.id;
}

async function score(over: Partial<{ name: string; decay_mode: string; half_life_days: string; bands: string }> = {}): Promise<number> {
	const v = validateScore({ name: over.name ?? `Test score ${++seq}`, decay_mode: over.decay_mode ?? 'expire', half_life_days: over.half_life_days, bands: over.bands ?? '[]' });
	if (!v.ok) throw new Error(v.error);
	const r = await createScore(db, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

async function rule(scoreId: number, raw: Record<string, unknown>, decay: 'expire' | 'half_life' | 'none' = 'expire'): Promise<number> {
	const v = validateRule(raw, decay);
	if (!v.ok) throw new Error(v.error);
	const r = await createRule(db, scoreId, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

/** Watermarks at the newest row of every source, so only rows added after this are read. */
async function watermarksToNow(): Promise<void> {
	const wm: Watermarks = {};
	for (const s of SOURCE_TABLES) {
		const col = s === 'list_members' ? 'rowid' : 'id';
		wm[s] = (await db.prepare(`SELECT COALESCE(MAX(${col}), 0) AS m FROM ${s}`).first<{ m: number }>())!.m;
	}
	await setWatermarks(db, wm);
}

async function ledger(scoreId: number, contactId: number) {
	return (
		await db.prepare('SELECT * FROM score_points WHERE score_id = ? AND contact_id = ? ORDER BY id').bind(scoreId, contactId).all<any>()
	).results;
}

async function value(scoreId: number, contactId: number): Promise<{ value: number; band: string | null } | null> {
	await computePairs(db, [[contactId, scoreId]]);
	return db.prepare('SELECT value, band FROM contact_scores WHERE score_id = ? AND contact_id = ?').bind(scoreId, contactId).first();
}

async function drainConditions(now = new Date()) {
	for (let i = 0; i < 20; i++) {
		const r = await processConditions(db, now);
		if (!r) break;
	}
}

async function event(contactId: number, type: string, detail: unknown = {}, ago = "-0 seconds", campaignId: number | null = null) {
	await db
		.prepare(`INSERT INTO events (contact_id, campaign_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, datetime('now', ?))`)
		.bind(contactId, campaignId, type, JSON.stringify(detail), ago)
		.run();
}

beforeAll(async () => {
	admin = await makeUser(`scoring-admin-${Date.now()}`, 'admin');
	member = await makeUser(`scoring-member-${Date.now()}`, 'member');
	// Get the seeded rebuild + daily condition run out of the way.
	await runScoringJob(db);
	await drainConditions();
});

describe('catalogue + validation', () => {
	it('lists every event type with a source table and filter keys', () => {
		expect(EVENT_TYPES.map((e) => e.type)).toEqual([
			'email_open',
			'email_open_proxy',
			'email_click',
			'email_bounce',
			'email_spam',
			'unsubscribe',
			'email_reply',
			'form_submit',
			'crm_form_submit',
			'site_pageview',
			'site_event',
			'pipeline_stage_entered',
			'automation_completed',
			'list_added'
		]);
		for (const e of EVENT_TYPES) expect(SOURCE_TABLES).toContain(e.source);
		expect(EVENT_TYPES.find((e) => e.type === 'email_click')!.filters).toContain('url_contains');
	});

	it('validates scores', () => {
		expect(validateScore({ name: '' }).ok).toBe(false);
		expect(validateScore({ name: 'x', decay_mode: 'half_life' }).ok).toBe(false);
		const ok = validateScore({ name: 'Fit', decay_mode: 'half_life', half_life_days: '30', bands: '[{"label":"Low","min":0},{"label":"High","min":10}]' });
		expect(ok.ok && ok.value.bands.map((b) => b.label)).toEqual(['High', 'Low']);
		expect(validateScore({ name: 'x', bands: '[{"label":"A","min":1},{"label":"B","min":1}]' }).ok).toBe(false);
	});

	it('validates rules: points range, filters, expiry, condition kinds', () => {
		expect(validateRule({ kind: 'event', event_type: 'email_click', points: '0' }).ok).toBe(false);
		expect(validateRule({ kind: 'event', event_type: 'email_click', points: '1001' }).ok).toBe(false);
		expect(validateRule({ kind: 'event', event_type: 'email_click', points: '-1000' }).ok).toBe(true);
		expect(validateRule({ kind: 'event', event_type: 'nope', points: '5' }).ok).toBe(false);
		expect(validateRule({ kind: 'event', event_type: 'email_reply', points: '5', filter: '{"url_contains":"x"}' }).ok).toBe(false);
		expect(validateRule({ kind: 'event', event_type: 'email_click', points: '5', expires_days: '4000' }).ok).toBe(false);
		const r = validateRule({ kind: 'event', event_type: 'email_click', points: '5', expires_days: '30' }, 'half_life');
		expect(r.ok && r.value.expires_days).toBe(null);
		expect(validateRule({ kind: 'condition', points: '5', rules: '{"match":"all","rules":[{"field":"tag","op":"has","value":"vip"}]}' }).ok).toBe(true);
		expect(validateRule({ kind: 'condition', points: '5', rules: '{"match":"all","rules":[{"field":"email","op":"contains","value":"x"}]}' }).ok).toBe(false);
		expect(validateRule({ kind: 'condition', points: '5', rules: '{"match":"all","rules":[]}' }).ok).toBe(false);
	});

	it('bands, slugs, decay words, adjust validation', () => {
		const bands = parseBands('[{"label":"Cool","min":1},{"label":"Hot","min":50},{"label":"Warm","min":20}]');
		expect(bandFor(60, bands)).toBe('Hot');
		expect(bandFor(20, bands)).toBe('Warm');
		expect(bandFor(0, bands)).toBe(null);
		expect(bandFor(-5, [{ label: 'Neg', min: -10 }])).toBe('Neg');
		expect(slugify('Lead Score — 2026!')).toBe('lead-score-2026');
		expect(decayText('half_life', 60)).toBe('half-life 60 days');
		expect(decayText('expire', null)).toBe('points expire per rule');
		expect(decayText('none', null)).toBe('permanent');
		expect(validateAdjust({ points: '0' }).ok).toBe(false);
		expect(validateAdjust({ points: '-5', expires_days: '10', note: 'call' }).ok).toBe(true);
	});
});

describe('seeded defaults', () => {
	it('has the two default scores, active, with their rules', async () => {
		const rows = (await db.prepare("SELECT id, slug, status, is_default FROM score_defs WHERE is_default = 1 ORDER BY position").all<any>()).results;
		expect(rows.map((r) => r.slug)).toEqual(['lead-score', 'likely-to-churn']);
		expect(rows.every((r) => r.status === 'active')).toBe(true);
		const lead = await listRules(db, rows[0].id);
		const churn = await listRules(db, rows[1].id);
		expect(lead.length).toBe(10); // 9 seeded by 0107 + "Submitted a CRM form" (0125, #621)
		expect(churn.filter((r) => r.kind === 'condition').map((r) => JSON.parse(r.rules!).rules[0].field)).toEqual([
			'engagement_tier',
			'last_open_within_days'
		]);
		expect(await db.prepare("SELECT value FROM app_state WHERE key = 'scoring_seeded_rebuild'").first()).toBeTruthy();
	});
});

describe('ingest', () => {
	it('awards once per source row and honours filters', async () => {
		const s = await score();
		await rule(s, { kind: 'event', event_type: 'email_click', points: '5', filter: '{"url_contains":"pricing"}' });
		const c = await contact();
		await watermarksToNow();
		await event(c, 'click', { OriginalLink: 'https://x.test/pricing' });
		await event(c, 'click', { OriginalLink: 'https://x.test/blog' });
		await event(c, 'click', { OriginalLink: 'https://x.test/PRICING/plans' });
		const res = await runScoringJob(db);
		expect(res.ingested.events).toBeGreaterThanOrEqual(3);
		expect((await ledger(s, c)).length).toBe(2);
		// Reading the same rows again adds nothing.
		const first = (await db.prepare('SELECT MIN(id) AS m FROM events WHERE contact_id = ?').bind(c).first<{ m: number }>())!.m;
		await watermarksToNow();
		await setWatermarks(db, { ...(JSON.parse((await db.prepare("SELECT value FROM app_state WHERE key = 'scoring_watermarks'").first<{ value: string }>())!.value)), events: first - 1 });
		await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(2);
		expect((await value(s, c))?.value).toBe(10);
	});

	it('filters email events by campaign', async () => {
		const s = await score();
		const camp = (
			await db
				.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('S', 'b', 'b', 'a@test.example.net', 'sent') RETURNING id")
				.first<{ id: number }>()
		)!.id;
		await rule(s, { kind: 'event', event_type: 'email_open', points: '3', filter: JSON.stringify({ campaign_id: camp }) });
		const c = await contact();
		await watermarksToNow();
		await event(c, 'open', { UserAgent: 'Chrome' }, '-0 seconds', camp);
		await event(c, 'open', { UserAgent: 'Chrome' }, '-0 seconds', null);
		await event(c, 'open', { UserAgent: 'Mozilla/5.0 Mail/3826' }, '-0 seconds', camp); // proxy open
		await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(1);
	});

	it('`once` keeps only the first match per contact', async () => {
		const s = await score();
		await rule(s, { kind: 'event', event_type: 'email_reply', points: '10', once: 'on' });
		const c = await contact();
		await watermarksToNow();
		for (let i = 0; i < 3; i++)
			await db.prepare("INSERT INTO replies (contact_id, from_email, received_at) VALUES (?, 'x@test.example.net', datetime('now'))").bind(c).run();
		await runScoringJob(db);
		await db.prepare("INSERT INTO replies (contact_id, from_email, received_at) VALUES (?, 'x@test.example.net', datetime('now'))").bind(c).run();
		await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(1);
	});

	it('`max_per_day` caps the rows per UTC day', async () => {
		const s = await score();
		await rule(s, { kind: 'event', event_type: 'list_added', points: '2', max_per_day: '2' });
		const c = await contact();
		await watermarksToNow();
		for (let i = 0; i < 3; i++) {
			const l = await list('list');
			await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(l, c).run();
		}
		await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(2);
	});

	it('form submits join webhook_events by email', async () => {
		const s = await score();
		await rule(s, { kind: 'event', event_type: 'form_submit', points: '20' });
		const c = await contact();
		const email = (await db.prepare('SELECT email FROM contacts WHERE id = ?').bind(c).first<{ email: string }>())!.email;
		await watermarksToNow();
		await db.prepare("INSERT INTO webhook_events (email, status) VALUES (?, 'added')").bind(email.toUpperCase()).run();
		await db.prepare("INSERT INTO webhook_events (email, status) VALUES (?, 'rejected')").bind(email).run();
		await runScoringJob(db);
		expect((await ledger(s, c)).map((r) => r.source_type)).toEqual(['webhook_events']);
	});
});

describe('expiry and decay', () => {
	it('expired rows leave the cache but stay in the ledger', async () => {
		const s = await score();
		await rule(s, { kind: 'event', event_type: 'email_click', points: '5', expires_days: '1' });
		const c = await contact();
		await watermarksToNow();
		await event(c, 'click', { OriginalLink: 'https://x.test/a' }, '-3 days');
		await event(c, 'click', { OriginalLink: 'https://x.test/b' });
		await runScoringJob(db);
		const rows = await ledger(s, c);
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.expires_at)).toBe(true);
		expect((await value(s, c))?.value).toBe(5);
		// Later the second one expires too; the sweep marks the contact dirty and the value drops.
		const later = new Date(Date.now() + 2 * 86_400_000);
		await runScoringJob(db, later);
		await computePairs(db, [[c, s]], later);
		const row = await db.prepare('SELECT value FROM contact_scores WHERE score_id = ? AND contact_id = ?').bind(s, c).first<{ value: number }>();
		expect(row?.value).toBe(0);
		expect((await ledger(s, c)).length).toBe(2);
	});

	it('half-life halves a point after one half-life', async () => {
		const s = await score({ decay_mode: 'half_life', half_life_days: '10' });
		await rule(s, { kind: 'event', event_type: 'email_reply', points: '100' }, 'half_life');
		const c = await contact();
		await watermarksToNow();
		await db.prepare("INSERT INTO replies (contact_id, from_email, received_at) VALUES (?, 'x@test.example.net', datetime('now', '-10 days'))").bind(c).run();
		await runScoringJob(db);
		const v = (await value(s, c))!.value;
		expect(v).toBeGreaterThanOrEqual(49);
		expect(v).toBeLessThanOrEqual(50);
		expect((await ledger(s, c))[0].expires_at).toBe(null);
	});
});

describe('condition rules', () => {
	it('adds points while the contact matches and removes them when it stops', async () => {
		const s = await score();
		const tagName = `vip-${Date.now()}`;
		const tag = await list('tag', tagName);
		const c = await contact();
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(tag, c).run();
		const r = await rule(s, { kind: 'condition', points: '7', rules: JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: tagName }] }) });
		await drainConditions();
		let rows = await ledger(s, c);
		expect(rows.map((x) => [x.source_type, x.source_id, x.points])).toEqual([['condition', String(r), 7]]);
		expect((await value(s, c))?.value).toBe(7);

		// Points change on save.
		const v = validateRule({ kind: 'condition', points: '9', rules: JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: tagName }] }) });
		if (v.ok) await updateRule(db, r, v.value);
		await drainConditions();
		expect((await value(s, c))?.value).toBe(9);

		await db.prepare('DELETE FROM list_members WHERE list_id = ? AND contact_id = ?').bind(tag, c).run();
		await queueConditionRules(db, [r]);
		await drainConditions();
		rows = await ledger(s, c);
		expect(rows.length).toBe(0);
		expect((await value(s, c))?.value).toBe(0);
	});

	it('deleting a rule removes its points', async () => {
		const s = await score();
		const r = await rule(s, { kind: 'event', event_type: 'email_click', points: '4' });
		const c = await contact();
		await watermarksToNow();
		await event(c, 'click', { OriginalLink: 'https://x.test/a' });
		await runScoringJob(db);
		expect((await value(s, c))?.value).toBe(4);
		await deleteRule(db, r);
		expect((await value(s, c))?.value).toBe(0);
	});
});

describe('bands and rebuild', () => {
	it('stores the band with the value', async () => {
		const s = await score({ bands: '[{"label":"Hot","min":10},{"label":"Warm","min":3}]' });
		await rule(s, { kind: 'event', event_type: 'email_click', points: '5' });
		const c = await contact();
		await watermarksToNow();
		await event(c, 'click', { OriginalLink: 'https://x.test/a' });
		await runScoringJob(db);
		expect(await value(s, c)).toMatchObject({ value: 5, band: 'Warm' });
		await event(c, 'click', { OriginalLink: 'https://x.test/b' });
		await runScoringJob(db);
		expect(await value(s, c)).toMatchObject({ value: 10, band: 'Hot' });
	});

	it('rebuild replays history through a rule added later', async () => {
		const c = await contact();
		await watermarksToNow();
		await event(c, 'click', { OriginalLink: 'https://x.test/old' }, '-20 days');
		await runScoringJob(db); // read before the score existed
		const s = await score();
		await rule(s, { kind: 'event', event_type: 'email_click', points: '6' });
		await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(0);
		await rebuildScore(db, s);
		const backlog = await ingestBacklog(db);
		expect(backlog.events).toBeGreaterThan(0);
		for (let i = 0; i < 20 && (await ingestBacklog(db)).events > 0; i++) await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(1);
		expect((await value(s, c))?.value).toBe(6);
	});
});

describe('Settings → Scoring permissions', () => {
	it('members get 403 on the pages and every action', async () => {
		expect((await thrown(() => listPage.load(ev('/settings/scoring', null, { user: member })) as Promise<unknown>))?.status).toBe(403);
		expect((await thrown(() => editPage.load(ev('/settings/scoring/new', null, { user: member, params: { id: 'new' } })) as Promise<unknown>))?.status).toBe(403);
		for (const a of ['status', 'rebuild', 'delete'] as const) {
			const r: any = await (listPage.actions as any)[a](ev('/settings/scoring', a, { user: member, form: { id: '1' } }));
			expect(r.status).toBe(403);
		}
		for (const a of ['save', 'saveRule', 'deleteRule', 'moveRule', 'rebuild'] as const) {
			const r: any = await (editPage.actions as any)[a](ev('/settings/scoring/1', a, { user: member, params: { id: '1' }, form: { name: 'x' } }));
			expect(r.status).toBe(403);
		}
	});

	it('admins can load, create a score and add a rule', async () => {
		const data: any = await listPage.load(ev('/settings/scoring', null, { user: admin }));
		expect(data.scores.length).toBeGreaterThanOrEqual(2);
		expect(data.engagement.halfLifeDays).toBeGreaterThan(0);
		const red = await thrown(() =>
			(editPage.actions as any).save(ev('/settings/scoring/new', 'save', { user: admin, params: { id: 'new' }, form: { name: 'Admin made', decay_mode: 'none', bands: '[]' } }))
		);
		expect(red?.status).toBe(303);
		const id = (await db.prepare("SELECT id FROM score_defs WHERE name = 'Admin made'").first<{ id: number }>())!.id;
		const r: any = await (editPage.actions as any).saveRule(
			ev(`/settings/scoring/${id}`, 'saveRule', { user: admin, params: { id: String(id) }, form: { kind: 'event', event_type: 'email_reply', points: '3', active: 'on' } })
		);
		expect(r.ruleDone).toBeTruthy();
		expect((await listRules(db, id)).length).toBe(1);
		const page: any = await editPage.load(ev(`/settings/scoring/${id}`, null, { user: admin, params: { id: String(id) } }));
		expect(page.rules.length).toBe(1);
	});
});

describe('contact page', () => {
	it('adjustScore writes a manual row and recomputes (admin only)', async () => {
		const s = await score();
		const c = await contact();
		const denied: any = await (contactPage.actions as any).adjustScore(
			ev(`/contacts/${c}`, 'adjustScore', { user: member, params: { id: String(c) }, form: { score_id: String(s), points: '5' } })
		);
		expect(denied.status).toBe(403);
		const ok: any = await (contactPage.actions as any).adjustScore(
			ev(`/contacts/${c}`, 'adjustScore', { user: admin, params: { id: String(c) }, form: { score_id: String(s), points: '12', expires_days: '30', note: 'Call went well' } })
		);
		expect(ok.scoreOk).toBe(true);
		const rows = await ledger(s, c);
		expect(rows.map((r) => [r.source_type, r.points, r.rule_id])).toEqual([['manual', 12, null]]);
		expect(rows[0].note).toContain('Call went well');
		expect(rows[0].expires_at).toBeTruthy();
		const card = (await contactScores(db, c)).find((x) => x.score_id === s)!;
		expect(card.value).toBe(12);
		expect(card.history[0].source_type).toBe('manual');
		// Rebuild keeps manual rows.
		await rebuildScore(db, s);
		expect((await ledger(s, c)).length).toBe(1);
	});
});

describe('tick', () => {
	it('returns the scoring result', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 503 }));
		try {
			const url = new URL('https://app.test/api/automations/tick');
			const res = await tickPOST({
				url,
				params: {},
				request: new Request(url, { method: 'POST', headers: { authorization: 'Bearer tick-key' } }),
				locals: {},
				platform: {
					env: { ...(env as any), CRON_KEY: 'tick-key', POSTMARK_TOKEN: 'test', SESSION_SECRET: 'secret', POSTMARK_STREAM: 'broadcast' }
				}
			} as any);
			const body: any = await res.json();
			expect(body.scoring).toBeTruthy();
			expect(body.scoring.error).toBeUndefined();
			expect(typeof body.scoring.computed).toBe('number');
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';

// #479: automatic link checks (classification, retry, DNS, merge-tag samples), the pre-send
// policy (levels, Warn only / Block / Strict, who may "Send anyway"), the scheduled-send
// re-check with its keep-trying window and hold, Re-check now / Send anyway, and the compose
// send gate running the link check itself.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { classifyProbe, extractLinks, linkProbeChecks, softenLiveLinks, SCHEDULE_LINK_NOTE, MERGE_AT_COMPOSE_ID, summarize, type Check, type LinkProbe } from '../src/lib/presend-checks';
import { applyPolicy, canSendAnyway, heldSummary, normalizePolicy, checkerErrorReport, DEFAULT_POLICY, CHECK_CATALOG, CHECKER_ERROR_ID, type LevelOverride, type PresendPolicy } from '../src/lib/presend-policy';
import { checkLinks, isDnsFailure, fetchBudget, takeFetch, linkLimiter, type Fetcher } from '../src/lib/server/link-check';
import { liveLinkChecks, fillHref } from '../src/lib/server/presend-checks';
import { getPresendPolicy, savePresendPolicy } from '../src/lib/server/presend-policy';
import { processScheduledCampaigns, fetchSlice, dueScheduled, claimScheduledCampaign } from '../src/lib/server/scheduled';
import {
	recheckHeld,
	sendAnywayHeld,
	preflightHolds,
	holdPayload,
	holdEmail,
	decidePreflight,
	sqlTime,
	preflightScheduled,
	preflightHoldRefusal,
	notifyHeldSends,
	DELIVERABILITY_HOLD_MESSAGE
} from '../src/lib/server/preflight';
import { heldCampaigns, releaseHeldCampaign, holdScheduledForList } from '../src/lib/server/deliverability-alerts';
import { reopenAsDraft } from '../src/lib/server/campaign-drafts';
import type { SendableRow } from '../src/lib/server/segments';
import { actions as compose } from '../src/routes/compose/+page.server';
import { actions as campaignPage } from '../src/routes/campaign/[id]/+page.server';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), POSTMARK_TOKEN: 'test', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const cfg = { token: 't', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);

type Route = (n: number, init: RequestInit) => Promise<Response>;
function fake(routes: Record<string, Route>) {
	const counts = new Map<string, number>();
	const calls: string[] = [];
	const fetcher = async (u: string, init: RequestInit): Promise<Response> => {
		calls.push(`${init.method} ${u}`);
		const n = (counts.get(u) ?? 0) + 1;
		counts.set(u, n);
		const r = routes[u];
		if (!r) throw new Error(`no route for ${u}`);
		return await r(n, init);
	};
	return { fetcher, calls, counts };
}
const status = (s: number, headers?: Record<string, string>): Route => async () => new Response(null, { status: s, headers });
const timeout: Route = async () => {
	throw Object.assign(new Error('t'), { name: 'TimeoutError' });
};

// ------------------------------------------------------------------ classification

describe('link classification (#479)', () => {
	it('every row of the table, by the final response', async () => {
		const { fetcher, counts } = fake({
			'https://ok.com/': status(200),
			'https://gone.com/': status(404),
			'https://removed.com/': status(410),
			'https://blip.com/': async (n) => new Response(null, { status: n === 1 ? 503 : 200 }),
			'https://down.com/': status(502),
			'https://slow.com/': timeout,
			'https://secure.com/': status(401),
			'https://bot.com/': status(403),
			'https://busy.com/': status(429),
			'https://teapot.com/': status(418),
			'https://nope.com/': async () => {
				throw new Error('getaddrinfo ENOTFOUND nope.com');
			},
			'https://cf-nope.com/': status(530),
			'https://loop-a.com/': status(302, { location: 'https://loop-b.com/' }),
			'https://loop-b.com/': status(302, { location: 'https://loop-a.com/' }),
			'https://h0.com/': status(301, { location: 'https://h1.com/' }),
			'https://h1.com/': status(301, { location: 'https://h2.com/' }),
			'https://h2.com/': status(301, { location: 'https://h3.com/' }),
			'https://h3.com/': status(301, { location: 'https://h4.com/' }),
			'https://h4.com/': status(200),
			'https://app.com/dash': status(302, { location: '/login' }),
			'https://app.com/login': status(200)
		});
		const urls = [
			'https://ok.com/',
			'https://gone.com/',
			'https://removed.com/',
			'https://blip.com/',
			'https://down.com/',
			'https://slow.com/',
			'https://secure.com/',
			'https://bot.com/',
			'https://busy.com/',
			'https://teapot.com/',
			'https://nope.com/',
			'https://cf-nope.com/',
			'https://loop-a.com/',
			'https://h0.com/',
			'https://app.com/dash',
			'http://10.0.0.1/admin'
		];
		const { probes } = await checkLinks(urls, fetcher, { retryDelayMs: 0 });
		const cls = Object.fromEntries(probes.map((p) => [p.url, classifyProbe(p)]));
		expect(cls).toEqual({
			'https://ok.com/': 'ok',
			'https://gone.com/': 'broken',
			'https://removed.com/': 'broken',
			'https://blip.com/': 'ok',
			'https://down.com/': 'server',
			'https://slow.com/': 'timeout',
			'https://secure.com/': 'refused',
			'https://bot.com/': 'refused',
			'https://busy.com/': 'refused',
			'https://teapot.com/': 'other',
			'https://nope.com/': 'dns',
			// #479: a 530 is "no answer from the host" (a server failure), not a missing domain.
			'https://cf-nope.com/': 'server',
			'https://loop-a.com/': 'redirects',
			'https://h0.com/': 'redirects',
			'https://app.com/dash': 'login',
			'http://10.0.0.1/admin': 'blocked'
		});
		// One retry for a 5xx / no answer; none for a 404 or a DNS failure.
		expect(counts.get('https://blip.com/')).toBe(2);
		expect(counts.get('https://down.com/')).toBe(2);
		expect(counts.get('https://slow.com/')).toBe(2);
		expect(counts.get('https://gone.com/')).toBe(1);
		expect(counts.get('https://nope.com/')).toBe(1);
		expect(counts.get('https://cf-nope.com/')).toBe(2);
		expect(probes.find((p) => p.url === 'https://blip.com/')?.retried).toBe(true);

		const checks = linkProbeChecks(probes, 0, { where: new Map([['https://gone.com/', 'Read the deck']]) });
		const level = (id: string) => byId(checks, id)?.level;
		expect(level('links.live_broken')).toBe('block');
		expect(byId(checks, 'links.live_broken')!.items).toContain('https://gone.com/ — 404 · “Read the deck”');
		expect(byId(checks, 'links.live_broken')!.urls).toEqual(['https://gone.com/', 'https://removed.com/']);
		expect(level('links.live_server')).toBe('block');
		expect(level('links.live_dns')).toBe('block');
		expect(level('links.live_error')).toBe('warn');
		expect(level('links.live_refused')).toBe('warn');
		expect(level('links.live_login')).toBe('warn');
		expect(level('links.live_redirects')).toBe('warn');
		expect(level('links.live_skipped')).toBe('pass');
		expect(byId(checks, 'links.live')).toBeUndefined();
	});

	it('all working collapses to one passing line; the cap and the time budget are reported', async () => {
		const { fetcher } = fake({ 'https://a.com/': status(200), 'https://b.com/': status(204) });
		const { probes } = await checkLinks(['https://a.com/', 'https://b.com/'], fetcher, { retryDelayMs: 0 });
		const checks = linkProbeChecks(probes, 3);
		expect(byId(checks, 'links.live')).toMatchObject({ level: 'pass', title: '2 links checked, all working' });
		expect(byId(checks, 'links.live_skipped')!.items).toEqual(['3 more not checked (limit 60)']);

		const late = await checkLinks(['https://a.com/'], fetcher, { deadline: Date.now() - 1 });
		expect(late).toMatchObject({ probes: [], unfinished: ['https://a.com/'] });
		expect(byId(linkProbeChecks(late.probes, 0, { unfinished: late.unfinished }), 'links.live_unfinished')?.level).toBe('warn');
	});

	it('isDnsFailure spots resolver errors only, never a status (a 530 included)', () => {
		expect(isDnsFailure(530)).toBe(false);
		expect(isDnsFailure(null, 'getaddrinfo ENOTFOUND x.com')).toBe(true);
		expect(isDnsFailure(null, 'timed out')).toBe(false);
		expect(isDnsFailure(500)).toBe(false);
	});

	it('at schedule time a failing link is a warning, checked again at send time', () => {
		const probes: LinkProbe[] = [{ url: 'https://gone.com/', status: 404 }];
		const soft = softenLiveLinks(linkProbeChecks(probes, 0));
		expect(byId(soft, 'links.live_broken')).toMatchObject({ level: 'warn' });
		expect(byId(soft, 'links.live_broken')!.detail).toContain(SCHEDULE_LINK_NOTE);
	});
});

describe('merge-tag links (#479)', () => {
	const row = (id: number, first: string, website: string | null): SendableRow => ({
		id,
		email: `${first}@x.example.net`,
		name: null,
		first_name: first,
		last_name: null,
		company: null,
		meta: website ? JSON.stringify({ website }) : null,
		tags: null
	});

	it('fills a merge href the way the send does', () => {
		expect(fillHref('https://shop.ok.com/{{first_name}}', row(1, 'ann', null))).toBe('https://shop.ok.com/ann');
		expect(fillHref('{{field:website}}', row(1, 'ann', 'https://ann-site.com/'))).toBe('https://ann-site.com/');
		expect(fillHref('%7B%7Bfield:website%7D%7D', row(1, 'ann', 'https://ann-site.com/'))).toBe('https://ann-site.com/');
	});

	it('checks up to 3 samples; a failing sample only warns', async () => {
		const { fetcher, calls } = fake({
			'https://ann-site.com/': status(200),
			'https://bob-site.com/': status(404),
			'https://cy-site.com/': status(200),
			'https://shop.ok.com/ann': status(200),
			'https://shop.ok.com/bob': status(200),
			'https://shop.ok.com/cy': status(200)
		});
		const html = '<a href="{{field:website}}">Your site</a> <a href="https://shop.ok.com/{{first_name}}">Shop</a>';
		const samples = [row(1, 'ann', 'https://ann-site.com/'), row(2, 'bob', 'https://bob-site.com/'), row(3, 'cy', 'https://cy-site.com/'), row(4, 'di', 'https://di-site.com/')];
		const checks = await liveLinkChecks(extractLinks(html), samples, { fetcher, retryDelayMs: 0 });
		expect(calls.some((c) => c.includes('di-site'))).toBe(false);
		const merge = byId(checks, 'links.live_merge')!;
		expect(merge).toMatchObject({ level: 'warn', title: "Some contacts' links may not work" });
		expect(merge.items).toEqual(['{{field:website}} — failed for 1 of 3 samples']);
		expect(checks.some((c) => c.level === 'block')).toBe(false);
	});
});

// ------------------------------------------------------------------ policy

describe('policy (#479)', () => {
	const report = (checks: Check[]) => summarize(checks, true);
	const c = (id: string, level: Check['level']): Check => ({ id, category: id.split('.')[0] as Check['category'], level, title: id });

	it('normalizes junk to the defaults and drops unknown / locked overrides', () => {
		expect(normalizePolicy({})).toEqual(DEFAULT_POLICY);
		expect(normalizePolicy({ enforcement: 'yes', override: 'x', retryMinutes: '7', levels: '{bad' })).toEqual(DEFAULT_POLICY);
		const p = normalizePolicy({ enforcement: 'strict', retryMinutes: '30', notifyEmail: '1', override: 'none', levels: JSON.stringify({ 'links.live_error': 'block', 'content.unsubscribe': 'off', nope: 'off', 'links.utm': 'warn' }) });
		// links.utm is already a warning by default, so "warn" is no override.
		expect(p).toEqual({ enforcement: 'strict', retryMinutes: 30, notifyEmail: true, override: 'none', levels: { 'links.live_error': 'block' } });
		expect(CHECK_CATALOG.find((e) => e.id === 'content.unsubscribe')?.locked).toBe(true);
	});

	it('Off drops, Warn lowers, Block raises only under Strict', () => {
		const r = report([c('links.live_error', 'warn'), c('content.spammy', 'warn'), c('links.placeholder', 'block'), c('content.merge.first_name', 'warn'), c('images.alt', 'pass')]);
		const levels = { 'links.live_error': 'block', 'content.spammy': 'off', 'links.placeholder': 'warn', 'content.merge': 'off' } as const;
		const block = applyPolicy(r, { ...DEFAULT_POLICY, levels: { ...levels } });
		expect(block.checks.map((x) => [x.id, x.level])).toEqual([
			['links.live_error', 'warn'],
			['links.placeholder', 'warn'],
			['images.alt', 'pass']
		]);
		expect(block.blocks).toBe(0);
		const strict = applyPolicy(r, { ...DEFAULT_POLICY, enforcement: 'strict', levels: { ...levels } });
		expect(byId(strict.checks, 'links.live_error')?.level).toBe('block');
		expect(strict.blocks).toBe(1);
	});

	it('Warn only stops nothing except locked compliance checks; Strict blocks unchecked links', () => {
		const r = report([c('links.live_broken', 'block'), c('content.unsubscribe', 'block'), c('links.live_unfinished', 'warn')]);
		const warn = applyPolicy(r, { ...DEFAULT_POLICY, enforcement: 'warn' });
		expect(warn.checks.map((x) => x.level)).toEqual(['warn', 'block', 'warn']);
		expect(applyPolicy(r, DEFAULT_POLICY).blocks).toBe(2);
		expect(applyPolicy(r, { ...DEFAULT_POLICY, enforcement: 'strict' }).blocks).toBe(3);
	});

	it('only admins may send anyway, and only when overrides are on', () => {
		expect(canSendAnyway(DEFAULT_POLICY, 'admin')).toBe(true);
		expect(canSendAnyway(DEFAULT_POLICY, 'member')).toBe(false);
		expect(canSendAnyway(DEFAULT_POLICY, undefined)).toBe(false);
		expect(canSendAnyway({ ...DEFAULT_POLICY, override: 'none' }, 'admin')).toBe(false);
	});

	it('held summary counts broken links', () => {
		const r = report([{ ...c('links.live_broken', 'block'), urls: ['https://a.com/', 'https://b.com/'] }]);
		expect(heldSummary(r)).toBe('2 broken links');
		expect(heldSummary(report([c('links.placeholder', 'block'), c('links.live_dns', 'block')]))).toBe('2 blocking problems');
		expect(heldSummary(null)).toBe('failed pre-send checks');
	});

	it('round-trips through app_state', async () => {
		await db.prepare(`DELETE FROM app_state WHERE key LIKE 'presend_%'`).run();
		expect(await getPresendPolicy(db)).toEqual(DEFAULT_POLICY);
		const p = { enforcement: 'strict' as const, levels: { 'links.live_error': 'block' as const }, override: 'none' as const, retryMinutes: 60, notifyEmail: true };
		await savePresendPolicy(db, p);
		expect(await getPresendPolicy(db)).toEqual(p);
	});
});

// ------------------------------------------------------------------ D1: scheduled path + compose gate

const LINK = 'https://shop.ok.com/deck';
const HTML = `<p>Our deck is live. <a href="${LINK}">Open the deck</a></p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>`;
let listId: number;
let adminId: number;

async function scheduled(): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status, scheduled_at, list_id)
			 VALUES ('Deck day', 'x', ?, 'x', 'alan@ourco.example', 'scheduled', datetime('now', '-1 minute'), ?) RETURNING id`
		)
		.bind(HTML, listId)
		.first<{ id: number }>())!.id;
}
const rowOf = (id: number) =>
	db
		.prepare('SELECT status, held_at, held_reason, preflight_report, preflight_retry_until, preflight_override_by FROM campaigns WHERE id = ?')
		.bind(id)
		.first<{ status: string; held_at: string | null; held_reason: string | null; preflight_report: string | null; preflight_retry_until: string | null; preflight_override_by: string | null }>();
const linkStatus = (s: number) => fake({ [LINK]: status(s) }).fetcher;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockImplementation(async (_db: unknown, o: { recipients: unknown[] }) => ({ accepted: o.recipients.length, failed: 0, firstError: null }));
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'presend_%'`)
	]);
	listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	await db.prepare(`INSERT OR IGNORE INTO users (github_login, role) VALUES ('ourco-admin', 'admin')`).run();
	await db.prepare(`UPDATE users SET role = 'admin', disabled_at = NULL WHERE github_login = 'ourco-admin'`).run();
	adminId = (await db.prepare(`SELECT id FROM users WHERE github_login = 'ourco-admin'`).first<{ id: number }>())!.id;
	for (const email of ['a@x.example.net', 'b@x.example.net']) {
		const id = (await db.prepare('INSERT INTO contacts (email, first_name, subscribed) VALUES (?, ?, 1) RETURNING id').bind(email, 'Ann').first<{ id: number }>())!.id;
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, id).run();
	}
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('scheduled sends re-check their links (#479)', () => {
	it('fails, then passes inside the window: sends late', async () => {
		const id = await scheduled();
		const first = await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		expect(first).toEqual({ fired: 0, failed: 0, retrying: 1 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		const waiting = (await rowOf(id))!;
		expect(waiting.status).toBe('scheduled');
		expect(waiting.held_at).toBeNull();
		expect(waiting.preflight_retry_until).not.toBeNull();
		expect(waiting.preflight_report).toContain('links.live_broken');

		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(200), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
		expect(spies.sendCampaignEmail).toHaveBeenCalledTimes(1);
		expect((await rowOf(id))!).toMatchObject({ status: 'sent', preflight_retry_until: null });
	});

	it('fails past the window: held with the report, notified once, never sent', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		const id = await scheduled();
		const onHold = vi.fn(async () => {});
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 }, onHold })).toEqual({ fired: 0, failed: 0, held: 1 });
		const held = (await rowOf(id))!;
		expect(held).toMatchObject({ status: 'scheduled', held_reason: 'preflight', preflight_retry_until: null });
		expect(held.held_at).not.toBeNull();
		expect(JSON.parse(held.preflight_report!).checks.find((c: Check) => c.id === 'links.live_broken').level).toBe('block');
		expect(onHold).toHaveBeenCalledTimes(1);
		// Held = not picked again.
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(200), retryDelayMs: 0 }, onHold })).toEqual({ fired: 0, failed: 0 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect(onHold).toHaveBeenCalledTimes(1);
		expect(await preflightHolds(db)).toEqual([expect.objectContaining({ id, summary: '1 broken link' })]);
		expect((await heldCampaigns(db)).find((h) => h.id === id)?.held_reason).toBe('preflight');
	});

	it('the window keeps trying for N minutes from the first failure', async () => {
		const id = await scheduled();
		const now = new Date();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(500), retryDelayMs: 0, now } });
		expect((await rowOf(id))!.preflight_retry_until).toBe(new Date(now.getTime() + 15 * 60_000).toISOString().slice(0, 19).replace('T', ' '));
		// 16 minutes later it's past the window: held.
		const later = new Date(now.getTime() + 16 * 60_000);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(500), retryDelayMs: 0, now: later } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect((await rowOf(id))!.held_reason).toBe('preflight');
	});

	it('Re-check now releases a passing send (the tick sends it); a failing one stays held', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		const id = await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		const still = await recheckHeld(db, id, { fetcher: linkStatus(404), retryDelayMs: 0 });
		expect(still).toMatchObject({ ok: true, released: false });
		expect((await rowOf(id))!.held_reason).toBe('preflight');
		const ok = await recheckHeld(db, id, { fetcher: linkStatus(200), retryDelayMs: 0 });
		expect(ok).toMatchObject({ ok: true, released: true });
		expect((await rowOf(id))!).toMatchObject({ status: 'scheduled', held_at: null, held_reason: null });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled(); // never from the re-check itself
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(200), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
	});

	it('Send anyway is logged and skips the check at fire time', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		const id = await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		expect(await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId })).toBe(true);
		expect((await rowOf(id))!.preflight_override_by).toMatch(/^@ourco-admin at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
		expect(await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId })).toBe(false);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
	});

	it('Edit clears a preflight hold; Release puts it back on its schedule', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		const a = await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		expect(await reopenAsDraft(db, a)).toEqual({ ok: true });
		expect((await rowOf(a))!).toMatchObject({ status: 'draft', held_at: null, held_reason: null });

		const b = await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		expect(await releaseHeldCampaign(db, b)).toBe(true);
		expect((await rowOf(b))!).toMatchObject({ held_at: null, held_reason: null });
	});

	it('a deliverability hold is untouched', async () => {
		const id = await scheduled();
		await db.prepare(`UPDATE campaigns SET held_at = datetime('now'), held_reason = 'deliverability' WHERE id = ?`).bind(id).run();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(200), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0 });
		expect(await recheckHeld(db, id, { fetcher: linkStatus(200) })).toMatchObject({ ok: false });
		expect(await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId })).toBe(false);
		expect((await rowOf(id))!.held_reason).toBe('deliverability');
	});

	it('Warn only never holds', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, enforcement: 'warn', retryMinutes: 0 });
		await scheduled();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
	});

	it('notifications escape the subject and point at the campaign', () => {
		const n = { id: 7, subject: '<b>Deck</b> & co', scheduledAt: '2026-11-24 12:00:00', appUrl: 'https://crm.myapp.example', report: summarize([{ id: 'links.live_broken', category: 'links', level: 'block', title: '1 link not found', items: ['https://gone.com/ — 404'], urls: ['https://gone.com/'] }], true) };
		const json = JSON.parse(holdPayload('json', n));
		expect(json).toMatchObject({ type: 'send_held', campaign_id: 7, summary: '1 broken link', url: 'https://crm.myapp.example/campaign/7' });
		expect(JSON.parse(holdPayload('slack', n)).text).toContain('&lt;b&gt;Deck&lt;/b&gt; &amp; co');
		const mail = holdEmail(n);
		expect(mail.html).not.toContain('<b>Deck</b>');
		expect(mail.text).toContain('https://crm.myapp.example/campaign/7');
	});
});

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return fd;
}
function sendEvent(fields: Record<string, string>, role = 'admin') {
	const url = new URL('https://app.test/compose?/send');
	return { platform: { env: platformEnv }, params: {}, url, locals: { user: { id: 1, role, github_login: 'ourco-admin' } }, request: new Request(url, { method: 'POST', body: form(fields) }) } as any;
}
async function run(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}

describe('compose send runs the link check itself (#479)', () => {
	const para = (text: string, href?: string) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', href }] } : {}) }] });
	const body = JSON.stringify([para('A real update with plenty of words. '.repeat(8)), para('Open the deck', LINK)]);
	const base = { subject: 'Deck day', from: 'alan@ourco.example', preheader: 'p', body_blocks: body };

	it('a 404 blocks Send now even though the panel never ran', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
		const r = await run(compose.send!, sendEvent({ ...base, list_id: String(listId) }));
		expect(r.result?.status).toBe(400);
		expect(byId(r.result?.data.checks.checks, 'links.live_broken')?.level).toBe('block');
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('at schedule time the same 404 only warns, so it schedules', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
		const when = new Date(Date.now() + 3600_000).toISOString();
		const r = await run(compose.send!, sendEvent({ ...base, list_id: String(listId), schedule_at: when }));
		expect(r.redirect).toMatch(/^\/campaign\/\d+/);
		expect((await db.prepare(`SELECT status FROM campaigns ORDER BY id DESC LIMIT 1`).first<{ status: string }>())?.status).toBe('scheduled');
	});

	it('overrides off: even an admin cannot send anyway', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
		await savePresendPolicy(db, { ...DEFAULT_POLICY, override: 'none' });
		const r = await run(compose.send!, sendEvent({ ...base, list_id: String(listId), send_anyway: '1' }));
		expect(r.result?.status).toBe(400);
		expect(r.result?.data.error).toContain('overrides are off');
	});
});

// ------------------------------------------------------------------ review fixes (A to G, 530)

async function scheduledWith(html: string): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status, scheduled_at, list_id)
			 VALUES ('Deck day', 'x', ?, 'x', 'alan@ourco.example', 'scheduled', datetime('now', '-1 minute'), ?) RETURNING id`
		)
		.bind(html, listId)
		.first<{ id: number }>())!.id;
}
const overrideOf = async (id: number) =>
	(await db.prepare('SELECT preflight_override_by AS by, preflight_override_user_id AS uid FROM campaigns WHERE id = ?').bind(id).first<{ by: string | null; uid: number | null }>())!;
const ok200: Fetcher = async () => new Response(null, { status: 200 });

describe('A: the check runs before the claim (#479)', () => {
	it('the row is still scheduled while its links are checked', async () => {
		const id = await scheduled();
		let during = '';
		const fetcher: Fetcher = async () => {
			during = (await db.prepare('SELECT status FROM campaigns WHERE id = ?').bind(id).first<{ status: string }>())!.status;
			return new Response(null, { status: 200 });
		};
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
		expect(during).toBe('scheduled');
		expect((await rowOf(id))!.status).toBe('sent');
	});

	it('a deliverability hold raised during the check stops the send (never sent while held)', async () => {
		const id = await scheduled();
		const fetcher: Fetcher = async () => {
			await db.prepare(`UPDATE campaigns SET held_at = datetime('now'), held_reason = 'deliverability' WHERE id = ?`).bind(id).run();
			return new Response(null, { status: 200 });
		};
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect((await rowOf(id))!).toMatchObject({ status: 'scheduled', held_reason: 'deliverability' });
	});

	it('a preflight hold never overwrites a deliverability hold raised meanwhile, and notifies nobody', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		const id = await scheduled();
		const onHold = vi.fn(async () => {});
		const fetcher: Fetcher = async () => {
			await db.prepare(`UPDATE campaigns SET held_at = datetime('now'), held_reason = 'deliverability' WHERE id = ?`).bind(id).run();
			return new Response(null, { status: 404 });
		};
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 }, onHold })).toEqual({ fired: 0, failed: 0 });
		expect(onHold).not.toHaveBeenCalled();
		expect((await rowOf(id))!).toMatchObject({ status: 'scheduled', held_reason: 'deliverability' });
	});

	it('two overlapping ticks may both check; only one claims and sends (never sent twice)', async () => {
		const id = await scheduled();
		const fetcher: Fetcher = async () => {
			await new Promise((r) => setTimeout(r, 20));
			return new Response(null, { status: 200 });
		};
		const [a, b] = await Promise.all([
			processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } }),
			processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })
		]);
		expect(a.fired + b.fired).toBe(1);
		expect(spies.sendCampaignEmail).toHaveBeenCalledTimes(1);
		expect((await rowOf(id))!.status).toBe('sent');
	});

	it('same audience as before: resolved after the claim, unsubscribed members left out', async () => {
		const out = (await db.prepare(`INSERT INTO contacts (email, first_name, subscribed) VALUES ('gone@x.example.net', 'Gus', 0) RETURNING id`).first<{ id: number }>())!.id;
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, out).run();
		await scheduled();
		// Someone joins the list while the links are being checked: they get the send, as on main.
		const fetcher: Fetcher = async () => {
			const late = (await db.prepare(`INSERT INTO contacts (email, first_name, subscribed) VALUES ('late@x.example.net', 'Lee', 1) RETURNING id`).first<{ id: number }>())!.id;
			await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, late).run();
			return new Response(null, { status: 200 });
		};
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } });
		const sent = (spies.sendCampaignEmail.mock.calls[0][1] as { recipients: { email: string }[] }).recipients.map((r) => r.email).sort();
		expect(sent).toEqual(['a@x.example.net', 'b@x.example.net', 'late@x.example.net']);
	});

	it('an empty audience still fails after the claim exactly as before', async () => {
		await db.prepare('DELETE FROM list_members').run();
		const id = await scheduled();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 1 });
		expect((await rowOf(id))!.status).toBe('failed');
	});
});

describe('B: a checker error is never a failed campaign (#479)', () => {
	const broken = (enforcement: PresendPolicy['enforcement']): PresendPolicy => ({
		...DEFAULT_POLICY,
		enforcement,
		retryMinutes: 0,
		get levels(): Record<string, LevelOverride> {
			throw new Error('policy store down at https://db.example.com/x?token=secret');
		}
	});

	it('Block: logged without URLs and sent (fail open)', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = await scheduled();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { policy: broken('block'), fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
		expect((await rowOf(id))!.status).toBe('sent');
		const logged = log.mock.calls.flat().map(String).join('\n');
		expect(logged).toContain('policy store down');
		expect(logged).not.toMatch(/https?:\/\//);
	});

	it('Warn only: sent', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await scheduled();
		// Warn only never runs the check: a broken link is sent, as on main.
		expect(await processScheduledCampaigns(db, cfg, { preflight: { policy: { ...DEFAULT_POLICY, enforcement: 'warn' }, fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
	});

	it('Strict: stays scheduled for at least 5 minutes, then held as "could not be checked"', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = await scheduled();
		const now = new Date();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { policy: broken('strict'), fetcher: linkStatus(404), retryDelayMs: 0, now } })).toEqual({ fired: 0, failed: 0, retrying: 1 });
		const waiting = (await rowOf(id))!;
		expect(waiting).toMatchObject({ status: 'scheduled', held_at: null });
		expect(waiting.preflight_retry_until).toBe(sqlTime(new Date(now.getTime() + 5 * 60_000)));
		expect(waiting.preflight_report).toContain(CHECKER_ERROR_ID);
		const later = new Date(now.getTime() + 6 * 60_000);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { policy: broken('strict'), fetcher: linkStatus(404), retryDelayMs: 0, now: later } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect((await rowOf(id))!).toMatchObject({ status: 'scheduled', held_reason: 'preflight' });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect((await preflightHolds(db))[0].summary).toBe('links could not be checked');
	});

	it('the "could not be checked" report reads as such', () => {
		expect(heldSummary(checkerErrorReport(new Date()))).toBe('links could not be checked');
	});
});

describe('C: hard time and fetch budgets (#479)', () => {
	it('the deadline aborts a fetch in flight; the link is "not checked yet"', async () => {
		const hang: Fetcher = async (_u, init) => {
			await new Promise<void>((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
			return new Response(null, { status: 200 });
		};
		const r = await checkLinks(['https://hang.example.com/'], hang, { deadline: Date.now() + 150, retryDelayMs: 0 });
		expect(r).toMatchObject({ probes: [], unfinished: ['https://hang.example.com/'] });
	});

	it('no retry (and no wait) when the deadline does not leave room for it', async () => {
		const { fetcher, counts } = fake({ 'https://blip.example.com/': status(503) });
		const r = await checkLinks(['https://blip.example.com/'], fetcher, { deadline: Date.now() + 1000, retryDelayMs: 5000 });
		expect(r.unfinished).toEqual(['https://blip.example.com/']);
		expect(counts.get('https://blip.example.com/')).toBe(1);
	});

	it('every fetch counts (HEAD, GET fallback, hops); out of budget = not checked yet', async () => {
		const { fetcher, calls } = fake({
			'https://a.example.com/': status(403),
			'https://b.example.com/': status(301, { location: 'https://c.example.com/' }),
			'https://c.example.com/': status(200),
			'https://d.example.com/': status(200)
		});
		const budget = fetchBudget(4);
		const r = await checkLinks(['https://a.example.com/', 'https://b.example.com/', 'https://d.example.com/'], fetcher, { maxFetches: budget, retryDelayMs: 0 });
		expect(calls).toHaveLength(4);
		expect(budget.remaining).toBe(0);
		expect(r.probes.length + r.unfinished.length).toBe(3);
		expect(r.unfinished.length).toBeGreaterThan(0);
	});

	it('one budget object is shared between calls; a child stops at its parent', async () => {
		const { fetcher } = fake({ 'https://a.example.com/': status(200), 'https://b.example.com/': status(200), 'https://c.example.com/': status(200) });
		const shared = fetchBudget(2);
		const first = await checkLinks(['https://a.example.com/'], fetcher, { maxFetches: shared });
		const second = await checkLinks(['https://b.example.com/', 'https://c.example.com/'], fetcher, { maxFetches: shared });
		expect(first.probes).toHaveLength(1);
		expect(second.probes).toHaveLength(1);
		expect(second.unfinished).toHaveLength(1);
		const parent = fetchBudget(1);
		const child = fetchBudget(10, parent);
		expect(takeFetch(child)).toBe(true);
		expect(takeFetch(child)).toBe(false);
		expect(child.remaining).toBe(9);
	});

	it('the SSRF guard still runs on every hop when budgets are set', async () => {
		const { fetcher, calls } = fake({ 'https://sneaky.example.com/': status(302, { location: 'http://169.254.169.254/' }) });
		const r = await checkLinks(['https://sneaky.example.com/'], fetcher, { maxFetches: fetchBudget(50), deadline: Date.now() + 5000 });
		expect(calls).toEqual(['HEAD https://sneaky.example.com/']);
		expect(r.probes[0].kind).toBe('blocked');
	});
});

describe('D: fair sharing in the tick, "not checked yet" by policy (#479)', () => {
	it('each campaign gets an equal slice of the tick budget, at least 30', () => {
		expect(fetchSlice(300, 5)).toBe(60);
		expect(fetchSlice(300, 1)).toBe(300);
		expect(fetchSlice(300, 20)).toBe(30);
	});

	it('a campaign with many slow links cannot starve another; under Block both send', async () => {
		const many = Array.from({ length: 40 }, (_, i) => `https://m${i}.example.com/`);
		const routes: Record<string, Route> = { 'https://one.example.com/': status(200) };
		for (const u of many) routes[u] = status(403); // HEAD 403 → GET 403: 2 fetches each
		const { fetcher, counts } = fake(routes);
		const big = await scheduledWith(`${many.map((u) => `<a href="${u}">x</a>`).join(' ')} <a href="%%UNSUB_URL%%">Unsubscribe</a>`);
		const small = await scheduledWith(`<a href="https://one.example.com/">One</a> <a href="%%UNSUB_URL%%">Unsubscribe</a>`);
		const total = fetchBudget(60);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0, maxFetches: total } })).toEqual({ fired: 2, failed: 0 });
		expect(counts.get('https://one.example.com/')).toBe(1);
		const bigFetches = many.reduce((n, u) => n + (counts.get(u) ?? 0), 0);
		expect(bigFetches).toBeLessThanOrEqual(30);
		expect((await rowOf(big))!.preflight_report).toContain('links.live_unfinished');
		expect((await rowOf(small))!.status).toBe('sent');
	});

	it('Block: links not checked do not block', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		await scheduled();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0, maxFetches: fetchBudget(0) } })).toEqual({ fired: 1, failed: 0 });
	});

	it('Strict: not checked = try again next tick, never an instant hold (window 0 → 5 minutes)', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, enforcement: 'strict', retryMinutes: 0 });
		const id = await scheduled();
		const now = new Date();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0, maxFetches: fetchBudget(0), now } })).toEqual({ fired: 0, failed: 0, retrying: 1 });
		expect((await rowOf(id))!).toMatchObject({ status: 'scheduled', held_at: null, preflight_retry_until: sqlTime(new Date(now.getTime() + 5 * 60_000)) });
		const later = new Date(now.getTime() + 6 * 60_000);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0, maxFetches: fetchBudget(0), now: later } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('Strict: checked again with budget, it sends', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, enforcement: 'strict', retryMinutes: 0 });
		await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0, maxFetches: fetchBudget(0) } });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
	});

	it('decidePreflight: a checked block uses the window as set; only-unchecked waits at least 5 minutes', () => {
		const now = new Date('2026-11-24T12:00:00Z');
		const rep = (id: string) => summarize([{ id, category: 'links', level: 'block', title: id }], true);
		const p0 = { ...DEFAULT_POLICY, enforcement: 'strict' as const, retryMinutes: 0 };
		expect(decidePreflight(rep('links.live_broken'), p0, null, now)).toEqual({ action: 'hold' });
		expect(decidePreflight(rep('links.live_unfinished'), p0, null, now)).toEqual({ action: 'retry', retryUntil: '2026-11-24 12:05:00' });
		// Started as "not checked", then a real broken link with window 0: held now.
		expect(decidePreflight(rep('links.live_broken'), p0, '2026-11-24 12:05:00', now)).toEqual({ action: 'hold' });
		expect(decidePreflight(rep('links.live_broken'), { ...p0, retryMinutes: 15 }, null, now)).toEqual({ action: 'retry', retryUntil: '2026-11-24 12:15:00' });
		expect(decidePreflight(summarize([], true), p0, null, now)).toEqual({ action: 'send' });
	});
});

describe('E: links never checked do not look checked (#479)', () => {
	it('over the cap is a warning that says how many', () => {
		const checks = linkProbeChecks([{ url: 'https://a.example.com/', status: 200 }], 3);
		expect(byId(checks, 'links.live_skipped')).toMatchObject({ level: 'warn', title: '3 links not checked' });
		expect(byId(checks, 'links.live')?.level).toBe('pass');
	});

	it('a merge-tag link with no usable sample is not checked (warning), and nothing is fetched', async () => {
		const { fetcher, calls } = fake({});
		const noSite: SendableRow = { id: 1, email: 'ann@x.example.net', name: null, first_name: 'Ann', last_name: null, company: null, meta: null, tags: null };
		const checks = await liveLinkChecks(extractLinks('<a href="{{field:website}}">Your site</a>'), [noSite], { fetcher, retryDelayMs: 0 });
		expect(calls).toEqual([]);
		const row = byId(checks, 'links.live_skipped')!;
		expect(row.level).toBe('warn');
		expect(row.items!.join('\n')).toContain('1 merge-tag link not checked');
	});

	it('SSRF-refused links alone stay an info row', () => {
		const checks = linkProbeChecks([{ url: 'http://10.0.0.1/', status: null, kind: 'blocked', error: 'blocked: private address' }], 0);
		expect(byId(checks, 'links.live_skipped')?.level).toBe('pass');
	});

	it('it can be overridden per check like any other', () => {
		expect(normalizePolicy({ levels: { 'links.live_skipped': 'off' } }).levels).toEqual({ 'links.live_skipped': 'off' });
		const r = summarize(linkProbeChecks([], 2), true);
		expect(byId(applyPolicy(r, { ...DEFAULT_POLICY, levels: { 'links.live_skipped': 'off' } }).checks, 'links.live_skipped')).toBeUndefined();
		expect(byId(applyPolicy(r, { ...DEFAULT_POLICY, enforcement: 'strict', levels: { 'links.live_skipped': 'block' } }).checks, 'links.live_skipped')?.level).toBe('block');
	});
});

describe('F: "Send anyway" counts for one fire (#479)', () => {
	async function heldNow(): Promise<number> {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
		const id = await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		expect((await rowOf(id))!.held_reason).toBe('preflight');
		return id;
	}

	it('cleared when it is sent; who did it stays in the report', async () => {
		const id = await heldNow();
		await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
		expect(await overrideOf(id)).toEqual({ by: null, uid: null });
		expect(JSON.parse((await rowOf(id))!.preflight_report!).overriddenBy).toMatch(/^@ourco-admin at /);
	});

	it('not honoured once overrides are turned off: checked, held again, cleared', async () => {
		const id = await heldNow();
		await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId });
		await savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0, override: 'none' });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect(await overrideOf(id)).toEqual({ by: null, uid: null });
	});

	it('not honoured when the admin is disabled or no longer an admin', async () => {
		const id = await heldNow();
		await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId });
		await db.prepare(`UPDATE users SET disabled_at = datetime('now') WHERE id = ?`).bind(adminId).run();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0, held: 1 });

		await db.prepare(`UPDATE users SET disabled_at = NULL, role = 'member' WHERE id = ?`).bind(adminId).run();
		await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('cleared by a deliverability hold and a release; the next fire is checked', async () => {
		const id = await heldNow();
		await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId });
		expect(await holdScheduledForList(db, listId, 1, new Date())).toEqual([id]);
		expect(await overrideOf(id)).toEqual({ by: null, uid: null });
		expect(await releaseHeldCampaign(db, id)).toBe(true);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0, held: 1 });
	});

	it('cleared by Edit', async () => {
		const id = await heldNow();
		await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId });
		expect(await reopenAsDraft(db, id)).toEqual({ ok: true });
		expect(await overrideOf(id)).toEqual({ by: null, uid: null });
	});
});

describe('G: schedule-time softening is final (#479)', () => {
	const c = (id: string, level: Check['level']): Check => ({ id, category: 'links', level, title: id });

	it('applied after the level overrides, even under Strict with a check raised to Block', () => {
		const r = summarize([c('links.live_refused', 'warn'), c('links.live_broken', 'block')], true);
		const strict = { ...DEFAULT_POLICY, enforcement: 'strict' as const, levels: { 'links.live_refused': 'block' as const } };
		expect(applyPolicy(r, strict).blocks).toBe(2);
		const soft = applyPolicy(r, strict, { scheduling: true });
		expect(soft.blocks).toBe(0);
		expect(soft.checks.map((x) => x.level)).toEqual(['warn', 'warn']);
		const note = byId(soft.checks, 'links.live_broken')!.detail!;
		expect(note.split(SCHEDULE_LINK_NOTE)).toHaveLength(2); // the note once
	});

	it('compose: Strict + 403 raised to Block schedules (warns) but stops Send now', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 403 }));
		await savePresendPolicy(db, { ...DEFAULT_POLICY, enforcement: 'strict', levels: { 'links.live_refused': 'block' } });
		const para = (text: string, href?: string) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', href }] } : {}) }] });
		const fields = { subject: 'Deck day', from: 'alan@ourco.example', preheader: 'p', list_id: String(listId), body_blocks: JSON.stringify([para('A real update with plenty of words. '.repeat(8)), para('Open the deck', LINK)]) };
		const now = await run(compose.send!, sendEvent(fields));
		expect(now.result?.status).toBe(400);
		expect(byId(now.result?.data.checks.checks, 'links.live_refused')?.level).toBe('block');
		const later = await run(compose.send!, sendEvent({ ...fields, schedule_at: new Date(Date.now() + 3600_000).toISOString() }));
		expect(later.redirect).toMatch(/^\/campaign\/\d+/);
	});
});

describe('530 is no answer from the host (#479)', () => {
	it('labelled and classified like a 5xx, never as a missing domain', () => {
		const checks = linkProbeChecks([{ url: 'https://origin-down.example.com/', status: 530, retried: true }], 0);
		expect(byId(checks, 'links.live_dns')).toBeUndefined();
		const row = byId(checks, 'links.live_server')!;
		expect(row.level).toBe('block');
		expect(row.items![0]).toContain('530 (no answer from the host)');
	});
});

// ------------------------------------------------------------------ second review (1 to 7)

/** The same D1 binding, but statements whose SQL matches `fails` throw when run. */
function failingWrites(fails: (sql: string) => boolean): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (sql: string) => {
					if (!fails(sql)) return target.prepare(sql);
					const boom = async (): Promise<never> => {
						throw new Error('D1 write failed');
					};
					const stmt: { bind: () => unknown; run: () => Promise<never>; first: () => Promise<never>; all: () => Promise<never> } = {
						bind: () => stmt,
						run: boom,
						first: boom,
						all: boom
					};
					return stmt as unknown as D1PreparedStatement;
				};
			}
			const v: unknown = Reflect.get(target, prop);
			return typeof v === 'function' ? v.bind(target) : v;
		}
	});
}
const noticeOf = async (id: number) =>
	(await db.prepare('SELECT preflight_notified_at AS at FROM campaigns WHERE id = ?').bind(id).first<{ at: string | null }>())!.at;
const holdNow = async () => savePresendPolicy(db, { ...DEFAULT_POLICY, retryMinutes: 0 });
async function heldByPreflight(): Promise<number> {
	await holdNow();
	const id = await scheduled();
	await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
	expect((await rowOf(id))!.held_reason).toBe('preflight');
	return id;
}
function pageEvent(id: number, role: 'admin' | 'member' = 'member'): RequestEvent {
	const url = new URL(`https://app.test/campaign/${id}`);
	return { platform: { env: platformEnv }, params: { id: String(id) }, url, locals: { user: { id: adminId, role, github_login: 'ourco-admin' } }, request: new Request(url, { method: 'POST' }) } as unknown as RequestEvent;
}

describe('1: a deliverability hold wins over a pre-send hold (#479)', () => {
	it('takes over a pre-send hold: reason, check id, retry window and override cleared', async () => {
		const id = await heldByPreflight();
		await db.prepare(`UPDATE campaigns SET preflight_override_by = '@x at now', preflight_override_user_id = ? WHERE id = ?`).bind(adminId, id).run();
		expect(await holdScheduledForList(db, listId, 42, new Date())).toEqual([id]);
		const row = (await db.prepare('SELECT held_at, held_reason, held_check_id, preflight_retry_until, preflight_override_by FROM campaigns WHERE id = ?').bind(id).first<Record<string, unknown>>())!;
		expect(row).toMatchObject({ held_reason: 'deliverability', held_check_id: 42, preflight_retry_until: null, preflight_override_by: null });
		expect(row.held_at).not.toBeNull();
	});

	it('also holds a send waiting out its pre-send retry window', async () => {
		const id = await scheduled();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		expect((await rowOf(id))!.preflight_retry_until).not.toBeNull();
		expect(await holdScheduledForList(db, listId, 7, new Date())).toEqual([id]);
		expect((await rowOf(id))!).toMatchObject({ held_reason: 'deliverability', preflight_retry_until: null });
	});

	it('Re-check now, Send anyway and Edit cannot release it; the links passing changes nothing', async () => {
		const id = await heldByPreflight();
		await holdScheduledForList(db, listId, 7, new Date());
		expect(await recheckHeld(db, id, { fetcher: linkStatus(200), retryDelayMs: 0 })).toEqual({ ok: false, error: DELIVERABILITY_HOLD_MESSAGE });
		expect(await sendAnywayHeld(db, id, { login: 'ourco-admin', userId: adminId })).toBe(false);
		expect(await preflightHoldRefusal(db, id)).toBe(DELIVERABILITY_HOLD_MESSAGE);
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(200), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0 });
		expect(await reopenAsDraft(db, id)).toEqual({ ok: true });
		expect((await rowOf(id))!).toMatchObject({ status: 'draft', held_reason: 'deliverability' });
		expect((await rowOf(id))!.held_at).not.toBeNull();
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});

	it('the campaign page refuses both actions with a clear message; Release stays admin-only', async () => {
		const id = await heldByPreflight();
		await holdScheduledForList(db, listId, 7, new Date());
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }));
		expect(await campaignPage.recheckHold!(pageEvent(id))).toMatchObject({ status: 400, data: { error: DELIVERABILITY_HOLD_MESSAGE } });
		expect(await campaignPage.sendAnywayHold!(pageEvent(id, 'admin'))).toMatchObject({ status: 400, data: { error: DELIVERABILITY_HOLD_MESSAGE } });
		expect(await campaignPage.releaseHold!(pageEvent(id, 'member'))).toMatchObject({ status: 403 });
		expect((await rowOf(id))!.held_reason).toBe('deliverability');
		expect(await campaignPage.releaseHold!(pageEvent(id, 'admin'))).toMatchObject({ ok: true, released: true });
	});

	it('taken over during Re-check now: neither the report nor the release is written', async () => {
		const id = await heldByPreflight();
		const before = (await rowOf(id))!.preflight_report;
		const fetcher: Fetcher = async () => {
			await holdScheduledForList(db, listId, 9, new Date());
			return new Response(null, { status: 200 });
		};
		expect(await recheckHeld(db, id, { fetcher, retryDelayMs: 0 })).toEqual({ ok: false, error: DELIVERABILITY_HOLD_MESSAGE });
		expect((await rowOf(id))!).toMatchObject({ held_reason: 'deliverability', preflight_report: before });
	});

	it('after an admin releases it, the next tick runs the pre-send check again', async () => {
		const id = await heldByPreflight();
		await holdScheduledForList(db, listId, 7, new Date());
		expect(await releaseHeldCampaign(db, id)).toBe(true);
		const { fetcher, calls } = fake({ [LINK]: status(404) });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect(calls).toEqual([`HEAD ${LINK}`]);
		expect((await rowOf(id))!.held_reason).toBe('preflight');
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
	});
});

describe('2: hold notices in their own pass (#479)', () => {
	it('a failing notifier loses no other notice; each is stamped once and never repeated', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		await holdNow();
		const a = await scheduled();
		const b = await scheduled();
		const onHold = vi.fn(async (c: { id: number }) => {
			if (c.id === a) throw new Error('webhook down https://hooks.example.com/x?k=secret');
		});
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 }, onHold })).toEqual({ fired: 0, failed: 0, held: 2 });
		expect(onHold.mock.calls.map(([c]) => c.id).sort()).toEqual([a, b].sort());
		expect(await noticeOf(a)).not.toBeNull();
		expect(await noticeOf(b)).not.toBeNull();
		expect(errors).toHaveBeenCalled();
		const logged = errors.mock.calls.flat().map(String).join('\n');
		expect(logged).toContain(`held-send notice failed for campaign ${a}`);
		expect(logged).toContain('webhook down');
		expect(logged).not.toMatch(/https?:\/\//);
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 }, onHold });
		expect(onHold).toHaveBeenCalledTimes(2);
	});

	it('a notice a tick missed is sent by the next one', async () => {
		const id = await heldByPreflight(); // that tick had no notifier: as if it was cut off
		expect(await noticeOf(id)).toBeNull();
		const onHold = vi.fn(async () => {});
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0 }, onHold })).toEqual({ fired: 0, failed: 0 });
		expect(onHold).toHaveBeenCalledTimes(1);
		expect(await noticeOf(id)).not.toBeNull();
	});

	it('notices never delay sends: they go out after the send loop', async () => {
		await holdNow();
		await scheduledWith(`<a href="https://gone.example.com/">Gone</a> <a href="%%UNSUB_URL%%">Unsubscribe</a>`);
		await scheduledWith(`<a href="https://fine.example.com/">Fine</a> <a href="%%UNSUB_URL%%">Unsubscribe</a>`);
		const { fetcher } = fake({ 'https://gone.example.com/': status(404), 'https://fine.example.com/': status(200) });
		let sendsBeforeNotice = -1;
		const onHold = vi.fn(async () => {
			sendsBeforeNotice = spies.sendCampaignEmail.mock.calls.length;
		});
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 }, onHold })).toEqual({ fired: 1, failed: 0, held: 1 });
		expect(sendsBeforeNotice).toBe(1);
	});

	it('the pass runs even when the send loop throws', async () => {
		const held = await heldByPreflight();
		await scheduled();
		const broken = failingWrites((sql) => sql.includes(`SET status = 'sending'`));
		const onHold = vi.fn(async () => {});
		await expect(processScheduledCampaigns(broken, cfg, { preflight: { fetcher: ok200, retryDelayMs: 0 }, onHold })).rejects.toThrow('D1 write failed');
		expect(onHold).toHaveBeenCalledTimes(1);
		expect(await noticeOf(held)).not.toBeNull();
	});

	it('at most 5 per pass; held again after a release = notified again', async () => {
		await holdNow();
		for (let i = 0; i < 6; i++) await scheduled();
		// Two ticks: 5 due campaigns per tick.
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } });
		const onHold = vi.fn(async () => {});
		expect(await notifyHeldSends(db, onHold)).toBe(5);
		expect(await notifyHeldSends(db, onHold)).toBe(1);
		expect(await notifyHeldSends(db, onHold)).toBe(0);

		await db.prepare('DELETE FROM campaigns').run();
		const id = await heldByPreflight();
		await notifyHeldSends(db, onHold);
		expect(await recheckHeld(db, id, { fetcher: linkStatus(200), retryDelayMs: 0 })).toMatchObject({ released: true });
		onHold.mockClear();
		await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 }, onHold });
		expect(onHold).toHaveBeenCalledTimes(1);
	});

	it('a deliverability hold is never a pre-send notice', async () => {
		const id = await heldByPreflight();
		await holdScheduledForList(db, listId, 7, new Date());
		const onHold = vi.fn(async () => {});
		expect(await notifyHeldSends(db, onHold)).toBe(0);
		expect(await noticeOf(id)).toBeNull();
	});
});

describe('3: retrying campaigns cannot crowd out other due campaigns (#479)', () => {
	const retrying = async (minutesAgo: number, until: string) => {
		const id = await scheduled();
		await db.prepare(`UPDATE campaigns SET scheduled_at = datetime('now', ?), preflight_retry_until = ? WHERE id = ?`).bind(`-${minutesAgo} minutes`, until, id).run();
		return id;
	};

	it('5 not retrying + 2 retrying (oldest retry first)', async () => {
		const far = sqlTime(new Date(Date.now() + 3600_000));
		const soon = sqlTime(new Date(Date.now() + 600_000));
		const r1 = await retrying(30, soon);
		const r2 = await retrying(29, soon);
		for (let i = 0; i < 4; i++) await retrying(40 + i, far);
		const fresh: number[] = [];
		for (let i = 0; i < 6; i++) fresh.push(await scheduled());
		const due = await dueScheduled(db);
		expect(due).toHaveLength(7);
		expect(due.filter((d) => d.preflight_retry_until === null)).toHaveLength(5);
		expect(due.filter((d) => d.preflight_retry_until !== null).map((d) => d.id)).toEqual([r1, r2]);
	});

	it('a fresh campaign sends while five others are still retrying', async () => {
		const until = sqlTime(new Date(Date.now() + 3600_000));
		for (let i = 0; i < 5; i++) await retrying(60 + i, until);
		const fresh = await scheduledWith(`<a href="https://fine.example.com/">Fine</a> <a href="%%UNSUB_URL%%">Unsubscribe</a>`);
		const { fetcher } = fake({ [LINK]: status(404), 'https://fine.example.com/': status(200) });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0, retrying: 2 });
		expect((await rowOf(fresh))!.status).toBe('sent');
	});
});

describe('4: a failed write never turns a known block into a send (#479)', () => {
	it('retry write fails under Block: skipped, still scheduled, not sent', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = await scheduled();
		const broken = failingWrites((sql) => sql.includes('preflight_retry_until = ?,'));
		expect(await processScheduledCampaigns(broken, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect((await rowOf(id))!).toMatchObject({ status: 'scheduled', held_at: null, preflight_retry_until: null });
	});

	it('hold write fails: skip (never checker_error / send), and the next tick holds it', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await holdNow();
		const id = await scheduled();
		const row = (await dueScheduled(db))[0];
		const broken = failingWrites((sql) => sql.includes(`held_reason = 'preflight', held_check_id = NULL`));
		expect(await preflightScheduled(broken, row, { fetcher: linkStatus(404), retryDelayMs: 0 })).toEqual({ action: 'skip', report: null });
		expect(await processScheduledCampaigns(broken, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher: linkStatus(404), retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0, held: 1 });
		expect((await rowOf(id))!.held_reason).toBe('preflight');
	});
});

describe('5: one probe limiter for the whole tick (#479)', () => {
	function slowCounter(ms = 15) {
		const state = { inFlight: 0, max: 0, calls: 0 };
		const fetcher: Fetcher = async () => {
			state.calls++;
			state.inFlight++;
			state.max = Math.max(state.max, state.inFlight);
			await new Promise((r) => setTimeout(r, ms));
			state.inFlight--;
			return new Response(null, { status: 200 });
		};
		return { fetcher, state };
	}

	it('three campaigns of six links each: never more than 6 probes in flight, none timed out', async () => {
		const { fetcher, state } = slowCounter();
		const ids: number[] = [];
		for (let c = 0; c < 3; c++) {
			const links = Array.from({ length: 6 }, (_, i) => `<a href="https://c${c}-l${i}.example.com/">x</a>`).join(' ');
			ids.push(await scheduledWith(`${links} <a href="%%UNSUB_URL%%">Unsubscribe</a>`));
		}
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 3, failed: 0 });
		expect(state.calls).toBe(18);
		expect(state.max).toBeLessThanOrEqual(6);
		for (const id of ids) expect((await rowOf(id))!.preflight_report).not.toContain('links.live_error');
	});

	it('a shared limiter caps two calls together; a call on its own keeps 6', async () => {
		const { fetcher, state } = slowCounter(10);
		const shared = linkLimiter(2);
		const urls = (p: string) => Array.from({ length: 4 }, (_, i) => `https://${p}${i}.example.com/`);
		const [x, y] = await Promise.all([checkLinks(urls('x'), fetcher, { limiter: shared, retryDelayMs: 0 }), checkLinks(urls('y'), fetcher, { limiter: shared, retryDelayMs: 0 })]);
		expect(x.probes.length + y.probes.length).toBe(8);
		expect(state.max).toBe(2);
		const solo = slowCounter(10);
		await checkLinks(urls('z').concat(urls('w')), solo.fetcher, { retryDelayMs: 0 });
		expect(solo.state.max).toBe(6);
	});

	it('a probe waiting for a slot past the deadline is "not checked yet", not timed out', async () => {
		const { fetcher } = slowCounter(80);
		const r = await checkLinks(['https://p0.example.com/', 'https://p1.example.com/'], fetcher, { limiter: linkLimiter(1), deadline: Date.now() + 40, retryDelayMs: 0 });
		expect(r.unfinished).toEqual(['https://p1.example.com/']);
		expect(r.probes.map((p) => classifyProbe(p))).toEqual(['ok']);
	});
});

describe('6: no merge-tag sampling in the tick (#479)', () => {
	const MERGE_HTML = `<a href="${LINK}">Deck</a> <a href="{{field:website}}">Your site</a> <a href="%%UNSUB_URL%%">Unsubscribe</a>`;
	beforeEach(async () => {
		await db.prepare(`UPDATE contacts SET meta = '{"website":"https://ann.example.com/"}'`).run();
	});

	it('the tick probes only plain links and reports merge-tag links as checked when composing, even under Strict', async () => {
		await savePresendPolicy(db, { ...DEFAULT_POLICY, enforcement: 'strict', retryMinutes: 0, levels: { 'links.live_skipped': 'block', 'links.live_merge': 'block' } });
		const id = await scheduledWith(MERGE_HTML);
		const { fetcher, calls } = fake({ [LINK]: status(200) });
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
		expect(calls).toEqual([`HEAD ${LINK}`]);
		const report = JSON.parse((await rowOf(id))!.preflight_report!) as { checks: Check[] };
		expect(byId(report.checks, MERGE_AT_COMPOSE_ID)).toMatchObject({ level: 'pass', title: '1 merge-tag link checked when composing, not at send time' });
		expect(byId(report.checks, 'links.live_skipped')).toBeUndefined();
	});

	it('Re-check now still samples merge-tag links', async () => {
		const id = await scheduledWith(MERGE_HTML);
		await db.prepare(`UPDATE campaigns SET held_at = datetime('now'), held_reason = 'preflight' WHERE id = ?`).bind(id).run();
		const { fetcher, calls } = fake({ [LINK]: status(200), 'https://ann.example.com/': status(200) });
		expect(await recheckHeld(db, id, { fetcher, retryDelayMs: 0 })).toMatchObject({ ok: true, released: true });
		expect(calls).toContain('HEAD https://ann.example.com/');
	});
});

describe('7: the read-to-claim gap (#479)', () => {
	it('rescheduled during the check: not claimed, not sent, still scheduled', async () => {
		const id = await scheduled();
		const fetcher: Fetcher = async () => {
			await db.prepare(`UPDATE campaigns SET scheduled_at = datetime('now', '+1 hour') WHERE id = ?`).bind(id).run();
			return new Response(null, { status: 200 });
		};
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 0, failed: 0 });
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect((await rowOf(id))!.status).toBe('scheduled');
		expect(await claimScheduledCampaign(db, id, '2000-01-01 00:00:00')).toBe(false);
	});

	it('sends the content re-read after the claim', async () => {
		const id = await scheduled();
		const fetcher: Fetcher = async () => {
			await db
				.prepare(`UPDATE campaigns SET subject = 'Deck day (v2)', from_email = 'news@ourco.example', body_html = '<p>v2 <a href="%%UNSUB_URL%%">Unsubscribe</a></p>', body_text = 'v2' WHERE id = ?`)
				.bind(id)
				.run();
			return new Response(null, { status: 200 });
		};
		expect(await processScheduledCampaigns(db, cfg, { preflight: { fetcher, retryDelayMs: 0 } })).toEqual({ fired: 1, failed: 0 });
		const sent = spies.sendCampaignEmail.mock.calls[0][1] as { subject: string; from: string; htmlTemplate: string; textTemplate: string };
		expect(sent).toMatchObject({ subject: 'Deck day (v2)', from: 'news@ourco.example', textTemplate: 'v2' });
		expect(sent.htmlTemplate).toContain('v2');
	});
});

describe('Strict: links the limits did not reach (#479)', () => {
	it('held as "could not check all links" (the checker failing stays "links could not be checked")', () => {
		const r = summarize([{ id: 'links.live_unfinished', category: 'links', level: 'block', title: '3 links not checked yet' }], true);
		expect(heldSummary(r)).toBe('could not check all links');
		expect(heldSummary(checkerErrorReport(new Date()))).toBe('links could not be checked');
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	checkLevel,
	checkRates,
	DEFAULT_THRESHOLDS,
	formatRate,
	levelFor,
	normalizeAlertConfig,
	thresholdsProblem,
	trendDirection
} from '../src/lib/deliverability-alerts';
import {
	activeAlerts,
	automationCounts,
	buildAlertPayload,
	campaignCounts,
	dismissAlert,
	heldCampaigns,
	releaseHeldCampaign,
	runDeliverabilityChecks,
	saveAlertConfig,
	sqlTime,
	weeklyDigest
} from '../src/lib/server/deliverability-alerts';
import { claimScheduledCampaign, processScheduledCampaigns } from '../src/lib/server/scheduled';
import { recentActivity } from '../src/lib/server/activity';

// #305: post-send deliverability alerts.
const db = (env as any).DB as D1Database;
const APP = 'https://crm.example.test';
const HOUR = 3_600_000;
// #386: tests that read a time window run on a fixed clock, never the wall clock.
const FIXED_NOW = new Date('2026-10-14T15:30:00Z');

async function list(name = 'Newsletter'): Promise<number> {
	return (await db.prepare(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`).bind(name).first<{ id: number }>())!.id;
}

async function campaign(opts: { listId?: number | null; status?: string; sentAt?: string | null; scheduledAt?: string | null; automationId?: number | null; subject?: string }): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, list_id, status, sent_at, scheduled_at, automation_id)
			 VALUES (?, 'md', '<p>x %%UNSUB_URL%%</p>', 'alan@ourco.example', ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(opts.subject ?? 'Hello', opts.listId ?? null, opts.status ?? 'sent', opts.sentAt ?? null, opts.scheduledAt ?? null, opts.automationId ?? null)
		.first<{ id: number }>())!.id;
}

/** `sent` accepted recipients; the first `hard` hard-bounce, the next `soft` soft-bounce, `spam` complain. */
async function fill(campaignId: number, n: { sent: number; hard?: number; soft?: number; spam?: number; delivered?: boolean; at?: string }) {
	const stmts: D1PreparedStatement[] = [];
	const ids: number[] = [];
	for (let i = 0; i < n.sent; i++) {
		const r = await db
			.prepare(`INSERT INTO recipients (campaign_id, email, message_id, status) VALUES (?, ?, ?, 'accepted') RETURNING id`)
			.bind(campaignId, `r${campaignId}-${i}@x.test`, `m${campaignId}-${i}`)
			.first<{ id: number }>();
		ids.push(r!.id);
	}
	const at = n.at ?? sqlTime(new Date());
	const ev = (rid: number, type: string, detail: string | null) =>
		db.prepare(`INSERT INTO events (campaign_id, recipient_id, type, message_id, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(campaignId, rid, type, `m${rid}`, detail, at);
	let i = 0;
	for (let k = 0; k < (n.hard ?? 0); k++) stmts.push(ev(ids[i++], 'bounce', '{"Type":"HardBounce","Description":"Unknown user"}'));
	for (let k = 0; k < (n.soft ?? 0); k++) stmts.push(ev(ids[i++], 'bounce', '{"Type":"SoftBounce"}'));
	for (let k = 0; k < (n.spam ?? 0); k++) stmts.push(ev(ids[k], 'spam', '{"Type":"SpamComplaint"}'));
	if (n.delivered) for (let k = i; k < n.sent; k++) stmts.push(ev(ids[k], 'delivery', null));
	for (let c = 0; c < stmts.length; c += 50) await db.batch(stmts.slice(c, c + 50));
}

const checks = (refId: number) =>
	db.prepare(`SELECT check_key, level FROM deliverability_checks WHERE ref_id = ? ORDER BY id`).bind(refId).all<{ check_key: string; level: string }>().then((r) => r.results);

beforeEach(async () => {
	vi.unstubAllGlobals();
	await db.batch([
		db.prepare('DELETE FROM deliverability_checks'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare("DELETE FROM app_state WHERE key = 'deliverability_alerts_config'")
	]);
});

describe('rate maths + thresholds', () => {
	it('computes rates over sent, 0 when nothing was sent', () => {
		expect(checkRates({ sent: 1170, bounces: 140, hard_bounces: 120, complaints: 1 })).toEqual({
			bounceRate: 140 / 1170,
			hardRate: 120 / 1170,
			complaintRate: 1 / 1170
		});
		expect(checkRates({ sent: 0, bounces: 3, hard_bounces: 3, complaints: 0 })).toEqual({ bounceRate: 0, hardRate: 0, complaintRate: 0 });
	});

	it('a rate AT a threshold is that level', () => {
		const t = DEFAULT_THRESHOLDS;
		expect(levelFor(0.0199, t.hardWarn, t.hardCrit)).toBe('ok');
		expect(levelFor(2 / 100, t.hardWarn, t.hardCrit)).toBe('warning');
		expect(levelFor(0.0499, t.hardWarn, t.hardCrit)).toBe('warning');
		expect(levelFor(5 / 100, t.hardWarn, t.hardCrit)).toBe('critical');
		expect(levelFor(4 / 10000, t.complaintWarn, t.complaintCrit)).toBe('ok');
		expect(levelFor(5 / 10000, t.complaintWarn, t.complaintCrit)).toBe('warning');
		expect(levelFor(1 / 2000, t.complaintWarn, t.complaintCrit)).toBe('warning');
		expect(levelFor(1 / 1000, t.complaintWarn, t.complaintCrit)).toBe('critical');
	});

	it('the check level is the worse of hard bounces and complaints; soft bounces have no threshold', () => {
		const t = DEFAULT_THRESHOLDS;
		expect(checkLevel({ sent: 1000, bounces: 30, hard_bounces: 0, complaints: 0 }, t).level).toBe('ok');
		expect(checkLevel({ sent: 1000, bounces: 20, hard_bounces: 20, complaints: 0 }, t)).toEqual({ level: 'warning', hard: 'warning', complaint: 'ok' });
		expect(checkLevel({ sent: 1000, bounces: 20, hard_bounces: 20, complaints: 1 }, t)).toEqual({ level: 'critical', hard: 'warning', complaint: 'critical' });
		expect(checkLevel({ sent: 0, bounces: 0, hard_bounces: 0, complaints: 0 }, t).level).toBe('ok');
	});

	it('formats, trends, validates and normalises', () => {
		expect(formatRate(0.12)).toBe('12.0%');
		expect(formatRate(0.0005)).toBe('0.05%');
		expect(trendDirection(0.03, 0.02)).toBe('up');
		expect(trendDirection(0.01, 0.02)).toBe('down');
		expect(trendDirection(0.02, 0.02)).toBe('flat');
		expect(thresholdsProblem(DEFAULT_THRESHOLDS)).toBeNull();
		expect(thresholdsProblem({ ...DEFAULT_THRESHOLDS, hardWarn: 0.05 })).toMatch(/below the critical/);
		expect(thresholdsProblem({ ...DEFAULT_THRESHOLDS, complaintCrit: 0 })).toMatch(/above 0/);
		expect(normalizeAlertConfig(null)).toEqual({ ...DEFAULT_THRESHOLDS, webhookUrl: '', webhookFormat: 'json', holdOnCritical: false });
		// A warn above crit falls back to the defaults as a set.
		expect(normalizeAlertConfig({ hardWarn: 0.5, hardCrit: 0.1, holdOnCritical: true }).hardWarn).toBe(DEFAULT_THRESHOLDS.hardWarn);
		expect(normalizeAlertConfig({ holdOnCritical: 'yes' }).holdOnCritical).toBe(false);
	});
});

describe('counts', () => {
	it('counts distinct recipients per campaign, hard by the bounce-filter rule', async () => {
		const c = await campaign({ listId: await list() });
		await fill(c, { sent: 100, hard: 4, soft: 3, spam: 1 });
		expect(await campaignCounts(db, c)).toEqual({ sent: 100, bounces: 7, hard_bounces: 4, complaints: 1 });
	});

	it('automation counts are mail that landed in the last 7 days', async () => {
		const a = (await db.prepare(`INSERT INTO automations (name, status) VALUES ('Nurture', 'active') RETURNING id`).first<{ id: number }>())!.id;
		const now = FIXED_NOW;
		const recent = await campaign({ automationId: a, sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		const old = await campaign({ automationId: a, sentAt: sqlTime(new Date(now.getTime() - 10 * 24 * HOUR)) });
		await fill(recent, { sent: 10, hard: 2, delivered: true, at: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		await fill(old, { sent: 10, hard: 5, delivered: true, at: sqlTime(new Date(now.getTime() - 10 * 24 * HOUR)) });
		expect(await automationCounts(db, a, now)).toEqual({ sent: 10, bounces: 2, hard_bounces: 2, complaints: 0 });
	});
});

describe('runDeliverabilityChecks', () => {
	it('fires the 2h and the 24h check once each', async () => {
		const now = new Date();
		const c = await campaign({ listId: await list(), sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		await fill(c, { sent: 100, hard: 3 });

		expect((await runDeliverabilityChecks(db, { appUrl: APP, now })).checked).toBe(1);
		expect(await checks(c)).toEqual([{ check_key: '2h', level: 'warning' }]);
		expect((await runDeliverabilityChecks(db, { appUrl: APP, now })).checked).toBe(0);

		const later = new Date(now.getTime() + 22 * HOUR); // 25 h after sending
		expect((await runDeliverabilityChecks(db, { appUrl: APP, now: later })).checked).toBe(1);
		expect((await runDeliverabilityChecks(db, { appUrl: APP, now: later })).checked).toBe(0);
		expect(await checks(c)).toEqual([
			{ check_key: '2h', level: 'warning' },
			{ check_key: '24h', level: 'warning' }
		]);
	});

	it('skips sends under 2 h old, older than 72 h, and direct sends', async () => {
		const now = new Date();
		const l = await list();
		const young = await campaign({ listId: l, sentAt: sqlTime(new Date(now.getTime() - HOUR)) });
		const ancient = await campaign({ listId: l, sentAt: sqlTime(new Date(now.getTime() - 100 * HOUR)) });
		const direct = await campaign({ listId: null, sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		for (const id of [young, ancient, direct]) await fill(id, { sent: 10, hard: 5 });
		expect((await runDeliverabilityChecks(db, { appUrl: APP, now })).checked).toBe(0);
	});

	it('checks each automation once a day over 7 days', async () => {
		// #386: a fixed clock, and events stamped before it. The events used to be stamped with
		// the wall clock *after* `now`, so a second boundary between the two left them outside
		// the window (the window ends at `now`) and the check saw nothing.
		const now = FIXED_NOW;
		const a = (await db.prepare(`INSERT INTO automations (name, status) VALUES ('Oct 12 drip', 'active') RETURNING id`).first<{ id: number }>())!.id;
		const step = await campaign({ automationId: a, sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		await fill(step, { sent: 50, hard: 9, delivered: true, at: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		const first = await runDeliverabilityChecks(db, { appUrl: APP, now });
		expect(first.critical).toBe(1);
		expect((await runDeliverabilityChecks(db, { appUrl: APP, now })).checked).toBe(0);
		const rows = await checks(a);
		expect(rows).toEqual([{ check_key: '7d:2026-10-14', level: 'critical' }]);
	});

	it('automation check at 23:59:59 UTC counts mail from the same second and keys on that UTC day', async () => {
		const now = new Date('2026-10-14T23:59:59.900Z');
		const a = (await db.prepare(`INSERT INTO automations (name, status) VALUES ('Late drip', 'active') RETURNING id`).first<{ id: number }>())!.id;
		const step = await campaign({ automationId: a, sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		// recorded_at '2026-10-14 23:59:59' — the same truncated second as `now`.
		await fill(step, { sent: 50, hard: 9, delivered: true, at: sqlTime(now) });
		const first = await runDeliverabilityChecks(db, { appUrl: APP, now });
		expect(first.critical).toBe(1);
		expect(await checks(a)).toEqual([{ check_key: '7d:2026-10-14', level: 'critical' }]);
		// One second later is a new UTC day: a new check, same mail still inside the 7 days.
		const next = await runDeliverabilityChecks(db, { appUrl: APP, now: new Date(now.getTime() + 1000) });
		expect(next.critical).toBe(1);
		expect((await checks(a)).map((r) => r.check_key)).toEqual(['7d:2026-10-14', '7d:2026-10-15']);
	});

	it('records the banner and an activity row; dismiss hides it', async () => {
		const now = new Date();
		const c = await campaign({ listId: await list(), subject: 'Campaign 47', sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		await fill(c, { sent: 100, hard: 12, soft: 2 });
		await runDeliverabilityChecks(db, { appUrl: APP, now });
		const alerts = await activeAlerts(db);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ level: 'critical', title: 'Campaign 47', href: `/campaign/${c}`, bounced_href: `/contacts?campaign=${c}&campaign_who=bounced` });
		expect(alerts[0].reasons).toEqual([
			{ reason: 'HardBounce', n: 12 },
			{ reason: 'SoftBounce', n: 2 }
		]);
		const feed = await recentActivity(db, { types: ['deliverability'] });
		expect(feed.map((f) => [f.type, f.campaign_id, f.detail, f.check_key])).toEqual([['deliverability', c, 'critical', '2h']]);
		await dismissAlert(db, alerts[0].id, null);
		expect(await activeAlerts(db)).toEqual([]);
	});

	it('posts the webhook on warning/critical only', async () => {
		const now = new Date();
		await saveAlertConfig(db, { ...normalizeAlertConfig(null), webhookUrl: 'https://hooks.example.test/x' });
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
		const l = await list();
		const bad = await campaign({ listId: l, subject: 'Bad', sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		const fine = await campaign({ listId: l, subject: 'Fine', sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		await fill(bad, { sent: 100, hard: 6 });
		await fill(fine, { sent: 100, hard: 1 });
		const sum = await runDeliverabilityChecks(db, { appUrl: APP, now, fetch: fetchMock as unknown as typeof fetch });
		expect(sum).toMatchObject({ checked: 2, critical: 1, webhooks: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://hooks.example.test/x');
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({ event: 'deliverability_alert', level: 'critical', scope: 'campaign', check: '2h', sent: 100, hard_bounces: 6 });
		expect(body.campaign).toEqual({ id: bad, subject: 'Bad', url: `${APP}/campaign/${bad}` });
		const row = await db.prepare(`SELECT webhook_status FROM deliverability_checks WHERE ref_id = ?`).bind(bad).first<{ webhook_status: number }>();
		expect(row?.webhook_status).toBe(200);
	});
});

describe('webhook payload', () => {
	const input = {
		level: 'critical' as const,
		scope: 'campaign' as const,
		check: '24h',
		campaign: { id: 47, subject: 'Oct <news>' },
		automation: null,
		counts: { sent: 1170, bounces: 140, hard_bounces: 120, complaints: 1 },
		thresholds: DEFAULT_THRESHOLDS,
		reasons: [{ reason: 'HardBounce', n: 120 }],
		held: [52],
		checkedAt: '2026-10-17 10:00:00',
		appUrl: `${APP}/`
	};

	it('json carries rates, thresholds, links and held ids', () => {
		expect(JSON.parse(buildAlertPayload('json', input))).toEqual({
			event: 'deliverability_alert',
			level: 'critical',
			scope: 'campaign',
			check: '24h',
			campaign: { id: 47, subject: 'Oct <news>', url: `${APP}/campaign/47` },
			automation: null,
			sent: 1170,
			bounces: 140,
			hard_bounces: 120,
			complaints: 1,
			bounce_rate: 140 / 1170,
			hard_bounce_rate: 120 / 1170,
			complaint_rate: 1 / 1170,
			thresholds: { hard_bounce_warning: 0.02, hard_bounce_critical: 0.05, complaint_warning: 0.0005, complaint_critical: 0.001 },
			top_reasons: [{ reason: 'HardBounce', n: 120 }],
			bounced_contacts_url: `${APP}/contacts?campaign=47&campaign_who=bounced`,
			held_campaign_ids: [52],
			checked_at: '2026-10-17 10:00:00',
			app_url: APP
		});
	});

	it('slack is one escaped mrkdwn text', () => {
		const { text } = JSON.parse(buildAlertPayload('slack', input));
		expect(text).toContain('*Deliverability critical* on campaign “Oct &lt;news&gt;” (24 hours after sending)');
		expect(text).toContain('Hard bounces 10.3%');
		expect(text).toContain('Held 1 scheduled send');
		expect(text).toContain(`<${APP}/contacts?campaign=47&campaign_who=bounced|Open bounced contacts>`);
	});
});

describe('hold + release', () => {
	async function criticalWithQueued(hold: boolean) {
		const now = new Date();
		await saveAlertConfig(db, { ...normalizeAlertConfig(null), holdOnCritical: hold });
		const l = await list();
		const other = await list('Other');
		const sent = await campaign({ listId: l, sentAt: sqlTime(new Date(now.getTime() - 3 * HOUR)) });
		await fill(sent, { sent: 100, hard: 10 });
		const due = sqlTime(new Date(now.getTime() - 60_000));
		const queued = await campaign({ listId: l, status: 'scheduled', scheduledAt: due, subject: 'Next week' });
		const elsewhere = await campaign({ listId: other, status: 'scheduled', scheduledAt: sqlTime(new Date(now.getTime() + 24 * HOUR)) });
		const sum = await runDeliverabilityChecks(db, { appUrl: APP, now });
		return { sum, queued, elsewhere };
	}
	const cfg = { token: 't', secret: 's', baseUrl: APP, stream: 'broadcast' };

	it('off by default: nothing is held', async () => {
		const { sum, queued } = await criticalWithQueued(false);
		expect(sum.held).toBe(0);
		expect((await db.prepare(`SELECT held_at FROM campaigns WHERE id = ?`).bind(queued).first<{ held_at: string | null }>())?.held_at).toBeNull();
	});

	it('holds the same list only; the held send does not go out; release restores it', async () => {
		const { sum, queued, elsewhere } = await criticalWithQueued(true);
		expect(sum.held).toBe(1);
		expect((await heldCampaigns(db)).map((h) => h.id)).toEqual([queued]);
		expect((await activeAlerts(db))[0].held.map((h) => h.id)).toEqual([queued]);
		const statusOf = async (id: number) => (await db.prepare(`SELECT status, held_at FROM campaigns WHERE id = ?`).bind(id).first<{ status: string; held_at: string | null }>())!;
		expect((await statusOf(elsewhere)).held_at).toBeNull();

		// The scheduler never picks it up, and a direct claim is refused too. Never cancelled.
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 0, failed: 0 });
		expect(await claimScheduledCampaign(db, queued)).toBe(false);
		expect((await statusOf(queued)).status).toBe('scheduled');

		// Release: back on its schedule (already due → the next tick takes it; its list is
		// empty here, so it's claimed and fails with "No subscribed contacts").
		expect(await releaseHeldCampaign(db, queued)).toBe(true);
		expect(await releaseHeldCampaign(db, queued)).toBe(false);
		expect(await statusOf(queued)).toEqual({ status: 'scheduled', held_at: null });
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 0, failed: 1 });
		expect((await statusOf(queued)).status).toBe('failed');
	});
});

describe('weekly digest', () => {
	it('compares the last 7 days with the 7 before', async () => {
		const now = new Date();
		const l = await list();
		const thisWeek = await campaign({ listId: l, sentAt: sqlTime(now) });
		const lastWeek = await campaign({ listId: l, sentAt: sqlTime(now) });
		// Explicit event times relative to `now`: inserting 200 rows can take over a second under
		// load, and the digest only counts events up to now + 1 s, so "stamp at insert time"
		// raced the window.
		await fill(thisWeek, { sent: 100, hard: 3, delivered: true, at: sqlTime(new Date(now.getTime() - HOUR)) });
		await fill(lastWeek, { sent: 100, hard: 1, delivered: true, at: sqlTime(new Date(now.getTime() - 10 * 24 * HOUR)) });
		const d = await weeklyDigest(db, now);
		expect(d.current).toMatchObject({ sent: 100, hard_bounces: 3, hardRate: 0.03 });
		expect(d.previous).toMatchObject({ sent: 100, hard_bounces: 1, hardRate: 0.01 });
		expect(d.hardLevel).toBe('warning');
		expect(d.complaintLevel).toBe('ok');
		expect(trendDirection(d.current.hardRate, d.previous.hardRate)).toBe('up');
	});
});

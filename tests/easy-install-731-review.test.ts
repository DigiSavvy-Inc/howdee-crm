// #731 review fixes: automation steps with no From, the tick with no sending credentials, the
// public address chosen in the wizard, the webhook pointing at an old host, "Finish setup" as an
// inline form error, the reply-forward sender stand-in, and an install with every var set.
// Postmark's low-level send client is stubbed: nothing here sends for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';

const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import webhookRouteSrc from '../src/routes/api/webhook/+server.ts?raw';
import setupPageSrc from '../src/routes/settings/setup/+page.svelte?raw';
import { enroll, SETUP_HOLD_FAILED_FROM, SETUP_HOLD_FAILED_SENDING, tick } from '../src/lib/server/automations';
import { FINISH_SETUP_FROM, FINISH_SETUP_SENDING } from '../src/lib/finish-setup';
import { resolveMailCredentials, setPostmarkToken, UNREADABLE_TOKEN_ERROR } from '../src/lib/server/mail/config';
import { webhookMatches, webhookTarget } from '../src/lib/server/mail/postmark';
import { ensurePostmarkWebhook, INGESTED_WEBHOOK_EVENTS, pmMessage, scrubSecrets, webhookTriggersFor } from '../src/lib/server/mail/postmark-webhook';
import { clearDomainCache, looksLikeVersionPreview, recordSeenOrigin, SEEN_BASE_URL_KEY } from '../src/lib/server/public-url';
import { localRequiredChecks } from '../src/lib/server/setup-checks';
import { SENDS_SKIPPED_KEY, SKIP_KEY, withClock } from '../src/lib/server/internal-tick';
import { emailDomain, forwardFallbackAddress, forwardSenderAddress, sendingDomain, withSenderStandIn } from '../src/lib/server/reply-forward';
import { conversationsFor } from '../src/lib/server/conversations';
import { POST as tickPOST } from '../src/routes/api/automations/tick/+server';
import { POST as inboundPOST } from '../src/routes/api/inbound/+server';
import { load as setupPageLoad, actions as wizardActions } from '../src/routes/settings/setup/+page.server';
import { actions as composeActions } from '../src/routes/compose/+page.server';
import { actions as convActions } from '../src/routes/conversations/+page.server';
import { actions as campaignActions } from '../src/routes/campaign/[id]/+page.server';
import { actions as automationActions } from '../src/routes/automations/[id]/+page.server';

const db = (testEnv as any).DB as D1Database;
const ADMIN = { id: 1, github_login: 'ourco-admin', role: 'admin' };
const MEMBER = { id: 2, github_login: 'jdoe', role: 'member' };
const FROM = 'news@ourco.example';

/** An env with none of the template's vars. */
const bareEnv = (extra: Record<string | symbol, unknown> = {}): Record<string | symbol, unknown> => ({ DB: db, SESSION_SECRET: 'secret-731', CRON_KEY: 'ck-731', ...extra });
/** An env with every var and secret set, as a filled-in wrangler.jsonc has. */
const fullEnv = (extra: Record<string | symbol, unknown> = {}) =>
	bareEnv({
		POSTMARK_TOKEN: 'server-token-731',
		POSTMARK_FROM: 'alan@ourco.example',
		POSTMARK_STREAM: 'news',
		POSTMARK_STREAM_TX: 'outbound',
		PUBLIC_BASE_URL: 'https://env.example.com',
		WEBHOOK_KEY: 'whk-731-abcdef', // gitleaks:allow
		...extra
	});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;
const newId = async (sql: string, ...binds: unknown[]) => (await one<{ id: number }>(sql, ...binds)).id;
const state = async (key: string) => (await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string | null }>())?.value ?? null;
const setState = (key: string, value: string) =>
	db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();

function formEvent(url: string, fields: Record<string, string | string[]> = {}, opts: { env?: Record<string | symbol, unknown>; user?: unknown } = {}) {
	const u = new URL(url);
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
	return {
		url: u,
		params: {},
		request: new Request(u, { method: 'POST', body: fd }),
		platform: { env: opts.env ?? bareEnv() },
		locals: { user: opts.user === undefined ? ADMIN : opts.user },
		getClientAddress: () => '203.0.113.9'
	} as any;
}
const getEvent = (url: string, opts: { env?: Record<string | symbol, unknown>; user?: unknown } = {}) =>
	({ url: new URL(url), params: {}, request: new Request(url), platform: { env: opts.env ?? bareEnv() }, locals: { user: opts.user === undefined ? ADMIN : opts.user } }) as any;

async function runAction(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}

async function httpTick(env: Record<string | symbol, unknown>) {
	const url = new URL('https://crm.example.com/api/automations/tick?key=ck-731');
	const res = await tickPOST({ url, params: {}, request: new Request(url, { method: 'POST' }), locals: { user: null }, platform: { env } } as any);
	return { status: res.status, body: (await res.json()) as any };
}

const sentMessages = () => spies.sendBatch.mock.calls.flatMap((c) => c[1] as { From: string; To: string; HtmlBody: string; Headers?: unknown }[]);

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` })));
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM login_attempts`),
		db.prepare(
			`DELETE FROM app_state WHERE key LIKE 'custom_domain%' OR key IN (?, ?, ?, 'last_tick', 'last_tick_clock', 'default_from', 'approved_senders', 'mail_settings', 'reply_bcc_operator', 'presend_enforcement')`
		).bind(SEEN_BASE_URL_KEY, SKIP_KEY, SENDS_SKIPPED_KEY)
	]);
	clearDomainCache();
});
afterEach(() => vi.restoreAllMocks());

/** An active automation whose one email step has `from` as its From, with one contact due on it. */
async function emailFlow(from: string, email = 'reader@example.net') {
	const aid = await newId("INSERT INTO automations (name, status, reentry) VALUES ('Welcome 731', 'active', 'once') RETURNING id");
	await db
		.prepare(`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type) VALUES (?, 0, 0, 'Hello', 'Body text here.', ?, 'email')`)
		.bind(aid, from)
		.run();
	const cid = await newId('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email);
	await enroll(db, aid, [cid]);
	return { aid, cid };
}
const pass = (aid: number) =>
	one<{ status: string; attempts: number; last_error: string | null; next_run_at: string | null; future: number }>(
		`SELECT status, attempts, last_error, next_run_at, next_run_at > datetime('now') AS future FROM automation_enrollments WHERE automation_id = ?`,
		aid
	);
const cfg = (extra: Record<string, unknown> = {}) => ({ token: 'server-token-731', secret: 's', baseUrl: 'https://crm.example.com', stream: 'broadcast', ...extra }) as any;

describe('automation email steps saved with no From', () => {
	it('an empty step From sends from Settings → General → Default From', async () => {
		await setState('default_from', FROM);
		const { aid } = await emailFlow('');
		const sum = await tick(db, cfg({ envFrom: 'alan@ourco.example' }));
		expect(sum.sent).toBe(1);
		expect(sentMessages().map((m) => m.From)).toEqual([FROM]);
		expect((await pass(aid)).status).toBe('completed');
	});

	it('with no Default From it falls back to POSTMARK_FROM', async () => {
		await emailFlow('');
		await tick(db, cfg({ envFrom: 'alan@ourco.example' }));
		expect(sentMessages().map((m) => m.From)).toEqual(['alan@ourco.example']);
	});

	it('with neither it sends nothing and holds the pass to retry, attempts untouched', async () => {
		const { aid } = await emailFlow('');
		for (let i = 0; i < 3; i++) {
			const sum = await tick(db, cfg());
			if (i === 0) expect(sum.held).toBe(1);
			// Make it due again, as the recheck would.
			await db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 second') WHERE automation_id = ?`).bind(aid).run();
		}
		expect(spies.sendBatch).not.toHaveBeenCalled();
		const p = await pass(aid);
		expect(p.status).toBe('active');
		expect(p.attempts).toBe(0);
		expect(p.last_error).toBe(FINISH_SETUP_FROM);
		// Once a sender exists, the next pass sends and clears the message.
		await setState('default_from', FROM);
		await tick(db, cfg());
		expect(sentMessages().map((m) => m.From)).toEqual([FROM]);
		const after = await pass(aid);
		expect(after.status).toBe('completed');
		expect(after.last_error).toBeNull();
	});

	it('a step with its own From is untouched by Default From and POSTMARK_FROM', async () => {
		await setState('default_from', FROM);
		await emailFlow('step@ourco.example');
		await tick(db, cfg({ envFrom: 'alan@ourco.example' }));
		expect(sentMessages().map((m) => m.From)).toEqual(['step@ourco.example']);
	});

	it('with no sending provider the step is held (not failed) with "Finish setup"', async () => {
		const { aid } = await emailFlow('step@ourco.example');
		const sum = await tick(db, cfg({ token: '', provider: null }));
		expect(sum.held).toBe(1);
		expect(spies.sendBatch).not.toHaveBeenCalled();
		const p = await pass(aid);
		expect(p).toMatchObject({ status: 'active', attempts: 0, last_error: FINISH_SETUP_SENDING, future: 1 });
	});

	it('a send that already went out on an earlier (crashed) tick is advanced, not held', async () => {
		const { aid, cid } = await emailFlow('');
		const step = await newId('SELECT id FROM automation_steps WHERE automation_id = ?', aid);
		const enr = await newId('SELECT id FROM automation_enrollments WHERE automation_id = ?', aid);
		const camp = await newId(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id) VALUES ('Hello', 'm', 'h', ?, 'sending', ?, ?) RETURNING id`,
			FROM,
			aid,
			step
		);
		await db
			.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, message_id, status, enrollment_id, enrollment_visit) VALUES (?, ?, 'reader@example.net', 'pm-crash', 'accepted', ?, 0)`)
			.bind(camp, cid, enr)
			.run();
		const sum = await tick(db, cfg()); // no Default From, no POSTMARK_FROM
		expect(sum.held).toBe(0);
		expect(spies.sendBatch).not.toHaveBeenCalled();
		const p = await pass(aid);
		expect(p.status).toBe('completed');
		expect(p.last_error).toBeNull();
	});

	/** Backdate this pass's "Finish setup" held events, then make the pass due again. */
	async function heldFor(aid: number, hours: number) {
		await db.prepare(`UPDATE automation_enrollment_events SET at = datetime('now', ?) WHERE automation_id = ? AND kind = 'held'`).bind(`-${hours} hours`, aid).run();
		await db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 second') WHERE automation_id = ?`).bind(aid).run();
	}

	it('a pass held for no sender for 24 hours since its first hold fails; before that it stays held', async () => {
		const { aid } = await emailFlow('');
		expect((await tick(db, cfg())).held).toBe(1);
		await heldFor(aid, 23);
		expect((await tick(db, cfg())).held).toBe(1);
		expect(await pass(aid)).toMatchObject({ status: 'active', attempts: 0, last_error: FINISH_SETUP_FROM });
		await heldFor(aid, 25);
		const sum = await tick(db, cfg());
		expect(sum.failed).toBe(1);
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await pass(aid)).toMatchObject({ status: 'failed', attempts: 0, last_error: SETUP_HOLD_FAILED_FROM, next_run_at: null });
		const failed = await one<{ detail: string }>(`SELECT detail FROM automation_enrollment_events WHERE automation_id = ? AND kind = 'failed'`, aid);
		expect(failed.detail).toBe(SETUP_HOLD_FAILED_FROM);
	});

	it('a pass held for no sending provider for 24 hours fails with its own reason', async () => {
		const { aid } = await emailFlow('step@ourco.example');
		await tick(db, cfg({ token: '', provider: null }));
		await heldFor(aid, 25);
		await tick(db, cfg({ token: '', provider: null }));
		expect(await pass(aid)).toMatchObject({ status: 'failed', attempts: 0, last_error: SETUP_HOLD_FAILED_SENDING });
	});

	it('Settings → Setup lists the waiting emails while any pass is held for them, counts only', async () => {
		const { aid } = await emailFlow('');
		await emailFlow('step@ourco.example', 'second@example.net');
		const rows = async () => (await localRequiredChecks(db, bareEnv() as Record<string, unknown>)).filter((r) => r.id === 'automation_setup_holds');
		expect(await rows()).toEqual([]);
		await tick(db, cfg({ token: '', provider: null }));
		const [sending] = await rows();
		expect(sending.state).toBe('attention');
		expect(sending.detail).toContain('2 automation emails are waiting: no sending provider configured.');
		await db.prepare(`UPDATE automation_enrollments SET last_error = ? WHERE automation_id = ?`).bind(FINISH_SETUP_FROM, aid).run();
		const [mixed] = await rows();
		expect(mixed.detail).toContain('1 automation email is waiting: no sending provider configured.');
		expect(mixed.detail).toContain('1 automation email is waiting: no sender configured.');
		await db.prepare(`UPDATE automation_enrollments SET status = 'failed'`).run();
		expect(await rows()).toEqual([]);
	});
});

describe('the tick with no sending credentials', () => {
	async function dueScheduled(): Promise<number> {
		const list = await newId("INSERT INTO lists (name, kind) VALUES ('News 731', 'list') RETURNING id");
		const cid = await newId("INSERT INTO contacts (email, subscribed) VALUES ('sub@example.net', 1) RETURNING id");
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, cid).run();
		// A real broadcast body carries the unsubscribe link in both parts: without it the send
		// path refuses the message (#373, "Not sent: unsubscribe path incomplete").
		return await newId(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, scheduled_at, recipient_count)
			 VALUES ('Scheduled', 'Hi', '<p>Hi there</p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>', 'Hi there\n\nUnsubscribe: %%UNSUB_URL%%', ?, ?, 'scheduled', datetime('now', '-5 minutes'), 1) RETURNING id`,
			list,
			FROM
		);
	}

	it('skips every send, leaves scheduled campaigns scheduled and unclaimed, runs housekeeping and stamps the tick', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const campaign = await dueScheduled();
		const { aid } = await emailFlow(FROM, 'flow@example.net');
		// Housekeeping evidence: a sign-in attempt older than the 30-day retention.
		await db.prepare(`INSERT INTO login_attempts (username, ip, ok, at) VALUES ('old', 'ip', 0, datetime('now', '-40 days'))`).run();

		const { status, body } = await httpTick(bareEnv());
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.skipped_sends).toBe('no_sending_token');
		expect(body.scheduled).toEqual({ skipped: 'no_sending_token' });
		expect(body.bestTime).toEqual({ skipped: 'no_sending_token' });
		expect(body.resends).toEqual({ skipped: 'no_sending_token' });
		expect(spies.sendBatch).not.toHaveBeenCalled();

		const c = await one<{ status: string; held_at: string | null }>('SELECT status, held_at FROM campaigns WHERE id = ?', campaign);
		expect(c).toEqual({ status: 'scheduled', held_at: null });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?').bind(campaign).first<number>('n'))).toBe(0);
		expect(await pass(aid)).toMatchObject({ status: 'active', attempts: 0, last_error: FINISH_SETUP_SENDING });

		// Housekeeping ran.
		expect(body.loginAttempts.deleted).toBeGreaterThanOrEqual(1);
		expect(body.engagement?.error).toBeUndefined();
		expect(body.scoring?.error).toBeUndefined();
		expect(body.backup).toBeDefined();
		const last = JSON.parse((await state('last_tick'))!);
		expect(last.skipped_sends).toBe('no_sending_token');
		expect(await state(SENDS_SKIPPED_KEY)).toBe('no_sending_token');

		const row = (await localRequiredChecks(db, bareEnv() as Record<string, unknown>)).find((r) => r.id === 'tick_no_sending');
		expect(row?.state).toBe('attention');
		// Provider-aware: once the provider resolution has credentials the row goes.
		expect((await localRequiredChecks(db, bareEnv({ POSTMARK_TOKEN: 'server-token-731' }) as Record<string, unknown>)).some((r) => r.id === 'tick_no_sending')).toBe(false);
	});

	it('the built-in clock with no credentials also answers 200 (the clock logs it as ok)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await recordSeenOrigin(db, new URL('https://crm.example.com/setup'));
		const seen: number[] = [];
		const app = {
			fetch: async (req: Request, env: Record<string | symbol, unknown>) => {
				const res = await tickPOST({ url: new URL(req.url), params: {}, request: req, locals: { user: null }, platform: { env } } as any);
				seen.push(res.status);
				return res;
			}
		};
		await withClock(app).scheduled({}, bareEnv(), { waitUntil() {} });
		expect(seen).toEqual([200]);
		expect(await state('last_tick')).not.toBeNull();
	});

	it('a fully configured install runs the sends as before and leaves no skip marker', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setState(SENDS_SKIPPED_KEY, 'no_sending_token');
		await setState('presend_enforcement', 'warn'); // this test is about the tick, not the link checks
		const campaign = await dueScheduled();
		const { body, status } = await httpTick(fullEnv());
		expect(status).toBe(200);
		expect(body.skipped_sends).toBeUndefined();
		expect(body.scheduled.skipped).toBeUndefined();
		expect(typeof body.scheduled.fired).toBe('number');
		expect(body.bestTime?.skipped).toBeUndefined();
		// `error` is selected so a mismatch shows why the campaign failed in the assertion diff.
		const c = await one<{ status: string; sent_at: string | null; recipient_count: number; error: string | null }>(
			'SELECT status, sent_at, recipient_count, error FROM campaigns WHERE id = ?',
			campaign
		);
		expect(c).toMatchObject({ status: 'sent', recipient_count: 1, error: null });
		expect(c.sent_at).not.toBeNull();
		const r = await one<{ email: string; status: string; error: string | null }>('SELECT email, status, error FROM recipients WHERE campaign_id = ?', campaign);
		expect(r).toEqual({ email: 'sub@example.net', status: 'accepted', error: null });
		expect(sentMessages().map((m) => m.To)).toEqual(['sub@example.net']);
		expect(await state(SENDS_SKIPPED_KEY)).toBeNull();
		expect(JSON.parse((await state('last_tick'))!).skipped_sends).toBeUndefined();
	});
});

describe('the tick with a saved sending token that cannot be read', () => {
	const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

	it('is a hard error (500), not "sends skipped"', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await setPostmarkToken(db, { MAIL_TOKEN_KEY: newKey() }, 'app-token-731-unreadable', null);
		try {
			const { aid } = await emailFlow(FROM, 'flow@example.net');
			await expect(httpTick(bareEnv({ MAIL_TOKEN_KEY: newKey() }))).rejects.toSatisfy(
				(e: unknown) => isHttpError(e) && e.status === 500 && e.body.message === UNREADABLE_TOKEN_ERROR
			);
			expect(spies.sendBatch).not.toHaveBeenCalled();
			expect(await state(SENDS_SKIPPED_KEY)).toBeNull();
			expect((await pass(aid)).last_error).toBeNull();
			expect(JSON.stringify(errSpy.mock.calls)).not.toContain('app-token-731-unreadable');
		} finally {
			await db.prepare('DELETE FROM integration_secrets').run();
		}
	});
});

describe('an install with every var set', () => {
	it('the env stream beats the built-in default', async () => {
		const c = await resolveMailCredentials(db, fullEnv());
		expect(c.postmark.stream).toBe('news');
		expect(c.postmark.txStream).toBe('outbound');
	});

	it('PUBLIC_BASE_URL beats the recorded origin inside the tick', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await recordSeenOrigin(db, new URL('https://seen.example.com/setup'));
		await emailFlow('alan@ourco.example');
		const app = {
			fetch: async (req: Request, env: Record<string | symbol, unknown>) =>
				await tickPOST({ url: new URL(req.url), params: {}, request: req, locals: { user: null }, platform: { env } } as any)
		};
		await withClock(app).scheduled({}, fullEnv(), { waitUntil() {} });
		const msgs = sentMessages();
		expect(msgs).toHaveLength(1);
		const text = JSON.stringify(msgs[0]);
		expect(text).toContain('https://env.example.com/');
		expect(text).not.toContain('seen.example.com');
	});
});

describe('the address step of the wizard', () => {
	it('a page load never records the address', async () => {
		const data = (await setupPageLoad(getEvent('https://crm.example.com/settings/setup?first=1'))) as any;
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
		expect(data.wizard.address).toMatchObject({ url: 'https://crm.example.com', source: 'request', canUse: true, canClear: false, recorded: null });
		await setupPageLoad(getEvent('https://crm.example.com/settings/setup'));
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
	});

	it('a local or plain-http page is never offered as the address and says why', async () => {
		const ok = (await setupPageLoad(getEvent('https://crm.example.com/settings/setup?wizard=address'))) as any;
		expect(ok.wizard.address.currentProblem).toBeNull();
		const local = (await setupPageLoad(getEvent('http://localhost:5188/settings/setup?wizard=address'))) as any;
		expect(local.wizard.address).toMatchObject({ source: 'request', canUse: false, currentProblem: 'loopback host' });
		const plain = (await setupPageLoad(getEvent('http://crm.example.com/settings/setup?wizard=address'))) as any;
		expect(plain.wizard.address).toMatchObject({ source: 'request', canUse: false, currentProblem: 'not https' });
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
	});

	it('shows the recorded address and offers to replace it with this one, then to clear it', async () => {
		await recordSeenOrigin(db, new URL('https://old.example.com/setup'));
		const data = (await setupPageLoad(getEvent('https://new.example.com/settings/setup?wizard=address'))) as any;
		expect(data.wizard.address).toMatchObject({ url: 'https://old.example.com', source: 'seen', host: 'old.example.com', canUse: true, canClear: true, current: 'https://new.example.com' });

		const used = await (wizardActions as any).useAddress(formEvent('https://new.example.com/settings/setup?/useAddress'));
		expect(used.saved).toContain('https://new.example.com');
		expect(await state(SEEN_BASE_URL_KEY)).toBe('https://new.example.com');
		const again = (await setupPageLoad(getEvent('https://new.example.com/settings/setup?wizard=address'))) as any;
		expect(again.wizard.address.canUse).toBe(false);

		await (wizardActions as any).clearAddress(formEvent('https://new.example.com/settings/setup?/clearAddress'));
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
	});

	it('never records over Settings → Domain or PUBLIC_BASE_URL, nor a loopback or internal host', async () => {
		await recordSeenOrigin(db, new URL('https://old.example.com/setup'));
		const env = bareEnv({ PUBLIC_BASE_URL: 'https://env.example.com' });
		const pinned = (await setupPageLoad(getEvent('https://new.example.com/settings/setup?wizard=address', { env }))) as any;
		expect(pinned.wizard.address).toMatchObject({ source: 'env', canUse: false, canClear: false, pinned: true });
		const r1 = await (wizardActions as any).useAddress(formEvent('https://new.example.com/settings/setup?/useAddress', {}, { env }));
		expect(r1.status).toBe(409);
		const c1 = await (wizardActions as any).clearAddress(formEvent('https://new.example.com/settings/setup?/clearAddress', {}, { env }));
		expect(c1.status).toBe(409);
		expect(c1.data.error).toBe(r1.data.error);
		await setState('custom_domain', 'crm.example.com');
		clearDomainCache();
		// #732: "Clear the recorded address" isn't offered while Settings → Domain decides either.
		const byDomain = (await setupPageLoad(getEvent('https://new.example.com/settings/setup?wizard=address'))) as any;
		expect(byDomain.wizard.address).toMatchObject({ source: 'setting', canClear: false, pinned: true });
		const r2 = await (wizardActions as any).useAddress(formEvent('https://new.example.com/settings/setup?/useAddress'));
		expect(r2.status).toBe(409);
		const c2 = await (wizardActions as any).clearAddress(formEvent('https://new.example.com/settings/setup?/clearAddress'));
		expect(c2.status).toBe(409);
		expect(c2.data.error).toBe(r1.data.error);
		expect(await state(SEEN_BASE_URL_KEY)).toBe('https://old.example.com');
		await db.prepare(`DELETE FROM app_state WHERE key = 'custom_domain'`).run();
		clearDomainCache();
		const r3 = await (wizardActions as any).useAddress(formEvent('http://localhost:5173/settings/setup?/useAddress'));
		expect(r3.status).toBe(400);
		const r4 = await (wizardActions as any).useAddress(formEvent('https://scheduled.invalid/settings/setup?/useAddress'));
		expect(r4.status).toBe(400);
		expect(await state(SEEN_BASE_URL_KEY)).toBe('https://old.example.com');
	});

	it('shows a version-preview host plainly, with a hint, and refuses nothing on its shape', async () => {
		expect(looksLikeVersionPreview('a1b2c3d4-crm.sub.workers.dev')).toBe(true);
		expect(looksLikeVersionPreview('crm.sub.workers.dev')).toBe(false);
		expect(looksLikeVersionPreview('a1b2c3d4-crm.example.com')).toBe(false);
		const data = (await setupPageLoad(getEvent('https://a1b2c3d4-crm.sub.workers.dev/settings/setup?wizard=address'))) as any;
		expect(data.wizard.address).toMatchObject({ host: 'a1b2c3d4-crm.sub.workers.dev', previewHint: true, canUse: true });
	});
});

describe('#732: the sending step empties the token field after a successful Connect', () => {
	it('resets the sending form only on success; other forms keep their values', () => {
		expect(setupPageSrc).toContain('action="?/sending" use:enhance={submitSending}');
		expect(setupPageSrc).toContain("await update({ reset: result.type === 'success' });");
	});
});

describe('every wizard action is admin-only', () => {
	const names = ['address', 'useAddress', 'clearAddress', 'sending', 'webhook', 'updateWebhook', 'revealWebhook', 'switchUnsubscribe', 'test'];
	it.each(names)('%s refuses a member', async (name) => {
		expect(typeof (wizardActions as any)[name]).toBe('function');
		await expect((wizardActions as any)[name](formEvent(`https://crm.example.com/settings/setup?/${name}`, {}, { user: MEMBER, env: fullEnv() }))).rejects.toSatisfy(
			(e: unknown) => isHttpError(e) && e.status === 403
		);
		await expect((wizardActions as any)[name](formEvent(`https://crm.example.com/settings/setup?/${name}`, {}, { user: null, env: fullEnv() }))).rejects.toSatisfy(
			(e: unknown) => isHttpError(e) && e.status === 403
		);
	});
});

/** A fake Postmark API: `METHOD path` → response, and every request seen. */
function fakePostmark(routes: Record<string, { status: number; body?: unknown }>) {
	const seen: { method: string; path: string; body: any }[] = [];
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const u = new URL(String(input));
		const method = init?.method ?? 'GET';
		const path = u.pathname + u.search;
		seen.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
		const r = routes[`${method} ${path}`] ?? routes[`${method} ${u.pathname}`] ?? { status: 404, body: { Message: 'not found' } };
		return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { fn, seen };
}
const STREAM_OK = { status: 200, body: { ID: 'broadcast', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } } };
const pmCfg = { token: 'server-token-731', broadcast: 'broadcast', transactional: 'outbound', webhookKey: 'whk-731-abcdef', baseUrl: 'https://crm.example.com' }; // gitleaks:allow
const OLD_HOOK = { ID: 7, Url: 'https://old.example.com/api/webhook?key=whk-731-abcdef' }; // gitleaks:allow

describe('the Postmark webhook', () => {
	it('a new webhook gets a trigger for each event the webhook route reads', async () => {
		// The route's own RecordType map (TYPE_MAP), parsed from its source: every key it reads
		// must be in the list, and nothing else.
		const map = /const TYPE_MAP[^=]*=\s*\{([^}]*)\}/.exec(webhookRouteSrc);
		expect(map).not.toBeNull();
		const routeEvents = [...map![1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
		expect(routeEvents.length).toBeGreaterThan(0);
		expect(webhookRouteSrc).toMatch(/TYPE_MAP\[recordType\]/);
		expect([...routeEvents].sort()).toEqual([...INGESTED_WEBHOOK_EVENTS].sort());
		const pm = fakePostmark({
			'GET /message-streams/broadcast': STREAM_OK,
			'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [] } },
			'POST /webhooks': { status: 200, body: { ID: 1 } }
		});
		const res = await ensurePostmarkWebhook(pmCfg, pm.fn);
		expect(res).toMatchObject({ ok: true, state: 'created' });
		const triggers = pm.seen.find((s) => s.method === 'POST')!.body.Triggers;
		expect(Object.keys(triggers).sort()).toEqual([...INGESTED_WEBHOOK_EVENTS].sort());
		expect(Object.values(triggers).every((t: any) => t.Enabled === true)).toBe(true);
		expect(webhookTriggersFor(['Open'])).toEqual({ Open: { Enabled: true } });
	});

	it('compares the host: a webhook of this install on an old host is "elsewhere", not "already set up"', async () => {
		expect(webhookTarget(OLD_HOOK.Url, pmCfg.webhookKey, pmCfg.baseUrl)).toBe('elsewhere');
		expect(webhookMatches(OLD_HOOK.Url, pmCfg.webhookKey, pmCfg.baseUrl)).toBe(false);
		expect(webhookMatches(OLD_HOOK.Url, pmCfg.webhookKey)).toBe(true); // no address given: path + key only, as before
		expect(webhookMatches('https://CRM.example.com/api/webhook?key=whk-731-abcdef', pmCfg.webhookKey, pmCfg.baseUrl)).toBe(true); // gitleaks:allow
		const pm = fakePostmark({ 'GET /message-streams/broadcast': STREAM_OK, 'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [OLD_HOOK] } } });
		const res = await ensurePostmarkWebhook({ ...pmCfg, create: true }, pm.fn);
		expect(res).toMatchObject({ ok: true, state: 'elsewhere', present: false, created: false, elsewhere: 'old.example.com' });
		expect(pm.seen.some((s) => s.method !== 'GET')).toBe(false);
	});

	it('Update moves it here with PUT /webhooks/{id}', async () => {
		const pm = fakePostmark({
			'GET /message-streams/broadcast': STREAM_OK,
			'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [OLD_HOOK] } },
			'PUT /webhooks/7': { status: 200, body: { ID: 7 } }
		});
		const res = await ensurePostmarkWebhook({ ...pmCfg, create: false, update: true }, pm.fn);
		expect(res).toMatchObject({ ok: true, state: 'updated', present: true });
		const put = pm.seen.find((s) => s.method === 'PUT')!;
		expect(put.path).toBe('/webhooks/7');
		expect(put.body).toEqual({ Url: 'https://crm.example.com/api/webhook?key=whk-731-abcdef' }); // gitleaks:allow
		expect(pm.seen.some((s) => s.method === 'POST')).toBe(false);
	});

	it('scrubs the token and the key out of a Postmark error', async () => {
		const pm = fakePostmark({
			'GET /message-streams/broadcast': STREAM_OK,
			'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [] } },
			'POST /webhooks': { status: 422, body: { Message: 'Bad Url https://crm.example.com/api/webhook?key=whk-731-abcdef for token server-token-731' } } // gitleaks:allow
		});
		const res = await ensurePostmarkWebhook(pmCfg, pm.fn);
		expect(res.ok).toBe(false);
		const text = JSON.stringify(res);
		expect(text).not.toContain('whk-731-abcdef');
		expect(text).not.toContain('server-token-731');
		expect(text).toContain('••••');
		expect(scrubSecrets('a key%3D12 b key=12', ['key=12'])).toBe('a •••• b ••••');
		expect(scrubSecrets('short t stays', ['t'])).toBe('short t stays');
	});

	it('scrubs before it cuts to 200 characters, and catches lower-case hex and + for a space', async () => {
		const key = 'whk-731-abcdef'; // gitleaks:allow
		const across = `${'x'.repeat(192)}${key} and more`; // the key straddles the 200-char cut
		const msg = pmMessage({ Message: across }, [key]);
		expect(msg.length).toBeLessThanOrEqual(200);
		expect(msg).not.toContain('whk-7');
		expect(msg).toContain('••••');
		const odd = 'tok/en+731 secret';
		for (const form of ['tok%2Fen%2B731%20secret', 'tok%2fen%2b731%20secret', 'tok%2Fen%2B731+secret', 'tok%2fen%2b731+secret']) { // gitleaks:allow
			expect(scrubSecrets(`url ?t=${form} end`, [odd])).toBe('url ?t=•••• end');
		}
		const pm = fakePostmark({
			'GET /message-streams/broadcast': STREAM_OK,
			'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [] } },
			'POST /webhooks': { status: 422, body: { Message: across } }
		});
		const res = await ensurePostmarkWebhook({ ...pmCfg, webhookKey: key }, pm.fn);
		expect(JSON.stringify(res)).not.toContain('whk-7');
	});
});

describe('"Finish setup" is an inline form error', () => {
	const para = (text: string) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text }] });
	const body = JSON.stringify([para('A real update with plenty of words. '.repeat(8))]);
	const base = { subject: 'Hello', from: FROM, preheader: 'p', body_blocks: body, send_anyway: '1' };
	const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'))!;

	async function audience() {
		const list = await newId("INSERT INTO lists (name, kind) VALUES ('Customers 731', 'list') RETURNING id");
		const cid = await newId("INSERT INTO contacts (email, subscribed) VALUES ('ann@example.net', 1) RETURNING id");
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, cid).run();
		return list;
	}

	it('compose send and schedule refuse before any campaign row or recipient', async () => {
		const list = await audience();
		const draft = await newId(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Draft', 'm', 'h', ?, 'draft') RETURNING id`, FROM);
		const send = await runAction(composeActions.send!, formEvent('https://crm.example.com/compose?/send', { ...base, include_id: String(list), draft_id: String(draft) }));
		expect(send.redirect).toBeUndefined();
		expect(send.result.status).toBe(409);
		expect(send.result.data.error).toBe(FINISH_SETUP_SENDING);
		expect(send.result.data.values).toMatchObject({ subject: 'Hello', from: FROM, preheader: 'p', include_ids: [list] });
		expect(send.result.data.values.body_blocks).toContain('A real update with plenty of words.');
		const later = new Date(Date.now() + 3 * 3600_000).toISOString();
		const sched = await runAction(composeActions.send!, formEvent('https://crm.example.com/compose?/send', { ...base, include_id: String(list), schedule_at: later }));
		expect(sched.result.status).toBe(409);
		expect(sched.result.data.error).toBe(FINISH_SETUP_SENDING);
		expect(sched.result.data.values).toMatchObject({ subject: 'Hello', from: FROM, preheader: 'p', include_ids: [list] });
		expect(await count('campaigns')).toBe(1);
		expect((await one<{ status: string }>('SELECT status FROM campaigns WHERE id = ?', draft)).status).toBe('draft');
		expect(await count('recipients')).toBe(0);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('compose direct and test refuse inline', async () => {
		const direct = await runAction(composeActions.direct!, formEvent('https://crm.example.com/compose?/direct', { ...base, direct_to: 'ann@example.net' }));
		expect(direct.result.status).toBe(409);
		expect(direct.result.data).toMatchObject({ error: FINISH_SETUP_SENDING, mode: 'direct', values: { subject: 'Hello', from: FROM, preheader: 'p', direct_to: 'ann@example.net' } });
		expect(direct.result.data.values.body_blocks).toContain('A real update with plenty of words.');
		const test = await runAction(composeActions.test!, formEvent('https://crm.example.com/compose?/test', { ...base, test_to: 'me@example.net' }));
		expect(test.result.status).toBe(409);
		expect(test.result.data.testError).toBe(FINISH_SETUP_SENDING);
		expect(await count('campaigns')).toBe(0);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('the campaign resend to non-openers refuses inline and writes nothing', async () => {
		const camp = await newId(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status, sent_at) VALUES ('Hello', 'm', '<p>Hi</p>', 'Hi', ?, 'sent', '2026-01-01 10:00:00') RETURNING id`,
			FROM
		);
		const ann = await newId("INSERT INTO contacts (email, subscribed) VALUES ('ann@example.net', 1) RETURNING id");
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@example.net', 'pm-r1', 'accepted')").bind(camp, ann).run();
		const e = formEvent(`https://crm.example.com/campaign/${camp}?/resend`, { subject: 'Did you see this?', resend_when: 'now' });
		e.params = { id: String(camp) };
		const res = await runAction(campaignActions.resend!, e);
		expect(res.redirect).toBeUndefined();
		expect(res.result.status).toBe(409);
		expect(res.result.data.error).toBe(FINISH_SETUP_SENDING);
		expect(await one('SELECT resend_status, resend_subject, resent_at FROM campaigns WHERE id = ?', camp)).toEqual({ resend_status: null, resend_subject: null, resent_at: null });
		expect(await count('recipients')).toBe(1);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('the automation step drawer test send refuses inline and writes nothing', async () => {
		await setState('default_from', FROM); // the test goes to the Default From when the user has no email
		const aid = await newId("INSERT INTO automations (name, status, reentry) VALUES ('Drawer 731', 'draft', 'once') RETURNING id");
		const step = await newId(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type) VALUES (?, 0, 0, 'Hello', 'Body', ?, 'email') RETURNING id`,
			aid,
			FROM
		);
		const e = formEvent(`https://crm.example.com/automations/${aid}?/testStep`, { step_id: String(step), subject: 'Hello', from_email: FROM, preheader: 'p', body_blocks: body });
		e.params = { id: String(aid) };
		const res = await runAction(automationActions.testStep!, e);
		expect(res.result.status).toBe(409);
		expect(res.result.data).toEqual({ testError: FINISH_SETUP_SENDING, testStepId: step });
		expect(await count('campaigns')).toBe(0);
		expect(await count('recipients')).toBe(0);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('the conversation reply (also the contact page composer) refuses inline', async () => {
		await setState('default_from', FROM);
		const ann = await newId("INSERT INTO contacts (email, first_name) VALUES ('ann@example.net', 'Ann') RETURNING id");
		const camp = await newId(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('Hello', 'm', 'h', ?, 'sent', '2026-01-01 10:00:00') RETURNING id`, FROM);
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@example.net', 'pm-1', 'accepted')").bind(camp, ann).run();
		await db
			.prepare(`INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at) VALUES (?, ?, 'ann@example.net', 'Re: Hello', 'thanks!', '2026-01-02 10:00:00')`)
			.bind(ann, camp)
			.run();
		const [thread] = await conversationsFor(db, ann);
		const res = await (convActions.reply as any)(
			formEvent('https://crm.example.com/conversations?/reply', { conv_key: thread.key, contact_id: String(ann), email: 'ann@example.net', body: 'Sure.' }, { user: MEMBER })
		);
		expect(res.status).toBe(409);
		expect(res.data).toEqual({ replyKey: thread.key, replyError: FINISH_SETUP_SENDING });
		expect(await count('campaigns')).toBe(1);
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});
});

describe('reply forwarding reads the same sender stand-in', () => {
	it('POSTMARK_FROM when set (unchanged), else the Default From', () => {
		const env = { POSTMARK_FROM: 'alan@ourco.example', REVIEW_FROM: 'review@ourco.example' };
		expect(withSenderStandIn(env, 'news@other.example')).toBe(env);
		expect(forwardSenderAddress(withSenderStandIn(env, 'news@other.example'))).toBe('review@ourco.example');
		const empty: Record<string, string> = {};
		expect(withSenderStandIn(empty, FROM).POSTMARK_FROM).toBe(FROM);
		expect(forwardSenderAddress(withSenderStandIn(empty, FROM))).toBe(FROM);
		expect(forwardSenderAddress(withSenderStandIn(empty, ''))).toBe('');
	});

	it('a From-style value (Brand <a@x>) counts as its bare address', () => {
		const branded = 'Our Co <Alan@OurCo.example>';
		expect(emailDomain(branded)).toBe('ourco.example');
		expect(sendingDomain({ POSTMARK_FROM: branded })).toBe('ourco.example');
		expect(forwardSenderAddress({ POSTMARK_FROM: branded })).toBe('Alan@OurCo.example');
		expect(forwardFallbackAddress({ POSTMARK_FROM: branded })).toBe('Alan@OurCo.example');
		expect(forwardSenderAddress({ INBOUND_FORWARD_FROM: '"CRM" <crm@ourco.example>', POSTMARK_FROM: 'alan@ourco.example' })).toBe('crm@ourco.example');
		expect(forwardSenderAddress(withSenderStandIn({}, `News <${FROM}>`))).toBe(FROM);
	});

	async function inboundFrom(from: string, env: Record<string, unknown>) {
		const res = await inboundPOST({
			url: new URL('https://crm.example.com/api/inbound?key=ik-731'),
			request: new Request('https://crm.example.com/api/inbound', { method: 'POST', body: JSON.stringify({ FromFull: { Email: from }, Subject: 'Re: x', TextBody: 'loop' }) }),
			platform: { env: { DB: db, INBOUND_KEY: 'ik-731', ...env } }
		} as any);
		return await res.json();
	}

	it('the inbound self-loop guard matches a branded POSTMARK_FROM and a branded Default From', async () => {
		expect(await inboundFrom('alan@ourco.example', { POSTMARK_FROM: 'Our Co <Alan@OurCo.example>' })).toEqual({ ignored: 'self' });
		await setState('default_from', `News <${FROM}>`);
		expect(await inboundFrom(FROM, {})).toEqual({ ignored: 'self' });
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM replies`).first<number>('n'))).toBe(0);
	});

	it('the inbound self-loop guard uses the Default From when POSTMARK_FROM is empty', async () => {
		await setState('default_from', FROM);
		const res = await inboundPOST({
			url: new URL('https://crm.example.com/api/inbound?key=ik-731'),
			request: new Request('https://crm.example.com/api/inbound', { method: 'POST', body: JSON.stringify({ FromFull: { Email: FROM }, Subject: 'Re: x', TextBody: 'loop' }) }),
			platform: { env: { DB: db, INBOUND_KEY: 'ik-731' } }
		} as any);
		expect(await res.json()).toEqual({ ignored: 'self' });
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM replies`).first<number>('n'))).toBe(0);
	});
});

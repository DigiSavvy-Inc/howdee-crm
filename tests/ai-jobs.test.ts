// #303: scheduled assistant jobs — next-run maths, the tick runner (≤ 2 per tick, no double
// run), the read-only registry, webhook payloads + signature, the SSRF guard, spend caps,
// and Settings → Assistant → Jobs (Run now, Send test payload, admin-only).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { nextRunAt } from '../src/lib/server/ai/jobs-schedule';
import {
	SIGNATURE_HEADER,
	buildPayload,
	deliverWebhook,
	signatureHeader,
	stripMarkdown,
	toSlackMrkdwn,
	webhookUrlProblem
} from '../src/lib/server/ai/jobs-webhook';
import { JOB_TOOLS, JOBS_PER_TICK, getJob, runDueJobs, runJob, saveJob, validateJobInput } from '../src/lib/server/ai/jobs';
import { saveAssistantConfig, spentMicros, utcDayStart } from '../src/lib/server/ai/config';
import { TOOLS } from '../src/lib/server/ai/tools';
import type { AiProvider, ProviderEvent } from '../src/lib/server/ai/provider';
import type { JobSchedule } from '../src/lib/ai-jobs';
import { load, actions } from '../src/routes/settings/assistant/jobs/+page.server';

const db = (env as any).DB as D1Database;
const LA = 'America/Los_Angeles';
const ENV = { ANTHROPIC_API_KEY: 'sk-ant-api03-jobs-test-key-0000' };
const HOOK = 'https://hooks.example.com/abc';

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const MAIL_KEY = newKey();

let admin: any;
let member: any;

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}
async function makeUser(login: string, role: 'admin' | 'member') {
	const r = await db.prepare('INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id').bind(login, role).first<{ id: number }>();
	return sessionUser({ id: r!.id, github_login: login, role });
}

beforeAll(async () => {
	admin = await makeUser(`jobs-admin-${Date.now()}`, 'admin');
	member = await makeUser(`jobs-member-${Date.now()}`, 'member');
});

beforeEach(async () => {
	await db.prepare('DELETE FROM ai_job_runs').run();
	await db.prepare('DELETE FROM ai_jobs').run();
	await saveAssistantConfig(db, { access: 'everyone' });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString().replace('.000Z', 'Z') ?? null;
const sched = (o: Partial<JobSchedule>): JobSchedule => ({ kind: 'daily', time: '08:00', dow: null, dom: null, timezone: LA, ...o });

// ---- next_run_at ----

describe('nextRunAt (#303)', () => {
	it('daily: 08:00 Los Angeles moves from 16:00 to 15:00 UTC across spring-forward', () => {
		expect(iso(nextRunAt(sched({}), at('2026-03-07T00:00:00Z')))).toBe('2026-03-07T16:00:00Z'); // PST
		expect(iso(nextRunAt(sched({}), at('2026-03-07T16:00:00Z')))).toBe('2026-03-08T15:00:00Z'); // strictly after; PDT
	});

	it('daily: back to 16:00 UTC across fall-back', () => {
		expect(iso(nextRunAt(sched({}), at('2026-10-31T16:00:00Z')))).toBe('2026-11-01T16:00:00Z');
	});

	it('weekly: the next Monday, in PDT then PST', () => {
		const mon = sched({ kind: 'weekly', dow: 1 });
		expect(iso(nextRunAt(mon, at('2026-10-17T12:00:00Z')))).toBe('2026-10-19T15:00:00Z');
		expect(iso(nextRunAt(mon, at('2026-10-30T12:00:00Z')))).toBe('2026-11-02T16:00:00Z');
		// Monday after 08:00 local → the following Monday.
		expect(iso(nextRunAt(mon, at('2026-10-19T15:30:00Z')))).toBe('2026-10-26T15:00:00Z');
	});

	it('monthly: day 31 runs on the last day of a short month; DST shifts the UTC hour', () => {
		expect(iso(nextRunAt(sched({ kind: 'monthly', dom: 31 }), at('2026-02-01T00:00:00Z')))).toBe('2026-02-28T16:00:00Z');
		expect(iso(nextRunAt(sched({ kind: 'monthly', dom: 15 }), at('2026-03-01T00:00:00Z')))).toBe('2026-03-15T15:00:00Z');
		expect(iso(nextRunAt(sched({ kind: 'monthly', dom: 15 }), at('2026-03-15T15:00:00Z')))).toBe('2026-04-15T15:00:00Z');
	});

	it('hourly: the next :MM, strictly after, also over the repeated fall-back hour and a half-hour zone', () => {
		const q = sched({ kind: 'hourly', time: '00:15' });
		expect(iso(nextRunAt(q, at('2026-10-17T10:20:00Z')))).toBe('2026-10-17T11:15:00Z');
		expect(iso(nextRunAt(q, at('2026-10-17T11:15:00Z')))).toBe('2026-10-17T12:15:00Z');
		expect(iso(nextRunAt(q, at('2026-11-01T08:20:00Z')))).toBe('2026-11-01T09:15:00Z'); // 01:15 PST, the repeat
		expect(iso(nextRunAt(sched({ kind: 'hourly', time: '00:00', timezone: 'Asia/Kolkata' }), at('2026-10-17T10:00:00Z')))).toBe('2026-10-17T10:30:00Z');
	});

	it('an unusable schedule has no next run', () => {
		expect(nextRunAt(sched({ time: '25:00' }), new Date())).toBeNull();
		expect(nextRunAt(sched({ timezone: 'Not/AZone' }), new Date())).toBeNull();
	});
});

// ---- SSRF guard ----

describe('webhookUrlProblem (#303)', () => {
	it('allows public https URLs', () => {
		expect(webhookUrlProblem('https://hooks.slack.com/services/T0/B0/x')).toBeNull();
		expect(webhookUrlProblem('https://8.8.8.8/hook')).toBeNull();
	});

	it.each([
		['http://hooks.example.com/x', /https/],
		['ftp://example.com/x', /https/],
		['https://localhost/x', /local/],
		['https://api.localhost/x', /local/],
		['https://printer.local/x', /local/],
		['https://127.0.0.1/x', /private/],
		['https://2130706433/x', /private/], // decimal 127.0.0.1
		['https://10.1.2.3/x', /private/],
		['https://172.16.0.9/x', /private/],
		['https://192.168.1.1/x', /private/],
		['https://169.254.169.254/latest/meta-data', /private/],
		['https://0.0.0.0/x', /private/],
		['https://[::1]/x', /private/],
		['https://[fe80::1]/x', /private/],
		['https://[fd00::1]/x', /private/],
		['https://[::ffff:127.0.0.1]/x', /private/],
		['https://user:pw@example.com/x', /username/],
		['not a url', /valid/]
	])('refuses %s', (url, why) => {
		expect(webhookUrlProblem(url)).toMatch(why);
	});

	it('is checked again at send time (no fetch for a refused URL)', async () => {
		const f = vi.fn();
		const d = await deliverWebhook('http://hooks.example.com/x', '{}', { fetch: f as any });
		expect(d.status).toBeNull();
		expect(d.error).toMatch(/https/);
		expect(f).not.toHaveBeenCalled();
	});
});

// ---- payloads + signature ----

const MD = '## Weekly recap\n\nSent **3** campaigns, *nice*.\n\n- See [the dashboard](https://app.test/)\n* Second\n\n| Campaign | Opens |\n| --- | --- |\n| Fall | 41% |\n\nDone & dusted <ok>.';

describe('payloads (#303)', () => {
	it('json: job, run, model, markdown + stripped text, cost and app url', () => {
		const body = JSON.parse(
			buildPayload('json', {
				job: { id: 7, name: 'Recap' },
				run: { id: 3, started_at: '2026-10-19 15:00:00', finished_at: '2026-10-19 15:00:30', status: 'ok' },
				model: 'claude-sonnet-5-5',
				output_markdown: MD,
				cost_micros: 12_345,
				app_url: 'https://app.test/settings/assistant/jobs?job=7'
			})
		);
		expect(body).toMatchObject({
			job: { id: 7, name: 'Recap' },
			run: { id: 3, status: 'ok', started_at: '2026-10-19 15:00:00', finished_at: '2026-10-19 15:00:30' },
			model: 'claude-sonnet-5-5',
			output_markdown: MD,
			cost_usd: 0.012345,
			app_url: 'https://app.test/settings/assistant/jobs?job=7'
		});
		expect(body.output_text).not.toMatch(/\*\*|##|\]\(/);
		expect(body.output_text).toContain('Weekly recap');
		expect(body.output_text).toContain('Sent 3 campaigns, nice.');
		expect(body.output_text).toContain('- See the dashboard (https://app.test/)');
		expect(body.output_text).not.toMatch(/---/);
	});

	it('slack: { text } in mrkdwn — bold, bullets, links, a table as a code block, escaped', () => {
		const out = toSlackMrkdwn(MD);
		expect(out).toContain('*Weekly recap*');
		expect(out).toContain('Sent *3* campaigns, _nice_.');
		expect(out).toContain('• See <https://app.test/|the dashboard>');
		expect(out).toContain('• Second');
		expect(out).toContain('```\n| Campaign | Opens |\n| --- | --- |\n| Fall | 41% |\n```');
		expect(out).toContain('Done &amp; dusted &lt;ok&gt;.');
		const body = JSON.parse(
			buildPayload('slack', {
				job: { id: 7, name: 'Recap' },
				run: { id: 3, started_at: '', finished_at: '', status: 'ok' },
				model: 'm',
				output_markdown: MD,
				cost_micros: 0,
				app_url: 'https://app.test/j'
			})
		);
		expect(Object.keys(body)).toEqual(['text']);
		expect(body.text.startsWith('*Recap*\n')).toBe(true);
		expect(body.text).toContain('<https://app.test/j|Open in the app>');
	});

	it('stripMarkdown leaves plain text alone', () => {
		expect(stripMarkdown('Nothing to see')).toBe('Nothing to see');
	});

	it('signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">', async () => {
		const header = await signatureHeader('s3cret', '{"a":1}', 1_790_000_000);
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('1790000000.{"a":1}')));
		expect(header).toBe(`t=1790000000,v1=${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
	});

	it('delivery signs when a secret is set, retries once on 5xx, not on 4xx', async () => {
		const calls: RequestInit[] = [];
		const f = vi.fn(async (_u: string, init: RequestInit) => {
			calls.push(init);
			return new Response('', { status: calls.length === 1 ? 502 : 200 });
		});
		const now = new Date('2026-10-19T15:00:00Z');
		const d = await deliverWebhook(HOOK, '{"x":1}', { secret: 'k3y', fetch: f as any, now });
		expect(d).toEqual({ status: 200, error: null });
		expect(f).toHaveBeenCalledTimes(2);
		const h = calls[0].headers as Record<string, string>;
		expect(h[SIGNATURE_HEADER]).toBe(await signatureHeader('k3y', '{"x":1}', Math.floor(now.getTime() / 1000)));
		expect(calls[0].redirect).toBe('manual');

		const g = vi.fn(async () => new Response('', { status: 404 }));
		expect((await deliverWebhook(HOOK, '{}', { fetch: g as any })).status).toBe(404);
		expect(g).toHaveBeenCalledTimes(1);

		const n = vi.fn(async () => {
			throw new TypeError('network');
		});
		expect(await deliverWebhook(HOOK, '{}', { fetch: n as any })).toEqual({ status: null, error: "Couldn't reach the webhook." });
		expect(n).toHaveBeenCalledTimes(2);
		// No secret → no signature header.
		const u = vi.fn(async (_u: string, _i: RequestInit) => new Response('', { status: 204 }));
		await deliverWebhook(HOOK, '{}', { fetch: u as any });
		expect((u.mock.calls[0][1].headers as Record<string, string>)[SIGNATURE_HEADER]).toBeUndefined();
	});
});

// ---- read-only registry ----

describe('JOB_TOOLS (#303)', () => {
	it('holds read-tier tools only — no write or approve tools', () => {
		expect(JOB_TOOLS.length).toBeGreaterThan(0);
		expect(JOB_TOOLS.every((t) => t.tier === 'read')).toBe(true);
		expect(JOB_TOOLS.map((t) => t.name)).toEqual(TOOLS.filter((t) => t.tier === 'read').map((t) => t.name));
		// Anchored to a leading verb: read tools like list_automation_enrollments contain
		// "enroll" mid-name, so an unanchored match is a false positive. tier === 'read' above is the real guarantee.
		expect(
			JOB_TOOLS.some((t) =>
				/^(send|schedule|enroll|delete|update|create|activate|add|remove|move|tag|untag|unsubscribe|resubscribe|archive|restore|edit|rewrite|reorder)_/i.test(t.name)
			)
		).toBe(false);
	});

	it('#322: none of the contact-management tools reach a job', () => {
		const manage = ['create_contact', 'update_contact', 'unsubscribe_contacts', 'resubscribe_contacts', 'archive_contacts', 'restore_contacts', 'delete_contacts', 'update_contact_tier'];
		for (const name of manage) expect(TOOLS.some((t) => t.name === name)).toBe(true); // they exist…
		expect(JOB_TOOLS.filter((t) => manage.includes(t.name))).toEqual([]); // …but never in a job
	});
});

// ---- runner + tick ----

const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };
function reportProvider(text = '## Report\n\n- All good') {
	const calls: { tools: string[]; system: string }[] = [];
	const p: AiProvider = {
		async *stream(req) {
			calls.push({ tools: req.tools.map((t) => t.name), system: req.system });
			const ev: ProviderEvent[] = [
				{ type: 'text', text },
				{ type: 'done', content: [{ type: 'text', text }], stopReason: 'end_turn', usage }
			];
			yield* ev;
		}
	};
	return { p, calls };
}

function hookFetch() {
	const bodies: string[] = [];
	const f = vi.fn(async (_u: string, init: RequestInit) => {
		bodies.push(String(init.body));
		return new Response('ok', { status: 200 });
	});
	return { f: f as unknown as typeof fetch & ReturnType<typeof vi.fn>, bodies, mock: f };
}

async function makeJob(over: Record<string, string> = {}, now = new Date('2026-10-19T00:00:00Z')) {
	const v = validateJobInput(
		{
			name: 'Recap',
			prompt: 'Summarise last week.',
			model: 'claude-sonnet-5-5',
			effort: 'low',
			schedule_kind: 'daily',
			schedule_time: '08:00',
			timezone: LA,
			webhook_url: HOOK,
			payload_format: 'json',
			enabled: '1',
			...over
		},
		{ allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'] }
	);
	if (!v.ok) throw new Error(v.error);
	const r = await saveJob(db, { MAIL_TOKEN_KEY: MAIL_KEY }, null, v.value, admin.id, now);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

async function setDue(id: number, when: string) {
	await db.prepare('UPDATE ai_jobs SET next_run_at = ? WHERE id = ?').bind(when, id).run();
}

describe('runDueJobs (#303)', () => {
	it('runs due jobs only, at most 2 per tick, oldest first, and moves next_run_at on', async () => {
		const a = await makeJob({ name: 'A' });
		const b = await makeJob({ name: 'B' });
		const c = await makeJob({ name: 'C' });
		const future = await makeJob({ name: 'Future' });
		const off = await makeJob({ name: 'Off', enabled: '' });
		await setDue(a, '2026-10-19 14:00:00');
		await setDue(b, '2026-10-19 14:30:00');
		await setDue(c, '2026-10-19 14:45:00');
		await setDue(future, '2026-10-20 15:00:00');
		await setDue(off, '2026-10-19 13:00:00'); // disabled: never picked
		const { p, calls } = reportProvider();
		const hook = hookFetch();
		const now = new Date('2026-10-19T15:00:00Z');

		const first = await runDueJobs(db, ENV, { now, provider: p, fetch: hook.f });
		expect(JOBS_PER_TICK).toBe(2);
		expect(first).toMatchObject({ due: 2, ran: 2, ok: 2 });
		expect(calls).toHaveLength(2);
		expect(hook.mock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(hook.bodies[0]).job.name).toBe('A');
		expect((await getJob(db, a))!.next_run_at).toBe('2026-10-20 15:00:00');
		expect((await getJob(db, a))!.last_run_at).toBe('2026-10-19 15:00:00');

		const second = await runDueJobs(db, ENV, { now, provider: p, fetch: hook.f });
		expect(second).toMatchObject({ due: 1, ran: 1 });
		expect(JSON.parse(hook.bodies[2]).job.name).toBe('C');
		expect(await runDueJobs(db, ENV, { now, provider: p, fetch: hook.f })).toMatchObject({ due: 0, ran: 0 });

		const runs = await db.prepare('SELECT job_id, status, trigger, cost_micros, webhook_status FROM ai_job_runs ORDER BY id').all<any>();
		expect(runs.results.map((r) => r.job_id)).toEqual([a, b, c]);
		expect(runs.results.every((r) => r.status === 'ok' && r.trigger === 'schedule' && r.webhook_status === 200 && r.cost_micros > 0)).toBe(true);
		// Read-only tools + the unattended preamble reached the model.
		expect(calls[0].tools).toEqual(JOB_TOOLS.map((t) => t.name));
		expect(calls[0].system).toMatch(/running unattended/);
	});

	it('#731: with sending off an email job is left untouched and still due; a webhook-only job runs', async () => {
		const mail = await makeJob({ name: 'Mailed' });
		const hookOnly = await makeJob({ name: 'Hook only' });
		await db.prepare('UPDATE ai_jobs SET email_admins = ? WHERE id = ?').bind(JSON.stringify([admin.id]), mail).run();
		await setDue(mail, '2026-10-19 14:00:00');
		await setDue(hookOnly, '2026-10-19 14:30:00');
		const before = await getJob(db, mail);
		const { p, calls } = reportProvider();
		const hook = hookFetch();
		const emailSender = vi.fn(async () => ({ status: 'sent' as const, sent: 1, error: null }));
		const now = new Date('2026-10-19T15:00:00Z');

		const res = await runDueJobs(db, ENV, { now, provider: p, fetch: hook.f, emailSender: emailSender as any, emailOff: true });
		expect(res).toMatchObject({ due: 1, ran: 1, ok: 1 });
		expect(calls).toHaveLength(1);
		expect(JSON.parse(hook.bodies[0]).job.name).toBe('Hook only');
		expect(emailSender).not.toHaveBeenCalled();
		const after = await getJob(db, mail);
		expect(after!.next_run_at).toBe('2026-10-19 14:00:00');
		expect(after!.last_run_at).toBe(before!.last_run_at);
		const runs = await db.prepare('SELECT job_id FROM ai_job_runs').all<{ job_id: number }>();
		expect(runs.results.map((r) => r.job_id)).toEqual([hookOnly]);

		// Once sending is configured again the email job runs.
		const later = await runDueJobs(db, ENV, { now, provider: p, fetch: hook.f, emailSender: emailSender as any });
		expect(later).toMatchObject({ due: 1, ran: 1 });
		expect(emailSender).toHaveBeenCalledTimes(1);
	});

	it('two overlapping ticks run a due job once', async () => {
		const a = await makeJob({ name: 'Once' });
		await setDue(a, '2026-10-19 14:00:00');
		const { p, calls } = reportProvider();
		const hook = hookFetch();
		const now = new Date('2026-10-19T15:00:00Z');
		const [x, y] = await Promise.all([
			runDueJobs(db, ENV, { now, provider: p, fetch: hook.f }),
			runDueJobs(db, ENV, { now, provider: p, fetch: hook.f })
		]);
		expect(x.ran + y.ran).toBe(1);
		expect(calls).toHaveLength(1);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM ai_job_runs').first<{ n: number }>())!.n).toBe(1);
	});

	it('at a spend cap the run is skipped: no model call, no webhook', async () => {
		const a = await makeJob();
		await setDue(a, '2026-10-19 14:00:00');
		await saveAssistantConfig(db, { access: 'everyone', dailyUserCapUsd: 1 });
		const now = new Date('2026-10-19T15:00:00Z');
		await db
			.prepare(`INSERT INTO ai_job_runs (job_id, user_id, status, started_at, cost_micros) VALUES (?, ?, 'ok', ?, 2000000)`)
			.bind(a, admin.id, '2026-10-19 01:00:00')
			.run();
		const { p, calls } = reportProvider();
		const hook = hookFetch();
		const r = await runDueJobs(db, ENV, { now, provider: p, fetch: hook.f });
		expect(r).toMatchObject({ ran: 1, skipped: 1 });
		expect(calls).toHaveLength(0);
		expect(hook.mock).not.toHaveBeenCalled();
		const run = await db.prepare(`SELECT status, error FROM ai_job_runs WHERE id = (SELECT MAX(id) FROM ai_job_runs)`).first<any>();
		expect(run.status).toBe('skipped');
		expect(run.error).toMatch(/spend cap/i);
	});

	it('job runs count toward the spend caps', async () => {
		const a = await makeJob();
		const { p } = reportProvider();
		const hook = hookFetch();
		const now = new Date();
		const before = await spentMicros(db, utcDayStart(now), admin.id);
		const r = await runJob(db, ENV, (await getJob(db, a))!, { trigger: 'manual', provider: p, fetch: hook.f, now });
		expect(r.costMicros).toBeGreaterThan(0);
		expect(await spentMicros(db, utcDayStart(now), admin.id)).toBe(before + r.costMicros);
		expect(await spentMicros(db, utcDayStart(now))).toBeGreaterThanOrEqual(before + r.costMicros);
	});

	it('assistant off → skipped without a model call', async () => {
		const a = await makeJob();
		await saveAssistantConfig(db, { access: 'off' });
		const { p, calls } = reportProvider();
		const r = await runJob(db, ENV, (await getJob(db, a))!, { trigger: 'manual', provider: p, fetch: hookFetch().f });
		expect(r.status).toBe('skipped');
		expect(calls).toHaveLength(0);
	});

	it('the webhook URL is re-checked at send time', async () => {
		const a = await makeJob();
		await db.prepare(`UPDATE ai_jobs SET webhook_url = 'https://127.0.0.1/x' WHERE id = ?`).bind(a).run();
		const { p } = reportProvider();
		const hook = hookFetch();
		const r = await runJob(db, ENV, (await getJob(db, a))!, { trigger: 'manual', provider: p, fetch: hook.f });
		expect(r.status).toBe('ok');
		expect(r.webhookStatus).toBeNull();
		expect(r.error).toMatch(/private/);
		expect(hook.mock).not.toHaveBeenCalled();
	});
});

// ---- Settings → Assistant → Jobs ----

function pageEvent(action: string | null, opts: { user: any; form?: Record<string, string>; query?: string }) {
	const url = new URL(`https://app.test/settings/assistant/jobs${opts.query ?? ''}${action ? `?/${action}` : ''}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(opts.form ?? {})) fd.append(k, v);
	return {
		url,
		params: {},
		request: new Request(url, action ? { method: 'POST', body: fd } : undefined),
		locals: { user: opts.user, authed: !!opts.user },
		platform: { env: { ...(env as any), ...ENV, MAIL_TOKEN_KEY: MAIL_KEY } }
	} as any;
}

const ANSWER_SSE = [
	{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Hot leads\n\n- None today.' } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
	{ type: 'message_stop' }
]
	.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	.join('');

const FORM = {
	name: 'Hot leads',
	prompt: 'List new hot leads.',
	model: 'claude-sonnet-5-5',
	effort: 'medium',
	schedule_kind: 'weekly',
	schedule_dow: '1',
	schedule_time: '08:00',
	timezone: LA,
	webhook_url: HOOK,
	payload_format: 'slack',
	enabled: '1'
};

async function expectRedirect(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e: any) {
		if (e?.status === 303) return e.location;
		throw e;
	}
	throw new Error('expected a redirect');
}

describe('Settings → Assistant → Jobs (#303)', () => {
	it('is admin-only: load and every action', async () => {
		await expect(load(pageEvent(null, { user: member }))).rejects.toMatchObject({ status: 403 });
		for (const name of ['save', 'toggle', 'delete', 'runNow', 'sendTest'] as const) {
			const r: any = await (actions as any)[name](pageEvent(name, { user: member, form: { ...FORM, id: '1' } }));
			expect(r?.status).toBe(403);
		}
		expect(await db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').first<{ n: number }>()).toEqual({ n: 0 });
	});

	it('save validates the URL and stores the secret sealed (last4 only on the page)', async () => {
		const bad: any = await actions.save(pageEvent('save', { user: admin, form: { ...FORM, webhook_url: 'http://hooks.example.com/x' } }));
		expect(bad.status).toBe(400);
		expect(bad.data.error).toMatch(/https/);
		const local: any = await actions.save(pageEvent('save', { user: admin, form: { ...FORM, webhook_url: 'https://localhost/x' } }));
		expect(local.status).toBe(400);

		const loc = await expectRedirect(actions.save(pageEvent('save', { user: admin, form: { ...FORM, webhook_secret: 'whsec-abcd1234' } })) as Promise<unknown>); // gitleaks:allow
		const id = Number(new URL(loc, 'https://app.test').searchParams.get('job'));
		const row = (await getJob(db, id))!;
		expect(row.webhook_secret).toMatch(/^v1\./);
		expect(row.webhook_secret).not.toContain('abcd1234');
		expect(row.webhook_secret_last4).toBe('1234');
		expect(row.next_run_at).not.toBeNull();
		expect(row.created_by).toBe(admin.id);

		const page: any = await load(pageEvent(null, { user: admin, query: `?job=${id}` }));
		expect(page.job).toMatchObject({ id, has_secret: true, webhook_secret_last4: '1234' });
		expect(JSON.stringify(page)).not.toContain('abcd1234');
		expect(JSON.stringify(page)).not.toContain(row.webhook_secret!);
	});

	it('Run now runs synchronously (mocked Anthropic + webhook) and shows the output', async () => {
		const id = await makeJob({ payload_format: 'slack' });
		const urls: string[] = [];
		const bodies: string[] = [];
		vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
			urls.push(String(u));
			if (String(u).startsWith('https://api.anthropic.com/')) {
				const enc = new TextEncoder();
				return new Response(new ReadableStream({ start: (c) => (c.enqueue(enc.encode(ANSWER_SSE)), c.close()) }), {
					headers: { 'content-type': 'text/event-stream' }
				});
			}
			bodies.push(String(init.body));
			return new Response('ok', { status: 200 });
		});
		const r: any = await actions.runNow(pageEvent('runNow', { user: admin, form: { id: String(id) } }));
		expect(r.runResult).toMatchObject({ status: 'ok', webhookStatus: 200, error: null });
		expect(r.runResult.output).toBe('## Hot leads\n\n- None today.');
		expect(urls).toEqual(['https://api.anthropic.com/v1/messages', HOOK]);
		expect(JSON.parse(bodies[0]).text).toContain('• None today.');
		const run = await db.prepare('SELECT trigger, status FROM ai_job_runs WHERE job_id = ?').bind(id).first<any>();
		expect(run).toEqual({ trigger: 'manual', status: 'ok' });
		// Run now leaves the schedule alone.
		expect((await getJob(db, id))!.last_run_at).toBeNull();
	});

	it('Send test payload posts the fixed sample and shows the HTTP status', async () => {
		const id = await makeJob();
		const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
		vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
			calls.push({ url: String(u), body: String(init.body), headers: init.headers as Record<string, string> });
			return new Response('', { status: 202 });
		});
		const r: any = await actions.sendTest(pageEvent('sendTest', { user: admin, form: { id: String(id) } }));
		expect(r.testResult).toEqual({ status: 202, error: null });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(HOOK);
		expect(JSON.parse(calls[0].body)).toMatchObject({ job: { id, name: 'Recap' }, run: { status: 'test' } });
		expect(calls[0].headers[SIGNATURE_HEADER]).toBeUndefined();
	});

	it('toggle turns a job off (no next run) and on again; delete removes it', async () => {
		const id = await makeJob();
		await actions.toggle(pageEvent('toggle', { user: admin, form: { id: String(id), enabled: '0' } }));
		expect(await getJob(db, id)).toMatchObject({ enabled: 0, next_run_at: null });
		await actions.toggle(pageEvent('toggle', { user: admin, form: { id: String(id), enabled: '1' } }));
		const on = (await getJob(db, id))!;
		expect(on.enabled).toBe(1);
		expect(on.next_run_at).not.toBeNull();
		await expectRedirect(actions.delete(pageEvent('delete', { user: admin, form: { id: String(id) } })) as Promise<unknown>);
		expect(await getJob(db, id)).toBeNull();
	});
});

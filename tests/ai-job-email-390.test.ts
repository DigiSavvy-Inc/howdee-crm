// #390: scheduled assistant jobs can email their report to admins. Recipients are enforced in
// code (active admins + REVIEW_TO only), the runner sends — never the model — From REVIEW_FROM
// on the transactional stream without tracking, the "Weekly digest" preset, "Send me a test
// now" (the clicker only), and the email rendering (model HTML escaped, links absolute).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { getJob, runJob, saveJob, validateJobInput } from '../src/lib/server/ai/jobs';
import { saveAssistantConfig } from '../src/lib/server/ai/config';
import { capWords, renderJobEmail, resolveEmailRecipients } from '../src/lib/server/ai/jobs-email';
import { jobEmailSender } from '../src/lib/server/job-email-send';
import type { AiProvider, ProviderEvent } from '../src/lib/server/ai/provider';
import { DIGEST_PRESET, REVIEW_TO_KEY } from '../src/lib/ai-jobs';
import { DEFAULT_APP_NAME } from '../src/lib/branding';
import { actions } from '../src/routes/settings/assistant/jobs/+page.server';

const db = (env as any).DB as D1Database;
const LA = 'America/Los_Angeles';
const HOOK = 'https://hooks.example.com/abc';
const BASE = 'https://crm.example.com';
const MAIL_ENV = {
	POSTMARK_TOKEN: 'pm-test-token',
	POSTMARK_STREAM_TX: 'outbound',
	REVIEW_FROM: 'assistant@ourco.example',
	REVIEW_TO: 'review@ourco.example',
	SESSION_SECRET: 'x'.repeat(32)
};
const ENV = { ANTHROPIC_API_KEY: 'sk-ant-api03-jobs-test-key-0000', ...MAIL_ENV, PUBLIC_BASE_URL: BASE };

const stamp = Date.now();
let admin: any; // has an email
let admin2: any; // has an email
let noMail: any; // admin without an email
let member: any; // has an email, but is not an admin

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}
async function makeUser(login: string, role: 'admin' | 'member', email: string | null) {
	const r = await db
		.prepare('INSERT INTO users (github_login, role, email) VALUES (?, ?, ?) RETURNING id')
		.bind(login, role, email)
		.first<{ id: number }>();
	return sessionUser({ id: r!.id, github_login: login, role });
}

beforeAll(async () => {
	admin = await makeUser(`dig-admin-${stamp}`, 'admin', `admin-${stamp}@ourco.example`);
	admin2 = await makeUser(`dig-admin2-${stamp}`, 'admin', `admin2-${stamp}@ourco.example`);
	noMail = await makeUser(`dig-nomail-${stamp}`, 'admin', null);
	member = await makeUser(`dig-member-${stamp}`, 'member', `member-${stamp}@ourco.example`);
});

beforeEach(async () => {
	await db.prepare('DELETE FROM ai_job_runs').run();
	await db.prepare('DELETE FROM ai_jobs').run();
	await saveAssistantConfig(db, { access: 'everyone' });
});

afterEach(() => vi.unstubAllGlobals());

const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };
function provider(text: string): AiProvider {
	return {
		async *stream() {
			const ev: ProviderEvent[] = [
				{ type: 'text', text },
				{ type: 'done', content: [{ type: 'text', text }], stopReason: 'end_turn', usage }
			];
			yield* ev;
		}
	};
}

const BASE_FORM = {
	name: 'Digest',
	prompt: 'Summarise last week.',
	model: 'claude-sonnet-5-5',
	effort: 'low',
	schedule_kind: 'weekly',
	schedule_dow: '1',
	schedule_time: '07:00',
	timezone: LA,
	payload_format: 'json',
	enabled: '1'
};
const CFG = { allowedModels: ['claude-sonnet-5-5'] };

async function saveForm(over: Record<string, string>) {
	const v = validateJobInput({ ...BASE_FORM, ...over }, CFG);
	if (!v.ok) return v;
	return saveJob(db, {}, null, v.value, admin.id, new Date('2026-10-19T00:00:00Z'));
}

/** A fetch that records Postmark batches (and anything else) and accepts every message. */
function postmarkFetch(opts: { status?: number; throwFirst?: boolean } = {}) {
	const batches: any[][] = [];
	const other: string[] = [];
	let calls = 0;
	vi.stubGlobal('fetch', async (u: string | URL, init: RequestInit) => {
		const url = String(u);
		if (url === 'https://api.postmarkapp.com/email/batch') {
			calls += 1;
			if (opts.throwFirst && calls === 1) throw new TypeError('network down');
			const msgs = JSON.parse(String(init.body));
			batches.push(msgs);
			if (opts.status && opts.status >= 400) return new Response(JSON.stringify({ Message: 'Server error' }), { status: opts.status });
			return Response.json(msgs.map((m: any, i: number) => ({ ErrorCode: 0, Message: 'OK', MessageID: `mid-${i}`, To: m.To })));
		}
		other.push(url);
		return new Response('ok', { status: 200 });
	});
	return { batches, other, calls: () => calls };
}

describe('recipient enforcement (#390)', () => {
	it('accepts active admins and REVIEW_TO', async () => {
		const r = await saveForm({ deliver_webhook: '0', deliver_email: '1', email_to: `${admin.id},${admin2.id},${REVIEW_TO_KEY}` });
		expect(r.ok).toBe(true);
		const job = (await getJob(db, (r as any).id))!;
		expect(JSON.parse(job.email_admins!)).toEqual([admin.id, admin2.id, REVIEW_TO_KEY]);
		expect(job.webhook_url).toBe('');
	});

	it('refuses a non-admin user, an unknown id (e.g. a contact id), a free-text address and a list name', async () => {
		const contact = await db.prepare(`INSERT INTO contacts (email) VALUES (?) RETURNING id`).bind(`c-${stamp}@example.com`).first<{ id: number }>();
		const cases = [String(member.id), '987654', `c-${stamp}@example.com`, 'someone@evil.example', 'Newsletter', `${admin.id},x@y.example.net`];
		for (const email_to of cases) {
			const r = await saveForm({ deliver_webhook: '0', deliver_email: '1', email_to });
			expect(r.ok, email_to).toBe(false);
			expect((r as any).error).toMatch(/admins/);
		}
		// A contact's id is only accepted if it happens to be an admin's id — check a fresh one.
		const r = await saveForm({ deliver_webhook: '0', deliver_email: '1', email_to: String(contact!.id + 100000) });
		expect(r.ok).toBe(false);
		expect(await db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').first<{ n: number }>()).toEqual({ n: 0 });
	});

	it('the save action refuses a member id server-side (400, nothing stored)', async () => {
		const fd = new FormData();
		for (const [k, v] of Object.entries({ ...BASE_FORM, deliver_webhook: '0', deliver_email: '1' })) fd.append(k, v);
		fd.append('email_to', String(admin.id));
		fd.append('email_to', String(member.id));
		const url = new URL('https://app.test/settings/assistant/jobs?/save');
		const r: any = await actions.save({
			url,
			params: {},
			request: new Request(url, { method: 'POST', body: fd }),
			locals: { user: admin, authed: true },
			platform: { env: { ...(env as any), ...ENV } }
		} as any);
		expect(r.status).toBe(400);
		expect(await db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').first<{ n: number }>()).toEqual({ n: 0 });
	});

	it('needs a delivery: neither webhook nor email is refused', async () => {
		const r = await saveForm({ deliver_webhook: '0' });
		expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/webhook, email/) });
	});

	it('addresses come from users at send time: a demoted admin, a no-email admin and junk are skipped', async () => {
		const demoted = await makeUser(`dig-demoted-${stamp}`, 'admin', `demoted-${stamp}@ourco.example`);
		await db.prepare(`UPDATE users SET role = 'member' WHERE id = ?`).bind(demoted.id).run();
		const r = await resolveEmailRecipients(db, [admin.id, demoted.id, noMail.id, member.id, REVIEW_TO_KEY, 'x@y.example.net' as any], 'review@ourco.example');
		expect(r.addresses).toEqual([`admin-${stamp}@ourco.example`, 'review@ourco.example']);
	});
});

describe('delivery (#390)', () => {
	it('one Postmark batch to the admins, From REVIEW_FROM, TX stream, no tracking; no webhook for an email-only job', async () => {
		const saved = await saveForm({ deliver_webhook: '0', deliver_email: '1', email_to: `${admin.id},${admin2.id},${noMail.id}` });
		const job = (await getJob(db, (saved as any).id))!;
		const pm = postmarkFetch();
		const r = await runJob(db, ENV, job, {
			trigger: 'schedule',
			provider: provider('## Digest\n\n- [Ann](/contacts/5) replied.'),
			emailSender: jobEmailSender(db, MAIL_ENV, BASE),
			now: new Date('2026-10-19T14:00:00Z')
		});
		expect(r).toMatchObject({ status: 'ok', emailStatus: 'sent', webhookStatus: null, error: null });
		expect(pm.other).toEqual([]); // no webhook, nothing else
		expect(pm.batches).toHaveLength(1);
		const msgs = pm.batches[0];
		expect(msgs.map((m: any) => m.To).sort()).toEqual([`admin-${stamp}@ourco.example`, `admin2-${stamp}@ourco.example`].sort());
		for (const m of msgs) {
			expect(m).toMatchObject({ From: 'assistant@ourco.example', MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None' });
			expect(m.Subject).toBe(`${DEFAULT_APP_NAME} digest, week of October 19, 2026`);
			expect(m.HtmlBody).toContain(`href="${BASE}/contacts/5"`);
			expect(m.TextBody).toContain(`${BASE}/contacts/5`);
			expect(m.Headers ?? []).toEqual([]); // no List-Unsubscribe: internal mail
		}
		const run = await db.prepare('SELECT status, email_status, webhook_status FROM ai_job_runs WHERE job_id = ?').bind(job.id).first<any>();
		expect(run).toEqual({ status: 'ok', email_status: 'sent', webhook_status: null });
	});

	it('both: the webhook and the email', async () => {
		const saved = await saveForm({ deliver_webhook: '1', webhook_url: HOOK, deliver_email: '1', email_to: String(admin.id) });
		const job = (await getJob(db, (saved as any).id))!;
		const pm = postmarkFetch();
		const r = await runJob(db, ENV, job, { trigger: 'schedule', provider: provider('Report'), emailSender: jobEmailSender(db, MAIL_ENV, BASE) });
		expect(r).toMatchObject({ status: 'ok', webhookStatus: 200, emailStatus: 'sent' });
		expect(pm.other).toEqual([HOOK]);
		expect(pm.batches).toHaveLength(1);
	});

	it('a failed send is recorded, not retried; a network failure is retried once', async () => {
		const saved = await saveForm({ deliver_webhook: '0', deliver_email: '1', email_to: String(admin.id) });
		const job = (await getJob(db, (saved as any).id))!;
		let pm = postmarkFetch({ status: 500 });
		const r = await runJob(db, ENV, job, { trigger: 'schedule', provider: provider('Report'), emailSender: jobEmailSender(db, MAIL_ENV, BASE) });
		expect(r.status).toBe('ok'); // the report itself is fine
		expect(r.emailStatus).toBe('failed');
		expect(r.error).toMatch(/^Email: /);
		expect(pm.calls()).toBe(1);
		const run = await db.prepare('SELECT email_status, error FROM ai_job_runs WHERE id = ?').bind(r.runId).first<any>();
		expect(run.email_status).toBe('failed');
		expect(run.error).toMatch(/Email:/);

		vi.unstubAllGlobals();
		pm = postmarkFetch({ throwFirst: true });
		const r2 = await runJob(db, ENV, job, { trigger: 'schedule', provider: provider('Report'), emailSender: jobEmailSender(db, MAIL_ENV, BASE) });
		expect(r2.emailStatus).toBe('sent');
		expect(pm.calls()).toBe(2);
	});

	it('without an injected sender the email is recorded as failed (the ai/ modules cannot send)', async () => {
		const saved = await saveForm({ deliver_webhook: '0', deliver_email: '1', email_to: String(admin.id) });
		const job = (await getJob(db, (saved as any).id))!;
		const r = await runJob(db, ENV, job, { trigger: 'schedule', provider: provider('Report') });
		expect(r.emailStatus).toBe('failed');
	});
});

function pageEvent(action: string, user: any, form: Record<string, string> = {}) {
	const url = new URL(`https://app.test/settings/assistant/jobs?/${action}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		url,
		params: {},
		request: new Request(url, { method: 'POST', body: fd }),
		locals: { user, authed: true },
		platform: { env: { ...(env as any), ...ENV } }
	} as any;
}

const ANSWER_SSE = [
	{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Digest\n\n- Quiet week.' } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
	{ type: 'message_stop' }
]
	.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	.join('');

describe('Settings → Assistant → Jobs (#390)', () => {
	it('"Create weekly digest" makes the preset job: Monday 07:00, email to admins + REVIEW_TO, no webhook', async () => {
		let loc = '';
		try {
			await actions.createDigest(pageEvent('createDigest', admin));
		} catch (e: any) {
			loc = e.location;
		}
		const id = Number(new URL(loc, 'https://app.test').searchParams.get('job'));
		const job = (await getJob(db, id))!;
		expect(job).toMatchObject({
			name: DIGEST_PRESET.name,
			prompt: DIGEST_PRESET.prompt,
			schedule_kind: 'weekly',
			schedule_dow: 1,
			schedule_time: '07:00',
			webhook_url: '',
			enabled: 1,
			created_by: admin.id
		});
		expect(job.next_run_at).not.toBeNull();
		const sel = JSON.parse(job.email_admins!);
		expect(sel).toContain(admin.id);
		expect(sel).toContain(admin2.id);
		expect(sel).not.toContain(noMail.id); // no address: not pre-checked
		expect(sel).not.toContain(member.id);
		expect(sel).toContain(REVIEW_TO_KEY);
		expect(DIGEST_PRESET.prompt).toMatch(/awaiting an answer/);
		expect(DIGEST_PRESET.prompt).toMatch(/14 days/);
		expect(DIGEST_PRESET.prompt).toMatch(/Three suggested actions/);
	});

	it('is admin-only', async () => {
		for (const name of ['createDigest', 'testEmail'] as const) {
			const r: any = await (actions as any)[name](pageEvent(name, member, { id: '1' }));
			expect(r.status).toBe(403);
		}
	});

	it('"Send me a test now" runs the job and emails only the clicker — not the recipients, not the webhook', async () => {
		const saved = await saveForm({
			deliver_webhook: '1',
			webhook_url: HOOK,
			deliver_email: '1',
			email_to: `${admin.id},${admin2.id},${REVIEW_TO_KEY}`
		});
		const id = (saved as any).id;
		const batches: any[][] = [];
		const urls: string[] = [];
		vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
			urls.push(String(u));
			if (String(u).startsWith('https://api.anthropic.com/')) {
				const enc = new TextEncoder();
				return new Response(new ReadableStream({ start: (c) => (c.enqueue(enc.encode(ANSWER_SSE)), c.close()) }), {
					headers: { 'content-type': 'text/event-stream' }
				});
			}
			const msgs = JSON.parse(String(init.body));
			batches.push(msgs);
			return Response.json(msgs.map(() => ({ ErrorCode: 0, Message: 'OK', MessageID: 'm1' })));
		});
		const r: any = await actions.testEmail(pageEvent('testEmail', admin2, { id: String(id) }));
		expect(r.runResult).toMatchObject({ status: 'ok', emailStatus: 'sent', webhookStatus: null });
		expect(urls).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.postmarkapp.com/email/batch']);
		expect(batches[0].map((m: any) => m.To)).toEqual([`admin2-${stamp}@ourco.example`]);
		const run = await db.prepare('SELECT trigger, cost_micros FROM ai_job_runs WHERE job_id = ?').bind(id).first<any>();
		expect(run.trigger).toBe('manual');
		expect(run.cost_micros).toBeGreaterThan(0); // counts against the caps
		expect((await getJob(db, id))!.last_run_at).toBeNull(); // schedule untouched
	});
});

describe('structural (#390)', () => {
	const src = import.meta.glob('../src/lib/server/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
	it('nothing under ai/ imports the email sender; the sender resolves recipients itself', () => {
		const ai = Object.keys(src).filter((f) => f.startsWith('../src/lib/server/ai/'));
		expect(ai.length).toBeGreaterThan(10);
		for (const f of ai) expect(src[f], f).not.toMatch(/from\s+['"][^'"]*job-email-send['"]/);
		const sender = src['../src/lib/server/job-email-send.ts'];
		expect(sender).toMatch(/resolveEmailRecipients\(db, sel,/);
		// Recipients reach Postmark only from the resolved addresses.
		expect(sender).toMatch(/recipients: addresses\.map/);
		expect(sender).toMatch(/trackOpens: false/);
		expect(sender).toMatch(/trackLinks: 'None'/);
	});
});

describe('rendering (#390)', () => {
	const job = { name: 'Digest', schedule_kind: 'weekly' };
	const render = (markdown: string) =>
		renderJobEmail({ markdown, job, baseUrl: BASE, jobUrl: `${BASE}/settings/assistant/jobs?job=1`, now: new Date('2026-10-21T15:00:00Z'), timezone: LA });

	it('strips HTML from the model output and keeps only http(s) links', () => {
		const out = render(
			'## Hi\n\n<script>alert(1)</script>\n\nText <img src=x onerror="alert(2)"> and <b>bold</b>\n\n[bad](javascript:alert(3)) [ok](https://example.com) [app](/campaign/4)\n\n```js\nconsole.log(1)\n```'
		);
		expect(out.html).not.toMatch(/<script/i);
		expect(out.html).not.toMatch(/<img/i);
		expect(out.html).not.toMatch(/<b>/);
		expect(out.html).not.toMatch(/javascript:/i);
		expect(out.html).not.toMatch(/<button/i);
		expect(out.html).not.toMatch(/data-app-link/);
		expect(out.html).toContain('href="https://example.com/"');
		expect(out.html).toContain(`href="${BASE}/campaign/4"`);
		expect(out.html).toContain(`${BASE}/settings/assistant/jobs?job=1`);
		expect(out.text).not.toMatch(/<script|<img|<b>/i);
		expect(out.subject).toBe(`${DEFAULT_APP_NAME} digest, week of October 19, 2026`);
	});

	it('leaves merge tags inert and caps the body at ~1,500 words', () => {
		const out = render('Hello {{first_name}} %%UNSUB_URL%%');
		expect(out.html).not.toContain('{{first_name}}');
		expect(out.text).not.toContain('{{first_name}}');
		expect(out.text).not.toContain('%%UNSUB_URL%%');
		const long = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
		const c = capWords(long);
		expect(c.trimmed).toBe(true);
		expect(c.text.split(/\s+/)).toHaveLength(1500);
		expect(render(long)).toMatchObject({ trimmed: true });
		expect(render(long).text).toMatch(/Trimmed to 1,500 words/);
	});
});

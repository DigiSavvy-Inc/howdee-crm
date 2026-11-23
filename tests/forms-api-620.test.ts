import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { emptyForm, normalizeFormSpec, validateFormSpec, type FormSpec } from '../src/lib/forms';
import { createForm, getForm, recordSubmission, type FormRow } from '../src/lib/server/forms';
import { handleSubmission, type SubmitContext } from '../src/lib/server/form-submit';
import { FORM_WEBHOOK_HEADER, deliverFormWebhook, formWebhookSecret, pageUrl } from '../src/lib/server/form-webhook';
import { parseSince } from '../src/lib/server/forms-api';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listFormsGET } from '../src/routes/api/v1/forms/+server';
import { GET as submissionsGET } from '../src/routes/api/v1/forms/[id]/submissions/+server';
import { POST as mcpPOST } from '../src/routes/mcp/+server';
import { resetMcpRateLimits } from '../src/lib/server/mcp/server';
import { toolsForScope } from '../src/lib/server/mcp/tools';
import { parseArgs, planRequest } from '../scripts/dscrm-lib.mjs';

// #620: the per-form webhook (signed, 5 s, failures noted on the submission), the read-only
// Data API (GET /api/v1/forms, /forms/:id/submissions), the MCP read tools and the CLI.

const db = (env as any).DB as D1Database;
const SECRET = 'test-secret';
const baseEnv = { SESSION_SECRET: SECRET };
let ipN = 0;
const ctx = (extra: Partial<SubmitContext> = {}): SubmitContext => ({
	origin: 'https://crm.test',
	crmOrigins: ['https://crm.test'],
	ip: `10.6.20.${++ipN}`,
	mxLookup: async () => 'ok',
	...extra
});

async function makeForm(mutate: (s: FormSpec) => void = () => {}, name = 'Hook form', status = 'published'): Promise<FormRow> {
	const id = await createForm(db, name, null);
	const spec = emptyForm(name);
	mutate(spec);
	await db.prepare('UPDATE forms SET spec = ?, status = ? WHERE id = ?').bind(JSON.stringify(spec), status, id).run();
	return (await getForm(db, id))!;
}

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, token?: string, params: Record<string, string> = {}) {
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return { request: new Request(url, { headers }), platform: { env }, url, params, locals: {} } as any;
}
const body = async (res: Response) => JSON.parse(await res.text());

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function hmacHex(key: string, data: string) {
	const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}

type Captured = { url: string; init: RequestInit };
function recorder(status = 200) {
	const calls: Captured[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response('ok', { status });
	}) as unknown as typeof fetch;
	return { calls, fn };
}

beforeEach(async () => {
	resetMcpRateLimits();
	await db.batch([db.prepare('DELETE FROM api_keys'), db.prepare('DELETE FROM form_submissions'), db.prepare('DELETE FROM forms'), db.prepare('DELETE FROM rate_limits')]);
});

describe('settings.notify_webhook', () => {
	it('is normalized and must be a public https URL', () => {
		expect(normalizeFormSpec({}).settings.notify_webhook).toBe('');
		const spec = emptyForm('X');
		spec.settings.notify_webhook = 'http://example.com/hook';
		expect(validateFormSpec(spec).some((p) => p.path === 'settings.notify_webhook')).toBe(true);
		for (const bad of ['https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://u:p@hooks.test/x']) {
			spec.settings.notify_webhook = bad;
			expect(validateFormSpec(spec).some((p) => p.path === 'settings.notify_webhook'), bad).toBe(true);
		}
		spec.settings.notify_webhook = 'https://hooks.example.com/form';
		expect(validateFormSpec(spec).some((p) => p.path === 'settings.notify_webhook')).toBe(false);
	});

	it('pageUrl keeps http(s) only and drops credentials', () => {
		expect(pageUrl('https://site.test/pricing?x=1')).toBe('https://site.test/pricing?x=1');
		expect(pageUrl('javascript:alert(1)')).toBeNull();
		expect(pageUrl('https://a:b@site.test/')).toBe('https://site.test/');
		expect(pageUrl(null)).toBeNull();
	});
});

describe('the form webhook', () => {
	it('POSTs a signed JSON payload on an accepted submission', async () => {
		const form = await makeForm((s) => {
			s.settings.notify_webhook = 'https://hooks.example.com/form';
		});
		const rec = recorder();
		const now = new Date('2026-11-18T12:00:00Z');
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'hook@forms.test' }, referrer: 'https://site.test/contact' }, ctx({ fetch: rec.fn, now }));
		expect(r.ok).toBe(true);
		expect(rec.calls).toHaveLength(1);
		const { url, init } = rec.calls[0];
		expect(url).toBe('https://hooks.example.com/form');
		expect(init.method).toBe('POST');
		expect(init.redirect).toBe('manual');
		const raw = String(init.body);
		const payload = JSON.parse(raw);
		expect(payload).toMatchObject({
			form: { id: form.id, name: form.name, slug: form.slug },
			submission_id: r.submissionId,
			email: 'hook@forms.test',
			answers: { email: 'hook@forms.test' },
			submitted_at: '2026-11-18T12:00:00.000Z',
			page_url: 'https://site.test/contact'
		});
		expect(typeof payload.contact_id).toBe('number');

		// Signature: t=<unix>,v1=<hex HMAC-SHA256(key, "t.body")>, key derived from SESSION_SECRET.
		const headers = init.headers as Record<string, string>;
		const sig = headers[FORM_WEBHOOK_HEADER];
		const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
		expect(m).not.toBeNull();
		expect(Number(m![1])).toBe(Math.floor(now.getTime() / 1000));
		const key = await formWebhookSecret(SECRET, form.id);
		expect(key).toMatch(/^fwh_[0-9a-f]{48}$/);
		expect(key).not.toContain(SECRET);
		expect(m![2]).toBe(await hmacHex(key, `${m![1]}.${raw}`));
		// A different form signs with a different key.
		expect(await formWebhookSecret(SECRET, form.id + 1)).not.toBe(key);

		const row = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ detail: string | null }>();
		expect(row?.detail ?? '').not.toMatch(/webhook/);
	});

	it('hands the work to waitUntil when the route has it', async () => {
		const form = await makeForm((s) => {
			s.settings.notify_webhook = 'https://hooks.example.com/form';
		});
		const rec = recorder();
		const pending: Promise<unknown>[] = [];
		await handleSubmission(db, baseEnv, form, { answers: { email: 'later@forms.test' } }, ctx({ fetch: rec.fn, waitUntil: (p) => pending.push(p) }));
		expect(pending).toHaveLength(1);
		await Promise.all(pending);
		expect(rec.calls).toHaveLength(1);
	});

	it('never fires for spam, rejected or invalid submissions, or without a URL', async () => {
		const form = await makeForm((s) => {
			s.settings.notify_webhook = 'https://hooks.example.com/form';
		});
		const rec = recorder();
		await handleSubmission(db, baseEnv, form, { answers: { email: 'bot@forms.test' }, honeypot: 'x' }, ctx({ fetch: rec.fn }));
		await handleSubmission(db, baseEnv, form, { answers: { email: 'x@forms.test' } }, ctx({ fetch: rec.fn, origin: 'https://evil.test' }));
		await handleSubmission(db, baseEnv, form, { answers: { email: 'not-an-email' } }, ctx({ fetch: rec.fn }));
		expect(rec.calls).toHaveLength(0);
		const plain = await makeForm(() => {}, 'No hook');
		await handleSubmission(db, baseEnv, plain, { answers: { email: 'plain@forms.test' } }, ctx({ fetch: rec.fn }));
		expect(rec.calls).toHaveLength(0);
	});

	it('writes a failure into the submission detail', async () => {
		const form = await makeForm((s) => {
			s.settings.notify_webhook = 'https://hooks.example.com/form';
		});
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'fail@forms.test' } }, ctx({ fetch: recorder(500).fn }));
		expect(r.ok).toBe(true);
		const row = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ detail: string }>();
		expect(row?.detail).toMatch(/webhook failed: answered 500/);

		const thrower = (async () => {
			throw new Error('boom');
		}) as unknown as typeof fetch;
		const r2 = await handleSubmission(db, baseEnv, form, { answers: { email: 'fail2@forms.test' } }, ctx({ fetch: thrower }));
		const row2 = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(r2.submissionId).first<{ detail: string }>();
		expect(row2?.detail).toMatch(/webhook failed: unreachable/);
	});

	it('refuses a private or non-https URL at send time without a request', async () => {
		const rec = recorder();
		const payload = { form: { id: 1, name: 'F', slug: 'f' }, submission_id: 1, contact_id: null, email: null, answers: {}, submitted_at: 'x', page_url: null };
		for (const url of ['https://127.0.0.1/hook', 'http://hooks.example.com/hook', 'https://169.254.169.254/latest']) {
			const r = await deliverFormWebhook(url, payload, 'k', { fetch: rec.fn });
			expect(r.ok).toBe(false);
		}
		expect(rec.calls).toHaveLength(0);
	});
});

describe('GET /api/v1/forms and /forms/:id/submissions', () => {
	it('needs a Bearer key with read scope', async () => {
		expect((await listFormsGET(ev('/api/v1/forms'))).status).toBe(401);
		expect((await listFormsGET(ev('/api/v1/forms', 'dk_live_nope'))).status).toBe(401);
		expect((await submissionsGET(ev('/api/v1/forms/1/submissions', undefined, { id: '1' }))).status).toBe(401);
		const draft = await makeKey('campaigns:draft');
		expect((await listFormsGET(ev('/api/v1/forms', draft))).status).toBe(403);
	});

	it('lists forms (archived only on request) with fields and accepted counts', async () => {
		const token = await makeKey('read');
		const a = await makeForm(() => {}, 'Alpha');
		await makeForm(() => {}, 'Old', 'archived');
		await recordSubmission(db, { form_id: a.id, form_version: 1, contact_id: null, email: 'x@forms.test', status: 'anonymous', answers: {} });
		await recordSubmission(db, { form_id: a.id, form_version: 1, contact_id: null, email: null, status: 'spam', answers: {} });
		const res = await listFormsGET(ev('/api/v1/forms', token));
		expect(res.status).toBe(200);
		const b = await body(res);
		expect(b.data.map((f: any) => f.name)).toEqual(['Alpha']);
		expect(b.data[0]).toMatchObject({ id: a.id, slug: a.slug, status: 'published', submissions: 1 });
		expect(b.data[0].url).toMatch(new RegExp(`/f/${a.slug}$`));
		expect(b.data[0].fields).toEqual([{ key: 'email', type: 'email', label: 'Email', required: true }]);
		expect(b.data[0]).not.toHaveProperty('spec');
		expect(b.pagination).toMatchObject({ total: 1, has_more: false });
		const all = await body(await listFormsGET(ev('/api/v1/forms?include_archived=1', token)));
		expect(all.data).toHaveLength(2);
		expect((await listFormsGET(ev('/api/v1/forms?status=nope', token))).status).toBe(400);
	});

	it('pages submissions (≤ 200), newest first, accepted only, with since', async () => {
		const token = await makeKey('read');
		const f = await makeForm();
		for (let i = 0; i < 5; i++) {
			const id = await recordSubmission(db, { form_id: f.id, form_version: 1, contact_id: null, email: `s${i}@forms.test`, status: 'anonymous', answers: { n: i } });
			await db.prepare('UPDATE form_submissions SET created_at = ? WHERE id = ?').bind(`2026-11-1${i} 10:00:00`, id).run();
		}
		await recordSubmission(db, { form_id: f.id, form_version: 1, contact_id: null, email: 'bot@forms.test', status: 'spam', answers: {} });

		const p1 = await body(await submissionsGET(ev(`/api/v1/forms/${f.id}/submissions?limit=2`, token, { id: String(f.id) })));
		expect(p1.data.map((s: any) => s.email)).toEqual(['s4@forms.test', 's3@forms.test']);
		expect(p1.pagination).toEqual({ limit: 2, offset: 0, total: 5, has_more: true });
		expect(p1.data[0]).toMatchObject({ form_id: f.id, status: 'anonymous', answers: { n: 4 }, submitted_at: '2026-11-14T10:00:00Z' });
		const p3 = await body(await submissionsGET(ev(`/api/v1/forms/${f.id}/submissions?limit=2&offset=4`, token, { id: String(f.id) })));
		expect(p3.data.map((s: any) => s.email)).toEqual(['s0@forms.test']);
		expect(p3.pagination.has_more).toBe(false);

		const big = await body(await submissionsGET(ev(`/api/v1/forms/${f.id}/submissions?limit=5000`, token, { id: String(f.id) })));
		expect(big.pagination.limit).toBe(200);

		const since = await body(await submissionsGET(ev(`/api/v1/forms/${f.id}/submissions?since=2026-11-12T10:00:00Z`, token, { id: String(f.id) })));
		expect(since.data.map((s: any) => s.email)).toEqual(['s4@forms.test', 's3@forms.test']);
		const sinceDay = await body(await submissionsGET(ev(`/api/v1/forms/${f.id}/submissions?since=2026-11-13`, token, { id: String(f.id) })));
		expect(sinceDay.pagination.total).toBe(2);

		expect((await submissionsGET(ev(`/api/v1/forms/${f.id}/submissions?since=garbage`, token, { id: String(f.id) }))).status).toBe(400);
		expect((await submissionsGET(ev('/api/v1/forms/abc/submissions', token, { id: 'abc' }))).status).toBe(400);
		expect((await submissionsGET(ev('/api/v1/forms/999999/submissions', token, { id: '999999' }))).status).toBe(404);
	});

	it('parseSince', () => {
		expect(parseSince(null)).toBeUndefined();
		expect(parseSince('2026-11-01')).toBe('2026-11-01 00:00:00');
		expect(parseSince('2026-11-01T08:30:00-08:00')).toBe('2026-11-01 16:30:00');
		expect(parseSince('nope')).toBeNull();
	});
});

describe('MCP read tools', () => {
	let n = 1;
	async function call(token: string, name: string, args: Record<string, unknown>) {
		const url = new URL('https://app.test/mcp');
		const req = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name, arguments: args } })
		});
		const res = await mcpPOST({ request: req, platform: { env }, url, params: {} } as any);
		return JSON.parse(await res.text()).result;
	}

	it('list_forms and get_form_submissions are read tools, not for draft keys', async () => {
		expect(toolsForScope('read')).toEqual(expect.arrayContaining(['list_forms', 'get_form_submissions']));
		expect(toolsForScope('campaigns:draft')).not.toContain('list_forms');
		expect(toolsForScope('automations:draft')).not.toContain('get_form_submissions');

		const token = await makeKey('read');
		const f = await makeForm(() => {}, 'MCP form');
		await recordSubmission(db, { form_id: f.id, form_version: 1, contact_id: null, email: 'm@forms.test', status: 'anonymous', answers: { a: 1 } });
		const list = await call(token, 'list_forms', {});
		expect(list.isError).toBe(false);
		expect(JSON.parse(list.content[0].text).map((x: any) => x.name)).toEqual(['MCP form']);
		const subs = await call(token, 'get_form_submissions', { form_id: f.id, limit: 10 });
		expect(subs.isError).toBe(false);
		expect(subs.structuredContent).toMatchObject({ form_id: f.id, total: 1, submissions: [{ email: 'm@forms.test', answers: { a: 1 } }] });
		expect((await call(token, 'get_form_submissions', { form_id: 999999 })).isError).toBe(true);
		expect((await call(token, 'get_form_submissions', { form_id: f.id, since: 'nope' })).isError).toBe(true);
	});
});

describe('dscrm forms', () => {
	const plan = (argv: string[]) => {
		const { positional, flags } = parseArgs(argv);
		return planRequest(positional, flags);
	};
	it('list and submissions', () => {
		expect(plan(['forms', 'list'])).toEqual({ method: 'GET', path: '/api/v1/forms' });
		expect(plan(['forms', 'list', '--status', 'published'])).toEqual({ method: 'GET', path: '/api/v1/forms?status=published' });
		expect(plan(['forms', 'submissions', '4'])).toEqual({ method: 'GET', path: '/api/v1/forms/4/submissions' });
		expect(plan(['forms', 'submissions', '4', '--since', '2026-11-01', '--limit', '200', '--offset', '200']).path).toBe(
			'/api/v1/forms/4/submissions?since=2026-11-01&limit=200&offset=200'
		);
		expect(() => plan(['forms', 'submissions'])).toThrow(/positive id/);
		expect(() => plan(['forms', 'delete', '4'])).toThrow(/Unknown command/);
	});
});

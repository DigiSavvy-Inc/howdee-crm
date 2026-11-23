import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { hashPassword } from '$lib/server/password';
import { githubConfigured } from '$lib/server/github-oauth';
import { googleConfigured } from '$lib/server/gmail';
import {
	githubProvider,
	runIntegrationsTick,
	runProviderSync,
	testConnection,
	timingProvider,
	zohoBooksProvider
} from '$lib/server/integrations';
import { attachRepo } from '$lib/server/integrations/github';
import { runMailTick } from '$lib/server/mail-sync';
import { resolveAnthropicKey } from '$lib/server/ai/key';
import { runAccountBriefs } from '$lib/server/ai/account-brief';
import { fetchPostmarkDomains, runDomainAuthCheck } from '$lib/server/domain-auth';
import { POST as tickPOST } from '../src/routes/api/automations/tick/+server';
import { POST as lumaPOST } from '../src/routes/api/luma/+server';
import { POST as inboundPOST } from '../src/routes/api/inbound/+server';
import { POST as chatPOST } from '../src/routes/api/assistant/chat/+server';
import { POST as resendSubjectPOST } from '../src/routes/api/ai/resend-subject/+server';
import { GET as timingProjectsGET } from '../src/routes/api/integrations/timing/projects/+server';
import { GET as zohoCustomersGET } from '../src/routes/api/integrations/zoho/customers/+server';
import { GET as githubStart } from '../src/routes/auth/github/+server';
import { GET as googleStart } from '../src/routes/auth/google/+server';
import { actions as loginActions, load as loginLoad } from '../src/routes/login/+page.server';
import { load as integrationsLoad } from '../src/routes/settings/integrations/+page.server';
import { load as mailLoad } from '../src/routes/settings/mail/+page.server';
import { load as assistantLoad } from '../src/routes/settings/assistant/+page.server';
import { load as settingsLoad } from '../src/routes/settings/+page.server';

// #605: a new install has only the required pieces — D1, the media bucket, SESSION_SECRET,
// POSTMARK_TOKEN, CRON_KEY (plus the deploy vars every wrangler.jsonc carries). Every optional
// integration must then stay quiet: no throw, no outbound request, no log line every tick, and
// its settings page says it isn't set up.

const db = (env as any).DB as D1Database;

/** In-memory R2 stand-in, enough for the backup tick. */
function fakeBucket() {
	const store = new Map<string, unknown>();
	return {
		async put(key: string, value: unknown) {
			store.set(key, value);
			return {};
		},
		async get() {
			return null;
		},
		async head() {
			return null;
		},
		async list() {
			return { objects: [], delimitedPrefixes: [], truncated: false };
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		}
	};
}

/** The required configuration and nothing else. */
function requiredEnv(): Record<string, unknown> {
	return {
		DB: db,
		MEDIA: fakeBucket(),
		SESSION_SECRET: 'test-session-secret-605',
		POSTMARK_TOKEN: 'pm-server-token',
		CRON_KEY: 'cron-605',
		// Deploy vars every wrangler.jsonc carries (not integrations).
		POSTMARK_FROM: 'sender@example.com',
		POSTMARK_STREAM: 'broadcast',
		POSTMARK_STREAM_TX: 'outbound',
		PUBLIC_BASE_URL: 'https://crm.example.com'
	};
}

/** Hosts the required configuration may reach: Postmark (POSTMARK_TOKEN) and DNS-over-HTTPS. */
const REQUIRED_HOSTS = new Set(['api.postmarkapp.com', 'cloudflare-dns.com', '1.1.1.1', '1.0.0.1']);

let calls: string[] = [];
let realFetch: typeof fetch;

beforeEach(() => {
	calls = [];
	realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push(url);
		const host = new URL(url).hostname;
		if (host === 'cloudflare-dns.com' || host === '1.1.1.1' || host === '1.0.0.1') {
			return Response.json({ Status: 0, Answer: [] }, { headers: { 'content-type': 'application/dns-json' } });
		}
		if (host === 'api.postmarkapp.com') {
			if (url.includes('/suppressions/dump')) return Response.json({ Suppressions: [] });
			return Response.json({ ID: 'broadcast', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } });
		}
		return new Response('unexpected', { status: 599 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

/** Fetch calls to anything the required configuration doesn't cover. */
const optionalCalls = () => calls.filter((u) => !REQUIRED_HOSTS.has(new URL(u).hostname));

let seq = 0;
async function makeUser(role: 'admin' | 'member', password?: string) {
	seq++;
	const login = `opt605-${role}-${seq}`;
	const hash = password ? await hashPassword(password) : null;
	const r = await db
		.prepare('INSERT INTO users (github_login, role, password_hash) VALUES (?, ?, ?) RETURNING id')
		.bind(login, role, hash)
		.first<{ id: number }>();
	return {
		id: r!.id,
		github_login: login,
		role,
		name: null,
		avatar_url: null,
		tourSeen: true,
		navLayout: 'top',
		passwordSetAt: null,
		mustChangePassword: false
	} as any;
}

function event(
	path: string,
	opts: { user?: any; method?: string; body?: BodyInit; headers?: Record<string, string>; form?: Record<string, string>; env?: Record<string, unknown> } = {}
) {
	const url = new URL(`https://crm.example.com${path}`);
	let body = opts.body;
	if (opts.form) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(opts.form)) fd.append(k, v);
		body = fd;
	}
	const headers = new Headers(opts.headers ?? {});
	const cookieJar = new Map<string, string>();
	return {
		url,
		params: {},
		request: new Request(url, { method: opts.method ?? (body ? 'POST' : 'GET'), body, headers }),
		locals: { user: opts.user ?? null, authed: !!opts.user },
		platform: { env: { ...requiredEnv(), ...opts.env } },
		cookies: {
			get: (k: string) => cookieJar.get(k),
			set: (k: string, v: string) => void cookieJar.set(k, v),
			delete: (k: string) => void cookieJar.delete(k)
		},
		getClientAddress: () => '203.0.113.5',
		setHeaders: () => {},
		depends: () => {}
	} as any;
}

async function thrown(fn: () => unknown): Promise<any> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return null;
}

describe('#605 heartbeat with only the required configuration', () => {
	it('runs twice without errors, log lines or requests to optional services', async () => {
		const errors = vi.spyOn(console, 'error');
		const warns = vi.spyOn(console, 'warn');
		for (let i = 0; i < 2; i++) {
			const res = await tickPOST(event('/api/automations/tick', { method: 'POST', headers: { authorization: 'Bearer cron-605' } }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, any>;
			expect(body.ok).toBe(true);
			expect(body.integrations).toEqual([]);
			expect(body.mail).toEqual({ skipped: 'not_configured' });
			expect(body.accountBriefs.skipped).toBe('assistant off');
			// A failure message (string) or a non-zero count (aiJobs.error) fails; a count of 0 is fine.
			for (const k of Object.keys(body)) expect([undefined, 0], k).toContain(body[k]?.error);
		}
		expect(optionalCalls()).toEqual([]);
		// The Domains API needs POSTMARK_ACCOUNT_TOKEN; the server token alone never calls it.
		expect(calls.filter((u) => u.includes('/domains'))).toEqual([]);
		expect(errors).not.toHaveBeenCalled();
		expect(warns).not.toHaveBeenCalled();
	});
});

describe('#605 integration entry points with only the required configuration', () => {
	it('Timing, GitHub and Zoho Books: no sync, no probe, no request', async () => {
		const e = requiredEnv() as any;
		expect(await runIntegrationsTick(db, e)).toEqual([]);
		for (const p of [timingProvider, githubProvider, zohoBooksProvider]) {
			expect(await runProviderSync(db, e, p, 'manual')).toEqual({ provider: p.provider, skipped: 'not_configured' });
			expect(await testConnection(db, e, p)).toBeNull();
		}
		const company = await db.prepare(`INSERT INTO companies (name) VALUES ('Opt605 Co') RETURNING id`).first<{ id: number }>();
		const attached = await attachRepo(db, e, company!.id, 'octo/repo');
		expect(attached).toMatchObject({ ok: false });
		expect(calls).toEqual([]);
	});

	it('Timing projects and Zoho customer search answer "not connected" without a request', async () => {
		const admin = await makeUser('admin');
		const t = await timingProjectsGET(event('/api/integrations/timing/projects', { user: admin }));
		expect(t.status).toBe(409);
		const z = await zohoCustomersGET(event('/api/integrations/zoho/customers?q=acme', { user: admin }));
		expect(z.status).toBe(409);
		expect(calls).toEqual([]);
	});

	it('Gmail: the mail tick skips, Connect redirects to the setup page', async () => {
		expect(googleConfigured(requiredEnv() as any)).toBe(false);
		expect(await runMailTick(db, requiredEnv() as any)).toEqual({ skipped: 'not_configured' });
		const admin = await makeUser('admin');
		const err = await thrown(() => googleStart(event('/auth/google', { user: admin })));
		expect(err).toMatchObject({ status: 303, location: '/settings/mail?error=not_configured' });
		expect(calls).toEqual([]);
	});

	it('AI assistant: no key, nothing called', async () => {
		const admin = await makeUser('admin');
		expect(await resolveAnthropicKey(db, requiredEnv())).toBe('');
		expect(await runAccountBriefs(db, requiredEnv())).toMatchObject({ skipped: 'assistant off' });
		const chat = await chatPOST(
			event('/api/assistant/chat', { user: admin, method: 'POST', body: JSON.stringify({ message: 'hi' }), headers: { 'content-type': 'application/json' } })
		);
		expect(chat.status).toBeGreaterThanOrEqual(400);
		const subj = await resendSubjectPOST(
			event('/api/ai/resend-subject', { user: admin, method: 'POST', body: JSON.stringify({ subject: 'Hi' }), headers: { 'content-type': 'application/json' } })
		);
		expect(subj.status).toBeGreaterThanOrEqual(400);
		expect(calls).toEqual([]);
	});

	it('Postmark account token: no Domains API request without it', async () => {
		const r = await fetchPostmarkDomains(undefined, ['example.com']);
		expect(r.error).toBe('POSTMARK_ACCOUNT_TOKEN is not set');
		const { result } = await runDomainAuthCheck(db, requiredEnv() as any, 'manual');
		const dkim = result.domains[0]?.checks.find((c) => c.key === 'dkim');
		expect(dkim?.status).toBe('unknown');
		expect(dkim?.fix).toContain('POSTMARK_ACCOUNT_TOKEN');
		expect(calls.filter((u) => u.includes('/domains'))).toEqual([]);
		expect(optionalCalls()).toEqual([]);
	});

	it('Luma: a delivery is refused quietly and nothing is stored', async () => {
		const before = await db.prepare('SELECT COUNT(*) AS n FROM luma_events').first<{ n: number }>();
		const res = await lumaPOST(
			event('/api/luma', { method: 'POST', body: JSON.stringify({ type: 'guest.registered', data: { email: 'a@example.com' } }) })
		);
		expect(res.status).toBe(404);
		const after = await db.prepare('SELECT COUNT(*) AS n FROM luma_events').first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
		expect(calls).toEqual([]);
	});

	it('Inbound forwarding: /api/inbound answers "not set up" (404), not a 500', async () => {
		const res = await inboundPOST(event('/api/inbound?key=x', { method: 'POST', body: '{}' }));
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});
});

describe('#605 sign-in without GitHub', () => {
	it('the login page offers password sign-in only, and it works', async () => {
		expect(githubConfigured(requiredEnv() as any)).toBe(false);
		const data = (await loginLoad(event('/login'))) as any;
		expect(data.github).toBe(false);
		const err = await thrown(() => githubStart(event('/auth/github')));
		expect(err).toMatchObject({ status: 303, location: '/login?error=not_configured' });

		const password = 'correct horse battery 605';
		const user = await makeUser('admin', password);
		const ev = event('/login?/password', { form: { username: user.github_login, password } });
		const res = await thrown(() => (loginActions as any).password(ev));
		expect(res).toMatchObject({ status: 303, location: '/' });
		expect(calls).toEqual([]);
	});
});

describe('#605 settings pages say what is not set up', () => {
	it('each page loads without a request and reports the missing configuration', async () => {
		const admin = await makeUser('admin');
		const integrations = (await integrationsLoad(event('/settings/integrations', { user: admin }))) as any;
		for (const p of integrations.providers) expect(p.state).toBe('not_configured');
		expect(integrations.tokenKeyReady).toBe(false);
		expect(integrations.zoho.connected).toBe(false);

		const mail = (await mailLoad(event('/settings/mail', { user: admin }))) as any;
		expect(mail.googleConfigured).toBe(false);

		const assistant = (await assistantLoad(event('/settings/assistant', { user: admin }))) as any;
		expect(assistant.keySet).toBe(false);

		const general = (await settingsLoad(event('/settings', { user: admin }))) as any;
		expect(general.replyCapture).toBe(false);
		expect(general.aiKeyConfigured).toBe(false);
		expect(general.lumaSecretFromEnv).toBe(false);

		expect(calls).toEqual([]);
	});
});

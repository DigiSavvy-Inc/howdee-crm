// #748: OpenAI-compatible base URLs are https (http only for a local server), a key is only sent to
// the host it belongs to (the in-app key to the host it was saved for, the OPENAI_API_KEY secret to
// api.openai.com or OPENAI_BASE_URL_HOST), the Anthropic key only to Anthropic, and resend subject
// suggestions respect the spend caps and record their cost. A key saved before #748 is bound before
// any save can change the base URL, a cached key never answers for another host, the key form must
// match the address shown, and redirects are never followed.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { baseUrlHost, baseUrlProblem, cleanHostSetting, maskUrlCredentials } from '../src/lib/ai-providers';
import {
	OPENAI_HOST_CHANGED,
	OPENAI_KEY_FORM_STALE,
	OPENAI_KEY_HOST_STATE,
	OPENAI_SECRET_PROVIDER,
	clearOpenAiKeyCache,
	openAiKeyInfo,
	openAiNoKeyMessage,
	pinnedOpenAiHost,
	resolveOpenAiKey,
	removeOpenAiKey,
	resolveProviderKey,
	setOpenAiKey,
	testOpenAiKey
} from '../src/lib/server/ai/key';
import { openAiCompatProvider } from '../src/lib/server/ai/openai-compat';
import { storeSecret } from '../src/lib/server/integrations/secrets';
import { modelKeyProblem, normalizeConfig, saveAssistantConfig, spentMicros, utcDayStart } from '../src/lib/server/ai/config';
import { providerFor } from '../src/lib/server/ai/providers';
import { listThreads } from '../src/lib/server/ai/threads';
import { actions, load } from '../src/routes/settings/assistant/+page.server';
import { POST as suggestPost } from '../src/routes/api/ai/resend-subject/+server';
import {
	AI_SUBJECT_NONE_TEXT,
	AI_SUBJECT_RATE_LIMIT,
	AI_SUBJECT_REQUEST_TEXT,
	AI_SUBJECT_RETURNED_TEXT,
	AI_SUBJECT_THREAD_TITLE,
	AI_SUBJECT_TOOL,
	resetAiSubjectRateLimit
} from '../src/lib/server/ai-subject';

const db = (env as any).DB as D1Database;

function newMailKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const MAIL_KEY = newMailKey();
const APP_KEY = 'sk-test-Fake-748-inapp-0000'; // gitleaks:allow
const WORKER_KEY = 'sk-test-Fake-748-worker-0000'; // gitleaks:allow
const ANTHROPIC_KEY = 'sk-ant-test-Fake-748-0000'; // gitleaks:allow
const HOST_A = 'https://llm-a.example.net/v1';
const HOST_B = 'https://llm-b.example.net/v1';
const MODELS = [{ name: 'big-model', label: 'Big', tools: true, reasoning: false, price: { input: 1, output: 4 } }];

let admin: any;

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

beforeAll(async () => {
	const login = `host-admin-${Date.now()}`;
	const r = await db.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'admin') RETURNING id`).bind(login).first<{ id: number }>();
	admin = sessionUser({ id: r!.id, github_login: login, role: 'admin' });
});

// A write that sets the base URL (only the provider form does this in the app; every other save keeps it).
async function saveBaseUrl(baseUrl: string) {
	await saveAssistantConfig(db, { ...normalizeConfig({}), openai: { baseUrl, label: '', models: MODELS } }, { setBaseUrl: true });
}

const envWith = (over: Record<string, unknown> = {}) => ({ MAIL_TOKEN_KEY: MAIL_KEY, ...over });

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER),
		db.prepare(`DELETE FROM app_state WHERE key IN (?, 'ai_assistant_config', 'ai_resend_subject')`).bind(OPENAI_KEY_HOST_STATE)
	]);
	clearOpenAiKeyCache(db);
	resetAiSubjectRateLimit();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function pageEvent(action: string, form: Record<string, string> = {}, envOver: Record<string, unknown> = {}) {
	const url = new URL(`https://app.test/settings/assistant?/${action}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		url,
		params: {},
		request: new Request(url, { method: 'POST', body: fd }),
		locals: { user: admin, authed: true },
		platform: { env: { ...(env as any), MAIL_TOKEN_KEY: MAIL_KEY, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ...envOver } }
	} as any;
}

describe('base URL rules (#748)', () => {
	it('refuses plain http except for a local server', () => {
		expect(baseUrlProblem('http://llm.example.net/v1')).not.toBe('');
		expect(baseUrlProblem('http://10.0.0.5:8080/v1')).not.toBe('');
		expect(baseUrlProblem('http://localhost:11434/v1')).toBe('');
		expect(baseUrlProblem('http://127.0.0.1:8000/v1')).toBe('');
		expect(baseUrlProblem('http://[::1]:8000/v1')).toBe('');
		expect(baseUrlProblem('https://llm.example.net/v1')).toBe('');
	});

	it('refuses credentials in the URL, in either scheme', () => {
		expect(baseUrlProblem('https://user:pw@llm.example.net/v1')).not.toBe('');
		expect(baseUrlProblem('https://user@llm.example.net/v1')).not.toBe('');
		expect(baseUrlProblem('http://user:pw@localhost:8000/v1')).not.toBe('');
	});

	it('normalises hosts before comparing', () => {
		expect(baseUrlHost('')).toBe('api.openai.com');
		expect(baseUrlHost('https://LLM-A.Example.NET/v1/')).toBe('llm-a.example.net');
		expect(baseUrlHost('https://llm-a.example.net:443/v1')).toBe('llm-a.example.net');
		expect(baseUrlHost('https://llm-a.example.net:8443/v1')).toBe('llm-a.example.net:8443');
		expect(baseUrlHost('http://llm-a.example.net/v1')).toBeNull();
		expect(cleanHostSetting('LLM-A.example.net')).toBe('llm-a.example.net');
		expect(cleanHostSetting('https://llm-a.example.net/v1')).toBe('llm-a.example.net');
		expect(cleanHostSetting('')).toBe('');
	});

	it('the provider form refuses an http base URL and stores nothing', async () => {
		const res: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: 'http://llm.example.net/v1', models: '' }));
		expect(res.status).toBe(400);
		expect(res.data.providerError).toMatch(/https/);
		expect(await db.prepare(`SELECT 1 FROM app_state WHERE key = 'ai_assistant_config'`).first()).toBeNull();
	});
});

describe('the in-app key follows the host (#748)', () => {
	it('is sent to the host it was saved for, and not after the host changes', async () => {
		await saveBaseUrl(HOST_A);
		const saved = await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect(saved.host).toBe('llm-a.example.net');
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);
		expect(await resolveOpenAiKey(db, envWith(), HOST_A)).toBe(APP_KEY);
		expect(await resolveOpenAiKey(db, envWith(), HOST_B)).toBe('');

		// Changed some other way than the provider form: the stored key is still not sent.
		await saveBaseUrl(HOST_B);
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
		const info = await openAiKeyInfo(db, envWith());
		expect(info).toMatchObject({ source: null, hostMismatch: true, host: 'llm-b.example.net' });
	});

	it('the provider form removes the key when the host changes, and Test key says why', async () => {
		await saveBaseUrl(HOST_A);
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const same: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: HOST_A, models: 'big-model | Big | tools | 1 | 4' }));
		expect(same).toMatchObject({ providerSaved: true, providerKeyCleared: false });
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);

		const moved: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: HOST_B, models: 'big-model | Big | tools | 1 | 4' }));
		expect(moved).toMatchObject({ providerSaved: true, providerKeyCleared: true });
		expect(await db.prepare('SELECT 1 FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER).first()).toBeNull();
		expect(await resolveOpenAiKey(db, envWith())).toBe('');

		const test: any = await actions.testProviderKey(pageEvent('testProviderKey'));
		expect(test.status).toBe(400);
		expect(test.data.providerKeyError).toContain('llm-b.example.net');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('Test key reports a key saved for another address and sends nothing', async () => {
		await saveBaseUrl(HOST_A);
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		await saveBaseUrl(HOST_B);
		clearOpenAiKeyCache(db);
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const test: any = await actions.testProviderKey(pageEvent('testProviderKey'));
		expect(test.status).toBe(400);
		expect(test.data.providerKeyError).toMatch(/different address/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('a key saved before #748 keeps working for the saved https host, and is bound to it', async () => {
		await saveBaseUrl(HOST_A);
		await storeSecret(db, MAIL_KEY, OPENAI_SECRET_PROVIDER, APP_KEY, admin.id);
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(OPENAI_KEY_HOST_STATE).first<{ value: string }>();
		expect(row?.value).toBe('llm-a.example.net');
		await saveBaseUrl(HOST_B);
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
	});

	it('a key saved before #748 with a plain-http base URL is not sent', async () => {
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('ai_assistant_config', ?)`)
			.bind(JSON.stringify({ openai: { baseUrl: 'http://llm-a.example.net/v1', label: '', models: MODELS } }))
			.run();
		await storeSecret(db, MAIL_KEY, OPENAI_SECRET_PROVIDER, APP_KEY, admin.id);
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
		expect(await resolveOpenAiKey(db, envWith(), 'http://llm-a.example.net/v1')).toBe('');
	});
});

describe('the OPENAI_API_KEY Worker secret goes to one host (#748)', () => {
	const cfgFor = (baseUrl: string) => normalizeConfig({ openai: { baseUrl, label: '', models: MODELS } });

	async function call(baseUrl: string, envOver: Record<string, unknown>) {
		const seen: { url: string; auth: string | null }[] = [];
		const fetchMock = (async (url: string, init?: RequestInit) => {
			seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
			return new Response('{}', { status: 500 });
		}) as unknown as typeof fetch;
		const p = await providerFor(null, envOver, cfgFor(baseUrl), { provider: 'openai' }, fetchMock);
		for await (const _ of p.stream({ model: 'openai:big-model', effort: null, system: '', messages: [], tools: [] })) {
			/* drain */
		}
		return seen;
	}

	it('is not sent to a host the operator did not pin', async () => {
		expect(await resolveOpenAiKey(null, { OPENAI_API_KEY: WORKER_KEY }, HOST_A)).toBe('');
		expect(await call(HOST_A, { OPENAI_API_KEY: WORKER_KEY })).toEqual([]);
		expect(await call(HOST_A, { OPENAI_API_KEY: WORKER_KEY, OPENAI_BASE_URL_HOST: 'llm-b.example.net' })).toEqual([]);
	});

	it('is sent to api.openai.com by default and to the pinned host', async () => {
		expect(pinnedOpenAiHost({})).toBe('api.openai.com');
		expect(await resolveOpenAiKey(null, { OPENAI_API_KEY: WORKER_KEY }, '')).toBe(WORKER_KEY);
		const pinned = await call(HOST_A, { OPENAI_API_KEY: WORKER_KEY, OPENAI_BASE_URL_HOST: 'LLM-A.example.net' });
		expect(pinned).toEqual([{ url: 'https://llm-a.example.net/v1/chat/completions', auth: `Bearer ${WORKER_KEY}` }]);
	});

	it('the in-app key for the host wins over the secret', async () => {
		await saveBaseUrl(HOST_A);
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect(await resolveOpenAiKey(db, envWith({ OPENAI_API_KEY: WORKER_KEY, OPENAI_BASE_URL_HOST: 'llm-a.example.net' }))).toBe(APP_KEY);
	});
});

describe('the Anthropic key only goes to Anthropic (#748)', () => {
	it('is never the OpenAI-compatible key, and an Anthropic model calls Anthropic', async () => {
		const only = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
		expect(await resolveProviderKey(null, only, 'openai', '')).toBe('');
		expect(await resolveProviderKey(null, only, 'openai', HOST_A)).toBe('');
		expect(await resolveProviderKey(null, only, 'anthropic')).toBe(ANTHROPIC_KEY);

		const seen: { url: string; headers: Headers }[] = [];
		const fetchMock = (async (url: string, init?: RequestInit) => {
			seen.push({ url, headers: new Headers(init?.headers) });
			return new Response('{}', { status: 500 });
		}) as unknown as typeof fetch;
		const cfg = normalizeConfig({ openai: { baseUrl: HOST_A, label: '', models: MODELS } });
		const req = { effort: null, system: '', messages: [], tools: [] };
		for await (const _ of (await providerFor(null, only, cfg, { provider: 'openai' }, fetchMock)).stream({ ...req, model: 'openai:big-model' })) {
			/* drain */
		}
		for await (const _ of (await providerFor(null, only, cfg, {}, fetchMock)).stream({ ...req, model: 'claude-sonnet-5-5' })) {
			/* drain */
		}
		// The OpenAI-compatible provider had no key, so it called nothing; only Anthropic was called.
		expect(seen.length).toBeGreaterThan(0);
		for (const s of seen) expect(new URL(s.url).host).toBe('api.anthropic.com');
	});
});

describe('resend subject suggestions: spend caps and cost (#748)', () => {
	const subjEnv = { ...(env as any), ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: '', MAIL_TOKEN_KEY: MAIL_KEY };

	function suggestEvent(subject: string) {
		return {
			locals: { user: admin },
			platform: { env: subjEnv },
			request: new Request('https://app.test/api/ai/resend-subject', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ subject })
			})
		} as any;
	}

	async function toggleOn() {
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('ai_resend_subject', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
	}

	beforeEach(async () => {
		await db.prepare('DELETE FROM ai_threads WHERE user_id = ?').bind(admin.id).run();
	});

	/** Everything the last suggestion wrote: its thread title, message texts and ai_actions text columns. */
	async function lastRecord() {
		const thread = await db.prepare('SELECT id, title FROM ai_threads WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(admin.id).first<{ id: number; title: string }>();
		const rows = (await db.prepare('SELECT content FROM ai_messages WHERE thread_id = ? ORDER BY id').bind(thread!.id).all<{ content: string }>()).results;
		const action = await db
			.prepare('SELECT input, before, after, error FROM ai_actions WHERE thread_id = ?')
			.bind(thread!.id)
			.first<{ input: string | null; before: string | null; after: string | null; error: string | null }>();
		const texts = rows.map((r) => JSON.parse(r.content)[0].text as string);
		const stored = [thread!.title, ...rows.map((r) => r.content), action!.input, action!.before, action!.after, action!.error].map((v) => v ?? '').join('\n');
		return { thread: thread!, texts, stored };
	}

	it('is refused at the daily cap without calling the model', async () => {
		await toggleOn();
		await saveAssistantConfig(db, { ...normalizeConfig({}), dailyUserCapUsd: 1 });
		const t = await db.prepare(`INSERT INTO ai_threads (user_id, model, title) VALUES (?, 'claude-haiku-5-5', 'x') RETURNING id`).bind(admin.id).first<{ id: number }>();
		await db.prepare(`INSERT INTO ai_messages (thread_id, role, content, cost_micros) VALUES (?, 'assistant', '[]', 1500000)`).bind(t!.id).run();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await suggestPost(suggestEvent('Hello'));
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ reason: 'cap' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('records the cost of each answered call, counted toward the caps and hidden from the panel', async () => {
		await toggleOn();
		const before = await spentMicros(db, utcDayStart(new Date()), admin.id);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello again' }], usage: { input_tokens: 1000, output_tokens: 200 } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		const res = await suggestPost(suggestEvent('Spring sale preview'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ subject: 'Hello again' });

		const after = await spentMicros(db, utcDayStart(new Date()), admin.id);
		expect(after).toBeGreaterThan(before);
		const action = await db
			.prepare('SELECT tool, status, after FROM ai_actions WHERE user_id = ? AND tool = ? ORDER BY id DESC LIMIT 1')
			.bind(admin.id, AI_SUBJECT_TOOL)
			.first<{ tool: string; status: string; after: string }>();
		expect(action).toMatchObject({ tool: 'resend_subject', status: 'applied' });
		expect(JSON.parse(action!.after).state.cost_micros).toBe(after - before);
		expect((await listThreads(db, admin.id)).length).toBe(0);
		// Usage only: neither the typed subject nor the suggestion is stored anywhere.
		const rec = await lastRecord();
		expect(rec.texts).toEqual([AI_SUBJECT_REQUEST_TEXT, AI_SUBJECT_RETURNED_TEXT]);
		expect(rec.stored).not.toContain('Spring sale preview');
		expect(rec.stored).not.toContain('Hello again');
	});

	it('records the cost even when the reply is unusable', async () => {
		await toggleOn();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ content: [{ type: 'text', text: 'Dropped the tag' }], usage: { input_tokens: 500, output_tokens: 50 } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		const res = await suggestPost(suggestEvent('Hello {{first_name}}'));
		expect(res.status).toBe(502);
		expect(await spentMicros(db, utcDayStart(new Date()), admin.id)).toBeGreaterThan(0);
		const rec = await lastRecord();
		expect(rec.texts).toEqual([AI_SUBJECT_REQUEST_TEXT, AI_SUBJECT_NONE_TEXT]);
		expect(rec.stored).not.toContain('Hello');
		expect(rec.stored).not.toContain('Dropped the tag');
	});

	it('checks the spend cap before a rate-limit slot is used', async () => {
		await toggleOn();
		await saveAssistantConfig(db, { ...normalizeConfig({}), dailyUserCapUsd: 1 });
		const t = await db.prepare(`INSERT INTO ai_threads (user_id, model, title) VALUES (?, 'claude-haiku-5-5', 'x') RETURNING id`).bind(admin.id).first<{ id: number }>();
		await db.prepare(`INSERT INTO ai_messages (thread_id, role, content, cost_micros) VALUES (?, 'assistant', '[]', 1500000)`).bind(t!.id).run();
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello again' }], usage: { input_tokens: 10, output_tokens: 2 } }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		for (let i = 0; i <= AI_SUBJECT_RATE_LIMIT; i++) {
			const res = await suggestPost(suggestEvent('Hello'));
			expect(res.status).toBe(429);
			expect(await res.json()).toMatchObject({ reason: 'cap' });
		}
		expect(fetchMock).not.toHaveBeenCalled();
		// Under the cap again: no slot was used by the refused calls, so this one goes through.
		await db.prepare('DELETE FROM ai_threads WHERE user_id = ?').bind(admin.id).run();
		const ok = await suggestPost(suggestEvent('Hello'));
		expect(ok.status).toBe(200);
	});

	it('records the cost of a suggestion made through the OpenAI-compatible provider', async () => {
		await toggleOn();
		const base = normalizeConfig({});
		await saveAssistantConfig(db, {
			...base,
			openai: { baseUrl: HOST_A, label: '', models: MODELS },
			allowedModels: [...base.allowedModels, 'openai:big-model'],
			featureModels: { resendSubject: 'openai:big-model' }
		}, { setBaseUrl: true });
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		const seen: { url: string; auth: string | null; redirect: string | undefined }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				seen.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
				const chunks = [
					{ choices: [{ delta: { content: 'Hello again' }, finish_reason: 'stop' }] },
					{ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } }
				];
				const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
				return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
			})
		);
		const before = await spentMicros(db, utcDayStart(new Date()), admin.id);
		const res = await suggestPost(suggestEvent('Spring sale preview'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ subject: 'Hello again' });
		expect(seen).toEqual([{ url: 'https://llm-a.example.net/v1/chat/completions', auth: `Bearer ${APP_KEY}`, redirect: 'manual' }]);
		const after = await spentMicros(db, utcDayStart(new Date()), admin.id);
		expect(after).toBeGreaterThan(before);
		const action = await db
			.prepare('SELECT after FROM ai_actions WHERE user_id = ? AND tool = ? ORDER BY id DESC LIMIT 1')
			.bind(admin.id, AI_SUBJECT_TOOL)
			.first<{ after: string }>();
		expect(JSON.parse(action!.after).state).toMatchObject({ model: 'openai:big-model', cost_micros: after - before });
		// What is stored: usage only (model, tokens, cost), a fixed thread title and fixed placeholder
		// messages. Neither the typed subject nor the suggestion is written anywhere.
		const rec = await lastRecord();
		expect(rec.thread.title).toBe(AI_SUBJECT_THREAD_TITLE);
		expect(rec.texts).toEqual([AI_SUBJECT_REQUEST_TEXT, AI_SUBJECT_RETURNED_TEXT]);
		expect(rec.stored).not.toContain('Spring sale preview');
		expect(rec.stored).not.toContain('Hello again');
	});

	it('says why there is no key when the secret is pinned to another host', async () => {
		await toggleOn();
		const base = normalizeConfig({});
		await saveAssistantConfig(db, {
			...base,
			openai: { baseUrl: HOST_A, label: '', models: MODELS },
			allowedModels: [...base.allowedModels, 'openai:big-model'],
			featureModels: { resendSubject: 'openai:big-model' }
		}, { setBaseUrl: true });
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await suggestPost({ ...suggestEvent('Hello'), platform: { env: { ...subjEnv, OPENAI_API_KEY: WORKER_KEY } } });
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string };
		const info = await openAiKeyInfo(db, envWith({ OPENAI_API_KEY: WORKER_KEY }));
		expect(body.error).toBe(openAiNoKeyMessage(info));
		expect(body.error).toContain('only sent to api.openai.com');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('a key saved before #748 is bound before the base URL changes', () => {
	const hostRow = () => db.prepare('SELECT value FROM app_state WHERE key = ?').bind(OPENAI_KEY_HOST_STATE).first<{ value: string }>();
	const secretExists = async () => !!(await db.prepare('SELECT 1 FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER).first());

	async function legacyKey() {
		await storeSecret(db, MAIL_KEY, OPENAI_SECRET_PROVIDER, APP_KEY, admin.id);
		clearOpenAiKeyCache(db);
	}

	async function sentTo(baseUrl: string, envOver: Record<string, unknown> = envWith()) {
		const seen: string[] = [];
		const fetchMock = (async (url: string) => {
			seen.push(url);
			return new Response('{}', { status: 500 });
		}) as unknown as typeof fetch;
		const cfg = normalizeConfig({ openai: { baseUrl, label: '', models: MODELS } });
		const p = await providerFor(db, envOver, cfg, { provider: 'openai' }, fetchMock);
		for await (const _ of p.stream({ model: 'openai:big-model', effort: null, system: '', messages: [], tools: [] })) {
			/* drain */
		}
		return seen;
	}

	it('a save that changes the host leaves no key and no host, and nothing is sent', async () => {
		await saveBaseUrl(HOST_A);
		await legacyKey(); // nothing has read it yet
		const res: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: HOST_B, models: 'big-model | Big | tools | 1 | 4' }));
		expect(res).toMatchObject({ providerSaved: true, providerKeyCleared: true });
		expect(await secretExists()).toBe(false);
		expect((await hostRow())?.value).toBe(''); // the removal leaves the empty marker, never a missing row
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
		expect(await sentTo(HOST_B)).toEqual([]);
		expect(await sentTo(HOST_A)).toEqual([]);
	});

	it('a save that keeps the host binds the key to it and keeps it', async () => {
		await saveBaseUrl(HOST_A);
		await legacyKey();
		const res: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: `${HOST_A}/`, models: 'big-model | Big | tools | 1 | 4' }));
		expect(res).toMatchObject({ providerSaved: true, providerKeyCleared: false });
		expect((await hostRow())?.value).toBe('llm-a.example.net');
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);
	});

	it('any other config save binds the key to the URL stored before it', async () => {
		await saveBaseUrl(HOST_A);
		await legacyKey();
		await saveBaseUrl(HOST_B); // a base URL change made by anything other than the provider form's own steps
		expect((await hostRow())?.value).toBe('llm-a.example.net');
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
	});

	describe('with a stored plain-http base URL', () => {
		const HTTP_URL = 'http://llm-a.example.net/v1';
		const storedRawUrl = async () => {
			const row = await db.prepare(`SELECT value FROM app_state WHERE key = 'ai_assistant_config'`).first<{ value: string }>();
			return JSON.parse(row!.value).openai?.baseUrl;
		};

		async function storeHttpUrl() {
			await db
				.prepare(`INSERT INTO app_state (key, value) VALUES ('ai_assistant_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
				.bind(JSON.stringify({ openai: { baseUrl: HTTP_URL, label: '', models: MODELS } }))
				.run();
		}

		it('the key is never sent anywhere and is not bound on read', async () => {
			await storeHttpUrl();
			await legacyKey();
			const withSecret = envWith({ OPENAI_API_KEY: WORKER_KEY });
			expect(await resolveOpenAiKey(db, withSecret)).toBe('');
			expect(await resolveOpenAiKey(db, withSecret, '')).toBe('');
			expect(await resolveOpenAiKey(db, withSecret, 'https://api.openai.com/v1')).toBe('');
			expect(await resolveOpenAiKey(db, withSecret, HTTP_URL)).toBe('');
			expect(await sentTo('', withSecret)).toEqual([]);
			expect(await hostRow()).toBeNull();
			const info = await openAiKeyInfo(db, withSecret);
			expect(info).toMatchObject({ host: null, baseUrlUnusable: true, source: null, hostMismatch: false });
			expect(await modelKeyProblem(db, withSecret, { provider: 'openai' })).toMatch(/isn't usable/);
		});

		it('a later config save (which reads the URL as blank) binds the key to nothing, not to api.openai.com', async () => {
			await storeHttpUrl();
			await legacyKey();
			await saveAssistantConfig(db, { ...normalizeConfig({}), monthlyCapUsd: 20 }); // e.g. the main form
			expect((await hostRow())?.value).toBe('');
			expect(await storedRawUrl()).toBe(HTTP_URL); // the save kept the stored address as it was
			expect(await resolveOpenAiKey(db, envWith())).toBe('');
			expect(await resolveOpenAiKey(db, envWith(), 'https://api.openai.com/v1')).toBe('');
		});

		it('saving a https URL removes the key: it must be entered again', async () => {
			await storeHttpUrl();
			await legacyKey();
			const res: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: 'https://llm-a.example.net/v1', models: '' }));
			expect(res).toMatchObject({ providerSaved: true, providerKeyCleared: true });
			expect(await secretExists()).toBe(false);
			expect(await resolveOpenAiKey(db, envWith())).toBe('');
		});

		it('the settings page shows the stored value and Test key says the URL is not usable', async () => {
			await storeHttpUrl();
			await legacyKey();
			const data: any = await load(pageEvent('load'));
			expect(data.openaiStoredBaseUrl).toMatchObject({ value: HTTP_URL, http: true });
			expect(data.openaiKey).toMatchObject({ baseUrlUnusable: true, hostMismatch: false });
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			const test: any = await actions.testProviderKey(pageEvent('testProviderKey'));
			expect(test.status).toBe(400);
			expect(test.data.providerKeyError).toMatch(/isn't usable/);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});

describe('the per-isolate key cache never answers for another host (#748)', () => {
	it('a cached key is not used for a different host', async () => {
		await saveBaseUrl(HOST_A);
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY); // now cached for llm-a
		// Another isolate removes the key and saves a new address; this isolate's cache is not cleared.
		await db.batch([
			db.prepare('DELETE FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER),
			db.prepare('DELETE FROM app_state WHERE key = ?').bind(OPENAI_KEY_HOST_STATE),
			db
				.prepare(`UPDATE app_state SET value = ? WHERE key = 'ai_assistant_config'`)
				.bind(JSON.stringify(normalizeConfig({ openai: { baseUrl: HOST_B, label: '', models: MODELS } })))
		]);
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
		expect(await resolveOpenAiKey(db, envWith(), HOST_B)).toBe('');
	});
});

describe('the key form must match the address the admin saw (#748)', () => {
	const KEY_FORM = { key: APP_KEY };

	it('refuses when the saved host changed, and stores nothing', async () => {
		await saveBaseUrl(HOST_B);
		const res: any = await actions.setProviderKey(pageEvent('setProviderKey', { ...KEY_FORM, base_host: 'llm-a.example.net' }));
		expect(res.status).toBe(409);
		expect(res.data.providerKeyError).toBe(OPENAI_HOST_CHANGED);
		expect(res.data.providerKeyError).toBe('The base URL changed. Reload and try again.');
		expect(await db.prepare('SELECT 1 FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER).first()).toBeNull();
	});

	it('refuses a form without the shown host with a plain reload message (not a host change)', async () => {
		await saveBaseUrl(HOST_A);
		const res: any = await actions.setProviderKey(pageEvent('setProviderKey', KEY_FORM));
		expect(res.status).toBe(400);
		expect(res.data.providerKeyError).toBe(OPENAI_KEY_FORM_STALE);
		expect(res.data.providerKeyError).toBe('Reload the page and try again.');
		const blank: any = await actions.setProviderKey(pageEvent('setProviderKey', { ...KEY_FORM, base_host: ' ' }));
		expect(blank.status).toBe(400);
		expect(blank.data.providerKeyError).toBe(OPENAI_KEY_FORM_STALE);
		expect(await db.prepare('SELECT 1 FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER).first()).toBeNull();
	});

	it('saves the key for the host shown', async () => {
		await saveBaseUrl(HOST_A);
		const res: any = await actions.setProviderKey(pageEvent('setProviderKey', { ...KEY_FORM, base_host: 'llm-a.example.net' }));
		expect(res).toMatchObject({ providerKeySaved: APP_KEY.slice(-4) });
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);
	});

	it('the page posts the host it shows', async () => {
		await saveBaseUrl(HOST_A);
		const data: any = await load(pageEvent('load'));
		expect(data.openaiKey.host).toBe('llm-a.example.net');
		expect(data.openaiStoredBaseUrl).toBeNull();
	});
});

describe('honest messages when the Worker secret is pinned elsewhere (#748)', () => {
	it('modelKeyProblem gives the Test key message', async () => {
		await saveBaseUrl(HOST_A);
		const e = envWith({ OPENAI_API_KEY: WORKER_KEY });
		const problem = await modelKeyProblem(db, e, { provider: 'openai' });
		expect(problem).toBe(openAiNoKeyMessage(await openAiKeyInfo(db, e)));
		expect(problem).toContain('only sent to api.openai.com');
		expect(problem).not.toMatch(/set the OPENAI_API_KEY secret/);
		expect(await modelKeyProblem(db, envWith({ OPENAI_API_KEY: WORKER_KEY, OPENAI_BASE_URL_HOST: 'llm-a.example.net' }), { provider: 'openai' })).toBe('');
	});
});

describe('redirects are not followed (#748)', () => {
	const redirect = () => vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example.net/v1/chat/completions' } }));

	it('chat: redirect manual, a 3xx is an error and no second request is made', async () => {
		const fetchMock = redirect();
		const events: any[] = [];
		const p = openAiCompatProvider({ apiKey: APP_KEY, baseUrl: HOST_A }, fetchMock as unknown as typeof fetch);
		for await (const e of p.stream({ model: 'big-model', effort: null, system: '', messages: [], tools: [] })) events.push(e);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
		expect(events.at(-1)).toMatchObject({ type: 'error', status: 302 });
	});

	it('Test key: redirect manual, a 3xx is an error and no second request is made', async () => {
		const fetchMock = redirect();
		const result = await testOpenAiKey(APP_KEY, HOST_A, fetchMock as unknown as typeof fetch);
		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain('302');
		expect((result as { error: string }).error).not.toContain(APP_KEY);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
	});
});

describe('URL forms (#748)', () => {
	const secretOnly = { OPENAI_API_KEY: WORKER_KEY };

	it('refuses userinfo that looks like another host', async () => {
		const url = 'https://api.openai.com@other.example.net/v1';
		expect(baseUrlProblem(url)).not.toBe('');
		expect(baseUrlHost(url)).toBeNull();
		expect(await resolveOpenAiKey(null, secretOnly, url)).toBe('');
	});

	it('a backslash form resolves to the host the URL parser gives, and the key is not sent to it', async () => {
		const url = 'https://other.example.net\\@api.openai.com/v1';
		expect(baseUrlHost(url)).toBe(new URL(url).host);
		expect(baseUrlHost(url)).toBe('other.example.net');
		expect(await resolveOpenAiKey(null, secretOnly, url)).toBe('');
	});

	it('a trailing dot is a different host', async () => {
		expect(baseUrlHost('https://api.openai.com./v1')).toBe('api.openai.com.');
		expect(await resolveOpenAiKey(null, secretOnly, 'https://api.openai.com./v1')).toBe('');
		expect(await resolveOpenAiKey(null, secretOnly, 'https://api.openai.com/v1')).toBe(WORKER_KEY);
	});

	it('a non-default port must match exactly', async () => {
		const pinned = { ...secretOnly, OPENAI_BASE_URL_HOST: 'llm-a.example.net:8443' };
		expect(await resolveOpenAiKey(null, pinned, 'https://llm-a.example.net:8443/v1')).toBe(WORKER_KEY);
		expect(await resolveOpenAiKey(null, pinned, 'https://llm-a.example.net/v1')).toBe('');
		expect(await resolveOpenAiKey(null, pinned, 'https://llm-a.example.net:9443/v1')).toBe('');
		expect(await resolveOpenAiKey(null, secretOnly, 'https://api.openai.com:8443/v1')).toBe('');
	});

	it('cleanHostSetting keeps host:port and refuses userinfo', () => {
		expect(cleanHostSetting('llm-a.example.net:8443')).toBe('llm-a.example.net:8443');
		expect(cleanHostSetting('LLM-A.example.net:443')).toBe('llm-a.example.net');
		expect(cleanHostSetting('https://llm-a.example.net:8443/v1')).toBe('llm-a.example.net:8443');
		expect(cleanHostSetting('user@llm-a.example.net')).toBe('');
		expect(cleanHostSetting('https://user:pw@llm-a.example.net')).toBe('');
		expect(pinnedOpenAiHost({ OPENAI_BASE_URL_HOST: 'user@llm-a.example.net' })).toBe('api.openai.com');
	});

	it('the binding is the host and port, not the scheme (loopback only)', async () => {
		await saveBaseUrl('https://localhost:8443/v1');
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect(await resolveOpenAiKey(db, envWith(), 'http://localhost:8443/v1')).toBe(APP_KEY);
		expect(await resolveOpenAiKey(db, envWith(), 'http://localhost:8000/v1')).toBe('');
		expect(await resolveOpenAiKey(db, envWith(), 'http://localhost/v1')).toBe('');
		// A non-loopback host can't use http at all, so the scheme never moves a key off https there.
		expect(baseUrlHost('http://llm-a.example.net:8443/v1')).toBeNull();
	});
});

describe('a removed key leaves the empty host marker, never a missing row (#748)', () => {
	const hostRow = () => db.prepare('SELECT value FROM app_state WHERE key = ?').bind(OPENAI_KEY_HOST_STATE).first<{ value: string }>();
	const writeHost = (host: string) =>
		db
			.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(OPENAI_KEY_HOST_STATE, host)
			.run();

	it('a remove in the middle of a key save cannot bind the new key to another address', async () => {
		await saveBaseUrl(HOST_A);
		// setOpenAiKey, step 1: the marker.
		await writeHost('');
		// Another request removes the key meanwhile.
		expect(await removeOpenAiKey(db)).toBe(false);
		expect((await hostRow())?.value).toBe('');
		// setOpenAiKey, step 2: the new key is stored; the marker is still ''.
		await storeSecret(db, MAIL_KEY, OPENAI_SECRET_PROVIDER, APP_KEY, admin.id);
		expect((await hostRow())?.value).toBe('');
		// The config is saved with a different host before the final host write.
		await saveBaseUrl(HOST_B);
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
		expect(await resolveOpenAiKey(db, envWith(), HOST_B)).toBe('');
		expect((await hostRow())?.value).toBe(''); // not bound to llm-b by the read or the save
		// setOpenAiKey, step 3: the host it was saved for.
		await writeHost('llm-a.example.net');
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, envWith(), HOST_A)).toBe(APP_KEY);
		expect(await resolveOpenAiKey(db, envWith(), HOST_B)).toBe('');
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
	});

	it('removing a key deletes it, writes the marker and audits the removal', async () => {
		await saveBaseUrl(HOST_A);
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect((await hostRow())?.value).toBe('llm-a.example.net');
		expect(await removeOpenAiKey(db)).toBe(true);
		expect(await db.prepare('SELECT 1 FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER).first()).toBeNull();
		expect((await hostRow())?.value).toBe('');
		const audit = await db
			.prepare(`SELECT detail FROM integration_syncs WHERE provider = ? AND trigger = 'token' ORDER BY id DESC LIMIT 1`)
			.bind(OPENAI_SECRET_PROVIDER)
			.first<{ detail: string }>();
		expect(JSON.parse(audit!.detail)).toEqual({ action: 'removed', last4: APP_KEY.slice(-4) });
		expect(await resolveOpenAiKey(db, envWith(), HOST_A)).toBe('');
		// Nothing to remove: still false, and the marker stays.
		expect(await removeOpenAiKey(db)).toBe(false);
		expect((await hostRow())?.value).toBe('');
	});

	it('saving a key after a removal binds it to the saved host', async () => {
		await saveBaseUrl(HOST_A);
		await removeOpenAiKey(db);
		const saved = await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect(saved).toEqual({ last4: APP_KEY.slice(-4), host: 'llm-a.example.net' });
		expect((await hostRow())?.value).toBe('llm-a.example.net');
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);
	});
});

describe('the key cache is keyed by the host asked for (#748)', () => {
	function counting() {
		const n = { batch: 0, prepare: 0 };
		const proxy = new Proxy(db, {
			get(target, prop) {
				if (prop === 'batch') {
					return (stmts: D1PreparedStatement[]) => {
						n.batch++;
						return target.batch(stmts);
					};
				}
				if (prop === 'prepare') {
					return (sql: string) => {
						n.prepare++;
						return target.prepare(sql);
					};
				}
				const v = Reflect.get(target, prop);
				return typeof v === 'function' ? v.bind(target) : v;
			}
		}) as D1Database;
		return { proxy, n };
	}

	it('two resolves for the same host read the key once; another host does not reuse the entry', async () => {
		await saveBaseUrl(HOST_A);
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		const { proxy, n } = counting();
		expect(await resolveOpenAiKey(proxy, envWith())).toBe(APP_KEY);
		expect(await resolveOpenAiKey(proxy, envWith())).toBe(APP_KEY);
		expect(n.batch).toBe(1);
		expect(await resolveOpenAiKey(proxy, envWith(), HOST_B)).toBe('');
		expect(n.batch).toBe(2);
		expect(await resolveOpenAiKey(proxy, envWith(), HOST_B)).toBe('');
		expect(n.batch).toBe(2); // the negative answer for llm-b is cached too
		expect(await resolveOpenAiKey(proxy, envWith(), HOST_A)).toBe(APP_KEY);
		expect(n.batch).toBe(3); // the entry now answers for llm-b, not llm-a
	});

	it('a default install (no in-app key) is not read on every call', async () => {
		const { proxy, n } = counting();
		expect(await resolveOpenAiKey(proxy, envWith())).toBe('');
		expect(await resolveOpenAiKey(proxy, envWith())).toBe('');
		expect(n.batch).toBe(1);
	});

	it('set, remove and a provider save clear the cache in this isolate', async () => {
		await saveBaseUrl(HOST_A);
		expect(await resolveOpenAiKey(db, envWith())).toBe(''); // cached: no key for llm-a
		await setOpenAiKey(db, envWith(), APP_KEY, admin.id);
		expect(await resolveOpenAiKey(db, envWith())).toBe(APP_KEY);
		await removeOpenAiKey(db);
		expect(await resolveOpenAiKey(db, envWith())).toBe('');
	});
});

describe('stored credentials in a base URL are never shown (#748)', () => {
	async function storeUrl(baseUrl: string) {
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('ai_assistant_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(JSON.stringify({ openai: { baseUrl, label: '', models: MODELS } }))
			.run();
	}

	it('maskUrlCredentials replaces the user name and password', () => {
		expect(maskUrlCredentials('https://ops:pw-748@llm-a.example.net/v1')).toBe('https://***@llm-a.example.net/v1'); // gitleaks:allow
		expect(maskUrlCredentials('http://ops@private.example/v1')).toBe('http://***@private.example/v1');
		expect(maskUrlCredentials('https://a@b@llm-a.example.net/v1')).toBe('https://***@llm-a.example.net/v1');
		expect(maskUrlCredentials('ops:pw-748@llm-a.example.net/v1')).toBe('***@llm-a.example.net/v1'); // gitleaks:allow
		expect(maskUrlCredentials('https://llm-a.example.net/v1/a@b')).toBe('https://llm-a.example.net/v1/a@b');
		expect(maskUrlCredentials('http://private.example/v1')).toBe('http://private.example/v1');
	});

	it('the settings page masks them in the text and the prefilled field', async () => {
		await storeUrl('https://ops:pw-748@llm-a.example.net/v1'); // gitleaks:allow
		const data: any = await load(pageEvent('load'));
		expect(data.openaiStoredBaseUrl).toMatchObject({ value: 'https://***@llm-a.example.net/v1', http: false });
		expect(JSON.stringify(data)).not.toContain('pw-748');
		expect(JSON.stringify(data)).not.toContain('ops:');

		await storeUrl('http://ops:pw-748@private.example/v1'); // gitleaks:allow
		const http: any = await load(pageEvent('load'));
		expect(http.openaiStoredBaseUrl).toMatchObject({ value: 'http://***@private.example/v1', http: true });
		expect(JSON.stringify(http)).not.toContain('pw-748');
	});
});

describe('only the provider form changes the stored base URL (#748)', () => {
	const PRIVATE_URL = 'http://private.example/v1';
	const withSecret = () => envWith({ OPENAI_API_KEY: WORKER_KEY });
	const storedRawUrl = async () => {
		const row = await db.prepare(`SELECT value FROM app_state WHERE key = 'ai_assistant_config'`).first<{ value: string }>();
		return JSON.parse(row!.value).openai?.baseUrl;
	};

	beforeEach(async () => {
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('ai_assistant_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(JSON.stringify({ openai: { baseUrl: PRIVATE_URL, label: '', models: MODELS } }))
			.run();
	});

	async function stillUnusable() {
		expect(await storedRawUrl()).toBe(PRIVATE_URL);
		clearOpenAiKeyCache(db);
		expect(await resolveOpenAiKey(db, withSecret())).toBe('');
		expect(await resolveOpenAiKey(db, withSecret(), 'https://api.openai.com/v1')).toBe('');
		const data: any = await load(pageEvent('load'));
		expect(data.openaiStoredBaseUrl).toMatchObject({ value: PRIVATE_URL, http: true });
	}

	it('saving Permissions keeps it', async () => {
		const res: any = await actions.setPermissions(pageEvent('setPermissions', { allow_delete: 'on', allow_code: 'admins', draft_reply_field: '1', editor_ask_field: '1' }));
		expect(res).toMatchObject({ permissionsSaved: true, permissionsChanged: true });
		await stillUnusable();
	});

	it('saving the main settings form keeps it', async () => {
		const res: any = await actions.save(
			pageEvent('save', {
				access: 'everyone',
				allowed: 'claude-sonnet-5-5',
				default_model: 'claude-sonnet-5-5',
				default_effort: 'medium',
				monthly_cap: '40',
				daily_cap: '4',
				retention_days: '60'
			})
		);
		expect(res).toMatchObject({ saved: true });
		const row = await db.prepare(`SELECT value FROM app_state WHERE key = 'ai_assistant_config'`).first<{ value: string }>();
		expect(JSON.parse(row!.value)).toMatchObject({ monthlyCapUsd: 40, retentionDays: 60 }); // the rest was saved
		await stillUnusable();
	});

	it('a direct save without setBaseUrl keeps it, and the provider form can still change it', async () => {
		await saveAssistantConfig(db, { ...normalizeConfig({}), monthlyCapUsd: 20 });
		await stillUnusable();
		const res: any = await actions.saveProvider(pageEvent('saveProvider', { base_url: HOST_A, models: '' }));
		expect(res).toMatchObject({ providerSaved: true });
		expect(await storedRawUrl()).toBe(HOST_A);
	});
});

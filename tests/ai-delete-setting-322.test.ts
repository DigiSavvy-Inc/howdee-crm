import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAction, handleChat } from '../src/lib/server/ai/chat';
import {
	AI_CONFIG_KEY,
	ASSISTANT_DEFAULTS,
	DELETE_OFF_MESSAGE,
	getAssistantConfig,
	normalizeConfig,
	saveAssistantConfig,
	setAllowDelete
} from '../src/lib/server/ai/config';
import { TOOLS, chatTools, runTool } from '../src/lib/server/ai/tools';
import { createThread } from '../src/lib/server/ai/threads';
import { systemPrompt } from '../src/lib/server/ai/system';
import { recentActivity } from '../src/lib/server/activity';
import { modelInfo } from '../src/lib/ai-models';
import { SseBuffer } from '../src/lib/sse';
import { load, actions } from '../src/routes/settings/assistant/+page.server';

// #322 addendum (operator decision, 2026-10-17): "Allow the assistant to delete contacts" in Settings →
// Assistant → Permissions, default off. Off = delete_contacts is not in the request's tool
// list, the prompt says so, and a forced call or an Approve after it was turned off is
// refused. Changing it writes an activity row naming who changed it.

const db = (env as any).DB as D1Database;
const T = `ds${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;

type U = { id: number; github_login: string; role: 'admin' | 'member' };
let member: U;
let admin: U;
let seq = 0;

function sessionUser(u: U) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

async function contact(): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', `del-${T}-${++seq}@x.co`)).id;
}

async function exists(id: number): Promise<boolean> {
	return !!(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first());
}

// ---- a mocked Anthropic provider: scripted SSE responses, request bodies captured ----

function sse(events: Record<string, unknown>[]): string {
	return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
const toolSse = (id: string, name: string, input: unknown) =>
	sse([
		{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
		{ type: 'message_stop' }
	]);
const textSse = (text: string) =>
	sse([
		{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
		{ type: 'message_stop' }
	]);

function scriptedFetch(script: string[]) {
	const bodies: any[] = [];
	const f = (async (_u: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return new Response(script[Math.min(bodies.length - 1, script.length - 1)], { headers: { 'content-type': 'text/event-stream' } });
	}) as unknown as typeof fetch;
	return { f, bodies };
}

function routeEvent(path: string, opts: { user?: U; body?: unknown; params?: Record<string, string> } = {}) {
	const url = new URL(`https://app.test${path}`);
	return {
		url,
		params: opts.params ?? {},
		request: new Request(url, { method: 'POST', body: JSON.stringify(opts.body ?? {}), headers: { 'content-type': 'application/json' } }),
		locals: { user: opts.user ? sessionUser(opts.user) : null, authed: !!opts.user },
		platform: { env: { ...(env as any), ANTHROPIC_API_KEY: 'sk-test', PUBLIC_BASE_URL: 'https://app.test' } }
	} as any;
}

function pageEvent(action: string | null, opts: { user: U; form?: Record<string, string> }) {
	const url = new URL(`https://app.test/settings/assistant${action ? `?/${action}` : ''}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(opts.form ?? {})) fd.append(k, v);
	return {
		url,
		params: {},
		request: new Request(url, action ? { method: 'POST', body: fd } : undefined),
		locals: { user: sessionUser(opts.user), authed: true },
		platform: { env: { ...(env as any), ANTHROPIC_API_KEY: '' } }
	} as any;
}

async function readSse(res: Response): Promise<any[]> {
	return new SseBuffer().push((await res.text()) + '\n\n').map((m) => JSON.parse(m.data));
}

const toolNames = (body: any): string[] => body.tools.map((t: any) => t.name);
const lastToolResult = (body: any) => body.messages.at(-1).content.find((b: any) => b.type === 'tool_result');

async function chat(message: string, script: string[]) {
	const { f, bodies } = scriptedFetch(script);
	const events = await readSse(await handleChat(routeEvent('/api/assistant/chat', { user: member, body: { message } }), { fetch: f }));
	return { events, bodies };
}

async function setDelete(allow: boolean) {
	await setAllowDelete(db, allow, sessionUser(admin));
}

beforeAll(async () => {
	member = { id: (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-m`)).id, github_login: `${T}-m`, role: 'member' };
	admin = { id: (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'admin') RETURNING id`, `${T}-a`)).id, github_login: `${T}-a`, role: 'admin' };
});

beforeEach(async () => {
	await saveAssistantConfig(db, { ...ASSISTANT_DEFAULTS, access: 'everyone' }); // allowDelete off
});

describe('config: allowDelete', () => {
	it('defaults to off, and an old config without the key means off', async () => {
		expect(ASSISTANT_DEFAULTS.allowDelete).toBe(false);
		expect(normalizeConfig(null).allowDelete).toBe(false);
		expect(normalizeConfig({ access: 'everyone', monthlyCapUsd: 5 }).allowDelete).toBe(false);
		expect(normalizeConfig({ allowDelete: 'true' }).allowDelete).toBe(false); // only a real true
		expect(normalizeConfig({ allowDelete: true }).allowDelete).toBe(true);

		// A config row saved before the setting existed.
		const old = { access: 'everyone', allowedModels: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5', defaultEffort: 'medium', monthlyCapUsd: 50, dailyUserCapUsd: 10, retentionDays: 180 };
		await db.prepare(`UPDATE app_state SET value = ? WHERE key = ?`).bind(JSON.stringify(old), AI_CONFIG_KEY).run();
		const cfg = await getAssistantConfig(db);
		expect(cfg.access).toBe('everyone');
		expect(cfg.allowDelete).toBe(false);
	});

	it('the chat tool list leaves out delete_contacts while off, in registry order', () => {
		expect(chatTools({ allowDelete: true })).toBe(TOOLS);
		const off = chatTools({ allowDelete: false }).map((t) => t.name);
		expect(off).not.toContain('delete_contacts');
		expect(off).toEqual(TOOLS.map((t) => t.name).filter((n) => n !== 'delete_contacts'));
	});

	it('the system prompt says deleting is off (suggest Archive / Settings) unless it is on', () => {
		const base = { appName: 'App', timezone: 'UTC', today: '2026-10-17', userLogin: 'me' };
		const off = systemPrompt(base);
		expect(off).toMatch(/Deleting contacts is turned off for you \(Settings → Assistant → Permissions\)/);
		expect(off).toMatch(/offer to archive them instead/);
		expect(off).not.toMatch(/delete is permanent/);
		const on = systemPrompt({ ...base, allowDelete: true });
		expect(on).not.toMatch(/turned off/);
		expect(on).toMatch(/delete is permanent \(no Undo, at most 50 per call\)/);
	});
});

describe('when off', () => {
	it('delete_contacts is absent from the provider request and a forced call is refused', async () => {
		const id = await contact();
		const { events, bodies } = await chat('delete this contact', [toolSse('toolu_del_off', 'delete_contacts', { contact_id: id }), textSse('Deleting is off.')]);

		expect(toolNames(bodies[0])).not.toContain('delete_contacts');
		expect(toolNames(bodies[0])).toContain('archive_contacts');
		const system = JSON.stringify(bodies[0].system);
		expect(system).toContain('Deleting contacts is turned off for you');

		// The model called it anyway: an error tool result, no pending card, nothing stored.
		expect(events.find((e) => e.type === 'pending')).toBeUndefined();
		expect(events.find((e) => e.type === 'tool_done')).toMatchObject({ name: 'delete_contacts', ok: false, error: DELETE_OFF_MESSAGE });
		expect(lastToolResult(bodies[1])).toMatchObject({ tool_use_id: 'toolu_del_off', content: DELETE_OFF_MESSAGE, is_error: true });
		expect(await exists(id)).toBe(true);
		expect((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_actions WHERE thread_id = ?`, events[0].id)).n).toBe(0);
	});

	it('is refused at execution time even with the full registry (server-side, not just the list)', async () => {
		const id = await contact();
		const threadId = await createThread(db, member.id, sonnet.id, 'medium', 'test');
		const ctx = { db, user: sessionUser(member), baseUrl: 'https://app.test', now: new Date(), threadId };
		const r = await runTool(ctx, 'delete_contacts', { contact_id: id }, TOOLS, 'tu_full');
		expect(r).toMatchObject({ ok: false, content: DELETE_OFF_MESSAGE });
		expect(r.pending).toBeUndefined();
		expect(await exists(id)).toBe(true);
	});
});

describe('when on', () => {
	it('delete_contacts is offered, waits for Approve, and Approve deletes', async () => {
		await setDelete(true);
		const id = await contact();
		const { f, bodies } = scriptedFetch([toolSse('toolu_del_on', 'delete_contacts', { contact_id: id }), textSse('Deleted.')]);
		const events = await readSse(await handleChat(routeEvent('/api/assistant/chat', { user: member, body: { message: 'delete it' } }), { fetch: f }));

		expect(toolNames(bodies[0])).toContain('delete_contacts');
		expect(JSON.stringify(bodies[0].system)).not.toContain('Deleting contacts is turned off');
		const pending = events.find((e) => e.type === 'pending');
		expect(pending.action).toMatchObject({ tool: 'delete_contacts', status: 'pending' });
		expect(await exists(id)).toBe(true);

		const actionId = pending.action.id;
		const resumed = await readSse(
			await handleAction(routeEvent(`/api/assistant/actions/${actionId}`, { user: member, body: { op: 'approve' }, params: { id: String(actionId) } }), { fetch: f })
		);
		expect(resumed.find((e) => e.type === 'action')).toMatchObject({ action: { id: actionId, status: 'approved', noUndo: true } });
		expect(await exists(id)).toBe(false);
		expect(lastToolResult(bodies[1])).toMatchObject({ tool_use_id: 'toolu_del_on' });
		expect(lastToolResult(bodies[1]).is_error).toBeUndefined();
	});

	it('turned off between the card and Approve: Approve is refused and the action fails', async () => {
		await setDelete(true);
		const id = await contact();
		const { f, bodies } = scriptedFetch([toolSse('toolu_del_race', 'delete_contacts', { contact_id: id }), textSse('It was turned off.')]);
		const events = await readSse(await handleChat(routeEvent('/api/assistant/chat', { user: member, body: { message: 'delete it' } }), { fetch: f }));
		const actionId = events.find((e) => e.type === 'pending').action.id;

		await setDelete(false);
		const resumed = await readSse(
			await handleAction(routeEvent(`/api/assistant/actions/${actionId}`, { user: member, body: { op: 'approve' }, params: { id: String(actionId) } }), { fetch: f })
		);
		expect(resumed.find((e) => e.type === 'action')).toMatchObject({ action: { id: actionId, status: 'failed', error: DELETE_OFF_MESSAGE } });
		expect(await one<any>('SELECT status, error FROM ai_actions WHERE id = ?', actionId)).toMatchObject({ status: 'failed', error: DELETE_OFF_MESSAGE });
		expect(await exists(id)).toBe(true);
		// The paused call is answered with the refusal, and the resumed request no longer offers the tool.
		expect(lastToolResult(bodies[1])).toMatchObject({ tool_use_id: 'toolu_del_race', content: DELETE_OFF_MESSAGE, is_error: true });
		expect(toolNames(bodies[1])).not.toContain('delete_contacts');
	});
});

describe('Settings → Assistant → Permissions', () => {
	it('non-admins can neither load the page nor change the setting', async () => {
		await expect(load(pageEvent(null, { user: member }))).rejects.toMatchObject({ status: 403 });
		const r: any = await actions.setPermissions(pageEvent('setPermissions', { user: member, form: { allow_delete: 'on' } }));
		expect(r.status).toBe(403);
		expect((await getAssistantConfig(db)).allowDelete).toBe(false);
	});

	it('an admin turns it on and off; each change writes an activity row naming who', async () => {
		const before = (await recentActivity(db, { types: ['assistant_setting'], limit: 500 })).length;

		const on: any = await actions.setPermissions(pageEvent('setPermissions', { user: admin, form: { allow_delete: 'on' } }));
		expect(on).toMatchObject({ permissionsSaved: true, permissionsChanged: true, config: { allowDelete: true, access: 'everyone' } });
		expect((await getAssistantConfig(db)).allowDelete).toBe(true);
		expect(((await load(pageEvent(null, { user: admin }))) as any).config.allowDelete).toBe(true);

		// Saving the same value again is not a change: no new row.
		const same: any = await actions.setPermissions(pageEvent('setPermissions', { user: admin, form: { allow_delete: 'on' } }));
		expect(same).toMatchObject({ permissionsChanged: false });

		// An unticked checkbox submits nothing → off.
		const off: any = await actions.setPermissions(pageEvent('setPermissions', { user: admin, form: {} }));
		expect(off).toMatchObject({ permissionsChanged: true, config: { allowDelete: false } });

		const feed = await recentActivity(db, { types: ['assistant_setting'], limit: 500 });
		expect(feed.length).toBe(before + 2);
		expect(feed[0]).toMatchObject({ type: 'assistant_setting', detail: 'off', actor_label: `@${admin.github_login}`, setting: 'allowDelete' });
		expect(feed[1]).toMatchObject({ type: 'assistant_setting', detail: 'on', actor_label: `@${admin.github_login}`, setting: 'allowDelete' });
		// It shows in the dashboard's default ("All") feed too.
		expect((await recentActivity(db, { limit: 500 })).some((a) => a.type === 'assistant_setting')).toBe(true);
	});

	it('the main Save keeps the Permissions setting as stored', async () => {
		await setDelete(true);
		const form = { access: 'everyone', allowed: 'claude-sonnet-5-5', default_model: 'claude-sonnet-5-5', default_effort: 'medium', monthly_cap: '50', daily_cap: '10', retention_days: '180' };
		const r: any = await actions.save(pageEvent('save', { user: admin, form }));
		expect(r).toMatchObject({ saved: true, config: { allowDelete: true } });
		expect((await getAssistantConfig(db)).allowDelete).toBe(true);
	});
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	AI_CONFIG_KEY,
	ASSISTANT_DEFAULTS,
	codeAllowedFor,
	getAssistantConfig,
	normalizeConfig,
	saveAssistantConfig,
	setAllowCode
} from '../src/lib/server/ai/config';
import { CODE_OFF_SECTION, CODE_ON_SECTION, systemPrompt } from '../src/lib/server/ai/system';
import { handleChat } from '../src/lib/server/ai/chat';
import { recentActivity } from '../src/lib/server/activity';
import { listSkills } from '../src/lib/server/ai/skills';
import { CODE_COLLAPSE_LINES, codeLanguage, renderAssistantMarkdown } from '../src/lib/assistant-markdown';
import { SseBuffer } from '../src/lib/sse';
import { actions } from '../src/routes/settings/assistant/+page.server';

// #327 (operator decision, 2026-10-17): Settings → Assistant → Permissions → "Code & snippets"
// (off / admins only / everyone with assistant access, default off). The prompt gets the code
// section only when the signed-in user qualifies; changes are logged to the activity feed;
// fenced code in the panel gets a language label + Copy button and stays escaped.

const db = (env as any).DB as D1Database;
const T = `code${Date.now()}`;

type U = { id: number; github_login: string; role: 'admin' | 'member' };
let member: U;
let admin: U;

function sessionUser(u: U) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

function pageEvent(action: string, opts: { user: U; form?: Record<string, string> }) {
	const url = new URL(`https://app.test/settings/assistant?/${action}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(opts.form ?? {})) fd.append(k, v);
	return {
		url,
		params: {},
		request: new Request(url, { method: 'POST', body: fd }),
		locals: { user: sessionUser(opts.user), authed: true },
		platform: { env: { ...(env as any), ANTHROPIC_API_KEY: '' } }
	} as any;
}

const textSse = (text: string) =>
	[
		{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
		{ type: 'message_stop' }
	]
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
		.join('');

/** The system prompt the chat sent to the provider for this user. */
async function chatSystem(u: U): Promise<string> {
	const bodies: any[] = [];
	const f = (async (_u: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return new Response(textSse('ok'), { headers: { 'content-type': 'text/event-stream' } });
	}) as unknown as typeof fetch;
	const url = new URL('https://app.test/api/assistant/chat');
	const event = {
		url,
		params: {},
		request: new Request(url, { method: 'POST', body: JSON.stringify({ message: 'write me a snippet' }), headers: { 'content-type': 'application/json' } }),
		locals: { user: sessionUser(u), authed: true },
		platform: { env: { ...(env as any), ANTHROPIC_API_KEY: 'sk-test', PUBLIC_BASE_URL: 'https://app.test' } }
	} as any;
	const res = await handleChat(event, { fetch: f });
	new SseBuffer().push((await res.text()) + '\n\n');
	return JSON.stringify(bodies[0].system);
}

beforeAll(async () => {
	member = { id: (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-m`)).id, github_login: `${T}-m`, role: 'member' };
	admin = { id: (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'admin') RETURNING id`, `${T}-a`)).id, github_login: `${T}-a`, role: 'admin' };
});

beforeEach(async () => {
	await saveAssistantConfig(db, { ...ASSISTANT_DEFAULTS, access: 'everyone' }); // allowCode off
});

describe('config: allowCode', () => {
	it('defaults to off, and old or junk values mean off', async () => {
		expect(ASSISTANT_DEFAULTS.allowCode).toBe('off');
		expect(normalizeConfig(null).allowCode).toBe('off');
		expect(normalizeConfig({ access: 'everyone' }).allowCode).toBe('off');
		expect(normalizeConfig({ allowCode: true }).allowCode).toBe('off');
		expect(normalizeConfig({ allowCode: 'all' }).allowCode).toBe('off');
		expect(normalizeConfig({ allowCode: 'admins' }).allowCode).toBe('admins');
		expect(normalizeConfig({ allowCode: 'everyone' }).allowCode).toBe('everyone');

		const old = { access: 'everyone', allowDelete: true, monthlyCapUsd: 50 };
		await db.prepare(`UPDATE app_state SET value = ? WHERE key = ?`).bind(JSON.stringify(old), AI_CONFIG_KEY).run();
		expect((await getAssistantConfig(db)).allowCode).toBe('off');
	});

	it('codeAllowedFor: admins under admins-only, anyone under everyone, nobody under off', () => {
		const a = { role: 'admin' };
		const m = { role: 'member' };
		expect(codeAllowedFor({ allowCode: 'off' }, a)).toBe(false);
		expect(codeAllowedFor({ allowCode: 'off' }, m)).toBe(false);
		expect(codeAllowedFor({ allowCode: 'admins' }, a)).toBe(true);
		expect(codeAllowedFor({ allowCode: 'admins' }, m)).toBe(false);
		expect(codeAllowedFor({ allowCode: 'everyone' }, a)).toBe(true);
		expect(codeAllowedFor({ allowCode: 'everyone' }, m)).toBe(true);
		expect(codeAllowedFor({ allowCode: 'everyone' }, null)).toBe(false);
	});
});

describe('system prompt', () => {
	const base = { appName: 'App', timezone: 'UTC', today: '2026-10-17', userLogin: 'me' };

	it('has the code section only when allowed, else the not-enabled note', () => {
		const off = systemPrompt(base);
		expect(off).toContain(CODE_OFF_SECTION);
		expect(off).not.toContain(CODE_ON_SECTION);
		expect(off).toMatch(/Settings → Assistant → Permissions/);
		const on = systemPrompt({ ...base, allowCode: true });
		expect(on).toContain(CODE_ON_SECTION);
		expect(on).not.toContain(CODE_OFF_SECTION);
		expect(on).toMatch(/YOUR_API_KEY/);
		expect(on).toMatch(/can't run code/);
		// The hard rules stay.
		expect(on).toMatch(/You cannot send email/);
	});

	it('the chat request follows the setting and the user role', async () => {
		const marker = 'Code & snippets (enabled for this user';
		const notOn = 'Code & snippets are not enabled for this user';

		// off: nobody
		expect(await chatSystem(admin)).toContain(notOn);
		expect(await chatSystem(member)).toContain(notOn);

		// admins only
		await setAllowCode(db, 'admins', sessionUser(admin));
		expect(await chatSystem(admin)).toContain(marker);
		const m = await chatSystem(member);
		expect(m).toContain(notOn);
		expect(m).not.toContain(marker);

		// everyone with access
		await setAllowCode(db, 'everyone', sessionUser(admin));
		expect(await chatSystem(member)).toContain(marker);
	});
});

describe('Settings → Assistant → Permissions', () => {
	it('a non-admin cannot change the setting', async () => {
		const res: any = await actions.setPermissions(pageEvent('setPermissions', { user: member, form: { allow_code: 'everyone' } }));
		expect(res.status).toBe(403);
		expect((await getAssistantConfig(db)).allowCode).toBe('off');
	});

	it('an admin saves it, refuses junk, and keeps allowDelete as posted', async () => {
		const bad: any = await actions.setPermissions(pageEvent('setPermissions', { user: admin, form: { allow_code: 'root' } }));
		expect(bad.status).toBe(400);
		const ok: any = await actions.setPermissions(pageEvent('setPermissions', { user: admin, form: { allow_code: 'admins' } }));
		expect(ok).toMatchObject({ permissionsSaved: true, permissionsChanged: true });
		const cfg = await getAssistantConfig(db);
		expect(cfg.allowCode).toBe('admins');
		expect(cfg.allowDelete).toBe(false);
	});

	it('the main save keeps the stored allowCode', async () => {
		await setAllowCode(db, 'everyone', sessionUser(admin));
		const res: any = await actions.save(
			pageEvent('save', {
				user: admin,
				form: { allowed: 'claude-sonnet-5-5', default_model: 'claude-sonnet-5-5', default_effort: 'medium', monthly_cap: '50', daily_cap: '10', retention_days: '180', access: 'everyone' }
			})
		);
		expect(res.saved).toBe(true);
		expect((await getAssistantConfig(db)).allowCode).toBe('everyone');
	});

	it('a change is logged once (activity feed), saving the same value writes nothing', async () => {
		const first = await setAllowCode(db, 'admins', sessionUser(admin));
		expect(first.changed).toBe(true);
		const again = await setAllowCode(db, 'admins', sessionUser(admin));
		expect(again.changed).toBe(false);

		const feed = await recentActivity(db, { limit: 50, types: ['assistant_setting'] });
		const mine = feed.filter((a) => a.actor_label === `@${admin.github_login}` && a.setting === 'allowCode');
		expect(mine.length).toBeGreaterThanOrEqual(1);
		expect(mine[0]).toMatchObject({ type: 'assistant_setting', detail: 'admins', setting: 'allowCode' });
		const raw = JSON.parse((await one<{ value: string }>(`SELECT value FROM app_state WHERE key = 'ai_setting_events'`)).value);
		expect(raw.filter((e: any) => e.setting === 'allowCode' && e.value === 'admins' && e.user_id === admin.id).length).toBe(
			mine.filter((a) => a.detail === 'admins').length
		);
	});
});

describe('panel: code blocks', () => {
	it('renders a language label and a Copy button on each fenced block', () => {
		const html = renderAssistantMarkdown('```html\n<table></table>\n```\n\n```\nplain\n```');
		expect(html.match(/data-code-copy/g)).toHaveLength(2);
		expect(html).toContain('<span class="md-code-lang">html</span>');
		expect(html).toContain('<span class="md-code-lang">code</span>');
		expect(html).toContain('<pre><code>&lt;table&gt;&lt;/table&gt;</code></pre>');
		expect(html).not.toContain('data-code-expand');
	});

	it('collapses a long block with Show all', () => {
		const lines = Array.from({ length: CODE_COLLAPSE_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
		const html = renderAssistantMarkdown('```js\n' + lines + '\n```');
		expect(html).toContain('md-code-long');
		expect(html).toContain(`data-code-expand>Show all ${CODE_COLLAPSE_LINES + 5} lines`);
	});

	it('keeps </code><script> in code escaped, and sanitises the language tag', () => {
		const html = renderAssistantMarkdown('```"><script>alert(1)</script>\n</code><script>alert(2)</script>\n```');
		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;/code&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
		expect(html.match(/<\/code>/g)).toHaveLength(1);
		expect(codeLanguage('"><img onerror=x>')).not.toMatch(/[<>"]/);
		expect(codeLanguage('TypeScript extra')).toBe('typescript');
	});
});

describe('starter skill', () => {
	it('seeds code-snippets as an on-demand skill', async () => {
		const s = (await listSkills(db)).find((r) => r.name === 'code-snippets');
		expect(s).toMatchObject({ mode: 'on_demand', enabled: 1 });
		expect(s!.body).toContain('YOUR_API_KEY');
		expect(s!.body).toContain('/t.js?k=');
	});
});

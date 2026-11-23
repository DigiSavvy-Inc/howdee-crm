import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #348: the MCP server at POST /mcp — initialize, per-scope tools/list, a tools/call
// round-trip that builds an automation draft, auth failures, a tool the scope doesn't
// allow (an error result, not a crash), the rate limit, and the structural rule that the
// server can't reach a send, the engine's enroll or an activation.
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { POST as mcpPOST, GET as mcpGET } from '../src/routes/mcp/+server';
import { MCP_RATE_PER_MINUTE, resetMcpRateLimits, takeMcpCall } from '../src/lib/server/mcp/server';
import { MCP_TOOLS, toolsForScope } from '../src/lib/server/mcp/tools';
import { EXAMPLE_SPEC } from '../src/lib/server/automations-api';
import type { AutomationSpec } from '../src/lib/automation-spec';
import { DEFAULT_APP_NAME } from '../src/lib/branding';

const db = (env as any).DB as D1Database;

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(token: string | undefined, body: unknown, method = 'POST') {
	const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL('https://app.test/mcp');
	return {
		request: new Request(url, { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }),
		platform: { env },
		url,
		params: {}
	} as any;
}

let nextId = 1;
async function rpc(token: string | undefined, method: string, params?: unknown) {
	const res = await mcpPOST(ev(token, { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }));
	return { status: res.status, body: res.status === 202 ? null : JSON.parse(await res.text()) };
}
const call = (token: string, name: string, args: Record<string, unknown> = {}) => rpc(token, 'tools/call', { name, arguments: args });
const names = (body: any) => (body.result.tools as { name: string }[]).map((t) => t.name).sort();

let LIST = 0;
let ro = '';
let rw = '';
let autoDraft = '';
let campDraft = '';

function spec(): AutomationSpec {
	return { ...structuredClone(EXAMPLE_SPEC), name: 'MCP flow', trigger: { type: 'list_added', list_id: LIST } };
}

beforeEach(async () => {
	resetMcpRateLimits();
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare("DELETE FROM app_state WHERE key IN ('approved_senders', 'default_from')")
	]);
	await db.prepare("INSERT INTO app_state (key, value) VALUES ('default_from', 'alan@ourco.example')").run();
	LIST = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	ro = await makeKey('read');
	rw = await makeKey('read_write');
	autoDraft = await makeKey('automations:draft');
	campDraft = await makeKey('campaigns:draft');
});

describe('protocol', () => {
	it('initialize echoes a supported protocol version and advertises tools', async () => {
		const { status, body } = await rpc(ro, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '0' }
		});
		expect(status).toBe(200);
		expect(body.result.protocolVersion).toBe('2025-06-18');
		expect(body.result.serverInfo.name).toBe('dscrm');
		// #596: title and instructions use Settings → Branding's app name.
		expect(body.result.serverInfo.title).toBe(DEFAULT_APP_NAME);
		expect(body.result.instructions.startsWith(`${DEFAULT_APP_NAME} (contacts`)).toBe(true);
		expect(body.result.capabilities.tools).toBeDefined();
		// An unknown version gets our latest.
		const old = await rpc(ro, 'initialize', { protocolVersion: '1999-01-01' });
		expect(old.body.result.protocolVersion).toBe('2025-06-18');
	});

	it('notifications get 202, ping answers, unknown methods are -32601, bad JSON is -32700', async () => {
		const n = await mcpPOST(ev(ro, { jsonrpc: '2.0', method: 'notifications/initialized' }));
		expect(n.status).toBe(202);
		expect((await rpc(ro, 'ping')).body.result).toEqual({});
		expect((await rpc(ro, 'resources/list')).body.error.code).toBe(-32601);
		const bad = await mcpPOST(ev(ro, '{not json'));
		expect(bad.status).toBe(400);
		expect(JSON.parse(await bad.text()).error.code).toBe(-32700);
		expect((await mcpGET(ev(ro, undefined, 'GET'))).status).toBe(405);
	});

	it('401 without a key or with a revoked one', async () => {
		const none = await mcpPOST(ev(undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
		expect(none.status).toBe(401);
		expect(none.headers.get('www-authenticate')).toMatch(/Bearer/);
		expect((await mcpPOST(ev('dk_live_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(401);
		await db.prepare("UPDATE api_keys SET revoked_at = datetime('now')").run();
		expect((await mcpPOST(ev(ro, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(401);
	});
});

describe('tools/list per scope', () => {
	const READ = MCP_TOOLS.filter((t) => t.group === 'read').map((t) => t.name).sort();
	const AUTO = MCP_TOOLS.filter((t) => t.group === 'automations:draft').map((t) => t.name);
	const CAMP = MCP_TOOLS.filter((t) => t.group === 'campaigns:draft').map((t) => t.name);

	it('read = read tools; each draft scope only its drafts (#538); read_write = all', async () => {
		expect(names((await rpc(ro, 'tools/list')).body)).toEqual(READ);
		// Draft keys get no CRM reads, like /api/v1; automation drafts keep the spec vocabulary (no data).
		expect(names((await rpc(autoDraft, 'tools/list')).body)).toEqual([...AUTO, 'get_automation_spec_format'].sort());
		expect(names((await rpc(campDraft, 'tools/list')).body)).toEqual([...CAMP].sort());
		expect(toolsForScope('campaigns:draft')).not.toContain('search_contacts');
		expect(toolsForScope('automations:draft')).not.toContain('search_contacts');
		expect(names((await rpc(rw, 'tools/list')).body)).toEqual(MCP_TOOLS.map((t) => t.name).sort());
		expect(toolsForScope('read')).toContain('search_contacts');
		expect(READ).toEqual(expect.arrayContaining(['search_contacts', 'get_contact', 'list_groups', 'list_campaigns', 'get_campaign', 'run_campaign_checks', 'list_automations', 'get_automation', 'get_deliverability', 'get_engagement_summary']));
		expect(AUTO).toEqual(expect.arrayContaining(['build_automation', 'add_automation_step', 'edit_automation_step', 'delete_automation_step', 'reorder_automation_steps', 'duplicate_automation']));
		expect(CAMP).toEqual(['create_campaign_draft', 'update_campaign_draft']);
	});

	it('no tool sends, schedules, activates or enrolls', () => {
		for (const t of MCP_TOOLS) expect(t.name).not.toMatch(/send|schedul|activat|enrol|pause|delete_automation$/);
		const desc = MCP_TOOLS.find((t) => t.name === 'build_automation')!.description;
		expect(desc).toMatch(/AutomationSpec/);
		expect(desc).toMatch(/GET \/api\/v1/);
	});
});

describe('tools/call', () => {
	it('builds an automation draft, reads it back and edits a step', async () => {
		const { status, body } = await call(autoDraft, 'build_automation', { spec: spec() });
		expect(status).toBe(200);
		expect(body.result.isError).toBe(false);
		const created = body.result.structuredContent;
		expect(created.status).toBe('draft');
		expect(created.name).toBe('MCP flow');
		expect(created.editor_url).toMatch(new RegExp(`/automations/${created.id}$`));
		expect(JSON.parse(body.result.content[0].text).id).toBe(created.id);
		const row = await db.prepare('SELECT status FROM automations WHERE id = ?').bind(created.id).first<{ status: string }>();
		expect(row?.status).toBe('draft');
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments').first<{ n: number }>())?.n).toBe(0);

		// A draft key may not read (#538); a read_write key may, and sees the same flow.
		const denied = await call(autoDraft, 'get_automation', { automation_id: created.id });
		expect(denied.body.result.isError).toBe(true);
		const got = await call(rw, 'get_automation', { automation_id: created.id });
		expect(got.body.result.isError).toBe(false);
		expect(got.body.result.structuredContent.spec.steps.length).toBe(spec().steps.length);
		const vocab = await call(autoDraft, 'get_automation_spec_format', {});
		expect(vocab.body.result.isError).toBe(false);

		// Step tools go through the same handlers.
		const emailStep = created.step_ids.welcome as number;
		const edit = await call(autoDraft, 'edit_automation_step', {
			automation_id: created.id,
			step_id: emailStep,
			fields: { subject: 'Hi again', body_md: 'Changed.' }
		});
		expect(edit.body.result.isError).toBe(false);
		const subj = await db.prepare('SELECT subject FROM automation_steps WHERE id = ?').bind(emailStep).first<{ subject: string }>();
		expect(subj?.subject).toBe('Hi again');

		const dup = await call(autoDraft, 'duplicate_automation', { automation_id: created.id });
		expect(dup.body.result.structuredContent.status).toBe('draft');
	});

	it('a bad spec is an error result with the problems, not a crash', async () => {
		const { status, body } = await call(autoDraft, 'build_automation', { spec: { name: '', trigger: { type: 'nope' }, steps: [] } });
		expect(status).toBe(200);
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text.length).toBeGreaterThan(0);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>())?.n).toBe(0);
	});

	it('a tool the scope does not allow is an error result; nothing is written', async () => {
		const r = await call(ro, 'build_automation', { spec: spec() });
		expect(r.status).toBe(200);
		expect(r.body.result.isError).toBe(true);
		expect(r.body.result.content[0].text).toMatch(/does not allow build_automation/);
		const c = await call(autoDraft, 'create_campaign_draft', { subject: 'S', body: 'B' });
		expect(c.body.result.isError).toBe(true);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>())?.n).toBe(0);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>())?.n).toBe(0);
	});

	it('draft keys cannot call read tools (#538)', async () => {
		await db.prepare("INSERT INTO contacts (email, first_name) VALUES ('secret@example.com', 'Sam')").run();
		for (const key of [campDraft, autoDraft]) {
			for (const [tool, args] of [
				['search_contacts', { q: 'secret' }],
				['get_contact', { email: 'secret@example.com' }],
				['list_groups', {}],
				['list_campaigns', {}],
				['get_engagement_summary', {}]
			] as const) {
				const r = await call(key, tool, args);
				expect(r.status).toBe(200);
				expect(r.body.result.isError).toBe(true);
				expect(r.body.result.content[0].text).toMatch(new RegExp(`does not allow ${tool}`));
				expect(r.body.result.content[0].text).not.toContain('secret@example.com');
			}
		}
		const c = await call(campDraft, 'get_automation_spec_format', {});
		expect(c.body.result.isError).toBe(true);
		const ok = await call(ro, 'search_contacts', { q: 'secret' });
		expect(ok.body.result.isError).toBe(false);
		await db.prepare("DELETE FROM contacts WHERE email = 'secret@example.com'").run();
	});

	it('unknown tools are -32602; unknown arguments are an error result', async () => {
		expect((await call(rw, 'send_campaign', {})).body.error.code).toBe(-32602);
		const r = await call(rw, 'update_campaign_draft', { campaign_id: 1, scheduled_at: '2030-01-01T00:00:00Z' });
		expect(r.body.result.isError).toBe(true);
		expect(r.body.result.content[0].text).toMatch(/scheduled_at/);
	});

	it('campaign drafts: create then update, still a draft', async () => {
		const c = await call(campDraft, 'create_campaign_draft', { subject: 'Hello', body: 'Body' });
		expect(c.body.result.isError).toBe(false);
		const id = c.body.result.structuredContent.id;
		const u = await call(campDraft, 'update_campaign_draft', { campaign_id: id, subject: 'Hello 2', list_id: LIST });
		expect(u.body.result.isError).toBe(false);
		const row = await db.prepare('SELECT subject, status FROM campaigns WHERE id = ?').bind(id).first<{ subject: string; status: string }>();
		expect(row).toEqual({ subject: 'Hello 2', status: 'draft' });
	});

	it('counts usage once per call', async () => {
		const count = async () =>
			(await db.prepare('SELECT request_count FROM api_keys WHERE scope = ?').bind('automations:draft').first<{ request_count: number }>())!.request_count;
		const before = await count();
		// A draft tool (counted by the REST handler it wraps) and a read-group tool the key may call (counted by the server).
		await call(autoDraft, 'build_automation', { spec: spec() });
		await call(autoDraft, 'get_automation_spec_format', {});
		const after = await count();
		expect(after - before).toBe(2);
		// A denied call is not counted.
		const denied = await call(autoDraft, 'list_automations', {});
		expect(denied.body.result.isError).toBe(true);
		expect(await count()).toBe(after);
	});
});

describe('rate limit', () => {
	it(`${MCP_RATE_PER_MINUTE} tool calls per minute per key`, async () => {
		const t0 = 1_000_000;
		for (let i = 0; i < MCP_RATE_PER_MINUTE; i++) expect(takeMcpCall(42, t0 + i)).toBe(true);
		expect(takeMcpCall(42, t0 + 100)).toBe(false);
		expect(takeMcpCall(43, t0 + 100)).toBe(true);
		expect(takeMcpCall(42, t0 + 60_001)).toBe(true);
	});

	it('the 61st call in a minute is an error result', async () => {
		const key = (await db.prepare("SELECT id FROM api_keys WHERE scope = 'read'").first<{ id: number }>())!.id;
		for (let i = 0; i < MCP_RATE_PER_MINUTE; i++) takeMcpCall(key);
		const r = await call(ro, 'list_automations', {});
		expect(r.body.result.isError).toBe(true);
		expect(r.body.result.content[0].text).toMatch(/Rate limit/);
	});
});

// Structural: walk the MCP server's import graph (runtime imports; `import type` is erased)
// — nothing reaches the engine (enroll, tick), a send, the scheduler or an activation.
const sources = import.meta.glob(['../src/lib/**/*.ts', '../src/routes/api/v1/**/*.ts', '../src/routes/mcp/**/*.ts'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

function resolve(from: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith('$lib/')) base = `../src/lib/${spec.slice(5)}`;
	else if (spec.startsWith('.')) {
		const parts = from.split('/').slice(0, -1);
		for (const seg of spec.split('/')) {
			if (seg === '..') parts.pop();
			else if (seg !== '.') parts.push(seg);
		}
		base = parts.join('/');
	} else return null; // a package
	base = base.replace(/\.ts$/, '');
	for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (c in sources) return c;
	return null;
}

function moduleGraph(entries: string[], { typeImports = false } = {}): Set<string> {
	const seen = new Set<string>();
	const stack = [...entries];
	const re = typeImports ? /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g : /(?:import|export)\s(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g;
	while (stack.length) {
		const f = stack.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const text = sources[f];
		expect(text, f).toBeDefined();
		for (const m of text.matchAll(re)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
		for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
	}
	return seen;
}

describe('structural: the MCP server cannot send, schedule, activate or enroll', () => {
	const ENTRY = ['../src/routes/mcp/+server.ts'];
	const banned = [
		'automations.ts',
		'send.ts',
		'postmark.ts',
		'scheduled.ts',
		'resend.ts',
		'automation-bulk.ts',
		'best-time.ts',
		'contact-bulk.ts',
		'contact-write.ts'
	].map((f) => `../src/lib/server/${f}`);

	it('module graph excludes the engine, send, postmark, scheduler, bulk and contact writes', () => {
		const graph = moduleGraph(ENTRY);
		expect(graph.has('../src/lib/server/mcp/tools.ts')).toBe(true);
		expect(graph.has('../src/lib/server/automation-write.ts')).toBe(true);
		expect(graph.has('../src/routes/api/v1/automations/+server.ts')).toBe(true);
		expect([...graph].filter((f) => banned.includes(f))).toEqual([]);
		// No /api/v1 route that enrolls, deletes or writes contacts is wired in.
		expect([...graph].filter((f) => /enroll|contacts|bulk/.test(f) && f.includes('/routes/'))).toEqual([]);
		for (const f of ['../src/lib/server/mcp/tools.ts', '../src/lib/server/mcp/server.ts']) {
			expect(sources[f]).not.toMatch(/\b(enroll\w*|sendCampaignEmail|activationProblem|processScheduled\w*)\s*[,}(]/);
		}
	});

	it('the walker does see a sending import (sanity)', () => {
		expect(moduleGraph(['../src/routes/api/v1/automations/[id]/enroll/+server.ts']).has('../src/lib/server/automations.ts')).toBe(true);
	});
});

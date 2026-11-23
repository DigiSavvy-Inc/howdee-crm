import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #347: create / edit automation DRAFTS over /api/v1 — scopes, the whole-flow spec
// round-trip, the 409s, the no-status rule, discovery, and the structural rule that the
// handlers never reach the engine's enroll or a send.
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listGET, POST as createPOST } from '../src/routes/api/v1/automations/+server';
import { GET as oneGET, PATCH as autoPATCH, DELETE as autoDELETE } from '../src/routes/api/v1/automations/[id]/+server';
import { PUT as specPUT } from '../src/routes/api/v1/automations/[id]/spec/+server';
import { POST as stepsPOST } from '../src/routes/api/v1/automations/[id]/steps/+server';
import { PATCH as stepPATCH, DELETE as stepDELETE } from '../src/routes/api/v1/automations/[id]/steps/[stepId]/+server';
import { POST as reorderPOST } from '../src/routes/api/v1/automations/[id]/steps/reorder/+server';
import { POST as duplicatePOST } from '../src/routes/api/v1/automations/[id]/duplicate/+server';
import { POST as enrollPOST } from '../src/routes/api/v1/automations/[id]/enroll/+server';
import { GET as discovery } from '../src/routes/api/v1/+server';
import { EXAMPLE_SPEC } from '../src/lib/server/automations-api';
import type { AutomationSpec } from '../src/lib/automation-spec';

const db = (env as any).DB as D1Database;

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, method: string, token: string | undefined, body?: unknown, params: Record<string, string> = {}) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		platform: { env },
		url,
		params
	} as any;
}
const jsonOf = async (res: Response) => JSON.parse(await res.text());
const p = (id: number, extra: Record<string, string> = {}) => ({ id: String(id), ...extra });

let LIST = 0;
let draftKey = '';
let rw = '';
let ro = '';
let campaignKey = '';

function spec(): AutomationSpec {
	return { ...structuredClone(EXAMPLE_SPEC), trigger: { type: 'list_added', list_id: LIST } };
}

async function create(token: string, body: unknown = spec()) {
	return createPOST(ev('/api/v1/automations', 'POST', token, body));
}
async function newDraft(): Promise<any> {
	const res = await create(draftKey);
	expect(res.status).toBe(201);
	return (await jsonOf(res)).data;
}

beforeEach(async () => {
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
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key IN ('approved_senders', 'default_from')")
	]);
	await db.prepare("INSERT INTO app_state (key, value) VALUES ('default_from', 'alan@ourco.example')").run();
	LIST = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	draftKey = await makeKey('automations:draft');
	rw = await makeKey('read_write');
	ro = await makeKey('read');
	campaignKey = await makeKey('campaigns:draft');
});

describe('scopes', () => {
	it('read → 403 on writes, campaigns:draft → 403, automations:draft → ok', async () => {
		expect((await create(ro)).status).toBe(403);
		expect((await create(campaignKey)).status).toBe(403);
		expect((await create(undefined as any)).status).toBe(401);
		const d = await newDraft();
		expect(d.status).toBe('draft');
		expect(d.editor_url).toMatch(new RegExp(`/automations/${d.id}$`));

		expect((await autoPATCH(ev('/x', 'PATCH', ro, { name: 'n' }, p(d.id)))).status).toBe(403);
		expect((await autoPATCH(ev('/x', 'PATCH', campaignKey, { name: 'n' }, p(d.id)))).status).toBe(403);
		expect((await stepsPOST(ev('/x', 'POST', ro, { type: 'end' }, p(d.id)))).status).toBe(403);
		expect((await specPUT(ev('/x', 'PUT', campaignKey, spec(), p(d.id)))).status).toBe(403);
		expect((await duplicatePOST(ev('/x', 'POST', ro, undefined, p(d.id)))).status).toBe(403);

		// read_write can do the draft writes too.
		expect((await create(rw)).status).toBe(201);
	});

	it('an automations:draft key cannot read, delete or enroll', async () => {
		const d = await newDraft();
		expect((await listGET(ev('/api/v1/automations', 'GET', draftKey))).status).toBe(403);
		expect((await oneGET(ev('/x', 'GET', draftKey, undefined, p(d.id)))).status).toBe(403);
		expect((await autoDELETE(ev('/x', 'DELETE', draftKey, undefined, p(d.id)))).status).toBe(403);
		expect((await enrollPOST(ev('/x', 'POST', draftKey, { contact_ids: [1] }, p(d.id)))).status).toBe(403);
		expect((await discovery(ev('/api/v1', 'GET', draftKey))).status).toBe(403);
	});
});

describe('spec round-trip', () => {
	it('POST spec → GET returns the same flow, with steps and stats', async () => {
		const d = await newDraft();
		expect(Object.keys(d.step_ids)).toEqual(['welcome']);
		const got = (await jsonOf(await oneGET(ev('/x', 'GET', ro, undefined, p(d.id))))).data;
		expect(got).toMatchObject({ id: d.id, name: 'Welcome series', status: 'draft', trigger: 'list_added', reentry: 'once', labels: ['onboarding'] });
		expect(got.steps).toHaveLength(4);
		expect(got.stats.enrollments).toEqual({ active: 0, completed: 0, cancelled: 0, failed: 0 });
		const s = got.spec;
		expect(s.trigger).toEqual({ type: 'list_added', list_id: LIST });
		expect(s.steps[0]).toMatchObject({ type: 'email', ref: 's1', subject: 'Welcome, {{first_name}}', from_email: 'alan@ourco.example', wait_seconds: 3600 });
		expect(s.steps[1].condition).toEqual({ kind: 'opened', step_ref: 's1' });
		expect(s.steps[1].yes[0]).toMatchObject({ type: 'tag', tag_action: 'add', tag_name: 'engaged' });
		expect(s.steps[1].no[0]).toMatchObject({ type: 'email', subject: 'Did you see this?' });

		// Re-import the read spec as a new draft → identical spec (modulo name).
		const again = await jsonOf(await create(draftKey, s));
		const got2 = (await jsonOf(await oneGET(ev('/x', 'GET', ro, undefined, p(again.data.id))))).data;
		expect(got2.spec).toEqual(s);
	});

	it('400 with every problem path on a bad spec, nothing written', async () => {
		const bad = spec();
		bad.steps[0].subject = '';
		(bad.steps[1] as any).yes = [{ type: 'nope' }];
		const res = await create(draftKey, bad);
		expect(res.status).toBe(400);
		const body = await jsonOf(res);
		expect(body.problems.map((x: any) => x.path)).toEqual(expect.arrayContaining(['steps[0]', 'steps[1].yes[0]']));
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>())!.n).toBe(0);
	});

	it('PUT spec replaces the whole flow of a draft', async () => {
		const d = await newDraft();
		const next: AutomationSpec = {
			name: 'Replaced',
			trigger: { type: 'manual' },
			reentry: 'multiple',
			labels: ['x'],
			steps: [{ type: 'tag', tag_action: 'add', tag_name: 'hello' }]
		};
		const res = await specPUT(ev('/x', 'PUT', draftKey, next, p(d.id)));
		expect(res.status).toBe(200);
		const r = (await jsonOf(res)).data;
		expect(r).toMatchObject({ id: d.id, name: 'Replaced', trigger: 'manual', reentry: 'multiple', labels: ['x'] });
		expect(r.spec.steps).toEqual([{ type: 'tag', wait_seconds: 0, weekday_only: false, tag_action: 'add', tag_name: 'hello' }]);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ?').bind(d.id).first<{ n: number }>())!.n).toBe(1);

		// A bad replacement leaves the flow as it was.
		const bad = await specPUT(ev('/x', 'PUT', draftKey, { ...next, steps: [{ type: 'tag', tag_name: '' }] }, p(d.id)));
		expect(bad.status).toBe(400);
		expect((await jsonOf(bad)).problems).toBeDefined();
		const after = (await jsonOf(await oneGET(ev('/x', 'GET', ro, undefined, p(d.id))))).data;
		expect(after.spec.steps[0].tag_name).toBe('hello');
	});
});

describe('edits', () => {
	it('PATCH is key-present: name, trigger, reentry, labels', async () => {
		const d = await newDraft();
		const res = await autoPATCH(ev('/x', 'PATCH', draftKey, { name: 'Renamed', labels: ['a', 'B'] }, p(d.id)));
		expect(res.status).toBe(200);
		const r = (await jsonOf(res)).data;
		expect(r).toMatchObject({ name: 'Renamed', trigger: 'list_added', reentry: 'once' });
		expect([...r.labels].sort()).toEqual(['B', 'a']);
		const r2 = (await jsonOf(await autoPATCH(ev('/x', 'PATCH', draftKey, { trigger: { type: 'manual' }, reentry: 'multiple' }, p(d.id))))).data;
		expect(r2).toMatchObject({ name: 'Renamed', trigger: 'manual', reentry: 'multiple' });
		expect((await autoPATCH(ev('/x', 'PATCH', draftKey, { colour: 'red' }, p(d.id)))).status).toBe(400);
		expect((await autoPATCH(ev('/x', 'PATCH', draftKey, { trigger: { type: 'list_added' } }, p(d.id)))).status).toBe(400);
		expect((await autoPATCH(ev('/x', 'PATCH', draftKey, { name: 'x' }, p(999999)))).status).toBe(404);
	});

	it('steps: add, edit, reorder, delete', async () => {
		const d = await newDraft();
		const add = await stepsPOST(ev('/x', 'POST', draftKey, { type: 'tag', tag_action: 'add', tag_name: 'late', position: 0 }, p(d.id)));
		expect(add.status).toBe(201);
		const added = (await jsonOf(add)).data;
		expect(added.automation.spec.steps[0]).toMatchObject({ type: 'tag', tag_name: 'late' });

		const email = await stepsPOST(ev('/x', 'POST', draftKey, { type: 'email', subject: 'Third', body_md: 'Hi' }, p(d.id)));
		expect(email.status).toBe(201);
		const emailId = (await jsonOf(email)).data.step_id;
		// Bare / invalid steps are refused and nothing is left behind.
		expect((await stepsPOST(ev('/x', 'POST', draftKey, { type: 'tag' }, p(d.id)))).status).toBe(400);
		expect((await stepsPOST(ev('/x', 'POST', draftKey, { type: 'tag', tag_name: 'x', foo: 1 }, p(d.id)))).status).toBe(400);

		const edit = await stepPATCH(ev('/x', 'PATCH', draftKey, { tag_action: 'remove', tag_name: 'later' }, p(d.id, { stepId: String(added.step_id) })));
		expect(edit.status).toBe(200);
		expect((await jsonOf(edit)).data.automation.spec.steps[0]).toMatchObject({ tag_action: 'remove', tag_name: 'later' });
		expect((await stepPATCH(ev('/x', 'PATCH', draftKey, { position: 2 }, p(d.id, { stepId: String(added.step_id) })))).status).toBe(400);
		expect((await stepPATCH(ev('/x', 'PATCH', draftKey, { tag_name: 'x' }, p(d.id, { stepId: '999999' })))).status).toBe(404);

		const trunk = (await jsonOf(await oneGET(ev('/x', 'GET', ro, undefined, p(d.id))))).data.steps.filter((s: any) => s.parent_step_id === null);
		const order = trunk.map((s: any) => s.id).reverse();
		const re = await reorderPOST(ev('/x', 'POST', draftKey, { order }, p(d.id)));
		expect(re.status).toBe(200);
		expect((await jsonOf(re)).data.spec.steps[0]).toMatchObject({ type: 'email', subject: 'Third' });
		expect((await reorderPOST(ev('/x', 'POST', draftKey, { order: [order[0]] }, p(d.id)))).status).toBe(400);

		const del = await stepDELETE(ev('/x', 'DELETE', draftKey, undefined, p(d.id, { stepId: String(emailId) })));
		expect(del.status).toBe(200);
		expect((await jsonOf(del)).data.deleted).toEqual([emailId]);
	});

	it('duplicate → a new draft copy', async () => {
		const d = await newDraft();
		await db.prepare("UPDATE automations SET status = 'active' WHERE id = ?").bind(d.id).run();
		const res = await duplicatePOST(ev('/x', 'POST', draftKey, undefined, p(d.id)));
		expect(res.status).toBe(201);
		const copy = (await jsonOf(res)).data;
		expect(copy).toMatchObject({ name: 'Welcome series (copy)', status: 'draft', labels: ['onboarding'] });
		expect(copy.spec.steps).toEqual((await jsonOf(await oneGET(ev('/x', 'GET', ro, undefined, p(d.id))))).data.spec.steps);
	});
});

describe('409s', () => {
	it('active → 409 on every edit; paused with contacts mid-flow → 409 needs_approval', async () => {
		const d = await newDraft();
		await db.prepare("UPDATE automations SET status = 'active' WHERE id = ?").bind(d.id).run();
		expect((await autoPATCH(ev('/x', 'PATCH', draftKey, { name: 'n' }, p(d.id)))).status).toBe(409);
		expect((await stepsPOST(ev('/x', 'POST', draftKey, { type: 'end' }, p(d.id)))).status).toBe(409);
		expect((await specPUT(ev('/x', 'PUT', draftKey, spec(), p(d.id)))).status).toBe(409);

		const contact = (await db.prepare("INSERT INTO contacts (email) VALUES ('a@example.org') RETURNING id").first<{ id: number }>())!.id;
		await db.prepare("UPDATE automations SET status = 'paused' WHERE id = ?").bind(d.id).run();
		await db
			.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status, current_step_id, next_run_at) VALUES (?, ?, 'active', ?, datetime('now'))")
			.bind(d.id, contact, d.step_ids.welcome)
			.run();
		const res = await autoPATCH(ev('/x', 'PATCH', draftKey, { name: 'n' }, p(d.id)));
		expect(res.status).toBe(409);
		expect(await jsonOf(res)).toMatchObject({ needs_approval: true, active_enrollments: 1 });
	});

	it('PUT spec and DELETE need a draft with no enrollments (DELETE: no campaigns either)', async () => {
		const d = await newDraft();
		const contact = (await db.prepare("INSERT INTO contacts (email) VALUES ('b@example.org') RETURNING id").first<{ id: number }>())!.id;
		await db
			.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status, ended_at) VALUES (?, ?, 'completed', datetime('now'))")
			.bind(d.id, contact)
			.run();
		expect((await specPUT(ev('/x', 'PUT', draftKey, spec(), p(d.id)))).status).toBe(409);
		expect((await autoDELETE(ev('/x', 'DELETE', rw, undefined, p(d.id)))).status).toBe(409);

		const e = await newDraft();
		await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id) VALUES ('s', 'b', '<p>b</p>', 'alan@ourco.example', 'sent', ?)")
			.bind(e.id)
			.run();
		expect((await autoDELETE(ev('/x', 'DELETE', rw, undefined, p(e.id)))).status).toBe(409);

		const f = await newDraft();
		expect((await autoDELETE(ev('/x', 'DELETE', rw, undefined, p(f.id)))).status).toBe(204);
		expect(await db.prepare('SELECT id FROM automations WHERE id = ?').bind(f.id).first()).toBeNull();
		expect((await autoDELETE(ev('/x', 'DELETE', rw, undefined, p(f.id)))).status).toBe(404);
	});
});

describe('no status changes', () => {
	it('a status key is 400 on every write, and nothing changes', async () => {
		expect((await create(draftKey, { ...spec(), status: 'active' })).status).toBe(400);
		const d = await newDraft();
		for (const res of [
			await autoPATCH(ev('/x', 'PATCH', draftKey, { status: 'active' }, p(d.id))),
			await autoPATCH(ev('/x', 'PATCH', rw, { status: 'active' }, p(d.id))),
			await specPUT(ev('/x', 'PUT', draftKey, { ...spec(), status: 'active' }, p(d.id))),
			await stepsPOST(ev('/x', 'POST', draftKey, { type: 'end', status: 'active' }, p(d.id))),
			await autoPATCH(ev('/x', 'PATCH', draftKey, { enroll: [1] }, p(d.id)))
		]) {
			expect(res.status).toBe(400);
		}
		const row = await db.prepare('SELECT status FROM automations WHERE id = ?').bind(d.id).first<{ status: string }>();
		expect(row!.status).toBe('draft');
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments').first<{ n: number }>())!.n).toBe(0);
	});
});

describe('discovery', () => {
	it('lists automations as draft-only with the spec vocabulary', async () => {
		const r = (await jsonOf(await discovery(ev('/api/v1', 'GET', rw)))).resources.automations;
		expect(r).toMatchObject({ read: true, write: 'draft', activate: false, enroll: true });
		expect(r.vocabulary.step_types).toEqual(['email', 'tag', 'branch', 'action', 'end', 'wait']);
		expect(r.vocabulary.trigger_types).toContain('list_added');
		expect(r.vocabulary.example.steps.length).toBeGreaterThan(0);
		const ro2 = (await jsonOf(await discovery(ev('/api/v1', 'GET', ro)))).resources.automations;
		expect(ro2).toMatchObject({ write: false, activate: false, enroll: false });
	});
});

// Structural: walk the handlers' import graph — nothing reaches the engine (enroll, tick),
// a send or an activation check. The existing enroll endpoint is the only exception and
// isn't part of this graph.
const sources = import.meta.glob(['../src/lib/**/*.ts', '../src/routes/api/v1/**/*.ts'], {
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

function moduleGraph(entries: string[]): Set<string> {
	const seen = new Set<string>();
	const stack = [...entries];
	while (stack.length) {
		const f = stack.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const text = sources[f];
		expect(text, f).toBeDefined();
		for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)) {
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

describe('structural: the automation write API cannot enroll, send or activate', () => {
	const HANDLERS = [
		'../src/routes/api/v1/automations/+server.ts',
		'../src/routes/api/v1/automations/[id]/+server.ts',
		'../src/routes/api/v1/automations/[id]/spec/+server.ts',
		'../src/routes/api/v1/automations/[id]/steps/+server.ts',
		'../src/routes/api/v1/automations/[id]/steps/[stepId]/+server.ts',
		'../src/routes/api/v1/automations/[id]/steps/reorder/+server.ts',
		'../src/routes/api/v1/automations/[id]/duplicate/+server.ts'
	];

	it('module graph excludes the engine, send, postmark, scheduled, resend, automation-bulk', () => {
		const graph = moduleGraph(HANDLERS);
		expect(graph.has('../src/lib/server/automation-write.ts')).toBe(true);
		expect(graph.has('../src/lib/server/automations-api.ts')).toBe(true);
		const banned = ['automations.ts', 'send.ts', 'postmark.ts', 'scheduled.ts', 'resend.ts', 'automation-bulk.ts', 'best-time.ts'].map(
			(f) => `../src/lib/server/${f}`
		);
		expect([...graph].filter((f) => banned.includes(f))).toEqual([]);
		for (const h of HANDLERS) expect(sources[h]).not.toMatch(/\b(enroll\w*|sendCampaignEmail|activationProblem)\s*[,}(]/);
	});

	it('the walker does see the engine from the enroll endpoint (sanity)', () => {
		expect(moduleGraph(['../src/routes/api/v1/automations/[id]/enroll/+server.ts']).has('../src/lib/server/automations.ts')).toBe(true);
	});
});

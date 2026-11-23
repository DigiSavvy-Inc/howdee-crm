import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import { APPROVE_OVER, type ToolContext, type WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, cardsForThread, resolvePending, undoAction } from '../src/lib/server/ai/actions';
import { runTurn, type LoopEvent, type PersistedMessage } from '../src/lib/server/ai/loop';
import type { AiProvider, ProviderEvent, StreamRequest } from '../src/lib/server/ai/provider';
import { handleAction, handleChat } from '../src/lib/server/ai/chat';
import { ASSISTANT_DEFAULTS, saveAssistantConfig } from '../src/lib/server/ai/config';
import { cleanPageContext, createThread, historyFor, pageContextText } from '../src/lib/server/ai/threads';
import { GET as threadGET } from '../src/routes/api/assistant/threads/[id]/+server';
import { POST as actionPOST } from '../src/routes/api/assistant/actions/[id]/+server';
import { bulkAddTag } from '../src/lib/server/contact-bulk';
import { listStages } from '../src/lib/server/pipeline';
import { syncCompanyMembership } from '../src/lib/server/companies';
import { modelInfo } from '../src/lib/ai-models';
import { SseBuffer } from '../src/lib/sse';
import { applyEvent, threadToItems, type ChatItem } from '../src/lib/assistant-view';
import { selectionLabel, upsertAction, type ActionCard } from '../src/lib/assistant-actions';

// #301 (Phase 2 of #71): the assistant's write tools against real D1 — each applies, writes
// ai_actions, and Undo restores the earlier state (or refuses when the record changed);
// > 25 contacts pauses for Approve / Cancel; only the action's own user can act on it; and
// no write enrolls anyone.

const db = (env as any).DB as D1Database;
const T = `w${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;

type U = { id: number; github_login: string; role: 'admin' | 'member' };
let member: U;
let other: U;
let seq = 0;

function sessionUser(u: U) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

async function newId(sql: string, ...binds: unknown[]): Promise<number> {
	return (await one<{ id: number }>(sql, ...binds)).id;
}

async function contact(label: string, extra: { first_name?: string; meta?: Record<string, unknown> } = {}): Promise<number> {
	return newId(
		'INSERT INTO contacts (email, first_name, subscribed, meta) VALUES (?, ?, 1, ?) RETURNING id',
		`${label}-${T}-${++seq}@x.example.net`,
		extra.first_name ?? null,
		extra.meta ? JSON.stringify(extra.meta) : null
	);
}

async function freshCtx(u: U = member): Promise<ToolContext> {
	const threadId = await createThread(db, u.id, sonnet.id, 'medium', 'test');
	return { db, user: sessionUser(u), baseUrl: 'https://app.test', now: new Date(), threadId };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	return runTool(ctx, name, input, TOOLS, `tu_${++seq}`);
}

async function undo(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return undoAction(ctx, row!, toolByName(row!.tool) as WriteTool);
}

async function actionRow(id: number) {
	return one<any>('SELECT * FROM ai_actions WHERE id = ?', id);
}

async function isMember(listId: number, contactId: number): Promise<boolean> {
	return !!(await db.prepare('SELECT 1 FROM list_members WHERE list_id = ? AND contact_id = ?').bind(listId, contactId).first());
}

async function enrollments(automationId: number): Promise<number> {
	return (await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', automationId)).n;
}

/** An active automation with one email step, triggered by `trigger`. */
async function automation(trigger: { list?: number; stage?: number }): Promise<number> {
	const id = await newId(
		`INSERT INTO automations (name, status, trigger_type, trigger_list_id, trigger_stage_id) VALUES (?, 'active', ?, ?, ?) RETURNING id`,
		`Auto ${T} ${++seq}`,
		trigger.stage ? 'pipeline_stage_entered' : 'list_added',
		trigger.list ?? null,
		trigger.stage ?? null
	);
	await db
		.prepare(`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type) VALUES (?, 1, 0, 'Hi', 'Hello', 'alan@ourco.example', 'email')`)
		.bind(id)
		.run();
	return id;
}

beforeAll(async () => {
	member = { id: await newId(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-m`), github_login: `${T}-m`, role: 'member' };
	other = { id: await newId(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-o`), github_login: `${T}-o`, role: 'member' };
});

const WRITE_TOOLS = [
	'update_contact', 'add_tag', 'remove_tag', 'add_to_list', 'remove_from_list',
	'create_segment', 'update_segment_rules', 'create_tag', 'create_list',
	'add_pipeline_card', 'move_pipeline_card', 'update_pipeline_card', 'update_company_fields'
];
// #309 drafting tools (tests/ai-drafts-309.test.ts): the only writes allowed to name automations.
const DRAFT_TOOLS = [
	'create_campaign_draft', 'update_campaign_draft', 'rewrite_draft_section',
	'create_automation_draft', 'add_automation_step', 'edit_automation_step', 'reorder_automation_steps',
	'build_automation', 'delete_automation_step' // #346 (tests/ai-automation-build.test.ts)
];
// #322 contact management (tests/ai-contacts-322.test.ts): the only writes allowed to touch
// subscription / archive state or delete, and to take an email.
const CONTACT_TOOLS = ['create_contact', 'unsubscribe_contacts', 'resubscribe_contacts', 'archive_contacts', 'restore_contacts', 'delete_contacts', 'update_contact_tier']; // #460: update_contact_tier
// #358 reports (tests/reports-358.test.ts): saves an unpinned report; changes no contacts.
const REPORT_TOOLS = ['create_report_draft'];
// #467 scores (tests/scoring-467.test.ts): a manual score ledger row; Undo deletes it.
const SCORE_TOOLS = ['add_score_points'];
// #472 group archive (tests/group-archive-472.test.ts): hides a list / segment; no contact changes.
const GROUP_ARCHIVE_TOOLS = ['archive_group', 'restore_group'];
// #517 forms (tests/ai-forms-tools-517.test.ts): draft forms only; never publish, archive or delete.
const FORM_TOOLS = ['create_form_draft', 'update_form'];

describe('registry', () => {
	it('has exactly the #301 (+ #309 drafting, #322 contact, #358 report) write tools, each with plan / apply / undo', () => {
		const writes = TOOLS.filter((t) => t.tier !== 'read') as WriteTool[];
		expect(writes.map((t) => t.name).sort()).toEqual([...WRITE_TOOLS, ...DRAFT_TOOLS, ...CONTACT_TOOLS, ...REPORT_TOOLS, ...SCORE_TOOLS, ...GROUP_ARCHIVE_TOOLS, ...FORM_TOOLS].sort());
		for (const t of writes) {
			expect(typeof t.plan).toBe('function');
			expect(typeof t.apply).toBe('function');
			expect(typeof t.undo).toBe('function');
		}
	});

	it('no tool can unsubscribe, delete, archive, send, schedule, enroll or touch automations', () => {
		// Read tools such as list_automations may name automations; write tools may not.
		for (const t of TOOLS) {
			if (t.tier !== 'read') expect(t.name).not.toMatch(/send|schedule|enroll|activate|reply/);
			// #346: delete_automation_step deletes a step of a draft / paused automation, never a contact.
			if (t.tier !== 'read' && !CONTACT_TOOLS.includes(t.name) && !GROUP_ARCHIVE_TOOLS.includes(t.name) && t.name !== 'delete_automation_step') expect(t.name).not.toMatch(/unsub|resub|subscri|delete|archive|restore|suppress/);
			if (t.tier !== 'read' && !DRAFT_TOOLS.includes(t.name)) expect(t.name).not.toMatch(/automation/);
			const props = Object.keys(((t.input_schema as any).properties ?? {}) as object);
			if (t.tier !== 'read') expect(props).not.toContain('subscribed');
			if (t.tier !== 'read' && !['update_contact', 'create_contact'].includes(t.name)) expect(props).not.toContain('email');
		}
		expect(APPROVE_OVER).toBe(25);
	});
});

describe('contacts', () => {
	it('update_contact applies, records before/after, and Undo restores (idempotently)', async () => {
		const ctx = await freshCtx();
		const id = await contact('ann', { first_name: 'Ann', meta: { plan: 'pro' } });
		const r = await call(ctx, 'update_contact', { contact_id: id, company: `Acme ${T}`, phone: '555-1234', custom_fields: { plan: 'enterprise' } });
		expect(r.ok).toBe(true);
		expect(r.action).toMatchObject({ tool: 'update_contact', status: 'applied', icon: 'edit', url: `https://app.test/contacts/${id}` });
		expect(JSON.parse(r.content)).toMatchObject({ action_id: r.action!.id, status: 'applied' });

		const row = await actionRow(r.action!.id);
		expect(row).toMatchObject({ user_id: member.id, thread_id: ctx.threadId, status: 'applied', tool: 'update_contact' });
		expect(JSON.parse(row.input)).toMatchObject({ args: { contact_id: id, company: `Acme ${T}` } });
		expect(JSON.parse(row.before)).toMatchObject({ contact_id: id, scalars: { company: null }, fields: { phone: null, plan: 'pro' } });
		expect(JSON.parse(row.after).state).toMatchObject({ scalars: { company: `Acme ${T}` }, fields: { phone: '555-1234', plan: 'enterprise' } });

		const now = await one<any>('SELECT company, company_id, meta FROM contacts WHERE id = ?', id);
		expect(now.company).toBe(`Acme ${T}`);
		expect(now.company_id).not.toBeNull();
		expect(JSON.parse(now.meta)).toMatchObject({ plan: 'enterprise', phone: '555-1234' });

		const u = await undo(ctx, r.action!.id);
		expect(u).toMatchObject({ ok: true, already: false });
		const back = await one<any>('SELECT company, company_id, meta FROM contacts WHERE id = ?', id);
		expect(back.company).toBeNull();
		expect(back.company_id).toBeNull();
		expect(JSON.parse(back.meta)).toEqual({ plan: 'pro' });
		expect((await actionRow(r.action!.id)).status).toBe('undone');
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true, already: true });
	});

	it('refuses subscription changes and a bad email, and stores nothing for a bad call', async () => {
		const ctx = await freshCtx();
		const id = await contact('bad');
		expect(await call(ctx, 'update_contact', { contact_id: id, email: 'not-an-email' })).toMatchObject({ ok: false });
		expect(await call(ctx, 'update_contact', { contact_id: id, subscribed: false })).toMatchObject({ ok: false });
		expect(await call(ctx, 'update_contact', { contact_id: id })).toMatchObject({ ok: false });
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM ai_actions WHERE thread_id = ?', ctx.threadId)).n).toBe(0);
		expect((await one<any>('SELECT subscribed FROM contacts WHERE id = ?', id)).subscribed).toBe(1);
	});

	it('Undo is refused when the record changed since', async () => {
		const ctx = await freshCtx();
		const id = await contact('chg', { first_name: 'Cara' });
		const r = await call(ctx, 'update_contact', { contact_id: id, first_name: 'Carla' });
		expect(r.action?.changes).toEqual([{ field: 'first_name', from: 'Cara', to: 'Carla' }]);
		await db.prepare(`UPDATE contacts SET first_name = 'Someone else' WHERE id = ?`).bind(id).run();
		const u = await undo(ctx, r.action!.id);
		expect(u).toMatchObject({ ok: false, status: 409 });
		expect((u as any).error).toMatch(/changed since/);
		expect((await one<any>('SELECT first_name FROM contacts WHERE id = ?', id)).first_name).toBe('Someone else');
		expect((await actionRow(r.action!.id)).status).toBe('applied');
	});

	it('add_tag / remove_tag apply, never enroll, and Undo restores membership (with added_at)', async () => {
		const ctx = await freshCtx();
		const tagName = `warm-${T}`;
		const tagId = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, tagName);
		const auto = await automation({ list: tagId });
		const [a, b, c] = [await contact('ta'), await contact('tb'), await contact('tc')];
		await db.prepare(`INSERT INTO list_members (list_id, contact_id, added_at) VALUES (?, ?, '2020-01-01 00:00:00')`).bind(tagId, c).run();

		const add = await call(ctx, 'add_tag', { contact_ids: [a, b, c], tag: tagName });
		expect(add.ok).toBe(true);
		expect(JSON.parse(add.content)).toMatchObject({ added: 2, already: 1 });
		expect(add.action).toMatchObject({ status: 'applied', icon: 'tag', url: `https://app.test/lists/${tagId}` });
		expect([await isMember(tagId, a), await isMember(tagId, b), await isMember(tagId, c)]).toEqual([true, true, true]);
		expect(await enrollments(auto)).toBe(0);

		expect(await undo(ctx, add.action!.id)).toMatchObject({ ok: true });
		expect([await isMember(tagId, a), await isMember(tagId, b), await isMember(tagId, c)]).toEqual([false, false, true]);

		const rm = await call(ctx, 'remove_tag', { contact_ids: [c, a], tag: tagName });
		expect(JSON.parse(rm.content)).toMatchObject({ removed: 1, not_in_it: 1 });
		expect(await isMember(tagId, c)).toBe(false);
		expect(await undo(ctx, rm.action!.id)).toMatchObject({ ok: true });
		expect((await one<any>('SELECT added_at FROM list_members WHERE list_id = ? AND contact_id = ?', tagId, c)).added_at).toBe('2020-01-01 00:00:00');
		expect(await isMember(tagId, a)).toBe(false);
		expect(await enrollments(auto)).toBe(0);

		// Undo of a remove is refused once someone was put back by hand.
		const rm2 = await call(ctx, 'remove_tag', { contact_id: c, tag: tagName });
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(tagId, c).run();
		expect(await undo(ctx, rm2.action!.id)).toMatchObject({ ok: false, status: 409 });

		// Control: the same tag added the normal way does enroll (so 0 above means something).
		const d = await contact('td');
		await bulkAddTag(db, { ok: true, ids: [d], all: false, missing: 0 }, tagName);
		expect(await enrollments(auto)).toBe(1);
	});

	it('add_tag creates a missing tag', async () => {
		const ctx = await freshCtx();
		const a = await contact('new');
		const r = await call(ctx, 'add_tag', { contact_id: a, tag: `fresh-${T}` });
		expect(r.ok).toBe(true);
		expect(await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`).bind(`fresh-${T}`).first()).not.toBeNull();
	});

	it('add_to_list / remove_from_list apply without enrolling; dynamic segments are refused', async () => {
		const ctx = await freshCtx();
		const listId = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `News ${T}`);
		const auto = await automation({ list: listId });
		const [a, b] = [await contact('la'), await contact('lb')];
		const add = await call(ctx, 'add_to_list', { contact_ids: [a, b], list_id: listId });
		expect(add.ok).toBe(true);
		expect(await isMember(listId, a)).toBe(true);
		expect(await enrollments(auto)).toBe(0);
		expect(await undo(ctx, add.action!.id)).toMatchObject({ ok: true });
		expect(await isMember(listId, a)).toBe(false);

		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, b).run();
		const rm = await call(ctx, 'remove_from_list', { contact_id: b, list: `News ${T}` });
		expect(rm.ok).toBe(true);
		expect(await isMember(listId, b)).toBe(false);
		expect(await undo(ctx, rm.action!.id)).toMatchObject({ ok: true });
		expect(await isMember(listId, b)).toBe(true);

		const dyn = await newId(`INSERT INTO lists (name, kind, rules) VALUES (?, 'segment', ?) RETURNING id`, `Dyn ${T}`, JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] }));
		expect(await call(ctx, 'add_to_list', { contact_id: a, list_id: dyn })).toMatchObject({ ok: false });
	});
});

describe('approve flow (> 25 contacts)', () => {
	async function many(n: number): Promise<number[]> {
		const ids: number[] = [];
		for (let i = 0; i < n; i++) ids.push(await contact('bulk'));
		return ids;
	}

	it('pauses: nothing is written until Approve; Approve runs it; Undo still works after', async () => {
		const ctx = await freshCtx();
		const ids = await many(APPROVE_OVER + 5);
		const tagName = `bulk-${T}`;
		const r = await call(ctx, 'add_tag', { contact_ids: ids, tag: tagName });
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ status: 'pending', scope: { count: 30 } });
		expect(r.action!.scope!.sample).toHaveLength(5);
		expect(await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`).bind(tagName).first()).toBeNull();

		// 25 is still a direct write.
		const direct = await call(ctx, 'add_tag', { contact_ids: ids.slice(0, APPROVE_OVER), tag: `${tagName}-25` });
		expect(direct.pending).toBeUndefined();
		expect(direct.action?.status).toBe('applied');

		const row = await actionForUser(db, r.action!.id, member.id);
		const ok = await resolvePending(ctx, row!, 'approve', toolByName('add_tag') as WriteTool);
		expect(ok).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect((ok as any).result).toMatchObject({ type: 'tool_result', tool_use_id: JSON.parse(row!.input!).tool_use_id });
		const tagId = (await one<{ id: number }>(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`, tagName)).id;
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', tagId)).n).toBe(30);

		expect(await resolvePending(ctx, row!, 'approve', toolByName('add_tag') as WriteTool)).toMatchObject({ ok: false, status: 409 });
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', tagId)).n).toBe(0);
	});

	it('cancel never runs it', async () => {
		const ctx = await freshCtx();
		const ids = await many(APPROVE_OVER + 1);
		const r = await call(ctx, 'add_tag', { contact_ids: ids, tag: `cancel-${T}` });
		const row = await actionForUser(db, r.action!.id, member.id);
		const c = await resolvePending(ctx, row!, 'cancel', toolByName('add_tag') as WriteTool);
		expect(c).toMatchObject({ ok: true, card: { status: 'cancelled' }, result: { is_error: true } });
		expect((c as any).result.content).toMatch(/cancelled/);
		expect(await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`).bind(`cancel-${T}`).first()).toBeNull();
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: false, status: 409 });
	});

	it('the loop stops at a pending write and answers any later tool call as not run', async () => {
		const ctx = await freshCtx();
		const ids = await many(APPROVE_OVER + 1);
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
		const calls: StreamRequest[] = [];
		const provider: AiProvider = {
			async *stream(req) {
				calls.push(req);
				const ev: ProviderEvent = {
					type: 'done',
					stopReason: 'tool_use',
					usage,
					content: [
						{ type: 'tool_use', id: 'tu_bulk', name: 'add_tag', input: { contact_ids: ids, tag: `loop-${T}` } },
						{ type: 'tool_use', id: 'tu_next', name: 'get_contact', input: { contact_id: ids[0] } }
					]
				};
				yield ev;
			}
		};
		const events: LoopEvent[] = [];
		const persisted: PersistedMessage[] = [];
		const r = await runTurn({
			provider,
			model: sonnet,
			effort: 'medium',
			system: 'sys',
			messages: [{ role: 'user', content: [{ type: 'text', text: 'tag them' }] }],
			tools: TOOLS,
			ctx,
			emit: (e) => events.push(e),
			persist: async (m) => {
				persisted.push(m);
			}
		});
		expect(r.stopReason).toBe('pending');
		expect(calls).toHaveLength(1);
		expect(events.find((e) => e.type === 'pending')).toMatchObject({ action: { tool: 'add_tag', status: 'pending' } });
		expect(persisted.map((m) => m.role)).toEqual(['assistant', 'tool']);
		const results = (persisted[1] as any).content;
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ tool_use_id: 'tu_next', is_error: true });
		expect(results[0].content).toMatch(/approve/);
	});
});

describe('groups', () => {
	it('create_segment validates rules; Undo removes it only while untouched', async () => {
		const ctx = await freshCtx();
		expect(await call(ctx, 'create_segment', { name: `Seg ${T}`, rules: [{ field: 'nope', op: 'x' }] })).toMatchObject({ ok: false });
		expect(await db.prepare(`SELECT id FROM lists WHERE name = ?`).bind(`Seg ${T}`).first()).toBeNull();

		const r = await call(ctx, 'create_segment', { name: `Seg ${T}`, match: 'any', rules: [{ field: 'tag', op: 'has', value: `warm-${T}` }] });
		expect(r.ok).toBe(true);
		const seg = await one<any>(`SELECT id, kind, rules FROM lists WHERE name = ?`, `Seg ${T}`);
		expect(seg.kind).toBe('segment');
		expect(JSON.parse(seg.rules)).toEqual({ match: 'any', rules: [{ field: 'tag', op: 'has', value: `warm-${T}` }] });
		expect(JSON.parse(r.content)).toMatchObject({ segment_id: seg.id, members: expect.any(Number) });
		expect(await call(ctx, 'create_segment', { name: `seg ${T}`, rules: [{ field: 'subscribed', op: 'yes' }] })).toMatchObject({ ok: false });

		// #535: a rule change moving over 25 contacts waits for approval, so keep this one narrow.
		const upd = await call(ctx, 'update_segment_rules', { segment_id: seg.id, rules: [{ field: 'source', op: 'is', value: `none-${T}` }] });
		expect(upd.ok).toBe(true);
		expect(upd.action?.status).toBe('applied');
		expect(JSON.parse((await one<any>('SELECT rules FROM lists WHERE id = ?', seg.id)).rules).rules[0].field).toBe('source');
		expect(await undo(ctx, upd.action!.id)).toMatchObject({ ok: true });
		expect(JSON.parse((await one<any>('SELECT rules FROM lists WHERE id = ?', seg.id)).rules).rules[0].field).toBe('tag');

		// Changed since → the rules undo is refused.
		const upd2 = await call(ctx, 'update_segment_rules', { segment_id: seg.id, rules: [{ field: 'never_opened', op: 'yes' }] });
		await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'no' }] }), seg.id).run();
		expect(await undo(ctx, upd2.action!.id)).toMatchObject({ ok: false, status: 409 });

		// The create can't be undone now (edited since).
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: false, status: 409 });
	});

	it('create_tag / create_list; Undo deletes an untouched one and keeps a used one', async () => {
		const ctx = await freshCtx();
		const t = await call(ctx, 'create_tag', { name: `empty-${T}` });
		expect(t.ok).toBe(true);
		expect(await call(ctx, 'create_tag', { name: `EMPTY-${T}` })).toMatchObject({ ok: false });
		expect(await undo(ctx, t.action!.id)).toMatchObject({ ok: true });
		expect(await db.prepare(`SELECT id FROM lists WHERE name = ?`).bind(`empty-${T}`).first()).toBeNull();

		const l = await call(ctx, 'create_list', { name: `Fresh list ${T}` });
		const listId = (await one<{ id: number }>(`SELECT id FROM lists WHERE kind = 'list' AND name = ?`, `Fresh list ${T}`)).id;
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, await contact('fl')).run();
		const u = await undo(ctx, l.action!.id);
		expect(u).toMatchObject({ ok: false, status: 409 });
		expect((u as any).error).toMatch(/has members/);
		expect(await db.prepare('SELECT id FROM lists WHERE id = ?').bind(listId).first()).not.toBeNull();
	});
});

describe('pipeline', () => {
	it('add / update / move apply as the user, never fire stage triggers, and Undo walks them back', async () => {
		const ctx = await freshCtx();
		const stages = (await listStages(db)).filter((s) => s.kind === 'open');
		const [s1, s2] = stages;
		const auto = await automation({ stage: s2.id });
		const autoAdd = await automation({ stage: s1.id });
		const id = await contact('deal');

		const add = await call(ctx, 'add_pipeline_card', { contact_id: id, stage: s1.name, value: 500, owner: member.github_login });
		expect(add.ok).toBe(true);
		expect(await one<any>('SELECT stage_id, value, owner_user_id FROM pipeline_cards WHERE contact_id = ?', id)).toMatchObject({ stage_id: s1.id, value: 500, owner_user_id: member.id });
		expect(await one<any>('SELECT actor_kind, actor_id FROM pipeline_history WHERE contact_id = ? ORDER BY id DESC LIMIT 1', id)).toMatchObject({ actor_kind: 'user', actor_id: member.id });
		expect(await call(ctx, 'add_pipeline_card', { contact_id: id, stage: s1.name })).toMatchObject({ ok: false });

		const upd = await call(ctx, 'update_pipeline_card', { contact_id: id, value: 900, note: 'big' });
		expect(upd.action?.changes).toEqual([
			{ field: 'value', from: '500', to: '900' },
			{ field: 'note', from: null, to: 'big' }
		]);

		const mv = await call(ctx, 'move_pipeline_card', { contact_id: id, stage: String(s2.id) });
		expect(mv.action?.changes).toEqual([{ field: 'stage', from: s1.name, to: s2.name }]);
		expect((await one<any>('SELECT stage_id FROM pipeline_cards WHERE contact_id = ?', id)).stage_id).toBe(s2.id);
		expect(await enrollments(auto)).toBe(0);
		expect(await enrollments(autoAdd)).toBe(0);

		expect(await undo(ctx, mv.action!.id)).toMatchObject({ ok: true });
		expect((await one<any>('SELECT stage_id FROM pipeline_cards WHERE contact_id = ?', id)).stage_id).toBe(s1.id);
		expect(await undo(ctx, upd.action!.id)).toMatchObject({ ok: true });
		expect(await one<any>('SELECT value, note FROM pipeline_cards WHERE contact_id = ?', id)).toMatchObject({ value: 500, note: null });
		expect(await undo(ctx, add.action!.id)).toMatchObject({ ok: true });
		expect(await db.prepare('SELECT id FROM pipeline_cards WHERE contact_id = ?').bind(id).first()).toBeNull();
		expect(await enrollments(auto)).toBe(0);
	});

	it('Undo of a move is refused after someone moved the card again', async () => {
		const ctx = await freshCtx();
		const [s1, s2, s3] = (await listStages(db)).filter((s) => s.kind === 'open');
		const id = await contact('deal2');
		await call(ctx, 'add_pipeline_card', { contact_id: id, stage: String(s1.id) });
		const mv = await call(ctx, 'move_pipeline_card', { contact_id: id, stage: String(s2.id) });
		await db.prepare('UPDATE pipeline_cards SET stage_id = ? WHERE contact_id = ?').bind(s3.id, id).run();
		expect(await undo(ctx, mv.action!.id)).toMatchObject({ ok: false, status: 409 });
		expect((await one<any>('SELECT stage_id FROM pipeline_cards WHERE contact_id = ?', id)).stage_id).toBe(s3.id);
	});
});

describe('companies', () => {
	it('update_company_fields applies (a rename reaches the contacts) and Undo restores', async () => {
		const ctx = await freshCtx();
		const cid = await contact('co');
		await db.prepare('UPDATE contacts SET company = ? WHERE id = ?').bind(`Globex ${T}`, cid).run();
		await syncCompanyMembership(db, cid, `Globex ${T}`);
		const companyId = (await one<{ company_id: number }>('SELECT company_id FROM contacts WHERE id = ?', cid)).company_id;

		const r = await call(ctx, 'update_company_fields', { company_id: companyId, name: `Globex Corp ${T}`, website: 'globex.com' });
		expect(r.ok).toBe(true);
		expect(await one<any>('SELECT name, website FROM companies WHERE id = ?', companyId)).toMatchObject({ name: `Globex Corp ${T}`, website: 'https://globex.com/' });
		expect((await one<any>('SELECT company FROM contacts WHERE id = ?', cid)).company).toBe(`Globex Corp ${T}`);

		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect(await one<any>('SELECT name, website FROM companies WHERE id = ?', companyId)).toMatchObject({ name: `Globex ${T}`, website: null });
		expect((await one<any>('SELECT company FROM contacts WHERE id = ?', cid)).company).toBe(`Globex ${T}`);
	});
});

// ---- routes: the action endpoint, approve/cancel resume, ownership, rehydration ----

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

async function readSse(res: Response): Promise<any[]> {
	return new SseBuffer().push((await res.text()) + '\n\n').map((m) => JSON.parse(m.data));
}

describe('assistant actions routes', () => {
	beforeEach(async () => {
		await saveAssistantConfig(db, { ...ASSISTANT_DEFAULTS, access: 'everyone' });
	});

	it('pauses a chat turn, only the owner can approve/cancel/undo, approve resumes, cards rehydrate', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 30; i++) ids.push(await contact('r'));
		const tagName = `route-${T}`;
		const { f, bodies } = scriptedFetch([toolSse('toolu_bulk', 'add_tag', { contact_ids: ids, tag: tagName }), textSse('Tagged all 30.')]);

		const res = await handleChat(
			routeEvent('/api/assistant/chat', { user: member, body: { message: 'tag these', page: { route: '/contacts', params: {}, selected: ids } } }),
			{ fetch: f }
		);
		const events = await readSse(res);
		const pending = events.find((e) => e.type === 'pending');
		expect(pending.action).toMatchObject({ tool: 'add_tag', status: 'pending', scope: { count: 30 } });
		expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'pending' });
		expect(bodies[0].messages[0].content[0].text).toMatch(/30 selected contacts/);
		const threadId = events[0].id;
		const actionId = pending.action.id;

		// Someone else: 404 for every op; nothing ran.
		for (const op of ['approve', 'cancel', 'undo']) {
			expect((await actionPOST(routeEvent(`/api/assistant/actions/${actionId}`, { user: other, body: { op }, params: { id: String(actionId) } }))).status).toBe(404);
		}
		expect((await actionPOST(routeEvent(`/api/assistant/actions/${actionId}`, { body: { op: 'approve' }, params: { id: String(actionId) } }))).status).toBe(401);
		expect(await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`).bind(tagName).first()).toBeNull();

		// Approve: runs it, answers the paused call, resumes the turn.
		const resumed = await handleAction(routeEvent(`/api/assistant/actions/${actionId}`, { user: member, body: { op: 'approve' }, params: { id: String(actionId) } }), { fetch: f });
		const rEvents = await readSse(resumed);
		expect(rEvents.find((e) => e.type === 'action')).toMatchObject({ action: { id: actionId, status: 'approved' } });
		expect(rEvents.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
		const last = bodies[1].messages.at(-1);
		expect(last.role).toBe('user');
		expect(last.content.find((b: any) => b.type === 'tool_result')).toMatchObject({ tool_use_id: 'toolu_bulk' });
		const tagId = (await one<{ id: number }>(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`, tagName)).id;
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', tagId)).n).toBe(30);

		// A second approve is refused.
		expect((await handleAction(routeEvent(`/api/assistant/actions/${actionId}`, { user: member, body: { op: 'approve' }, params: { id: String(actionId) } }), { fetch: f })).status).toBe(409);

		// Rehydrate: the thread carries the card.
		const thread = await (await threadGET({ ...routeEvent(`/api/assistant/threads/${threadId}`, { user: member, params: { id: String(threadId) } }), request: new Request(`https://app.test/api/assistant/threads/${threadId}`) } as any)).json<any>();
		expect(thread.actions).toEqual([expect.objectContaining({ id: actionId, status: 'approved', tool_use_id: 'toolu_bulk' })]);
		const items = threadToItems(thread.messages, thread.actions);
		expect((items[1] as any).actions[0]).toMatchObject({ id: actionId });

		// Undo through the route.
		const u = await actionPOST(routeEvent(`/api/assistant/actions/${actionId}`, { user: member, body: { op: 'undo' }, params: { id: String(actionId) } }));
		expect(u.status).toBe(200);
		expect((await u.json<any>()).action).toMatchObject({ status: 'undone' });
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', tagId)).n).toBe(0);
		expect(await historyFor(db, threadId)).toBeTruthy();
	});

	it('a new message instead of Approve cancels the pending write and keeps the history valid', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 26; i++) ids.push(await contact('n'));
		const { f, bodies } = scriptedFetch([toolSse('toolu_wait', 'add_tag', { contact_ids: ids, tag: `skip-${T}` }), textSse('OK, not doing that.')]);
		const first = await readSse(await handleChat(routeEvent('/api/assistant/chat', { user: member, body: { message: 'tag them' } }), { fetch: f }));
		const threadId = first[0].id;
		const actionId = first.find((e) => e.type === 'pending').action.id;

		const second = await readSse(await handleChat(routeEvent('/api/assistant/chat', { user: member, body: { message: 'never mind', thread_id: threadId } }), { fetch: f }));
		expect(second.find((e) => e.type === 'action')).toMatchObject({ action: { id: actionId, status: 'cancelled' } });
		expect((await actionRow(actionId)).status).toBe('cancelled');
		const msgs = bodies[1].messages;
		const lastUser = msgs.at(-1);
		expect(lastUser.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_wait', is_error: true });
		expect(lastUser.content.at(-1)).toMatchObject({ type: 'text', text: 'never mind' });
		expect(await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = ?`).bind(`skip-${T}`).first()).toBeNull();
		expect((await cardsForThread(db, threadId)).map((c) => c.status)).toEqual(['cancelled']);
	});
});

describe('view helpers', () => {
	it('page context carries a capped selection; chip and cards fold in', () => {
		const pc = cleanPageContext({ route: '/contacts', params: {}, selected: [3, 3, 'x', 5, -1, ...Array.from({ length: 600 }, (_, i) => i + 10)] });
		expect(pc!.selected!.slice(0, 2)).toEqual([3, 5]);
		expect(pc!.selected).toHaveLength(500);
		expect(pageContextText({ route: '/contacts', params: {}, selected: [1, 2] })).toMatch(/2 selected contacts, ids \[1,2\]/);
		expect(cleanPageContext({ route: '/x', params: {} })).toEqual({ route: '/x', params: {} });
		expect(selectionLabel(12)).toBe('12 selected contacts');
		expect(selectionLabel(1)).toBe('1 selected contact');

		const card: ActionCard = { id: 9, tool: 'add_tag', tool_use_id: 't9', status: 'pending', icon: 'tag', summary: 'Tag 30', url: null, changes: [], scope: { count: 30, sample: [] }, error: null };
		const a = { kind: 'assistant', text: '', tools: [], costMicros: 0, tokens: 0 } as Extract<ChatItem, { kind: 'assistant' }>;
		applyEvent(a, { type: 'pending', action: card });
		expect(a.actions).toEqual([card]);
		const b = { kind: 'assistant', text: '', tools: [], costMicros: 0, tokens: 0 } as Extract<ChatItem, { kind: 'assistant' }>;
		upsertAction([a, b] as ChatItem[], b, { ...card, status: 'approved' });
		expect(a.actions![0].status).toBe('approved');
		expect(b.actions).toBeUndefined();
	});
});

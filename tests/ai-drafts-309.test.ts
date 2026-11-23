import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, resolvePending, undoAction } from '../src/lib/server/ai/actions';
import { cleanPageContext, createThread } from '../src/lib/server/ai/threads';
import { listSkills } from '../src/lib/server/ai/skills';
import { modelInfo } from '../src/lib/ai-models';
import { contextLabel } from '../src/lib/assistant-view';
import { draftIdOf, openLabel } from '../src/lib/assistant-actions';

// #309 (Phase 3 of #71): campaign and automation drafting on real D1 — drafts are created
// and edited, never sent, scheduled or activated; scheduled / sent campaigns and active
// automations are refused; replacing a whole body (and editing a paused automation with
// contacts in it) waits for Approve; Undo restores the earlier content.

const db = (env as any).DB as D1Database;
const T = `d${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;
const FROM = 'alan@ourco.example';

type U = { id: number; github_login: string; role: 'admin' | 'member' };
let member: U;
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

async function freshCtx(): Promise<ToolContext> {
	const threadId = await createThread(db, member.id, sonnet.id, 'medium', 'test');
	return { db, user: sessionUser(member), baseUrl: 'https://app.test', now: new Date(), threadId };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	return runTool(ctx, name, input, TOOLS, `tu_${++seq}`);
}

async function undo(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return undoAction(ctx, row!, toolByName(row!.tool) as WriteTool);
}

async function approve(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return resolvePending(ctx, row!, 'approve', toolByName(row!.tool) as WriteTool);
}

type Camp = { id: number; subject: string; preheader: string | null; body_md: string; body_blocks: string | null; body_html: string; status: string; scheduled_at: string | null; list_id: number | null; recipient_count: number };
async function camp(id: number): Promise<Camp | null> {
	return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Camp>();
}

const BODY = 'Hi {{first_name}},\n\nWe opened a new office in Pasadena and would love to show you around.\n\nCome by any Friday afternoon.\n\nAlan';

async function draft(ctx: ToolContext, extra: Record<string, unknown> = {}): Promise<number> {
	const r = await call(ctx, 'create_campaign_draft', { subject: `Office ${T} ${++seq}`, body_markdown: BODY, ...extra });
	expect(r.ok).toBe(true);
	return JSON.parse(r.content).campaign_id;
}

async function stepsOf(id: number) {
	return (await db.prepare('SELECT id, type, position, subject, tag_name, delay_before_seconds FROM automation_steps WHERE automation_id = ? ORDER BY position').bind(id).all<any>()).results;
}

beforeAll(async () => {
	member = { id: await newId(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-m`), github_login: `${T}-m`, role: 'member' };
});

describe('campaign drafts', () => {
	it('create_campaign_draft writes a zero-recipient draft in block format, with a proposed time that is not a schedule', async () => {
		const ctx = await freshCtx();
		const list = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `L ${T}`);
		const r = await call(ctx, 'create_campaign_draft', {
			subject: `Launch ${T}`,
			preheader: 'A quick look inside',
			body_markdown: BODY,
			list_id: list,
			from_email: FROM,
			proposed_send_at: '2030-01-15T09:00:00-08:00'
		});
		expect(r.ok).toBe(true);
		expect(r.action).toMatchObject({ status: 'applied', tool: 'create_campaign_draft' });
		const id = JSON.parse(r.content).campaign_id as number;
		expect(r.action!.url).toBe(`https://app.test/compose?draft=${id}`);
		expect(draftIdOf(r.action!)).toBe(id);
		expect(openLabel(r.action!)).toBe('Open in composer');
		const c = (await camp(id))!;
		expect(c).toMatchObject({ status: 'draft', recipient_count: 0, list_id: list, preheader: 'A quick look inside', scheduled_at: '2030-01-15 17:00:00' });
		expect(Array.isArray(JSON.parse(c.body_blocks!))).toBe(true);
		expect(c.body_md).toContain('Pasadena');
		expect(c.body_html).toContain('Pasadena');
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?', id)).n).toBe(0);
	});

	it('refuses a missing body, a non-list audience and a past proposed time — nothing is stored', async () => {
		const ctx = await freshCtx();
		const tag = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, `tag ${T}`);
		const before = (await one<{ n: number }>('SELECT COUNT(*) AS n FROM campaigns')).n;
		expect((await call(ctx, 'create_campaign_draft', { subject: 'x' })).ok).toBe(false);
		expect((await call(ctx, 'create_campaign_draft', { subject: 'x', body_markdown: 'y', list_id: tag })).ok).toBe(false);
		expect((await call(ctx, 'create_campaign_draft', { subject: 'x', body_markdown: 'y', proposed_send_at: '2001-01-01T00:00:00Z' })).ok).toBe(false);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM campaigns')).n).toBe(before);
	});

	it('update_campaign_draft edits fields and Undo restores them; Undo refuses after a later edit', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const orig = (await camp(id))!;
		const r = await call(ctx, 'update_campaign_draft', { campaign_id: id, subject: 'New subject', preheader: 'New preheader' });
		expect(r.action).toMatchObject({ status: 'applied' });
		expect(r.action!.changes.map((c) => c.field)).toEqual(['subject', 'preheader']);
		expect((await camp(id))!).toMatchObject({ subject: 'New subject', preheader: 'New preheader', status: 'draft' });
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect((await camp(id))!).toMatchObject({ subject: orig.subject, preheader: null, body_md: orig.body_md });

		const r2 = await call(ctx, 'update_campaign_draft', { campaign_id: id, subject: 'Second' });
		await db.prepare("UPDATE campaigns SET subject = 'Edited by a person' WHERE id = ?").bind(id).run();
		expect(await undo(ctx, r2.action!.id)).toMatchObject({ ok: false, status: 409 });
		expect((await camp(id))!.subject).toBe('Edited by a person');
	});

	it('replacing the whole body waits for Approve; Approve applies it and Undo restores the earlier body', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const orig = (await camp(id))!;
		const r = await call(ctx, 'update_campaign_draft', { campaign_id: id, body_markdown: 'Entirely new text.' });
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ status: 'pending' });
		expect((await camp(id))!.body_md).toBe(orig.body_md); // nothing written yet
		const ok = await approve(ctx, r.action!.id);
		expect(ok).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect((await camp(id))!.body_md).toContain('Entirely new text.');
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		const back = (await camp(id))!;
		expect(back.body_md).toBe(orig.body_md);
		expect(back.body_blocks).toBe(orig.body_blocks);
	});

	it('rewrite_draft_section inserts a P.S. and rewrites one block, refuses replacing everything; Undo restores', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const orig = (await camp(id))!;
		const read = await call(ctx, 'get_draft_sections', { campaign_id: id });
		expect(read.ok).toBe(true);
		const sections = JSON.parse(read.content).sections as { index: number; text: string }[];
		expect(sections.length).toBeGreaterThanOrEqual(3);
		expect(sections[1].text).toContain('Pasadena');

		const ps = await call(ctx, 'rewrite_draft_section', { campaign_id: id, start: sections.length, end: sections.length, body_markdown: 'P.S. Bring a friend.' });
		expect(ps.action).toMatchObject({ status: 'applied' });
		expect(ps.pending).toBeUndefined();
		const after = (await camp(id))!;
		expect(after.body_md).toContain('P.S. Bring a friend.');
		expect(JSON.parse(after.body_blocks!).length).toBe(sections.length + 1);

		const intro = await call(ctx, 'rewrite_draft_section', { campaign_id: id, start: 1, body_markdown: 'New office, new view.' });
		expect(intro.ok).toBe(true);
		expect((await camp(id))!.body_md).not.toContain('would love to show you around');

		const all = await call(ctx, 'rewrite_draft_section', { campaign_id: id, start: 0, end: sections.length + 1, body_markdown: 'All gone.' });
		expect(all.ok).toBe(false);
		expect(all.content).toMatch(/whole body/);

		expect(await undo(ctx, intro.action!.id)).toMatchObject({ ok: true });
		expect(await undo(ctx, ps.action!.id)).toMatchObject({ ok: true });
		expect((await camp(id))!.body_md).toBe(orig.body_md);
	});

	it('refuses edits on scheduled and sent campaigns', async () => {
		const ctx = await freshCtx();
		for (const status of ['scheduled', 'sent', 'sending']) {
			const id = await newId(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, recipient_count, scheduled_at) VALUES (?, 'Body', '<p>Body</p>', ?, ?, 0, '2030-01-01 00:00:00') RETURNING id`,
				`S ${status} ${T}`,
				FROM,
				status
			);
			for (const [tool, input] of [
				['update_campaign_draft', { campaign_id: id, subject: 'Hacked' }],
				['update_campaign_draft', { campaign_id: id, body_markdown: 'Hacked' }],
				['rewrite_draft_section', { campaign_id: id, start: 0, end: 0, body_markdown: 'Hacked' }]
			] as const) {
				const r = await call(ctx, tool, input);
				expect(r.ok, `${tool} on ${status}`).toBe(false);
				expect(r.pending).toBeUndefined();
				expect(r.content).toMatch(/not a draft/);
			}
			expect((await camp(id))!).toMatchObject({ subject: `S ${status} ${T}`, body_md: 'Body', status });
		}
	});

	it('Undo of an approved body change refuses once the draft was scheduled by a person', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const r = await call(ctx, 'update_campaign_draft', { campaign_id: id, subject: 'Before scheduling' });
		await db.prepare("UPDATE campaigns SET status = 'scheduled' WHERE id = ?").bind(id).run();
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: false, status: 409 });
		expect((await camp(id))!).toMatchObject({ subject: 'Before scheduling', status: 'scheduled' });
	});

	it('Undo of a create deletes the untouched draft, and keeps an edited one', async () => {
		const ctx = await freshCtx();
		const r = await call(ctx, 'create_campaign_draft', { subject: `Undo me ${T}`, body_markdown: BODY });
		const id = JSON.parse(r.content).campaign_id;
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect(await camp(id)).toBeNull();

		const r2 = await call(ctx, 'create_campaign_draft', { subject: `Keep me ${T}`, body_markdown: BODY });
		const id2 = JSON.parse(r2.content).campaign_id;
		await db.prepare("UPDATE campaigns SET preheader = 'mine' WHERE id = ?").bind(id2).run();
		expect(await undo(ctx, r2.action!.id)).toMatchObject({ ok: false });
		expect(await camp(id2)).not.toBeNull();
	});

	it('suggest_subject_lines checks options and changes nothing', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx, { subject: 'Hi {{first_name}}, come visit' });
		const r = await call(ctx, 'suggest_subject_lines', { campaign_id: id, options: ['Come see the new office', 'FREE TOUR!!! Act now', 'A very long subject line that keeps going well past what any phone inbox shows'] });
		expect(r.ok).toBe(true);
		const v = JSON.parse(r.content);
		expect(v.current_subject).toBe('Hi {{first_name}}, come visit');
		expect(v.options[0]).toMatchObject({ fits_phone: true });
		expect(v.options[1].warnings.join(' ')).toMatch(/exclamation/);
		expect(v.options[1].warnings.join(' ')).toMatch(/spam/);
		expect(v.options[2].fits_phone).toBe(false);
		expect(v.options[0].warnings.join(' ')).toMatch(/first_name/);
		expect((await camp(id))!.subject).toBe('Hi {{first_name}}, come visit');
	});
});

describe('automation drafts', () => {
	const steps = [
		{ type: 'email', subject: 'Welcome', body_markdown: 'Hi {{first_name}}, welcome aboard.', from_email: FROM },
		{ type: 'tag', tag_name: `welcomed-${T}`, wait_days: 1 },
		{ type: 'email', subject: 'Day 3', body_markdown: 'A tip for your first week.', from_email: FROM, wait_days: 2 }
	];

	async function created(ctx: ToolContext): Promise<number> {
		const r = await call(ctx, 'create_automation_draft', { name: `Onboarding ${T} ${++seq}`, steps });
		expect(r.ok).toBe(true);
		return JSON.parse(r.content).automation_id;
	}

	it('create_automation_draft makes a draft with its steps and enrolls nobody; Undo deletes it', async () => {
		const ctx = await freshCtx();
		const list = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `Trig ${T}`);
		const r = await call(ctx, 'create_automation_draft', { name: `Onboarding ${T}`, trigger_type: 'list_added', trigger_list_id: list, steps });
		expect(r.action).toMatchObject({ status: 'applied', url: expect.stringMatching(/\/automations\/\d+$/) });
		const id = JSON.parse(r.content).automation_id;
		expect(await one<any>('SELECT status, trigger_type, trigger_list_id FROM automations WHERE id = ?', id)).toMatchObject({ status: 'draft', trigger_type: 'list_added', trigger_list_id: list });
		const s = await stepsOf(id);
		expect(s.map((x: any) => x.type)).toEqual(['email', 'tag', 'email']);
		expect(s[2].delay_before_seconds).toBe(2 * 86400);
		expect(JSON.parse((await one<any>('SELECT body_blocks FROM automation_steps WHERE id = ?', s[0].id)).body_blocks).length).toBeGreaterThan(0);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', id)).n).toBe(0);

		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect(await db.prepare('SELECT id FROM automations WHERE id = ?').bind(id).first()).toBeNull();
		expect(await stepsOf(id)).toEqual([]);
	});

	it('refuses incomplete steps and triggers (#346: every step type and trigger is allowed when complete)', async () => {
		const ctx = await freshCtx();
		expect((await call(ctx, 'create_automation_draft', { name: 'x', steps: [{ type: 'branch' }] })).ok).toBe(false);
		expect((await call(ctx, 'create_automation_draft', { name: 'x', trigger_type: 'site_visit', steps })).ok).toBe(false);
		expect((await call(ctx, 'create_automation_draft', { name: 'x', steps: [{ type: 'email', subject: 'No body', from_email: FROM }] })).content).toMatch(/Step 1/);
	});

	it('add, edit and reorder steps on a draft, each undoable', async () => {
		const ctx = await freshCtx();
		const id = await created(ctx);
		const [a, b, c] = (await stepsOf(id)).map((x: any) => x.id);

		const add = await call(ctx, 'add_automation_step', { automation_id: id, position: 1, step: { type: 'tag', tag_name: 'mid' } });
		expect(add.action).toMatchObject({ status: 'applied' });
		const added = JSON.parse(add.content).step_id;
		expect((await stepsOf(id)).map((x: any) => x.id)).toEqual([a, added, b, c]);

		const edit = await call(ctx, 'edit_automation_step', { automation_id: id, step_id: a, subject: 'Welcome!', wait_hours: 2 });
		expect(edit.action!.changes.map((ch) => ch.field)).toEqual(['wait', 'subject']);
		expect((await stepsOf(id))[0]).toMatchObject({ subject: 'Welcome!', delay_before_seconds: 7200 });

		const order = [c, b, added, a];
		const re = await call(ctx, 'reorder_automation_steps', { automation_id: id, order });
		expect(re.action).toMatchObject({ status: 'applied' });
		expect((await stepsOf(id)).map((x: any) => x.id)).toEqual(order);
		expect((await call(ctx, 'reorder_automation_steps', { automation_id: id, order: [a, b] })).ok).toBe(false);

		expect(await undo(ctx, re.action!.id)).toMatchObject({ ok: true });
		expect((await stepsOf(id)).map((x: any) => x.id)).toEqual([a, added, b, c]);
		expect(await undo(ctx, edit.action!.id)).toMatchObject({ ok: true });
		expect((await stepsOf(id))[0]).toMatchObject({ subject: 'Welcome', delay_before_seconds: 0 });
		expect(await undo(ctx, add.action!.id)).toMatchObject({ ok: true });
		expect((await stepsOf(id)).map((x: any) => x.id)).toEqual([a, b, c]);
		expect((await one<any>('SELECT status FROM automations WHERE id = ?', id)).status).toBe('draft');
	});

	it('refuses every step edit on an active automation (and Undo once it is active)', async () => {
		const ctx = await freshCtx();
		const id = await created(ctx);
		const [a, b, c] = (await stepsOf(id)).map((x: any) => x.id);
		const edit = await call(ctx, 'edit_automation_step', { automation_id: id, step_id: a, subject: 'Before activation' });
		await db.prepare("UPDATE automations SET status = 'active' WHERE id = ?").bind(id).run();
		for (const [tool, input] of [
			['add_automation_step', { automation_id: id, step: { type: 'tag', tag_name: 'x' } }],
			['edit_automation_step', { automation_id: id, step_id: a, subject: 'Live edit' }],
			['reorder_automation_steps', { automation_id: id, order: [c, b, a] }]
		] as const) {
			const r = await call(ctx, tool, input);
			expect(r.ok, tool).toBe(false);
			expect(r.pending).toBeUndefined();
			expect(r.content).toMatch(/is active/);
		}
		expect(await undo(ctx, edit.action!.id)).toMatchObject({ ok: false, status: 409 });
		expect((await stepsOf(id)).map((x: any) => x.subject)).toEqual(['Before activation', '', 'Day 3']);
	});

	it('a paused automation with contacts mid-flow needs Approve; without contacts it applies at once', async () => {
		const ctx = await freshCtx();
		const id = await created(ctx);
		const [a] = (await stepsOf(id)).map((x: any) => x.id);
		await db.prepare("UPDATE automations SET status = 'paused' WHERE id = ?").bind(id).run();
		const direct = await call(ctx, 'edit_automation_step', { automation_id: id, step_id: a, subject: 'Paused, empty' });
		expect(direct.action).toMatchObject({ status: 'applied' });

		const contact = await newId('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', `p-${T}@x.example.net`);
		await db.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status, current_step_id) VALUES (?, ?, 'active', ?)").bind(id, contact, a).run();
		const r = await call(ctx, 'edit_automation_step', { automation_id: id, step_id: a, subject: 'Paused, busy' });
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ status: 'pending', scope: { count: 1 } });
		expect((await stepsOf(id))[0].subject).toBe('Paused, empty');
		expect(await approve(ctx, r.action!.id)).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect((await stepsOf(id))[0].subject).toBe('Paused, busy');
		expect((await one<any>('SELECT status FROM automations WHERE id = ?', id)).status).toBe('paused');
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', id)).n).toBe(1);
	});
});

describe('page context + skill', () => {
	it('keeps the composer draft id and labels it', () => {
		expect(cleanPageContext({ route: '/compose', params: { draft_id: '12' } })).toEqual({ route: '/compose', params: { draft_id: '12' } });
		expect(contextLabel('/compose', { draft_id: '12' })).toBe('Draft #12');
		expect(contextLabel('/compose', {})).toBe('Compose');
		expect(draftIdOf({ url: 'https://x/automations/3' })).toBeNull();
		expect(openLabel({ url: 'https://x/automations/3' })).toBe('Open automation'); // #346
		expect(openLabel({ url: 'https://x/contacts/3' })).toBe('Open');
	});

	it('seeds the email-copywriting on-demand skill', async () => {
		const s = (await listSkills(db)).find((r) => r.name === 'email-copywriting');
		expect(s).toMatchObject({ mode: 'on_demand', enabled: 1 });
		expect(s!.description.length).toBeLessThanOrEqual(200);
		expect(s!.body).toMatch(/preheader/i);
		expect(s!.body).toMatch(/call to action/i);
	});
});

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { DELETE_MAX, UNSUB_UNDO_HOURS } from '../src/lib/server/ai/tools/write-contact-manage';
import { actionForUser, resolvePending, undoAction } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';
import { canUndo } from '../src/lib/assistant-actions';
import { getAssistantConfig, saveAssistantConfig } from '../src/lib/server/ai/config';

// #322 (a #71 hard-rule change, 2026-10-17): the assistant's contact management tools against
// real D1 — create (dedupe, hygiene, Undo while unreferenced), update incl. email, unsubscribe /
// resubscribe (always Approve; reason, passes, 24 h Undo, Postmark guard), archive / restore
// (Undo), delete (always Approve, ≤ 50, unsubscribes kept, no Undo).

const db = (env as any).DB as D1Database;
const T = `c${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;
const LOGIN = `${T}-m`;
let userId = 0;
let seq = 0;

function sessionUser() {
	return { id: userId, github_login: LOGIN, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

async function contact(label: string, extra: { subscribed?: number; name?: string; archived?: string } = {}): Promise<number> {
	const r = await one<{ id: number }>(
		'INSERT INTO contacts (email, name, subscribed, archived_at) VALUES (?, ?, ?, ?) RETURNING id',
		`${label}-${T}-${++seq}@x.example.net`,
		extra.name ?? null,
		extra.subscribed ?? 1,
		extra.archived ?? null
	);
	return r.id;
}

async function freshCtx(extra: Partial<ToolContext> = {}): Promise<ToolContext> {
	const threadId = await createThread(db, userId, sonnet.id, 'medium', 'test');
	return { db, user: sessionUser(), baseUrl: 'https://app.test', now: new Date(), threadId, mxLookup: async () => 'ok', ...extra };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	return runTool(ctx, name, input, TOOLS, `tu_${++seq}`);
}

async function approve(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return resolvePending(ctx, row!, 'approve', toolByName(row!.tool) as WriteTool);
}

async function undo(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return undoAction(ctx, row!, toolByName(row!.tool) as WriteTool);
}

async function subscribed(id: number): Promise<number> {
	return (await one<{ subscribed: number }>('SELECT subscribed FROM contacts WHERE id = ?', id)).subscribed;
}

async function archivedAt(id: number): Promise<string | null> {
	return (await one<{ archived_at: string | null }>('SELECT archived_at FROM contacts WHERE id = ?', id)).archived_at;
}

async function activeAutomation(): Promise<number> {
	return (
		await one<{ id: number }>(`INSERT INTO automations (name, status, trigger_type) VALUES (?, 'active', 'manual') RETURNING id`, `A ${T} ${++seq}`)
	).id;
}

async function activePass(automationId: number, contactId: number): Promise<void> {
	await db
		.prepare(`INSERT INTO automation_enrollments (automation_id, contact_id, status, next_run_at) VALUES (?, ?, 'active', datetime('now', '+1 day'))`)
		.bind(automationId, contactId)
		.run();
}

beforeAll(async () => {
	userId = (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, LOGIN)).id;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

afterAll(async () => {
	// unsubscribes → contacts has no ON DELETE: don't leave rows that block another file's cleanup.
	await db.prepare('DELETE FROM unsubscribes WHERE email LIKE ?').bind(`%-${T}-%`).run();
});

describe('registry (#322)', () => {
	it('unsubscribe, resubscribe and delete are approve-tier; create / update / archive / restore are write-tier', () => {
		const tier = (n: string) => toolByName(n)?.tier;
		expect(['unsubscribe_contacts', 'resubscribe_contacts', 'delete_contacts'].map(tier)).toEqual(['approve', 'approve', 'approve']);
		expect(['create_contact', 'update_contact', 'archive_contacts', 'restore_contacts'].map(tier)).toEqual(['write', 'write', 'write', 'write']);
		// Older ai_actions rows of the #301 name still resolve for Undo.
		expect(toolByName('update_contact_fields')?.name).toBe('update_contact');
	});
});

describe('create_contact', () => {
	it('creates with fields / tags / lists, never enrolls, shows hygiene warnings, and Undo deletes it', async () => {
		const ctx = await freshCtx();
		const tag = `lead-${T}`;
		const tagId = (await one<{ id: number }>(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, tag)).id;
		const auto = (
			await one<{ id: number }>(`INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, 'active', 'list_added', ?) RETURNING id`, `On tag ${T}`, tagId)
		).id;
		await db.prepare(`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type) VALUES (?, 1, 0, 'Hi', 'x', 'alan@ourco.example', 'email')`).bind(auto).run();
		const listId = (await one<{ id: number }>(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `News ${T}`)).id;

		const email = `info+${T}@gmial.com`; // role local part (info) + typo'd domain
		const r = await call(ctx, 'create_contact', { email, name: 'Ann Lee', company: `Acme ${T}`, phone: '555', custom_fields: { plan: 'pro' }, tags: [tag], lists: [listId] });
		expect(r.ok).toBe(true);
		expect(r.action).toMatchObject({ tool: 'create_contact', status: 'applied', icon: 'add' });
		const id = JSON.parse(r.content).contact_id as number;
		const c = await one<any>('SELECT * FROM contacts WHERE id = ?', id);
		expect(c).toMatchObject({ email, name: 'Ann Lee', company: `Acme ${T}`, subscribed: 1, source: 'assistant' });
		expect(c.company_id).not.toBeNull();
		const meta = JSON.parse(c.meta);
		expect(meta).toMatchObject({ phone: '555', plan: 'pro' });
		expect(meta.hygiene).toMatch(/^warn .*role.*typo:gmail\.com/);
		expect(r.action!.notes!.join(' ')).toMatch(/Role address/);
		expect(r.action!.notes!.join(' ')).toMatch(/Did you mean/);
		expect(await one<any>('SELECT 1 AS x FROM list_members WHERE list_id = ? AND contact_id = ?', tagId, id)).toBeTruthy();
		expect(await one<any>('SELECT 1 AS x FROM list_members WHERE list_id = ? AND contact_id = ?', listId, id)).toBeTruthy();
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', auto)).n).toBe(0);

		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first()).toBeNull();
	});

	it('dedupes on email: returns the existing contact, creates nothing, stores no action', async () => {
		const ctx = await freshCtx();
		const id = await contact('dup');
		const email = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', id)).email;
		const r = await call(ctx, 'create_contact', { email: email.toUpperCase() });
		expect(r.ok).toBe(false);
		expect(JSON.parse(r.content)).toMatchObject({ existing_contact: { id, email } });
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE email = ?', email)).n).toBe(1);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM ai_actions WHERE thread_id = ?', ctx.threadId)).n).toBe(0);
		expect((await call(ctx, 'create_contact', { email: 'nope' })).ok).toBe(false);
	});

	it('tags an invalid (disposable) address hygiene:invalid without enrolling; Undo refuses once it is used', async () => {
		const ctx = await freshCtx();
		const r = await call(ctx, 'create_contact', { email: `x-${T}@mailinator.com` });
		expect(r.ok).toBe(true);
		const id = JSON.parse(r.content).contact_id as number;
		expect(await one<any>(`SELECT 1 AS x FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE l.name = 'hygiene:invalid' AND lm.contact_id = ?`, id)).toBeTruthy();
		expect(r.action!.notes).toContain('Disposable domain');

		await activePass(await activeAutomation(), id); // now something references it
		const u = await undo(ctx, r.action!.id);
		expect(u).toMatchObject({ ok: false, status: 409 });
		expect((u as any).error).toMatch(/kept/);
		expect(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first()).not.toBeNull();
	});
});

describe('update_contact (email)', () => {
	it('changes the email with hygiene, refuses a taken one, and Undo restores the old address', async () => {
		const ctx = await freshCtx();
		const id = await contact('old');
		const old = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', id)).email;
		const taken = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', await contact('taken'))).email;

		expect(await call(ctx, 'update_contact', { contact_id: id, email: taken })).toMatchObject({ ok: false });
		const next = `new-${T}@example.org`;
		const r = await call(ctx, 'update_contact', { contact_id: id, email: ` ${next.toUpperCase()} ` });
		expect(r.ok).toBe(true);
		expect(r.action!.changes).toEqual([{ field: 'email', from: old, to: next }]);
		const now = await one<any>('SELECT email, meta FROM contacts WHERE id = ?', id);
		expect(now.email).toBe(next);
		expect(JSON.parse(now.meta).hygiene).toBe('ok');

		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		const back = await one<any>('SELECT email, meta FROM contacts WHERE id = ?', id);
		expect(back.email).toBe(old);
		expect(back.meta ? JSON.parse(back.meta).hygiene : undefined).toBeUndefined();
	});
});

describe('unsubscribe_contacts', () => {
	it('is approve-tier even for one contact: nothing changes until Approve', async () => {
		const ctx = await freshCtx();
		const id = await contact('one');
		const r = await call(ctx, 'unsubscribe_contacts', { contact_id: id });
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ status: 'pending', scope: { count: 1 } });
		expect(r.action!.scope!.sample[0]).toMatch(/@x\.example\.net/);
		expect(r.action!.scope!.notes!.join(' ')).toMatch(/Not suppressed in Postmark/);
		expect(await subscribed(id)).toBe(1);
		const rr = await call(ctx, 'resubscribe_contacts', { contact_id: id, consent_confirmed: true });
		expect(rr.pending).toBe(true);
	});

	it('writes the assistant reason, cancels active passes; Undo within 24 h resubscribes only those it unsubscribed', async () => {
		const ctx = await freshCtx();
		const a = await contact('ua', { name: 'Ann' });
		const b = await contact('ub');
		const was = await contact('uc', { subscribed: 0 }); // already unsubscribed — Undo must leave it
		const auto = await activeAutomation();
		await activePass(auto, a);

		const r = await call(ctx, 'unsubscribe_contacts', { contact_ids: [a, b, was] });
		expect(r.action!.scope!.notes!.join(' ')).toMatch(/1 contact has active automation passes that will be cancelled/);
		expect(r.action!.scope!.sample[0]).toMatch(/^Ann <ua-/);
		const ok = await approve(ctx, r.action!.id);
		expect(ok).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect([await subscribed(a), await subscribed(b), await subscribed(was)]).toEqual([0, 0, 0]);
		const reasons = await db.prepare('SELECT contact_id, reason FROM unsubscribes WHERE contact_id IN (?, ?, ?)').bind(a, b, was).all<any>();
		expect(reasons.results.map((x) => x.reason)).toEqual([`assistant (@${LOGIN})`, `assistant (@${LOGIN})`]);
		expect((await one<any>('SELECT status FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', auto, a)).status).toBe('cancelled');
		expect(canUndo((ok as any).card)).toBe(true);

		// Past the window → refused.
		const late = { ...ctx, now: new Date(Date.now() + (UNSUB_UNDO_HOURS + 1) * 3600_000) };
		expect(await undo(late, r.action!.id)).toMatchObject({ ok: false, status: 409 });

		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect([await subscribed(a), await subscribed(b), await subscribed(was)]).toEqual([1, 1, 0]);
		// The cancelled pass stays cancelled (Undo never enrolls).
		expect((await one<any>('SELECT status FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', auto, a)).status).toBe('cancelled');
	});

	it('with also_suppress_in_postmark: suppresses, says so, and has no Undo', async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const emails = JSON.parse(String(init.body)).Suppressions.map((s: { EmailAddress: string }) => s.EmailAddress);
			return new Response(JSON.stringify({ Suppressions: emails.map((e: string) => ({ EmailAddress: e, Status: 'Suppressed' })) }), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const ctx = await freshCtx({ postmark: { token: 't', stream: 'broadcast' } });
		const id = await contact('sup');
		const r = await call(ctx, 'unsubscribe_contacts', { contact_id: id, also_suppress_in_postmark: true });
		expect(r.action!.scope!.notes!.join(' ')).toMatch(/Also suppresses them in Postmark/);
		expect(fetchMock).not.toHaveBeenCalled();
		const ok = await approve(ctx, r.action!.id);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((ok as any).card).toMatchObject({ status: 'approved', noUndo: true });
		expect(canUndo((ok as any).card)).toBe(false);
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: false, status: 409 });
		expect(await subscribed(id)).toBe(0);
	});
});

describe('resubscribe_contacts', () => {
	it('needs consent_confirmed and skips Postmark hard-bounce / spam suppressions (mocked)', async () => {
		const ctx = await freshCtx({ postmark: { token: 't', stream: 'broadcast', txStream: 'outbound' } });
		const fine = await contact('fine', { subscribed: 0 });
		const hard = await contact('hard', { subscribed: 0 });
		const hardEmail = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', hard)).email;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				const m = /\/message-streams\/([^/]+)\/suppressions\/dump$/.exec(url);
				const rows = m && m[1] === 'broadcast' ? [{ EmailAddress: hardEmail, SuppressionReason: 'HardBounce' }] : [];
				return new Response(JSON.stringify({ Suppressions: rows }), { status: 200 });
			})
		);

		expect(await call(ctx, 'resubscribe_contacts', { contact_ids: [fine, hard] })).toMatchObject({ ok: false });
		const r = await call(ctx, 'resubscribe_contacts', { contact_ids: [fine, hard], consent_confirmed: true });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes!.join(' ')).toMatch(/consent/);
		const ok = await approve(ctx, r.action!.id);
		expect((ok as any).card.summary).toMatch(/1 skipped: suppressed in Postmark/);
		expect([await subscribed(fine), await subscribed(hard)]).toEqual([1, 0]);

		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect([await subscribed(fine), await subscribed(hard)]).toEqual([0, 0]);
	});
});

describe('archive_contacts / restore_contacts', () => {
	it('archive applies at once and Undo restores; restore Undo puts the original archive date back', async () => {
		const ctx = await freshCtx();
		const a = await contact('aa');
		const old = await contact('ab', { archived: '2020-01-01 00:00:00' });

		const r = await call(ctx, 'archive_contacts', { contact_ids: [a, old] });
		expect(r.action).toMatchObject({ status: 'applied', tool: 'archive_contacts' });
		expect(await archivedAt(a)).not.toBeNull();
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: true });
		expect(await archivedAt(a)).toBeNull();
		expect(await archivedAt(old)).toBe('2020-01-01 00:00:00'); // wasn't archived by this action

		const rs = await call(ctx, 'restore_contacts', { contact_id: old });
		expect(rs.action).toMatchObject({ status: 'applied' });
		expect(await archivedAt(old)).toBeNull();
		expect(await undo(ctx, rs.action!.id)).toMatchObject({ ok: true });
		expect(await archivedAt(old)).toBe('2020-01-01 00:00:00');
	});

	it('waits for Approve above 25 contacts', async () => {
		const ctx = await freshCtx();
		const ids: number[] = [];
		for (let i = 0; i < 26; i++) ids.push(await contact(`bulk${i}`));
		const r = await call(ctx, 'archive_contacts', { contact_ids: ids });
		expect(r.pending).toBe(true);
		expect(await archivedAt(ids[0])).toBeNull();
	});
});

describe('delete_contacts', () => {
	// #322 addendum: deleting is off by default (Settings → Assistant → Permissions); these
	// cases are the "on" behaviour. tests/ai-delete-setting-322.test.ts covers the setting.
	beforeAll(async () => {
		await saveAssistantConfig(db, { ...(await getAssistantConfig(db)), allowDelete: true });
	});

	it('is approve-tier, keeps unsubscribes rows, and has no Undo', async () => {
		const ctx = await freshCtx();
		const id = await contact('del');
		const email = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', id)).email;
		await db.prepare(`INSERT INTO unsubscribes (contact_id, email, reason) VALUES (?, ?, 'link')`).bind(id, email).run();

		const r = await call(ctx, 'delete_contacts', { contact_id: id });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes!.join(' ')).toMatch(/Permanent: can't be undone\. Consider Archive instead\./);
		expect(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first()).not.toBeNull();

		const ok = await approve(ctx, r.action!.id);
		expect((ok as any).card).toMatchObject({ status: 'approved', noUndo: true });
		expect(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first()).toBeNull();
		const kept = await one<any>('SELECT contact_id, reason FROM unsubscribes WHERE email = ?', email);
		expect(kept).toMatchObject({ contact_id: null, reason: 'link' });
		expect(await undo(ctx, r.action!.id)).toMatchObject({ ok: false, status: 409 });
	});

	it(`refuses more than ${DELETE_MAX} contacts per call`, async () => {
		const ctx = await freshCtx();
		const ids: number[] = [];
		for (let i = 0; i < DELETE_MAX + 1; i++) ids.push(await contact(`many${i}`));
		const r = await call(ctx, 'delete_contacts', { contact_ids: ids });
		expect(r).toMatchObject({ ok: false });
		expect(r.content).toMatch(/At most 50/);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM ai_actions WHERE thread_id = ?', ctx.threadId)).n).toBe(0);
	});
});

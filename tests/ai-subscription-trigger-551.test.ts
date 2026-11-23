import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, resolvePending, undoAction } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';
import { bulkResubscribe, bulkUnsubscribe } from '../src/lib/server/contact-bulk';
import { defaultSubscriptionConfig } from '../src/lib/subscription-trigger';

// #551: the assistant never enrolls. Its unsubscribe / resubscribe (and the unsubscribe's Undo)
// pass `triggers: false`, so an active or paused "Subscription changes" automation gets no
// pass and no pending trigger — while the tier refresh still runs. The bulk bar still fires.

const db = (env as any).DB as D1Database;
const T = `s551${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;
const LOGIN = `${T}-m`;
let userId = 0;
let seq = 0;
const automations: number[] = [];

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

async function contact(subscribed = 1): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id', `c-${T}-${++seq}@x.example.net`, subscribed)).id;
}

async function subsAutomation(status: 'active' | 'paused'): Promise<number> {
	const cfg = { ...defaultSubscriptionConfig(), events: ['unsubscribed', 'resubscribed'] };
	const id = (
		await one<{ id: number }>(
			`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry) VALUES (?, ?, 'subscription_changed', ?, 'multiple') RETURNING id`,
			`Subs ${T} ${++seq}`,
			status,
			JSON.stringify(cfg)
		)
	).id;
	// subject / body_md / from_email are NOT NULL with no default (0003); a tag step leaves them empty (as #444's tests do).
	await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
			 VALUES (?, 0, 'tag', 'add', 'lost', '', '', 'alan@ourco.example', 0)`
		)
		.bind(id)
		.run();
	automations.push(id);
	return id;
}

// Counted for this file's contacts only, so a subscription change elsewhere in the shared DB can't skew them.
const IN_IDS = 'contact_id IN (SELECT value FROM json_each(?))';
const passes = async (aid: number, ...cids: number[]) =>
	(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND ${IN_IDS}`, aid, JSON.stringify(cids))).n;
const pending = async (aid: number, ...cids: number[]) =>
	(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_pending_triggers WHERE automation_id = ? AND ${IN_IDS}`, aid, JSON.stringify(cids))).n;
const tier = async (cid: number) =>
	(await db.prepare('SELECT tier FROM contact_engagement WHERE contact_id = ?').bind(cid).first<{ tier: string }>())?.tier ?? null;

function sessionUser() {
	return { id: userId, github_login: LOGIN, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function ctx(): Promise<ToolContext> {
	const threadId = await createThread(db, userId, sonnet.id, 'medium', 'test');
	return { db, user: sessionUser(), baseUrl: 'https://app.test', now: new Date(), threadId, mxLookup: async () => 'ok' };
}

const call = (c: ToolContext, name: string, input: Record<string, unknown>) => runTool(c, name, input, TOOLS, `tu_${++seq}`);

async function approve(c: ToolContext, id: number) {
	const row = await actionForUser(db, id, c.user.id);
	return resolvePending(c, row!, 'approve', toolByName(row!.tool) as WriteTool);
}

async function undo(c: ToolContext, id: number) {
	const row = await actionForUser(db, id, c.user.id);
	return undoAction(c, row!, toolByName(row!.tool) as WriteTool);
}

let active = 0;
let paused = 0;

beforeAll(async () => {
	userId = (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, LOGIN)).id;
	active = await subsAutomation('active');
	paused = await subsAutomation('paused');
});

afterAll(async () => {
	// Leave no live trigger behind for other test files sharing the database.
	await db.prepare(`UPDATE automations SET status = 'draft' WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(automations)).run();
	await db.prepare('DELETE FROM unsubscribes WHERE email LIKE ?').bind(`%-${T}-%`).run();
});

describe('#551: assistant subscription writes never fire "Subscription changes"', () => {
	it('approved unsubscribe, its Undo, and an approved resubscribe enroll nobody and record no pending trigger', async () => {
		const c = await ctx();
		const id = await contact();

		const r = await call(c, 'unsubscribe_contacts', { contact_id: id });
		expect(r.pending).toBe(true);
		// resolvePending answers ok: true even when apply throws (the card goes `failed`), so check the card.
		expect(await approve(c, r.action!.id)).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect((await one<{ subscribed: number }>('SELECT subscribed FROM contacts WHERE id = ?', id)).subscribed).toBe(0);
		expect(await tier(id)).toBe('cold'); // the tier refresh still ran (#444)
		expect(await passes(active, id)).toBe(0);
		expect(await pending(paused, id)).toBe(0);

		expect(await undo(c, r.action!.id)).toMatchObject({ ok: true, already: false });
		expect((await one<{ subscribed: number }>('SELECT subscribed FROM contacts WHERE id = ?', id)).subscribed).toBe(1);
		expect(await passes(active, id)).toBe(0);
		expect(await pending(paused, id)).toBe(0);

		const other = await contact(0);
		const rr = await call(c, 'resubscribe_contacts', { contact_id: other, consent_confirmed: true });
		expect(rr.pending).toBe(true);
		expect(await approve(c, rr.action!.id)).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect((await one<{ subscribed: number }>('SELECT subscribed FROM contacts WHERE id = ?', other)).subscribed).toBe(1);
		expect(await passes(active, id, other)).toBe(0);
		expect(await pending(paused, id, other)).toBe(0);
	});

	it('the bulk bar path still fires the trigger (so the checks above are not vacuous)', async () => {
		const id = await contact();
		await bulkUnsubscribe(db, { ok: true, ids: [id], all: false, missing: 0 });
		expect(await passes(active, id)).toBe(1);
		expect(await pending(paused, id)).toBe(1);

		// Resubscribe too (a fresh contact: the first one's pass is still active, one active pass per automation).
		const other = await contact(0);
		await bulkResubscribe(db, { ok: true, ids: [other], all: false, missing: 0 });
		expect(await passes(active, other)).toBe(1);
		expect(await pending(paused, other)).toBe(1);
	});

	it('unsubscribe_contacts adds the trigger-segment note when a segment reads subscribed', async () => {
		const c = await ctx();
		const id = await contact();
		const seg = (
			await one<{ id: number }>(
				`INSERT INTO lists (name, kind, rules) VALUES (?, 'segment', ?) RETURNING id`,
				`Seg ${T}`,
				JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'no' }] })
			)
		).id;
		automations.push(
			(await one<{ id: number }>(`INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, 'active', 'list_added', ?) RETURNING id`, `LA ${T}`, seg)).id
		);
		const r = await call(c, 'unsubscribe_contacts', { contact_id: id });
		expect(r.pending).toBe(true);
		const notes = r.action!.scope!.notes!.filter((n) => n.includes(`Segment “Seg ${T}”`));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/1 of these contacts is not in it yet/);
	});
});

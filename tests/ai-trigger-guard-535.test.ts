import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import { APPROVE_OVER, type ToolContext, type WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, resolvePending } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';

// #535: the assistant never enrolls anyone, but a dynamic segment that is the `list_added`
// trigger of an active / paused automation is polled by the heartbeat (#413). So a write that
// could push contacts into such a segment — new rules, a tag / list it reads, a field it
// reads — waits for Approve, with the reason and the count on the card. A plain segment (or a
// trigger segment that doesn't read what changes) applies as before. Nothing here runs the
// tick, so nothing is ever enrolled.

const db = (env as any).DB as D1Database;
const T = `g${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;
let seq = 0;
let userId = 0;
const automations: number[] = [];

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}
async function newId(sql: string, ...binds: unknown[]): Promise<number> {
	return (await one<{ id: number }>(sql, ...binds)).id;
}

async function contact(
	opts: { source?: string; meta?: Record<string, unknown>; subscribed?: 0 | 1; archived?: boolean; company?: { id: number; name: string } } = {}
): Promise<number> {
	return newId(
		`INSERT INTO contacts (email, subscribed, source, meta, archived_at, company, company_id) VALUES (?, ?, ?, ?, ${opts.archived ? "datetime('now')" : 'NULL'}, ?, ?) RETURNING id`,
		`c-${T}-${++seq}@x.example.net`,
		opts.subscribed ?? 1,
		opts.source ?? null,
		opts.meta ? JSON.stringify(opts.meta) : null,
		opts.company?.name ?? null,
		opts.company?.id ?? null
	);
}

/** Park every automation this file made, so later cases start with no live trigger segment. */
async function quiet(): Promise<void> {
	await db.prepare(`UPDATE automations SET status = 'draft' WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(automations)).run();
}

async function segment(rules: unknown[]): Promise<number> {
	return newId(`INSERT INTO lists (name, kind, rules) VALUES (?, 'segment', ?) RETURNING id`, `Seg ${T} ${++seq}`, JSON.stringify({ match: 'all', rules }));
}

async function list(): Promise<number> {
	return newId(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `List ${T} ${++seq}`);
}

async function automation(listId: number, status: 'active' | 'paused' | 'draft' = 'active'): Promise<number> {
	const id = await newId(
		`INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, ?, 'list_added', ?) RETURNING id`,
		`Auto ${T} ${++seq}`,
		status,
		listId
	);
	automations.push(id);
	return id;
}

async function ctx(): Promise<ToolContext> {
	const threadId = await createThread(db, userId, sonnet.id, 'medium', 'test');
	return {
		db,
		user: { id: userId, github_login: `${T}-u`, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any,
		baseUrl: 'https://app.test',
		now: new Date(),
		threadId,
		mxLookup: async () => 'ok'
	};
}

async function call(c: ToolContext, name: string, input: Record<string, unknown>) {
	return runTool(c, name, input, TOOLS, `tu_${++seq}`);
}

async function rulesOf(id: number) {
	return JSON.parse((await one<{ rules: string }>('SELECT rules FROM lists WHERE id = ?', id)).rules);
}

async function enrollments(): Promise<number> {
	return (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id IN (SELECT value FROM json_each(?))`, JSON.stringify(automations))).n;
}

beforeAll(async () => {
	userId = await newId(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-u`);
});

afterAll(async () => {
	// Leave no live trigger behind for other test files sharing the database.
	await db.prepare(`UPDATE automations SET status = 'draft' WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(automations)).run();
});

describe('update_segment_rules', () => {
	it('a trigger segment waits for Approve and says how many would enter', async () => {
		const src = `src-${T}-a`;
		for (let i = 0; i < 3; i++) await contact({ source: src });
		const seg = await segment([{ field: 'source', op: 'is', value: `nobody-${T}` }]);
		await automation(seg);
		const c = await ctx();

		const r = await call(c, 'update_segment_rules', { segment_id: seg, rules: [{ field: 'source', op: 'is', value: src }] });
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ status: 'pending', scope: { count: 3 } });
		expect(r.action!.summary).toMatch(/0 → 3 matching \(3 enter, 0 leave\)/);
		const notes = r.action!.scope!.notes!;
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/active automation/);
		expect(notes[0]).toMatch(/3 contacts would enter it \(3 subscribed\)/);
		// Nothing changed yet.
		expect((await rulesOf(seg)).rules[0].value).toBe(`nobody-${T}`);

		const row = await actionForUser(db, r.action!.id, userId);
		const ok = await resolvePending(c, row!, 'approve', toolByName('update_segment_rules') as WriteTool);
		expect(ok).toMatchObject({ ok: true, card: { status: 'approved' } });
		expect((await rulesOf(seg)).rules[0].value).toBe(src);
		expect(await enrollments()).toBe(0);
	});

	it('a paused automation counts too; a draft one does not', async () => {
		const src = `src-${T}-p`;
		await contact({ source: src });
		const paused = await segment([{ field: 'source', op: 'is', value: `nobody-${T}` }]);
		await automation(paused, 'paused');
		const c = await ctx();
		const r = await call(c, 'update_segment_rules', { segment_id: paused, rules: [{ field: 'source', op: 'is', value: src }] });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes![0]).toMatch(/paused automation/);

		const draft = await segment([{ field: 'source', op: 'is', value: `nobody-${T}` }]);
		await automation(draft, 'draft');
		const d = await call(c, 'update_segment_rules', { segment_id: draft, rules: [{ field: 'source', op: 'is', value: src }] });
		expect(d.pending).toBeUndefined();
		expect(d.action?.status).toBe('applied');
	});

	it('a plain segment applies at once for a small change, and reports the real count above 25', async () => {
		const c = await ctx();
		const small = `src-${T}-s`;
		await contact({ source: small });
		const seg = await segment([{ field: 'source', op: 'is', value: `nobody-${T}` }]);
		const r = await call(c, 'update_segment_rules', { segment_id: seg, rules: [{ field: 'source', op: 'is', value: small }] });
		expect(r.pending).toBeUndefined();
		expect(r.action?.status).toBe('applied');
		expect(JSON.parse(r.content)).toMatchObject({ members_before: 0, members_after: 1 });

		const big = `src-${T}-b`;
		for (let i = 0; i < APPROVE_OVER + 2; i++) await contact({ source: big });
		const r2 = await call(c, 'update_segment_rules', { segment_id: seg, rules: [{ field: 'source', op: 'is', value: big }] });
		expect(r2.pending).toBe(true);
		// 27 enter, 1 leaves.
		expect(r2.action).toMatchObject({ scope: { count: APPROVE_OVER + 3 } });
		expect(r2.action!.scope!.notes ?? []).toHaveLength(0);
		expect((await rulesOf(seg)).rules[0].value).toBe(small);
	});
});

describe('contact writes into a trigger segment', () => {
	it('add_tag / remove_tag on a tag a trigger segment reads waits; other tags and members already in it apply', async () => {
		const tag = `hot-${T}`;
		const seg = await segment([{ field: 'tag', op: 'has', value: tag }]);
		await automation(seg);
		const id = await contact();
		const c = await ctx();

		const r = await call(c, 'add_tag', { contact_id: id, tag });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes![0]).toMatch(/1 of these contacts is not in it yet/);
		expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM lists WHERE kind = 'tag' AND name = ? COLLATE NOCASE`, tag)).toEqual({ n: 0 });

		const other = await call(c, 'add_tag', { contact_id: id, tag: `cold-${T}` });
		expect(other.action?.status).toBe('applied');

		// Approve, then the contact is in the segment: tagging again needs no approval.
		const row = await actionForUser(db, r.action!.id, userId);
		await resolvePending(c, row!, 'approve', toolByName('add_tag') as WriteTool);
		const again = await call(c, 'add_tag', { contact_id: id, tag });
		expect(again.action?.status).toBe('applied');

		// "not tagged" trigger segment: removing the tag would push the contact in.
		const notSeg = await segment([{ field: 'tag', op: 'not', value: tag }]);
		await automation(notSeg);
		const rm = await call(c, 'remove_tag', { contact_id: id, tag });
		expect(rm.pending).toBe(true);
		expect(await enrollments()).toBe(0);
	});

	it('add_to_list / remove_from_list on a list a trigger segment reads waits', async () => {
		const l = await list();
		const seg = await segment([{ field: 'list', op: 'in', value: String(l) }]);
		await automation(seg);
		const id = await contact();
		const c = await ctx();
		const r = await call(c, 'add_to_list', { contact_id: id, list_id: l });
		expect(r.pending).toBe(true);
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', l)).toEqual({ n: 0 });

		const plain = await list();
		const ok = await call(c, 'add_to_list', { contact_id: id, list_id: plain });
		expect(ok.action?.status).toBe('applied');
	});

	it('update_contact on a field a trigger segment reads waits; another field applies', async () => {
		const key = `plan_${T}`;
		const seg = await segment([{ field: 'field', op: 'eq', value2: key, value: 'pro' }]);
		await automation(seg);
		const id = await contact();
		const c = await ctx();
		const r = await call(c, 'update_contact', { contact_id: id, custom_fields: { [key]: 'pro' } });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes![0]).toMatch(/active automation/);
		expect((await one<{ meta: string | null }>('SELECT meta FROM contacts WHERE id = ?', id)).meta).toBeNull();

		const ok = await call(c, 'update_contact', { contact_id: id, custom_fields: { [`other_${T}`]: 'x' } });
		expect(ok.action?.status).toBe('applied');
		expect(await enrollments()).toBe(0);
	});
});

// #535 part 2: the other write tools that can move contacts into a trigger segment.
describe('create, restore, tier, pipeline, company, email and resubscribe', () => {
	beforeEach(quiet);

	it('create_contact asks when a trigger segment may match a new contact; applies when none can', async () => {
		const c = await ctx();
		// No live trigger segment: applies at once, exactly as before.
		const plain = await call(c, 'create_contact', { email: `new-${T}-1@x.example.net` });
		expect(plain.action?.status).toBe('applied');

		// "Subscribed" matches any new contact.
		const seg = await segment([{ field: 'subscribed', op: 'yes' }]);
		await automation(seg);
		const email = `new-${T}-2@x.example.net`;
		const r = await call(c, 'create_contact', { email });
		expect(r.pending).toBe(true);
		const notes = r.action!.scope!.notes!;
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain((await one<{ name: string }>('SELECT name FROM lists WHERE id = ?', seg)).name);
		expect(notes[0]).toMatch(/active automation .*may enter it/);
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE email = ?', email)).toEqual({ n: 0 });

		const row = await actionForUser(db, r.action!.id, userId);
		await resolvePending(c, row!, 'approve', toolByName('create_contact') as WriteTool);
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE email = ?', email)).toEqual({ n: 1 });
		expect(await enrollments()).toBe(0);
	});

	it('create_contact skips a trigger segment that needs a tag / list the call does not give', async () => {
		const c = await ctx();
		const tag = `vip-${T}`;
		const l = await list();
		await automation(await segment([{ field: 'tag', op: 'has', value: tag }]));
		await automation(await segment([{ field: 'list', op: 'in', value: String(l) }, { field: 'subscribed', op: 'yes' }]));

		const r = await call(c, 'create_contact', { email: `new-${T}-3@x.example.net` });
		expect(r.action?.status).toBe('applied');

		// Given the tag (any case) or the list → may match → asks.
		const tagged = await call(c, 'create_contact', { email: `new-${T}-4@x.example.net`, tags: [tag.toUpperCase()] });
		expect(tagged.pending).toBe(true);
		const listed = await call(c, 'create_contact', { email: `new-${T}-5@x.example.net`, lists: [l] });
		expect(listed.pending).toBe(true);
		expect(listed.action!.scope!.notes!).toHaveLength(1);
	});

	it('restore_contacts asks when a restored contact matches a trigger segment', async () => {
		const c = await ctx();
		const src = `src-${T}-r`;
		const archived = await contact({ source: src, archived: true });
		const other = await contact({ source: `src-${T}-other`, archived: true });

		// No trigger segment: applies.
		const plain = await call(c, 'restore_contacts', { contact_id: other });
		expect(plain.action?.status).toBe('applied');

		const seg = await segment([{ field: 'source', op: 'is', value: src }]);
		await automation(seg, 'paused');
		const r = await call(c, 'restore_contacts', { contact_id: archived });
		expect(r.pending).toBe(true);
		const notes = r.action!.scope!.notes!;
		expect(notes[0]).toMatch(/^Effect:/);
		expect(notes[1]).toMatch(/paused automation .*1 of these archived contacts matches its rules/);
		expect((await one<{ a: string | null }>('SELECT archived_at AS a FROM contacts WHERE id = ?', archived)).a).not.toBeNull();

		// An archived contact the segment doesn't match restores at once.
		await db.prepare(`UPDATE contacts SET archived_at = datetime('now') WHERE id = ?`).bind(other).run();
		const ok = await call(c, 'restore_contacts', { contact_id: other });
		expect(ok.action?.status).toBe('applied');
		expect(await enrollments()).toBe(0);
	});

	it('update_contact_tier asks for an engagement_tier trigger segment', async () => {
		const c = await ctx();
		const id = await contact();
		const plain = await call(c, 'update_contact_tier', { contact_id: id, tier: 'warm' });
		expect(plain.action?.status).toBe('applied');

		await automation(await segment([{ field: 'engagement_tier', op: 'is', value: 'hot' }]));
		const r = await call(c, 'update_contact_tier', { contact_id: id, tier: 'hot' });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes![1]).toMatch(/Its rules read what this changes/);

		// A segment on something else doesn't make it ask.
		await quiet();
		await automation(await segment([{ field: 'source', op: 'is', value: `nobody-${T}` }]));
		const ok = await call(c, 'update_contact_tier', { contact_id: id, tier: 'hot' });
		expect(ok.action?.status).toBe('applied');
	});

	it('pipeline add / move ask for a pipeline_stage trigger segment; value / note edits never do', async () => {
		const c = await ctx();
		const stages = (await db.prepare(`SELECT id FROM pipeline_stages ORDER BY position, id LIMIT 2`).all<{ id: number }>()).results.map((r) => r.id);
		const [a, b] = stages;
		const id = await contact();
		const plain = await call(c, 'add_pipeline_card', { contact_id: id, stage: String(a) });
		expect(plain.action?.status).toBe('applied');

		await automation(await segment([{ field: 'pipeline_stage', op: 'is', value: String(b) }]));
		const mv = await call(c, 'move_pipeline_card', { contact_id: id, stage: String(b) });
		expect(mv.pending).toBe(true);
		expect(mv.action!.scope!.notes![0]).toMatch(/active automation/);
		expect((await one<{ s: number }>('SELECT stage_id AS s FROM pipeline_cards WHERE contact_id = ?', id)).s).toBe(a);

		// Same stage = no change; value / note don't feed any rule.
		expect((await call(c, 'move_pipeline_card', { contact_id: id, stage: String(a) })).action?.status).toBe('applied');
		expect((await call(c, 'update_pipeline_card', { contact_id: id, value: 500, note: 'n' })).action?.status).toBe('applied');

		const fresh = await contact();
		const add = await call(c, 'add_pipeline_card', { contact_id: fresh, stage: String(b) });
		expect(add.pending).toBe(true);
		expect(await enrollments()).toBe(0);
	});

	it('update_company_fields asks when a rename reaches a company trigger segment; other edits apply', async () => {
		const c = await ctx();
		const name = `Co ${T}`;
		const newName = `Co ${T} renamed`;
		const coId = await newId('INSERT INTO companies (name) VALUES (?) RETURNING id', name);
		await contact({ company: { id: coId, name } });

		const plain = await call(c, 'update_company_fields', { company_id: coId, name: `${name} tmp` });
		expect(plain.action?.status).toBe('applied');
		await call(c, 'update_company_fields', { company_id: coId, name });

		await automation(await segment([{ field: 'company', op: 'is', value: newName }]));
		const r = await call(c, 'update_company_fields', { company_id: coId, name: newName });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes![0]).toMatch(/1 of these contacts is not in it yet/);
		expect((await one<{ name: string }>('SELECT name FROM companies WHERE id = ?', coId)).name).toBe(name);

		// Notes / domain reach no rule.
		const ok = await call(c, 'update_company_fields', { company_id: coId, notes: 'hello', domain: 'acme.test' });
		expect(ok.action?.status).toBe('applied');
	});

	it('update_contact asks for a new email when a spam_complaint trigger segment reads it; a name change applies', async () => {
		const c = await ctx();
		const id = await contact();
		const spamAddr = `spam-${T}@x.example.net`;
		await db.prepare(`INSERT INTO unsubscribes (email, reason) VALUES (?, 'Marked as spam')`).bind(spamAddr).run();
		await automation(await segment([{ field: 'spam_complaint', op: 'yes' }]));

		const r = await call(c, 'update_contact', { contact_id: id, email: spamAddr });
		expect(r.pending).toBe(true);
		const ok = await call(c, 'update_contact', { contact_id: id, first_name: 'Ann' });
		expect(ok.action?.status).toBe('applied');
	});

	it('resubscribe_contacts adds the trigger note when a segment reads subscribed (tier unchanged: approve)', async () => {
		const c = await ctx();
		const id = await contact({ subscribed: 0 });
		const input = { contact_id: id, consent_confirmed: true };

		const plain = await call(c, 'resubscribe_contacts', input);
		expect(plain.pending).toBe(true);
		expect(plain.action!.scope!.notes!.some((n) => /Segment “/.test(n))).toBe(false);

		const seg = await segment([{ field: 'subscribed', op: 'yes' }]);
		await automation(seg);
		const r = await call(c, 'resubscribe_contacts', input);
		expect(r.pending).toBe(true);
		const notes = r.action!.scope!.notes!;
		expect(notes.filter((n) => /Segment “/.test(n))).toHaveLength(1);
		expect(notes.at(-1)).toMatch(/1 of these contacts is not in it yet/);
	});
});

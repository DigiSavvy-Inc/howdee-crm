import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #413: "Added to segment" for rule-based segments — membership polled by the heartbeat.

import { processSegmentTriggers, SEGMENT_TRIGGER_CAP } from '../src/lib/server/segment-trigger';
import { triggerText, type TriggerFields } from '../src/lib/automation-trigger';
import { actions } from '../src/routes/automations/[id]/+page.server';

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM segment_trigger_members'),
		db.prepare('DELETE FROM segment_trigger_state'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare("DELETE FROM app_state WHERE key = 'automation_enroll_queue'"),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;

async function contact(email: string, source = ''): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed, source) VALUES (?, 1, ?) RETURNING id', email, source)).id;
}
const setSource = (id: number, source: string) => db.prepare('UPDATE contacts SET source = ? WHERE id = ?').bind(source, id).run();

/** A dynamic segment: contacts whose source is "vip". */
async function vipSegment(): Promise<number> {
	return (
		await one<{ id: number }>(
			"INSERT INTO lists (name, kind, rules) VALUES ('VIPs', 'segment', ?) RETURNING id",
			JSON.stringify({ match: 'all', rules: [{ field: 'source', op: 'is', value: 'vip' }] })
		)
	).id;
}

async function flow(listId: number, o: { status?: string; reentry?: string } = {}): Promise<number> {
	const id = (
		await one<{ id: number }>(
			"INSERT INTO automations (name, status, trigger_type, trigger_list_id, reentry) VALUES ('Flow', ?, 'list_added', ?, ?) RETURNING id",
			o.status ?? 'active',
			listId,
			o.reentry ?? 'once'
		)
	).id;
	await db
		.prepare("INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds) VALUES (?, 0, 'tag', 'add', 'x', '', '', '', 3600)")
		.bind(id)
		.run();
	return id;
}

const passes = async (aid: number, cid?: number) =>
	(
		await one<{ n: number }>(
			`SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? ${cid ? 'AND contact_id = ?' : ''}`,
			...(cid ? [aid, cid] : [aid])
		)
	).n;
const endPasses = (aid: number) => db.prepare("UPDATE automation_enrollments SET status = 'completed' WHERE automation_id = ?").bind(aid).run();

function ev(aid: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env: { ...(env as any), POSTMARK_FROM: 'alan@ourco.example' } },
		params: { id: String(aid) },
		locals: {},
		request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
	} as any;
}

describe('segment entry polling (#413)', () => {
	it('baselines without enrolling, then enrolls a new entrant exactly once', async () => {
		const seg = await vipSegment();
		const before = await contact('a@x.test', 'vip');
		const A = await flow(seg);

		const first = await processSegmentTriggers(db);
		expect(first.baselined).toBe(1);
		expect(await passes(A)).toBe(0);

		const b = await contact('b@x.test');
		await setSource(b, 'vip');
		const second = await processSegmentTriggers(db);
		expect(second.enrolled).toBe(1);
		expect(await passes(A, b)).toBe(1);
		expect(await passes(A, before)).toBe(0);

		await processSegmentTriggers(db);
		expect(await passes(A, b)).toBe(1);
	});

	it('a leaver who comes back honours the re-entry policy', async () => {
		const seg = await vipSegment();
		const once = await flow(seg, { reentry: 'once' });
		const multi = await flow(seg, { reentry: 'multiple' });
		await processSegmentTriggers(db); // baseline (empty)

		const c = await contact('c@x.test', 'vip');
		await processSegmentTriggers(db);
		expect(await passes(once, c)).toBe(1);
		expect(await passes(multi, c)).toBe(1);
		await endPasses(once);
		await endPasses(multi);

		await setSource(c, 'other');
		const left = await processSegmentTriggers(db);
		expect(left.left).toBe(2);
		await setSource(c, 'vip');
		await processSegmentTriggers(db);
		expect(await passes(once, c)).toBe(1);
		expect(await passes(multi, c)).toBe(2);
	});

	it('caps entrants per tick and takes the rest next tick', async () => {
		const seg = await vipSegment();
		const A = await flow(seg);
		await processSegmentTriggers(db);
		const n = SEGMENT_TRIGGER_CAP + 5;
		for (let i = 0; i < n; i += 500) {
			const emails = Array.from({ length: Math.min(500, n - i) }, (_, k) => `bulk${i + k}@x.test`);
			await db
				.prepare("INSERT INTO contacts (email, subscribed, source) SELECT value, 1, 'vip' FROM json_each(?)")
				.bind(JSON.stringify(emails))
				.run();
		}
		const t1 = await processSegmentTriggers(db);
		expect(t1.entered).toBe(SEGMENT_TRIGGER_CAP);
		expect(t1.deferred).toBe(1);
		expect(await passes(A)).toBe(SEGMENT_TRIGGER_CAP);
		const t2 = await processSegmentTriggers(db);
		expect(t2.entered).toBe(5);
		expect(t2.deferred).toBe(0);
		expect(await passes(A)).toBe(n);
	});

	it('a paused automation records entrants as pending instead of enrolling', async () => {
		const seg = await vipSegment();
		const A = await flow(seg);
		await processSegmentTriggers(db);
		await db.prepare("UPDATE automations SET status = 'paused' WHERE id = ?").bind(A).run();
		const c = await contact('p@x.test', 'vip');
		const r = await processSegmentTriggers(db);
		expect(r.pending).toBe(1);
		expect(await passes(A)).toBe(0);
		const pend = await one<{ contact_id: number; source: string }>('SELECT contact_id, source FROM automation_pending_triggers WHERE automation_id = ?', A);
		expect(pend).toEqual({ contact_id: c, source: 'segment_entered' });
	});

	it('the activate action snapshots without enrolling, with an opt-in offer', async () => {
		const seg = await vipSegment();
		const a = await contact('a@x.test', 'vip');
		const A = await flow(seg, { status: 'draft' });

		const ask: any = await actions.activate(ev(A, {}));
		expect(ask.activateConfirm.segment).toEqual({ name: 'VIPs', members: 1 });
		expect((await one<{ status: string }>('SELECT status FROM automations WHERE id = ?', A)).status).toBe('draft');

		const done: any = await actions.activate(ev(A, { confirm: '1' }));
		expect(done.ok).toBe(true);
		expect(await passes(A)).toBe(0);
		await processSegmentTriggers(db);
		expect(await passes(A, a)).toBe(0);

		// A second flow on the same segment, this time taking the offer.
		const B = await flow(seg, { status: 'draft' });
		const yes: any = await actions.activate(ev(B, { confirm: '1', enroll_existing: '1' }));
		expect(yes.enrolled).toBe(1);
		expect(await passes(B, a)).toBe(1);
	});

	it('says the segment is polled in the trigger summary', () => {
		const a = { trigger_type: 'list_added', trigger_list_id: 7, reentry: 'once' } as TriggerFields;
		const ctx = { lists: [{ id: 7, name: 'VIPs', kind: 'segment', dynamic: 1 }], sites: [], stages: [] };
		expect(triggerText(a, ctx)).toBe('When enters segment “VIPs” (checked every heartbeat)');
		expect(triggerText(a, { ...ctx, lists: [{ id: 7, name: 'VIPs', kind: 'segment' }] })).toBe('When added to segment “VIPs”');
	});
});

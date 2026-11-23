import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #398: recipes (starter flows as specs → drafts), simulate a contact (read-only path),
// subject / content A/B on an email step (variant per pass, stats, manual winner) and the
// pre-activation pre-send checks on every email step.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { enroll, tick } from '../src/lib/server/automations';
import { createFromSpec, pickVariantWinner, readSpec, setStepVariant, validateSpec, type Actor } from '../src/lib/server/automation-write';
import { RECIPES, recipeByKey, recipeStepCount } from '../src/lib/automation-recipes';
import { abLeader, abStats, abVariantFor } from '../src/lib/automation-ab';
import { simulateContact } from '../src/lib/server/automation-simulate';
import { automationPresendChecks } from '../src/lib/server/automation-checks';
import { abTestsFor } from '../src/lib/server/automation-ab';
import { activationProblems } from '../src/lib/server/automation-bulk';
import { actions } from '../src/routes/automations/[id]/+page.server';
import { actions as listActions } from '../src/routes/automations/+page.server';

const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const actor: Actor = { kind: 'system' };
const FROM = 'alan@ourco.example';

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;
const contact = async (email: string, subscribed = 1) =>
	(await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id', email, subscribed)).id;
async function tagged(cid: number, tag: string) {
	const l = await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id", tag);
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(l.id, cid).run();
}
function ev(path: string, params: Record<string, string>, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = new URL(`https://app.test${path}`);
	return {
		platform: { env: { ...(env as any), POSTMARK_FROM: FROM } },
		params,
		url,
		locals: { user: { id: 1, role: 'admin' } },
		request: new Request(url, { method: 'POST', body: fd })
	} as any;
}
const aev = (aid: number, fields: Record<string, string>) => ev(`/automations/${aid}`, { id: String(aid) }, fields);

async function simpleFlow(steps: Parameters<typeof createFromSpec>[1]['steps'], status = 'draft'): Promise<{ id: number; refs: Record<string, number> }> {
	const r = await createFromSpec(db, { name: 'Flow', trigger: { type: 'manual' }, steps }, actor, { defaultFrom: FROM });
	if (!r.ok) throw new Error(r.error);
	await db.prepare('UPDATE automations SET status = ? WHERE id = ?').bind(status, r.data.automation_id).run();
	return { id: r.data.automation_id, refs: r.data.step_ids };
}

describe('recipes', () => {
	it('every recipe is a valid spec, with and without its list / stage', async () => {
		const list = await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id");
		const stage = await one<{ id: number }>("INSERT INTO pipeline_stages (name, color, position, kind) VALUES ('Won-398', 'success', 99, 'won') RETURNING id");
		expect(RECIPES.map((r) => r.key)).toEqual(['welcome-series', 'post-webinar', 're-engagement', 'lead-magnet', 'pipeline-nudge', 'review-request']);
		for (const r of RECIPES) {
			expect(await validateSpec(db, r.spec({}), { defaultFrom: FROM })).toEqual([]);
			expect(await validateSpec(db, r.spec({ list_id: list.id, stage_id: stage.id }), { defaultFrom: FROM })).toEqual([]);
			expect(recipeStepCount(r)).toBeGreaterThan(1);
		}
		expect(recipeByKey('welcome-series')!.spec({ list_id: list.id }).trigger).toEqual({ type: 'list_added', list_id: list.id });
		expect(recipeByKey('welcome-series')!.spec({}).trigger).toEqual({ type: 'manual' });
		expect(recipeByKey('nope')).toBeNull();
		await db.prepare('DELETE FROM pipeline_stages WHERE id = ?').bind(stage.id).run();
	});

	it('?/fromRecipe creates a draft (never active, nobody enrolled) and opens it', async () => {
		const list = await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES ('Signups', 'list') RETURNING id");
		await expect(listActions.fromRecipe(ev('/automations', {}, { recipe: 'welcome-series', list_id: String(list.id) }))).rejects.toMatchObject({
			status: 303
		});
		const a = await one<{ id: number; status: string; trigger_type: string; trigger_list_id: number }>(
			'SELECT id, status, trigger_type, trigger_list_id FROM automations ORDER BY id DESC LIMIT 1'
		);
		expect(a).toMatchObject({ status: 'draft', trigger_type: 'list_added', trigger_list_id: list.id });
		const spec = await readSpec(db, a.id);
		expect(spec.ok && spec.data.steps.length).toBe(3);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments')).n).toBe(0);
		const bad = (await listActions.fromRecipe(ev('/automations', {}, { recipe: 'nope' }))) as { status: number; data: { recipeError: string } };
		expect(bad.status).toBe(400);
	});
});

describe('simulate a contact', () => {
	it('walks the path with live branch decisions and waits as durations, without writing anything', async () => {
		const { id } = await simpleFlow([
			{ type: 'email', ref: 'hi', subject: 'Hi', body_md: 'Hello there, this is the body.' },
			{
				type: 'branch',
				wait_seconds: 2 * 86400,
				condition: { kind: 'tag', name: 'vip' },
				yes: [{ type: 'email', subject: 'VIP only', body_md: 'Welcome VIP.' }],
				no: [{ type: 'tag', tag_action: 'add', tag_name: 'regular' }]
			},
			{ type: 'email', wait_seconds: 3600, subject: 'Bye', body_md: 'See you.' }
		]);
		const vip = await contact('vip@example.com');
		await tagged(vip, 'vip');
		const plain = await contact('plain@example.com');
		const before = await one<{ n: number }>('SELECT (SELECT COUNT(*) FROM automation_enrollments) + (SELECT COUNT(*) FROM recipients) + (SELECT COUNT(*) FROM automation_branch_hits) AS n');

		const a = (await simulateContact(db, id, vip))!;
		expect(a.notes).toEqual([]);
		expect(a.path.map((s) => s.decision)).toEqual(['Sends “Hi”', 'YES', 'Sends “VIP only”', 'Sends “Bye”']);
		expect(a.path[1]).toMatchObject({ wait: 'waits 2 days', at: 'after 2 days' });
		expect(a.path[2].depth).toBe(1);
		expect(a.path[3].at).toBe('after 2 days'); // 2 days + 1 hour rounds to days
		expect(a.end).toMatch(/^Completes after 5\. Bye/);

		const b = (await simulateContact(db, id, plain))!;
		expect(b.path.map((s) => s.decision)).toEqual(['Sends “Hi”', 'NO', 'Adds the tag', 'Sends “Bye”']);

		const after = await one<{ n: number }>('SELECT (SELECT COUNT(*) FROM automation_enrollments) + (SELECT COUNT(*) FROM recipients) + (SELECT COUNT(*) FROM automation_branch_hits) AS n');
		expect(after.n).toBe(before.n);
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await one<{ n: number }>("SELECT COUNT(*) AS n FROM lists WHERE name = 'regular'")).toEqual({ n: 0 });
	});

	it('says why a contact would not be enrolled, follows go-to jumps and stops at End', async () => {
		const { id } = await simpleFlow([
			{ type: 'email', ref: 'one', subject: 'One', body_md: 'Body one.' },
			{ type: 'end' }
		]);
		const gone = await contact('gone@example.com', 0);
		const r = (await simulateContact(db, id, gone))!;
		expect(r.notes[0]).toMatch(/Unsubscribed/);
		expect(r.end).toMatch(/^Ends at 2\. End automation/);
		expect(await simulateContact(db, id, 999999)).toBeNull();
	});
});

describe('A/B test on an email step', () => {
	it('variant is stable per pass and close to 50/50', () => {
		expect(abVariantFor(7, 3)).toBe(abVariantFor(7, 3));
		const bs = Array.from({ length: 1000 }, (_, i) => abVariantFor(i + 1, 42)).filter((v) => v === 'b').length;
		expect(bs).toBeGreaterThan(400);
		expect(bs).toBeLessThan(600);
		expect(abLeader(abStats([{ variant: 'a', sent: 10, opened: 5, clicked: 1 }, { variant: 'b', sent: 10, opened: 4, clicked: 3 }]))).toBe('b');
		expect(abLeader(abStats([{ variant: 'a', sent: 10, opened: 5, clicked: 1 }]))).toBeNull();
	});

	it('sends A or B per pass, records the variant, and the winner becomes the step', async () => {
		const { id, refs } = await simpleFlow([{ type: 'email', ref: 'mail', subject: 'Subject A', body_md: 'Body A text here.' }], 'active');
		const stepId = refs.mail;
		expect((await setStepVariant(db, id, { step_id: stepId, variant: { subject: '' } }, actor)).ok).toBe(false);
		expect((await setStepVariant(db, id, { step_id: stepId, variant: { subject: 'Subject B', body_md: 'Body B text here.' } }, actor)).ok).toBe(true);

		const ids: number[] = [];
		for (let i = 0; i < 20; i++) ids.push(await contact(`ab${i}@example.com`));
		await enroll(db, id, ids);
		await tick(db, cfg as any);
		const sent = spies.sendBatch.mock.calls.flatMap((c) => c[1] as { To: string; Subject: string; HtmlBody: string }[]);
		expect(sent).toHaveLength(20);
		const rows = (await db.prepare('SELECT r.contact_id, r.ab_variant, r.enrollment_id FROM recipients r').all<{ contact_id: number; ab_variant: string; enrollment_id: number }>()).results;
		for (const r of rows) {
			expect(r.ab_variant).toBe(abVariantFor(r.enrollment_id, stepId));
			const email = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', r.contact_id)).email;
			const msg = sent.find((m) => m.To.includes(email))!;
			expect(msg.Subject).toBe(r.ab_variant === 'b' ? 'Subject B' : 'Subject A');
			expect(msg.HtmlBody).toContain(r.ab_variant === 'b' ? 'Body B' : 'Body A');
		}
		const bRow = rows.find((r) => r.ab_variant === 'b')!;
		await db.prepare("INSERT INTO events (type, campaign_id, contact_id, recipient_id) SELECT 'click', campaign_id, contact_id, id FROM recipients WHERE contact_id = ?").bind(bRow.contact_id).run();

		const tests = await abTestsFor(db, id);
		const st = tests[stepId].stats;
		expect(st[0].sent + st[1].sent).toBe(20);
		expect(st[1].clicked).toBe(1);
		expect(tests[stepId]).toMatchObject({ enabled: true, subject_b: 'Subject B', winner: null });

		// The editor's action, then the step sends B to everyone and the campaign row follows.
		await actions.pickWinner(aev(id, { step_id: String(stepId), winner: 'b' }));
		const s = await one<{ subject: string; body_md: string; ab_enabled: number; ab_winner: string }>(
			'SELECT subject, body_md, ab_enabled, ab_winner FROM automation_steps WHERE id = ?',
			stepId
		);
		expect(s).toEqual({ subject: 'Subject B', body_md: 'Body B text here.', ab_enabled: 0, ab_winner: 'b' });
		expect((await one<{ subject: string }>('SELECT subject FROM campaigns WHERE automation_step_id = ?', stepId)).subject).toBe('Subject B');
		expect((await pickVariantWinner(db, id, { step_id: stepId, winner: 'a' }, actor)).ok).toBe(false); // no test running
	});

	it('an enabled test without a variant subject blocks activation', async () => {
		const { id, refs } = await simpleFlow([{ type: 'email', ref: 'mail', subject: 'S', body_md: 'Body text.' }]);
		await db.prepare("UPDATE automation_steps SET ab_enabled = 1, ab_subject = '' WHERE id = ?").bind(refs.mail).run();
		expect((await activationProblems(db, id)).map((p) => p.message).join(' ')).toMatch(/variant B subject/);
	});
});

describe('pre-activation pre-send checks', () => {
	it('checks every email step and variant B; a block stops activation until "Activate anyway"', async () => {
		const { id, refs } = await simpleFlow([
			{ type: 'email', ref: 'ok', subject: 'Fine subject', preheader: 'Preview', body_md: 'A real body with enough words to read well.' },
			{ type: 'email', ref: 'bad', subject: 'Has a fake link', body_md: 'Read [this](https://example.com/page) now.' }
		]);
		await setStepVariant(db, id, { step_id: refs.ok, variant: { subject: 'Hi *|FNAME|*' } }, actor);
		const checks = await automationPresendChecks(db, id);
		expect(checks.steps.map((s) => [s.step_id, s.variant])).toEqual([
			[refs.ok, null],
			[refs.ok, 'b'],
			[refs.bad, null]
		]);
		expect(checks.steps[0].report.blocks).toBe(0);
		expect(checks.steps[1].report.blocks).toBeGreaterThan(0); // Mailchimp merge tag
		expect(checks.steps[2].report.blocks).toBeGreaterThan(0); // example.com placeholder link
		expect(checks.steps.every((s) => s.report.checks.every((c) => c.category !== 'audience'))).toBe(true);

		const stopped = (await actions.activate(aev(id, {}))) as { status: number; data: { activateChecks: { blocks: number; steps: unknown[] } } };
		expect(stopped.status).toBe(400);
		expect(stopped.data.activateChecks.blocks).toBe(checks.blocks);
		expect((await one<{ status: string }>('SELECT status FROM automations WHERE id = ?', id)).status).toBe('draft');

		const ok = (await actions.activate(aev(id, { checks_ok: '1' }))) as { ok: boolean };
		expect(ok.ok).toBe(true);
		expect((await one<{ status: string }>('SELECT status FROM automations WHERE id = ?', id)).status).toBe('active');
	});
});

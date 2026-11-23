import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #460: engagement tier override — precedence (override > unsubscribed-cold > score), expiry,
// `tier_auto`, the "Set engagement tier" automation action (set / clear / skip, unsubscribed
// contacts in a subscription_changed flow), validation + labels, the bulk bar, the assistant
// tool and the Data API.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { normalizeTierOverride, tierActionTitle, tierSourceText } from '../src/lib/tier-override';
import { stepShortTitle, isTierLabel, TIER_CLEARED_LABEL } from '../src/lib/automation-action-labels';
import { computeEngagement, runEngagementJob } from '../src/lib/server/engagement';
import { setTierOverride, tierOverrideStates } from '../src/lib/server/tier-override';
import { engagementProfile } from '../src/lib/server/engagement-query';
import { enroll, tick } from '../src/lib/server/automations';
import { addStep, createAutomation, readSpec, updateStep, createFromSpec } from '../src/lib/server/automation-write';
import { fireSubscriptionTriggers } from '../src/lib/server/subscription-trigger';
import { defaultSubscriptionConfig } from '../src/lib/subscription-trigger';
import { resolveSelection, runBulk, runBulkForm } from '../src/lib/server/contact-bulk';
import { TOOLS, runTool } from '../src/lib/server/ai/tools';
import type { ToolContext } from '../src/lib/server/ai/tools/types';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';
import { actionForUser, undoAction } from '../src/lib/server/ai/actions';
import { toolByName } from '../src/lib/server/ai/tools';
import type { WriteTool } from '../src/lib/server/ai/tools/types';
import { generateApiKey } from '../src/lib/server/api-keys';
import { GET as getContact, PATCH as patchContact } from '../src/routes/api/v1/contacts/[id]/+server';

const db = (env as any).DB as D1Database;
const engineCfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const actor = { kind: 'user' as const, id: 1 };
let seq = 0;

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}
async function contact(subscribed = 1): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id', `t${++seq}-${Date.now()}@tier.test`, subscribed)).id;
}
type Row = { tier: string; tier_auto: string | null; tier_override: string | null; tier_override_until: string | null; tier_override_source: string | null; prev_tier: string | null };
const row = (id: number) => one<Row>('SELECT tier, tier_auto, tier_override, tier_override_until, tier_override_source, prev_tier FROM contact_engagement WHERE contact_id = ?', id);
const dueNow = () => db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE status = 'active'`).run();
const lastDecision = async (enrollmentId: number) =>
	(await one<{ label: string }>('SELECT label FROM automation_branch_hits WHERE enrollment_id = ? ORDER BY decided_at DESC LIMIT 1', enrollmentId)).label;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` })));
	await db.batch([
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE campaigns SET automation_step_id = NULL'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations')
	]);
});

// ── pure ────────────────────────────────────────────────────────────────────────────────

describe('validation + labels', () => {
	it('normalizes a tier, clear and days', () => {
		expect(normalizeTierOverride({ tier: 'Hot' })).toEqual({ ok: true, value: { tier: 'hot', days: null } });
		expect(normalizeTierOverride({ tier: 'cool', days: '30' })).toEqual({ ok: true, value: { tier: 'cool', days: 30 } });
		expect(normalizeTierOverride({ tier: 'clear' })).toEqual({ ok: true, value: { tier: null, days: null } });
		expect(normalizeTierOverride({ tier: null })).toEqual({ ok: true, value: { tier: null, days: null } });
	});
	it('refuses a bad tier and days out of range', () => {
		expect(normalizeTierOverride({ tier: 'lukewarm' }).ok).toBe(false);
		expect(normalizeTierOverride({ tier: 'hot', days: 0 }).ok).toBe(false);
		expect(normalizeTierOverride({ tier: 'hot', days: 366 }).ok).toBe(false);
		expect(normalizeTierOverride({ tier: 'hot', days: 2.5 }).ok).toBe(false);
		expect(normalizeTierOverride({ tier: 'hot', days: 365 }).ok).toBe(true);
	});
	it('titles + labels', () => {
		expect(tierActionTitle('hot', 30)).toBe('Set tier to Hot for 30 days');
		expect(tierActionTitle('cold', null)).toBe('Set tier to Cold');
		expect(tierActionTitle('clear', null)).toBe('Clear tier override');
		expect(stepShortTitle({ type: 'action', action_kind: 'set_tier', target_tier: 'warm', tier_days: 1 })).toBe('Set tier to Warm for 1 day');
		expect(isTierLabel('tier set to «Hot» (until 2026-11-23)')).toBe(true);
		expect(isTierLabel(TIER_CLEARED_LABEL)).toBe(true);
		expect(isTierLabel('skipped: already Hot by override')).toBe(false);
		expect(tierSourceText('automation:4', 'Nurture')).toBe('automation “Nurture”');
		expect(tierSourceText('user:jdoe')).toBe('@jdoe');
	});
});

// ── compute ─────────────────────────────────────────────────────────────────────────────

describe('precedence + expiry', () => {
	it('override > unsubscribed-cold > score; tier_auto tracks the computed tier', async () => {
		const sub = await contact(1);
		const unsub = await contact(0);
		await computeEngagement(db, { contactIds: [sub, unsub] });
		expect(await row(sub)).toMatchObject({ tier: 'new', tier_auto: 'new', tier_override: null });
		expect(await row(unsub)).toMatchObject({ tier: 'cold', tier_auto: 'cold' });

		await setTierOverride(db, [sub, unsub], { tier: 'hot', source: 'user:t' });
		expect(await row(sub)).toMatchObject({ tier: 'hot', tier_auto: 'new', tier_override: 'hot', tier_override_source: 'user:t', prev_tier: 'new' });
		expect(await row(unsub)).toMatchObject({ tier: 'hot', tier_auto: 'cold' });

		// The heartbeat recompute never clobbers an active override.
		await db.prepare('UPDATE contact_engagement SET dirty = 1 WHERE contact_id IN (?, ?)').bind(sub, unsub).run();
		await computeEngagement(db, { contactIds: [sub, unsub] });
		expect((await row(sub)).tier).toBe('hot');
		expect((await row(unsub)).tier).toBe('hot');

		// Clearing goes back to automatic at once.
		const res = await setTierOverride(db, [unsub], { tier: null, source: 'user:t' });
		expect(res.changed).toEqual([unsub]);
		expect(await row(unsub)).toMatchObject({ tier: 'cold', tier_override: null, tier_override_source: null });
	});

	it('an override for N days expires on the recompute after it passes', async () => {
		const id = await contact();
		const t0 = new Date('2026-10-01T12:00:00.000Z');
		const res = await setTierOverride(db, [id], { tier: 'warm', days: 2, source: 'user:t', now: t0 });
		expect(res.until).toBe('2026-10-03T12:00:00.000Z');
		expect(await row(id)).toMatchObject({ tier: 'warm', tier_override_until: '2026-10-03T12:00:00.000Z' });

		await computeEngagement(db, { contactIds: [id], now: new Date('2026-10-02T12:00:00.000Z') });
		expect((await row(id)).tier).toBe('warm');

		await computeEngagement(db, { contactIds: [id], now: new Date('2026-10-04T00:00:00.000Z') });
		expect(await row(id)).toMatchObject({ tier: 'new', tier_auto: 'new', tier_override: null, tier_override_until: null });
	});

	it('the heartbeat job picks up an expired override even when the contact is not dirty', async () => {
		const id = await contact();
		await setTierOverride(db, [id], { tier: 'hot', days: 1, source: 'user:t', now: new Date('2020-01-01T00:00:00.000Z') });
		await db.prepare('UPDATE contact_engagement SET dirty = 0').run();
		await runEngagementJob(db, new Date());
		expect((await row(id)).tier_override).toBeNull();
	});

	it('re-setting the same until-cleared tier changes nothing; with days it refreshes', async () => {
		const id = await contact();
		await setTierOverride(db, [id], { tier: 'cool', source: 'user:t' });
		expect((await setTierOverride(db, [id], { tier: 'cool', source: 'user:t' })).unchanged).toEqual([id]);
		expect((await setTierOverride(db, [id], { tier: 'cool', days: 5, source: 'user:t' })).changed).toEqual([id]);
		expect((await setTierOverride(db, [id], { tier: null, source: 'user:t' })).changed).toEqual([id]);
		expect((await setTierOverride(db, [id], { tier: null, source: 'user:t' })).unchanged).toEqual([id]);
	});

	it('the contact profile shows the override and the automatic tier', async () => {
		const id = await contact();
		await setTierOverride(db, [id], { tier: 'hot', days: 30, source: 'automation:9' });
		const p = await engagementProfile(db, id);
		expect(p).toMatchObject({ tier: 'hot', tier_auto: 'new', tier_override: 'hot', tier_override_source: 'automation:9' });
		expect(p.tier_override_until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

// ── automation action ───────────────────────────────────────────────────────────────────

async function tierFlow(action: Record<string, unknown>, trigger: 'manual' | 'subscription_changed' = 'manual'): Promise<number> {
	const created = await createAutomation(db, { name: `Tier ${++seq}` }, actor);
	if (!created.ok) throw new Error(created.error);
	const aid = created.data.automation_id;
	const step = await addStep(db, aid, { type: 'action', action: { kind: 'set_tier' }, fields: { action: { kind: 'set_tier', ...action } } }, actor);
	if (!step.ok) throw new Error(step.error);
	await db
		.prepare(`UPDATE automations SET status = 'active', trigger_type = ?, trigger_config = ?, reentry = 'multiple' WHERE id = ?`)
		.bind(trigger, trigger === 'subscription_changed' ? JSON.stringify(defaultSubscriptionConfig()) : null, aid)
		.run();
	return aid;
}

async function enrollAndRun(aid: number, cid: number): Promise<number> {
	const r = await enroll(db, aid, [cid]);
	expect(r.enrolled).toBe(1);
	await dueNow();
	await tick(db, engineCfg);
	return (await one<{ id: number }>('SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1', aid, cid)).id;
}

describe('"Set engagement tier" action step', () => {
	it('validates the tier and days on save', async () => {
		const created = await createAutomation(db, { name: 'V' }, actor);
		const aid = (created as any).data.automation_id;
		const bad = await addStep(db, aid, { type: 'action', fields: { action: { kind: 'set_tier', tier: 'lukewarm' } } }, actor);
		expect(bad.ok).toBe(false);
		const days = await addStep(db, aid, { type: 'action', fields: { action: { kind: 'set_tier', tier: 'hot', days: 400 } } }, actor);
		expect(days.ok).toBe(false);
		const none = await addStep(db, aid, { type: 'action', fields: { action: { kind: 'set_tier' } } }, actor);
		expect(none.ok).toBe(false);
		const ok = await addStep(db, aid, { type: 'action', fields: { action: { kind: 'set_tier', tier: 'cold', days: 30 } } }, actor);
		expect(ok.ok).toBe(true);
		const stored = await one<{ action_kind: string; target_tier: string; tier_days: number; ready: number }>(
			'SELECT action_kind, target_tier, tier_days, ready FROM automation_steps WHERE id = ?',
			(ok as any).data.step_id
		);
		expect(stored).toEqual({ action_kind: 'set_tier', target_tier: 'cold', tier_days: 30, ready: 1 });
		// Switching the step to another kind clears the tier columns.
		const sw = await updateStep(db, aid, { step_id: (ok as any).data.step_id, fields: { action: { kind: 'end_all_automations' } } }, actor);
		expect(sw.ok).toBe(true);
		expect(await one('SELECT target_tier, tier_days FROM automation_steps WHERE id = ?', (ok as any).data.step_id)).toEqual({ target_tier: null, tier_days: null });
	});

	it('round-trips through the spec', async () => {
		const r = await createFromSpec(db, { name: 'Spec tier', trigger: { type: 'manual' }, steps: [{ type: 'action', action: { kind: 'set_tier', tier: 'warm', days: 14 } }, { type: 'action', action: { kind: 'set_tier', tier: 'clear' } }] }, actor);
		expect(r.ok).toBe(true);
		const spec = await readSpec(db, (r as any).data.automation_id);
		expect((spec as any).data.steps.map((s: any) => s.action)).toEqual([
			{ kind: 'set_tier', tier: 'warm', days: 14 },
			{ kind: 'set_tier', tier: 'clear', days: null }
		]);
	});

	it('sets, skips when already set, and clears', async () => {
		const cid = await contact();
		const setFlow = await tierFlow({ tier: 'hot', days: 30 });
		const e1 = await enrollAndRun(setFlow, cid);
		expect(await lastDecision(e1)).toMatch(/^tier set to «Hot» \(until \d{4}-\d{2}-\d{2}\)$/);
		expect(await row(cid)).toMatchObject({ tier: 'hot', tier_override_source: `automation:${setFlow}` });

		const keepFlow = await tierFlow({ tier: 'cold' });
		const e2 = await enrollAndRun(keepFlow, cid);
		expect(await lastDecision(e2)).toBe('tier set to «Cold»');
		const e3 = await enrollAndRun(keepFlow, cid);
		expect(await lastDecision(e3)).toBe('skipped: already Cold by override');

		const clearFlow = await tierFlow({ tier: 'clear' });
		const e4 = await enrollAndRun(clearFlow, cid);
		expect(await lastDecision(e4)).toBe(TIER_CLEARED_LABEL);
		expect((await row(cid)).tier_override).toBeNull();
		const e5 = await enrollAndRun(clearFlow, cid);
		expect(await lastDecision(e5)).toBe('skipped: no tier override');
	});

	it('works for an unsubscribed contact in a subscription_changed automation (wins over unsubscribed-cold)', async () => {
		const aid = await tierFlow({ tier: 'warm' }, 'subscription_changed');
		const cid = await contact(0);
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'unsubscribed', source: 'link' });
		await dueNow();
		await tick(db, engineCfg);
		const p = await one<{ id: number; status: string }>('SELECT id, status FROM automation_enrollments WHERE automation_id = ?', aid);
		expect(p.status).toBe('completed');
		expect(await lastDecision(p.id)).toBe('tier set to «Warm»');
		expect(await row(cid)).toMatchObject({ tier: 'warm', tier_auto: 'cold' });
	});
});

// ── bulk, assistant, API ────────────────────────────────────────────────────────────────

describe('bulk bar', () => {
	it('sets and clears for the selection', async () => {
		const a = await contact();
		const b = await contact();
		const sel = await resolveSelection(db, { ids: [a, b] });
		if (!sel.ok) throw new Error(sel.error);
		const out = await runBulk(db, sel, { action: 'set_tier', tier: 'cool', days: 7, source: 'bulk:t' });
		expect(out).toMatchObject({ ok: true, affected: 2 });
		expect(await row(a)).toMatchObject({ tier: 'cool', tier_override_source: 'bulk:t' });

		const fd = new FormData();
		fd.append('contact_ids', String(a));
		fd.append('contact_ids', String(b));
		fd.set('tier', 'clear');
		const cleared = await runBulkForm(db, fd, 'set_tier', { query: () => ({ sql: '', binds: [] }), actor: 'jdoe' });
		expect(cleared).toMatchObject({ ok: true, affected: 2 });
		expect((await row(b)).tier_override).toBeNull();

		fd.set('tier', 'nope');
		expect(await runBulkForm(db, fd, 'set_tier', { query: () => ({ sql: '', binds: [] }) })).toMatchObject({ ok: false, status: 400 });
	});
});

describe('assistant update_contact_tier', () => {
	const LOGIN = `tier-${Date.now()}`;
	let userId = 0;
	beforeAll(async () => {
		userId = (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, LOGIN)).id;
	});
	const user = () => ({ id: userId, github_login: LOGIN, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false }) as any;

	it('is a write tool; sets the tier and Undo restores the previous override', async () => {
		expect((TOOLS.find((t) => t.name === 'update_contact_tier') as WriteTool).tier).toBe('write');
		const threadId = await createThread(db, userId, modelInfo('claude-sonnet-5-5')!.id, 'medium', 'test');
		const ctx: ToolContext = { db, user: user(), baseUrl: 'https://app.test', now: new Date(), threadId };
		const id = await contact();
		await setTierOverride(db, [id], { tier: 'warm', source: 'user:x' });

		const r = await runTool(ctx, 'update_contact_tier', { contact_ids: [id], tier: 'hot', days: 10 }, TOOLS, `tu_${++seq}`);
		expect(r.action).toMatchObject({ status: 'applied', tool: 'update_contact_tier' });
		expect(await row(id)).toMatchObject({ tier: 'hot', tier_override_source: `assistant:${LOGIN}` });

		const action = await actionForUser(db, r.action!.id, userId);
		expect(await undoAction(ctx, action!, toolByName('update_contact_tier') as WriteTool)).toMatchObject({ ok: true });
		expect(await row(id)).toMatchObject({ tier: 'warm', tier_override: 'warm', tier_override_source: 'user:x' });

		const bad = await runTool(ctx, 'update_contact_tier', { contact_ids: [id], tier: 'lukewarm' }, TOOLS, `tu_${++seq}`);
		expect(bad.ok).toBe(false);
	});
});

describe('Data API', () => {
	async function key(): Promise<{ token: string; id: number }> {
		const k = await generateApiKey();
		const r = await one<{ id: number }>(
			`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, 'read_write') RETURNING id`,
			k.tokenHash,
			k.prefix,
			k.last4
		);
		return { token: k.token, id: r.id };
	}
	function ev(id: number, method: string, token: string, body?: unknown) {
		const url = new URL(`https://app.test/api/v1/contacts/${id}`);
		return {
			request: new Request(url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
			platform: { env },
			url,
			params: { id: String(id) }
		} as any;
	}

	it('PATCH sets / clears the override; GET returns tier, tier_auto, tier_override, tier_override_until', async () => {
		const k = await key();
		const id = await contact();
		const res = await patchContact(ev(id, 'PATCH', k.token, { tier_override: 'hot', tier_override_days: 30 }));
		expect(res.status).toBe(200);
		const d = JSON.parse(await res.text()).data;
		expect(d).toMatchObject({ tier: 'hot', tier_auto: 'new', tier_override: 'hot' });
		expect(d.tier_override_until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect((await tierOverrideStates(db, [id])).get(id)?.tier_override_source).toBe(`api:${k.id}`);

		const got = JSON.parse(await (await getContact(ev(id, 'GET', k.token))).text()).data;
		expect(got).toMatchObject({ tier: 'hot', tier_override: 'hot' });

		const clear = JSON.parse(await (await patchContact(ev(id, 'PATCH', k.token, { tier_override: null }))).text()).data;
		expect(clear).toMatchObject({ tier: 'new', tier_auto: 'new', tier_override: null, tier_override_until: null });
	});

	it('PATCH refuses a bad tier / days (400) without writing', async () => {
		const k = await key();
		const id = await contact();
		expect((await patchContact(ev(id, 'PATCH', k.token, { tier_override: 'lukewarm' }))).status).toBe(400);
		expect((await patchContact(ev(id, 'PATCH', k.token, { tier_override: 'hot', tier_override_days: 0 }))).status).toBe(400);
		expect((await patchContact(ev(id, 'PATCH', k.token, { tier_override_days: 3 }))).status).toBe(400);
		expect((await tierOverrideStates(db, [id])).get(id)?.tier_override ?? null).toBeNull();
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #444: the "Subscription changes" (`subscription_changed`) trigger — config, text, matching,
// enroll with allowUnsubscribed, the engine skipping email steps for unsubscribed contacts, the
// `cold` tier override, and every fire point.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import {
	defaultSubscriptionConfig,
	normalizeSubscriptionConfig,
	parseSubscriptionConfig,
	subscriptionMatches,
	subscriptionTriggerText,
	SKIPPED_EMAIL_UNSUBSCRIBED
} from '../src/lib/subscription-trigger';
import { TRIGGER_TYPES, triggerText, type TriggerFields } from '../src/lib/automation-trigger';
import { fireSubscriptionTriggers, saveTopicChoicesAndFire as saveTopicChoices } from '../src/lib/server/subscription-trigger';
import { enroll, tick } from '../src/lib/server/automations';
import { computeEngagement, tierFor } from '../src/lib/server/engagement';
import { unsubscribeAll } from '../src/lib/server/unsubscribe';
import { bulkResubscribe, bulkUnsubscribe, resolveSelection } from '../src/lib/server/contact-bulk';
import { readSpec, setTrigger, storedTriggerProblem } from '../src/lib/server/automation-write';
import { POST as webhook } from '../src/routes/api/webhook/+server';

const db = (env as any).DB as D1Database;
const engineCfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };

// ── pure ────────────────────────────────────────────────────────────────────────────────

describe('subscription_changed config', () => {
	it('defaults to unsubscribed, any topic, any source', () => {
		expect(defaultSubscriptionConfig()).toEqual({ events: ['unsubscribed'], topic_list_id: null, sources: [] });
		expect(normalizeSubscriptionConfig({})).toEqual({ ok: true, config: defaultSubscriptionConfig() });
	});
	it('orders + dedupes events and sources, accepts a string topic id', () => {
		const r = normalizeSubscriptionConfig({ events: ['topic_optout', 'unsubscribed', 'unsubscribed'], topic_list_id: '4', sources: ['postmark', 'link'] });
		expect(r).toEqual({ ok: true, config: { events: ['unsubscribed', 'topic_optout'], topic_list_id: 4, sources: ['link', 'postmark'] } });
	});
	it('refuses empty / unknown events, unknown sources, a bad topic', () => {
		expect(normalizeSubscriptionConfig({ events: [] }).ok).toBe(false);
		expect(normalizeSubscriptionConfig({ events: ['deleted'] }).ok).toBe(false);
		expect(normalizeSubscriptionConfig({ events: 'unsubscribed' }).ok).toBe(false);
		expect(normalizeSubscriptionConfig({ sources: ['carrier-pigeon'] }).ok).toBe(false);
		expect(normalizeSubscriptionConfig({ topic_list_id: 0 }).ok).toBe(false);
	});
	it('parse is lenient: unknown entries dropped, junk → defaults', () => {
		expect(parseSubscriptionConfig(JSON.stringify({ events: ['bounced', 'nope'], sources: ['x', 'api'] }))).toEqual({
			events: ['bounced'],
			topic_list_id: null,
			sources: ['api']
		});
		expect(parseSubscriptionConfig(JSON.stringify({ events: ['nope'] }))).toEqual(defaultSubscriptionConfig());
		expect(parseSubscriptionConfig('not json')).toEqual(defaultSubscriptionConfig());
		expect(parseSubscriptionConfig(null)).toEqual(defaultSubscriptionConfig());
	});
	it('matches by event, topic and source', () => {
		const cfg = { events: ['unsubscribed', 'topic_optout'] as const, topic_list_id: 7, sources: ['link'] as const };
		const c = { ...cfg, events: [...cfg.events], sources: [...cfg.sources] };
		expect(subscriptionMatches(c, { event: 'unsubscribed', source: 'link' })).toBe(true);
		expect(subscriptionMatches(c, { event: 'unsubscribed', source: 'manual' })).toBe(false);
		expect(subscriptionMatches(c, { event: 'unsubscribed' })).toBe(false);
		expect(subscriptionMatches(c, { event: 'topic_optout', listId: 7 })).toBe(true);
		expect(subscriptionMatches(c, { event: 'topic_optout', listId: 8 })).toBe(false);
		expect(subscriptionMatches(c, { event: 'resubscribed' })).toBe(false);
		expect(subscriptionMatches({ ...c, topic_list_id: null }, { event: 'topic_optout', listId: 8 })).toBe(true);
		expect(subscriptionMatches({ ...c, sources: [] }, { event: 'unsubscribed', source: 'postmark' })).toBe(true);
	});
	it('text', () => {
		const name = (id: number) => (id === 7 ? 'Newsletter' : null);
		expect(subscriptionTriggerText(defaultSubscriptionConfig(), name)).toBe('When a contact unsubscribes');
		expect(subscriptionTriggerText({ events: ['unsubscribed', 'bounced'], topic_list_id: null, sources: ['link', 'preference_center'] }, name)).toBe(
			'When a contact unsubscribes (unsubscribe link, preference page) or hard-bounces'
		);
		expect(subscriptionTriggerText({ events: ['topic_optout'], topic_list_id: 7, sources: [] }, name)).toBe('When a contact opts out of topic “Newsletter”');
		expect(subscriptionTriggerText({ events: ['complained', 'topic_optin'], topic_list_id: null, sources: [] }, name)).toBe(
			'When a contact marks an email as spam or opts in to a topic'
		);
	});
	it('the picker has the ninth card; triggerText reads trigger_config', () => {
		expect(TRIGGER_TYPES.length).toBeGreaterThanOrEqual(9); // #467 added score_changed after it
		expect(TRIGGER_TYPES[8]).toMatchObject({
			type: 'subscription_changed',
			label: 'Subscription changes',
			description: 'When a contact unsubscribes, resubscribes, bounces, complains or opts out of a topic'
		});
		const a: TriggerFields = {
			trigger_type: 'subscription_changed',
			trigger_list_id: null,
			trigger_metric: null,
			trigger_direction: null,
			trigger_threshold: null,
			trigger_site_id: null,
			trigger_path_op: null,
			trigger_path: null,
			trigger_cooldown_hours: null,
			trigger_stage_id: null,
			trigger_config: JSON.stringify({ events: ['resubscribed'] }),
			reentry: 'once'
		};
		expect(triggerText(a, { lists: [], sites: [], stages: [] })).toBe('When a contact resubscribes');
	});
	it('tierFor: unsubscribed → cold whatever the score', () => {
		const input = { sentCount: 5, firstSentAt: null, lastEngagedAt: '2026-10-01 00:00:00' };
		expect(tierFor(95, input)).toBe('hot');
		expect(tierFor(95, { ...input, subscribed: false })).toBe('cold');
		expect(tierFor(0, { sentCount: 0, firstSentAt: null, lastEngagedAt: null, subscribed: false })).toBe('cold');
		expect(tierFor(95, { ...input, subscribed: true })).toBe('hot');
	});
});

// ── D1 ───────────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE campaigns SET automation_step_id = NULL'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM topic_optouts'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function contact(email: string, subscribed = 1): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id').bind(email, subscribed).first<{ id: number }>())!.id;
}

type Step = { type: 'tag' | 'email'; tag?: string };

async function automation(cfg: Record<string, unknown>, steps: Step[] = [{ type: 'tag', tag: 'lost' }], o: { status?: string; trigger?: string } = {}) {
	const id = (await db
		.prepare(`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry) VALUES ('Subs', ?, ?, ?, 'multiple') RETURNING id`)
		.bind(o.status ?? 'active', o.trigger ?? 'subscription_changed', JSON.stringify({ ...defaultSubscriptionConfig(), ...cfg }))
		.first<{ id: number }>())!.id;
	let pos = 0;
	for (const s of steps) {
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
				 VALUES (?, ?, ?, 'add', ?, ?, ?, 'alan@ourco.example', 0)`
			)
			.bind(id, pos++, s.type, s.tag ?? null, s.type === 'email' ? 'Hello' : '', s.type === 'email' ? 'Body' : '')
			.run();
	}
	return id;
}

const passes = async (aid: number) =>
	(await db.prepare('SELECT id, contact_id, status FROM automation_enrollments WHERE automation_id = ? ORDER BY id').bind(aid).all<{ id: number; contact_id: number; status: string }>())
		.results;
const hasTag = async (cid: number, tag: string) =>
	!!(await db
		.prepare(`SELECT 1 FROM list_members m JOIN lists l ON l.id = m.list_id WHERE l.kind = 'tag' AND l.name = ? AND m.contact_id = ?`)
		.bind(tag, cid)
		.first());
const dueNow = () => db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE status = 'active'`).run();

describe('fireSubscriptionTriggers', () => {
	it('enrolls an unsubscribed contact (allowUnsubscribed) only when the event matches', async () => {
		const aid = await automation({ events: ['unsubscribed', 'bounced'] });
		const cid = await contact('u@x.test', 0);
		expect((await fireSubscriptionTriggers(db, { contactId: cid, event: 'resubscribed' })).enrolled).toBe(0);
		expect((await fireSubscriptionTriggers(db, { contactId: cid, event: 'bounced' })).enrolled).toBe(1);
		expect(await passes(aid)).toHaveLength(1);
		// already in an active pass → skipped by enroll()
		expect((await fireSubscriptionTriggers(db, { contactId: cid, event: 'unsubscribed', source: 'link' })).enrolled).toBe(0);
	});

	it('topic and source filters', async () => {
		const topic = (await db.prepare(`INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id`).first<{ id: number }>())!.id;
		const byTopic = await automation({ events: ['topic_optout'], topic_list_id: topic });
		const bySource = await automation({ events: ['unsubscribed'], sources: ['postmark'] });
		const cid = await contact('t@x.test');
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'topic_optout', listId: topic + 100 });
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'unsubscribed', source: 'link' });
		expect(await passes(byTopic)).toHaveLength(0);
		expect(await passes(bySource)).toHaveLength(0);
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'topic_optout', listId: topic });
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'unsubscribed', source: 'postmark' });
		expect(await passes(byTopic)).toHaveLength(1);
		expect(await passes(bySource)).toHaveLength(1);
	});

	it('draft automations are ignored, paused ones record pending triggers, other kinds never fire', async () => {
		const draft = await automation({}, undefined, { status: 'draft' });
		const paused = await automation({}, undefined, { status: 'paused' });
		const manual = await automation({}, undefined, { trigger: 'manual' });
		const cid = await contact('p@x.test', 0);
		const s = await fireSubscriptionTriggers(db, { contactId: cid, event: 'unsubscribed', source: 'link' });
		expect(s).toEqual({ matched: 0, enrolled: 0, pending: 1 });
		expect(await passes(draft)).toHaveLength(0);
		expect(await passes(manual)).toHaveLength(0);
		const pend = await db.prepare('SELECT contact_id FROM automation_pending_triggers WHERE automation_id = ?').bind(paused).all();
		expect(pend.results).toEqual([{ contact_id: cid }]);
	});

	it('enroll() still refuses unsubscribed contacts without the flag, and archived ones with it', async () => {
		const aid = await automation({});
		const u = await contact('nope@x.test', 0);
		const arch = await contact('arch@x.test', 0);
		await db.prepare(`UPDATE contacts SET archived_at = datetime('now') WHERE id = ?`).bind(arch).run();
		expect((await enroll(db, aid, [u])).enrolled).toBe(0);
		expect((await enroll(db, aid, [u, arch], { allowUnsubscribed: true })).enrolled).toBe(1);
	});

	it('entry rules still apply', async () => {
		const aid = await automation({});
		await db
			.prepare('UPDATE automations SET entry_rules = ? WHERE id = ?')
			.bind(JSON.stringify({ match: 'all', rules: [{ field: 'email', op: 'ends', value: '@vip.test' }] }), aid)
			.run();
		const a = await contact('a@vip.test', 0);
		const b = await contact('b@other.test', 0);
		await fireSubscriptionTriggers(db, { contactIds: [a, b], event: 'unsubscribed', source: 'manual' });
		expect((await passes(aid)).map((p) => p.contact_id)).toEqual([a]);
	});
});

describe('engine', () => {
	it('an unsubscribed contact runs the tag step, then the email step ends the pass without sending', async () => {
		const aid = await automation({}, [{ type: 'tag', tag: 'unsubbed' }, { type: 'email' }, { type: 'tag', tag: 'after' }]);
		const cid = await contact('e@x.test', 0);
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'unsubscribed', source: 'link' });
		await dueNow();
		await tick(db, engineCfg);
		expect(await hasTag(cid, 'unsubbed')).toBe(true);
		await dueNow();
		await tick(db, engineCfg);
		const [p] = await passes(aid);
		expect(p.status).toBe('completed');
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await hasTag(cid, 'after')).toBe(false);
		const ev = await db
			.prepare(`SELECT kind, detail FROM automation_enrollment_events WHERE enrollment_id = ? ORDER BY id DESC LIMIT 1`)
			.bind(p.id)
			.first<{ kind: string; detail: string }>();
		expect(ev).toEqual({ kind: 'completed', detail: SKIPPED_EMAIL_UNSUBSCRIBED });
	});

	it('a resubscribed contact gets the email as usual', async () => {
		const aid = await automation({ events: ['resubscribed'] }, [{ type: 'email' }]);
		const cid = await contact('r@x.test', 1);
		await fireSubscriptionTriggers(db, { contactId: cid, event: 'resubscribed' });
		await dueNow();
		await tick(db, engineCfg);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		expect((await passes(aid))[0].status).toBe('completed');
	});

	it('every other trigger type still cancels an unsubscribed contact before any step', async () => {
		const aid = await automation({}, [{ type: 'tag', tag: 'x' }], { trigger: 'manual' });
		const cid = await contact('m@x.test', 1);
		await enroll(db, aid, [cid]);
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(cid).run();
		await dueNow();
		await tick(db, engineCfg);
		expect((await passes(aid))[0].status).toBe('cancelled');
		expect(await hasTag(cid, 'x')).toBe(false);
	});
});

describe('engagement tier follows subscription', () => {
	it('cold when unsubscribed, the score tier back after resubscribe', async () => {
		const cid = await contact('hot@x.test', 1);
		const camp = (await db.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('S', 'B', '<p>B</p>', 'alan@ourco.example', 'sent', datetime('now')) RETURNING id`).first<{ id: number }>())!.id;
		await db.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'hot@x.test', 'accepted')`).bind(camp, cid).run();
		for (let i = 0; i < 4; i++) {
			await db.prepare(`INSERT INTO events (campaign_id, contact_id, type, recorded_at) VALUES (?, ?, 'click', datetime('now'))`).bind(camp, cid).run();
		}
		await computeEngagement(db, { contactIds: [cid] });
		const tier = async () => (await db.prepare('SELECT tier, score FROM contact_engagement WHERE contact_id = ?').bind(cid).first<{ tier: string; score: number }>())!;
		expect((await tier()).tier).toBe('hot');
		const sel = await resolveSelection(db, { ids: [cid] });
		if (!sel.ok) throw new Error('selection');
		await bulkUnsubscribe(db, sel);
		const after = await tier();
		expect(after.tier).toBe('cold');
		expect(after.score).toBeGreaterThan(60);
		await bulkResubscribe(db, sel);
		expect((await tier()).tier).toBe('hot');
	});
});

// #542: a bounce / complaint only suppresses an address we sent that MessageID to.
let sentSeq = 0;
async function sentTo(email: string): Promise<string> {
	const cid = (await db.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'alan@ourco.example', 'sent') RETURNING id`).first<{ id: number }>())!.id;
	const mid = `pm-${++sentSeq}`;
	await db
		.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, (SELECT id FROM contacts WHERE email = ?), ?, ?, 'accepted')")
		.bind(cid, email, email, mid)
		.run();
	return mid;
}

describe('fire points', () => {
	it('unsubscribeAll fires once (link), a repeat does not', async () => {
		const aid = await automation({ events: ['unsubscribed'], sources: ['link'] });
		const cid = await contact('link@x.test');
		const payload = { e: 'link@x.test', c: null, k: cid } as any;
		await unsubscribeAll(db, {}, payload, 'Too many emails', null);
		await unsubscribeAll(db, {}, payload, 'Too many emails', null);
		expect(await passes(aid)).toHaveLength(1);
	});

	it('preference page: preference_center source', async () => {
		const link = await automation({ events: ['unsubscribed'], sources: ['link'] });
		const pref = await automation({ events: ['unsubscribed'], sources: ['preference_center'] });
		const cid = await contact('pref@x.test');
		await unsubscribeAll(db, {}, { e: 'pref@x.test', c: null, k: cid } as any, 'preferences', null, { source: 'preference_center' });
		expect(await passes(link)).toHaveLength(0);
		expect(await passes(pref)).toHaveLength(1);
	});

	function hook(payload: object) {
		return webhook({
			platform: { env: { ...env, WEBHOOK_KEY: 'test-key' } },
			url: new URL('https://app.test/api/webhook?key=test-key'),
			request: new Request('https://app.test/api/webhook', { method: 'POST', body: JSON.stringify(payload) })
		} as any);
	}

	it('webhook hard bounce → bounced + unsubscribed (postmark); spam → complained', async () => {
		const bounced = await automation({ events: ['bounced'] });
		const unsub = await automation({ events: ['unsubscribed'], sources: ['postmark'] });
		const complained = await automation({ events: ['complained'] });
		const b = await contact('bounce@x.test');
		const s = await contact('spam@x.test');
		await hook({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'bounce@x.test', MessageID: await sentTo('bounce@x.test') });
		await hook({ RecordType: 'SpamComplaint', Email: 'spam@x.test', MessageID: await sentTo('spam@x.test') });
		expect((await passes(bounced)).map((p) => p.contact_id)).toEqual([b]);
		expect((await passes(unsub)).map((p) => p.contact_id).sort()).toEqual([b, s].sort());
		expect((await passes(complained)).map((p) => p.contact_id)).toEqual([s]);
	});

	it('bulk unsubscribe (manual) does not cancel this kind of pass; bulk resubscribe fires resubscribed', async () => {
		const unsub = await automation({ events: ['unsubscribed'], sources: ['manual'] }, [{ type: 'tag', tag: 'a' }, { type: 'tag', tag: 'b' }]);
		const resub = await automation({ events: ['resubscribed'] });
		const other = await automation({}, [{ type: 'tag', tag: 'z' }], { trigger: 'manual' });
		const cid = await contact('bulk@x.test');
		await enroll(db, other, [cid]);
		const sel = await resolveSelection(db, { ids: [cid] });
		if (!sel.ok) throw new Error('selection');
		await bulkUnsubscribe(db, sel);
		expect((await passes(unsub)).map((p) => p.status)).toEqual(['active']);
		expect((await passes(other)).map((p) => p.status)).toEqual(['cancelled']);
		await bulkResubscribe(db, sel);
		expect(await passes(resub)).toHaveLength(1);
		await bulkResubscribe(db, sel); // already subscribed → no second fire
		expect(await passes(resub)).toHaveLength(1);
	});

	it('topic opt-out / opt-in fire only on a real change', async () => {
		const topic = (await db.prepare(`INSERT INTO lists (name, kind, public_topic) VALUES ('News', 'list', 1) RETURNING id`).first<{ id: number }>())!.id;
		const out = await automation({ events: ['topic_optout'], topic_list_id: topic });
		const inn = await automation({ events: ['topic_optin'] });
		const cid = await contact('topic@x.test');
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(topic, cid).run();
		await saveTopicChoices(db, cid, [topic], new Set([topic])); // still in → nothing
		expect(await passes(out)).toHaveLength(0);
		expect(await passes(inn)).toHaveLength(0);
		await saveTopicChoices(db, cid, [topic], new Set());
		expect(await passes(out)).toHaveLength(1);
		await saveTopicChoices(db, cid, [topic], new Set()); // not a member any more → nothing
		expect(await passes(out)).toHaveLength(1);
		await saveTopicChoices(db, cid, [topic], new Set([topic]));
		expect(await passes(inn)).toHaveLength(1);
	});
});

describe('write layer', () => {
	it('setTrigger validates + stores the config; readSpec round-trips; a missing topic is refused', async () => {
		const aid = await automation({}, [{ type: 'tag', tag: 'x' }], { status: 'draft' });
		const topic = (await db.prepare(`INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id`).first<{ id: number }>())!.id;
		const bad = await setTrigger(db, aid, { type: 'subscription_changed', events: [] } as any, { kind: 'system' });
		expect(bad.ok).toBe(false);
		const missing = await setTrigger(db, aid, { type: 'subscription_changed', events: ['topic_optout'], topic_list_id: topic + 99 }, { kind: 'system' });
		expect(missing.ok).toBe(false);
		const ok = await setTrigger(db, aid, { type: 'subscription_changed', events: ['topic_optout', 'unsubscribed'], topic_list_id: topic, sources: ['api'] }, { kind: 'system' });
		expect(ok.ok).toBe(true);
		const spec = await readSpec(db, aid);
		expect(spec.ok && spec.data.trigger).toMatchObject({ type: 'subscription_changed', events: ['unsubscribed', 'topic_optout'], topic_list_id: topic, sources: ['api'] });
		const row = await db.prepare('SELECT * FROM automations WHERE id = ?').bind(aid).first<any>();
		expect(await storedTriggerProblem(db, row)).toBeNull();
		await db.prepare('DELETE FROM lists WHERE id = ?').bind(topic).run();
		expect(await storedTriggerProblem(db, row)).toBe('That topic list no longer exists.');
	});
});

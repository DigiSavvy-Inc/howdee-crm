import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #414: curated preference-page topics (public label + blurb, never internal names), an
// honest footer, `?/preferences` that never silently resubscribes and unsubscribes when
// everything is unticked, and topic opt-outs that hold across lists, hand-picked and
// dynamic segments, the scheduler, pre-send checks and automation step emails.
// Postmark is stubbed: nothing here sends or suppresses for real.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), suppress: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), suppress: spies.suppress, sendBatch: vi.fn() }));

import {
	PREFERENCES_REASON,
	cleanTopicFields,
	looksInternalName,
	parseTopicChoice,
	topicDisplay,
	topicLayout,
	topicWarnings
} from '../src/lib/topics';
import { campaignTopicId, publicTopics, resolveTopicId, saveTopicChoices, topicAdminRows } from '../src/lib/server/topics';
import { recipientsForList } from '../src/lib/server/segments';
import { audienceCount, recipientsForAudience, writeAudience } from '../src/lib/server/campaign-audience';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import { runPresendChecks } from '../src/lib/server/presend-checks';
import { enroll, tick } from '../src/lib/server/automations';
import { TOPIC_OPTED_OUT } from '../src/lib/automation-action-labels';
import { signUnsub } from '../src/lib/server/token';
import { saveUnsubPage } from '../src/lib/server/unsubscribe-page';
import { DEFAULT_UNSUB_PAGE } from '../src/lib/unsubscribe-page';
import { actions as pageActions, load as pageLoad } from '../src/routes/unsubscribe/+page.server';
import { load as previewLoad } from '../src/routes/unsubscribe/preview/+page.server';
import { actions as settingsActions, load as settingsLoad } from '../src/routes/settings/unsubscribe/+page.server';
import { actions as listActions } from '../src/routes/lists/[id]/+page.server';

const viewSource = (
	import.meta.glob('../src/lib/components/UnsubscribeView.svelte', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
)['../src/lib/components/UnsubscribeView.svelte'];

const db = (env as any).DB as D1Database;
const SECRET = 'topics-414-secret';
const cfg = { token: 't', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };

const id = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
const sentEmails = (call = 0) => (spies.sendCampaignEmail.mock.calls[call][1].recipients as { email: string }[]).map((r) => r.email).sort();

let newsletter: number, events: number, archived: number, plain: number, handSeg: number, dynSeg: number;
let ann: number, bob: number, cat: number;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockImplementation(async (_db: unknown, o: { recipients: unknown[] }) => ({
		accepted: o.recipients.length,
		failed: 0,
		firstError: null,
		results: []
	}));
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_automation_id = NULL, target_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM topic_optouts'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key = 'unsubscribe_page'")
	]);
	ann = await id("INSERT INTO contacts (email, subscribed, source) VALUES ('ann@x.example.net', 1, 'web') RETURNING id");
	bob = await id("INSERT INTO contacts (email, subscribed, source) VALUES ('bob@x.example.net', 1, 'web') RETURNING id");
	cat = await id("INSERT INTO contacts (email, subscribed, source) VALUES ('cat@x.example.net', 1, 'event') RETURNING id");
	newsletter = await id(
		`INSERT INTO lists (name, kind, description, origin, public_topic, topic_label, topic_blurb, topic_order)
		 VALUES ('zz-old · NL import', 'list', 'INTERNAL DESCRIPTION', 'you signed up at ourco.example', 1, 'Monthly newsletter', 'One email a month', 1) RETURNING id`
	);
	events = await id(
		`INSERT INTO lists (name, kind, public_topic, topic_label, topic_blurb, topic_order)
		 VALUES ('Events 2026', 'list', 1, 'Event invites', NULL, 0) RETURNING id`
	);
	archived = await id(
		`INSERT INTO lists (name, kind, public_topic) VALUES ('zz-archived · Claude guests 2026-06-24 — [merged] into Claude Meetup Guests', 'list', 1) RETURNING id`
	);
	plain = await id("INSERT INTO lists (name, kind, public_topic, topic_order) VALUES ('Product updates', 'list', 1, 2) RETURNING id");
	handSeg = await id("INSERT INTO lists (name, kind, origin) VALUES ('Seg · Interest · Memberships', 'segment', 'you asked about memberships') RETURNING id");
	dynSeg = await id(
		"INSERT INTO lists (name, kind, rules) VALUES ('Seg · Web', 'segment', ?) RETURNING id",
		JSON.stringify({ match: 'all', rules: [{ field: 'source', op: 'is', value: 'web' }] })
	);
	const member = db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)');
	await db.batch([
		member.bind(newsletter, ann),
		member.bind(newsletter, bob),
		member.bind(events, ann),
		member.bind(handSeg, ann),
		member.bind(handSeg, bob),
		member.bind(handSeg, cat)
	]);
});

function pageEvent(action: string, fields: [string, string][]) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	return {
		request: new Request(`https://app.test/unsubscribe?/${action}`, { method: 'POST', body: fd }),
		platform: { env: { DB: db, SESSION_SECRET: SECRET } }
	} as any;
}
async function loadFor(email: string, contactId: number, campaignId: number | null) {
	const t = await signUnsub(SECRET, { e: email, c: campaignId, k: contactId });
	const data: any = await pageLoad({
		url: new URL(`https://app.test/unsubscribe?t=${encodeURIComponent(t)}`),
		platform: { env: { DB: db, SESSION_SECRET: SECRET } },
		setHeaders: () => undefined
	} as any);
	return { data, token: t };
}
const subscribedOf = async (cid: number) => (await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(cid).first<{ subscribed: number }>())!.subscribed;
const optOut = (cid: number, lid: number) => db.prepare('INSERT INTO topic_optouts (contact_id, list_id) VALUES (?, ?)').bind(cid, lid).run();

describe('public wording', () => {
	it('internal names are recognised', () => {
		for (const n of ['zz-archived · Claude guests', 'ZZ old list', '[merged] into Claude Meetup Guests (list 1)', 'Seg · Interest · Memberships', 'Archived 2024', ''])
			expect(looksInternalName(n), n).toBe(true);
		for (const n of ['Newsletter', 'Product updates', 'Pasadena AI Meetup']) expect(looksInternalName(n), n).toBe(false);
	});

	it('label + blurb only; a missing label falls back to a clean name, else the topic is skipped', () => {
		expect(topicDisplay({ name: 'zz-x', topic_label: 'News', topic_blurb: ' Monthly ' })).toEqual({ label: 'News', blurb: 'Monthly' });
		expect(topicDisplay({ name: 'Product updates', topic_label: null, topic_blurb: null })).toEqual({ label: 'Product updates', blurb: null });
		expect(topicDisplay({ name: 'zz-archived · Claude guests', topic_label: '  ', topic_blurb: 'x' })).toBeNull();
		expect(topicWarnings({ name: 'zz-archived · a', topic_label: null, topic_blurb: null, members: 0 })).toEqual(['archived', 'no_label', 'empty']);
		expect(topicWarnings({ name: 'News', topic_label: 'News', topic_blurb: null, members: 3 })).toEqual([]);
	});

	it('fields are trimmed and capped; order is a small integer', () => {
		const f = cleanTopicFields({ label: 'x'.repeat(60), blurb: '  a   b  ', order: '3' });
		expect(f).toEqual({ topic_label: 'x'.repeat(40), topic_blurb: 'a b', topic_order: 3 });
		expect(cleanTopicFields({ label: '', blurb: '', order: 'nope' })).toEqual({ topic_label: null, topic_blurb: null, topic_order: null });
		expect(parseTopicChoice('')).toBeNull();
		expect(parseTopicChoice('0')).toBe(0);
		expect(parseTopicChoice('12')).toBe(12);
	});

	it('the page lists topics in order with label/blurb, never name/description, archived skipped', async () => {
		const topics = await publicTopics(db, ann);
		expect(topics).toEqual([
			{ id: events, label: 'Event invites', blurb: null, subscribed: true },
			{ id: newsletter, label: 'Monthly newsletter', blurb: 'One email a month', subscribed: true },
			{ id: plain, label: 'Product updates', blurb: null, subscribed: false }
		]);
		const json = JSON.stringify(topics);
		expect(json).not.toContain('zz-');
		expect(json).not.toContain('INTERNAL DESCRIPTION');
		expect(json).not.toContain('[merged]');
	});

	it('the view renders label + blurb and never a list name or description', () => {
		expect(viewSource).toContain('{t.label}');
		expect(viewSource).toContain('{t.blurb}');
		expect(viewSource).not.toMatch(/t\.name|t\.description|listName/);
	});

	it('the preview uses the same topics', async () => {
		const data: any = await previewLoad({ locals: { user: { id: 1, role: 'admin' } }, platform: { env: { DB: db } }, setHeaders: () => undefined } as any);
		expect(data.topics.map((t: any) => t.label)).toEqual(['Event invites', 'Monthly newsletter', 'Product updates']);
		expect(data.topics.every((t: any) => t.subscribed)).toBe(true);
	});
});

describe('layouts', () => {
	it('0 topics hide the block, 1 shows two buttons, 2+ the checkbox list', () => {
		expect(topicLayout(0)).toBe('none');
		expect(topicLayout(1)).toBe('one');
		expect(topicLayout(3)).toBe('many');
		expect(viewSource).toContain('data-topic-layout="one"');
		expect(viewSource).toContain('Keep receiving {topics[0].label}');
		expect(viewSource).toContain('data-topic-layout="many"');
		expect(viewSource).toContain('Save preferences');
		// The reason + comment are optional and collapsed.
		expect(viewSource.indexOf('<details>')).toBeLessThan(viewSource.indexOf('name="reason"'));
		// Compliance order (#374) holds: unsubscribe everything comes first.
		expect(viewSource.indexOf('data-unsub-button')).toBeLessThan(viewSource.indexOf('action="?/preferences"'));
	});
});

describe('footer', () => {
	it('a segment audience shows only its consent note, never the segment name', async () => {
		const c = await id("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id) VALUES ('S', 'x', 'x', 'a@b.example.net', 'sent', ?) RETURNING id", handSeg);
		await writeAudience(db, c, { include: [handSeg], exclude: [] });
		const { data } = await loadFor('ann@x.example.net', ann, c);
		expect(data.footerTopic).toBeNull();
		expect(data.listOrigin).toBe('you asked about memberships');
		expect(JSON.stringify(data)).not.toContain('Seg ·');
	});

	it('a topic audience shows the topic label (never the internal list name)', async () => {
		const c = await id("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id) VALUES ('N', 'x', 'x', 'a@b.example.net', 'sent', ?) RETURNING id", newsletter);
		await writeAudience(db, c, { include: [newsletter], exclude: [] });
		const { data } = await loadFor('ann@x.example.net', ann, c);
		expect(data.footerTopic).toBe('Monthly newsletter');
		expect(data.listOrigin).toBe('you signed up at ourco.example');
		expect(JSON.stringify(data)).not.toContain('zz-old');
	});

	it('an archived-looking topic without a label is never named', async () => {
		const c = await id("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id) VALUES ('A', 'x', 'x', 'a@b.example.net', 'sent', ?) RETURNING id", archived);
		const { data } = await loadFor('ann@x.example.net', ann, c);
		expect(data.footerTopic).toBeNull();
		expect(JSON.stringify(data)).not.toContain('zz-archived');
	});
});

describe('?/preferences', () => {
	it('every topic unticked = unsubscribe from everything, reason "preferences", member topics opted out', async () => {
		const { token } = await loadFor('ann@x.example.net', ann, null);
		const res: any = await pageActions.preferences(pageEvent('preferences', [['token', token]]));
		expect(res).toEqual({ success: true, email: 'ann@x.example.net' });
		expect(await subscribedOf(ann)).toBe(0);
		const u = await db.prepare("SELECT reason FROM unsubscribes WHERE email = 'ann@x.example.net'").all<{ reason: string }>();
		expect(u.results.map((r) => r.reason)).toEqual([PREFERENCES_REASON]);
		const outs = await db.prepare('SELECT list_id FROM topic_optouts WHERE contact_id = ? ORDER BY list_id').bind(ann).all<{ list_id: number }>();
		expect(outs.results.map((r) => r.list_id)).toEqual([newsletter, events].sort((a, b) => a - b));
		expect(spies.suppress).not.toHaveBeenCalled(); // no Postmark token here
	});

	it('unticking one topic writes an opt-out and removes membership; re-ticking clears it', async () => {
		const { token } = await loadFor('ann@x.example.net', ann, null);
		let res: any = await pageActions.preferences(pageEvent('preferences', [['token', token], ['topic', String(events)]]));
		expect(res).toMatchObject({ prefsSaved: true, kept: 1, stillUnsubscribed: false });
		expect(await db.prepare('SELECT 1 FROM list_members WHERE list_id = ? AND contact_id = ?').bind(newsletter, ann).first()).toBeNull();
		expect(await db.prepare('SELECT 1 FROM topic_optouts WHERE list_id = ? AND contact_id = ?').bind(newsletter, ann).first()).not.toBeNull();
		// A topic they were never in stays as it was (no opt-out).
		expect(await db.prepare('SELECT 1 FROM topic_optouts WHERE list_id = ? AND contact_id = ?').bind(plain, ann).first()).toBeNull();

		res = await pageActions.preferences(pageEvent('preferences', [['token', token], ['topic', String(events)], ['topic', String(newsletter)]]));
		expect(res).toMatchObject({ prefsSaved: true, kept: 2 });
		expect(await db.prepare('SELECT 1 FROM topic_optouts WHERE list_id = ? AND contact_id = ?').bind(newsletter, ann).first()).toBeNull();
		expect(await db.prepare('SELECT 1 FROM list_members WHERE list_id = ? AND contact_id = ?').bind(newsletter, ann).first()).not.toBeNull();
		expect(await subscribedOf(ann)).toBe(1);
	});

	it('never silently resubscribes an opted-out contact', async () => {
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(ann).run();
		const { token, data } = await loadFor('ann@x.example.net', ann, null);
		expect(data.subscribed).toBe(false);
		const res: any = await pageActions.preferences(pageEvent('preferences', [['token', token], ['topic', String(newsletter)]]));
		expect(res).toMatchObject({ prefsSaved: true, stillUnsubscribed: true });
		expect(await subscribedOf(ann)).toBe(0);
	});

	it('"Resubscribe me" works only while the page allows it', async () => {
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(ann).run();
		const { token } = await loadFor('ann@x.example.net', ann, null);
		const fields: [string, string][] = [['token', token], ['topic', String(newsletter)], ['resubscribe', '1']];
		let res: any = await pageActions.preferences(pageEvent('preferences', fields));
		expect(res.status).toBe(400);
		expect(await subscribedOf(ann)).toBe(0);
		await saveUnsubPage(db, { ...DEFAULT_UNSUB_PAGE, resubscribe: true });
		res = await pageActions.preferences(pageEvent('preferences', fields));
		expect(res).toMatchObject({ prefsSaved: true, stillUnsubscribed: false });
		expect(await subscribedOf(ann)).toBe(1);
	});

	it('a forged token changes nothing', async () => {
		const res: any = await pageActions.preferences(pageEvent('preferences', [['token', 'forged.token']]));
		expect(res.status).toBe(400);
		expect(await subscribedOf(ann)).toBe(1);
	});
});

describe('opt-outs hold', () => {
	beforeEach(async () => {
		// Bob unticked the newsletter.
		await saveTopicChoices(db, bob, [newsletter, events, plain], new Set());
	});

	it('the topic list itself, a hand-picked segment and a dynamic segment all skip bob for that topic', async () => {
		expect((await recipientsForList(db, newsletter, { topicId: newsletter })).map((r) => r.email)).toEqual(['ann@x.example.net']);
		const hand = await recipientsForList(db, handSeg, { topicId: newsletter });
		expect(hand.map((r) => r.email).sort()).toEqual(['ann@x.example.net', 'cat@x.example.net']);
		const dyn = await recipientsForList(db, dynSeg, { topicId: newsletter });
		expect(dyn.map((r) => r.email).sort()).toEqual(['ann@x.example.net']);
		// Another topic (or none) still reaches him.
		expect((await recipientsForList(db, handSeg, { topicId: events })).map((r) => r.email).sort()).toEqual(['ann@x.example.net', 'bob@x.example.net', 'cat@x.example.net']);
		expect((await recipientsForList(db, dynSeg)).map((r) => r.email).sort()).toEqual(['ann@x.example.net', 'bob@x.example.net']);
		expect(await audienceCount(db, { include: [handSeg, dynSeg], exclude: [] }, { topicId: newsletter })).toBe(2);
		expect((await recipientsForAudience(db, { include: [handSeg], exclude: [] }, { topicId: newsletter })).length).toBe(2);
	});

	it('the topic: explicit, none, or automatic from the first included topic list', async () => {
		expect(await resolveTopicId(db, null, { include: [newsletter, handSeg], exclude: [] })).toBe(newsletter);
		expect(await resolveTopicId(db, null, { include: [handSeg, newsletter], exclude: [] })).toBeNull();
		expect(await resolveTopicId(db, 0, { include: [newsletter], exclude: [] })).toBeNull();
		expect(await resolveTopicId(db, newsletter, { include: [handSeg], exclude: [] })).toBe(newsletter);
	});

	it('a scheduled send to a segment with the newsletter topic skips him', async () => {
		const c = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, scheduled_at, topic_list_id) VALUES ('T', 'x', 'x', 'a@b.example.net', 'scheduled', ?, datetime('now', '-1 minute'), ?) RETURNING id",
			handSeg,
			newsletter
		);
		await writeAudience(db, c, { include: [handSeg], exclude: [] });
		expect(await campaignTopicId(db, c)).toBe(newsletter);
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		expect(sentEmails()).toEqual(['ann@x.example.net', 'cat@x.example.net']);
	});

	it('a scheduled send to the topic list (automatic topic) skips him; "no topic" does not', async () => {
		const auto = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, scheduled_at) VALUES ('A', 'x', 'x', 'a@b.example.net', 'scheduled', ?, datetime('now', '-1 minute')) RETURNING id",
			handSeg
		);
		await writeAudience(db, auto, { include: [newsletter, handSeg], exclude: [] });
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		expect(sentEmails(0)).toEqual(['ann@x.example.net', 'cat@x.example.net']);

		const none = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, scheduled_at, topic_list_id) VALUES ('B', 'x', 'x', 'a@b.example.net', 'scheduled', ?, datetime('now', '-1 minute'), 0) RETURNING id",
			handSeg
		);
		await writeAudience(db, none, { include: [newsletter, handSeg], exclude: [] });
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		expect(sentEmails(1)).toEqual(['ann@x.example.net', 'bob@x.example.net', 'cat@x.example.net']);
	});

	it('pre-send checks say how many were skipped', async () => {
		const r = await runPresendChecks(db, {
			subject: 'Hi',
			preheader: 'p',
			body: { blocks: null, md: 'Hello there, ' + 'words '.repeat(60) },
			templateId: null,
			audience: { include: [handSeg], exclude: [] },
			topicId: newsletter
		});
		const skip = r.checks.find((c) => c.id === 'audience.topic_optout');
		expect(skip).toMatchObject({ level: 'pass', title: '1 recipient skipped: opted out of Monthly newsletter' });
		expect(r.checks.find((c) => c.id === 'audience.count')?.title).toBe('2 recipients');

		const none = await runPresendChecks(db, {
			subject: 'Hi',
			preheader: 'p',
			body: { blocks: null, md: 'Hello there, ' + 'words '.repeat(60) },
			templateId: null,
			audience: { include: [handSeg], exclude: [] },
			topicId: 0
		});
		expect(none.checks.find((c) => c.id === 'audience.topic_optout')).toBeUndefined();
	});

	it('automation step emails inherit the automation topic: an opted-out contact skips the email, the flow goes on', async () => {
		const a = await id("INSERT INTO automations (name, status, reentry, topic_list_id) VALUES ('Drip', 'active', 'once', ?) RETURNING id", newsletter);
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
				 VALUES (?, 0, 0, 'Hello', 'Body text', 'alan@ourco.example', 'email')`
			)
			.bind(a)
			.run();
		await enroll(db, a, [ann, bob]);
		await tick(db, cfg);
		const sentTo = spies.sendCampaignEmail.mock.calls.flatMap((c) => (c[1].recipients as { email: string }[]).map((r) => r.email));
		expect(sentTo).toEqual(['ann@x.example.net']);
		const bobPass = await db
			.prepare('SELECT status, last_error FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?')
			.bind(a, bob)
			.first<{ status: string; last_error: string }>();
		expect(bobPass).toEqual({ status: 'completed', last_error: TOPIC_OPTED_OUT });
	});
});

describe('admin', () => {
	const admin = { id: 1, role: 'admin' };

	it('list details store the public label, blurb and order (lists only)', async () => {
		const ev = (listId: number, fields: [string, string][]) => {
			const fd = new FormData();
			for (const [k, v] of fields) fd.append(k, v);
			return { params: { id: String(listId) }, platform: { env: { DB: db } }, locals: { user: admin }, request: new Request('https://app.test/x', { method: 'POST', body: fd }) } as any;
		};
		const res: any = await listActions.updateMeta(
			ev(plain, [['description', 'internal'], ['public_topic', 'on'], ['topic_label', ' Product news '], ['topic_blurb', 'b'.repeat(200)], ['topic_order', '5']])
		);
		expect(res).toEqual({ metaOk: true });
		const row = await db.prepare('SELECT public_topic, topic_label, topic_blurb, topic_order FROM lists WHERE id = ?').bind(plain).first();
		expect(row).toEqual({ public_topic: 1, topic_label: 'Product news', topic_blurb: 'b'.repeat(120), topic_order: 5 });
		// A segment can't become a topic.
		await listActions.updateMeta(ev(handSeg, [['public_topic', 'on'], ['topic_label', 'Nope']]));
		expect(await db.prepare('SELECT public_topic, topic_label FROM lists WHERE id = ?').bind(handSeg).first()).toEqual({ public_topic: 0, topic_label: null });
	});

	it('Settings → Topics: warnings, counts, reorder (admin-only)', async () => {
		const rows = await topicAdminRows(db);
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get(archived)?.warnings).toEqual(['archived', 'no_label', 'empty']);
		expect(byId.get(newsletter)).toMatchObject({ members: 2, label: 'Monthly newsletter' });

		const ev = (user: any, order: string) => {
			const fd = new FormData();
			fd.set('order', order);
			return { locals: { user }, platform: { env: { DB: db } }, request: new Request('https://app.test/settings/unsubscribe?/reorderTopics', { method: 'POST', body: fd }) } as any;
		};
		await expect(settingsActions.reorderTopics(ev({ id: 2, role: 'member' }, `${plain}`))).rejects.toMatchObject({ status: 403 });
		expect(await settingsActions.reorderTopics(ev(admin, `${plain},${newsletter},${events},${handSeg}`))).toEqual({ topicsSaved: true });
		expect((await publicTopics(db, null)).map((t) => t.id)).toEqual([plain, newsletter, events]);
		// The segment is not a topic and was left alone.
		expect((await db.prepare('SELECT topic_order FROM lists WHERE id = ?').bind(handSeg).first<{ topic_order: number | null }>())!.topic_order).toBeNull();

		const data: any = await settingsLoad({ locals: { user: admin }, platform: { env: { DB: db } } } as any);
		expect(data.topics.map((t: any) => t.id)).toEqual([plain, newsletter, events, archived]);
	});
});

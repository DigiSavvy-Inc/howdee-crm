import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	defaultSuggestionsConfig,
	normalizeSuggestionsConfig,
	suggestionsConfigProblems,
	shortDate,
	type SuggestionsConfig
} from '../src/lib/suggestions';
import {
	awaitingReply,
	coldMembers,
	evidenceHash,
	formNoFollowup,
	groupUnmailed,
	hotEngagement,
	isInternalGroupName,
	quietAfterReply,
	stalledDeal,
	type RuleContext
} from '../src/lib/server/suggestions/rules';
import { runSuggestions, pruneSuggestions } from '../src/lib/server/suggestions/engine';
import { CONFIG_KEY, PASS_KEY, RULES_AT_KEY, requestSuggestionsPass } from '../src/lib/server/suggestions/config';
import { listVisibleSuggestions, suggestionViewer, viewOf, visibleSuggestion } from '../src/lib/server/suggestions/visibility';
import { listedThreads } from '../src/lib/server/conversations';

// #712: Suggestions 1/5 — rules and storage, no AI.
const db = (env as any).DB as D1Database;
const DAY = 86_400_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString().slice(0, 19).replace('T', ' ');

function cfg(over: (c: SuggestionsConfig) => void = () => {}): SuggestionsConfig {
	const c = defaultSuggestionsConfig();
	c.enabled = true;
	over(c);
	return c;
}
function ctx(c: SuggestionsConfig = cfg()): RuleContext {
	let t: ReturnType<typeof listedThreads> | null = null;
	return { db, cfg: c, now, threads: () => (t ??= listedThreads(db)) };
}
async function setConfig(c: SuggestionsConfig | Record<string, unknown>) {
	await db
		.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(CONFIG_KEY, JSON.stringify(c))
		.run();
}
async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}
async function contact(email: string, first: string, opts: { subscribed?: number; archived?: boolean; pending?: number } = {}) {
	return id(
		`INSERT INTO contacts (email, first_name, last_name, subscribed, confirm_pending, archived_at) VALUES (?, ?, 'Example', ?, ?, ?) RETURNING id`,
		email,
		first,
		opts.subscribed ?? 1,
		opts.pending ?? 0,
		opts.archived ? ago(DAY) : null
	);
}
async function reply(contactId: number, email: string, at: string, subject = 'Pricing question') {
	return id(`INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, ?, ?, 'Hi there', ?) RETURNING id`, contactId, email, subject, at);
}
/** A sent campaign; `listId` null = a 1:1 (personal) send. */
async function campaign(subject: string, at: string, listId: number | null, opts: { status?: string } = {}) {
	return id(
		`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at, created_at)
		 VALUES (?, 'b', '<p>b</p>', ?, 'me@ourco.example', ?, ?, ?) RETURNING id`,
		subject,
		listId,
		opts.status ?? 'sent',
		at,
		at
	);
}
async function sendTo(campaignId: number, contactId: number, email: string) {
	return id(
		`INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, ?, ?, 'accepted') RETURNING id`,
		campaignId,
		contactId,
		email,
		`m-${campaignId}-${contactId}`
	);
}
async function list(name: string, kind = 'list', members: number[] = []) {
	const l = await id(`INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id`, name, kind);
	for (const m of members) await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(l, m).run();
	return l;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM suggestions'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'suggestions_%'`),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM mail_message_contacts'),
		db.prepare('DELETE FROM mail_messages'),
		db.prepare('DELETE FROM mail_threads'),
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM score_points'),
		db.prepare('DELETE FROM form_submissions'),
		db.prepare('DELETE FROM forms'),
		db.prepare('DELETE FROM webhook_events'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM users WHERE id <> 1`)
	]);
});

describe('config', () => {
	it('defaults: off, every kind and rule on, the documented thresholds', () => {
		const d = defaultSuggestionsConfig();
		expect(d.enabled).toBe(false);
		expect(d.kinds).toEqual({ follow_up: true, campaign: true, marketing: true });
		expect(d.rules.awaiting_reply).toEqual({ on: true, hours: 48 });
		expect(d.rules.quiet_after_reply.days).toBe(14);
		expect(d.rules.hot_engagement).toEqual({ on: true, points: 10, clicks: 2, visit_days: 2, quiet_days: 30 });
		expect(d.rules.form_no_followup.days).toBe(3);
		expect(d.rules.stalled_deal.days).toBe(21);
		expect(d.rules.group_unmailed).toEqual({ on: true, min_members: 25, days: 30 });
		expect(d.rules.cold_members.campaigns).toBe(5);
		expect(d.cooldown_days).toBe(30);
		expect(d.daily_cap).toBe(25);
		expect(d.audience).toBe('admins');
	});
	it('reads leniently and clamps; the save check names the range', () => {
		const c = normalizeSuggestionsConfig({ enabled: true, rules: { awaiting_reply: { hours: 9999 }, stalled_deal: { on: false } }, daily_cap: 'x' });
		expect(c.enabled).toBe(true);
		expect(c.rules.awaiting_reply.hours).toBe(720);
		expect(c.rules.stalled_deal.on).toBe(false);
		expect(c.daily_cap).toBe(25);
		expect(normalizeSuggestionsConfig('junk').enabled).toBe(false);
		expect(suggestionsConfigProblems({ rules: { awaiting_reply: { hours: 0 } }, daily_cap: 500 })).toEqual([
			{ path: 'rules.awaiting_reply.hours', message: 'Use a whole number from 1 to 720.' },
			{ path: 'daily_cap', message: 'Use a whole number from 1 to 200.' }
		]);
		expect(suggestionsConfigProblems(defaultSuggestionsConfig())).toEqual([]);
	});
	it('wording uses dates, not elapsed time', () => {
		expect(shortDate('2026-11-20 15:04:00')).toBe('Nov 20');
	});
});

describe('rules', () => {
	it('awaiting_reply: waiting longer than the limit, active contacts only', async () => {
		const ana = await contact('ana@ourco.example', 'Ana');
		const new1 = await contact('ben@ourco.example', 'Ben');
		const unsub = await contact('cy@ourco.example', 'Cy', { subscribed: 0 });
		const arch = await contact('di@ourco.example', 'Di', { archived: true });
		const pend = await contact('ed@ourco.example', 'Ed', { subscribed: 0, pending: 1 });
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		await reply(new1, 'ben@ourco.example', ago(3_600_000)); // 1 hour: too new
		await reply(unsub, 'cy@ourco.example', ago(3 * DAY));
		await reply(arch, 'di@ourco.example', ago(3 * DAY));
		await reply(pend, 'ed@ourco.example', ago(3 * DAY));
		const out = await awaitingReply(ctx());
		expect(out.map((c) => c.subject_id).sort()).toEqual([ana, pend].sort());
		const a = out.find((c) => c.subject_id === ana)!;
		expect(a.kind).toBe('follow_up');
		expect(a.title).toBe('Reply to Ana Example');
		expect(a.why).toMatch(/^Ana Example wrote on \w{3} \d+ and is waiting on us\.$/);
		expect(a.action.type).toBe('reply');
		expect(a.action.url).toMatch(/^\/conversations\/.+\?reply=1$/);
		expect(a.evidence[0]).toMatchObject({ id: 'e1', type: 'conversation', label: 'Pricing question' });
		expect(a.assigned_user_id).toBeNull();
	});

	it('quiet_after_reply: replied before, our last personal email unanswered for N days', async () => {
		const ana = await contact('ana@ourco.example', 'Ana');
		const ben = await contact('ben@ourco.example', 'Ben');
		const cy = await contact('cy@ourco.example', 'Cy');
		await reply(ana, 'ana@ourco.example', ago(40 * DAY), 'Hello');
		await sendTo(await campaign('Re: Hello', ago(20 * DAY), null), ana, 'ana@ourco.example');
		await reply(ben, 'ben@ourco.example', ago(40 * DAY), 'Hello');
		await sendTo(await campaign('Re: Hello', ago(5 * DAY), null), ben, 'ben@ourco.example'); // too recent
		await reply(cy, 'cy@ourco.example', ago(40 * DAY), 'Hello');
		await sendTo(await campaign('Re: Hello', ago(30 * DAY), null), cy, 'cy@ourco.example');
		await reply(cy, 'cy@ourco.example', ago(25 * DAY), 'Re: Hello'); // they answered
		const out = await quietAfterReply(ctx());
		expect(out.map((c) => c.subject_id)).toEqual([ana]);
		expect(out[0].title).toBe('Check in with Ana Example');
		expect(out[0].action.type).toBe('email_them');
	});

	it('hot_engagement: score, clicks or visit days — and no personal email lately', async () => {
		const ana = await contact('ana@ourco.example', 'Ana');
		const ben = await contact('ben@ourco.example', 'Ben');
		const cy = await contact('cy@ourco.example', 'Cy');
		const di = await contact('di@ourco.example', 'Di');
		const ed = await contact('ed@ourco.example', 'Ed', { archived: true });
		const lead = (await db.prepare(`SELECT id FROM score_defs WHERE slug = 'lead-score'`).first<{ id: number }>())!.id;
		const pts = (c: number, n: number, at: string, src: string) =>
			db.prepare(`INSERT INTO score_points (score_id, contact_id, points, source_type, source_id, earned_at) VALUES (?, ?, ?, 'manual', ?, ?)`).bind(lead, c, n, src, at).run();
		await pts(ana, 12, ago(2 * DAY), 'a1');
		await pts(ed, 50, ago(2 * DAY), 'e1');
		await pts(di, 4, ago(2 * DAY), 'd1'); // not enough
		const camp = await campaign('News', ago(10 * DAY), null);
		for (const at of [ago(3 * DAY), ago(2 * DAY)]) {
			await db.prepare(`INSERT INTO events (campaign_id, contact_id, type, recorded_at) VALUES (?, ?, 'click', ?)`).bind(camp, ben, at).run();
		}
		const site = await id(`INSERT INTO tracking_sites (name, domain, site_key) VALUES ('Site', 'ourco.example', 'dsv_712') RETURNING id`);
		const threeDays = ago(3 * DAY);
		for (const at of [ago(DAY), threeDays, threeDays]) {
			await db.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, path, occurred_at) VALUES (?, ?, 'pageview', 'pageview', '/pricing', ?)`).bind(site, cy, at).run();
		}
		// Fy has had a personal email 10 days ago → drops out despite the points.
		const c2 = await contact('fy@ourco.example', 'Fy');
		await pts(c2, 20, ago(DAY), 'f1');
		await sendTo(await campaign('Hi Fy', ago(10 * DAY), null), c2, 'fy@ourco.example');
		const out = await hotEngagement(ctx());
		expect(out.map((c) => c.subject_id).sort()).toEqual([ana, ben, cy].sort());
		expect(out.find((c) => c.subject_id === ana)!.evidence[0]).toMatchObject({ type: 'score', label: 'Lead score +12 in 7 days' });
		expect(out.find((c) => c.subject_id === ben)!.evidence[0]).toMatchObject({ type: 'clicks', label: '2 campaign clicks in 14 days' });
		expect(out.find((c) => c.subject_id === cy)!.evidence[0]).toMatchObject({ type: 'site_visits', label: 'Visited the site on 2 days in 7' });
	});

	it('form_no_followup: app form or webhook submission, no personal email since, after N days', async () => {
		const ana = await contact('ana@ourco.example', 'Ana');
		const ben = await contact('ben@ourco.example', 'Ben');
		const cy = await contact('cy@ourco.example', 'Cy');
		const di = await contact('di@ourco.example', 'Di');
		const form = await id(`INSERT INTO forms (name, slug, status, spec) VALUES ('Contact us', 'contact-712', 'published', '{}') RETURNING id`);
		const sub = (c: number, at: string, status = 'added') =>
			db.prepare(`INSERT INTO form_submissions (form_id, contact_id, status, answers, created_at) VALUES (?, ?, ?, '{}', ?)`).bind(form, c, status, at).run();
		await sub(ana, ago(5 * DAY));
		await sub(ben, ago(DAY)); // too new
		await sub(cy, ago(5 * DAY), 'spam');
		await sub(di, ago(5 * DAY));
		await sendTo(await campaign('Thanks', ago(4 * DAY), null), di, 'di@ourco.example'); // followed up
		const web = await contact('ed@ourco.example', 'Ed');
		await db.prepare(`INSERT INTO webhook_events (email, status, created_at) VALUES ('ED@ourco.example ', 'updated', ?)`).bind(ago(4 * DAY)).run();
		const out = await formNoFollowup(ctx());
		expect(out.map((c) => c.subject_id).sort()).toEqual([ana, web].sort());
		const a = out.find((c) => c.subject_id === ana)!;
		expect(a.why).toMatch(/filled in “Contact us”/);
		expect(a.evidence[0].url).toBe(`/forms/${form}?tab=submissions`);
		expect(out.find((c) => c.subject_id === web)!.evidence[0].label).toBe('Website form');
	});

	it('stalled_deal: open stage longer than N days, assigned to the owner', async () => {
		const ana = await contact('ana@ourco.example', 'Ana');
		const ben = await contact('ben@ourco.example', 'Ben');
		const cy = await contact('cy@ourco.example', 'Cy', { subscribed: 0 });
		const stage = (kind: string) => db.prepare(`SELECT id FROM pipeline_stages WHERE kind = ? ORDER BY position LIMIT 1`).bind(kind).first<{ id: number }>();
		const open = (await stage('open'))!.id;
		const won = (await stage('won'))!.id;
		const deal = await id(`INSERT INTO pipeline_cards (contact_id, stage_id, owner_user_id, entered_stage_at) VALUES (?, ?, 1, ?) RETURNING id`, ana, open, ago(30 * DAY));
		await db.prepare(`INSERT INTO pipeline_cards (contact_id, stage_id, entered_stage_at) VALUES (?, ?, ?)`).bind(ben, won, ago(60 * DAY)).run();
		await db.prepare(`INSERT INTO pipeline_cards (contact_id, stage_id, entered_stage_at) VALUES (?, ?, ?)`).bind(cy, open, ago(60 * DAY)).run();
		const out = await stalledDeal(ctx());
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ subject_type: 'deal', subject_id: deal, assigned_user_id: 1, kind: 'follow_up' });
		expect(out[0].action.type).toBe('open_deal');
	});

	it('group_unmailed: active members only, no recent or scheduled campaign, internal tags skipped', async () => {
		const a = await contact('a@ourco.example', 'A');
		const b = await contact('b@ourco.example', 'B');
		const u1 = await contact('u1@ourco.example', 'U', { subscribed: 0 });
		const u2 = await contact('u2@ourco.example', 'V', { archived: true });
		const c = cfg((x) => (x.rules.group_unmailed.min_members = 2));
		const quiet = await list('Newsletter', 'list', [a, b]);
		const recent = await list('Customers', 'list', [a, b]);
		await campaign('Hello customers', ago(5 * DAY), recent);
		const small = await list('Mostly gone', 'list', [a, u1, u2]); // 1 active member
		await list('hygiene:invalid', 'tag', [a, b]);
		const sched = await list('Upcoming', 'list', [a, b]);
		await campaign('Soon', ago(0), sched, { status: 'scheduled' });
		const archived = await list('Old', 'list', [a, b]);
		await db.prepare(`UPDATE lists SET archived_at = datetime('now') WHERE id = ?`).bind(archived).run();
		const stale = await list('Stale', 'tag', [a, b]);
		await campaign('Long ago', ago(60 * DAY), stale);
		const out = await groupUnmailed(ctx(c));
		expect(out.map((x) => x.subject_id).sort()).toEqual([quiet, stale].sort());
		expect(out.find((x) => x.subject_id === quiet)!.why).toBe("Newsletter has 2 active members and hasn't had a campaign yet.");
		expect(out.find((x) => x.subject_id === stale)!.kind).toBe('campaign');
		expect(small).toBeTruthy();
		expect(isInternalGroupName('excluded: VIP')).toBe(true);
		expect(isInternalGroupName('Newsletter')).toBe(false);
	});

	it('cold_members: more than half of the reached active members opened none of the last N', async () => {
		const [a, b, c, d] = [
			await contact('a@ourco.example', 'A'),
			await contact('b@ourco.example', 'B'),
			await contact('c@ourco.example', 'C'),
			await contact('d@ourco.example', 'D', { subscribed: 0 })
		];
		const conf = cfg((x) => {
			x.rules.group_unmailed.min_members = 2;
			x.rules.cold_members.campaigns = 2;
		});
		const cold = await list('Cold list', 'list', [a, b, c, d]);
		const warm = await list('Warm list', 'list', [a, b, c]);
		for (const [g, opened] of [
			[cold, [a]],
			[warm, [a, b]]
		] as [number, number[]][]) {
			for (const days of [20, 10]) {
				const camp = await campaign(`To ${g} ${days}`, ago(days * DAY), g);
				for (const m of [a, b, c, d]) await sendTo(camp, m, `x${m}@ourco.example`);
				for (const m of opened) await db.prepare(`INSERT INTO events (campaign_id, contact_id, type) VALUES (?, ?, 'open')`).bind(camp, m).run();
			}
		}
		const out = await coldMembers(ctx(conf));
		expect(out.map((x) => x.subject_id)).toEqual([cold]);
		expect(out[0].kind).toBe('marketing');
		// The unsubscribed member is neither counted nor cold.
		expect(out[0].evidence[0].label).toBe('2 of 3 active members opened none of the last 2 campaigns');
		expect(out[0].action.more!.map((m) => m.type)).toEqual(['move_to_automation', 'see_cold']);
	});

	it('the evidence hash ignores labels and time, only identities', async () => {
		const e = [{ id: 'e1', type: 'conversation', label: 'A', url: null, at: '2026-01-01', ref: 'conv:x:1' }];
		expect(await evidenceHash(e)).toBe(await evidenceHash([{ ...e[0], label: 'B', at: '2027-01-01' }]));
		expect(await evidenceHash(e)).not.toBe(await evidenceHash([{ ...e[0], ref: 'conv:x:2' }]));
	});
});

describe('engine', () => {
	async function rows() {
		return (await db.prepare('SELECT * FROM suggestions ORDER BY id').all<Record<string, any>>()).results;
	}

	it('off (the default) does no work at all', async () => {
		const ana = await contact('ana@ourco.example', 'Ana');
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		expect(await runSuggestions(db)).toMatchObject({ off: true });
		expect(await rows()).toEqual([]);
		expect(await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(RULES_AT_KEY).first()).toBeNull();
	});

	it('inserts, dedupes, refreshes on new evidence and closes when the condition is gone', async () => {
		await setConfig(cfg());
		const ana = await contact('ana@ourco.example', 'Ana');
		const r1 = await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		const first = await runSuggestions(db, { now });
		expect(first).toMatchObject({ created: 1, pass_complete: true });
		const [row] = await rows();
		expect(row).toMatchObject({ kind: 'follow_up', rule: 'awaiting_reply', subject_type: 'contact', subject_id: ana, status: 'open', cost_micros: 0, model: null });
		expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);

		// Hourly: not due again; forced: same evidence → nothing written, still one row.
		expect(await runSuggestions(db, { now })).toMatchObject({ skipped: 'not_due' });
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 0, updated: 0 });
		expect(await rows()).toHaveLength(1);

		// A second waiting conversation is new evidence → refreshed in place.
		await reply(ana, 'ana@ourco.example', ago(2 * DAY), 'Another topic');
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 0, updated: 1 });
		const [after] = await rows();
		expect(after.id).toBe(row.id);
		expect(after.input_hash).not.toBe(row.input_hash);

		// The condition goes away → closed by the rules (no cooldown).
		await db.prepare('DELETE FROM replies WHERE contact_id = ?').bind(ana).run();
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ closed: 1 });
		expect((await rows())[0]).toMatchObject({ status: 'done', closed_by: 'rules' });
		expect(r1).toBeTruthy();
		// It comes back at once when the condition returns.
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 1 });
	});

	it('dismissed stays quiet for the cooldown unless the evidence changes', async () => {
		await setConfig(cfg());
		const ana = await contact('ana@ourco.example', 'Ana');
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		await runSuggestions(db, { now, force: true });
		await db.prepare(`UPDATE suggestions SET status = 'dismissed', closed_by = 'user', closed_by_user_id = 1, closed_at = ?`).bind(ago(DAY)).run();
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 0, cooldown: 1 });
		// After the cooldown it may come back.
		await db.prepare(`UPDATE suggestions SET closed_at = ?`).bind(ago(31 * DAY)).run();
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 1 });
		// Done within the cooldown + new evidence (a new reply) → back early.
		await db.prepare(`UPDATE suggestions SET status = 'done', closed_by = 'user', closed_at = ? WHERE status = 'open'`).bind(ago(DAY)).run();
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 0, cooldown: 1 });
		await reply(ana, 'ana@ourco.example', ago(2 * DAY), 'New question');
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 1 });
	});

	it('snoozed reopens at snooze_until while the condition holds', async () => {
		await setConfig(cfg());
		const ana = await contact('ana@ourco.example', 'Ana');
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		await runSuggestions(db, { now, force: true });
		const future = new Date(now.getTime() + DAY).toISOString().slice(0, 19).replace('T', ' ');
		await db.prepare(`UPDATE suggestions SET status = 'snoozed', snooze_until = ?`).bind(future).run();
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ reopened: 0, created: 0 });
		expect((await rows())[0].status).toBe('snoozed');
		await db.prepare(`UPDATE suggestions SET snooze_until = ?`).bind(ago(60_000)).run();
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ reopened: 1 });
		expect((await rows())[0]).toMatchObject({ status: 'open', snooze_until: null });
	});

	it('daily cap on new rows; per-tick write cap resumes on the next tick', async () => {
		await setConfig(cfg((c) => (c.daily_cap = 1)));
		for (const n of ['a', 'b', 'c']) {
			const c = await contact(`${n}@ourco.example`, n.toUpperCase());
			await reply(c, `${n}@ourco.example`, ago(3 * DAY));
		}
		expect(await runSuggestions(db, { now, force: true })).toMatchObject({ created: 1, capped: 2 });

		await db.prepare('DELETE FROM suggestions').run();
		await db.prepare(`DELETE FROM app_state WHERE key LIKE 'suggestions_%' AND key <> ?`).bind(CONFIG_KEY).run();
		await setConfig(cfg());
		const t1 = await runSuggestions(db, { now, force: true, cap: 2 });
		expect(t1).toMatchObject({ created: 2, pass_complete: false });
		expect(await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(PASS_KEY).first()).not.toBeNull();
		const t2 = await runSuggestions(db, { now, cap: 2 }); // not forced: the pass in progress continues
		expect(t2).toMatchObject({ created: 1, pass_complete: true });
		expect(await rows()).toHaveLength(3);
	});

	it('a rule or kind that is off makes nothing; a settings save asks for a pass', async () => {
		await setConfig(cfg((c) => (c.kinds.follow_up = false)));
		const ana = await contact('ana@ourco.example', 'Ana');
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		expect(await runSuggestions(db, { now })).toMatchObject({ created: 0, pass_complete: true });
		await setConfig(cfg((c) => (c.rules.awaiting_reply.on = false)));
		await requestSuggestionsPass(db);
		expect(await runSuggestions(db, { now })).toMatchObject({ created: 0, pass_complete: true });
		await setConfig(cfg());
		await requestSuggestionsPass(db);
		expect(await runSuggestions(db, { now })).toMatchObject({ created: 1 });
	});

	it('prunes closed rows after 180 days, never this month', async () => {
		const ins = (closed: string) =>
			db
				.prepare(`INSERT INTO suggestions (kind, subject_type, subject_id, rule, input_hash, title, why, status, closed_by, closed_at) VALUES ('follow_up', 'contact', 1, 'awaiting_reply', 'h', 't', 'w', 'done', 'rules', ?)`)
				.bind(closed)
				.run();
		await ins(ago(200 * DAY));
		await ins(ago(10 * DAY));
		expect(await pruneSuggestions(db, now)).toBe(1);
	});
});

describe('visibility', () => {
	async function seed() {
		await setConfig(cfg());
		const ana = await contact('ana@ourco.example', 'Ana');
		await reply(ana, 'ana@ourco.example', ago(3 * DAY));
		const ben = await contact('ben@ourco.example', 'Ben');
		const open = (await db.prepare(`SELECT id FROM pipeline_stages WHERE kind = 'open' LIMIT 1`).first<{ id: number }>())!.id;
		await db.prepare(`INSERT INTO pipeline_cards (contact_id, stage_id, owner_user_id, entered_stage_at) VALUES (?, ?, 1, ?)`).bind(ben, open, ago(40 * DAY)).run();
		await runSuggestions(db, { now, force: true });
		const member = await id(`INSERT INTO users (github_login, role) VALUES ('jdoe-712', 'member') RETURNING id`);
		return { ana, ben, member };
	}

	it('admins only by default; everyone lets members in; feature off = nobody', async () => {
		const { member } = await seed();
		expect(await suggestionViewer(db, { id: member, role: 'member' })).toBeNull();
		const admin = (await suggestionViewer(db, { id: 1, role: 'admin' }))!;
		expect((await listVisibleSuggestions(db, admin)).map((s) => s.rule)).toEqual(['awaiting_reply', 'stalled_deal']);
		await setConfig(cfg((c) => (c.audience = 'everyone')));
		expect(await suggestionViewer(db, { id: member, role: 'member' })).not.toBeNull();
		await setConfig({ enabled: false });
		expect(await suggestionViewer(db, { id: 1, role: 'admin' })).toBeNull();
	});

	it("the panel shows team rows and the viewer's own; the deal owner gets the deal", async () => {
		const { member } = await seed();
		await setConfig(cfg((c) => (c.audience = 'everyone')));
		const m = (await suggestionViewer(db, { id: member, role: 'member' }))!;
		expect((await listVisibleSuggestions(db, m, { panel: true })).map((s) => s.rule)).toEqual(['awaiting_reply']);
		const a = (await suggestionViewer(db, { id: 1, role: 'admin' }))!;
		expect((await listVisibleSuggestions(db, a, { panel: true })).map((s) => s.rule)).toEqual(['awaiting_reply', 'stalled_deal']);
		expect((await listVisibleSuggestions(db, a, { mine: true })).map((s) => s.rule)).toEqual(['stalled_deal']);
	});

	it('a subject that is unsubscribed or archived since is hidden; a kind turned off is hidden', async () => {
		const { ana, ben } = await seed();
		const a = (await suggestionViewer(db, { id: 1, role: 'admin' }))!;
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(ana).run();
		await db.prepare(`UPDATE contacts SET archived_at = datetime('now') WHERE id = ?`).bind(ben).run();
		expect(await listVisibleSuggestions(db, a)).toEqual([]);
		const id1 = (await db.prepare(`SELECT id FROM suggestions LIMIT 1`).first<{ id: number }>())!.id;
		expect(await visibleSuggestion(db, a, id1)).toBeNull();
		await db.prepare('UPDATE contacts SET subscribed = 1, archived_at = NULL').run();
		await setConfig(cfg((c) => (c.kinds.follow_up = false)));
		const off = (await suggestionViewer(db, { id: 1, role: 'admin' }))!;
		expect(await listVisibleSuggestions(db, off)).toEqual([]);
	});

	it('billing evidence only with canSeeBilling; hash refs never leave', async () => {
		const { member } = await seed();
		await setConfig(cfg((c) => (c.audience = 'everyone')));
		const row = (await db.prepare(`SELECT * FROM suggestions WHERE rule = 'awaiting_reply'`).first<any>())!;
		row.evidence = JSON.stringify([...JSON.parse(row.evidence), { id: 'e9', type: 'invoice', label: 'Overdue $500', url: null, at: null, billing: true }]);
		const m = (await suggestionViewer(db, { id: member, role: 'member' }))!;
		const a = (await suggestionViewer(db, { id: 1, role: 'admin' }))!;
		expect(m.billing).toBe(false);
		expect(viewOf(row, m).evidence.map((e) => e.type)).toEqual(['conversation']);
		expect(viewOf(row, a).evidence.map((e) => e.type)).toEqual(['conversation', 'invoice']);
		expect(viewOf(row, a).evidence.every((e) => !('ref' in e) && !('billing' in e))).toBe(true);
	});
});

// Structural: nothing in the suggestions modules can send, schedule, activate or enroll.
const sources = import.meta.glob(['../src/lib/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function resolve(from: string, spec: string): string | null {
	let b: string;
	if (spec.startsWith('$lib/')) b = `../src/lib/${spec.slice(5)}`;
	else if (spec.startsWith('.')) {
		const parts = from.split('/').slice(0, -1);
		for (const seg of spec.split('/')) {
			if (seg === '..') parts.pop();
			else if (seg !== '.') parts.push(seg);
		}
		b = parts.join('/');
	} else return null;
	b = b.replace(/\.ts$/, '');
	for (const c of [b, `${b}.ts`, `${b}/index.ts`]) if (c in sources) return c;
	return null;
}
function graph(entries: string[]): Set<string> {
	const seen = new Set<string>();
	const stack = [...entries];
	while (stack.length) {
		const f = stack.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const text = sources[f] ?? '';
		for (const m of text.matchAll(/(?:import|export)\s(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
		for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			const r = resolve(f, m[1]);
			if (r) stack.push(r);
		}
	}
	return seen;
}

describe('structural: suggestions never send, schedule, activate or enroll', () => {
	it('the module graph has no engine, send, postmark, scheduler or bulk write', () => {
		const g = graph(['../src/lib/server/suggestions/engine.ts', '../src/lib/server/suggestions/visibility.ts']);
		expect(g.has('../src/lib/server/suggestions/rules.ts')).toBe(true);
		const banned = ['automations', 'automation-enroll', 'automation-bulk', 'send', 'postmark', 'scheduled', 'resend', 'best-time', 'contact-bulk', 'contact-write'].map(
			(f) => `../src/lib/server/${f}.ts`
		);
		expect([...g].filter((f) => banned.includes(f) || /\/ai\//.test(f))).toEqual([]);
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// #412: the "Opens an email" / "Clicks a link in an email" triggers (config validation, the
// summary text, the firing matrix through the Postmark webhook), entry conditions on every
// trigger + the manual Enroll preview, the webhook's valid-JSON detail, the spec round-trip,
// and the proxy-open rule in the step_opened / segment opened rules.

import { POST as webhook } from '../src/routes/api/webhook/+server';
import { autoEnroll } from '../src/lib/server/automations';
import {
	createAutomation,
	createFromSpec,
	duplicateAutomation,
	readSpec,
	setEntryRules,
	setTrigger,
	type Actor
} from '../src/lib/server/automation-write';
import { activationProblems } from '../src/lib/server/automation-bulk';
import { classifyProxyOpen, proxyOpenSql } from '../src/lib/server/engagement';
import { evaluateRules } from '../src/lib/server/condition-eval';
import { compactEventDetail } from '../src/lib/server/event-detail';
import { triggerEmailOptions, triggerLinkOptions } from '../src/lib/server/engagement-trigger-read';
import { linkMatches, normalizeEngagementConfig, MAX_TRIGGER_EXCLUDES } from '../src/lib/engagement-trigger';
import { triggerSummary, triggerText, type TriggerFields } from '../src/lib/automation-trigger';
import { timelineText } from '../src/lib/automation-flow';
import { actions } from '../src/routes/automations/[id]/+page.server';
import type { AutomationSpec } from '../src/lib/automation-spec';

const db = (env as any).DB as D1Database;
const actor: Actor = { kind: 'system' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM engagement_trigger_fires'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;

async function contact(email: string): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;
}
async function list(name: string, kind = 'list'): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id', name, kind)).id;
}
const join = (listId: number, cid: number) => db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, cid).run();

async function broadcast(subject: string, listId: number | null = null): Promise<number> {
	return (
		await one<{ id: number }>(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at, list_id, recipient_count)
			 VALUES (?, 'b', '<p><a href="https://site.test/pricing">Pricing</a> <a href="%%UNSUB_URL%%">unsub</a></p>', 'alan@ourco.example', 'sent', datetime('now'), ?, 1) RETURNING id`,
			subject,
			listId
		)
	).id;
}

/** An automation with one step (enroll() needs an entry step). */
async function flow(o: { type: string; config?: unknown; status?: string; reentry?: string; name?: string; entry?: unknown; listId?: number }): Promise<number> {
	const id = (
		await one<{ id: number }>(
			'INSERT INTO automations (name, status, trigger_type, trigger_config, reentry, entry_rules, trigger_list_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
			o.name ?? 'Flow',
			o.status ?? 'active',
			o.type,
			o.config === undefined ? null : JSON.stringify(o.config),
			o.reentry ?? 'once',
			o.entry === undefined ? null : JSON.stringify(o.entry),
			o.listId ?? null
		)
	).id;
	await db
		.prepare(
			"INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, delay_before_seconds, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 'x', 3600, '', '', '')"
		)
		.bind(id)
		.run();
	return id;
}

/** An email step in its own automation + its lazily created campaign row. */
async function stepEmail(subject: string): Promise<{ stepId: number; campaignId: number; automationId: number }> {
	const automationId = await flow({ type: 'manual', status: 'draft', name: 'Onboarding' });
	const stepId = (
		await one<{ id: number }>(
			"INSERT INTO automation_steps (automation_id, position, type, subject, body_md, from_email) VALUES (?, 1, 'email', ?, 'b', 'alan@ourco.example') RETURNING id",
			automationId,
			subject
		)
	).id;
	const campaignId = (
		await one<{ id: number }>(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id)
			 VALUES (?, 'b', '<a href="https://site.test/start">Start</a>', 'alan@ourco.example', 'sent', ?, ?) RETURNING id`,
			subject,
			automationId,
			stepId
		)
	).id;
	return { stepId, campaignId, automationId };
}

let msg = 0;
async function sendTo(campaignId: number, cid: number): Promise<string> {
	const id = `msg-${++msg}`;
	await db
		.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, (SELECT email FROM contacts WHERE id = ?), ?, 'accepted')")
		.bind(campaignId, cid, cid, id)
		.run();
	return id;
}

function hook(payload: object) {
	return webhook({
		platform: { env: { ...env, WEBHOOK_KEY: 'test-key' } },
		url: new URL('https://app.test/api/webhook?key=test-key'),
		request: new Request('https://app.test/api/webhook', { method: 'POST', body: JSON.stringify(payload) })
	} as any);
}
const HUMAN = { UserAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', Client: { Name: 'Chrome', Family: 'Chrome' } };
const open = (messageId: string, extra: object = HUMAN) => hook({ RecordType: 'Open', MessageID: messageId, ...extra });
const click = (messageId: string, link: string) => hook({ RecordType: 'Click', MessageID: messageId, OriginalLink: link, ...HUMAN });

const passes = async (aid: number, cid: number) =>
	(await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', aid, cid)).n;
const finish = (aid: number) => db.prepare("UPDATE automation_enrollments SET status = 'completed', ended_at = datetime('now') WHERE automation_id = ?").bind(aid).run();

// ── Config validation ──────────────────────────────────────────────────────────────────

describe('trigger config validation', () => {
	it('normalizes the defaults and refuses links on opens, > 10 conditions and bad link ops', () => {
		const ok = normalizeEngagementConfig('email_opened', {});
		expect(ok).toEqual({
			ok: true,
			config: { email: 'any', list_id: null, link: 'any', exclude: [], ignore_proxy_opens: true, once_per_email: true }
		});
		expect(normalizeEngagementConfig('email_opened', { link: { op: 'contains', value: '/x' } })).toMatchObject({ ok: false, error: expect.stringContaining('link') });
		expect(normalizeEngagementConfig('email_opened', { exclude: [{ link: { op: 'contains', value: 'u' } }] })).toMatchObject({ ok: false });
		const many = Array.from({ length: MAX_TRIGGER_EXCLUDES + 1 }, (_, i) => ({ campaign_id: i + 1 }));
		expect(normalizeEngagementConfig('email_clicked', { exclude: many })).toMatchObject({ ok: false, error: expect.stringContaining('10') });
		expect(normalizeEngagementConfig('email_clicked', { link: { op: 'regex', value: 'x' } })).toMatchObject({ ok: false });
		expect(normalizeEngagementConfig('email_clicked', { link: { op: 'contains', value: '  ' } })).toMatchObject({ ok: false });
		expect(normalizeEngagementConfig('email_clicked', { email: { campaign_id: 'abc' } })).toMatchObject({ ok: false });
		expect(normalizeEngagementConfig('email_clicked', { email: { step_ref: 's1' } })).toMatchObject({ ok: false });
		expect(normalizeEngagementConfig('email_clicked', { email: { step_ref: 's1' } }, { allowRefs: true })).toMatchObject({ ok: true });
	});

	it('triggerColumns checks the campaign, email step and list exist', async () => {
		const created = await createAutomation(db, { name: 'T' }, actor);
		const aid = created.ok ? created.data.automation_id : 0;
		const missing = await setTrigger(db, aid, { type: 'email_opened', email: { campaign_id: 9999 } }, actor);
		expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('campaign no longer exists') });
		const tagStep = await one<{ id: number }>('SELECT id FROM automation_steps WHERE automation_id = ? LIMIT 1', (await flow({ type: 'manual' })));
		expect(await setTrigger(db, aid, { type: 'email_clicked', email: { step_id: tagStep.id } }, actor)).toMatchObject({ ok: false, error: expect.stringContaining('email step') });
		expect(await setTrigger(db, aid, { type: 'email_clicked', list_id: 9999 }, actor)).toMatchObject({ ok: false });
		const c = await broadcast('Spring promo');
		expect(await setTrigger(db, aid, { type: 'email_opened', link: { op: 'contains', value: 'x' } }, actor)).toMatchObject({ ok: false });
		expect(await setTrigger(db, aid, { type: 'email_opened', exclude: [{ campaign_id: c }] }, actor)).toEqual({ ok: true, data: null });
		const row = await one<{ trigger_type: string; trigger_config: string }>('SELECT trigger_type, trigger_config FROM automations WHERE id = ?', aid);
		expect(row.trigger_type).toBe('email_opened');
		expect(JSON.parse(row.trigger_config)).toMatchObject({ email: 'any', exclude: [{ campaign_id: c }], ignore_proxy_opens: true });
		// switching back to an older kind clears the config
		await setTrigger(db, aid, { type: 'manual' }, actor);
		expect((await one<{ trigger_config: string | null }>('SELECT trigger_config FROM automations WHERE id = ?', aid)).trigger_config).toBeNull();
	});

	it('activation reports a trigger whose email was deleted', async () => {
		const c = await broadcast('Gone soon');
		const aid = await flow({ type: 'email_opened', config: { email: { campaign_id: c } }, status: 'draft' });
		expect((await activationProblems(db, aid)).filter((p) => p.step_id === null)).toEqual([]);
		await db.prepare('DELETE FROM campaigns WHERE id = ?').bind(c).run();
		expect((await activationProblems(db, aid)).map((p) => p.message)).toContain('Trigger: Trigger email: that campaign no longer exists.');
	});

	it('links match case-insensitively by op', () => {
		expect(linkMatches('https://Site.test/Pricing?x=1', { op: 'contains', value: '/pricing' })).toBe(true);
		expect(linkMatches('https://site.test/pricing/', { op: 'equals', value: 'https://site.test/pricing' })).toBe(true);
		expect(linkMatches('https://site.test/pricing?x', { op: 'equals', value: 'https://site.test/pricing' })).toBe(false);
		expect(linkMatches('https://site.test/a', { op: 'starts_with', value: 'https://site.test' })).toBe(true);
		expect(linkMatches(null, { op: 'contains', value: 'x' })).toBe(false);
	});
});

// ── Summary text ───────────────────────────────────────────────────────────────────────

describe('trigger summary text', () => {
	const base: TriggerFields = {
		trigger_type: 'manual',
		trigger_list_id: null,
		trigger_metric: null,
		trigger_direction: null,
		trigger_threshold: null,
		trigger_site_id: null,
		trigger_path_op: null,
		trigger_path: null,
		trigger_cooldown_hours: null,
		trigger_stage_id: null,
		reentry: 'multiple'
	};
	const ctx = {
		lists: [{ id: 5, name: 'Clients', kind: 'list' }],
		sites: [],
		stages: [],
		emails: { campaigns: [{ id: 12, subject: 'Spring promo' }], steps: [{ id: 34, label: 'Onboarding #2' }] }
	};

	it('reads like the issue examples', () => {
		expect(
			triggerSummary({ ...base, trigger_type: 'email_opened', trigger_config: JSON.stringify({ email: 'any', exclude: [{ campaign_id: 12 }] }) }, ctx)
		).toBe('When opens any email except “Spring promo” · multiple times');
		expect(
			triggerText(
				{ ...base, trigger_type: 'email_clicked', trigger_config: JSON.stringify({ email: { step_id: 34 }, list_id: 5, link: { op: 'contains', value: '/pricing' } }) },
				ctx
			)
		).toBe('When clicks a link containing “/pricing” in “Onboarding #2” (list “Clients”)');
		expect(triggerText({ ...base, trigger_type: 'email_clicked', trigger_config: null }, ctx)).toBe('When clicks any link in any email');
		expect(
			triggerText({ ...base, trigger_type: 'email_clicked', trigger_config: JSON.stringify({ exclude: [{ link: { op: 'contains', value: 'unsubscribe' } }] }) }, ctx)
		).toBe('When clicks any link in any email except links containing “unsubscribe”');
		expect(triggerText({ ...base, trigger_type: 'email_opened', trigger_config: JSON.stringify({ email: { campaign_id: 99 } }) }, ctx)).toBe(
			'When opens (deleted email)'
		);
		expect(timelineText({ kind: 'trigger:email_opened', detail: 'opened “Spring promo”' })).toBe('Triggered: opened “Spring promo”');
	});
});

// ── Firing ─────────────────────────────────────────────────────────────────────────────

describe('firing through the webhook', () => {
	it('any email: enrolls, records the fire and a timeline event', async () => {
		const cid = await contact('ann@x.test');
		const c1 = await broadcast('Spring promo');
		const aid = await flow({ type: 'email_opened', config: { email: 'any' } });
		await open(await sendTo(c1, cid));
		expect(await passes(aid, cid)).toBe(1);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM engagement_trigger_fires WHERE automation_id = ?', aid)).n).toBe(1);
		const ev = await one<{ detail: string }>("SELECT detail FROM automation_enrollment_events WHERE kind = 'trigger:email_opened'");
		expect(ev.detail).toBe('opened “Spring promo”');
	});

	it('a specific campaign or step email; exclusions stack', async () => {
		const cid = await contact('bob@x.test');
		const c1 = await broadcast('One');
		const c2 = await broadcast('Two');
		const s = await stepEmail('Welcome');
		const only1 = await flow({ type: 'email_opened', config: { email: { campaign_id: c1 } }, reentry: 'multiple' });
		const onlyStep = await flow({ type: 'email_opened', config: { email: { step_id: s.stepId } } });
		const notC1 = await flow({ type: 'email_opened', config: { email: 'any', exclude: [{ campaign_id: c1 }, { step_id: s.stepId }] } });
		await open(await sendTo(c2, cid));
		expect([await passes(only1, cid), await passes(onlyStep, cid), await passes(notC1, cid)]).toEqual([0, 0, 1]);
		await open(await sendTo(s.campaignId, cid));
		expect(await passes(onlyStep, cid)).toBe(1);
		await finish(notC1);
		await open(await sendTo(c1, cid));
		expect(await passes(only1, cid)).toBe(1);
		expect(await passes(notC1, cid)).toBe(1); // excluded (and once anyway)
	});

	it('a list restriction checks the contact is in it', async () => {
		const cid = await contact('cy@x.test');
		const l = await list('Clients');
		const c1 = await broadcast('One');
		const aid = await flow({ type: 'email_opened', config: { list_id: l }, reentry: 'multiple' });
		await open(await sendTo(c1, cid));
		expect(await passes(aid, cid)).toBe(0);
		await join(l, cid);
		await open(await sendTo(c1, cid));
		expect(await passes(aid, cid)).toBe(1);
	});

	it('link ops and link exclusions (clicks)', async () => {
		const cid = await contact('di@x.test');
		const c1 = await broadcast('One');
		const contains = await flow({ type: 'email_clicked', config: { link: { op: 'contains', value: '/pricing' } }, reentry: 'multiple' });
		const equals = await flow({ type: 'email_clicked', config: { link: { op: 'equals', value: 'https://site.test/pricing' } }, reentry: 'multiple' });
		const starts = await flow({ type: 'email_clicked', config: { link: { op: 'starts_with', value: 'https://site.test/' } }, reentry: 'multiple' });
		const anyButUnsub = await flow({ type: 'email_clicked', config: { exclude: [{ link: { op: 'contains', value: 'unsubscribe' } }] }, reentry: 'multiple' });
		const m = await sendTo(c1, cid);
		await click(m, 'https://site.test/Pricing?utm=x');
		expect([await passes(contains, cid), await passes(equals, cid), await passes(starts, cid), await passes(anyButUnsub, cid)]).toEqual([1, 0, 1, 1]);
		await finish(anyButUnsub);
		await click(await sendTo(c1, cid), 'https://site.test/unsubscribe');
		expect(await passes(anyButUnsub, cid)).toBe(1);
		// an open never fires a clicks trigger
		await open(await sendTo(await broadcast('Two'), cid));
		expect(await passes(equals, cid)).toBe(0);
	});

	it('skips Apple Mail / proxy auto-opens unless told not to', async () => {
		const cid = await contact('ed@x.test');
		const c1 = await broadcast('One');
		const strict = await flow({ type: 'email_opened', config: {} });
		const loose = await flow({ type: 'email_opened', config: { ignore_proxy_opens: false } });
		await open(await sendTo(c1, cid), { UserAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit (KHTML, like Gecko) Mail/3826', Client: { Name: 'Apple Mail', Family: 'Apple Mail' } });
		expect([await passes(strict, cid), await passes(loose, cid)]).toEqual([0, 1]);
		await open(await sendTo(c1, cid));
		expect(await passes(strict, cid)).toBe(1);
	});

	it('once per email, and re-entry once vs multiple', async () => {
		const cid = await contact('fi@x.test');
		const c1 = await broadcast('One');
		const c2 = await broadcast('Two');
		const oncePerEmail = await flow({ type: 'email_opened', config: {}, reentry: 'multiple' });
		const everyOpen = await flow({ type: 'email_opened', config: { once_per_email: false }, reentry: 'multiple' });
		const onceOnly = await flow({ type: 'email_opened', config: { once_per_email: false }, reentry: 'once' });
		const m1 = await sendTo(c1, cid);
		await open(m1);
		await finish(oncePerEmail);
		await finish(everyOpen);
		await finish(onceOnly);
		await open(m1);
		expect([await passes(oncePerEmail, cid), await passes(everyOpen, cid), await passes(onceOnly, cid)]).toEqual([1, 2, 1]);
		await open(await sendTo(c2, cid));
		expect(await passes(oncePerEmail, cid)).toBe(2);
	});

	it('paused records a pending trigger; draft does nothing', async () => {
		const cid = await contact('gi@x.test');
		const c1 = await broadcast('One');
		const paused = await flow({ type: 'email_clicked', config: {}, status: 'paused' });
		const draft = await flow({ type: 'email_clicked', config: {}, status: 'draft' });
		await click(await sendTo(c1, cid), 'https://site.test/pricing');
		expect([await passes(paused, cid), await passes(draft, cid)]).toEqual([0, 0]);
		const pend = await db.prepare('SELECT automation_id, source FROM automation_pending_triggers').all<{ automation_id: number; source: string }>();
		expect(pend.results).toEqual([{ automation_id: paused, source: 'email_clicked' }]);
	});

	it('entry conditions apply to the engagement trigger too', async () => {
		const cid = await contact('hi@x.test');
		const c1 = await broadcast('One');
		const aid = await flow({ type: 'email_opened', config: {}, entry: { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'vip' }] } });
		await open(await sendTo(c1, cid));
		expect(await passes(aid, cid)).toBe(0);
		await join(await list('vip', 'tag'), cid);
		await open(await sendTo(await broadcast('Two'), cid));
		expect(await passes(aid, cid)).toBe(1);
	});
});

// ── Entry conditions ───────────────────────────────────────────────────────────────────

function ev(aid: number, fields: Record<string, string | string[]>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
	const url = new URL(`https://app.test/automations/${aid}`);
	return { platform: { env }, params: { id: String(aid) }, url, locals: { user: null }, request: new Request(url, { method: 'POST', body: fd }) } as any;
}

describe('entry conditions', () => {
	it('list_added only enrolls matching contacts; the manual preview counts the skips; ignore enrolls them', async () => {
		const trigger = await list('Signups');
		const vip = await list('vip', 'tag');
		const a = await contact('a@x.test');
		const b = await contact('b@x.test');
		const c = await contact('c@x.test');
		await join(vip, a);
		const aid = await flow({ type: 'list_added', listId: trigger });
		expect(await setEntryRules(db, aid, { rules: { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'vip' }] } }, actor)).toMatchObject({ ok: true });
		await join(trigger, a);
		await join(trigger, b);
		await autoEnroll(db, trigger, [a, b]);
		expect([await passes(aid, a), await passes(aid, b)]).toEqual([1, 0]);

		const preview = (await actions.enrollPreview(ev(aid, { contact_ids: [String(b), String(c)] }))) as any;
		expect(preview.preview).toMatchObject({ total: 2, eligible: 0, entry_blocked: 2, skipped_more: 0 });
		// #678: each skipped hand-picked contact is listed with its reason.
		expect(preview.preview.skipped.map((s: any) => s.reason)).toEqual(['conditions', 'conditions']);
		const listPreview = (await actions.enrollPreview(ev(aid, { list_id: String(trigger) }))) as any;
		expect(listPreview.enrollPreview).toMatchObject({ eligible: 2, already: 1, entry_blocked: 1, will_enroll: 0 });

		await actions.enrollContacts(ev(aid, { contact_ids: [String(b)] }));
		expect(await passes(aid, b)).toBe(0);
		await actions.enrollContacts(ev(aid, { contact_ids: [String(b)], ignore_entry: '1' }));
		expect(await passes(aid, b)).toBe(1);
	});

	it('refuses email-step rules and saves through the trigger drawer', async () => {
		const aid = await flow({ type: 'manual', status: 'draft' });
		expect(await setEntryRules(db, aid, { rules: { match: 'all', rules: [{ field: 'step_opened', op: 'yes', value: '1' }] } }, actor)).toMatchObject({
			ok: false,
			error: expect.stringContaining('email step')
		});
		const r = (await actions.setTrigger(
			ev(aid, { trigger_type: 'email_opened', trigger_config: JSON.stringify({ email: 'any' }), entry_rules: JSON.stringify({ match: 'any', rules: [{ field: 'subscribed', op: 'yes' }] }) })
		)) as any;
		expect(r).toEqual({ ok: true });
		const row = await one<{ trigger_type: string; entry_rules: string }>('SELECT trigger_type, entry_rules FROM automations WHERE id = ?', aid);
		expect(row.trigger_type).toBe('email_opened');
		expect(JSON.parse(row.entry_rules)).toEqual({ match: 'any', rules: [{ field: 'subscribed', op: 'yes' }] });
		await actions.setTrigger(ev(aid, { trigger_type: 'manual', entry_rules: '' }));
		expect((await one<{ entry_rules: string | null }>('SELECT entry_rules FROM automations WHERE id = ?', aid)).entry_rules).toBeNull();
	});
});

// ── Webhook detail ─────────────────────────────────────────────────────────────────────

describe('webhook detail JSON', () => {
	it('stays valid at a 20 KB payload and keeps the fields readers use', async () => {
		const cid = await contact('big@x.test');
		const c1 = await broadcast('One');
		const m = await sendTo(c1, cid);
		const link = `https://site.test/pricing?${'q='.padEnd(300, 'x')}`;
		await hook({
			RecordType: 'Click',
			MessageID: m,
			OriginalLink: link,
			UserAgent: 'Mozilla/5.0',
			Client: { Name: 'Chrome', Family: 'Chrome', Company: 'Google' },
			Geo: { Country: 'US', City: 'Pasadena', Coords: '1,2' },
			Metadata: { blob: 'y'.repeat(20_000) }
		});
		const row = await one<{ detail: string; ok: number; link: string }>(
			"SELECT detail, json_valid(detail) AS ok, json_extract(detail, '$.OriginalLink') AS link FROM events WHERE type = 'click'"
		);
		expect(row.ok).toBe(1);
		expect(row.link).toBe(link);
		expect(row.detail.length).toBeLessThan(6000);
		expect(JSON.parse(row.detail)).toMatchObject({ RecordType: 'Click', Client: { Name: 'Chrome' }, Geo: { Country: 'US' }, Truncated: true });
		const small = { RecordType: 'Open', MessageID: 'x' };
		expect(compactEventDetail(small)).toBe(JSON.stringify(small));
		expect(await triggerLinkOptions(db, { campaign_id: c1 })).toEqual(['https://site.test/pricing', link]);
	});
});

// ── Spec round-trip, duplicate, picker ─────────────────────────────────────────────────

describe('spec round-trip', () => {
	it('readSpec → createFromSpec keeps the trigger (own step by ref) and entry conditions; duplicate remaps the step', async () => {
		const c1 = await broadcast('Spring promo');
		const spec: AutomationSpec = {
			name: 'Clickers',
			trigger: {
				type: 'email_clicked',
				email: { step_ref: 'mail' },
				link: { op: 'contains', value: '/pricing' },
				exclude: [{ campaign_id: c1 }, { link: { op: 'contains', value: 'unsubscribe' } }],
				once_per_email: false
			},
			reentry: 'multiple',
			entry_rules: { match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] },
			steps: [{ type: 'email', ref: 'mail', subject: 'Hi', body_md: 'Body', from_email: 'alan@ourco.example' }, { type: 'tag', tag_action: 'add', tag_name: 'clicked' }]
		};
		const made = await createFromSpec(db, spec, actor);
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const row = await one<{ trigger_config: string }>('SELECT trigger_config FROM automations WHERE id = ?', made.data.automation_id);
		expect(JSON.parse(row.trigger_config).email).toEqual({ step_id: made.data.step_ids.mail });

		const read = await readSpec(db, made.data.automation_id);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.data.trigger).toEqual({
			type: 'email_clicked',
			email: { step_ref: 's1' },
			list_id: null,
			link: { op: 'contains', value: '/pricing' },
			exclude: [{ campaign_id: c1 }, { link: { op: 'contains', value: 'unsubscribe' } }],
			once_per_email: false
		});
		expect(read.data.entry_rules).toEqual({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] });
		const again = await createFromSpec(db, read.data, actor);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		const reread = await readSpec(db, again.data.automation_id);
		expect(reread.ok && reread.data.trigger).toEqual(read.data.trigger);
		expect(reread.ok && reread.data.entry_rules).toEqual(read.data.entry_rules);

		const dup = await duplicateAutomation(db, made.data.automation_id, actor);
		expect(dup.ok).toBe(true);
		if (!dup.ok) return;
		const copyStep = await one<{ id: number }>("SELECT id FROM automation_steps WHERE automation_id = ? AND type = 'email'", dup.data.automation_id);
		const dupRow = await one<{ trigger_config: string; entry_rules: string }>('SELECT trigger_config, entry_rules FROM automations WHERE id = ?', dup.data.automation_id);
		expect(JSON.parse(dupRow.trigger_config).email).toEqual({ step_id: copyStep.id });
		expect(JSON.parse(dupRow.entry_rules)).toEqual(spec.entry_rules);
	});

	it('refuses a spec trigger ref that is not an email step', async () => {
		const r = await createFromSpec(
			db,
			{ name: 'Bad', trigger: { type: 'email_opened', email: { step_ref: 't' } }, steps: [{ type: 'tag', ref: 't', tag_action: 'add', tag_name: 'x' }] },
			actor
		);
		expect(r).toMatchObject({ ok: false, problems: [{ path: 'trigger', message: expect.stringContaining('no email step') }] });
	});

	it('the Select email options: broadcasts, this automation’s steps, then others', async () => {
		const c1 = await broadcast('Newsletter', await list('All'));
		const other = await stepEmail('Welcome');
		const mine = await flow({ type: 'manual', status: 'draft', name: 'Mine' });
		await db
			.prepare("INSERT INTO automation_steps (automation_id, position, type, subject, body_md, from_email) VALUES (?, 1, 'email', 'Follow up', 'b', 'alan@ourco.example')")
			.bind(mine)
			.run();
		const opts = await triggerEmailOptions(db, mine);
		expect(opts.map((o) => o.label)).toEqual(['Newsletter', 'Step 2: Follow up', 'Welcome']);
		expect(opts[0]).toMatchObject({ kind: 'campaign', id: c1 });
		expect(opts[2]).toMatchObject({ kind: 'step', id: other.stepId, group: 'Onboarding', own: false });
		expect((await triggerEmailOptions(db, mine, 'welc')).map((o) => o.label)).toEqual(['Welcome']);
	});
});

// ── Proxy-open rule in SQL ─────────────────────────────────────────────────────────────

describe('proxy-open rule', () => {
	it('proxyOpenSql agrees with classifyProxyOpen', async () => {
		const cid = await contact('px@x.test');
		const c1 = await broadcast('One');
		const r = (await one<{ id: number }>("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'px@x.test', 'px', 'accepted') RETURNING id", c1, cid)).id;
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, 'delivery', '{}', '2026-10-01 10:00:00')").bind(c1, r, cid).run();
		const cases: { detail: string; at: string }[] = [
			{ detail: JSON.stringify({ UserAgent: 'Mozilla/5.0 Mail/3826' }), at: '2026-10-01 11:00:00' },
			{ detail: JSON.stringify({ UserAgent: 'x', Client: { Family: 'Apple Mail' } }), at: '2026-10-01 11:00:00' },
			{ detail: JSON.stringify({ UserAgent: 'iPhone Mail (16A)' }), at: '2026-10-01 11:00:00' },
			{ detail: JSON.stringify({ UserAgent: 'Chrome', FirstOpen: true }), at: '2026-10-01 10:00:30' },
			{ detail: JSON.stringify({ UserAgent: 'Chrome', FirstOpen: true }), at: '2026-10-01 10:05:00' },
			{ detail: JSON.stringify({ UserAgent: 'Chrome', FirstOpen: false }), at: '2026-10-01 10:00:10' },
			{ detail: '{"UserAgent":"Apple Mail', at: '2026-10-01 11:00:00' }
		];
		for (const c of cases) {
			const id = (
				await one<{ id: number }>(
					"INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, 'open', ?, ?) RETURNING id",
					c1,
					r,
					cid,
					c.detail,
					c.at
				)
			).id;
			const sql = await one<{ p: number }>(`SELECT ${proxyOpenSql('ev')} AS p FROM events ev WHERE ev.id = ?`, id);
			let parsed: unknown = {};
			try {
				parsed = JSON.parse(c.detail);
			} catch {
				/* truncated */
			}
			expect(!!sql.p, c.detail + ' @ ' + c.at).toBe(classifyProxyOpen(parsed, '2026-10-01 10:00:00', c.at));
		}
	});

	it('step_opened and the segment opened rule ignore auto-opens', async () => {
		const cid = await contact('so@x.test');
		const s = await stepEmail('Welcome');
		const m = await sendTo(s.campaignId, cid);
		await open(m, { UserAgent: 'Mozilla/5.0 Mail/3826' });
		const stepRule = { match: 'all' as const, rules: [{ field: 'step_opened', op: 'yes', value: String(s.stepId) }] };
		const segRule = { match: 'all' as const, rules: [{ field: 'opened', op: 'in', value: '30' }] };
		expect((await evaluateRules(db, cid, stepRule)).pass).toBe(false);
		expect((await evaluateRules(db, cid, segRule)).pass).toBe(false);
		await open(m);
		expect((await evaluateRules(db, cid, stepRule)).pass).toBe(true);
		expect((await evaluateRules(db, cid, segRule)).pass).toBe(true);
	});
});

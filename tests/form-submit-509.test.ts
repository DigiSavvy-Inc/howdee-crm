import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { blankField, emptyForm, withSettingsOutcome, type FormAction, type FormField, type FormOutcome, type FormSpec } from '../src/lib/forms';
import type { FormRule, FormRuleSet } from '../src/lib/form-logic';
import { createForm, getForm, listSubmissions, pruneSubmissions, recordSubmission, submissionsCsv, type FormRow } from '../src/lib/server/forms';
import { handleSubmission, RATE_PER_IP, type SubmitContext } from '../src/lib/server/form-submit';
import { limit } from '../src/lib/server/rate-limit';
import { recentActivity } from '../src/lib/server/activity';

// #509: the whole submit path on a real D1 — contact write, mapping, hidden answers, spam,
// rate limit, origin, anonymous, the consent gate, CSV, prune and notifications.

const db = (env as any).DB as D1Database;
const baseEnv = { SESSION_SECRET: 'test-secret' };
let ipN = 0;
const ctx = (extra: Partial<SubmitContext> = {}): SubmitContext => ({
	origin: 'https://crm.test',
	crmOrigins: ['https://crm.test'],
	ip: `10.0.0.${++ipN}`,
	mxLookup: async () => 'ok',
	...extra
});

function q(type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField {
	return { ...blankField(type, label), key, ...extra };
}

async function makeForm(mutate: (s: FormSpec) => FormSpec | void = () => {}, name = 'Signup'): Promise<FormRow> {
	const id = await createForm(db, name, null);
	const spec = emptyForm(name);
	const next = mutate(spec) ?? spec;
	await db.prepare("UPDATE forms SET spec = ?, status = 'published', retention_days = ? WHERE id = ?").bind(JSON.stringify(next), next.settings.retention_days, id).run();
	return (await getForm(db, id))!;
}

async function listId(name: string, extra = ''): Promise<number> {
	const row = await db.prepare(`INSERT INTO lists (name, kind${extra ? ', public_topic' : ''}) VALUES (?, 'list'${extra ? ', 1' : ''}) RETURNING id`).bind(name).first<{ id: number }>();
	return row!.id;
}
const contact = (email: string) =>
	db.prepare('SELECT * FROM contacts WHERE email = ?').bind(email).first<Record<string, any>>();
const groupsOf = async (id: number) =>
	(
		await db
			.prepare('SELECT l.name, l.kind FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.contact_id = ? ORDER BY l.name')
			.bind(id)
			.all<{ name: string; kind: string }>()
	).results;

describe('handleSubmission', () => {
	it('creates a contact with mapped fields, tags, lists and topics', async () => {
		const news = await listId('Form News');
		const topic = await listId('Form Topic', 'topic');
		const form = await makeForm((s) => {
			s.fields.push(
				q('short_text', 'First name', 'first', { map: { to: 'contact', field: 'first_name' } }),
				q('short_text', 'Company', 'company', { map: { to: 'contact', field: 'company' } }),
				q('phone', 'Phone', 'phone', { map: { to: 'contact', field: 'phone' } }),
				q('radio', 'Role', 'role', { options: [{ value: 'dev', label: 'Developer' }, { value: 'pm', label: 'PM' }], map: { to: 'meta', key: 'role' } }),
				q('checkboxes', 'Interests', 'interests', { options: [{ value: 'seo', label: 'SEO' }, { value: 'ads', label: 'Ads' }], map: { to: 'tag_prefix', prefix: 'interest:' } }),
				q('checkbox', 'Newsletter', 'news', { map: { to: 'list', list_id: news } }),
				q('topics', 'Topics', 'topics', { options: [{ value: String(topic), label: 'Topic' }] })
			);
			return withSettingsOutcome(s, [{ type: 'add_tag', tag: 'form-lead' }, { type: 'set_source', source: 'webinar-form' }, { type: 'message_md', md: 'Thanks **{{x}}**' }]);
		});
		const r = await handleSubmission(db, baseEnv, form, {
			answers: { email: 'Ann@Forms.test', first: 'Ann', company: 'Acme Forms', phone: '+1 555 0100', role: 'dev', interests: ['seo', 'ads'], news: 'on', topics: String(topic) },
			utm: { utm_source: 'news' }
		}, ctx());
		expect(r).toMatchObject({ ok: true, status: 200, detail: 'added' });
		expect(r.message_html).toContain('<strong>');
		const c = (await contact('ann@forms.test'))!;
		expect(c.first_name).toBe('Ann');
		expect(c.company).toBe('Acme Forms');
		expect(c.source).toBe('webinar-form');
		expect(c.subscribed).toBe(1);
		const meta = JSON.parse(c.meta);
		expect(meta.role).toBe('Developer');
		expect(meta.phone).toBe('+1 555 0100');
		const groups = (await groupsOf(c.id)).map((g) => g.name);
		expect(groups).toEqual(expect.arrayContaining(['form-lead', 'interest:SEO', 'interest:Ads', 'Form News', 'Form Topic', 'Acme Forms']));
		const sub = await db.prepare('SELECT * FROM form_submissions WHERE id = ?').bind(r.submissionId).first<Record<string, any>>();
		expect(sub).toMatchObject({ status: 'added', contact_id: c.id, email: 'ann@forms.test', form_version: form.version });
		expect(JSON.parse(sub!.answers)).toMatchObject({ first: 'Ann', interests: ['seo', 'ads'], news: true });
		expect(JSON.parse(sub!.utm)).toEqual({ utm_source: 'news' });
		expect(sub!.ip_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(sub!.ip_hash).not.toContain('10.0.0');
	});

	it('updates an existing contact without clearing blanks, and restores an archived one', async () => {
		await db.prepare("INSERT INTO contacts (email, first_name, last_name, source, archived_at) VALUES ('bob@forms.test', 'Bob', 'Old', 'csv', datetime('now'))").run();
		const form = await makeForm((s) => {
			s.fields.push(
				q('short_text', 'First', 'first', { map: { to: 'contact', field: 'first_name' } }),
				q('short_text', 'Last', 'last', { map: { to: 'contact', field: 'last_name' } })
			);
		});
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'bob@forms.test', first: 'Robert', last: '' } }, ctx());
		expect(r.detail).toBe('updated');
		const c = (await contact('bob@forms.test'))!;
		expect(c.first_name).toBe('Robert');
		expect(c.last_name).toBe('Old');
		expect(c.source).toBe('csv');
		expect(c.archived_at).toBeNull();
	});

	it('drops answers to questions hidden by show_when', async () => {
		const form = await makeForm((s) => {
			s.fields.push(
				q('radio', 'Role', 'role', { options: [{ value: 'dev', label: 'Dev' }, { value: 'mgr', label: 'Manager' }] }),
				q('short_text', 'Team size', 'team', {
					required: true,
					map: { to: 'meta', key: 'team' },
					show_when: { match: 'all', rules: [{ field: 'role', op: 'eq', value: 'mgr' }] }
				})
			);
		});
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'cat@forms.test', role: 'dev', team: '50' } }, ctx());
		expect(r.ok).toBe(true);
		const sub = await db.prepare('SELECT answers FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ answers: string }>();
		expect(JSON.parse(sub!.answers)).toEqual({ email: 'cat@forms.test', role: 'dev' });
		expect(JSON.parse((await contact('cat@forms.test'))!.meta ?? '{}').team).toBeUndefined();
		// Shown → required again.
		const bad = await handleSubmission(db, baseEnv, form, { answers: { email: 'cat@forms.test', role: 'mgr' } }, ctx());
		expect(bad).toMatchObject({ ok: false, status: 400, detail: 'invalid' });
		expect(bad.errors).toHaveProperty('team');
	});

	it('honeypot → a spam row, no contact', async () => {
		const form = await makeForm();
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'bot@forms.test' }, honeypot: 'http://spam' }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'spam' });
		expect(await contact('bot@forms.test')).toBeNull();
		const sub = await db.prepare('SELECT status, detail, email FROM form_submissions WHERE id = ?').bind(r.submissionId).first();
		expect(sub).toEqual({ status: 'spam', detail: 'honeypot', email: 'bot@forms.test' });
	});

	it('rate limits a visitor: 429 after 10 in 10 minutes', async () => {
		const form = await makeForm();
		const c = ctx({ ip: '203.0.113.9' });
		for (let i = 0; i < RATE_PER_IP; i++) {
			const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'rate@forms.test' } }, c);
			expect(r.status).toBe(200);
		}
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'rate@forms.test' } }, c);
		expect(r).toMatchObject({ ok: false, status: 429, detail: 'rate_limit' });
		// Another visitor is fine; a new window resets.
		expect((await handleSubmission(db, baseEnv, form, { answers: { email: 'rate2@forms.test' } }, ctx({ ip: '203.0.113.10' }))).status).toBe(200);
		const later = await limit(db, 'form:x:y', { max: 1, windowSec: 600, now: new Date('2026-01-01T00:00:00Z') });
		expect(later.ok).toBe(true);
		expect((await limit(db, 'form:x:y', { max: 1, windowSec: 600, now: new Date('2026-01-01T00:05:00Z') })).ok).toBe(false);
		expect((await limit(db, 'form:x:y', { max: 1, windowSec: 600, now: new Date('2026-01-01T00:11:00Z') })).ok).toBe(true);
	});

	it('rejects a foreign origin (403, logged as rejected / origin); allows none and null', async () => {
		const form = await makeForm();
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'evil@forms.test' } }, ctx({ origin: 'https://evil.test' }));
		expect(r).toMatchObject({ ok: false, status: 403, detail: 'origin' });
		const sub = await db.prepare('SELECT status, detail FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ status: string; detail: string }>();
		expect(sub!.status).toBe('rejected');
		expect(sub!.detail).toMatch(/^origin https:\/\/evil\.test/);
		expect(await contact('evil@forms.test')).toBeNull();
		expect((await handleSubmission(db, baseEnv, form, { answers: { email: 'n1@forms.test' } }, ctx({ origin: null }))).ok).toBe(true);
		expect((await handleSubmission(db, baseEnv, form, { answers: { email: 'n2@forms.test' } }, ctx({ origin: 'null' }))).ok).toBe(true);
		const allowed = await makeForm((s) => {
			s.settings.allowed_origins = ['https://www.partner.test'];
		});
		expect((await handleSubmission(db, baseEnv, allowed, { answers: { email: 'n3@forms.test' } }, ctx({ origin: 'https://www.partner.test' }))).ok).toBe(true);
	});

	it('anonymous only when the form allows it', async () => {
		const anon = await makeForm((s) => {
			s.settings.allow_anonymous = true;
			s.fields[0].required = false;
			s.fields.push(q('long_text', 'Feedback', 'feedback'));
		});
		const r = await handleSubmission(db, baseEnv, anon, { answers: { feedback: 'Great' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'anonymous' });
		const sub = await db.prepare('SELECT status, contact_id, answers FROM form_submissions WHERE id = ?').bind(r.submissionId).first<Record<string, any>>();
		expect(sub).toMatchObject({ status: 'anonymous', contact_id: null });
		const strict = await makeForm();
		const no = await handleSubmission(db, baseEnv, strict, { answers: {} }, ctx());
		expect(no).toMatchObject({ ok: false, status: 400 });
		expect(no.errors).toHaveProperty('email');
	});

	it('never resubscribes an unsubscribed contact straight from a form (#541: consent → confirm email)', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('unsub@forms.test', 0)").run();
		const form = await makeForm((s) => {
			s.fields.push(q('consent', 'Yes, email me', 'consent'), q('short_text', 'Role', 'role', { map: { to: 'meta', key: 'role' } }));
		});
		const no = await handleSubmission(db, baseEnv, form, { answers: { email: 'unsub@forms.test', role: 'cto' } }, ctx());
		expect(no.detail).toBe('updated');
		let c = (await contact('unsub@forms.test'))!;
		expect(c.subscribed).toBe(0);
		expect(JSON.parse(c.meta).role).toBe('cto');
		const row = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(no.submissionId).first<{ detail: string }>();
		expect(row!.detail).toContain('kept unsubscribed: no consent');
		const yes = await handleSubmission(db, baseEnv, form, { answers: { email: 'unsub@forms.test', consent: 'on' } }, ctx());
		expect(yes.ok).toBe(true);
		c = (await contact('unsub@forms.test'))!;
		expect(c.subscribed).toBe(0);
		expect(c.confirm_pending).toBe(1);
		const yesRow = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(yes.submissionId).first<{ detail: string }>();
		expect(yesRow!.detail).toContain('resubscribe needs confirmation');
	});

	it('ends on the redirect when the form has one', async () => {
		const form = await makeForm((s) => withSettingsOutcome(s, [{ type: 'redirect', url: 'https://example.com/thanks' }]));
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'redir@forms.test' } }, ctx());
		expect(r.redirect).toBe('https://example.com/thanks');
		expect(r.message_html).toBeUndefined();
	});

	it('emails the chosen users', async () => {
		const u = await db.prepare("INSERT INTO users (github_login, role, email) VALUES ('notify509', 'member', 'notify509@ourco.test') RETURNING id").first<{ id: number }>();
		const form = await makeForm((s) => {
			s.settings.notify_user_ids = [u!.id];
			s.fields.push(q('short_text', 'Message', 'msg'));
		}, 'Contact us');
		const send = vi.fn(async () => [{ ErrorCode: 0, Message: 'OK', MessageID: 'm1', To: 'x', SubmittedAt: '' }]) as any;
		const r = await handleSubmission(
			db,
			{ ...baseEnv, POSTMARK_TOKEN: 't', POSTMARK_FROM: 'alan@ourco.test' },
			form,
			{ answers: { email: 'note@forms.test', msg: 'Hello <there>' } },
			ctx({ send, baseUrl: 'https://crm.test' })
		);
		expect(r.ok).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		const [, [msg]] = send.mock.calls[0];
		expect(msg).toMatchObject({ To: 'notify509@ourco.test', Subject: 'New submission: Contact us', ReplyTo: 'note@forms.test', MessageStream: 'outbound' });
		expect(msg.HtmlBody).toContain('Hello &lt;there&gt;');
		expect(msg.TextBody).toContain(`https://crm.test/forms/${form.id}?tab=submissions`);
	});

	it('shows in the activity feed as a form row', async () => {
		const form = await makeForm(undefined, 'Feed form');
		await handleSubmission(db, baseEnv, form, { answers: { email: 'feed@forms.test' } }, ctx());
		const items = await recentActivity(db, { types: ['form'], limit: 50 });
		expect(items.some((i) => i.type === 'form' && i.email === 'feed@forms.test' && i.detail === 'Feed form')).toBe(true);
	});
});

describe('submissions', () => {
	it('lists, filters and exports CSV (formula-guarded)', async () => {
		const form = await makeForm((s) => {
			s.fields.push(q('select', 'Plan', 'plan', { options: [{ value: 'p', label: 'Pro' }] }), q('short_text', 'Note', 'note'));
		}, 'CSV form');
		await handleSubmission(db, baseEnv, form, { answers: { email: 'csv1@forms.test', plan: 'p', note: '=SUM(A1)' } }, ctx());
		await handleSubmission(db, baseEnv, form, { answers: { email: 'csv2@forms.test', note: 'plain, "quoted"' } }, ctx());
		await handleSubmission(db, baseEnv, form, { answers: { email: 'csv3@forms.test' }, honeypot: 'x' }, ctx());
		const ok = await listSubmissions(db, form.id);
		expect(ok.total).toBe(2);
		expect((await listSubmissions(db, form.id, { status: 'hidden' })).total).toBe(1);
		expect((await listSubmissions(db, form.id, { q: 'csv2' })).rows.map((r) => r.email)).toEqual(['csv2@forms.test']);
		const csv = await submissionsCsv(db, form);
		const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
		expect(lines[0]).toBe('submission_id,submitted_at_utc,status,email,contact_id,Email,Plan,Note,utm_source,utm_medium,utm_campaign,referrer,page_url');
		expect(lines).toHaveLength(3);
		expect(csv).toContain("'=SUM(A1)");
		expect(csv).toContain('"plain, ""quoted"""');
		expect(csv).toContain(',Pro,');
	});

	it('prunes past each form’s retention', async () => {
		const short = await makeForm((s) => {
			s.settings.retention_days = 30;
		}, 'Short');
		const long = await makeForm(undefined, 'Long');
		const old = (form: FormRow, days: number) =>
			recordSubmission(db, { form_id: form.id, form_version: 1, contact_id: null, email: `old${days}@forms.test`, status: 'anonymous', answers: {} }).then((id) =>
				db.prepare(`UPDATE form_submissions SET created_at = datetime('now', '-${days} days') WHERE id = ?`).bind(id).run().then(() => id)
			);
		const a = await old(short, 40);
		const b = await old(short, 10);
		const c = await old(long, 40);
		const d = await old(long, 400);
		const res = await pruneSubmissions(db);
		expect(res.deleted).toBeGreaterThanOrEqual(2);
		const left = (await db.prepare('SELECT id FROM form_submissions WHERE id IN (?, ?, ?, ?)').bind(a, b, c, d).all<{ id: number }>()).results.map((r) => r.id);
		expect(left.sort()).toEqual([b, c].sort());
	});
});

// #514: page jumps, conditional outcomes (all / first), remove_tag, enroll_automation, the
// known-contact rules and the fired outcome ids on the row.
describe('logic (#514)', () => {
	const rule = (field: string, op: FormRule['op'], value?: string): FormRuleSet => ({ match: 'all', rules: [value === undefined ? { field, op } : { field, op, value }] });
	const outcome = (id: string, when: FormRuleSet | null, actions: FormAction[]): FormOutcome => ({ id, when, actions });
	const outcomesOf = async (sid: number) =>
		JSON.parse((await db.prepare('SELECT outcomes FROM form_submissions WHERE id = ?').bind(sid).first<{ outcomes: string }>())!.outcomes);
	const tagNames = async (email: string) => (await groupsOf((await contact(email))!.id)).filter((g) => g.kind === 'tag').map((g) => g.name);
	async function knownContact(email: string, tags: string[], meta: Record<string, string> = {}): Promise<number> {
		const id = (await db.prepare('INSERT INTO contacts (email, subscribed, meta) VALUES (?, 1, ?) RETURNING id').bind(email, JSON.stringify(meta)).first<{ id: number }>())!.id;
		for (const t of tags) {
			await db.prepare("INSERT OR IGNORE INTO lists (name, kind) VALUES (?, 'tag')").bind(t).run();
			const l = (await db.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'tag'").bind(t).first<{ id: number }>())!;
			await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(l.id, id).run();
		}
		return id;
	}

	it('drops answers on pages a jump skips (native post), even required ones', async () => {
		const form = await makeForm((s) => {
			s.fields.push(
				q('radio', 'Plan', 'plan', { options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }] }),
				{ ...blankField('page_break', 'Team'), id: 'p2' },
				q('short_text', 'Team', 'team', { required: true, map: { to: 'meta', key: 'team' } }),
				{ ...blankField('page_break', 'Notes'), id: 'p3' },
				q('short_text', 'Note', 'note', { map: { to: 'meta', key: 'note' } })
			);
			s.pages = [{ id: 'start', title: s.title, next: [{ when: rule('plan', 'eq', 'free'), goto: 'p3' }] }];
		});
		expect(form.spec.pages[0].next).toHaveLength(1);
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'jump@forms514.test', plan: 'free', team: 'Ops', note: 'hi' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'added' });
		const sub = await db.prepare('SELECT answers FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ answers: string }>();
		expect(JSON.parse(sub!.answers)).toEqual({ email: 'jump@forms514.test', plan: 'free', note: 'hi' });
		const meta = JSON.parse((await contact('jump@forms514.test'))!.meta ?? '{}');
		expect(meta.team).toBeUndefined();
		expect(meta.note).toBe('hi');
		// Not skipped → the page's required question counts again.
		const bad = await handleSubmission(db, baseEnv, form, { answers: { email: 'jump2@forms514.test', plan: 'pro' } }, ctx());
		expect(bad).toMatchObject({ ok: false, detail: 'invalid' });
		expect(bad.errors).toHaveProperty('team');
	});

	it('all vs first; the first fired conditional finish wins; fired ids are stored', async () => {
		const build = (mode: 'all' | 'first') =>
			makeForm((s) => {
				s.fields.push(q('number', 'Score', 'score'));
				s.settings.outcomes_mode = mode;
				s.outcomes.push(
					outcome('low', rule('score', 'lte', '5'), [{ type: 'add_tag', tag: `low-${mode}` }, { type: 'message_md', md: 'Low message' }]),
					outcome('any', rule('score', 'not_empty'), [{ type: 'add_tag', tag: `any-${mode}` }, { type: 'message_md', md: 'Any message' }])
				);
			}, `Score ${mode}`);
		const all = await build('all');
		const ra = await handleSubmission(db, baseEnv, all, { answers: { email: 'all@forms514.test', score: '3' } }, ctx());
		expect(ra.message_html).toContain('Low message');
		expect(await tagNames('all@forms514.test')).toEqual(expect.arrayContaining(['low-all', 'any-all']));
		expect(await outcomesOf(ra.submissionId!)).toEqual(['default', 'low', 'any']);

		const first = await build('first');
		const rf = await handleSubmission(db, baseEnv, first, { answers: { email: 'first@forms514.test', score: '3' } }, ctx());
		expect(rf.message_html).toContain('Low message');
		const tags = await tagNames('first@forms514.test');
		expect(tags).toContain('low-first');
		expect(tags).not.toContain('any-first');
		expect(await outcomesOf(rf.submissionId!)).toEqual(['default', 'low']);
		// No conditional match → the Settings tab's message.
		const rn = await handleSubmission(db, baseEnv, first, { answers: { email: 'none@forms514.test' } }, ctx());
		expect(rn.message_html).toContain('Thanks! We got your answers.');
		expect(await outcomesOf(rn.submissionId!)).toEqual(['default']);
	});

	it('remove_tag takes a tag off (case-insensitive)', async () => {
		await knownContact('rm@forms514.test', ['cold-514', 'keep-514']);
		const form = await makeForm((s) => {
			s.outcomes.push(outcome('warm', null, [{ type: 'remove_tag', tag: 'COLD-514' }]));
		}, 'Remove tag');
		const r = await handleSubmission(db, baseEnv, form, { answers: { email: 'rm@forms514.test' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'updated' });
		const tags = await tagNames('rm@forms514.test');
		expect(tags).toContain('keep-514');
		expect(tags).not.toContain('cold-514');
	});

	it('enroll_automation runs only while settings.enroll is on', async () => {
		const aid = (await db
			.prepare("INSERT INTO automations (name, status, trigger_type, reentry) VALUES ('Form 514 flow', 'active', 'manual', 'once') RETURNING id")
			.first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
				 VALUES (?, 0, 'tag', 'add', 'from-514', '', '', 'sender@forms514.test', 3600)`
			)
			.bind(aid)
			.run();
		const build = (enroll: boolean) =>
			makeForm((s) => {
				s.settings.enroll = enroll;
				s.outcomes.push(outcome('go', rule('email', 'not_empty'), [{ type: 'enroll_automation', automation_id: aid }]));
			}, `Enroll ${enroll}`);
		const passes = async (email: string) =>
			(await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.automation_id = ? AND c.email = ?').bind(aid, email).first<{ n: number }>())!.n;

		const off = await handleSubmission(db, baseEnv, await build(false), { answers: { email: 'off@forms514.test' } }, ctx());
		expect(off.ok).toBe(true);
		expect(await passes('off@forms514.test')).toBe(0);
		const row = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(off.submissionId).first<{ detail: string }>();
		expect(row!.detail).toContain('automation enrolment off');

		const on = await handleSubmission(db, baseEnv, await build(true), { answers: { email: 'on@forms514.test' } }, ctx());
		expect(on.ok).toBe(true);
		expect(await passes('on@forms514.test')).toBe(1);
	});

	it('contact-aware outcomes match a known contact only', async () => {
		await knownContact('vip@forms514.test', ['vip-514'], { plan: 'Pro' });
		const form = await makeForm((s) => {
			s.outcomes.push(
				outcome('vip', rule('contact.has_tag', 'eq', 'vip-514'), [{ type: 'add_tag', tag: 'vip-form-514' }, { type: 'message_md', md: 'Welcome back' }]),
				outcome('pro', rule('contact.field:plan', 'eq', 'pro'), [{ type: 'add_tag', tag: 'pro-form-514' }]),
				outcome('not', rule('contact.has_tag', 'neq', 'vip-514'), [{ type: 'add_tag', tag: 'not-vip-514' }])
			);
		}, 'Known contact');
		const known = await handleSubmission(db, baseEnv, form, { answers: { email: 'vip@forms514.test' } }, ctx());
		expect(known.message_html).toContain('Welcome back');
		const kt = await tagNames('vip@forms514.test');
		expect(kt).toEqual(expect.arrayContaining(['vip-form-514', 'pro-form-514']));
		expect(kt).not.toContain('not-vip-514');

		const fresh = await handleSubmission(db, baseEnv, form, { answers: { email: 'new@forms514.test' } }, ctx());
		expect(fresh.message_html).not.toContain('Welcome back');
		const ft = await tagNames('new@forms514.test');
		expect(ft).not.toContain('vip-form-514');
		// "doesn't have tag" is false for an unknown person too.
		expect(ft).not.toContain('not-vip-514');
		expect(await outcomesOf(fresh.submissionId!)).toEqual(['default']);
	});
});

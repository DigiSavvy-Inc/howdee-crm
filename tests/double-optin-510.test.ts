import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #510: optional double opt-in — pending contact, hashed token, confirm applies the intent,
// expiry / reuse / invalid tokens, resend limits, already-subscribed skip, the #285 guard,
// ingest `confirm: true` + a key's "Require confirmation", and GET never confirming.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn(), suppressionsByEmail: vi.fn(), unsuppress: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch,
	suppressionsByEmail: spies.suppressionsByEmail,
	unsuppress: spies.unsuppress
}));

import {
	cancelPending,
	confirmSubscription,
	expireConfirmations,
	hashToken,
	peekConfirmation,
	requestConfirmation,
	resendConfirmation,
	resendForContact,
	sqlTime
} from '../src/lib/server/double-optin';
import { normalizeDoi, validateDoiText, subscriptionStatusText, DEFAULT_BODY } from '../src/lib/double-optin';
import { subscriptionMatches, subscriptionTriggerText, defaultSubscriptionConfig } from '../src/lib/subscription-trigger';
import { POST as ingest } from '../src/routes/api/ingest/+server';
import { POST as upsert } from '../src/routes/api/contacts/upsert/+server';
import { load as confirmLoad, actions as confirmActions } from '../src/routes/confirm/[token]/+page.server';
import { contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { blankField, emptyForm, withSettingsOutcome } from '../src/lib/forms';
import { createForm, getForm } from '../src/lib/server/forms';
import { handleSubmission } from '../src/lib/server/form-submit';

const db = (env as any).DB as D1Database;
const doiEnv = { POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'alan@ourco.example', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 's' };
const opts = (now?: Date) => ({ baseUrl: 'https://crm.test', ...(now ? { now } : {}) });

/** The token in the last confirmation email sent. */
function lastToken(): string {
	const calls = spies.sendBatch.mock.calls;
	const msgs = calls[calls.length - 1][1] as { TextBody: string }[];
	const m = /\/confirm\/([A-Za-z0-9_-]+)/.exec(msgs[0].TextBody);
	if (!m) throw new Error('no token in the email');
	return m[1];
}

async function contact(email: string) {
	return db
		.prepare('SELECT id, subscribed, confirm_pending, source FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number; subscribed: number; confirm_pending: number; source: string | null }>();
}

async function groupsOf(email: string): Promise<string[]> {
	const r = await db
		.prepare(
			`SELECT l.kind || ':' || l.name AS g FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id
			 WHERE c.email = ? ORDER BY g`
		)
		.bind(email)
		.all<{ g: string }>();
	return r.results.map((x) => x.g);
}

function routeEvent(token: string, method = 'GET', extraEnv: Record<string, unknown> = {}) {
	const url = `https://crm.test/confirm/${token}`;
	return {
		request: new Request(url, { method, headers: { origin: 'https://crm.test' } }),
		url: new URL(url),
		params: { token },
		platform: { env: { ...env, ...doiEnv, ...extraEnv } },
		locals: {},
		setHeaders: () => {}
	} as any;
}

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	spies.suppressionsByEmail.mockResolvedValue({ map: new Map(), errors: [], read: 2 });
	spies.unsuppress.mockResolvedValue({ ok: true });
	await db.batch([
		db.prepare('DELETE FROM subscription_confirmations'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM topic_optouts'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM webhook_events'),
		db.prepare('DELETE FROM webhook_keys'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key = 'double_optin'")
	]);
});

describe('config', () => {
	it('defaults and the strict save check', () => {
		expect(normalizeDoi(null).body).toBe(DEFAULT_BODY);
		expect(normalizeDoi(JSON.stringify({ body: 'no link here' })).body).toBe(DEFAULT_BODY);
		expect(normalizeDoi(JSON.stringify({ expiryHours: 7 })).expiryHours).toBe(48);
		expect(validateDoiText({ body: 'Hi {{first_name}}, no link' }).ok).toBe(false);
		expect(validateDoiText({ body: 'Go: {{confirm_url}}', expiryHours: '12' }).ok).toBe(false);
		expect(validateDoiText({ body: 'Go: {{confirm_url}}', redirectUrl: 'javascript:alert(1)' }).ok).toBe(false);
		const ok = validateDoiText({ body: 'Go: {{confirm_url}}', expiryHours: '24', redirectUrl: 'https://ourco.example' });
		expect(ok.ok && ok.value.expiryHours).toBe(24);
	});
	it('status wording + the new trigger event', () => {
		expect(subscriptionStatusText(0, 1)).toBe('pending confirmation');
		expect(subscriptionStatusText(1, 0)).toBe('subscribed');
		expect(subscriptionStatusText(0, 0)).toBe('unsubscribed');
		const cfg = { ...defaultSubscriptionConfig(), events: ['subscribed' as const] };
		expect(subscriptionMatches(cfg, { event: 'subscribed', source: 'double_optin' })).toBe(true);
		expect(subscriptionTriggerText(cfg, () => null)).toBe('When a contact confirms a subscription');
	});
});

describe('requestConfirmation', () => {
	it('creates a pending contact with no memberships and one hashed row', async () => {
		const res = await requestConfirmation(db, doiEnv, { email: 'New@Example.com', source: 'test', intent: { lists: ['Newsletter'], tags: ['hot'] } }, opts());
		expect(res.sent).toBe(true);
		const c = await contact('new@example.com');
		expect(c).toMatchObject({ subscribed: 0, confirm_pending: 1 });
		expect(await groupsOf('new@example.com')).toEqual([]);
		const rows = await db.prepare('SELECT token_hash, intent FROM subscription_confirmations').all<{ token_hash: string; intent: string }>();
		expect(rows.results).toHaveLength(1);
		const token = lastToken();
		expect(rows.results[0].token_hash).toBe(await hashToken(token));
		expect(rows.results[0].token_hash).not.toContain(token);
		expect(JSON.parse(rows.results[0].intent)).toMatchObject({ lists: ['Newsletter'], tags: ['hot'] });
		// Transactional stream, no tracking, no unsubscribe footer; the stored campaign copy has no token.
		const msg = spies.sendBatch.mock.calls[0][1][0];
		expect(msg.MessageStream).toBe('outbound');
		const camp = await db.prepare('SELECT body_html FROM campaigns ORDER BY id DESC LIMIT 1').first<{ body_html: string }>();
		expect(camp!.body_html).not.toContain(token);
		// Pending is not churn: no unsubscribes row.
		expect((await db.prepare('SELECT COUNT(*) AS n FROM unsubscribes').first<{ n: number }>())!.n).toBe(0);
	});

	it('an already-subscribed contact skips confirmation and gets the intent at once', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('sub@example.com', 1)").run();
		const res = await requestConfirmation(db, doiEnv, { email: 'sub@example.com', source: 'test', intent: { lists: ['Newsletter'] } }, opts());
		expect(res).toMatchObject({ sent: false, reason: 'already_subscribed' });
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await groupsOf('sub@example.com')).toEqual(['list:Newsletter']);
	});

	it('limits re-sends: 10 minutes apart, at most 3', async () => {
		const t0 = new Date('2026-11-03T10:00:00Z');
		const at = (min: number) => new Date(t0.getTime() + min * 60_000);
		const req = (min: number) => requestConfirmation(db, doiEnv, { email: 'r@example.com', source: 'test', intent: {} }, opts(at(min)));
		expect((await req(0)).sent).toBe(true);
		expect(await req(5)).toMatchObject({ sent: false, reason: 'rate_limited' });
		expect((await req(11)).sent).toBe(true);
		expect((await req(22)).sent).toBe(true);
		expect((await req(33)).sent).toBe(true);
		expect(await req(44)).toMatchObject({ sent: false, reason: 'rate_limited' });
		const row = await db.prepare('SELECT resend_count FROM subscription_confirmations').first<{ resend_count: number }>();
		expect(row!.resend_count).toBe(3);
		// The contact page uses the same limit.
		const c = await contact('r@example.com');
		expect(await resendForContact(db, doiEnv, c!.id, opts(at(60)))).toMatchObject({ sent: false, reason: 'rate_limited' });
	});
});

describe('confirmSubscription', () => {
	it('applies lists / tags / topics / fields, subscribes, fires `subscribed` with source double_optin', async () => {
		const topic = await db.prepare("INSERT INTO lists (name, kind, public_topic, topic_label) VALUES ('Tips', 'list', 1, 'Tips') RETURNING id").first<{ id: number }>();
		const tagList = await db.prepare("INSERT INTO lists (name, kind) VALUES ('hot', 'tag') RETURNING id").first<{ id: number }>();
		const auto = await db
			.prepare("INSERT INTO automations (name, status, trigger_type, trigger_config) VALUES ('Confirmed', 'active', 'subscription_changed', ?) RETURNING id")
			.bind(JSON.stringify({ events: ['subscribed'], topic_list_id: null, sources: [] }))
			.first<{ id: number }>();
		await db.prepare("INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 'x', '', '', '')").bind(auto!.id).run();
		const listAuto = await db
			.prepare("INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES ('Hot', 'active', 'list_added', ?) RETURNING id")
			.bind(tagList!.id)
			.first<{ id: number }>();
		await db.prepare("INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 'y', '', '', '')").bind(listAuto!.id).run();

		await requestConfirmation(
			db,
			doiEnv,
			{ email: 'c@example.com', source: 'form', intent: { lists: ['Newsletter'], tags: ['hot'], topics: [topic!.id], fields: { role: 'cto' }, enroll: true, source: 'website' } },
			opts()
		);
		const token = lastToken();
		const res = await confirmSubscription(db, doiEnv, token, { actor: 'self' });
		expect(res).toMatchObject({ ok: true, email: 'c@example.com' });
		const c = await contact('c@example.com');
		expect(c).toMatchObject({ subscribed: 1, confirm_pending: 0, source: 'website' });
		expect(await groupsOf('c@example.com')).toEqual(['list:Newsletter', 'list:Tips', 'tag:hot']);
		const meta = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(c!.id).first<{ meta: string }>();
		expect(JSON.parse(meta!.meta).role).toBe('cto');
		const passes = await db.prepare('SELECT automation_id FROM automation_enrollments WHERE contact_id = ? ORDER BY automation_id').bind(c!.id).all<{ automation_id: number }>();
		expect(passes.results.map((p) => p.automation_id)).toEqual([auto!.id, listAuto!.id]);

		// Reused token → already confirmed, nothing changes.
		expect(await confirmSubscription(db, doiEnv, token)).toMatchObject({ ok: true, alreadyConfirmed: true });
	});

	it('expired, invalid and cancelled tokens', async () => {
		const t0 = new Date('2026-11-03T10:00:00Z');
		await requestConfirmation(db, doiEnv, { email: 'e@example.com', source: 'test', intent: {} }, opts(t0));
		const token = lastToken();
		const later = new Date(t0.getTime() + 49 * 3600_000);
		expect(await confirmSubscription(db, doiEnv, token, { actor: 'self' }, { now: later })).toMatchObject({ ok: false, expired: true });
		expect(await expireConfirmations(db, later)).toEqual({ expired: 1 });
		expect((await contact('e@example.com'))!.confirm_pending).toBe(1); // stays pending
		expect(await peekConfirmation(db, token, later)).toMatchObject({ state: 'expired', canResend: true });
		// "Send a new link" → a fresh token; the old one stops working.
		expect((await resendConfirmation(db, doiEnv, token, opts(later))).sent).toBe(true);
		const fresh = lastToken();
		expect(await confirmSubscription(db, doiEnv, token, { actor: 'self' }, { now: later })).toMatchObject({ invalid: true });
		expect(await confirmSubscription(db, doiEnv, 'nope', { actor: 'self' })).toMatchObject({ ok: false, invalid: true });
		// Cancel from the contact page.
		const c = await contact('e@example.com');
		expect(await cancelPending(db, c!.id)).toBe(true);
		expect(await confirmSubscription(db, doiEnv, fresh, { actor: 'self' }, { now: later })).toMatchObject({ invalid: true });
		expect((await contact('e@example.com'))!.confirm_pending).toBe(0);
	});

	it('an unsubscribed contact with a Postmark hard bounce is refused (#285)', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('hb@example.com', 0)").run();
		await requestConfirmation(db, doiEnv, { email: 'hb@example.com', source: 'test', intent: { lists: ['Newsletter'] } }, opts());
		spies.suppressionsByEmail.mockResolvedValue({ map: new Map([['hb@example.com', { reason: 'HardBounce', stream: 'broadcast' }]]), errors: [], read: 2 });
		const res = await confirmSubscription(db, doiEnv, lastToken());
		expect(res).toMatchObject({ ok: false, refused: true });
		expect(res.error).toMatch(/bounced or were reported as spam/);
		expect((await contact('hb@example.com'))!.subscribed).toBe(0);
		expect(await groupsOf('hb@example.com')).toEqual([]);
	});

	it('an unsubscribed contact with a manual suppression is resubscribed and unsuppressed', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('ms@example.com', 0)").run();
		await requestConfirmation(db, doiEnv, { email: 'ms@example.com', source: 'test', intent: {} }, opts());
		spies.suppressionsByEmail.mockResolvedValue({ map: new Map([['ms@example.com', { reason: 'ManualSuppression', stream: 'broadcast' }]]), errors: [], read: 2 });
		expect((await confirmSubscription(db, doiEnv, lastToken())).ok).toBe(true);
		expect((await contact('ms@example.com'))!.subscribed).toBe(1);
		expect(spies.unsuppress).toHaveBeenCalledWith('pm-test', 'broadcast', 'ms@example.com');
	});
});

describe('/confirm page', () => {
	it('GET never confirms; the POST button does', async () => {
		await requestConfirmation(db, doiEnv, { email: 'g@example.com', source: 'test', intent: { lists: ['Newsletter'] } }, opts());
		const token = lastToken();
		const data = (await confirmLoad(routeEvent(token))) as { state: string; email: string };
		expect(data).toMatchObject({ state: 'ready', email: 'g@example.com' });
		expect((await contact('g@example.com'))!.subscribed).toBe(0);
		const res = (await confirmActions.confirm(routeEvent(token, 'POST'))) as { state: string };
		expect(res.state).toBe('confirmed');
		expect((await contact('g@example.com'))!.subscribed).toBe(1);
		expect(((await confirmLoad(routeEvent(token))) as { state: string }).state).toBe('already');
		expect(((await confirmLoad(routeEvent('bogus'))) as { state: string }).state).toBe('invalid');
	});
});

describe('ingest + upsert', () => {
	function post(handler: typeof ingest, path: string, token: string, body: Record<string, unknown>) {
		const url = `https://crm.test${path}`;
		return handler({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify(body)
			}),
			url: new URL(url),
			platform: { env: { ...env, ...doiEnv, INGEST_KEY: 'ingest-k', PUBLIC_BASE_URL: 'https://crm.test' } }
		} as any);
	}

	it('/api/ingest with confirm: true → pending, list waits for the confirm', async () => {
		const res = await post(ingest, '/api/ingest', 'ingest-k', { email: 'i@example.com', list: 'Signup', tags: ['webinar'], confirm: true, project: 'x' });
		expect(await res.json()).toMatchObject({ ok: true, status: 'pending_confirmation' });
		expect(await contact('i@example.com')).toMatchObject({ subscribed: 0, confirm_pending: 1 });
		expect(await groupsOf('i@example.com')).toEqual([]);
		await confirmSubscription(db, doiEnv, lastToken());
		expect(await groupsOf('i@example.com')).toEqual(['list:Signup', 'tag:webinar']);
	});

	it("a key's Require confirmation; off = the old behaviour", async () => {
		await db.prepare("INSERT INTO webhook_keys (label, token, default_list, require_confirm) VALUES ('DOI', 'wk_doi', 'Keyed', 1)").run();
		const r1 = await post(ingest, '/api/ingest', 'wk_doi', { email: 'k@example.com' });
		expect(((await r1.json()) as { status: string }).status).toBe('pending_confirmation');
		const r2 = await post(ingest, '/api/ingest', 'ingest-k', { email: 'plain@example.com', list: 'Plain' });
		expect(((await r2.json()) as { status: string }).status).toBe('added');
		expect(await contact('plain@example.com')).toMatchObject({ subscribed: 1, confirm_pending: 0 });
		expect(await groupsOf('plain@example.com')).toEqual(['list:Plain']);
	});

	it('/api/contacts/upsert with confirm: true', async () => {
		const res = await post(upsert as typeof ingest, '/api/contacts/upsert', 'ingest-k', { email: 'u@example.com', list: 'Up', confirm: true });
		expect(await res.json()).toMatchObject({ ok: true, status: 'pending_confirmation' });
		expect(await groupsOf('u@example.com')).toEqual([]);
	});
});

describe('contacts filter', () => {
	it('status=pending vs unsubscribed', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed, confirm_pending) VALUES ('p@example.com', 0, 1), ('x@example.com', 0, 0), ('s@example.com', 1, 0)").run();
		const count = async (status: string) => {
			const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams({ status })));
			return (await db.prepare(`SELECT email FROM contacts ${where} ORDER BY email`).bind(...params).all<{ email: string }>()).results.map((r) => r.email);
		};
		expect(await count('pending')).toEqual(['p@example.com']);
		expect(await count('unsubscribed')).toEqual(['x@example.com']);
	});
	it('sqlTime format', () => {
		expect(sqlTime(new Date('2026-11-03T10:00:00.123Z'))).toBe('2026-11-03 10:00:00');
	});
});

describe('form submit (#509 settings.double_optin)', () => {
	let ipN = 0;
	const ctx = () => ({ origin: 'https://crm.test', crmOrigins: ['https://crm.test'], ip: `10.9.0.${++ipN}`, baseUrl: 'https://crm.test', mxLookup: async () => 'ok' as const });
	async function doiForm(doi: boolean) {
		const id = await createForm(db, `DOI form ${doi}`, null);
		let spec = emptyForm('DOI form');
		spec.fields.push({ ...blankField('short_text', 'First name'), key: 'first', map: { to: 'contact', field: 'first_name' } });
		spec = withSettingsOutcome(spec, [{ type: 'add_tag', tag: 'form-doi' }]);
		spec.settings.double_optin = doi;
		await db.prepare("UPDATE forms SET spec = ?, status = 'published' WHERE id = ?").bind(JSON.stringify(spec), id).run();
		return (await getForm(db, id))!;
	}

	it('leaves a new address pending with the tag in the intent; confirming applies it', async () => {
		const form = await doiForm(true);
		const r = await handleSubmission(db, doiEnv, form, { answers: { email: 'Form@Doi.test', first: 'Fay' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'added' });
		const c = await contact('form@doi.test');
		expect(c).toMatchObject({ subscribed: 0, confirm_pending: 1 });
		expect(await groupsOf('form@doi.test')).toEqual([]);
		const sub = await db.prepare('SELECT contact_id, status, detail FROM form_submissions WHERE email = ?').bind('form@doi.test').first<{ contact_id: number; status: string; detail: string }>();
		expect(sub).toMatchObject({ contact_id: c!.id, status: 'added' });
		expect(sub!.detail).toContain('pending confirmation');
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		const done = await confirmSubscription(db, doiEnv, lastToken(), { actor: 'self' });
		expect(done.ok).toBe(true);
		expect(await contact('form@doi.test')).toMatchObject({ subscribed: 1, confirm_pending: 0, source: 'form' });
		expect(await groupsOf('form@doi.test')).toEqual(['tag:form-doi']);
	});

	it('an already-subscribed address skips the email; the flag off writes at once', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('sub@doi.test', 1)").run();
		const r = await handleSubmission(db, doiEnv, await doiForm(true), { answers: { email: 'sub@doi.test' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'updated' });
		expect(await groupsOf('sub@doi.test')).toEqual(['tag:form-doi']);
		const off = await handleSubmission(db, doiEnv, await doiForm(false), { answers: { email: 'off@doi.test' } }, ctx());
		expect(off).toMatchObject({ ok: true, detail: 'added' });
		expect(await contact('off@doi.test')).toMatchObject({ subscribed: 1, confirm_pending: 0 });
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});
});

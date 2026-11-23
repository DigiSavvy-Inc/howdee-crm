import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #541: a public form never resubscribes an unsubscribed contact on its own. A consent tick sends
// the confirmation email (double opt-in on or off); tags, lists and triggers wait for the confirm.
// Origin-rejected and honeypot submissions are only recorded after the rate limit.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn(), suppressionsByEmail: vi.fn(), unsuppress: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch,
	suppressionsByEmail: spies.suppressionsByEmail,
	unsuppress: spies.unsuppress
}));

import { blankField, emptyForm, withSettingsOutcome, type FormField } from '../src/lib/forms';
import { createForm, getForm, type FormRow } from '../src/lib/server/forms';
import { handleSubmission, RATE_PER_IP, type SubmitContext } from '../src/lib/server/form-submit';
import { confirmSubscription } from '../src/lib/server/double-optin';

const db = (env as any).DB as D1Database;
const pmEnv = { POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'alan@ourco.example', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 's' };
let ipN = 0;
const ctx = (extra: Partial<SubmitContext> = {}): SubmitContext => ({
	origin: 'https://crm.test',
	crmOrigins: ['https://crm.test'],
	ip: `10.54.1.${++ipN}`,
	baseUrl: 'https://crm.test',
	mxLookup: async () => 'ok',
	...extra
});

function lastToken(): string {
	const calls = spies.sendBatch.mock.calls;
	const msgs = calls[calls.length - 1][1] as { TextBody: string }[];
	const m = /\/confirm\/([A-Za-z0-9_-]+)/.exec(msgs[0].TextBody);
	if (!m) throw new Error('no token in the email');
	return m[1];
}

const contact = (email: string) =>
	db.prepare('SELECT id, subscribed, confirm_pending, meta FROM contacts WHERE email = ?').bind(email).first<{ id: number; subscribed: number; confirm_pending: number; meta: string | null }>();

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

let formN = 0;
async function consentForm(doubleOptin: boolean, listId: number): Promise<FormRow> {
	const name = `Resub form ${++formN}`;
	const id = await createForm(db, name, null);
	let spec = emptyForm(name);
	const f = (type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField => ({ ...blankField(type, label), key, ...extra });
	spec.fields.push(f('consent', 'Yes, email me', 'consent', { required: false }), f('short_text', 'Role', 'role', { map: { to: 'meta', key: 'role' } }));
	spec = withSettingsOutcome(spec, [{ type: 'add_tag', tag: 'resub-541' }, { type: 'add_to_list', list_id: listId }]);
	spec.settings.double_optin = doubleOptin;
	spec.settings.enroll = true;
	await db.prepare("UPDATE forms SET spec = ?, status = 'published' WHERE id = ?").bind(JSON.stringify(spec), id).run();
	return (await getForm(db, id))!;
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
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM form_submissions'),
		db.prepare('DELETE FROM rate_limits'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function setup() {
	const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Resub list', 'list') RETURNING id").first<{ id: number }>())!.id;
	const tag = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('resub-541', 'tag') RETURNING id").first<{ id: number }>())!.id;
	await db.prepare("INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES ('On resub tag', 'active', 'list_added', ?)").bind(tag).run();
	await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('gone@resub.test', 0)").run();
	return { list };
}

describe('form consent on an unsubscribed contact (#541)', () => {
	for (const doi of [false, true]) {
		it(`sends a confirm email and holds tags / lists until confirm (double opt-in ${doi ? 'on' : 'off'})`, async () => {
			const { list } = await setup();
			const form = await consentForm(doi, list);
			const r = await handleSubmission(db, pmEnv, form, { answers: { email: 'gone@resub.test', consent: 'on', role: 'cto' } }, ctx());
			expect(r).toMatchObject({ ok: true, detail: 'updated' });
			const c = (await contact('gone@resub.test'))!;
			expect(c).toMatchObject({ subscribed: 0, confirm_pending: 1 });
			expect(JSON.parse(c.meta ?? '{}').role).toBeUndefined();
			expect(await groupsOf('gone@resub.test')).toEqual([]);
			const enrolled = await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE contact_id = ?').bind(c.id).first<{ n: number }>();
			expect(enrolled!.n).toBe(0);
			expect(spies.unsuppress).not.toHaveBeenCalled();
			expect(spies.sendBatch).toHaveBeenCalledTimes(1);
			const sub = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ detail: string }>();
			expect(sub!.detail).toContain('resubscribe needs confirmation');
			expect(sub!.detail).toContain('pending confirmation: confirm email sent');

			const done = await confirmSubscription(db, pmEnv, lastToken(), { actor: 'self' });
			expect(done.ok).toBe(true);
			expect(await contact('gone@resub.test')).toMatchObject({ subscribed: 1, confirm_pending: 0 });
			expect(await groupsOf('gone@resub.test')).toEqual(['list:Resub list', 'tag:resub-541']);
			expect(JSON.parse((await contact('gone@resub.test'))!.meta ?? '{}').role).toBe('cto');
		});
	}

	it('a hard-bounced address gets no email and stays unsubscribed', async () => {
		const { list } = await setup();
		spies.suppressionsByEmail.mockResolvedValue({ map: new Map([['gone@resub.test', { reason: 'HardBounce', stream: 'broadcast' }]]), errors: [], read: 2 });
		const r = await handleSubmission(db, pmEnv, await consentForm(false, list), { answers: { email: 'gone@resub.test', consent: 'on' } }, ctx());
		expect(r.ok).toBe(true);
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await contact('gone@resub.test')).toMatchObject({ subscribed: 0, confirm_pending: 0 });
		const sub = await db.prepare('SELECT detail FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ detail: string }>();
		expect(sub!.detail).toContain('kept unsubscribed: suppressed in Postmark');
	});

	it('without consent: no email, stays unsubscribed', async () => {
		const { list } = await setup();
		const r = await handleSubmission(db, pmEnv, await consentForm(false, list), { answers: { email: 'gone@resub.test' } }, ctx());
		expect(r.ok).toBe(true);
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await contact('gone@resub.test')).toMatchObject({ subscribed: 0, confirm_pending: 0 });
	});

	it('a new address with double opt-in off is still subscribed at once', async () => {
		const { list } = await setup();
		const r = await handleSubmission(db, pmEnv, await consentForm(false, list), { answers: { email: 'new@resub.test', consent: 'on' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'added' });
		expect(spies.sendBatch).not.toHaveBeenCalled();
		expect(await contact('new@resub.test')).toMatchObject({ subscribed: 1, confirm_pending: 0 });
	});
});

describe('rate limit before origin / honeypot rows (#541)', () => {
	it('stops storing rejected and spam rows once the visitor is rate limited', async () => {
		const { list } = await setup();
		const form = await consentForm(false, list);
		const c = ctx({ ip: '198.51.100.7', origin: 'https://evil.test' });
		for (let i = 0; i < RATE_PER_IP; i++) {
			const r = await handleSubmission(db, pmEnv, form, { answers: { email: 'x@resub.test' } }, c);
			expect(r).toMatchObject({ status: 403, detail: 'origin' });
		}
		const limited = await handleSubmission(db, pmEnv, form, { answers: { email: 'x@resub.test' } }, c);
		expect(limited).toMatchObject({ status: 429, detail: 'rate_limit' });
		const spam = await handleSubmission(db, pmEnv, form, { answers: { email: 'x@resub.test' }, honeypot: 'http://spam' }, ctx({ ip: '198.51.100.7' }));
		expect(spam).toMatchObject({ status: 429, detail: 'rate_limit' });
		const rows = await db.prepare('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ?').bind(form.id).first<{ n: number }>();
		expect(rows!.n).toBe(RATE_PER_IP);
	});
});

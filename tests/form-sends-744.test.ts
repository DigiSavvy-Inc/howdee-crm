import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #744: public forms and the ingest webhook — client buckets (IPv6 by /64), the per-form daily
// send cap with held submissions an admin releases, the shared email check, and two ingest
// follow-ups (a request-log row when a key reaches its shared limit; an open confirmation keeps
// its choices when a key that doesn't trust the body submits the address again).
const spies = vi.hoisted(() => ({ sendBatch: vi.fn(), suppressionsByEmail: vi.fn(), unsuppress: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch,
	suppressionsByEmail: spies.suppressionsByEmail,
	unsuppress: spies.unsuppress
}));

import { isEmail, isStoredEmail } from '../src/lib/csv';
import { checkAddressSync } from '../src/lib/email-hygiene';
import { coerceAnswers, DEFAULT_DAILY_SEND_CAP, emptyForm, normalizeFormSpec, validateFormSpec, type FormSpec } from '../src/lib/forms';
import {
	createForm,
	discardHeld,
	getForm,
	heldSubmissionSummary,
	isPreMigrationHeldError,
	listForms,
	listSubmissions,
	type FormRow
} from '../src/lib/server/forms';
import { listFormsForApi } from '../src/lib/server/forms-api';
import {
	CONFIRMATION_SENT_NOTE,
	handleSubmission,
	HELD_DETAIL,
	RATE_PER_IP,
	RELEASE_FAILED,
	releaseAllHeld,
	releaseHeldSubmission,
	sendCapKey,
	type SubmitContext
} from '../src/lib/server/form-submit';
import { requestConfirmation } from '../src/lib/server/double-optin';
import { deleteContactsByIds } from '../src/lib/server/contacts';
import { HYGIENE_INVALID_TAG, runHygieneBackfill, startHygieneBackfill } from '../src/lib/server/hygiene';
import { generateApiKey } from '../src/lib/server/api-keys';
import { PATCH as patchContact } from '../src/routes/api/v1/contacts/[id]/+server';
import { clientBucket, clientHash } from '../src/lib/server/rate-limit';
import { clientBucket as keysClientBucket } from '../src/lib/server/webhook-keys';
import { POST as ingest } from '../src/routes/api/ingest/+server';

const db = (env as any).DB as D1Database;
const SECRET = 'test-secret-744';
const pmEnv = { POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'sender@forms744.test', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: SECRET };
let ipN = 0;
let mailN = 0;
const ctx = (extra: Partial<SubmitContext> = {}): SubmitContext => ({
	origin: 'https://crm.test',
	crmOrigins: ['https://crm.test'],
	ip: `198.51.100.${++ipN % 250}`,
	baseUrl: 'https://crm.test',
	mxLookup: async () => 'ok',
	...extra
});
const mail = () => `p${++mailN}@forms744.test`;

async function makeForm(mutate: (s: FormSpec) => void = () => {}): Promise<FormRow> {
	const id = await createForm(db, 'Cap form', null);
	const spec = emptyForm('Cap form');
	mutate(spec);
	await db.prepare("UPDATE forms SET spec = ?, status = 'published' WHERE id = ?").bind(JSON.stringify(spec), id).run();
	return (await getForm(db, id))!;
}
const contact = (email: string) => db.prepare('SELECT id, subscribed, confirm_pending FROM contacts WHERE email = ?').bind(email).first<{ id: number; subscribed: number; confirm_pending: number }>();
const sub = (id: number) =>
	db.prepare('SELECT status, contact_id, detail, held_at, released_at, released_by FROM form_submissions WHERE id = ?').bind(id).first<Record<string, any>>();
/** Remove one address's confirmations and contact. A confirmation send leaves `recipients` (and
 *  maybe `events`) rows on the contact with no ON DELETE action, so the contact goes through the
 *  contacts bulk delete (events, recipients, memberships, then the contact). */
async function removeContact(email: string): Promise<void> {
	await db.prepare('DELETE FROM subscription_confirmations WHERE email = ?').bind(email).run();
	const row = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
	if (row) await deleteContactsByIds(db, [row.id]);
}

beforeEach(async () => {
	spies.sendBatch.mockReset();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: { To: string }[]) =>
		msgs.map((m, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m744-${Date.now()}-${i}`, To: m.To }))
	);
	spies.suppressionsByEmail.mockReset();
	spies.suppressionsByEmail.mockResolvedValue({ map: new Map(), failed: [] });
	await db.prepare('DELETE FROM rate_limits').run();
});

describe('client buckets', () => {
	it('counts IPv4 as is and IPv6 by its /64; webhook keys use the same helper', () => {
		expect(clientBucket('192.0.2.7')).toBe('192.0.2.7');
		expect(clientBucket('2001:db8:aa:bb:1::2')).toBe('2001:db8:aa:bb::/64');
		expect(clientBucket('2001:db8:aa:bb:ffff:ffff:ffff:ffff')).toBe('2001:db8:aa:bb::/64');
		expect(clientBucket('::ffff:192.0.2.9')).toBe('192.0.2.9');
		expect(clientBucket('')).toBeNull();
		expect(keysClientBucket).toBe(clientBucket);
	});

	it('hashes the bucket, never the raw address', async () => {
		const a = await clientHash('2001:db8:1:2::1', SECRET);
		const b = await clientHash('2001:db8:1:2:9::9', SECRET);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(a).toBe(b);
		expect(await clientHash('2001:db8:1:3::1', SECRET)).not.toBe(a);
		expect(await clientHash(null, SECRET)).toBeNull();
	});

	it('a hosted form limits every address of one IPv6 /64 together', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 0));
		for (let i = 1; i <= RATE_PER_IP; i++) {
			const r = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx({ ip: `2001:db8:744:1::${i.toString(16)}` }));
			expect(r.status).toBe(200);
		}
		const over = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx({ ip: '2001:db8:744:1:abcd:ef01:2345:6789' }));
		expect(over).toMatchObject({ ok: false, status: 429, detail: 'rate_limit' });
		const other = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx({ ip: '2001:db8:744:2::1' }));
		expect(other.status).toBe(200);
	});
});

describe('daily send cap: settings', () => {
	it('defaults to 500, keeps 0 (no cap), and falls back on junk', () => {
		expect(DEFAULT_DAILY_SEND_CAP).toBe(500);
		expect(emptyForm().settings.daily_send_cap).toBe(500);
		const base = JSON.parse(JSON.stringify(emptyForm()));
		delete base.settings.daily_send_cap;
		expect(normalizeFormSpec(base).settings.daily_send_cap).toBe(500);
		expect(normalizeFormSpec({ ...base, settings: { ...base.settings, daily_send_cap: 0 } }).settings.daily_send_cap).toBe(0);
		expect(normalizeFormSpec({ ...base, settings: { ...base.settings, daily_send_cap: 25 } }).settings.daily_send_cap).toBe(25);
		for (const junk of [-1, 1.5, 'lots', true, null]) {
			expect(normalizeFormSpec({ ...base, settings: { ...base.settings, daily_send_cap: junk } }).settings.daily_send_cap).toBe(500);
		}
	});

	it('the save check refuses a value out of range', () => {
		for (const bad of [-1, 2.5, 100001]) {
			const s = emptyForm();
			s.settings.daily_send_cap = bad;
			expect(validateFormSpec(s).map((p) => p.path)).toContain('settings.daily_send_cap');
		}
		const ok = emptyForm();
		ok.settings.daily_send_cap = 0;
		expect(validateFormSpec(ok).map((p) => p.path)).not.toContain('settings.daily_send_cap');
	});
});

describe('daily send cap: assistant drafts', () => {
	it("keeps the form's own limit (the default for a new draft)", async () => {
		const { prepareFormSpec } = await import('../src/lib/server/ai/tools/form-input');
		const raw = { fields: [{ type: 'email', label: 'Email', required: true, map: { to: 'contact', field: 'email' } }], settings: { daily_send_cap: 0 } };
		const fresh = await prepareFormSpec(db, raw, { name: 'cap', userId: 1 });
		expect(fresh.ok).toBe(true);
		if (fresh.ok) {
			expect(fresh.spec.settings.daily_send_cap).toBe(500);
			expect(fresh.notes.join(' ')).toMatch(/daily send limit/);
		}
		const current = emptyForm();
		current.settings.daily_send_cap = 40;
		const upd = await prepareFormSpec(db, raw, { name: 'cap', userId: 1, current });
		if (upd.ok) expect(upd.spec.settings.daily_send_cap).toBe(40);
		else throw new Error('expected ok');
	});
});

describe('daily send cap: holding and releasing', () => {
	it('holds new addresses past the cap: stored, nothing written, normal finish', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 2));
		const a = mail();
		const b = mail();
		const c = mail();
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: a } }, ctx())).detail).toBe('added');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: b } }, ctx())).detail).toBe('added');
		const held = await handleSubmission(db, pmEnv, form, { answers: { email: c } }, ctx());
		expect(held).toMatchObject({ ok: true, status: 200, detail: 'held' });
		expect(held.message_html).toBeTruthy();
		expect(await contact(c)).toBeNull();
		const row = await sub(held.submissionId!);
		expect(row).toMatchObject({ status: 'anonymous', contact_id: null, detail: HELD_DETAIL });
		expect(row!.held_at).toBeTruthy();

		// Held rows are listed under "held" only, not with accepted submissions (API, CSV).
		const ok = await listSubmissions(db, form.id, { status: 'ok' });
		expect(ok.rows.map((r) => r.email)).not.toContain(c);
		const heldList = await listSubmissions(db, form.id, { status: 'held' });
		expect(heldList.rows.map((r) => r.email)).toEqual([c]);
		expect(heldList.rows[0].held_at).toBeTruthy();

		// The admin notice lists the form.
		const summary = await heldSubmissionSummary(db);
		expect(summary.find((s) => s.form_id === form.id)).toMatchObject({ name: 'Cap form', held: 1 });
	});

	it("an existing contact's submission isn't counted and still goes through", async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		const known = mail();
		await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1)').bind(known).run();
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx())).detail).toBe('added');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: known } }, ctx())).detail).toBe('updated');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx())).detail).toBe('held');
	});

	it('0 means no cap', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 0));
		for (let i = 0; i < 4; i++) expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx())).detail).toBe('added');
	});

	it('the cap is per UTC day', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		const day1 = new Date('2026-11-20T23:00:00Z');
		const day2 = new Date('2026-11-21T00:30:00Z');
		expect(sendCapKey(form.id, day1)).not.toBe(sendCapKey(form.id, day2));
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx({ now: day1 }))).detail).toBe('added');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx({ now: day1 }))).detail).toBe('held');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx({ now: day2 }))).detail).toBe('added');
	});

	it('sends no confirmation email past the cap; releasing sends it', async () => {
		const form = await makeForm((s) => {
			s.settings.daily_send_cap = 1;
			s.settings.double_optin = true;
		});
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		const later = mail();
		const held = await handleSubmission(db, pmEnv, form, { answers: { email: later } }, ctx());
		expect(held.detail).toBe('held');
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		expect(await contact(later)).toBeNull();

		const r = await releaseHeldSubmission(db, pmEnv, form, held.submissionId!, { baseUrl: 'https://crm.test', userId: 7 });
		expect(r).toEqual({ ok: true, status: 'added' });
		expect(spies.sendBatch).toHaveBeenCalledTimes(2);
		expect(await contact(later)).toMatchObject({ subscribed: 0, confirm_pending: 1 });
		const row = await sub(held.submissionId!);
		expect(row!.held_at).toBeNull();
		expect(row!.released_at).toBeTruthy();
		expect(row!.released_by).toBe(7);
		expect(String(row!.detail)).toMatch(/^released/);
	});

	it('a release runs once; a released row is no longer held', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const email = mail();
		const held = await handleSubmission(db, pmEnv, form, { answers: { email } }, ctx());
		expect((await releaseHeldSubmission(db, pmEnv, form, held.submissionId!)).ok).toBe(true);
		expect(await contact(email)).toMatchObject({ subscribed: 1 });
		expect(await sub(held.submissionId!)).toMatchObject({ status: 'added' });
		expect(await releaseHeldSubmission(db, pmEnv, form, held.submissionId!)).toMatchObject({ ok: false, status: 404 });
		const other = await makeForm();
		expect(await releaseHeldSubmission(db, pmEnv, other, held.submissionId!)).toMatchObject({ ok: false, status: 404 });
	});

	it('release all runs every held submission of the form', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const held = [mail(), mail(), mail()];
		for (const e of held) expect((await handleSubmission(db, pmEnv, form, { answers: { email: e } }, ctx())).detail).toBe('held');
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 3, failed: 0, remaining: 0, stopped: false });
		for (const e of held) expect(await contact(e)).toMatchObject({ subscribed: 1 });
		expect((await heldSubmissionSummary(db)).find((s) => s.form_id === form.id)).toBeUndefined();
	});

	it('the builder actions are admin-only', async () => {
		const page = await import('../src/routes/forms/[id]/+page.server');
		const form = await makeForm();
		const body = new FormData();
		body.set('submission_id', '1');
		const url = new URL(`https://crm.test/forms/${form.id}`);
		const ev = {
			request: new Request(url, { method: 'POST', body }),
			url,
			params: { id: String(form.id) },
			platform: { env: pmEnv },
			locals: { user: { id: 5, github_login: 'member-744', role: 'member', navLayout: 'top' } }
		} as any;
		await expect((page.actions as any).releaseSubmission(ev)).rejects.toMatchObject({ status: 403 });
		await expect((page.actions as any).releaseHeld({ ...ev, request: new Request(url, { method: 'POST', body: new FormData() }) })).rejects.toMatchObject({ status: 403 });
	});
});

describe('the shared email check', () => {
	it('accepts addresses in real use', () => {
		for (const ok of [
			'jane@ourco.example',
			'jane.doe+news@mail.sub.ourco.example',
			"o'brien@ourco.example",
			'x@xn--bcher-kva.example',
			'user@shop.localhost',
			'a_b-c@my-host.example.net',
			'  padded@ourco.example  '
		])
			expect(isEmail(ok), ok).toBe(true);
	});

	it('refuses malformed addresses', () => {
		for (const bad of [
			'',
			'jane',
			'jane@ourco',
			'jane..doe@ourco.example',
			'.jane@ourco.example',
			'jane.@ourco.example',
			'jane@ourco..example',
			'jane@.ourco.example',
			'jane@ourco.example.',
			'jane@-ourco.example',
			'jane@ourco-.example',
			'ja\\ne@ourco.example',
			'ja ne@ourco.example',
			'jane@our co.example',
			'ja\u0007ne@ourco.example',
			'ja\nne@ourco.example',
			'"jane"@ourco.example',
			'jane@a@ourco.example',
			'jane@ourco.e',
			'jane@192.0.2.1',
			`${'a'.repeat(65)}@ourco.example`,
			// Invisible characters: format characters (Cf) and lone surrogates.
			'ja\u200bne@ourco.example',
			'jane@our\u200cco.example',
			'ja\u200dne@ourco.example',
			'ja\u200ene@ourco.example',
			'ja\u200fne@ourco.example',
			'\u202ajane@ourco.example',
			'jane\u202e@ourco.example',
			'ja\u2066ne@ourco.example',
			'jane@our\u2069co.example',
			'ja\u2060ne@ourco.example',
			'\ufeffjane@ourco.example',
			'jane@ourco.example\ufeff',
			'ja\u00adne@ourco.example',
			'ja\ud800ne@ourco.example',
			'jane@our\udc00co.example'
		])
			expect(isEmail(bad), JSON.stringify(bad)).toBe(false);
	});

	it('still accepts non-ASCII letters and a valid surrogate pair', () => {
		expect(isEmail('j\u00f6ran@ourco.example')).toBe(true);
		expect(isEmail('jane\ud83d\ude00@ourco.example')).toBe(true);
	});

	it('keeps the looser stored-address rule for addresses already on a contact', () => {
		expect(isStoredEmail('jane..doe@ourco.example')).toBe(true);
		expect(isStoredEmail('  jane.@ourco.example ')).toBe(true);
		expect(isStoredEmail('jane')).toBe(false);
		expect(isStoredEmail('ja ne@ourco.example')).toBe(false);
		expect(checkAddressSync('jane..doe@ourco.example').syntax).toBe(false);
		expect(checkAddressSync('jane..doe@ourco.example', { stored: true }).syntax).toBe(true);
	});

	it('a form email question uses it', () => {
		const spec = emptyForm();
		const key = spec.fields[0].key;
		expect(coerceAnswers(spec, { [key]: 'jane..doe@ourco.example' }).errors[key]).toBeTruthy();
		expect(coerceAnswers(spec, { [key]: 'Jane+x@Mail.OurCo.example' }).answers[key]).toBe('jane+x@mail.ourco.example');
	});
});

describe('daily send cap: a release that fails', () => {
	// A contact insert for this address fails, so the release's processing throws after the claim.
	const failOn = (email: string) =>
		db.prepare(`CREATE TRIGGER IF NOT EXISTS t744_fail BEFORE INSERT ON contacts WHEN NEW.email = '${email}' BEGIN SELECT RAISE(ABORT, 'insert refused for the test'); END`).run();
	/** Contact inserts fail for every one of these addresses. */
	const failOnAll = (emails: string[]) =>
		db
			.prepare(
				`CREATE TRIGGER IF NOT EXISTS t744_fail BEFORE INSERT ON contacts WHEN NEW.email IN (${emails.map((e) => `'${e}'`).join(', ')}) BEGIN SELECT RAISE(ABORT, 'insert refused for the test'); END`
			)
			.run();
	/** Putting a claimed row back (held_at set again) fails. */
	const failRestore = () =>
		db
			.prepare(
				"CREATE TRIGGER IF NOT EXISTS t744_fail_restore BEFORE UPDATE ON form_submissions WHEN OLD.held_at IS NULL AND NEW.held_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'restore refused for the test'); END"
			)
			.run();
	/** Saving a finished release fails (after any confirmation email was handed off). */
	const failSave = () =>
		db
			.prepare(
				"CREATE TRIGGER IF NOT EXISTS t744_fail_save BEFORE UPDATE ON form_submissions WHEN substr(IFNULL(NEW.detail, ''), 1, 8) = 'released' BEGIN SELECT RAISE(ABORT, 'save refused for the test'); END"
			)
			.run();
	const stopFailing = async () => {
		await db.prepare('DROP TRIGGER IF EXISTS t744_fail').run();
		await db.prepare('DROP TRIGGER IF EXISTS t744_fail_restore').run();
		await db.prepare('DROP TRIGGER IF EXISTS t744_fail_save').run();
	};
	const failedDetail = new RegExp(`^${HELD_DETAIL}; release failed: [a-z ]+$`);
	/** Hold `n` submissions on a form whose daily limit is used up. */
	async function holdMany(form: FormRow, n: number): Promise<{ id: number; email: string }[]> {
		const out: { id: number; email: string }[] = [];
		for (let i = 0; i < n; i++) {
			if (i % 9 === 8) await db.prepare("DELETE FROM rate_limits WHERE key NOT LIKE 'form-sends:%'").run();
			const email = mail();
			const r = await handleSubmission(db, pmEnv, form, { answers: { email } }, ctx());
			expect(r.detail).toBe('held');
			out.push({ id: r.submissionId!, email });
		}
		return out;
	}
	afterEach(async () => {
		await stopFailing();
	});

	it('leaves the row held and releasable again', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const email = mail();
		const held = await handleSubmission(db, pmEnv, form, { answers: { email } }, ctx());
		expect(held.detail).toBe('held');
		const before = await sub(held.submissionId!);

		await failOn(email);
		const r = await releaseHeldSubmission(db, pmEnv, form, held.submissionId!, { userId: 7 });
		expect(r).toEqual({ ok: false, status: 500, error: RELEASE_FAILED });
		const after = await sub(held.submissionId!);
		expect(after).toMatchObject({ status: 'anonymous', contact_id: null, held_at: before!.held_at, released_at: null, released_by: null });
		// The row says why, in fixed words: never the address or the error text.
		expect(String(after!.detail)).toMatch(failedDetail);
		expect(String(after!.detail)).not.toContain('@');
		expect(String(after!.detail)).not.toContain('refused');
		expect(await contact(email)).toBeNull();
		expect((await listSubmissions(db, form.id, { status: 'held' })).rows.map((x) => x.id)).toEqual([held.submissionId]);

		await stopFailing();
		expect(await releaseHeldSubmission(db, pmEnv, form, held.submissionId!, { userId: 7 })).toEqual({ ok: true, status: 'added' });
		expect(await contact(email)).toMatchObject({ subscribed: 1 });
		expect(await sub(held.submissionId!)).toMatchObject({ held_at: null, released_by: 7 });
	});

	it('release all releases the others and reports the failure', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const held = [mail(), mail(), mail()];
		for (const e of held) expect((await handleSubmission(db, pmEnv, form, { answers: { email: e } }, ctx())).detail).toBe('held');
		await failOn(held[1]);
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 2, failed: 1, remaining: 1, stopped: false });
		expect(await contact(held[0])).toMatchObject({ subscribed: 1 });
		expect(await contact(held[1])).toBeNull();
		expect(await contact(held[2])).toMatchObject({ subscribed: 1 });
		expect((await listSubmissions(db, form.id, { status: 'held' })).rows.map((x) => x.email)).toEqual([held[1]]);
	});

	it('release all runs at most 10 per call and says how many remain', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		await holdMany(form, 12);
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 10, failed: 0, remaining: 2, stopped: false });
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 2, failed: 0, remaining: 0, stopped: false });
	});

	it('rows that always fail go last, so two calls release the other ten of twelve', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const held = await holdMany(form, 12);
		await failOnAll([held[0].email, held[1].email]);
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 8, failed: 2, remaining: 4, stopped: false });
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 2, failed: 2, remaining: 2, stopped: false });
		for (const h of held.slice(2)) expect(await contact(h.email)).toMatchObject({ subscribed: 1 });
		const left = await listSubmissions(db, form.id, { status: 'held' });
		expect(left.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([held[0].id, held[1].id]);
		for (const r of left.rows) expect(String(r.detail)).toMatch(failedDetail);
	});

	it('a row a failed release could not put back still counts as held and is released once', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const [stranded, other] = await holdMany(form, 2);
		// The state by hand: claimed (held_at cleared, released_* set) an hour ago, never put back.
		await db.prepare("UPDATE form_submissions SET held_at = NULL, released_at = datetime('now', '-1 hour'), released_by = 7 WHERE id = ?").bind(stranded.id).run();

		const heldRows = await listSubmissions(db, form.id, { status: 'held' });
		expect(heldRows.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([stranded.id, other.id]);
		expect(heldRows.rows.find((r) => r.id === stranded.id)!.held).toBe(true);
		expect((await listSubmissions(db, form.id, { status: 'ok' })).rows.map((r) => r.id)).not.toContain(stranded.id);
		expect((await listSubmissions(db, form.id, { status: 'anonymous' })).rows.map((r) => r.id)).not.toContain(stranded.id);
		expect((await listForms(db)).find((f) => f.id === form.id)!.submissions).toBe(1);
		expect((await heldSubmissionSummary(db)).find((s) => s.form_id === form.id)).toMatchObject({ held: 2 });

		expect(await releaseHeldSubmission(db, pmEnv, form, stranded.id, { userId: 8 })).toEqual({ ok: true, status: 'added' });
		expect(await contact(stranded.email)).toMatchObject({ subscribed: 1 });
		expect(await sub(stranded.id)).toMatchObject({ status: 'added', held_at: null, released_by: 8 });
		const contacts = await db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').bind(stranded.email).first<{ n: number }>();
		expect(contacts!.n).toBe(1);
		// Processed once: not held any more, so neither a second release nor release all runs it.
		expect(await releaseHeldSubmission(db, pmEnv, form, stranded.id)).toMatchObject({ ok: false, status: 404 });
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 1, failed: 0, remaining: 0, stopped: false });
		expect((await listSubmissions(db, form.id, { status: 'held' })).total).toBe(0);
	});

	it('a claim that is still fresh is left alone (a release may be running on it)', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const [running] = await holdMany(form, 1);
		await db.prepare("UPDATE form_submissions SET held_at = NULL, released_at = datetime('now') WHERE id = ?").bind(running.id).run();
		expect((await listSubmissions(db, form.id, { status: 'held' })).total).toBe(1);
		expect(await releaseHeldSubmission(db, pmEnv, form, running.id)).toMatchObject({ ok: false, status: 409 });
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 0, failed: 0, remaining: 1, stopped: false });
		expect(await discardHeld(db, form.id)).toBe(0);
		expect(await contact(running.email)).toBeNull();
	});

	it('release all stops at a row it could not put back, and that row stays held', async () => {
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const held = await holdMany(form, 3);
		await failOnAll([held[0].email]);
		await failRestore();
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 0, failed: 1, remaining: 3, stopped: true });
		expect(await contact(held[1].email)).toBeNull();
		expect(await sub(held[0].id)).toMatchObject({ held_at: null, detail: HELD_DETAIL, status: 'anonymous', contact_id: null });
		expect((await listSubmissions(db, form.id, { status: 'held' })).total).toBe(3);

		await stopFailing();
		await db.prepare("UPDATE form_submissions SET released_at = datetime('now', '-1 hour') WHERE id = ?").bind(held[0].id).run();
		expect(await releaseAllHeld(db, pmEnv, form)).toEqual({ released: 3, failed: 0, remaining: 0, stopped: false });
		for (const h of held) expect(await contact(h.email)).toMatchObject({ subscribed: 1 });
	});

	it('a failed release after a confirmation email went says so on the row', async () => {
		const form = await makeForm((s) => {
			s.settings.daily_send_cap = 1;
			s.settings.double_optin = true;
		});
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const [held] = await holdMany(form, 1);
		spies.sendBatch.mockClear();
		await failSave();
		expect(await releaseHeldSubmission(db, pmEnv, form, held.id)).toEqual({ ok: false, status: 500, error: RELEASE_FAILED });
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		const row = await sub(held.id);
		expect(row!.held_at).toBeTruthy();
		expect(String(row!.detail)).toMatch(new RegExp(`^${HELD_DETAIL}; ${CONFIRMATION_SENT_NOTE}; release failed: `));

		// A later failure keeps the note; a release that finishes replaces it.
		expect(await releaseHeldSubmission(db, pmEnv, form, held.id)).toMatchObject({ ok: false, status: 500 });
		expect(String((await sub(held.id))!.detail)).toContain(CONFIRMATION_SENT_NOTE);
		await stopFailing();
		expect((await releaseHeldSubmission(db, pmEnv, form, held.id)).ok).toBe(true);
		expect(String((await sub(held.id))!.detail)).toMatch(/^released/);
	});

	it("a release's confirmation email goes through waitUntil when the request has one", async () => {
		const form = await makeForm((s) => {
			s.settings.daily_send_cap = 1;
			s.settings.double_optin = true;
		});
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		const held = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		spies.sendBatch.mockClear();
		const waited: Promise<unknown>[] = [];
		const r = await releaseHeldSubmission(db, pmEnv, form, held.submissionId!, { waitUntil: (p) => waited.push(p) });
		expect(r.ok).toBe(true);
		expect(waited.length).toBeGreaterThan(0);
		await Promise.all(waited);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		expect(String((await sub(held.submissionId!))!.detail)).toMatch(/queued/);
	});
});

describe('daily send cap: only new sends count', () => {
	const capCount = async (formId: number) =>
		(await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(sendCapKey(formId)).first<{ count: number }>())?.count ?? 0;

	it('600 repeat submissions of one pending address use one unit; a new address afterwards is not held', { timeout: 180_000 }, async () => {
		const form = await makeForm((s) => {
			s.settings.daily_send_cap = 2;
			s.settings.double_optin = true;
		});
		const pending = mail();
		for (let i = 0; i < 600; i++) {
			// Keep the per-client and per-form rate limits out of the way (the cap's counter stays).
			if (i % 200 === 0) await db.prepare("DELETE FROM rate_limits WHERE key NOT LIKE 'form-sends:%'").run();
			const r = await handleSubmission(db, pmEnv, form, { answers: { email: pending } }, ctx());
			expect(r.detail).not.toBe('held');
		}
		expect(await capCount(form.id)).toBe(1);
		expect(await contact(pending)).toMatchObject({ subscribed: 0, confirm_pending: 1 });
		const fresh = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		expect(fresh.ok).toBe(true);
		expect(fresh.detail).not.toBe('held');
		expect(await capCount(form.id)).toBe(2);
	});
});

describe('daily send cap: discard all held', () => {
	const event = (form: FormRow, role: 'admin' | 'member') => {
		const url = new URL(`https://crm.test/forms/${form.id}`);
		return {
			request: new Request(url, { method: 'POST', body: new FormData() }),
			url,
			params: { id: String(form.id) },
			platform: { env: { ...pmEnv, DB: db } },
			locals: { user: { id: role === 'admin' ? 4 : 5, github_login: `${role}-744`, role, navLayout: 'top' } }
		} as any;
	};

	it("deletes the form's held rows only", async () => {
		const page = await import('../src/routes/forms/[id]/+page.server');
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		const other = await makeForm((s) => (s.settings.daily_send_cap = 1));
		const kept = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		for (let i = 0; i < 2; i++) expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx())).detail).toBe('held');
		await handleSubmission(db, pmEnv, other, { answers: { email: mail() } }, ctx());
		expect((await handleSubmission(db, pmEnv, other, { answers: { email: mail() } }, ctx())).detail).toBe('held');

		expect(await (page.actions as any).discardHeld(event(form, 'admin'))).toEqual({ discarded: 2 });
		expect((await listSubmissions(db, form.id, { status: 'held' })).total).toBe(0);
		expect(await sub(kept.submissionId!)).toMatchObject({ status: 'added' });
		expect((await listSubmissions(db, other.id, { status: 'held' })).total).toBe(1);
		expect(await discardHeld(db, other.id)).toBe(1);
	});

	it('refuses a member', async () => {
		const page = await import('../src/routes/forms/[id]/+page.server');
		const form = await makeForm((s) => (s.settings.daily_send_cap = 1));
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		await expect((page.actions as any).discardHeld(event(form, 'member'))).rejects.toMatchObject({ status: 403 });
		expect((await listSubmissions(db, form.id, { status: 'held' })).total).toBe(1);
	});
});

describe('daily send cap: held rows in counts', () => {
	it('the form list, the API list and the anonymous filter leave held rows out', async () => {
		const form = await makeForm((s) => {
			s.settings.daily_send_cap = 1;
			s.settings.allow_anonymous = true;
			s.fields[0].required = false;
		});
		const added = await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx());
		expect(added.detail).toBe('added');
		const anon = await handleSubmission(db, pmEnv, form, { answers: {} }, ctx());
		expect(anon.detail).toBe('anonymous');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx())).detail).toBe('held');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: mail() } }, ctx())).detail).toBe('held');

		const row = (await listForms(db)).find((f) => f.id === form.id)!;
		expect(row.submissions).toBe(2);
		const newestCounted = await db
			.prepare('SELECT MAX(created_at) AS t FROM form_submissions WHERE id IN (?, ?)')
			.bind(added.submissionId, anon.submissionId)
			.first<{ t: string }>();
		expect(row.last_submission_at).toBe(newestCounted!.t);
		const api = (await listFormsForApi(db, 'https://crm.test')).find((f) => f.id === form.id)!;
		expect(api.submissions).toBe(2);

		const anonymous = await listSubmissions(db, form.id, { status: 'anonymous' });
		expect(anonymous.rows.map((r) => r.id)).toEqual([anon.submissionId]);
		expect(anonymous.total).toBe(1);
		expect((await listSubmissions(db, form.id, { status: 'held' })).total).toBe(2);
	});
});

describe('before migration 0139', () => {
	it("recognises only SQLite's missing-column errors for the new columns", () => {
		expect(isPreMigrationHeldError(new Error('D1_ERROR: no such column: held_at: SQLITE_ERROR'))).toBe(true);
		expect(isPreMigrationHeldError(new Error('no such column: s.released_at'))).toBe(true);
		expect(isPreMigrationHeldError(new Error('D1_ERROR: table form_submissions has no column named held_at: SQLITE_ERROR'))).toBe(true);
		expect(isPreMigrationHeldError(new Error('table form_submissions has no column named released_by'))).toBe(true);
		expect(isPreMigrationHeldError(new Error('D1 failed', { cause: new Error('no such column: held_at') }))).toBe(true);
		expect(isPreMigrationHeldError('no such column: released_by')).toBe(true);

		expect(isPreMigrationHeldError(new Error('no such column: outcomes'))).toBe(false);
		expect(isPreMigrationHeldError(new Error('no such column: held_at_other'))).toBe(false);
		expect(isPreMigrationHeldError(new Error('no such table: form_submissions'))).toBe(false);
		expect(isPreMigrationHeldError(new Error('UNIQUE constraint failed: form_submissions.id'))).toBe(false);
		expect(isPreMigrationHeldError(null)).toBe(false);
		expect(isPreMigrationHeldError(42)).toBe(false);
	});
});

describe('addresses already on a contact', () => {
	const stored = 'jane..doe@stored744.test';
	let id = 0;
	beforeEach(async () => {
		await removeContact(stored);
		id = (await db.prepare('INSERT INTO contacts (email, first_name, subscribed) VALUES (?, ?, 1) RETURNING id').bind(stored, 'Jane').first<{ id: number }>())!.id;
	});

	it('a contact with a doubled dot can still be patched through the API', async () => {
		const k = await generateApiKey();
		await db
			.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
			.bind('k744', k.tokenHash, k.prefix, k.last4, 'read_write')
			.run();
		const patch = (body: unknown) => {
			const url = new URL(`https://crm.test/api/v1/contacts/${id}`);
			return patchContact({
				request: new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${k.token}` }, body: JSON.stringify(body) }),
				platform: { env: { ...(env as object), DB: db } },
				url,
				params: { id: String(id) }
			} as any);
		};
		expect((await patch({ first_name: 'Janet' })).status).toBe(200);
		expect((await patch({ email: stored, last_name: 'Doe' })).status).toBe(200);
		const row = await db.prepare('SELECT email, first_name, last_name FROM contacts WHERE id = ?').bind(id).first();
		expect(row).toMatchObject({ email: stored, first_name: 'Janet', last_name: 'Doe' });
		// A changed address still needs the strict check.
		expect((await patch({ email: 'jane..new@stored744.test' })).status).toBe(400);
	});

	it('still gets a confirmation email; a new address like it does not', async () => {
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(id).run();
		const r = await requestConfirmation(db, pmEnv, { email: stored, contactId: id, source: 'form', intent: {} }, { baseUrl: 'https://crm.test' });
		expect(r).toMatchObject({ sent: true, contactId: id });
		const fresh = await requestConfirmation(db, pmEnv, { email: 'john..doe@stored744.test', contactId: null, source: 'form', intent: {} });
		expect(fresh).toMatchObject({ sent: false, reason: 'invalid_email' });
	});

	it('is not newly tagged invalid by the hygiene pass', async () => {
		await startHygieneBackfill(db);
		const step = await runHygieneBackfill(db, { lookup: async () => 'ok', batch: 5000, maxDomains: 1000 });
		expect(step).toMatchObject({ done: true });
		const row = await db.prepare("SELECT json_extract(meta, '$.hygiene') AS h FROM contacts WHERE id = ?").bind(id).first<{ h: string | null }>();
		expect(String(row?.h)).not.toMatch(/^invalid/);
		const tagged = await db
			.prepare("SELECT 1 AS x FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.contact_id = ? AND l.kind = 'tag' AND l.name = ?")
			.bind(id, HYGIENE_INVALID_TAG)
			.first();
		expect(tagged).toBeNull();
	});
});

describe('ingest follow-ups', () => {
	const INGEST_SECRET = 'test-session-secret-744';
	const realFetch = globalThis.fetch;
	const testEnv = () => ({ ...(env as object), SESSION_SECRET: INGEST_SECRET });
	const post = (token: string, body: Record<string, unknown>) => {
		const url = 'https://crm.test/api/ingest';
		return ingest({
			request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
			url: new URL(url),
			platform: { env: testEnv() }
		} as any);
	};
	const key = async (token: string, trust: 0 | 1, list: string) =>
		(await db
			.prepare('INSERT INTO webhook_keys (label, token, default_list, trust_body, require_confirm) VALUES (?, ?, ?, ?, 1) RETURNING id')
			.bind(`k744-${token}`, token, list, trust)
			.first<{ id: number }>())!.id;
	const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

	beforeEach(async () => {
		globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
		await db.prepare("DELETE FROM webhook_keys WHERE label LIKE 'k744-%'").run();
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("leaves one request-log row when a key reaches its shared limit", async () => {
		const id = await key('wk744lim', 0, 'K744 list');
		await db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 3000, ?)').bind(`ingest:key:k${id}`, now()).run();
		expect((await post('wk744lim', { email: 'lim@i744.test' })).status).toBe(429);
		expect((await post('wk744lim', { email: 'lim2@i744.test' })).status).toBe(429);
		const rows = await db.prepare('SELECT status, detail, email FROM webhook_events WHERE key_id = ?').bind(id).all<{ status: string; detail: string; email: string | null }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]).toMatchObject({ status: 'rejected', email: null });
		expect(rows.results[0].detail).toMatch(/limit/);
	});

	it("a repeat submission through a key that doesn't trust the body keeps the open confirmation's choices", async () => {
		await key('wk744t', 1, 'K744 default');
		await key('wk744u', 0, 'K744 untrusted list');
		const email = 'repeat@i744.test';
		await removeContact(email);
		expect((await post('wk744t', { email, list: 'K744 chosen list', role: 'founder' })).status).toBe(200);
		const before = await db.prepare('SELECT intent FROM subscription_confirmations WHERE email = ?').bind(email).first<{ intent: string }>();
		expect(JSON.parse(before!.intent).lists).toEqual(['K744 chosen list']);
		expect((await post('wk744u', { email, role: 'other' })).status).toBe(200);
		const after = await db.prepare('SELECT intent FROM subscription_confirmations WHERE email = ?').bind(email).all<{ intent: string }>();
		expect(after.results).toHaveLength(1);
		const intent = JSON.parse(after.results[0].intent);
		expect(intent.lists).toEqual(['K744 chosen list']);
		expect(intent.fields).toMatchObject({ role: 'founder' });
	});
});

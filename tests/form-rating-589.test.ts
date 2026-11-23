import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #589: the Rating question — spec normalize / validate, answer coercion, both renderers (same
// script-free radio group), the submit path writing (and not writing) contact_ratings, double
// opt-in timing, outcome rules on a rating, delete, the activity detail, CSV and the contact page.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn(), suppressionsByEmail: vi.fn(), unsuppress: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch,
	suppressionsByEmail: spies.suppressionsByEmail,
	unsuppress: spies.unsuppress
}));

import {
	answerText,
	blankField,
	coerceAnswers,
	emptyForm,
	normalizeFormSpec,
	ratingOf,
	validateFormSpec,
	withSettingsOutcome,
	type FormField,
	type FormOutcome,
	type FormSpec
} from '../src/lib/forms';
import { evaluateRule } from '../src/lib/form-logic';
import { RATING_CSS, normalizeRating, ratingChoices, ratingGroupHtml, ratingSpoken } from '../src/lib/form-rating';
import { createForm, getForm, pruneSubmissions, submissionsCsv, type FormRow } from '../src/lib/server/forms';
import { finishFor, handleSubmission, type SubmitContext } from '../src/lib/server/form-submit';
import { PLAIN_FIELD_TYPES, PLAIN_FORM_CSS, plainFormProblem, renderPlainForm } from '../src/lib/server/form-plain';
import { contactRatings } from '../src/lib/server/contact-ratings';
import { deleteContactsByIds } from '../src/lib/server/contacts';
import { confirmSubscription } from '../src/lib/server/double-optin';
import { recentActivity } from '../src/lib/server/activity';
import * as contactPage from '../src/routes/contacts/[id]/+page.server';
import rendererSource from '../src/lib/components/FormRenderer.svelte?raw';

const db = (env as any).DB as D1Database;
const pmEnv = { POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'alan@ourco.example', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 's' };
let ipN = 0;
const ctx = (extra: Partial<SubmitContext> = {}): SubmitContext => ({
	origin: 'https://crm.test',
	crmOrigins: ['https://crm.test'],
	ip: `10.58.9.${++ipN}`,
	baseUrl: 'https://crm.test',
	mxLookup: async () => 'ok',
	...extra
});

const q = (type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField => ({ ...blankField(type, label), key, ...extra });
const rating = (extra: Partial<FormField> = {}) =>
	q('rating', 'How likely are you to recommend us?', 'nps', { rating: { style: 'numbers', min: 0, max: 10, low_label: 'Not likely', high_label: 'Very likely' }, ...extra });

let formN = 0;
async function makeForm(mutate: (s: FormSpec) => FormSpec | void = () => {}): Promise<FormRow> {
	const name = `Rating form ${++formN}`;
	const id = await createForm(db, name, null);
	const spec = emptyForm(name);
	const next = mutate(spec) ?? spec;
	await db.prepare("UPDATE forms SET spec = ?, status = 'published', retention_days = ? WHERE id = ?").bind(JSON.stringify(next), next.settings.retention_days, id).run();
	return (await getForm(db, id))!;
}
const contactId = async (email: string) => (await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>())?.id ?? null;

function lastToken(): string {
	const calls = spies.sendBatch.mock.calls;
	const msgs = calls[calls.length - 1][1] as { TextBody: string }[];
	const m = /\/confirm\/([A-Za-z0-9_-]+)/.exec(msgs[0].TextBody);
	if (!m) throw new Error('no token in the email');
	return m[1];
}

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` })));
	spies.suppressionsByEmail.mockResolvedValue({ map: new Map(), errors: [], read: 2 });
	spies.unsuppress.mockResolvedValue({ ok: true });
	await db.batch([
		db.prepare('DELETE FROM contact_ratings'),
		db.prepare('DELETE FROM subscription_confirmations'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM form_submissions'),
		db.prepare('DELETE FROM rate_limits'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('spec: normalize + validate', () => {
	it('defaults old / junk settings and keeps allowed scales', () => {
		expect(normalizeRating(undefined)).toEqual({ style: 'stars', min: 1, max: 5, low_label: '', high_label: '' });
		expect(normalizeRating({ style: 'faces', min: 1, max: 10 })).toMatchObject({ style: 'faces', min: 1, max: 5 });
		expect(normalizeRating({ style: 'stars', min: 0, max: 10 })).toMatchObject({ min: 1, max: 5 });
		expect(normalizeRating({ style: 'numbers', min: 0, max: 10 })).toMatchObject({ min: 0, max: 10 });
		expect(normalizeRating({ style: 'hearts', min: '1', max: '10' })).toMatchObject({ style: 'hearts', min: 1, max: 10 });
		expect(normalizeRating({ style: 'emoji' }).style).toBe('stars');
		// A stored rating field without settings (older spec) reads with the defaults.
		const spec = normalizeFormSpec({ fields: [{ type: 'rating', key: 'r', label: 'Rate us' }] });
		expect(spec.fields[0].rating).toEqual({ style: 'stars', min: 1, max: 5, low_label: '', high_label: '' });
		// Other types never carry rating settings.
		expect(normalizeFormSpec({ fields: [{ type: 'short_text', key: 's', label: 'S', rating: { style: 'faces' } }] }).fields[0].rating).toBeUndefined();
	});

	it('validates end labels and mapping (custom field only)', () => {
		const ok = emptyForm('R');
		ok.fields.push(rating({ map: { to: 'meta', key: 'nps' } }));
		expect(validateFormSpec(ok)).toEqual([]);

		const bad = emptyForm('R');
		bad.fields.push(rating({ map: { to: 'tag', name: 'x' }, rating: { style: 'stars', min: 1, max: 5, low_label: 'x'.repeat(61), high_label: '' } }));
		const paths = validateFormSpec(bad).map((p) => p.path);
		expect(paths).toContain('fields[1].map');
		expect(paths).toContain('fields[1].rating.low_label');
	});
});

describe('answers', () => {
	const spec = { fields: [rating(), q('rating', 'Stars', 'stars', { required: true })] };

	it('coerces to a whole number inside the scale', () => {
		expect(coerceAnswers(spec, { nps: '0', stars: '5' }).answers).toEqual({ nps: 0, stars: 5 });
		expect(coerceAnswers(spec, { nps: ' 10 ', stars: '1' }).answers).toEqual({ nps: 10, stars: 1 });
	});

	it('rejects out-of-range, fractional and non-numeric input', () => {
		for (const bad of ['11', '-1', '4.5', 'abc', '1e1', '0x3']) {
			expect(coerceAnswers(spec, { nps: bad, stars: '3' }).errors.nps, bad).toBe('Pick a rating from 0 to 10.');
		}
		expect(coerceAnswers(spec, { nps: '3', stars: '0' }).errors.stars).toBe('Pick a rating from 1 to 5.');
		expect(coerceAnswers(spec, { nps: '3' }).errors.stars).toBe('This question is required.');
	});

	it('answerText shows "4 / 5"; logic compares it as a number', () => {
		const f = spec.fields[1];
		expect(answerText(4, f)).toBe('4 / 5');
		expect(answerText(7, spec.fields[0])).toBe('7 / 10');
		expect(ratingOf(spec.fields[0]).max).toBe(10);
		expect(evaluateRule({ field: 'stars', op: 'lte', value: '3' }, { stars: 3 })).toBe(true);
		expect(evaluateRule({ field: 'stars', op: 'lte', value: '3' }, { stars: 4 })).toBe(false);
		expect(evaluateRule({ field: 'stars', op: 'gte', value: 4 }, { stars: 4 })).toBe(true);
		expect(evaluateRule({ field: 'stars', op: 'lt', value: '10' }, { stars: 9 })).toBe(true);
	});
});

describe('renderers', () => {
	it('draws a radio group in a fieldset with spoken labels', () => {
		const r = normalizeRating({ style: 'stars', min: 1, max: 5 });
		expect(ratingChoices(r).map((c) => c.value)).toEqual([1, 2, 3, 4, 5]);
		expect(ratingSpoken(r, 4)).toBe('4 out of 5 stars');
		expect(ratingSpoken(normalizeRating({ style: 'faces' }), 4)).toBe('Happy, 4 out of 5');
		const html = ratingGroupHtml(r, { name: 'stars', legend: 'Rate <us>', required: true });
		expect(html).toMatch(/^<fieldset class="rt rt-fill rt-stars"><legend>Rate &lt;us&gt;<\/legend>/);
		expect(html.match(/type="radio" name="stars"/g)).toHaveLength(5);
		expect(html).toContain('<span class="rt-sr">4 out of 5 stars</span>');
		expect(html).not.toMatch(/<script|on\w+=/i);
	});

	it('the plain renderer shows it without script, and allows it in the archive popup', () => {
		expect(PLAIN_FIELD_TYPES).toContain('rating');
		const spec = emptyForm('Feedback');
		spec.fields.push(rating());
		expect(plainFormProblem({ status: 'published', spec })).toBeNull();
		const html = renderPlainForm(spec, { action: '/newsletter/subscribe' });
		expect(html).toContain('<fieldset class="rt rt-num rt-numbers nl-form-q">');
		expect(html.match(/type="radio" name="nps"/g)).toHaveLength(11);
		expect(html).toContain('0 out of 10 (Not likely)');
		expect(html).toContain('<div class="rt-ends" aria-hidden="true"><span>Not likely</span><span>Very likely</span></div>');
		expect(html).not.toMatch(/<script/i);
		expect(PLAIN_FORM_CSS).toContain(RATING_CSS.trim());
		// Tap targets ≥ 44px, a focus ring and wrapping rows (375px phones).
		expect(RATING_CSS).toMatch(/min-width:44px; min-height:44px/);
		expect(RATING_CSS).toContain('.rt-opt:has(input:focus-visible)');
		expect(RATING_CSS).toContain('flex-wrap:wrap');
	});

	it('FormRenderer uses the same markup and CSS', () => {
		expect(rendererSource).toContain('ratingGroupHtml(ratingOf(f)');
		expect(rendererSource).toContain('RATING_CSS');
	});
});

describe('submit path', () => {
	it('writes one row per answered rating for a known contact, links the submission, maps the bare number', async () => {
		const form = await makeForm((s) => {
			s.fields.push(rating({ map: { to: 'meta', key: 'nps' } }), q('rating', 'Support', 'support', { rating: { style: 'faces', min: 1, max: 5, low_label: '', high_label: '' } }));
		});
		const r = await handleSubmission(db, pmEnv, form, { answers: { email: 'rater@r.test', nps: '9' } }, ctx());
		expect(r).toMatchObject({ ok: true, detail: 'added' });
		const id = (await contactId('rater@r.test'))!;
		const rows = await contactRatings(db, id);
		expect(rows).toHaveLength(1); // the unanswered faces question writes nothing
		expect(rows[0]).toMatchObject({ form_id: form.id, form_name: form.name, submission_id: r.submissionId, field_key: 'nps', value: 9, low: 0, high: 10, style: 'numbers', question: 'How likely are you to recommend us?' });
		const meta = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(id).first<{ meta: string }>();
		expect(JSON.parse(meta!.meta).nps).toBe('9');

		// A second submission adds history, not a replacement.
		await handleSubmission(db, pmEnv, form, { answers: { email: 'rater@r.test', nps: '6', support: '2' } }, ctx());
		expect((await contactRatings(db, id)).map((x) => x.value).sort()).toEqual([2, 6, 9]);

		// Activity lists the rating with the form submission.
		const feed = await recentActivity(db, { limit: 20, types: ['form'] });
		expect(feed.some((a) => a.contact_id === id && String(a.detail).includes(`${form.name} · rated 9 / 10`))).toBe(true);

		// CSV: the bare number.
		const csv = await submissionsCsv(db, form);
		expect(csv.split('\r\n').some((l) => /rater@r\.test,9,,/.test(l))).toBe(true);
		expect(csv).not.toContain('9 / 10');
	});

	it('writes nothing for anonymous, spam or invalid submissions', async () => {
		const anon = await makeForm((s) => {
			s.settings.allow_anonymous = true;
			s.fields[0].required = false;
			s.fields.push(rating());
		});
		expect((await handleSubmission(db, pmEnv, anon, { answers: { nps: '8' } }, ctx())).detail).toBe('anonymous');
		const form = await makeForm((s) => void s.fields.push(rating()));
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: 'bot@r.test', nps: '8' }, honeypot: 'x' }, ctx())).detail).toBe('spam');
		expect((await handleSubmission(db, pmEnv, form, { answers: { email: 'bad@r.test', nps: '12' } }, ctx())).detail).toBe('invalid');
		const n = await db.prepare('SELECT COUNT(*) AS n FROM contact_ratings').first<{ n: number }>();
		expect(n!.n).toBe(0);
	});

	it('double opt-in: the rating waits for the confirm', async () => {
		const form = await makeForm((s) => {
			s.settings.double_optin = true;
			s.fields.push(rating());
		});
		await handleSubmission(db, pmEnv, form, { answers: { email: 'doi@r.test', nps: '7' } }, ctx());
		const id = (await contactId('doi@r.test'))!;
		expect(await contactRatings(db, id)).toEqual([]);
		expect((await confirmSubscription(db, pmEnv, lastToken(), { actor: 'self' })).ok).toBe(true);
		expect((await contactRatings(db, id)).map((x) => [x.value, x.high, x.form_id])).toEqual([[7, 10, form.id]]);
	});

	it('an outcome rule on the rating picks the message and adds a tag', async () => {
		const form = await makeForm((s) => {
			s.fields.push(q('rating', 'Stars', 'stars'));
			const next = withSettingsOutcome(s, [{ type: 'message_md', md: 'Thanks!' }]);
			next.outcomes.push({ id: 'low', when: { match: 'all', rules: [{ field: 'stars', op: 'lte', value: '3' }] }, actions: [{ type: 'add_tag', tag: 'unhappy' }, { type: 'message_md', md: 'Sorry to hear that.' }] });
			return next;
		});
		const low = await handleSubmission(db, pmEnv, form, { answers: { email: 'low@r.test', stars: '2' } }, ctx());
		expect(low.message_html).toContain('Sorry to hear that.');
		const high = await handleSubmission(db, pmEnv, form, { answers: { email: 'high@r.test', stars: '5' } }, ctx());
		expect(high.message_html).toContain('Thanks!');
		const tagged = await db
			.prepare("SELECT c.email FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id WHERE l.name = 'unhappy'")
			.all<{ email: string }>();
		expect(tagged.results.map((x) => x.email)).toEqual(['low@r.test']);
	});

	it('survives the submission prune; deleted with the contact', async () => {
		const form = await makeForm((s) => void s.fields.push(rating()));
		await handleSubmission(db, pmEnv, form, { answers: { email: 'keep@r.test', nps: '5' } }, ctx());
		const id = (await contactId('keep@r.test'))!;
		await db.prepare("UPDATE form_submissions SET created_at = datetime('now', '-400 days') WHERE form_id = ?").bind(form.id).run();
		// Count the rows, not `deleted`: D1's `changes` is a total_changes() delta, which also
		// counts the ON DELETE SET NULL on the rating's submission_id.
		const subs = async () => (await db.prepare('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ?').bind(form.id).first<{ n: number }>())!.n;
		expect(await subs()).toBe(1);
		expect((await pruneSubmissions(db)).deleted).toBeGreaterThanOrEqual(1);
		expect(await subs()).toBe(0);
		const rows = await contactRatings(db, id);
		expect(rows).toHaveLength(1);
		expect(rows[0].submission_id).toBeNull();

		expect(await deleteContactsByIds(db, [id])).toBe(1);
		const n = await db.prepare('SELECT COUNT(*) AS n FROM contact_ratings WHERE contact_id = ?').bind(id).first<{ n: number }>();
		expect(n!.n).toBe(0);
	});
});

describe('finish per outcome', () => {
	const row = (outcomes: FormOutcome[]) => ({ id: 1, name: 'F', spec: { ...emptyForm('F'), outcomes } }) as FormRow;
	const low = { match: 'all' as const, rules: [{ field: 'stars', op: 'lte' as const, value: '3' }] };
	const msg = (md: string) => ({ type: 'message_md' as const, md });
	const go = (url: string) => ({ type: 'redirect' as const, url });

	it('inside one outcome a valid redirect beats the message, whatever the order', () => {
		expect(finishFor(row([{ id: 'default', when: null, actions: [msg('Hi'), go('https://ex.test/a')] }]))).toEqual({ redirect: 'https://ex.test/a' });
		expect(finishFor(row([{ id: 'default', when: null, actions: [go('https://ex.test/b'), msg('Hi')] }]))).toEqual({ redirect: 'https://ex.test/b' });
	});

	it('a matching outcome without a finish of its own keeps the earlier one', () => {
		const badUrl = row([
			{ id: 'default', when: null, actions: [msg('Thanks!')] },
			{ id: 'low', when: low, actions: [go('javascript:alert(1)')] }
		]);
		expect(finishFor(badUrl, { stars: 2 }).message_html).toContain('Thanks!');
		const tagOnly = row([
			{ id: 'default', when: null, actions: [go('https://ex.test/thanks')] },
			{ id: 'low', when: low, actions: [{ type: 'add_tag', tag: 'unhappy' }] }
		]);
		expect(finishFor(tagOnly, { stars: 2 })).toEqual({ redirect: 'https://ex.test/thanks' });
	});

	it('a matching conditional message replaces an unconditional redirect', () => {
		const form = row([
			{ id: 'default', when: null, actions: [go('https://ex.test/thanks')] },
			{ id: 'low', when: low, actions: [msg('Sorry to hear that.')] }
		]);
		const r = finishFor(form, { stars: 2 });
		expect(r.redirect).toBeUndefined();
		expect(r.message_html).toContain('Sorry to hear that.');
		expect(finishFor(form, { stars: 5 })).toEqual({ redirect: 'https://ex.test/thanks' });
		expect(finishFor(row([])).message_html).toContain('Thanks! We got your answers.');
	});
});

describe('contact page', () => {
	it('loads ratings newest first, empty when none', async () => {
		const user = { id: 1, github_login: 'ourco-admin', role: 'admin', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false };
		const ev = (id: number) => {
			const url = new URL(`https://app.test/contacts/${id}`);
			return { url, params: { id: String(id) }, request: new Request(url), locals: { user, authed: true }, platform: { env: env as any }, setHeaders: () => {} } as any;
		};
		const form = await makeForm((s) => void s.fields.push(rating()));
		await handleSubmission(db, pmEnv, form, { answers: { email: 'page@r.test', nps: '3' } }, ctx());
		const id = (await contactId('page@r.test'))!;
		await db.prepare("UPDATE contact_ratings SET created_at = datetime('now', '-1 day')").run();
		await handleSubmission(db, pmEnv, form, { answers: { email: 'page@r.test', nps: '8' } }, ctx());
		const data: any = await contactPage.load(ev(id));
		expect(data.ratings.map((r: any) => r.value)).toEqual([8, 3]);

		const other = (await db.prepare("INSERT INTO contacts (email) VALUES ('none@r.test') RETURNING id").first<{ id: number }>())!.id;
		expect(((await contactPage.load(ev(other))) as any).ratings).toEqual([]);
	});
});

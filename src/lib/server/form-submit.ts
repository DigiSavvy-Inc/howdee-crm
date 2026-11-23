// Forms (#508, phase 1 = #509): one submission, start to finish. The route only parses the
// request; tests call `handleSubmission` directly. Order:
//   rate limit → origin → honeypot → answers validation → formPath drop (hidden questions and
//   skipped pages, #514) → outcome rules (answers + the known contact, #514) → hygiene →
//   contact write → outcomes (or the confirmation email: double opt-in, or an unsubscribed
//   contact ticking consent, #541) → enroll_automation actions → submission row (+ fired
//   outcome ids) → (activity is read from the row) → notify → the form webhook (#620, fire
//   and forget)
import {
	answerText,
	cleanRedirectUrl,
	coerceAnswers,
	emailField,
	TICK_TYPES,
	type Answers,
	type AnswerValue,
	type FormAction,
	type FormField,
	type FormOutcome,
	type RawAnswers
} from '$lib/forms';
import { evaluateRuleSet, formPath, type RuleContact } from '$lib/form-logic';
import { insertRatings, ratingsFromAnswers, type RatingInput } from './contact-ratings';
import { enrollContactsInAutomation } from './automations';
import { renderAssistantMarkdown } from '$lib/assistant-markdown';
import { hygieneInvalid } from '$lib/email-hygiene';
import type { FormRow, SubmissionStatus } from './forms';
import { recordSubmission } from './forms';
import { limit, ipHash } from './rate-limit';
import { applyContactFields, applyContactMeta } from './contact-write';
import { addTagAndEnroll, autoEnroll, syncCompanyMembership } from './contacts';
import { restoreIfArchived } from './contact-archive';
import { checkAddress, recordHygiene, type MxLookup } from './hygiene';
import { saveTopicChoicesAndFire } from './subscription-trigger';
import { isHardSuppression, suppressionsByEmail, suppressionStreams, sendBatch, type PostmarkMessage } from './postmark';
import { formatAddress, forwardFallbackAddress, forwardSenderAddress, sendReplyForward } from './reply-forward';
import { attachFormSubmission, needsConfirmation, requestConfirmation } from './double-optin';
import { fireFormTriggers } from './form-trigger';
import { formWebhookSecret, pageUrl, sendFormWebhook } from './form-webhook';

/** Per visitor (hashed IP) and per form, in a 10-minute window. */
export const RATE_PER_IP = 10;
export const RATE_PER_FORM = 300;
export const RATE_WINDOW_SEC = 600;
/** The honeypot input's name (rendered off-screen; people never fill it). */
export const HONEYPOT_NAME = '_hp_url';
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export type SubmissionInput = {
	answers: RawAnswers;
	honeypot?: string | null;
	utm?: Record<string, string> | null;
	referrer?: string | null;
	/** #515: the host page of an embedded form. */
	pageUrl?: string | null;
	userAgent?: string | null;
};

export type SubmitEnv = {
	SESSION_SECRET?: string;
	POSTMARK_TOKEN?: string;
	POSTMARK_STREAM?: string;
	POSTMARK_STREAM_TX?: string;
	POSTMARK_FROM?: string;
	REVIEW_FROM?: string;
	INBOUND_FORWARD_FROM?: string;
};

export type SubmitContext = {
	/** The request's Origin header (null when absent). */
	origin: string | null;
	/** Origins of the CRM itself (request origin, public base URL) — always allowed. */
	crmOrigins: string[];
	/** cf-connecting-ip. */
	ip: string | null;
	/** For links in the notification email. */
	baseUrl?: string;
	now?: Date;
	/** Test seams. */
	mxLookup?: MxLookup;
	send?: typeof sendBatch;
	/** #620: the form webhook POST. */
	fetch?: typeof fetch;
	/** #620: `platform.ctx.waitUntil` — the webhook then runs after the response. Absent = awaited. */
	waitUntil?: (p: Promise<unknown>) => void;
};

export type SubmitResult = {
	ok: boolean;
	status: number;
	/** Short machine-readable reason (`origin`, `spam`, `rate_limit`, `invalid`, `added`, …). */
	detail: string;
	submissionId?: number;
	redirect?: string;
	message_html?: string;
	/** Per answer key, when `detail === 'invalid'`. */
	errors?: Record<string, string>;
	error?: string;
};

/** #620: the request's `waitUntil`, bound, when the platform has one (dev / tests: none). */
export function waitUntilFor(event: { platform?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } } | null }): ((p: Promise<unknown>) => void) | undefined {
	const ctx = event.platform?.ctx;
	return ctx?.waitUntil ? (p) => ctx.waitUntil!(p) : undefined;
}

const normOrigin = (o: string) => {
	try {
		return new URL(o).origin.toLowerCase();
	} catch {
		return '';
	}
};

/** CRM origins, then the form's own allowed origins (phase 3 edits them). `null` / none = allowed. */
export function originAllowed(origin: string | null, crmOrigins: string[], allowed: string[]): boolean {
	if (origin === null || origin === '' || origin === 'null') return true;
	const o = normOrigin(origin);
	if (!o) return false;
	return [...crmOrigins, ...allowed].some((a) => normOrigin(a) === o);
}

const plain = (v: AnswerValue | undefined) =>
	v === undefined ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : '') : String(v);

/**
 * #514: what an outcome rule may read about the person submitting — the contact with this email
 * as it was before the submission (tags lowercased, list ids as text, custom fields), or null for
 * a new address. Contact rules are false without one.
 */
export async function loadRuleContact(db: D1Database, email: string | null): Promise<RuleContact | null> {
	if (!email) return null;
	const c = await db
		.prepare('SELECT id, email, first_name, last_name, company, subscribed, meta FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number; email: string; first_name: string | null; last_name: string | null; company: string | null; subscribed: number; meta: string | null }>();
	if (!c) return null;
	const groups = await db
		.prepare('SELECT l.id, l.name, l.kind FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.contact_id = ?')
		.bind(c.id)
		.all<{ id: number; name: string; kind: string }>();
	const tags = groups.results.filter((g) => g.kind === 'tag').map((g) => g.name.toLowerCase());
	const out: RuleContact = {
		email: c.email,
		first_name: c.first_name ?? '',
		last_name: c.last_name ?? '',
		company: c.company ?? '',
		subscribed: c.subscribed === 1,
		tags,
		has_tag: tags,
		in_list: groups.results.filter((g) => g.kind !== 'tag').map((g) => String(g.id))
	};
	let meta: Record<string, unknown> = {};
	try {
		meta = c.meta ? JSON.parse(c.meta) : {};
	} catch {
		meta = {};
	}
	if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
		for (const [k, v] of Object.entries(meta)) {
			if (v === null || typeof v === 'object') continue;
			out[`field:${k}`] = String(v);
			if (!(k in out)) out[k] = String(v);
		}
	}
	return out;
}

/**
 * Outcomes that fire: the unconditional ones (`when: null`), plus — given the answers — the
 * conditional ones whose rule set holds (#589: "rating is at most 3" adds a tag or picks another
 * thank-you message; a rating answer is a number, so gt / gte / lt / lte compare it as one).
 * #514: rules may read the known contact; `settings.outcomes_mode: 'first'` keeps only the first
 * matching conditional outcome (unconditional ones always fire). Without answers only the
 * unconditional ones fire.
 */
export function firedOutcomes(form: Pick<FormRow, 'spec'>, answers?: Answers, contact?: RuleContact | null): FormOutcome[] {
	const first = form.spec.settings.outcomes_mode === 'first';
	let matched = false;
	return form.spec.outcomes.filter((o) => {
		if (o.when === null) return true;
		if (answers === undefined || (first && matched)) return false;
		const ok = evaluateRuleSet(o.when, answers, contact);
		if (ok) matched = true;
		return ok;
	});
}

/** The actions of the outcomes that fire, in order. */
export function applicableActions(form: FormRow, answers?: Answers, contact?: RuleContact | null): FormAction[] {
	return firedOutcomes(form, answers, contact).flatMap((o) => o.actions);
}

/** One outcome's own finish: its last valid redirect, else its last non-blank message, else none. */
function outcomeFinish(o: FormOutcome): { redirect: string } | { md: string } | null {
	let redirect: string | null = null;
	let md: string | null = null;
	for (const a of o.actions) {
		if (a.type === 'redirect') redirect = cleanRedirectUrl(a.url) ?? redirect;
		if (a.type === 'message_md' && a.md.trim()) md = a.md;
	}
	if (redirect) return { redirect };
	return md !== null ? { md } : null;
}

/**
 * The message (rendered, safe) or redirect a submission ends on. Per outcome (#589): one with a
 * finish of its own (a valid redirect beats its message) counts; one without (only tags, or only
 * a bad URL) is passed over. #514: the first fired conditional outcome with a finish wins; else
 * the unconditional outcome's (the Settings tab's; with several, the last one's); else the default
 * message. `opts.fired` = the outcome ids a stored submission fired (the thanks page), instead of
 * evaluating the rules again.
 */
export function finishFor(
	form: Pick<FormRow, 'spec'>,
	answers?: Answers,
	opts: { contact?: RuleContact | null; fired?: string[] | null } = {}
): { redirect?: string; message_html?: string } {
	const fired = opts.fired ? form.spec.outcomes.filter((o) => opts.fired!.includes(o.id)) : firedOutcomes(form, answers, opts.contact);
	let finish: { redirect: string } | { md: string } | null = null;
	for (const o of fired) {
		if (o.when === null) continue;
		finish = outcomeFinish(o);
		if (finish) break;
	}
	if (!finish) for (const o of fired) if (o.when === null) finish = outcomeFinish(o) ?? finish;
	if (finish && 'redirect' in finish) return { redirect: finish.redirect };
	return { message_html: renderAssistantMarkdown(finish?.md.trim() || 'Thanks! We got your answers.') };
}

/**
 * #541: a consent tick never resubscribes on its own (anyone can type an address). An existing
 * unsubscribed contact goes through the confirmation email instead — unless Postmark holds a
 * HardBounce / SpamComplaint suppression for it (#285), when no email is sent (the confirm
 * itself runs the same guard again).
 */
async function hardSuppressed(env: SubmitEnv, email: string): Promise<boolean> {
	if (!env.POSTMARK_TOKEN) return false;
	try {
		const { map } = await suppressionsByEmail(env.POSTMARK_TOKEN, suppressionStreams(env.POSTMARK_STREAM, env.POSTMARK_STREAM_TX));
		const s = map.get(email.toLowerCase());
		return !!s && isHardSuppression(s.reason);
	} catch {
		return false; // unreachable → not checked, like bulkResubscribe; the confirm runs the guard again
	}
}

/** Does this submission go through the confirmation email? Null = no; else the note to add. */
async function confirmationRoute(db: D1Database, env: SubmitEnv, form: FormRow, email: string, plan: Plan): Promise<string | null> {
	const row = await db.prepare('SELECT subscribed FROM contacts WHERE email = ?').bind(email).first<{ subscribed: number }>();
	const unsubscribed = !!row && row.subscribed === 0;
	const wantsResub = unsubscribed && plan.consent;
	if (!form.spec.settings.double_optin && !wantsResub) return null;
	if (form.spec.settings.double_optin && !(await needsConfirmation(db, email))) return null;
	// Without double opt-in a blocked address keeps the normal write (it stays unsubscribed).
	if (!form.spec.settings.double_optin && (await hardSuppressed(env, email))) return null;
	return wantsResub ? 'resubscribe needs confirmation' : '';
}

async function addToListById(db: D1Database, listId: number, contactId: number, enroll: boolean): Promise<void> {
	const list = await db.prepare("SELECT id FROM lists WHERE id = ? AND kind = 'list'").bind(listId).first<{ id: number }>();
	if (!list) return;
	const res = await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, contactId).run();
	if (enroll && (res.meta.changes ?? 0) > 0) {
		try {
			await autoEnroll(db, listId, [contactId]);
		} catch (e) {
			console.error('form list auto-enroll failed:', e);
		}
	}
}

/** What the mapped answers and the outcome actions do to a contact. */
type Plan = {
	columns: Partial<Record<'first_name' | 'last_name' | 'name' | 'company', string>>;
	meta: Record<string, string>;
	tags: Set<string>;
	/** #514: `remove_tag` actions (applied after the adds, so a tag both added and removed ends removed). */
	removeTags: Set<string>;
	lists: Set<number>;
	topics: Set<number>;
	/** #514: `enroll_automation` actions (run only while `settings.enroll` is on). */
	automations: Set<number>;
	/** #514: `notify` actions' users (on top of `settings.notify_user_ids`). */
	notify: Set<number>;
	source: string;
	consent: boolean;
};

/** An option's label (tags read better than stored values); free text as is. */
const optionLabel = (f: FormField, v: string) => f.options.find((o) => o.value === v)?.label || v;

function planFor(fields: FormField[], answers: Answers, actions: FormAction[]): Plan {
	const plan: Plan = {
		columns: {},
		meta: {},
		tags: new Set(),
		removeTags: new Set(),
		lists: new Set(),
		topics: new Set(),
		automations: new Set(),
		notify: new Set(),
		source: 'form',
		consent: false
	};
	for (const f of fields) {
		const v = answers[f.key];
		if (f.type === 'consent' && v === true) plan.consent = true;
		if (f.type === 'topics' && Array.isArray(v)) for (const t of v) plan.topics.add(Number(t));
		const m = f.map;
		if (!m || v === undefined) continue;
		const ticked = TICK_TYPES.includes(f.type);
		switch (m.to) {
			case 'contact':
				if (m.field === 'phone') plan.meta.phone = plain(v);
				else if (m.field !== 'email') plan.columns[m.field] = plain(v);
				break;
			case 'meta':
				// A rating fills the custom field with the bare number (segments / scores read it).
				plan.meta[m.key] = ticked ? (v ? 'yes' : '') : f.type === 'rating' ? String(v) : answerText(v, f);
				break;
			case 'tag':
				if (m.name) plan.tags.add(m.name);
				else for (const x of Array.isArray(v) ? v : [String(v)]) plan.tags.add(optionLabel(f, x));
				break;
			case 'tag_prefix':
				for (const x of Array.isArray(v) ? v : [String(v)]) plan.tags.add(`${m.prefix}${optionLabel(f, x)}`);
				break;
			case 'list':
				plan.lists.add(m.list_id);
				break;
			case 'topic':
				plan.topics.add(m.list_id);
				break;
		}
	}
	for (const a of actions) {
		if (a.type === 'add_tag') plan.tags.add(a.tag);
		if (a.type === 'add_to_list') plan.lists.add(a.list_id);
		if (a.type === 'add_topic') plan.topics.add(a.list_id);
		if (a.type === 'set_field') plan.meta[a.key] = a.value;
		if (a.type === 'set_source') plan.source = a.source;
		if (a.type === 'remove_tag') plan.removeTags.add(a.tag);
		if (a.type === 'enroll_automation') plan.automations.add(a.automation_id);
		if (a.type === 'notify') for (const u of a.user_ids) plan.notify.add(u);
	}
	for (const set of [plan.tags, plan.removeTags]) {
		for (const t of [...set]) {
			const clean = t.trim().slice(0, 60);
			set.delete(t);
			if (clean) set.add(clean);
		}
	}
	return plan;
}

/** Create or update the contact. Returns its id, whether it was new, and notes for `detail`. */
async function writeContact(
	db: D1Database,
	email: string,
	plan: Plan,
	enroll: boolean
): Promise<{ id: number; created: boolean; notes: string[] }> {
	const notes: string[] = [];
	const existing = await db
		.prepare('SELECT id, email, subscribed FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number; email: string; subscribed: number }>();
	let id: number;
	let created = false;
	if (!existing) {
		const c = plan.columns;
		const row = await db
			.prepare(
				`INSERT INTO contacts (email, name, first_name, last_name, company, source, subscribed)
				 VALUES (?, ?, ?, ?, ?, ?, 1)
				 ON CONFLICT(email) DO NOTHING RETURNING id`
			)
			.bind(email, c.name || null, c.first_name || null, c.last_name || null, c.company || null, plan.source.slice(0, 60))
			.first<{ id: number }>();
		if (row) {
			id = row.id;
			created = true;
			if (c.company) await syncCompanyMembership(db, id, c.company, { enroll });
		} else {
			// Lost a race with another write of the same address — update it instead.
			id = (await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>())!.id;
		}
	} else {
		id = existing.id;
	}
	if (!created) {
		// Only answered fields are written; a blank answer never clears what's there.
		const body: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(plan.columns)) if (v) body[k] = v;
		if (Object.keys(body).length) await applyContactFields(db, id, body, { currentEmail: email, enroll });
		await restoreIfArchived(db, { id });
		// Resubscribing only happens on confirm (#541); here the contact stays unsubscribed.
		if (existing && existing.subscribed === 0) notes.push(plan.consent ? 'kept unsubscribed: suppressed in Postmark' : 'kept unsubscribed: no consent');
	}
	const meta: Record<string, string> = {};
	for (const [k, v] of Object.entries(plan.meta)) if (v !== '') meta[k] = v;
	if (Object.keys(meta).length) await applyContactMeta(db, id, meta);
	for (const t of plan.tags) await addTagAndEnroll(db, t, id);
	for (const t of plan.removeTags) {
		await db
			.prepare("DELETE FROM list_members WHERE contact_id = ? AND list_id IN (SELECT id FROM lists WHERE name = ? COLLATE NOCASE AND kind = 'tag')")
			.bind(id, t)
			.run();
	}
	for (const l of plan.lists) await addToListById(db, l, id, enroll);
	if (plan.topics.size) {
		const valid = await db
			.prepare("SELECT l.id FROM lists l WHERE l.kind = 'list' AND l.public_topic = 1 AND l.id IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify([...plan.topics]))
			.all<{ id: number }>();
		const ids = valid.results.map((r) => r.id);
		if (ids.length) await saveTopicChoicesAndFire(db, id, ids, new Set(ids));
	}
	return { id, created, notes };
}

/**
 * Double opt-in (#510): the form's `settings.double_optin` is on and the address isn't subscribed.
 * Nothing is subscribed or joined now: `requestConfirmation` leaves the contact pending and stores
 * what the submission asked for (lists, tags, topics, meta fields, enroll, source) as the intent,
 * applied only when they press Confirm. Name parts / company are written on a new contact only.
 */
async function requestFormConfirmation(
	db: D1Database,
	env: SubmitEnv,
	form: FormRow,
	email: string,
	plan: Plan,
	baseUrl: string | undefined,
	ratings: RatingInput[] = []
): Promise<{ id: number | null; created: boolean; notes: string[]; confirmationId: number | null; appliedNow: boolean }> {
	const existing = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(plan.meta)) if (v !== '') fields[k] = v;
	const c = plan.columns;
	const res = await requestConfirmation(
		db,
		env,
		{
			email,
			contactId: existing?.id ?? null,
			source: 'form',
			intent: {
				list_ids: [...plan.lists],
				tags: [...plan.tags],
				topics: [...plan.topics],
				fields: Object.keys(fields).length ? fields : undefined,
				// #589: ratings wait for the confirm like every other mapping.
				ratings: ratings.length ? ratings : undefined,
				enroll: form.spec.settings.enroll,
				source: plan.source
			},
			contact: { name: c.name || null, first_name: c.first_name || null, last_name: c.last_name || null, company: c.company || null }
		},
		baseUrl ? { baseUrl } : {}
	);
	const notes: string[] = [];
	if (res.sent) notes.push('pending confirmation: confirm email sent');
	else if (res.reason === 'already_subscribed') notes.push('already subscribed: applied without confirmation');
	else if (res.reason === 'rate_limited') notes.push('pending confirmation: re-send limit reached');
	else notes.push(`pending confirmation: ${res.reason ?? 'not sent'}${res.error ? ` (${res.error.slice(0, 120)})` : ''}`);
	return {
		id: res.contactId ?? existing?.id ?? null,
		created: !existing && res.contactId !== undefined,
		notes,
		// #516: the confirmation now waiting (its intent gets the submission id once the row
		// exists), or — already subscribed — nothing waits: the intent was applied at once.
		confirmationId: res.confirmationId ?? null,
		appliedNow: res.reason === 'already_subscribed'
	};
}

/** "New submission: <form name>" to each chosen active user with an email address. */
export async function notifySubmission(
	db: D1Database,
	env: SubmitEnv,
	form: FormRow,
	sub: { id: number; email: string | null; contactId: number | null; answers: Answers; fields: FormField[] },
	opts: { baseUrl?: string; send?: typeof sendBatch; /** #514: users from fired `notify` actions. */ userIds?: number[] } = {}
): Promise<number> {
	const ids = [...new Set([...form.spec.settings.notify_user_ids, ...(opts.userIds ?? [])])];
	if (!ids.length || !env.POSTMARK_TOKEN) return 0;
	const sender = forwardSenderAddress(env as Record<string, string | undefined>);
	if (!sender) return 0;
	const users = await db
		.prepare('SELECT email FROM users WHERE disabled_at IS NULL AND email IS NOT NULL AND id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(ids))
		.all<{ email: string }>();
	if (!users.results.length) return 0;
	const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const rows = sub.fields
		.filter((f) => sub.answers[f.key] !== undefined)
		.map((f) => ({ q: f.label || f.key, a: answerText(sub.answers[f.key], f) }));
	const base = (opts.baseUrl ?? '').replace(/\/$/, '');
	const link = base ? `${base}/forms/${form.id}?tab=submissions` : '';
	const contactLink = base && sub.contactId ? `${base}/contacts/${sub.contactId}` : '';
	const text = [
		`New submission to ${form.name}${sub.email ? ` from ${sub.email}` : ''}.`,
		'',
		...rows.map((r) => `${r.q}\n${r.a}\n`),
		link ? `All submissions: ${link}` : '',
		contactLink ? `Contact: ${contactLink}` : ''
	]
		.filter((l) => l !== null)
		.join('\n');
	const html =
		`<p>New submission to <strong>${esc(form.name)}</strong>${sub.email ? ` from ${esc(sub.email)}` : ''}.</p>` +
		`<table cellpadding="6" style="border-collapse:collapse">${rows
			.map((r) => `<tr><td style="vertical-align:top;color:#666">${esc(r.q)}</td><td style="white-space:pre-wrap">${esc(r.a)}</td></tr>`)
			.join('')}</table>` +
		(link ? `<p><a href="${esc(link)}">All submissions</a>${contactLink ? ` · <a href="${esc(contactLink)}">Contact</a>` : ''}</p>` : '');
	let sent = 0;
	for (const u of users.results) {
		const message: PostmarkMessage = {
			From: formatAddress(`${form.name} form`, sender),
			To: u.email,
			...(sub.email ? { ReplyTo: sub.email } : {}),
			Subject: `New submission: ${form.name}`,
			TextBody: text,
			HtmlBody: html,
			MessageStream: env.POSTMARK_STREAM_TX || 'outbound',
			TrackOpens: false,
			TrackLinks: 'None'
		};
		const r = await sendReplyForward(env.POSTMARK_TOKEN, message, sender, forwardFallbackAddress(env as Record<string, string | undefined>), opts.send);
		if (r.ok) sent++;
		else console.error('form notification failed:', r.error);
	}
	return sent;
}

export async function handleSubmission(
	db: D1Database,
	env: SubmitEnv,
	form: FormRow,
	input: SubmissionInput,
	ctx: SubmitContext
): Promise<SubmitResult> {
	const spec = form.spec;
	const hash = await ipHash(ctx.ip, env.SESSION_SECRET);
	// #515: the host page of an embedded form (http(s) only, no credentials — `pageUrl`), stored on
	// the row; the #620 webhook sends this stored value (and the referrer only when it is absent).
	const embedPageUrl = pageUrl(input.pageUrl);
	const base = {
		form_id: form.id,
		form_version: form.version,
		utm: input.utm ?? null,
		referrer: input.referrer ?? null,
		page_url: embedPageUrl,
		ip_hash: hash,
		user_agent: input.userAgent ?? null
	};

	// 1. Rate limits (per hashed IP, per form), before any row is stored (#541). A 429 stores nothing.
	if (hash) {
		const r = await limit(db, `form:${form.id}:${hash}`, { max: RATE_PER_IP, windowSec: RATE_WINDOW_SEC, now: ctx.now });
		if (!r.ok) return { ok: false, status: 429, detail: 'rate_limit', error: 'Too many submissions. Please try again in a few minutes.' };
	}
	const rf = await limit(db, `form:${form.id}`, { max: RATE_PER_FORM, windowSec: RATE_WINDOW_SEC, now: ctx.now });
	if (!rf.ok) return { ok: false, status: 429, detail: 'rate_limit', error: 'This form is getting a lot of submissions. Please try again in a few minutes.' };

	// 2. Origin: the CRM host always; the form's allowed origins (phase 3); no Origin is fine.
	if (!originAllowed(ctx.origin, ctx.crmOrigins, spec.settings.allowed_origins)) {
		const id = await recordSubmission(db, { ...base, contact_id: null, email: null, status: 'rejected', detail: `origin ${String(ctx.origin).slice(0, 200)}`, answers: {} });
		return { ok: false, status: 403, detail: 'origin', submissionId: id, error: 'This form can’t be submitted from here.' };
	}

	// 3. Honeypot: stored as spam, answered like a success so bots learn nothing.
	if (input.honeypot && input.honeypot.trim()) {
		const { answers } = coerceAnswers(spec, input.answers);
		const em = emailField(spec);
		const email = em ? (answers[em.key] as string | undefined) ?? null : null;
		const id = await recordSubmission(db, { ...base, contact_id: null, email, status: 'spam', detail: 'honeypot', answers });
		return { ok: true, status: 200, detail: 'spam', submissionId: id, ...finishFor(form) };
	}

	// 4 + 5. Answers: shown questions on reached pages only (#514: the page-jump chain; a hidden
	// question's or a skipped page's answer is dropped and never reaches the contact), then strict.
	const loose = coerceAnswers({ fields: spec.fields.map((f) => ({ ...f, required: false })) }, input.answers).answers;
	const shown = formPath(spec, loose).fields;
	const shownIds = new Set(shown.map((f) => f.id));
	const { answers, errors } = coerceAnswers(spec, input.answers, shownIds);
	if (Object.keys(errors).length) {
		return { ok: false, status: 400, detail: 'invalid', errors, error: 'Please check the highlighted answers.' };
	}

	const em = emailField(spec);
	const email = em && shownIds.has(em.id) ? ((answers[em.key] as string | undefined) ?? null) : null;
	// #514: outcome rules may read the contact as it was before this submission.
	let ruleContact: RuleContact | null = null;
	try {
		ruleContact = await loadRuleContact(db, email);
	} catch (e) {
		console.error('form rule contact load failed:', e);
	}
	const fired = firedOutcomes(form, answers, ruleContact);
	const actions = fired.flatMap((o) => o.actions);
	let status: SubmissionStatus = 'anonymous';
	let contactId: number | null = null;
	const notes: string[] = [];
	// #589: answered Rating questions; stored on the contact once the submission row exists (so
	// the rating links to it), or carried in the double opt-in intent until the confirm.
	const ratings = ratingsFromAnswers(form.id, shown, answers);
	let normalWrite = false;
	// #516: the confirmation this submission waits on (its "Form submitted" automations start on
	// confirm), and whether the confirmation route applied everything at once (already subscribed).
	let confirmationId: number | null = null;
	let appliedNow = false;
	let plan: Plan | null = null;

	if (email) {
		// 6. Hygiene: syntax was checked above; disposable / no-MX are tagged, never refused.
		let hygiene = null;
		try {
			hygiene = await checkAddress(email, { lookup: ctx.mxLookup });
		} catch {
			hygiene = null;
		}
		// 7 + 8. Contact write + outcome actions — or a pending contact + a confirm email (the
		// actions wait for the confirm) when double opt-in is on for an address that isn't
		// subscribed, or, whatever that setting, an unsubscribed contact ticks consent (#541).
		plan = planFor(shown, answers, actions);
		const route = await confirmationRoute(db, env, form, email, plan);
		if (route) notes.push(route);
		const w =
			route !== null
				? await requestFormConfirmation(db, env, form, email, plan, ctx.baseUrl, ratings)
				: await writeContact(db, email, plan, spec.settings.enroll);
		normalWrite = route === null;
		if ('confirmationId' in w) {
			confirmationId = w.confirmationId;
			appliedNow = w.appliedNow;
		}
		contactId = w.id;
		status = w.created ? 'added' : 'updated';
		notes.push(...w.notes);
		if (hygiene && w.id !== null) {
			try {
				await recordHygiene(db, w.id, hygiene);
				if (hygieneInvalid(hygiene)) notes.push('address looks invalid');
			} catch (e) {
				console.error('form hygiene record failed:', e);
			}
		}
	} else if (!spec.settings.allow_anonymous) {
		return { ok: false, status: 400, detail: 'invalid', errors: em ? { [em.key]: 'This question is required.' } : {}, error: 'An email address is required.' };
	}

	// 8b. #514: `enroll_automation` actions — only while the form's `settings.enroll` is on, and only
	// after a normal contact write (a pending confirmation enrols nobody; `remove_tag` likewise waits
	// for a normal write).
	if (plan && plan.automations.size && normalWrite && contactId !== null) {
		if (!spec.settings.enroll) notes.push('automation enrolment off');
		else {
			for (const aid of plan.automations) {
				try {
					const r = await enrollContactsInAutomation(db, aid, [contactId]);
					if (!r.ok) notes.push(`automation ${aid}: ${r.error.slice(0, 80)}`);
				} catch (e) {
					console.error('form enroll_automation failed:', e);
				}
			}
		}
	}

	// 9. The submission row (the activity feed reads it), with the outcomes that fired (#514).
	const id = await recordSubmission(db, {
		...base,
		contact_id: contactId,
		email,
		status,
		detail: notes.join('; ') || null,
		answers,
		outcomes: fired.map((o) => o.id)
	});
	if (normalWrite && contactId !== null && ratings.length) {
		try {
			await insertRatings(db, contactId, ratings, id);
		} catch (e) {
			console.error('form ratings write failed:', e);
		}
	}

	// 9b. #516: "Form submitted" automation triggers, only when the form's `settings.enroll` is on
	// (checked in fireFormTriggers). After the normal contact write (or a confirmation route that
	// found the address already subscribed and applied everything at once) they fire now. When the
	// submission waits on a confirmation (double opt-in / #541), its id goes into that
	// confirmation's intent and `confirmSubscription` fires them when the person confirms; never
	// confirmed = never fired. Anonymous submissions never fire. Best-effort: a failure here never
	// fails the submission.
	if ((normalWrite || appliedNow) && contactId !== null) {
		try {
			await fireFormTriggers(db, { form: { id: form.id, name: form.name, enroll: spec.settings.enroll }, submissionId: id, contactId, answers }, ctx.now);
		} catch (e) {
			console.error('form_submitted trigger failed:', e);
		}
	} else if (confirmationId !== null && contactId !== null) {
		try {
			await attachFormSubmission(db, confirmationId, id);
		} catch (e) {
			console.error('form submission → confirmation link failed:', e);
		}
	}

	// 10. Notify (best-effort).
	try {
		const userIds = [...new Set(actions.flatMap((a) => (a.type === 'notify' ? a.user_ids : [])))];
		await notifySubmission(db, env, form, { id, email, contactId, answers, fields: shown }, { baseUrl: ctx.baseUrl, send: ctx.send, userIds });
	} catch (e) {
		console.error('form notify failed:', e);
	}

	// 11. #620: the form webhook, fire and forget (waitUntil when the route has it). A failure is
	// appended to the submission's `detail`; it never changes the answer the visitor gets.
	const hook = spec.settings.notify_webhook;
	if (hook) {
		const work = (async () => {
			try {
				const key = await formWebhookSecret(env.SESSION_SECRET, form.id);
				await sendFormWebhook(
					db,
					hook,
					{
						form: { id: form.id, name: form.name, slug: form.slug },
						submission_id: id,
						contact_id: contactId,
						email,
						answers,
						submitted_at: (ctx.now ?? new Date()).toISOString(),
						// #515's stored host page for an embedded form (there `referrer` is the host page's own
						// referrer); otherwise the page the visitor came from (#620).
						page_url: embedPageUrl ?? pageUrl(input.referrer)
					},
					key,
					{ fetch: ctx.fetch, now: ctx.now }
				);
			} catch (e) {
				console.error('form webhook failed:', e);
			}
		})();
		if (ctx.waitUntil) ctx.waitUntil(work);
		else await work;
	}

	return { ok: true, status: 200, detail: status, submissionId: id, ...finishFor(form, answers, { fired: fired.map((o) => o.id) }) };
}

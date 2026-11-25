// Double opt-in (#510): optional. A sign-up that asks for confirmation (a form's
// `settings.double_optin`, a webhook key's "Require confirmation", `confirm: true` on
// /api/ingest or /api/contacts/upsert) does not subscribe anyone. `requestConfirmation`
// leaves the contact pending (`subscribed = 0`, `confirm_pending = 1` — every send path skips
// `subscribed = 0`), stores what the sign-up asked for in `subscription_confirmations.intent`
// and emails one confirm link. Only `confirmSubscription` (the /confirm page's button — never
// a GET) subscribes them, applies the intent (lists, tags, topics, fields, enroll as recorded)
// and fires the "Subscription changes" trigger (`subscribed`, source `double_optin`) — plus, for a
// form submission that waited on it, that submission's "Form submitted" automations (#516).
//
// The token is 32 random bytes (base64url) in the link; only its SHA-256 is stored. A link
// lives `expiryHours` (Settings → Double opt-in); a confirmation can be re-sent at most
// RESEND_MAX times, RESEND_GAP_MINUTES apart, each with a fresh token (the old link stops
// working). The email is a direct campaign on the transactional stream — no tracking, no
// unsubscribe footer — like the snapshot review / job emails.

import { sendCampaignEmail } from './send';
import { getSettings } from './settings';
import { publicBaseUrl } from './public-url';
import { emailDocument } from './email';
import { addToList, addTagAndEnroll, autoEnroll } from './contacts';
import { addTag } from './automations';
import { applyContactMeta } from './contact-write';
import { cleanRatingInputs, insertRatings, type RatingInput } from './contact-ratings';
import { subscriptionChanged } from './subscription-trigger';
import { credentialError, getMailProvider, isHardSuppression, mailSetup } from './mail';
import { RESUB_REFUSED } from './unsubscribe-page';
import { fireFormTriggersForSubmission } from './form-trigger';
import { b64urlEncode } from './token';
import { parseMarkdownPreservingMergeTags } from '$lib/merge-tags';
import { isEmail } from '$lib/csv';
import {
	CONFIRM_URL_TAG,
	DOI_KEY,
	RESEND_GAP_MINUTES,
	RESEND_MAX,
	normalizeDoi,
	type DoiConfig
} from '$lib/double-optin';

export type DoiEnv = {
	POSTMARK_TOKEN?: string;
	POSTMARK_STREAM?: string;
	POSTMARK_STREAM_TX?: string;
	POSTMARK_FROM?: string;
	SESSION_SECRET?: string;
	PUBLIC_BASE_URL?: string;
};

/** What the sign-up asked for — applied only on confirmation. */
export type ConfirmIntent = {
	/** List names (find-or-create, kind 'list'). */
	lists?: string[];
	/** List / hand-picked segment ids. */
	list_ids?: number[];
	tags?: string[];
	/** Topic list ids (public topics): joined, any opt-out cleared. */
	topics?: number[];
	/** Custom fields merged into contacts.meta. */
	fields?: Record<string, unknown>;
	/** #589: a form's answered Rating questions, stored on the contact at confirm time. */
	ratings?: RatingInput[];
	/** Fire list_added automations for the list / tag adds. */
	enroll?: boolean;
	/** Stamped on the contact at confirm time when it has none. */
	source?: string | null;
	/** The contact was unsubscribed: confirming is their consent to resubscribe (#285 guard). */
	resubscribe?: boolean;
	/** #516: the form submission waiting on this confirmation; its "Form submitted" automations
	 *  start at confirm time. Set by `attachFormSubmission` once the submission row exists. */
	form_submission_id?: number;
	/** #742: the sign-up came through a webhook key that does not trust the body. On confirm,
	 *  `fields` only fill custom fields the contact doesn't have yet; nothing is overwritten. */
	fields_fill_only?: boolean;
};

type Deliver = typeof sendCampaignEmail;
/** What sending the confirmation email came to. */
export type DeliveryResult = { ok: true } | { ok: false; error: string };
/**
 * `defer` (#742): hand the confirmation email's send to the caller instead of waiting for it
 * (the caller passes it to the Worker's `waitUntil`). The promise never rejects. The result then
 * says `queued: true` and the send outcome only reaches the caller through that promise.
 */
export type DoiOpts = { now?: Date; deliver?: Deliver; baseUrl?: string; defer?: (delivery: Promise<DeliveryResult>) => void };

type ConfirmationRow = {
	id: number;
	contact_id: number | null;
	email: string;
	source: string | null;
	intent: string | null;
	created_at: string;
	expires_at: string;
	confirmed_at: string | null;
	expired_at: string | null;
	cancelled_at: string | null;
	resend_count: number;
	last_sent_at: string | null;
};

const ROW_COLS = 'id, contact_id, email, source, intent, created_at, expires_at, confirmed_at, expired_at, cancelled_at, resend_count, last_sent_at';

/** 'YYYY-MM-DD HH:MM:SS' UTC — the format datetime('now') writes. */
export function sqlTime(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function hashToken(token: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
	const b = new Uint8Array(32);
	crypto.getRandomValues(b);
	return b64urlEncode(b);
}

export async function getDoiConfig(db: D1Database | null | undefined): Promise<DoiConfig> {
	if (!db) return normalizeDoi(null);
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(DOI_KEY).first<{ value: string | null }>();
		return normalizeDoi(row?.value ?? null);
	} catch {
		return normalizeDoi(null);
	}
}

export async function saveDoiConfig(db: D1Database, cfg: DoiConfig): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(DOI_KEY, JSON.stringify(cfg))
		.run();
}

/** Clean, bounded intent (it's stored as JSON and replayed later). */
export function cleanIntent(raw: ConfirmIntent): ConfirmIntent {
	const names = (v: unknown, cap: number) =>
		Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim().slice(0, 60)).filter(Boolean))].slice(0, cap) : [];
	const ids = (v: unknown) =>
		Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 25) : [];
	const out: ConfirmIntent = {};
	const lists = names(raw.lists, 10);
	if (lists.length) out.lists = lists;
	const listIds = ids(raw.list_ids);
	if (listIds.length) out.list_ids = listIds;
	const tags = names(raw.tags, 25);
	if (tags.length) out.tags = tags;
	const topics = ids(raw.topics);
	if (topics.length) out.topics = topics;
	if (raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields) && Object.keys(raw.fields).length) out.fields = raw.fields;
	const ratings = cleanRatingInputs(raw.ratings);
	if (ratings.length) out.ratings = ratings;
	if (raw.enroll) out.enroll = true;
	if (raw.source) out.source = String(raw.source).trim().slice(0, 100) || null;
	if (raw.resubscribe) out.resubscribe = true;
	const sub = Number(raw.form_submission_id);
	if (Number.isInteger(sub) && sub > 0) out.form_submission_id = sub;
	if (raw.fields_fill_only) out.fields_fill_only = true;
	return out;
}

function parseIntent(json: string | null): ConfirmIntent {
	if (!json) return {};
	try {
		const v = JSON.parse(json);
		return v && typeof v === 'object' ? cleanIntent(v) : {};
	} catch {
		return {};
	}
}

/**
 * Apply an intent to a (now subscribed) contact: lists by name / id, tags, topics, fields.
 * List and tag adds fire `list_added` automations only when `enroll` is set.
 */
export async function applyIntent(db: D1Database, contactId: number, intent: ConfirmIntent): Promise<void> {
	const enrollIn = async (listId: number | null) => {
		if (!listId || !intent.enroll) return;
		try {
			await autoEnroll(db, listId, [contactId]);
		} catch (e) {
			console.error('double opt-in auto-enroll failed:', e);
		}
	};
	for (const name of intent.lists ?? []) await enrollIn(await addToList(db, name, contactId));
	for (const id of intent.list_ids ?? []) {
		const ok = await db
			.prepare(`SELECT id FROM lists WHERE id = ? AND (kind = 'list' OR (kind = 'segment' AND rules IS NULL))`)
			.bind(id)
			.first<{ id: number }>();
		if (!ok) continue;
		await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(id, contactId).run();
		await enrollIn(id);
	}
	for (const t of intent.tags ?? []) {
		if (intent.enroll) await addTagAndEnroll(db, t, contactId);
		else await addTag(db, t, contactId);
	}
	for (const id of intent.topics ?? []) {
		const topic = await db.prepare(`SELECT id FROM lists WHERE id = ? AND kind = 'list' AND public_topic = 1`).bind(id).first<{ id: number }>();
		if (!topic) continue;
		await db.batch([
			db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(id, contactId),
			db.prepare('DELETE FROM topic_optouts WHERE contact_id = ? AND list_id = ?').bind(contactId, id)
		]);
		await enrollIn(id);
	}
	if (intent.fields) {
		let fields = intent.fields;
		if (intent.fields_fill_only) {
			// #742: fill blanks only, the same rule as the direct path of an untrusted key.
			const prev = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(contactId).first<{ meta: string | null }>();
			let have: Record<string, unknown> = {};
			try {
				have = prev?.meta ? JSON.parse(prev.meta) : {};
			} catch {
				have = {};
			}
			if (!have || typeof have !== 'object') have = {};
			fields = Object.fromEntries(
				Object.entries(fields).filter(([k, v]) => v !== null && v !== '' && have[k.trim().slice(0, 50)] === undefined)
			);
		}
		if (Object.keys(fields).length) await applyContactMeta(db, contactId, fields);
	}
	if (intent.ratings?.length) await insertRatings(db, contactId, intent.ratings);
}

/** Does this address need a confirmation? No contact, or a contact that isn't subscribed. */
export async function needsConfirmation(db: D1Database, email: string): Promise<boolean> {
	const c = await db.prepare('SELECT subscribed FROM contacts WHERE email = ?').bind(email.trim().toLowerCase()).first<{ subscribed: number }>();
	return !c || c.subscribed !== 1;
}

async function sendConfirmEmail(
	db: D1Database,
	env: DoiEnv,
	contactId: number,
	email: string,
	token: string,
	opts: DoiOpts
): Promise<DeliveryResult> {
	const { provider: mail, creds } = await mailSetup(db, env);
	if (!mail) return { ok: false, error: credentialError(creds) ?? 'POSTMARK_TOKEN is not set.' };
	const cfg = await getDoiConfig(db);
	const baseUrl = opts.baseUrl ?? (await publicBaseUrl(db, env));
	const url = `${baseUrl}/confirm/${encodeURIComponent(token)}`;
	const contact = await db
		.prepare('SELECT id, email, name, first_name, last_name, company FROM contacts WHERE id = ?')
		.bind(contactId)
		.first<{ id: number; email: string; name: string | null; first_name: string | null; last_name: string | null; company: string | null }>();
	const msg = renderConfirmEmail(cfg, url);
	const redacted = `${baseUrl}/confirm/…`;
	const from = (await getSettings(db)).default_from?.trim() || env.POSTMARK_FROM || '';
	if (!from) return { ok: false, error: 'No From address (Settings → Default From or POSTMARK_FROM).' };
	const campaign = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, sent_at)
			 VALUES (?, ?, ?, ?, NULL, ?, 'sending', datetime('now')) RETURNING id`
		)
		// The stored copy must not carry a live link: the URL appears more than once (link text,
		// href, button), so redact every occurrence, not just the first.
		.bind(cfg.subject, cfg.body, msg.html.split(url).join(redacted), msg.text.split(url).join(redacted), from)
		.first<{ id: number }>();
	const campaignId = campaign!.id;
	const deliver = opts.deliver ?? sendCampaignEmail;
	let result;
	try {
		result = await deliver(db, {
			provider: mail,
			secret: env.SESSION_SECRET || 'unused',
			baseUrl,
			campaignId,
			recipients: [contact ?? { id: contactId, email, name: null, first_name: null, last_name: null }],
			subject: cfg.subject,
			htmlTemplate: msg.html,
			textTemplate: msg.text,
			from,
			stream: mail.streams.transactional,
			streamKind: 'transactional',
			trackOpens: false,
			trackLinks: 'None',
			unsubscribe: false
		});
	} catch (e) {
		const message = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
		await db.prepare(`UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?`).bind(message, campaignId).run();
		return { ok: false, error: message };
	}
	const ok = result.accepted > 0;
	await db
		.prepare('UPDATE campaigns SET status = ?, recipient_count = ?, error = ? WHERE id = ?')
		.bind(ok ? 'sent' : 'failed', result.accepted, ok ? null : result.firstError, campaignId)
		.run();
	return ok ? { ok: true } : { ok: false, error: result.firstError ?? 'Postmark refused the email.' };
}

/** `sendConfirmEmail` as a promise that never rejects (safe to hand to `waitUntil`). */
function deliverConfirmEmail(
	db: D1Database,
	env: DoiEnv,
	contactId: number,
	email: string,
	token: string,
	opts: DoiOpts
): Promise<DeliveryResult> {
	return sendConfirmEmail(db, env, contactId, email, token, opts).catch((e: unknown) => {
		console.error('confirmation email failed:', e);
		return { ok: false as const, error: (e instanceof Error ? e.message : 'send failed').slice(0, 300) };
	});
}

/** The confirmation email for a confirm URL (merge tags like {{first_name}} stay for send-time personalisation). */
export function renderConfirmEmail(cfg: DoiConfig, url: string): { html: string; text: string } {
	const md = cfg.body.split(CONFIRM_URL_TAG).join(url);
	const button = `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#147793;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(cfg.button)}</a></p>`;
	return { html: emailDocument(parseMarkdownPreservingMergeTags(md) + button), text: md };
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type RequestResult = {
	sent: boolean;
	/** #742: the email was handed to `opts.defer`; its outcome is that promise's. */
	queued?: boolean;
	reason?: 'invalid_email' | 'already_subscribed' | 'rate_limited' | 'send_failed';
	error?: string;
	contactId?: number;
	confirmationId?: number;
};

/**
 * Start (or re-send) a confirmation for this address. Creates the contact as pending when it's
 * new, marks an unsubscribed one pending (confirming = consent to resubscribe), reuses an open
 * confirmation (a re-send: rate-limited, fresh token, newest intent). An already-subscribed
 * contact gets no email — the intent is applied at once (`reason: 'already_subscribed'`).
 * `fields` + name parts in `contact` are written on a new contact only.
 * `keepArchived` (#742): an archived contact stays archived until the link is confirmed
 * (`confirmSubscription` restores it). Without it, asking again restores it at once.
 */
export async function requestConfirmation(
	db: D1Database,
	env: DoiEnv,
	input: {
		email: string;
		contactId?: number | null;
		intent: ConfirmIntent;
		source: string;
		contact?: { name?: string | null; first_name?: string | null; last_name?: string | null; company?: string | null };
		keepArchived?: boolean;
	},
	opts: DoiOpts = {}
): Promise<RequestResult> {
	const now = opts.now ?? new Date();
	const email = input.email.trim().toLowerCase();
	if (!isEmail(email)) return { sent: false, reason: 'invalid_email' };
	const intent = cleanIntent({ ...input.intent, source: input.intent.source ?? input.source });

	let contact = input.contactId
		? await db.prepare('SELECT id, email, subscribed, confirm_pending FROM contacts WHERE id = ?').bind(input.contactId).first<{ id: number; email: string; subscribed: number; confirm_pending: number }>()
		: await db.prepare('SELECT id, email, subscribed, confirm_pending FROM contacts WHERE email = ?').bind(email).first<{ id: number; email: string; subscribed: number; confirm_pending: number }>();

	if (contact?.subscribed === 1) {
		await applyIntent(db, contact.id, intent);
		return { sent: false, reason: 'already_subscribed', contactId: contact.id };
	}

	if (!contact) {
		const c = input.contact ?? {};
		const s = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);
		const row = await db
			.prepare(
				`INSERT INTO contacts (email, name, first_name, last_name, company, source, subscribed, confirm_pending)
				 VALUES (?, ?, ?, ?, ?, ?, 0, 1)
				 ON CONFLICT(email) DO UPDATE SET confirm_pending = CASE WHEN contacts.subscribed = 1 THEN 0 ELSE 1 END
				 RETURNING id, email, subscribed, confirm_pending`
			)
			.bind(email, s(c.name), s(c.first_name), s(c.last_name), s(c.company), intent.source ?? input.source ?? null)
			.first<{ id: number; email: string; subscribed: number; confirm_pending: number }>();
		contact = row!;
		if (contact.subscribed === 1) {
			await applyIntent(db, contact.id, intent);
			return { sent: false, reason: 'already_subscribed', contactId: contact.id };
		}
	} else {
		// Unsubscribed (not yet pending): confirming is their consent to resubscribe.
		if (!contact.confirm_pending) intent.resubscribe = true;
		await db
			.prepare(
				input.keepArchived
					? 'UPDATE contacts SET confirm_pending = 1 WHERE id = ?'
					: 'UPDATE contacts SET confirm_pending = 1, archived_at = NULL WHERE id = ?'
			)
			.bind(contact.id)
			.run();
	}
	const contactId = contact.id;
	const cfg = await getDoiConfig(db);
	const nowSql = sqlTime(now);

	const open = await db
		.prepare(
			`SELECT ${ROW_COLS} FROM subscription_confirmations
			 WHERE contact_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND expires_at > ?
			 ORDER BY id DESC LIMIT 1`
		)
		.bind(contactId, nowSql)
		.first<ConfirmationRow>();
	if (open) {
		// Keep the earlier "resubscribe" consent flag when a re-send carries the newest intent, and
		// the earlier form submission (#516) when this one carries none (a form re-send attaches
		// its own after its submission row is written).
		const prev = parseIntent(open.intent);
		if (prev.resubscribe) intent.resubscribe = true;
		if (prev.form_submission_id && !intent.form_submission_id) intent.form_submission_id = prev.form_submission_id;
		await db.prepare('UPDATE subscription_confirmations SET intent = ? WHERE id = ?').bind(JSON.stringify(intent), open.id).run();
		return resendRow(db, env, open, cfg, opts);
	}

	const token = newToken();
	const expires = sqlTime(new Date(now.getTime() + cfg.expiryHours * 3600_000));
	const row = await db
		.prepare(
			`INSERT INTO subscription_confirmations (contact_id, email, token_hash, source, intent, created_at, expires_at, last_sent_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(contactId, contact.email, await hashToken(token), input.source.slice(0, 60), JSON.stringify(intent), nowSql, expires, nowSql)
		.first<{ id: number }>();
	const delivery = deliverConfirmEmail(db, env, contactId, contact.email, token, opts);
	if (opts.defer) {
		opts.defer(delivery);
		return { sent: false, queued: true, contactId, confirmationId: row!.id };
	}
	const sent = await delivery;
	if (!sent.ok) return { sent: false, reason: 'send_failed', error: sent.error, contactId, confirmationId: row!.id };
	return { sent: true, contactId, confirmationId: row!.id };
}

/**
 * #516: a form submission that went through the confirmation route → record its id in the
 * waiting confirmation's intent, so confirming starts that submission's "Form submitted"
 * automations. Called after the submission row exists (`requestConfirmation` runs before it).
 * Only an open (unconfirmed, uncancelled) row is changed. Returns whether it was written.
 */
export async function attachFormSubmission(db: D1Database, confirmationId: number, submissionId: number): Promise<boolean> {
	const row = await db
		.prepare('SELECT intent FROM subscription_confirmations WHERE id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL')
		.bind(confirmationId)
		.first<{ intent: string | null }>();
	if (!row) return false;
	const intent = parseIntent(row.intent);
	intent.form_submission_id = submissionId;
	const res = await db
		.prepare('UPDATE subscription_confirmations SET intent = ? WHERE id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL')
		.bind(JSON.stringify(cleanIntent(intent)), confirmationId)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Can this row be re-sent now? ≤ RESEND_MAX re-sends, RESEND_GAP_MINUTES apart. */
export function resendAllowed(row: Pick<ConfirmationRow, 'resend_count' | 'last_sent_at' | 'created_at'>, now: Date): boolean {
	if (row.resend_count >= RESEND_MAX) return false;
	const last = Date.parse(`${(row.last_sent_at ?? row.created_at).replace(' ', 'T')}Z`);
	return !Number.isFinite(last) || now.getTime() - last >= RESEND_GAP_MINUTES * 60_000;
}

async function resendRow(db: D1Database, env: DoiEnv, row: ConfirmationRow, cfg: DoiConfig, opts: DoiOpts): Promise<RequestResult> {
	const now = opts.now ?? new Date();
	const contactId = row.contact_id ?? undefined;
	if (!row.contact_id) return { sent: false, reason: 'send_failed', error: 'The contact no longer exists.' };
	if (!resendAllowed(row, now)) return { sent: false, reason: 'rate_limited', contactId, confirmationId: row.id };
	const token = newToken();
	const nowSql = sqlTime(now);
	const expires = sqlTime(new Date(now.getTime() + cfg.expiryHours * 3600_000));
	// Conditional on the count we read, so two clicks can't both pass the limit.
	const claimed = await db
		.prepare(
			`UPDATE subscription_confirmations
			 SET token_hash = ?, expires_at = ?, expired_at = NULL, resend_count = resend_count + 1, last_sent_at = ?
			 WHERE id = ? AND resend_count = ? AND confirmed_at IS NULL AND cancelled_at IS NULL`
		)
		.bind(await hashToken(token), expires, nowSql, row.id, row.resend_count)
		.run();
	if (!(claimed.meta.changes ?? 0)) return { sent: false, reason: 'rate_limited', contactId, confirmationId: row.id };
	const delivery = deliverConfirmEmail(db, env, row.contact_id, row.email, token, opts);
	if (opts.defer) {
		opts.defer(delivery);
		return { sent: false, queued: true, contactId, confirmationId: row.id };
	}
	const sent = await delivery;
	if (!sent.ok) return { sent: false, reason: 'send_failed', error: sent.error, contactId, confirmationId: row.id };
	return { sent: true, contactId, confirmationId: row.id };
}

async function rowByToken(db: D1Database, token: string): Promise<ConfirmationRow | null> {
	if (!token || token.length > 200) return null;
	return db.prepare(`SELECT ${ROW_COLS} FROM subscription_confirmations WHERE token_hash = ?`).bind(await hashToken(token)).first<ConfirmationRow>();
}

const isExpired = (row: ConfirmationRow, now: Date) => !!row.expired_at || row.expires_at <= sqlTime(now);

/** "Send a new link" from the expired page (by the old link's token). */
export async function resendConfirmation(db: D1Database, env: DoiEnv, token: string, opts: DoiOpts = {}): Promise<RequestResult & { alreadyConfirmed?: boolean; invalid?: boolean }> {
	const row = await rowByToken(db, token);
	if (!row || row.cancelled_at) return { sent: false, invalid: true };
	if (row.confirmed_at) return { sent: false, alreadyConfirmed: true };
	return resendRow(db, env, row, await getDoiConfig(db), opts);
}

/** Contact page → Resend confirmation: the contact's newest open (or expired) confirmation. */
export async function resendForContact(db: D1Database, env: DoiEnv, contactId: number, opts: DoiOpts = {}): Promise<RequestResult> {
	const row = await db
		.prepare(
			`SELECT ${ROW_COLS} FROM subscription_confirmations
			 WHERE contact_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1`
		)
		.bind(contactId)
		.first<ConfirmationRow>();
	if (!row) return { sent: false, reason: 'send_failed', error: 'No confirmation is waiting for this contact.' };
	return resendRow(db, env, row, await getDoiConfig(db), opts);
}

export type PeekResult =
	| { state: 'invalid' }
	| { state: 'ready' | 'confirmed' | 'expired'; email: string; canResend: boolean };

/** What the GET /confirm page shows. Never changes anything. */
export async function peekConfirmation(db: D1Database, token: string, now: Date = new Date()): Promise<PeekResult> {
	const row = await rowByToken(db, token);
	if (!row || row.cancelled_at || !row.contact_id) return { state: 'invalid' };
	if (row.confirmed_at) return { state: 'confirmed', email: row.email, canResend: false };
	if (isExpired(row, now)) return { state: 'expired', email: row.email, canResend: resendAllowed(row, now) };
	return { state: 'ready', email: row.email, canResend: false };
}

export type ConfirmResult = {
	ok: boolean;
	contactId?: number;
	email?: string;
	alreadyConfirmed?: boolean;
	expired?: boolean;
	invalid?: boolean;
	refused?: boolean;
	error?: string;
};

/**
 * The /confirm page's button. Subscribes the contact, applies the recorded intent, stamps
 * `source` when the contact had none and fires `subscribed` (source `double_optin`). When the
 * contact had unsubscribed before, the #285 guard runs first: a HardBounce / SpamComplaint
 * suppression in Postmark refuses it; a manual one is lifted. Postmark unset / unreachable →
 * confirmed without the check (like resubscribe).
 */
export async function confirmSubscription(
	db: D1Database,
	env: DoiEnv,
	token: string,
	_ctx: { actor: 'self' } = { actor: 'self' },
	opts: { now?: Date } = {}
): Promise<ConfirmResult> {
	const now = opts.now ?? new Date();
	const row = await rowByToken(db, token);
	if (!row || row.cancelled_at || !row.contact_id) return { ok: false, invalid: true };
	if (row.confirmed_at) return { ok: true, alreadyConfirmed: true, contactId: row.contact_id, email: row.email };
	if (isExpired(row, now)) return { ok: false, expired: true, contactId: row.contact_id, email: row.email };
	const contact = await db.prepare('SELECT id, email FROM contacts WHERE id = ?').bind(row.contact_id).first<{ id: number; email: string }>();
	if (!contact) return { ok: false, invalid: true };
	const intent = parseIntent(row.intent);

	let manualStream: string | null = null;
	const mail = intent.resubscribe ? await getMailProvider(db, env) : null;
	if (intent.resubscribe && mail?.suppressions) {
		try {
			const { map } = await mail.suppressions.byEmail();
			const s = map.get(contact.email.toLowerCase());
			if (s && isHardSuppression(s.reason)) return { ok: false, refused: true, error: RESUB_REFUSED, contactId: contact.id, email: contact.email };
			if (s) manualStream = s.stream;
		} catch {
			/* unreachable → not checked */
		}
	}

	const nowSql = sqlTime(now);
	const claim = await db
		.prepare('UPDATE subscription_confirmations SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL')
		.bind(nowSql, row.id)
		.run();
	if (!(claim.meta.changes ?? 0)) return { ok: true, alreadyConfirmed: true, contactId: contact.id, email: contact.email };
	await db.batch([
		db
			.prepare(
				`UPDATE contacts SET subscribed = 1, confirm_pending = 0, archived_at = NULL,
				   source = COALESCE(NULLIF(source, ''), ?) WHERE id = ?`
			)
			.bind(intent.source ?? row.source ?? 'double_optin', contact.id),
		db
			.prepare('UPDATE subscription_confirmations SET cancelled_at = ? WHERE contact_id = ? AND id != ? AND confirmed_at IS NULL AND cancelled_at IS NULL')
			.bind(nowSql, contact.id, row.id)
	]);
	try {
		await applyIntent(db, contact.id, intent);
	} catch (e) {
		console.error('double opt-in intent failed:', e);
	}
	// #516: the form submission this confirmation was waiting on starts its "Form submitted"
	// automations now — once, since only the claim above gets here. Best-effort.
	if (intent.form_submission_id) {
		try {
			await fireFormTriggersForSubmission(db, intent.form_submission_id, contact.id, now);
		} catch (e) {
			console.error('double opt-in form_submitted trigger failed:', e);
		}
	}
	if (manualStream && mail?.suppressions) {
		try {
			await mail.suppressions.remove(contact.email, manualStream);
		} catch {
			/* best-effort */
		}
	}
	await subscriptionChanged(db, [contact.id], 'subscribed', { source: 'double_optin', now });
	if (intent.resubscribe) await subscriptionChanged(db, [contact.id], 'resubscribed', { source: 'double_optin', now });
	return { ok: true, contactId: contact.id, email: contact.email };
}

/** Contact page → Cancel: drop the pending state (they stay unsubscribed); open links stop working. */
export async function cancelPending(db: D1Database, contactId: number, now: Date = new Date()): Promise<boolean> {
	const res = await db.batch([
		db.prepare('UPDATE contacts SET confirm_pending = 0 WHERE id = ? AND confirm_pending = 1').bind(contactId),
		db
			.prepare('UPDATE subscription_confirmations SET cancelled_at = ? WHERE contact_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL')
			.bind(sqlTime(now), contactId)
	]);
	return (res[0].meta.changes ?? 0) > 0;
}

export type PendingInfo = { sentAt: string; lastSentAt: string | null; resendCount: number; expiresAt: string; expired: boolean; canResend: boolean };

/** The contact page badge's tooltip: when it was sent, how often re-sent. */
export async function pendingInfo(db: D1Database, contactId: number, now: Date = new Date()): Promise<PendingInfo | null> {
	const row = await db
		.prepare(`SELECT ${ROW_COLS} FROM subscription_confirmations WHERE contact_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1`)
		.bind(contactId)
		.first<ConfirmationRow>();
	if (!row) return null;
	return {
		sentAt: row.created_at,
		lastSentAt: row.last_sent_at,
		resendCount: row.resend_count,
		expiresAt: row.expires_at,
		expired: isExpired(row, now),
		canResend: resendAllowed(row, now)
	};
}

/** Heartbeat: stamp `expired_at` on links past `expires_at`. The contact stays pending. */
export async function expireConfirmations(db: D1Database, now: Date = new Date()): Promise<{ expired: number }> {
	const res = await db
		.prepare(
			`UPDATE subscription_confirmations SET expired_at = ?
			 WHERE confirmed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND expires_at <= ?`
		)
		.bind(sqlTime(now), sqlTime(now))
		.run();
	return { expired: res.meta.changes ?? 0 };
}

/** Settings → Double opt-in → Send me a test: the saved email to one address, with a preview link. */
export async function sendDoiTest(
	db: D1Database,
	env: DoiEnv,
	to: string,
	opts: { deliver?: Deliver; baseUrl?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!isEmail(to)) return { ok: false, error: 'Your user record has no email address.' };
	const { provider: mail, creds } = await mailSetup(db, env);
	if (!mail) return { ok: false, error: credentialError(creds) ?? 'POSTMARK_TOKEN is not set.' };
	const cfg = await getDoiConfig(db);
	const baseUrl = opts.baseUrl ?? (await publicBaseUrl(db, env));
	const msg = renderConfirmEmail(cfg, `${baseUrl}/confirm/preview`);
	const from = (await getSettings(db)).default_from?.trim() || env.POSTMARK_FROM || '';
	if (!from) return { ok: false, error: 'No From address (Settings → Default From or POSTMARK_FROM).' };
	const subject = `[TEST] ${cfg.subject}`;
	const campaign = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, sent_at)
			 VALUES (?, ?, ?, ?, NULL, ?, 'sending', datetime('now')) RETURNING id`
		)
		.bind(subject, cfg.body, msg.html, msg.text, from)
		.first<{ id: number }>();
	const contact = await db
		.prepare('SELECT id, email, name, first_name, last_name FROM contacts WHERE email = ?')
		.bind(to.toLowerCase())
		.first<{ id: number; email: string; name: string | null; first_name: string | null; last_name: string | null }>();
	try {
		const r = await (opts.deliver ?? sendCampaignEmail)(db, {
			provider: mail,
			secret: env.SESSION_SECRET || 'unused',
			baseUrl,
			campaignId: campaign!.id,
			recipients: [contact ?? { id: null, email: to, name: null, first_name: null, last_name: null }],
			subject,
			htmlTemplate: msg.html,
			textTemplate: msg.text,
			from,
			stream: mail.streams.transactional,
			streamKind: 'transactional',
			trackOpens: false,
			trackLinks: 'None',
			unsubscribe: false
		});
		const ok = r.accepted > 0;
		await db
			.prepare('UPDATE campaigns SET status = ?, recipient_count = ?, error = ? WHERE id = ?')
			.bind(ok ? 'sent' : 'failed', r.accepted, ok ? null : r.firstError, campaign!.id)
			.run();
		return ok ? { ok: true } : { ok: false, error: r.firstError ?? 'Postmark refused the email.' };
	} catch (e) {
		const message = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
		await db.prepare(`UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?`).bind(message, campaign!.id).run();
		return { ok: false, error: message };
	}
}

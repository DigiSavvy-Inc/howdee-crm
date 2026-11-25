// #639: invitations, password reset and email verification — the emailed single-use links.
//
// - A token is 32 random bytes (base64url, 43 chars). It exists only in the emailed link; the
//   database keeps its SHA-256 hex (`account_tokens.token_hash`, unique). Looked up by hash, then
//   compared again in constant time. Single use (`used_at`, claimed with a conditional UPDATE),
//   expiring: invite 7 days, reset 1 hour, verify 24 hours. Issuing a token of a kind cancels
//   the older unused ones of that kind for the same user or address.
// - Rate limits ride on `login_attempts` (see `RATE_LIMITS`). Request-type rows (a reset asked
//   for, an invite sent) are written with `ok = 2` so they never count toward the sign-in
//   lockout; a bad token link is `ok = 0`, a guess, so it does. Addresses are stored hashed.
// - Emails go out on the transactional stream through `sendCampaignEmail`, no tracking, no
//   unsubscribe footer; the stored campaign copy has the link redacted.
// - Never log a token, a link or a password. `account_token_events` keeps kind, user id, time
//   and outcome only.

import { safeEqual } from './auth';
import { sha256Hex } from './api-keys';
import { b64urlEncode } from './token';
import { credentialStamp, hashPassword, passwordPolicyError } from './password';
import { sendCampaignEmail } from './send';
import { credentialError, mailSetup } from './mail';
import { ACCOUNT_MAIL_KIND } from './system-mail';
import { emailDocument } from './email';
import { getSettings } from './settings';
import { getBranding } from './branding';
import { publicBaseUrl } from './public-url';
import { firstAdminUsername, validateFirstAdmin, type FirstAdminErrors } from './setup';
import {
	emailInUse,
	findUserByVerifiedEmail,
	getUserById,
	markEmailVerified,
	setUserPassword,
	type SessionUser,
	type UserRole
} from './users';
import { isEmail } from '$lib/csv';

export type TokenKind = 'invite' | 'reset' | 'verify';

const HOUR = 60 * 60 * 1000;
export const TOKEN_TTL_MS: Record<TokenKind, number> = {
	invite: 7 * 24 * HOUR,
	reset: HOUR,
	verify: 24 * HOUR
};

/** The public path each kind's link opens (`<base><path>/<token>`). */
export const TOKEN_PATH: Record<TokenKind, string> = { invite: '/invite', reset: '/reset', verify: '/verify' };

/** The sentence `/reset` always answers with, whether or not the address is a user's. */
export const RESET_SENT_MESSAGE =
	'If that address belongs to an account with a verified email, a reset link is on its way. It works for one hour.';

/** Minimum time a reset request takes, so a known and an unknown address look the same. */
export const RESET_MIN_MS = 400;

export const RATE_LIMITS = {
	/** Reset requests: per address and per IP, within the window. */
	reset: { perKey: 3, perIp: 10, minutes: 60 },
	/** Invites sent: per invited address and per IP (the admin's), within the window. */
	invite: { perKey: 5, perIp: 30, minutes: 60 },
	/** "Send a new link" for email verification, per address and per IP. */
	verify: { perKey: 3, perIp: 10, minutes: 60 },
	/** Failed token-link opens (unknown / used / expired) per IP. */
	open: { perIp: 20, minutes: 15 }
} as const;

/** `login_attempts.ok` for a request that isn't a guess (never counts toward the sign-in lockout). */
const RATE_ROW = 2;

export type AccountEnv = {
	POSTMARK_TOKEN?: string;
	POSTMARK_FROM?: string;
	POSTMARK_STREAM_TX?: string;
	SESSION_SECRET?: string;
	PUBLIC_BASE_URL?: string;
};

export type SendOpts = {
	/** The public origin for links; defaults to `publicBaseUrl`. */
	baseUrl?: string;
	/** Test seam — defaults to `sendCampaignEmail`. */
	deliver?: typeof sendCampaignEmail;
};

// ── Tokens ───────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD HH:MM:SS' UTC — compares with SQLite's datetime('now'). */
export function sqlTime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlTime(s: string): number {
	return Date.parse(s.replace(' ', 'T') + 'Z');
}

/** 32 random bytes, base64url. */
export function newToken(): string {
	const b = new Uint8Array(32);
	crypto.getRandomValues(b);
	return b64urlEncode(b);
}

export function hashToken(token: string): Promise<string> {
	return sha256Hex(token);
}

export type TokenRow = {
	id: number;
	user_id: number | null;
	email: string;
	kind: TokenKind;
	token_hash: string;
	role: UserRole | null;
	created_by: number | null;
	created_at: string;
	expires_at: string;
	used_at: string | null;
	cancelled_at: string | null;
};

/**
 * Store a new token and return the plaintext (for the link only). Older unused tokens of this
 * kind for the same user or address are cancelled first.
 */
export async function issueToken(
	db: D1Database,
	input: { kind: TokenKind; email: string; userId?: number | null; role?: UserRole | null; createdBy?: number | null; now?: number }
): Promise<{ id: number; token: string; expiresAt: string }> {
	const now = input.now ?? Date.now();
	const email = input.email.trim().toLowerCase();
	const userId = input.userId ?? null;
	await db
		.prepare(
			`UPDATE account_tokens SET cancelled_at = ?
			 WHERE kind = ? AND used_at IS NULL AND cancelled_at IS NULL
			   AND (email = ? OR (? IS NOT NULL AND user_id = ?))`
		)
		.bind(sqlTime(now), input.kind, email, userId, userId)
		.run();
	const token = newToken();
	const expiresAt = sqlTime(now + TOKEN_TTL_MS[input.kind]);
	const row = await db
		.prepare(
			`INSERT INTO account_tokens (user_id, email, kind, token_hash, role, created_by, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			userId,
			email,
			input.kind,
			await hashToken(token),
			input.kind === 'invite' ? (input.role ?? 'member') : null,
			input.createdBy ?? null,
			sqlTime(now),
			expiresAt
		)
		.first<{ id: number }>();
	return { id: row!.id, token, expiresAt };
}

export type PeekResult = { ok: true; row: TokenRow } | { ok: false; reason: 'invalid' | 'used' | 'expired' };

/** Look a token up without using it. */
export async function peekToken(db: D1Database, kind: TokenKind, token: string, now = Date.now()): Promise<PeekResult> {
	const t = (token ?? '').trim();
	// 32 bytes base64url = 43 chars; anything else can't be ours (and skips a needless hash).
	if (!/^[A-Za-z0-9_-]{43}$/.test(t)) return { ok: false, reason: 'invalid' };
	const hash = await hashToken(t);
	const row = await db.prepare(`SELECT * FROM account_tokens WHERE token_hash = ?`).bind(hash).first<TokenRow>();
	if (!row || !safeEqual(row.token_hash, hash) || row.kind !== kind) return { ok: false, reason: 'invalid' };
	if (row.used_at || row.cancelled_at) return { ok: false, reason: 'used' };
	if (!(parseSqlTime(row.expires_at) > now)) return { ok: false, reason: 'expired' };
	return { ok: true, row };
}

/** Mark a token used. False when it was used, cancelled or expired in the meantime. */
export async function claimToken(db: D1Database, id: number, now = Date.now()): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE account_tokens SET used_at = ?
			 WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`
		)
		.bind(sqlTime(now), id, sqlTime(now))
		.run();
	return (res.meta.changes ?? 0) > 0;
}

async function unclaimToken(db: D1Database, id: number): Promise<void> {
	await db.prepare(`UPDATE account_tokens SET used_at = NULL WHERE id = ?`).bind(id).run();
}

/** Audit row: kind, user id, time, outcome — nothing else. Best-effort. */
export async function logTokenEvent(db: D1Database, kind: TokenKind, userId: number | null, outcome: string): Promise<void> {
	try {
		await db
			.prepare(`INSERT INTO account_token_events (kind, user_id, outcome) VALUES (?, ?, ?)`)
			.bind(kind, userId, outcome.slice(0, 40))
			.run();
	} catch {
		// never fail the request over the audit row
	}
}

export const TOKEN_ERRORS: Record<'invalid' | 'used' | 'expired', string> = {
	invalid: "This link isn't valid. Check you copied all of it.",
	used: 'This link was already used or replaced by a newer one.',
	expired: 'This link has expired.'
};

// ── Rate limits (login_attempts) ─────────────────────────────────────────────────────

async function rateKey(action: string, address: string): Promise<string> {
	// Hashed, so the attempts table never holds the address itself.
	return `${action}:${(await sha256Hex(address.trim().toLowerCase())).slice(0, 32)}`;
}

async function countSince(db: D1Database, where: string, binds: (string | number)[], minutes: number): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ${where} AND at > datetime('now', ?)`)
		.bind(...binds, `-${minutes} minutes`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** True when this request (reset / invite) is over its per-address or per-IP limit. */
export async function requestLimited(db: D1Database, action: 'reset' | 'invite' | 'verify', address: string, ip: string): Promise<boolean> {
	const lim = RATE_LIMITS[action];
	const key = await rateKey(action, address);
	const byKey = await countSince(db, 'username = ?', [key], lim.minutes);
	if (byKey >= lim.perKey) return true;
	const byIp = await countSince(db, 'ip = ? AND username LIKE ?', [ip, `${action}:%`], lim.minutes);
	return byIp >= lim.perIp;
}

export async function recordRequest(db: D1Database, action: 'reset' | 'invite' | 'verify', address: string, ip: string): Promise<void> {
	await db
		.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES (?, ?, ?)`)
		.bind(await rateKey(action, address), ip, RATE_ROW)
		.run();
}

/** True when this IP opened too many bad token links recently. */
export async function openLimited(db: D1Database, ip: string): Promise<boolean> {
	const n = await countSince(db, `ip = ? AND username = 'token:open' AND ok = 0`, [ip], RATE_LIMITS.open.minutes);
	return n >= RATE_LIMITS.open.perIp;
}

export async function recordBadOpen(db: D1Database, ip: string): Promise<void> {
	await db.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES ('token:open', ?, 0)`).bind(ip).run();
}

export const OPEN_LIMITED_MESSAGE = 'Too many invalid links from your network. Try again in 15 minutes.';

/**
 * Peek a token for a route: rate-limited per IP, a bad link counted as a guess. The routes use
 * this for both the page load and the form post.
 */
export async function openToken(
	db: D1Database,
	kind: TokenKind,
	token: string,
	ip: string
): Promise<PeekResult | { ok: false; reason: 'limited' }> {
	if (await openLimited(db, ip)) return { ok: false, reason: 'limited' };
	const r = await peekToken(db, kind, token);
	if (!r.ok) await recordBadOpen(db, ip);
	return r;
}

// ── Emails ───────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Subject + paragraphs for each kind. `url` appears in the text and as one link. */
export function accountEmail(
	kind: TokenKind,
	ctx: { appName: string; url: string; inviter?: string | null; role?: UserRole | null }
): { subject: string; html: string; text: string } {
	const app = ctx.appName;
	let subject: string;
	let lines: string[];
	let action: string;
	if (kind === 'invite') {
		subject = `You're invited to ${app}`;
		const who = ctx.inviter ? `${ctx.inviter} invited you` : 'You have been invited';
		lines = [`${who} to ${app} as ${ctx.role === 'admin' ? 'an admin' : 'a member'}.`, 'Open this link to choose your password:'];
		action = 'Accept the invitation';
		lines.push('The link works once and expires in 7 days. If you weren’t expecting this, ignore this email.');
	} else if (kind === 'reset') {
		subject = `Reset your ${app} password`;
		lines = ['Someone asked to reset the password for this address.', 'Open this link to choose a new one:'];
		action = 'Choose a new password';
		lines.push('The link works once and expires in 1 hour. If you didn’t ask for this, ignore this email; your password hasn’t changed.');
	} else {
		subject = `Confirm your email for ${app}`;
		lines = [`Confirm this address for your ${app} account:`];
		action = 'Confirm this address';
		lines.push('The link works once and expires in 24 hours. If you didn’t change your email, tell an admin.');
	}
	const [intro, ...rest] = lines;
	const outro = rest.pop()!;
	const text = [intro, ...rest, ctx.url, outro].join('\n\n');
	const p = (s: string) => `<p>${escapeHtml(s)}</p>`;
	const link = `<p><a href="${escapeHtml(ctx.url)}">${escapeHtml(action)}</a></p><p style="word-break:break-all">${escapeHtml(ctx.url)}</p>`;
	const html = emailDocument([p(intro), ...rest.map(p), link, p(outro)].join('\n'));
	return { subject, html, text };
}

/**
 * Send one account email to `to`. A direct campaign row like the double opt-in mail: transactional
 * stream, no open / link tracking, no unsubscribe footer; the stored copy has the link redacted.
 */
export async function sendAccountEmail(
	db: D1Database,
	env: AccountEnv,
	input: { kind: TokenKind; to: string; token: string; inviter?: string | null; role?: UserRole | null },
	opts: SendOpts = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
	const { provider: mail, creds } = await mailSetup(db, env);
	if (!mail) return { ok: false, error: credentialError(creds) ?? 'Email isn’t set up (POSTMARK_TOKEN).' };
	const from = (await getSettings(db)).default_from?.trim() || env.POSTMARK_FROM || '';
	if (!from) return { ok: false, error: 'No From address (Settings → Default From or POSTMARK_FROM).' };
	const baseUrl = opts.baseUrl ?? (await publicBaseUrl(db, env));
	const url = `${baseUrl}${TOKEN_PATH[input.kind]}/${input.token}`;
	const redacted = `${baseUrl}${TOKEN_PATH[input.kind]}/…`;
	const { appName } = await getBranding(db);
	const msg = accountEmail(input.kind, { appName, url, inviter: input.inviter, role: input.role });
	const hide = (s: string) => s.split(url).join(redacted).split(escapeHtml(url)).join(redacted);
	// #668: marked as account mail, so it stays out of Conversations, the send log, the dashboard,
	// reports, search and the API (`VISIBLE_CAMPAIGN_SQL`).
	const campaign = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, sent_at, system_kind)
			 VALUES (?, ?, ?, ?, NULL, ?, 'sending', datetime('now'), ?) RETURNING id`
		)
		.bind(msg.subject, hide(msg.text), hide(msg.html), hide(msg.text), from, ACCOUNT_MAIL_KIND)
		.first<{ id: number }>();
	const campaignId = campaign!.id;
	let result;
	try {
		result = await (opts.deliver ?? sendCampaignEmail)(db, {
			provider: mail,
			secret: env.SESSION_SECRET || 'unused',
			baseUrl,
			campaignId,
			recipients: [{ id: null, email: input.to, name: null, first_name: null, last_name: null }],
			subject: msg.subject,
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
		// The error text comes from the transport, never from our link.
		const message = hide(e instanceof Error ? e.message : 'send failed').slice(0, 300);
		await db.prepare(`UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?`).bind(message, campaignId).run();
		return { ok: false, error: message };
	}
	const ok = result.accepted > 0;
	// #668: a transport error can echo the message back — never store or return the live link.
	const firstError = result.firstError == null ? null : hide(result.firstError).slice(0, 300);
	await db
		.prepare('UPDATE campaigns SET status = ?, recipient_count = ?, error = ? WHERE id = ?')
		.bind(ok ? 'sent' : 'failed', result.accepted, ok ? null : firstError, campaignId)
		.run();
	return ok ? { ok: true } : { ok: false, error: firstError ?? 'Postmark refused the email.' };
}

// ── Invitations ──────────────────────────────────────────────────────────────────────

export type InviteResult = { ok: true; message: string } | { ok: false; status: number; error: string };

function inviterName(u: SessionUser): string {
	return u.name?.trim() || u.github_login;
}

/** Admin only: invite `email` as `role`. Refuses an address that already belongs to a user. */
export async function sendInvite(
	db: D1Database,
	env: AccountEnv,
	input: { email: string; role: UserRole; actor: SessionUser | null; ip: string },
	opts: SendOpts = {}
): Promise<InviteResult> {
	if (input.actor?.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can invite people.' };
	const email = input.email.trim().toLowerCase();
	if (!email || email.length > 254 || !isEmail(email)) return { ok: false, status: 400, error: "That doesn't look like an email address." };
	const role: UserRole = input.role === 'admin' ? 'admin' : 'member';
	if (await emailInUse(db, email)) return { ok: false, status: 400, error: 'That address already belongs to a user.' };
	if (await requestLimited(db, 'invite', email, input.ip)) {
		return { ok: false, status: 429, error: 'Too many invites sent recently. Try again in an hour.' };
	}
	await recordRequest(db, 'invite', email, input.ip);
	const issued = await issueToken(db, { kind: 'invite', email, role, createdBy: input.actor.id });
	const sent = await sendAccountEmail(db, env, { kind: 'invite', to: email, token: issued.token, inviter: inviterName(input.actor), role }, opts);
	await logTokenEvent(db, 'invite', input.actor.id, sent.ok ? 'sent' : 'send_failed');
	if (!sent.ok) return { ok: false, status: 502, error: `Invite saved but the email failed: ${sent.error} Use Resend.` };
	return { ok: true, message: `Invite sent to ${email}.` };
}

export type PendingInvite = { id: number; email: string; role: UserRole; created_at: string; expires_at: string; expired: boolean; invited_by: string | null };

/** Invites not yet accepted or revoked (expired ones included, flagged). */
export async function listPendingInvites(db: D1Database, now = Date.now()): Promise<PendingInvite[]> {
	const res = await db
		.prepare(
			`SELECT t.id, t.email, t.role, t.created_at, t.expires_at, u.github_login AS invited_by
			 FROM account_tokens t LEFT JOIN users u ON u.id = t.created_by
			 WHERE t.kind = 'invite' AND t.used_at IS NULL AND t.cancelled_at IS NULL
			 ORDER BY t.id DESC LIMIT 200`
		)
		.all<Omit<PendingInvite, 'expired'>>();
	return (res.results ?? []).map((r) => ({ ...r, role: r.role === 'admin' ? 'admin' : 'member', expired: !(parseSqlTime(r.expires_at) > now) }));
}

async function pendingInvite(db: D1Database, id: number): Promise<TokenRow | null> {
	return (
		(await db
			.prepare(`SELECT * FROM account_tokens WHERE id = ? AND kind = 'invite' AND used_at IS NULL AND cancelled_at IS NULL`)
			.bind(id)
			.first<TokenRow>()) ?? null
	);
}

/** Admin only: a fresh link for a pending invite (the old one stops working). */
export async function resendInvite(
	db: D1Database,
	env: AccountEnv,
	input: { id: number; actor: SessionUser | null; ip: string },
	opts: SendOpts = {}
): Promise<InviteResult> {
	if (input.actor?.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can invite people.' };
	const row = await pendingInvite(db, input.id);
	if (!row) return { ok: false, status: 404, error: 'That invite is no longer pending.' };
	if (await emailInUse(db, row.email)) return { ok: false, status: 400, error: 'That address already belongs to a user.' };
	if (await requestLimited(db, 'invite', row.email, input.ip)) {
		return { ok: false, status: 429, error: 'Too many invites sent recently. Try again in an hour.' };
	}
	await recordRequest(db, 'invite', row.email, input.ip);
	const role: UserRole = row.role === 'admin' ? 'admin' : 'member';
	const issued = await issueToken(db, { kind: 'invite', email: row.email, role, createdBy: input.actor.id });
	const sent = await sendAccountEmail(db, env, { kind: 'invite', to: row.email, token: issued.token, inviter: inviterName(input.actor), role }, opts);
	await logTokenEvent(db, 'invite', input.actor.id, sent.ok ? 'resent' : 'send_failed');
	if (!sent.ok) return { ok: false, status: 502, error: `The email failed: ${sent.error}` };
	return { ok: true, message: `Invite sent again to ${row.email}.` };
}

/** Admin only: revoke a pending invite (its link stops working). */
export async function revokeInvite(db: D1Database, input: { id: number; actor: SessionUser | null }): Promise<InviteResult> {
	if (input.actor?.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can invite people.' };
	const res = await db
		.prepare(
			`UPDATE account_tokens SET cancelled_at = ?
			 WHERE id = ? AND kind = 'invite' AND used_at IS NULL AND cancelled_at IS NULL RETURNING email`
		)
		.bind(sqlTime(Date.now()), input.id)
		.first<{ email: string }>();
	if (!res) return { ok: false, status: 404, error: 'That invite is no longer pending.' };
	await logTokenEvent(db, 'invite', input.actor.id, 'revoked');
	return { ok: true, message: `Revoked the invite for ${res.email}.` };
}

export type AcceptInput = { name: string; password: string; confirm: string; githubLogin: string };
export type AcceptResult =
	| { ok: true; userId: number }
	| { ok: false; errors?: FirstAdminErrors; error?: string };

/**
 * Accept an invite: create the user with the invite's address and role, a password, and the
 * email marked verified (they opened the link sent to it). Username = the GitHub login when
 * given, else the email address (same rule as /setup).
 */
export async function acceptInvite(db: D1Database, row: TokenRow, input: AcceptInput): Promise<AcceptResult> {
	const errors = validateFirstAdmin({ ...input, email: row.email });
	if (Object.keys(errors).length) return { ok: false, errors };
	const username = firstAdminUsername({ email: row.email, githubLogin: input.githubLogin });
	if (await emailInUse(db, row.email)) return { ok: false, error: 'An account with this address already exists. Sign in instead.' };
	const taken = await db.prepare(`SELECT id FROM users WHERE github_login = ? OR email = ?`).bind(username, username).first<{ id: number }>();
	if (taken) return { ok: false, errors: { githubLogin: 'That GitHub login is already on the user list.' } };

	if (!(await claimToken(db, row.id))) return { ok: false, error: TOKEN_ERRORS.used };
	const hash = await hashPassword(input.password);
	const role: UserRole = row.role === 'admin' ? 'admin' : 'member';
	let id: number;
	try {
		const res = await db
			.prepare(
				`INSERT INTO users (github_login, name, email, role, password_hash, password_set_at, must_change_password, email_verified_at)
				 VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`
			)
			.bind(username, input.name.trim(), row.email, role, hash, credentialStamp())
			.run();
		id = res.meta.last_row_id as number;
	} catch {
		await unclaimToken(db, row.id);
		return { ok: false, error: 'An account with this address or login already exists.' };
	}
	await db.prepare(`UPDATE account_tokens SET user_id = ? WHERE id = ?`).bind(id, row.id).run();
	await logTokenEvent(db, 'invite', id, 'accepted');
	return { ok: true, userId: id };
}

// ── Password reset ───────────────────────────────────────────────────────────────────

/**
 * Handle a "Forgot password?" request. Always resolves the same way: the caller shows
 * `RESET_SENT_MESSAGE` whatever happened. A link goes out only to an active user's *verified*
 * address, and only under the rate limits. `defer` (the Worker's waitUntil) lets the send run
 * after the response so its duration can't tell a known address from an unknown one.
 */
export async function requestPasswordReset(
	db: D1Database,
	env: AccountEnv,
	input: { email: string; ip: string },
	opts: SendOpts & { defer?: (p: Promise<unknown>) => void } = {}
): Promise<void> {
	const email = input.email.trim().toLowerCase().slice(0, 254);
	if (!email || !isEmail(email)) return;
	if (await requestLimited(db, 'reset', email, input.ip)) return;
	await recordRequest(db, 'reset', email, input.ip);
	const user = await findUserByVerifiedEmail(db, email);
	if (!user) {
		await hashToken(newToken()); // the same work as a real issue, roughly
		await logTokenEvent(db, 'reset', null, 'no_account');
		return;
	}
	const issued = await issueToken(db, { kind: 'reset', email: user.email, userId: user.id });
	const work = sendAccountEmail(db, env, { kind: 'reset', to: user.email, token: issued.token }, opts)
		.then((r) => logTokenEvent(db, 'reset', user.id, r.ok ? 'sent' : 'send_failed'))
		.catch(() => logTokenEvent(db, 'reset', user.id, 'send_failed'));
	if (opts.defer) opts.defer(work);
	else await work;
}

/** `dead` = the link itself can't be used any more (gone, used meanwhile): show the dead-link view (#668). */
export type ResetResult = { ok: true; userId: number } | { ok: false; error: string; dead?: true };

/** Set a new password from a reset link. Stamps password_set_at, so every other session ends. */
export async function completePasswordReset(
	db: D1Database,
	row: TokenRow,
	input: { password: string; confirm: string }
): Promise<ResetResult> {
	const user = row.user_id ? await getUserById(db, row.user_id) : null;
	if (!user || user.disabled_at || (user.email ?? '').toLowerCase() !== row.email.toLowerCase()) {
		return { ok: false, error: TOKEN_ERRORS.invalid, dead: true };
	}
	const policy = passwordPolicyError(input.password, user.github_login);
	if (policy) return { ok: false, error: policy };
	if (input.password !== input.confirm) return { ok: false, error: "The passwords don't match." };
	// Used in another tab between opening the page and saving (#668): the link is dead now.
	if (!(await claimToken(db, row.id))) return { ok: false, error: TOKEN_ERRORS.used, dead: true };
	await setUserPassword(db, user.id, await hashPassword(input.password), false, credentialStamp());
	await logTokenEvent(db, 'reset', user.id, 'completed');
	return { ok: true, userId: user.id };
}

// ── Email verification ───────────────────────────────────────────────────────────────

/** Send a verification link to the user's current (unverified) email. */
export async function sendVerification(
	db: D1Database,
	env: AccountEnv,
	userId: number,
	opts: SendOpts = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
	const user = await getUserById(db, userId);
	if (!user?.email) return { ok: false, error: 'No email address to verify.' };
	if (user.email_verified_at) return { ok: false, error: 'That address is already verified.' };
	const issued = await issueToken(db, { kind: 'verify', email: user.email, userId: user.id });
	const sent = await sendAccountEmail(db, env, { kind: 'verify', to: user.email, token: issued.token }, opts);
	await logTokenEvent(db, 'verify', user.id, sent.ok ? 'sent' : 'send_failed');
	return sent;
}

/** Use a verify link: marks the address verified while it is still the user's email. */
export async function completeVerification(db: D1Database, row: TokenRow): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!row.user_id) return { ok: false, error: TOKEN_ERRORS.invalid };
	const user = await getUserById(db, row.user_id);
	if (!user || (user.email ?? '').toLowerCase() !== row.email.toLowerCase()) {
		return { ok: false, error: 'This link is for an address that is no longer on the account.' };
	}
	if (!(await claimToken(db, row.id))) return { ok: false, error: TOKEN_ERRORS.used };
	await markEmailVerified(db, user.id, row.email);
	await logTokenEvent(db, 'verify', user.id, 'verified');
	return { ok: true };
}

/** Client IP for rate limits: Cloudflare's header, else the adapter's address. */
export function requestIp(event: { request: Request; getClientAddress?: () => string }): string {
	const cf = event.request.headers.get('cf-connecting-ip');
	if (cf) return cf.slice(0, 64);
	try {
		return (event.getClientAddress?.() ?? 'unknown').slice(0, 64);
	} catch {
		return 'unknown';
	}
}

/** Wait until at least `ms` have passed since `start` (equal-time responses). */
export async function padTo(start: number, ms: number): Promise<void> {
	const left = start + ms - Date.now();
	if (left > 0) await new Promise((r) => setTimeout(r, left));
}

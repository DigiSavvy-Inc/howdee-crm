// Gmail (#158) — Google OAuth (web server flow, offline access) + a small Gmail API client
// written against the documented REST shapes (users.getProfile, users.messages.list/get,
// users.history.list). Every call takes a `fetchImpl` so tests drive it with fixtures.
// Tokens are never logged or put in error messages.

import { AUTOMATION_HEADERS } from '$lib/mail-filter';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_STATE_COOKIE = 'google_oauth_state';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GoogleEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };

/** True when both Google OAuth client values are set. */
export function googleConfigured(env: GoogleEnv | undefined): boolean {
	return !!env?.GOOGLE_CLIENT_ID && !!env?.GOOGLE_CLIENT_SECRET;
}

/** Authorize URL — offline access + forced consent so Google always returns a refresh token. */
export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: GMAIL_SCOPE,
		access_type: 'offline',
		prompt: 'consent',
		state
	});
	return `${AUTH_URL}?${params.toString()}`;
}

/** A Gmail / Google OAuth HTTP failure. `status` drives the sync's backoff + fallback logic. */
export class GmailError extends Error {
	constructor(
		public status: number,
		public reason: string
	) {
		super(`Gmail HTTP ${status}${reason ? ` (${reason})` : ''}`);
	}
	/** 429, or a 403 whose reason is a rate limit (Gmail's per-user quota). */
	get rateLimited(): boolean {
		return this.status === 429 || (this.status === 403 && /rate ?limit/i.test(this.reason));
	}
}

async function failure(res: Response): Promise<GmailError> {
	let reason = '';
	try {
		const body = (await res.json()) as {
			error?: string | { status?: string; message?: string; errors?: { reason?: string }[] };
		};
		if (typeof body.error === 'string') reason = body.error;
		else if (body.error) reason = body.error.errors?.[0]?.reason ?? body.error.status ?? '';
	} catch {
		/* non-JSON error body */
	}
	return new GmailError(res.status, reason.slice(0, 80));
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
	const res = await fetchImpl(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams(body).toString()
	});
	if (!res.ok) throw await failure(res);
	return (await res.json()) as TokenResponse;
}

/** Exchange the callback `code`. Throws unless Google returned a refresh token. */
export async function exchangeGoogleCode(
	args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
	fetchImpl: typeof fetch = fetch
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const t = await tokenRequest(
		{
			client_id: args.clientId,
			client_secret: args.clientSecret,
			code: args.code,
			redirect_uri: args.redirectUri,
			grant_type: 'authorization_code'
		},
		fetchImpl
	);
	if (!t.access_token || !t.refresh_token) throw new GmailError(200, 'no_refresh_token');
	return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in ?? 3600 };
}

/** New access token from the refresh token. A 400 `invalid_grant` means access was revoked. */
export async function refreshGoogleToken(
	args: { clientId: string; clientSecret: string; refreshToken: string },
	fetchImpl: typeof fetch = fetch
): Promise<{ accessToken: string; expiresIn: number }> {
	const t = await tokenRequest(
		{
			client_id: args.clientId,
			client_secret: args.clientSecret,
			refresh_token: args.refreshToken,
			grant_type: 'refresh_token'
		},
		fetchImpl
	);
	if (!t.access_token) throw new GmailError(200, 'no_access_token');
	return { accessToken: t.access_token, expiresIn: t.expires_in ?? 3600 };
}

/** Revoke a token at Google (best-effort: returns false instead of throwing). */
export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	try {
		const res = await fetchImpl(REVOKE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token }).toString()
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function api<T>(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<T> {
	const res = await fetchImpl(`${API}${path}`, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
	});
	if (!res.ok) throw await failure(res);
	return (await res.json()) as T;
}

export type GmailProfile = { emailAddress: string; historyId: string };

export function getProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<GmailProfile> {
	return api<GmailProfile>('/profile', accessToken, fetchImpl);
}

export type MessageList = { messages?: { id: string; threadId: string }[]; nextPageToken?: string };

export function listMessages(
	accessToken: string,
	opts: { q: string; pageToken?: string | null; maxResults: number },
	fetchImpl: typeof fetch = fetch
): Promise<MessageList> {
	const p = new URLSearchParams({ q: opts.q, maxResults: String(opts.maxResults) });
	if (opts.pageToken) p.set('pageToken', opts.pageToken);
	return api<MessageList>(`/messages?${p}`, accessToken, fetchImpl);
}

export type HistoryList = {
	history?: { id: string; messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
	nextPageToken?: string;
	historyId: string;
};

/** users.history.list — a 404 here means `startHistoryId` is too old (caller re-lists). */
export function listHistory(
	accessToken: string,
	opts: { startHistoryId: string; pageToken?: string | null; maxResults: number },
	fetchImpl: typeof fetch = fetch
): Promise<HistoryList> {
	const p = new URLSearchParams({
		startHistoryId: opts.startHistoryId,
		historyTypes: 'messageAdded',
		maxResults: String(opts.maxResults)
	});
	if (opts.pageToken) p.set('pageToken', opts.pageToken);
	return api<HistoryList>(`/history?${p}`, accessToken, fetchImpl);
}

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
	mimeType?: string;
	headers?: GmailHeader[];
	body?: { data?: string; size?: number; attachmentId?: string };
	parts?: GmailPart[];
	filename?: string;
};
export type GmailMessage = {
	id: string;
	threadId: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string; // ms since epoch, as a string
	payload?: GmailPart;
};

// #443: plus the headers that mark automated mail (List-Unsubscribe, Precedence, …).
// #585: plus References, so an answer to a message the app holds finds its thread.
export const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', ...AUTOMATION_HEADERS];

export function getMessageMetadata(accessToken: string, id: string, fetchImpl: typeof fetch = fetch): Promise<GmailMessage> {
	const p = new URLSearchParams({ format: 'metadata' });
	for (const h of METADATA_HEADERS) p.append('metadataHeaders', h);
	return api<GmailMessage>(`/messages/${encodeURIComponent(id)}?${p}`, accessToken, fetchImpl);
}

export function getMessageFull(accessToken: string, id: string, fetchImpl: typeof fetch = fetch): Promise<GmailMessage> {
	return api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`, accessToken, fetchImpl);
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────

export function header(msg: GmailMessage, name: string): string | null {
	const n = name.toLowerCase();
	for (const h of msg.payload?.headers ?? []) if (h.name.toLowerCase() === n) return h.value;
	return null;
}

const ADDR_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[^\s<>,;:"'()[\]]+/g;

/**
 * Every address in an address-list header, lowercased (no other normalisation — `+tags`
 * are kept exactly), de-duplicated, in order. Display names are ignored, quoted or not.
 */
export function parseAddresses(value: string | null | undefined): string[] {
	if (!value) return [];
	// Drop quoted display names first: "Doe, Jane <x@y>" must not split on the comma, and
	// a display name that looks like an address isn't a participant.
	const stripped = value.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
	const out: string[] = [];
	for (const m of stripped.match(ADDR_RE) ?? []) {
		const a = m.toLowerCase().replace(/\.+$/, '');
		if (!out.includes(a)) out.push(a);
	}
	return out;
}

/** Display name from a `From` header (`"Jane" <j@x>` → Jane), or null. */
export function displayName(value: string | null | undefined): string | null {
	if (!value) return null;
	const i = value.indexOf('<');
	if (i <= 0) return null;
	const name = value.slice(0, i).trim().replace(/^"|"$/g, '').trim();
	return name || null;
}

/** First `<id>` in a Message-ID / In-Reply-To header, brackets stripped. */
export function bareMessageId(value: string | null | undefined): string | null {
	if (!value) return null;
	const m = value.match(/<([^<>\s]+)>/);
	const id = (m ? m[1] : value.trim().split(/\s+/)[0] ?? '').trim();
	return id ? id.slice(0, 500) : null;
}

/** Gmail internalDate (ms) → UTC 'YYYY-MM-DD HH:MM:SS'. Falls back to the Date header. */
export function messageTime(msg: GmailMessage): string {
	let t = Number(msg.internalDate);
	if (!Number.isFinite(t) || t <= 0) t = Date.parse(header(msg, 'Date') ?? '');
	if (!Number.isFinite(t)) t = Date.now();
	return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function b64urlToText(data: string): string {
	const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function findPart(part: GmailPart | undefined, mime: string): GmailPart | null {
	if (!part) return null;
	if (part.mimeType?.toLowerCase() === mime && part.body?.data && !part.filename) return part;
	for (const p of part.parts ?? []) {
		const hit = findPart(p, mime);
		if (hit) return hit;
	}
	return null;
}

/**
 * Strip what a sandboxed iframe wouldn't run anyway, belt and braces: script/style-ish
 * containers, embedded frames/objects/forms, inline event handlers, javascript: URLs.
 */
export function sanitizeEmailHtml(html: string): string {
	return html
		.replace(/<(script|iframe|object|embed|form|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<(script|iframe|object|embed|form|base|meta|link)\b[^>]*>/gi, '')
		.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
		.replace(/(href|src|action)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

export type MessageBody = { kind: 'text' | 'html'; body: string };

/** The readable body of a `format=full` message: text/plain if present, else sanitised HTML. */
export function extractBody(msg: GmailMessage): MessageBody {
	const text = findPart(msg.payload, 'text/plain');
	if (text?.body?.data) return { kind: 'text', body: b64urlToText(text.body.data) };
	const html = findPart(msg.payload, 'text/html');
	if (html?.body?.data) return { kind: 'html', body: sanitizeEmailHtml(b64urlToText(html.body.data)) };
	return { kind: 'text', body: msg.snippet ?? '' };
}

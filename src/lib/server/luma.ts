// Luma webhook integration (#70). Workers-native (Web Crypto) signature verification +
// payload normalization for inbound Luma guest webhooks.
//
// Luma signs each delivery with `Webhook-Signature: t=<unix-seconds>,v1=<sig>` where the
// signed content is `{t}.{rawBody}` and the key is the `whsec_…` signing secret. The
// published example uses Node's `crypto` + `timingSafeEqual` over a HEX digest; this app
// runs on Cloudflare Workers, so we use `crypto.subtle` instead. We accept the digest in
// either hex or base64 form (and tolerate a `whsec_`-stripped key) so a real delivery
// verifies regardless of which encoding Luma emits — every variant still requires the
// secret, so this widens compatibility without weakening the check. Confirm against the
// first real delivery in the Luma activity log and tighten if needed.

import { safeEqual } from './auth';

const enc = new TextEncoder();

async function hmacBytes(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function toHex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

function toB64(bytes: Uint8Array): string {
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str);
}

/** Parse `t=123,v1=abc,v1=def` → the timestamp + every provided v1 signature. */
export function parseSignatureHeader(header: string): { t: string | null; sigs: string[] } {
	let t: string | null = null;
	const sigs: string[] = [];
	for (const part of header.split(',')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k === 't') t = v;
		else if (k === 'v1') sigs.push(v);
	}
	return { t, sigs };
}

export type VerifyResult = { ok: boolean; reason?: string };

/**
 * Verify a Luma webhook signature + freshness.
 *  - `secret`   the `whsec_…` signing secret (from settings / env).
 *  - `header`   the raw `Webhook-Signature` header value.
 *  - `rawBody`  the request body EXACTLY as received (verify before JSON.parse).
 *  - `nowSec`   current unix seconds (injectable for tests).
 *  - `toleranceSec` max clock skew / age before a timestamp is rejected (replay guard).
 */
export async function verifyLumaSignature(
	secret: string,
	header: string | null | undefined,
	rawBody: string,
	nowSec: number,
	toleranceSec = 300
): Promise<VerifyResult> {
	if (!secret) return { ok: false, reason: 'no signing secret configured' };
	if (!header) return { ok: false, reason: 'missing signature header' };

	const { t, sigs } = parseSignatureHeader(header);
	if (!t || sigs.length === 0) return { ok: false, reason: 'malformed signature header' };

	const ts = Number(t);
	if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid timestamp' };
	if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: 'timestamp out of tolerance' };

	const signed = `${t}.${rawBody}`;
	// Try the secret as-is and with the `whsec_` prefix stripped; compare hex + base64.
	const keys = secret.startsWith('whsec_') ? [secret, secret.slice('whsec_'.length)] : [secret];
	const expected: string[] = [];
	for (const k of keys) {
		const bytes = await hmacBytes(k, signed);
		expected.push(toHex(bytes), toB64(bytes));
	}
	for (const sig of sigs) {
		// Some emitters prefix `v1,<sig>`; normalize that away.
		const s = sig.includes(',') ? sig.slice(sig.indexOf(',') + 1) : sig;
		for (const e of expected) {
			if (safeEqual(s, e)) return { ok: true };
		}
	}
	return { ok: false, reason: 'signature mismatch' };
}

// --- Payload normalization ----------------------------------------------------------
// Luma's UI labels approval state Going / Pending / Not Going; the API carries
// `approval_status`. Map the known values to a stable, mutually-exclusive tag slug.

export type LumaStatus = 'going' | 'pending' | 'not-going';

const STATUS_MAP: Record<string, LumaStatus> = {
	approved: 'going',
	going: 'going',
	checked_in: 'going',
	pending_approval: 'pending',
	pending: 'pending',
	waitlist: 'pending',
	on_waitlist: 'pending',
	invited: 'pending',
	declined: 'not-going',
	rejected: 'not-going',
	not_going: 'not-going',
	cancelled: 'not-going',
	canceled: 'not-going'
};

/** All status tag slugs, so an update can clear the stale ones before applying the new. */
export const STATUS_TAGS: LumaStatus[] = ['going', 'pending', 'not-going'];

export function mapApprovalStatus(status: string | null | undefined): LumaStatus | null {
	if (!status) return null;
	return STATUS_MAP[String(status).trim().toLowerCase()] ?? null;
}

export type NormalizedGuest = {
	email: string;
	name: string;
	first: string;
	last: string;
	status: LumaStatus | null;
	rawStatus: string | null;
	answers: { label: string; answer: string }[];
	eventName: string | null;
};

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
}

/** Flatten a registration answer value (Luma multi-selects can be arrays). */
function answerText(v: unknown): string {
	if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join(', ');
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		return str(o.answer ?? o.value ?? o.label ?? o.name);
	}
	return str(v);
}

/**
 * Pull a normalized guest out of a Luma webhook payload. Luma nests the guest under
 * `data` (sometimes `data.guest`); field names vary by event, so probe a few likely
 * locations and fall back gracefully. The raw payload is always logged, so the operator
 * can confirm shapes against a real delivery and we can tighten this.
 */
export function extractGuest(payload: unknown): NormalizedGuest {
	const root = (payload ?? {}) as Record<string, unknown>;
	const data = (root.data ?? {}) as Record<string, unknown>;
	const guest = ((data.guest as Record<string, unknown>) ?? data) as Record<string, unknown>;
	const user = (guest.user as Record<string, unknown>) ?? {};

	const email = str(guest.email ?? user.email ?? data.email ?? root.email).toLowerCase();
	let first = str(guest.first_name ?? user.first_name ?? data.first_name);
	let last = str(guest.last_name ?? user.last_name ?? data.last_name);
	let name = str(guest.name ?? user.name ?? data.name ?? guest.user_name);
	if (!name && (first || last)) name = [first, last].filter(Boolean).join(' ');
	if (!first && name) {
		const p = name.split(/\s+/);
		first = p[0];
		last = p.slice(1).join(' ');
	}

	const rawStatus = str(guest.approval_status ?? data.approval_status ?? guest.status) || null;

	const answersRaw = (guest.registration_answers ??
		data.registration_answers ??
		guest.event_answers ??
		[]) as unknown;
	const answers: { label: string; answer: string }[] = [];
	if (Array.isArray(answersRaw)) {
		for (const a of answersRaw) {
			const o = (a ?? {}) as Record<string, unknown>;
			const label = str(
				o.label ?? o.question ?? o.question_label ?? (o.registration_question as Record<string, unknown>)?.label
			);
			const answer = answerText(o.answer ?? o.value ?? o.answers ?? o);
			if (label && answer) answers.push({ label, answer });
		}
	}

	const eventObj = (data.event ?? root.event ?? guest.event) as Record<string, unknown> | undefined;
	const eventName = str(eventObj?.name ?? data.event_name ?? root.event_name) || null;

	return { email, name, first, last, status: mapApprovalStatus(rawStatus), rawStatus, answers, eventName };
}

/** A simple slug for tag names derived from free-text (event names, interest answers). */
export function slugifyTag(s: string, max = 40): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max);
}

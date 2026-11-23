// Forms (#620): the per-form webhook. On every accepted submission (added / updated /
// anonymous — never spam, rejected or invalid) the form's `settings.notify_webhook` gets a JSON
// POST signed with `X-DSV-Signature`. Fire and forget: the submit route hands the promise to
// `waitUntil`, so the visitor never waits on it, and nothing here runs on the heartbeat.
//
// Signing key: never the raw SESSION_SECRET (a receiver would need it). Each form gets its own
// key derived from it — HMAC-SHA256(SESSION_SECRET, "form-webhook:<form id>"), hex, prefixed
// `fwh_` — shown to admins on the form's Settings tab. Rotating SESSION_SECRET rotates every key.
// Header: `X-DSV-Signature: t=<unix>,v1=<hex HMAC-SHA256(key, "<t>.<raw body>")>` (Luma style,
// same as the assistant jobs' header).

import type { Answers } from '$lib/forms';
import { webhookUrlProblem } from '$lib/webhook-url';
import { signatureHeader } from './ai/jobs-webhook';
import { hmac } from './token';
import { USER_AGENT } from './user-agent';

export const FORM_WEBHOOK_HEADER = 'X-DSV-Signature';
export const FORM_WEBHOOK_TIMEOUT_MS = 5000;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The form's signing key, derived from SESSION_SECRET. '' when the secret isn't set. */
export async function formWebhookSecret(sessionSecret: string | undefined, formId: number): Promise<string> {
	const secret = (sessionSecret ?? '').trim();
	if (!secret) return '';
	return `fwh_${hex(await hmac(secret, `form-webhook:${formId}`)).slice(0, 48)}`;
}

export type FormWebhookPayload = {
	form: { id: number; name: string; slug: string };
	submission_id: number;
	contact_id: number | null;
	email: string | null;
	answers: Answers;
	submitted_at: string;
	page_url: string | null;
};

/** The page the form was submitted from — http(s) only, query kept, capped. */
export function pageUrl(referrer: string | null | undefined): string | null {
	if (!referrer) return null;
	try {
		const u = new URL(referrer);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		u.username = '';
		u.password = '';
		return u.toString().slice(0, 2000);
	} catch {
		return null;
	}
}

export type FormWebhookResult = { ok: boolean; status: number | null; error: string | null };

/** POST the payload once (no retry, redirects not followed). Never throws. */
export async function deliverFormWebhook(
	url: string,
	payload: FormWebhookPayload,
	signingKey: string,
	opts: { fetch?: typeof fetch; now?: Date } = {}
): Promise<FormWebhookResult> {
	const problem = webhookUrlProblem(url);
	if (problem) return { ok: false, status: null, error: problem };
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': USER_AGENT };
	if (signingKey) headers[FORM_WEBHOOK_HEADER] = await signatureHeader(signingKey, body, Math.floor((opts.now ?? new Date()).getTime() / 1000));
	try {
		const res = await (opts.fetch ?? fetch)(url, {
			method: 'POST',
			headers,
			body,
			redirect: 'manual',
			signal: AbortSignal.timeout(FORM_WEBHOOK_TIMEOUT_MS)
		});
		await res.body?.cancel().catch(() => {});
		const ok = res.status >= 200 && res.status < 300;
		return { ok, status: res.status, error: ok ? null : `answered ${res.status}` };
	} catch (e) {
		const name = e instanceof Error ? e.name : '';
		return { ok: false, status: null, error: name === 'TimeoutError' || name === 'AbortError' ? 'timed out (5 s)' : 'unreachable' };
	}
}

/** Deliver, and on failure append "webhook failed: …" to the submission's `detail` (≤ 300). */
export async function sendFormWebhook(
	db: D1Database,
	url: string,
	payload: FormWebhookPayload,
	signingKey: string,
	opts: { fetch?: typeof fetch; now?: Date } = {}
): Promise<FormWebhookResult> {
	const r = await deliverFormWebhook(url, payload, signingKey, opts);
	if (!r.ok) {
		const note = `webhook failed: ${r.error ?? 'error'}`;
		try {
			await db
				.prepare(
					`UPDATE form_submissions
					 SET detail = substr(CASE WHEN detail IS NULL OR detail = '' THEN ? ELSE detail || '; ' || ? END, 1, 300)
					 WHERE id = ?`
				)
				.bind(note, note, payload.submission_id)
				.run();
		} catch (e) {
			console.error('form webhook detail write failed:', e);
		}
	}
	return r;
}

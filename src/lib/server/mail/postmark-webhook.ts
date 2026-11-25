// #731: the setup wizard's "Create the webhook" button. Written for the public app from Postmark's
// public webhook API (`GET /webhooks`, `POST /webhooks`, `PUT /webhooks/{id}`), not taken from any
// hosted tooling. With the server token saved, it lists the broadcast stream's webhooks and:
//   - one points at this install's /api/webhook with its key, on the install's address → present;
//   - one has our path and key on another host (an old address) → reported as pointing elsewhere,
//     and only `update: true` (the wizard's Update button) moves it here (PUT, Url only);
//   - none is ours → `create` adds one with a trigger for each event the app ingests.
// It reports the stream and its unsubscribe handling (#373). It never sends mail, and every text
// it returns has the token and the key replaced with dots (`scrubSecrets`).
//
// Only Postmark's REST API is called here (fetch); the low-level send client in `../postmark.ts`
// stays imported by `./postmark.ts` alone.

import { checkUnsubscribeHandling } from '../domain-auth';
import { webhookTarget } from './postmark';

const PM_API = 'https://api.postmarkapp.com';
const PM_TIMEOUT_MS = 8_000;

/**
 * Postmark webhook event names the app's `/api/webhook` handler reads (its RecordType map):
 * opens, clicks, deliveries, bounces, spam complaints and subscription changes. Keep in step with
 * `src/routes/api/webhook/+server.ts`.
 */
export const INGESTED_WEBHOOK_EVENTS = ['Open', 'Click', 'Delivery', 'Bounce', 'SpamComplaint', 'SubscriptionChange'] as const;

export type IngestedWebhookEvent = (typeof INGESTED_WEBHOOK_EVENTS)[number];

/** The `Triggers` object of a new webhook: each event in `events` switched on, nothing else set
 *  (Postmark's defaults apply to the per-event options). */
export function webhookTriggersFor(events: readonly IngestedWebhookEvent[] = INGESTED_WEBHOOK_EVENTS): Record<IngestedWebhookEvent, { Enabled: true }> {
	const out = {} as Record<IngestedWebhookEvent, { Enabled: true }>;
	for (const name of events) out[name] = { Enabled: true };
	return out;
}

/** The spellings a secret can take in a URL or a form body: raw, percent-encoded with upper- and
 *  lower-case hex, and the form encoding (`+` for a space, also URLSearchParams' own escapes). */
function secretForms(s: string): string[] {
	const lowerHex = (v: string) => v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
	const pct = encodeURIComponent(s);
	const form = new URLSearchParams({ v: s }).toString().slice(2);
	const forms = [s, pct, lowerHex(pct), pct.replace(/%20/g, '+'), lowerHex(pct.replace(/%20/g, '+')), form, lowerHex(form)];
	// Longest first, so a shorter spelling never leaves part of a longer one behind.
	return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each secret (raw and URL-encoded, see `secretForms`) with dots. A
 *  value shorter than 6 characters can't be a real token or key and would only mangle ordinary
 *  words, so it's skipped. Scrub before any truncation (`pmMessage`), never after. */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
	let out = text;
	for (const raw of secrets) {
		const s = (raw ?? '').trim();
		if (s.length < 6) continue;
		for (const form of secretForms(s)) out = out.split(form).join('••••');
	}
	return out;
}

export type UnsubscribeStatus = { status: 'pass' | 'warn' | 'unknown'; summary: string };

/** What happened to the webhook: created now, already here, moved here (updated), pointing at
 *  another address of this install (elsewhere), none yet (absent), or not checked (no stream). */
export type WebhookState = 'created' | 'present' | 'updated' | 'elsewhere' | 'absent' | 'no_stream';

export type WebhookSetup =
	| {
			ok: true;
			state: WebhookState;
			/** True when this call created the webhook. */
			created: boolean;
			/** A webhook to this install's address exists now. */
			present: boolean;
			/** The host an existing webhook of this install points at instead (state `elsewhere`). */
			elsewhere: string | null;
			stream: string;
			/** The broadcast stream answered 200. */
			streamOk: boolean;
			streamDetail: string;
			unsubscribe: UnsubscribeStatus;
	  }
	| { ok: false; error: string };

type Read = { status: number; body: unknown; error?: string };

async function pmRequest(fetchFn: typeof fetch, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Read> {
	try {
		const res = await fetchFn(`${PM_API}${path}`, {
			method: init.method ?? 'GET',
			headers: {
				Accept: 'application/json',
				...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
				'X-Postmark-Server-Token': token
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			signal: AbortSignal.timeout(PM_TIMEOUT_MS)
		});
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		return { status: res.status, body };
	} catch (e) {
		return { status: 0, body: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
	}
}

const rejected = (r: Read) => r.status === 401 || r.status === 403;
const httpText = (r: Read) => (r.status === 0 ? 'no answer' : `HTTP ${r.status}`);

/** Postmark's error message, scrubbed of `secrets` first and only then cut to 200 characters, so a
 *  secret straddling the cut can't leave its start behind. */
export function pmMessage(body: unknown, secrets: (string | null | undefined)[]): string {
	const m = (body as { Message?: unknown } | null)?.Message;
	return typeof m === 'string' ? scrubSecrets(m, secrets).slice(0, 200) : '';
}

/** Where the webhook must point: `<origin>/api/webhook?key=<key>`. */
export function webhookUrlFor(baseUrl: string, key: string): string {
	return `${new URL(baseUrl).origin}/api/webhook?key=${encodeURIComponent(key)}`;
}

type Cfg = {
	token: string;
	broadcast: string;
	transactional?: string;
	webhookKey: string;
	baseUrl: string;
	/** false = only report. Default true. */
	create?: boolean;
	/** true = move a webhook of this install that points at another host to `baseUrl` (PUT). */
	update?: boolean;
};

/**
 * Make sure the broadcast stream has a webhook to `<baseUrl>/api/webhook?key=<webhookKey>`.
 * `baseUrl` must be the app's https address. No text in the result carries the token or the key.
 */
export async function ensurePostmarkWebhook(cfg: Cfg, fetchFn: typeof fetch = fetch): Promise<WebhookSetup> {
	const res = await runWebhookSetup(cfg, fetchFn);
	const secrets = [cfg.token, cfg.webhookKey];
	if (!res.ok) return { ok: false, error: scrubSecrets(res.error, secrets) };
	return {
		...res,
		streamDetail: scrubSecrets(res.streamDetail, secrets),
		unsubscribe: { ...res.unsubscribe, summary: scrubSecrets(res.unsubscribe.summary, secrets) }
	};
}

async function runWebhookSetup(cfg: Cfg, fetchFn: typeof fetch): Promise<WebhookSetup> {
	const token = cfg.token.trim();
	const key = cfg.webhookKey.trim();
	const stream = (cfg.broadcast || 'broadcast').trim();
	const tx = (cfg.transactional || 'outbound').trim();
	if (!token) return { ok: false, error: 'Save the Postmark server token first.' };
	if (!key) {
		return {
			ok: false,
			error: 'WEBHOOK_KEY is not set, so the webhook would answer 401. Run `npx wrangler secret put WEBHOOK_KEY` (the deploy sets it on a new install), then try again.'
		};
	}
	if (stream === tx) return { ok: false, error: `The broadcast stream is "${stream}", the transactional one. Fix the stream names in Settings → Sending first.` };
	let base: URL;
	try {
		base = new URL(cfg.baseUrl);
	} catch {
		return { ok: false, error: "The app's address isn't known yet. Set it in Settings → Domain." };
	}
	if (base.protocol !== 'https:' || base.hostname.endsWith('.invalid')) {
		return {
			ok: false,
			error: `Postmark can only call an https address, and this app's address is ${base.origin}. Open the app at its public https address, or set Settings → Domain.`
		};
	}

	const [s, hooks] = await Promise.all([
		pmRequest(fetchFn, token, `/message-streams/${encodeURIComponent(stream)}`),
		pmRequest(fetchFn, token, `/webhooks?MessageStream=${encodeURIComponent(stream)}`)
	]);
	if (rejected(s) || rejected(hooks)) return { ok: false, error: 'Postmark rejected the token. Use the Server API token (Postmark → Servers → your server → API Tokens).' };
	if (s.status === 0 && hooks.status === 0) return { ok: false, error: `Couldn't reach Postmark: ${s.error ?? 'no answer'}.` };

	const streamOk = s.status === 200;
	const unsubscribe: UnsubscribeStatus = streamOk
		? (({ status, summary }) => ({ status: status === 'pass' || status === 'warn' ? status : 'unknown', summary }))(
				checkUnsubscribeHandling(stream, { ok: true, body: s.body })
			)
		: { status: 'unknown', summary: `Not checked: the "${stream}" stream couldn't be read.` };
	const base_ = { stream, streamOk, unsubscribe, elsewhere: null as string | null };
	if (!streamOk) {
		const streamDetail =
			s.status === 404 || s.status === 422
				? `Postmark has no "${stream}" stream. Create a Broadcasts stream with that ID (Servers → your server → Message Streams), or change the name in Settings → Sending. No webhook was created.`
				: `Couldn't read the "${stream}" stream (${httpText(s)}). No webhook was created.`;
		return { ok: true, state: 'no_stream', created: false, present: false, streamDetail, ...base_ };
	}
	const streamDetail = `The "${stream}" stream exists.`;

	if (hooks.status !== 200) return { ok: false, error: `Couldn't list the webhooks (${httpText(hooks)}). Try again.` };
	type Hook = { ID?: unknown; Url?: unknown };
	const list = ((hooks.body as { Webhooks?: Hook[] } | null)?.Webhooks ?? []) as Hook[];
	const targetUrl = webhookUrlFor(base.origin, key);
	if (list.some((h) => webhookTarget(h?.Url, key, base.origin) === 'here')) {
		return { ok: true, state: 'present', created: false, present: true, streamDetail, ...base_ };
	}

	// Ours, but on another host (the install moved, or was set up on another address).
	const old = list.find((h) => webhookTarget(h?.Url, key, base.origin) === 'elsewhere');
	if (old) {
		const oldHost = (() => {
			try {
				return new URL(String(old.Url)).host;
			} catch {
				return '';
			}
		})();
		if (!cfg.update) return { ok: true, state: 'elsewhere', created: false, present: false, streamDetail, ...base_, elsewhere: oldHost };
		const id = Number(old.ID);
		if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Postmark didn't say which webhook that is. Update it in Postmark instead." };
		const put = await pmRequest(fetchFn, token, `/webhooks/${id}`, { method: 'PUT', body: { Url: targetUrl } });
		if (put.status === 0) return { ok: false, error: `Couldn't reach Postmark: ${put.error ?? 'no answer'}.` };
		if (put.status < 200 || put.status >= 300) {
			const msg = pmMessage(put.body, [cfg.token, cfg.webhookKey]);
			return { ok: false, error: `Postmark refused the update (HTTP ${put.status})${msg ? `: ${msg}` : '.'}` };
		}
		return { ok: true, state: 'updated', created: false, present: true, streamDetail, ...base_, elsewhere: oldHost };
	}

	if (cfg.create === false) return { ok: true, state: 'absent', created: false, present: false, streamDetail, ...base_ };

	const made = await pmRequest(fetchFn, token, '/webhooks', {
		method: 'POST',
		body: { Url: targetUrl, MessageStream: stream, Triggers: webhookTriggersFor() }
	});
	if (made.status === 0) return { ok: false, error: `Couldn't reach Postmark: ${made.error ?? 'no answer'}.` };
	if (made.status < 200 || made.status >= 300) {
		const msg = pmMessage(made.body, [cfg.token, cfg.webhookKey]);
		return { ok: false, error: `Postmark refused the webhook (HTTP ${made.status})${msg ? `: ${msg}` : '.'}` };
	}
	return { ok: true, state: 'created', created: true, present: true, streamDetail, ...base_ };
}

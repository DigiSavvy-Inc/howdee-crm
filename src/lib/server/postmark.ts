// Minimal Postmark API client (batch send + suppressions).

const API = 'https://api.postmarkapp.com';
const BATCH_LIMIT = 500;

export type PostmarkMessage = {
	From: string;
	To: string;
	ReplyTo?: string;
	Bcc?: string;
	Subject: string;
	Headers?: { Name: string; Value: string }[];
	HtmlBody: string;
	TextBody: string;
	MessageStream: string;
	TrackOpens?: boolean;
	TrackLinks?: 'None' | 'HtmlAndText' | 'HtmlOnly' | 'TextOnly';
};

export type PostmarkResult = {
	ErrorCode: number;
	Message: string;
	MessageID?: string;
	To?: string;
	SubmittedAt?: string;
	/** #536: set by us, not Postmark — the request itself failed (network error, timeout,
	 *  unreadable body), so whether Postmark took the message is unknown. */
	Transport?: boolean;
};

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** #536: every Postmark call gets a deadline, so a hung connection can't eat the Worker's budget. */
export const POSTMARK_TIMEOUT_MS = 30_000;
export const POSTMARK_BATCH_LIMIT = BATCH_LIMIT;

/** fetch with a timeout (AbortSignal). Throws on timeout like any network error. */
export function postmarkFetch(url: string, init: RequestInit = {}, timeoutMs = POSTMARK_TIMEOUT_MS): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Send ONE chunk (≤ 500) via Postmark's batch endpoint. Never throws (#536): a thrown fetch, a
 * timeout, a non-2xx answer or an unreadable 200 body marks every message in the chunk failed
 * (`Transport: true` when we can't tell whether Postmark took it — network error, timeout,
 * bad body). Returns results in the same order as input.
 */
export async function sendBatchChunk(token: string, part: PostmarkMessage[]): Promise<PostmarkResult[]> {
	if (!part.length) return [];
	const failAll = (code: number, message: string, transport = false): PostmarkResult[] =>
		part.map(() => (transport ? { ErrorCode: code, Message: message, Transport: true } : { ErrorCode: code, Message: message }));
	let res: Response;
	let text: string;
	try {
		res = await postmarkFetch(`${API}/email/batch`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'X-Postmark-Server-Token': token
			},
			body: JSON.stringify(part)
		});
		text = await res.text();
	} catch (e) {
		const err = e as { name?: string; message?: string } | null;
		const why = err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? e);
		return failAll(-1, `Postmark request failed: ${why}`.slice(0, 300), true);
	}
	if (!res.ok) {
		// Whole-batch failure (e.g. auth/stream error): mark every message in this chunk failed.
		let message = `Postmark error ${res.status}`;
		try {
			const j = JSON.parse(text);
			message = j.Message ?? j.message ?? message;
		} catch {
			// Non-JSON body (e.g. an edge/WAF error page): keep a snippet so the real reason isn't lost.
			const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
			if (snippet) message = `${message}: ${snippet}`;
		}
		return failAll(res.status || -1, message);
	}
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (!Array.isArray(parsed) || parsed.length !== part.length) return failAll(-1, 'Unreadable Postmark response', true);
	return parsed.map((r): PostmarkResult =>
		r && typeof r === 'object' && typeof (r as PostmarkResult).ErrorCode === 'number'
			? (r as PostmarkResult)
			: { ErrorCode: -1, Message: 'Unreadable Postmark result', Transport: true }
	);
}

/** Send messages via Postmark's batch endpoint, 500 per request. Returns results in the same
 *  order as input. Never throws — a failed chunk comes back as error results (#536). */
export async function sendBatch(
	token: string,
	messages: PostmarkMessage[]
): Promise<PostmarkResult[]> {
	const results: PostmarkResult[] = [];
	for (const part of chunk(messages, BATCH_LIMIT)) results.push(...(await sendBatchChunk(token, part)));
	return results;
}

/** Add an address to a broadcast stream's suppression list (server-side unsubscribe). */
export async function suppress(
	token: string,
	stream: string,
	email: string
): Promise<{ ok: boolean; message?: string }> {
	const res = await postmarkFetch(`${API}/message-streams/${encodeURIComponent(stream)}/suppressions`, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-Postmark-Server-Token': token
		},
		body: JSON.stringify({ Suppressions: [{ EmailAddress: email }] })
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, message: text || `Postmark error ${res.status}` };
	}
	return { ok: true };
}

/** Reactivate an address on a stream (#374: the contact resubscribed themselves). Postmark
 *  only deletes manual suppressions; bounces and spam complaints stay. */
export async function unsuppress(
	token: string,
	stream: string,
	email: string
): Promise<{ ok: boolean; message?: string }> {
	const res = await postmarkFetch(`${API}/message-streams/${encodeURIComponent(stream)}/suppressions/delete`, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-Postmark-Server-Token': token
		},
		body: JSON.stringify({ Suppressions: [{ EmailAddress: email }] })
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, message: text || `Postmark error ${res.status}` };
	}
	return { ok: true };
}

const SUPPRESS_BATCH = 50; // Postmark's per-request limit for the suppressions endpoint

/**
 * Suppress many addresses on a stream (#279, bulk unsubscribe): 50 per request, keeps going
 * when a request or an address fails, and returns how many were suppressed / failed.
 */
export async function suppressMany(
	token: string,
	stream: string,
	emails: string[]
): Promise<{ suppressed: number; failed: number }> {
	let suppressed = 0;
	let failed = 0;
	for (const part of chunk(emails, SUPPRESS_BATCH)) {
		try {
			const res = await postmarkFetch(`${API}/message-streams/${encodeURIComponent(stream)}/suppressions`, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					'X-Postmark-Server-Token': token
				},
				body: JSON.stringify({ Suppressions: part.map((EmailAddress) => ({ EmailAddress })) })
			});
			if (!res.ok) {
				failed += part.length;
				continue;
			}
			const body = (await res.json().catch(() => null)) as { Suppressions?: { Status?: string }[] } | null;
			const rows = body?.Suppressions;
			const bad = Array.isArray(rows) ? rows.filter((r) => r?.Status === 'Failed').length : 0;
			failed += bad;
			suppressed += part.length - bad;
		} catch {
			failed += part.length;
		}
	}
	return { suppressed, failed };
}

export type PostmarkSuppression = {
	EmailAddress: string;
	SuppressionReason: string; // HardBounce | SpamComplaint | ManualSuppression
	Origin?: string;
	CreatedAt?: string;
};

/**
 * Every suppression on a stream (#285): `GET /message-streams/{stream}/suppressions/dump`.
 * Never throws — a network error or a non-2xx answer comes back as `ok: false`.
 */
export async function suppressionDump(
	token: string,
	stream: string
): Promise<{ ok: true; suppressions: PostmarkSuppression[] } | { ok: false; message: string }> {
	try {
		const res = await postmarkFetch(`${API}/message-streams/${encodeURIComponent(stream)}/suppressions/dump`, {
			headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token }
		});
		if (!res.ok) return { ok: false, message: `Postmark error ${res.status}` };
		const body = (await res.json().catch(() => null)) as { Suppressions?: unknown } | null;
		if (!body || !Array.isArray(body.Suppressions)) return { ok: false, message: 'Unreadable Postmark response' };
		const rows = body.Suppressions as PostmarkSuppression[];
		return { ok: true, suppressions: rows.filter((s) => typeof s?.EmailAddress === 'string' && s.EmailAddress.trim() !== '') };
	} catch (e) {
		return { ok: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
	}
}

/** The broadcast stream and the transactional one (default `outbound`), deduped. */
export function suppressionStreams(stream?: string, txStream?: string): string[] {
	return [...new Set([stream, txStream || 'outbound'].map((s) => (s ?? '').trim()).filter(Boolean))];
}

export type SuppressionMap = Map<string, { reason: string; stream: string }>;

/** A bounce or spam-complaint suppression — one an operator must not resubscribe over. */
export function isHardSuppression(reason: string): boolean {
	return reason === 'HardBounce' || reason === 'SpamComplaint';
}

/**
 * The dumps of several streams in one map, keyed by lowercased email (the first stream that
 * lists an address wins, unless a later one has a bounce / spam reason for it).
 * `errors` = one line per stream that couldn't be read.
 */
export async function suppressionsByEmail(
	token: string,
	streams: string[]
): Promise<{ map: SuppressionMap; errors: string[]; read: number }> {
	const map: SuppressionMap = new Map();
	const errors: string[] = [];
	let read = 0;
	for (const stream of streams) {
		const dump = await suppressionDump(token, stream);
		if (!dump.ok) {
			errors.push(`${stream}: ${dump.message}`);
			continue;
		}
		read++;
		for (const s of dump.suppressions) {
			const email = s.EmailAddress.trim().toLowerCase();
			const reason = String(s.SuppressionReason || 'Unknown');
			const seen = map.get(email);
			if (!seen || (!isHardSuppression(seen.reason) && isHardSuppression(reason))) map.set(email, { reason, stream });
		}
	}
	return { map, errors, read };
}

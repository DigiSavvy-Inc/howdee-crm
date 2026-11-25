import { describe, expect, it } from 'vitest';
import { resendProvider, type OutboundMessage } from '../src/lib/server/mail';
import { RESEND_REJECTED_KEY_ERROR, RESEND_SPLIT_LIMIT_ERROR, RESEND_SPLIT_MAX_CALLS, isRecipientRefusal } from '../src/lib/server/mail/resend';
import * as fx from './fixtures/resend-702';

// #745: Resend refuses a whole batch when one message in it fails validation. When the refusal is
// about a recipient address, the adapter splits that batch in halves, breadth first, and sends each
// again, down to single messages, so only the refused message fails. A bad key or a shared field
// fails the call once. Nothing here touches the network: fetch is injected.

type Call = { key: string; to: string[] };

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const msg = (to: string): OutboundMessage => ({
	from: 'News <news@ourco.example>',
	to,
	subject: 'Hi',
	html: '<p>Hi</p>',
	text: 'Hi',
	stream: 'broadcast'
});

const list = (n: number, bad: number[] = []) => Array.from({ length: n }, (_, i) => msg(bad.includes(i) ? `bad-${i}` : `r${i}@ourco.example`));

/** Resend's batch rules, faked: any address without `@` refuses the whole call (400
 *  validation_error); otherwise one id per message, `rs-<address>`. `before` may answer first. */
function fakeResend(before?: (c: Call, calls: Call[]) => Response | null) {
	const calls: Call[] = [];
	const fn = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		const body = JSON.parse(String(init.body)) as { to: string[] }[];
		const call: Call = { key: headers.get('idempotency-key') ?? '', to: body.map((e) => e.to[0]) };
		calls.push(call);
		const early = before?.(call, calls);
		if (early) return early;
		if (call.to.some((t) => !t.includes('@'))) return jsonRes(fx.errorBatchValidation, 400);
		return jsonRes({ data: call.to.map((t) => ({ id: `rs-${t}` })) });
	}) as typeof fetch;
	return { fn, calls };
}

/** The `to` of every call Resend accepted (a 200), in order. */
const acceptedTo = (calls: Call[], statuses: number[]) => calls.flatMap((c, i) => (statuses[i] === 200 ? c.to : []));

/** Wrap a fake so the status of every answer is kept next to its call. */
function recording(f: ReturnType<typeof fakeResend>) {
	const statuses: number[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await f.fn(input, init);
		statuses.push(res.status);
		return res;
	}) as typeof fetch;
	return { fn, calls: f.calls, statuses };
}

const provider = (fetchFn: typeof fetch) =>
	resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: fetchFn, sleep: async () => {} });

describe('Resend: a batch refused for one message is split so the others still go out', () => {
	it('one bad address among 100: 99 sent with ids on the right rows, 1 permanent error with Resend’s message', async () => {
		const f = fakeResend();
		const messages = list(100, [37]);
		const res = await provider(f.fn).sendBatch(messages);
		expect(res).toHaveLength(100);
		res.forEach((r, i) => {
			if (i === 37) {
				expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
				expect(!r.ok && r.error).toContain('Invalid `to` field');
			} else {
				expect(r).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
			}
		});
		// One halving per level: at most 2 × ⌈log2 100⌉ + 1 calls.
		expect(f.calls.length).toBeLessThanOrEqual(15);
		// Each message is accepted exactly once.
		const accepted = f.calls.filter((c) => c.to.every((t) => t.includes('@'))).flatMap((c) => c.to);
		expect(accepted).toHaveLength(99);
		expect(new Set(accepted).size).toBe(99);
	});

	it('two bad addresses: only those two fail', async () => {
		const f = fakeResend();
		const messages = list(10, [2, 7]);
		const res = await provider(f.fn).sendBatch(messages);
		res.forEach((r, i) => {
			if (i === 2 || i === 7) expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
			else expect(r).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
		});
		expect(f.calls.length).toBeLessThanOrEqual(RESEND_SPLIT_MAX_CALLS);
	});

	it('every address bad: the call limit stops the splitting; the rest fail, not permanently, nothing sent', async () => {
		const f = fakeResend();
		const res = await provider(f.fn).sendBatch(Array.from({ length: 100 }, (_, i) => msg(`bad-${i}`)));
		expect(res).toHaveLength(100);
		expect(f.calls).toHaveLength(RESEND_SPLIT_MAX_CALLS);
		expect(res.some((r) => r.ok)).toBe(false);
		const limited = res.filter((r) => !r.ok && r.error === RESEND_SPLIT_LIMIT_ERROR);
		expect(limited.length).toBeGreaterThan(0);
		for (const r of limited) expect(r).toMatchObject({ ok: false, permanent: false });
		for (const r of res.filter((r) => !r.ok && r.error !== RESEND_SPLIT_LIMIT_ERROR)) {
			expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
		}
		expect(res.every((r) => !r.ok && !r.transport)).toBe(true);
	});

	it('a 429 inside a half is retried with that half’s own key, then the half is split as usual', async () => {
		let limited = false;
		const f = fakeResend((c) => {
			if (!limited && c.to.length === 50 && c.to[0] === 'r50@ourco.example') {
				limited = true;
				return jsonRes(fx.errorRateLimit, 429, { 'retry-after': '1' });
			}
			return null;
		});
		const messages = list(100, [80]);
		const res = await provider(f.fn).sendBatch(messages);
		res.forEach((r, i) => {
			if (i === 80) expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
			else expect(r).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
		});
		const half = f.calls.filter((c) => c.to.length === 50 && c.to[0] === 'r50@ourco.example');
		expect(half).toHaveLength(2);
		expect(half[0].key).toBe(half[1].key);
	});

	it('part keys come from the batch key and the slice: stable on a retry, never shared between parts', async () => {
		let failedOnce = false;
		const f = fakeResend((c, calls) => {
			// The first try of the first quarter answers 500 once; its retry must reuse the key.
			if (!failedOnce && calls.length > 1 && c.to.length === 25 && c.to[0] === 'r0@ourco.example') {
				failedOnce = true;
				return jsonRes({ name: 'internal_server_error', message: 'Try again' }, 500);
			}
			return null;
		});
		await provider(f.fn).sendBatch(list(100, [10]));
		const top = f.calls[0].key;
		expect(top).toMatch(/^crm-batch-/);
		const bySlice = new Map<string, Set<string>>();
		for (const c of f.calls) {
			const slice = `${c.to[0]}|${c.to.length}`;
			if (!bySlice.has(slice)) bySlice.set(slice, new Set());
			bySlice.get(slice)!.add(c.key);
		}
		// Every slice used exactly one key (the 500 retry included), and no two slices share one.
		for (const keys of bySlice.values()) expect(keys.size).toBe(1);
		const keys = [...bySlice.values()].map((k) => [...k][0]);
		expect(new Set(keys).size).toBe(keys.length);
		// Parts carry `<batch key>-<start>-<end>`.
		for (const k of keys) if (k !== top) expect(k).toMatch(new RegExp(`^${top}-\\d+-\\d+$`));
		expect(keys).toContain(`${top}-0-25`);
	});

	it('a batch that timed out or met a 409 is never split', async () => {
		const t = { calls: 0 };
		const timeout = (async () => {
			t.calls++;
			throw new Error('The operation was aborted due to timeout');
		}) as typeof fetch;
		const res = await provider(timeout).sendBatch(list(4));
		expect(t.calls).toBe(3); // the retries of one call, no parts
		for (const r of res) expect(r).toMatchObject({ ok: false, permanent: false, transport: true });

		const f = fakeResend((_c, calls) =>
			calls.length === 1 ? jsonRes({ name: 'concurrent_idempotent_requests', message: 'Same key in progress' }, 409) : null
		);
		const after409 = await provider(f.fn).sendBatch(list(4, [1]));
		// The 409, then the refusal on the retry: the earlier try's fate is unknown, so no parts.
		expect(f.calls).toHaveLength(2);
		expect(f.calls.every((c) => c.to.length === 4)).toBe(true);
		expect(after409.every((r) => !r.ok)).toBe(true);
	});

	it('two bad addresses among 100 in different halves: 98 sent with ids on the right rows, 2 permanent, within the cap', async () => {
		const f = recording(fakeResend());
		const messages = list(100, [10, 80]);
		const res = await provider(f.fn).sendBatch(messages);
		expect(res).toHaveLength(100);
		res.forEach((r, i) => {
			if (i === 10 || i === 80) expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
			else expect(r).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
		});
		// 1 + 2 + 4 per level for the 6 levels after the first halving.
		expect(f.calls.length).toBe(27);
		expect(f.calls.length).toBeLessThanOrEqual(RESEND_SPLIT_MAX_CALLS);
		const accepted = acceptedTo(f.calls, f.statuses);
		expect(accepted).toHaveLength(98);
		expect(new Set(accepted).size).toBe(98);
	});

	it('breadth first: every part of a level is sent before any part is split again', async () => {
		const f = fakeResend();
		await provider(f.fn).sendBatch(list(100, [10, 80]));
		const sizes = f.calls.map((c) => c.to.length);
		// Never a bigger part after a smaller one.
		for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1] + 1);
		expect(sizes.slice(0, 7)).toEqual([100, 50, 50, 25, 25, 25, 25]);
	});

	it('three bad addresses among 100: everything outside a still-refused part is sent, the rest get the limit error', async () => {
		const f = recording(fakeResend());
		const bad = [10, 40, 80];
		const messages = list(100, bad);
		const res = await provider(f.fn).sendBatch(messages);
		expect(f.calls.length).toBe(RESEND_SPLIT_MAX_CALLS);
		const limited = res.flatMap((r, i) => (!r.ok && r.error === RESEND_SPLIT_LIMIT_ERROR ? [i] : []));
		// The cap is reached on the last level (single messages): the parts of it not sent by then.
		expect(limited).toEqual([11, 79, 80]);
		for (const i of limited) {
			expect(res[i]).toMatchObject({ ok: false, permanent: false });
			expect(bad.some((b) => Math.abs(b - i) <= 1)).toBe(true);
		}
		res.forEach((r, i) => {
			if (limited.includes(i)) return;
			if (bad.includes(i)) expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
			else expect(r).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
		});
		const accepted = acceptedTo(f.calls, f.statuses);
		expect(accepted).toHaveLength(95);
		expect(new Set(accepted).size).toBe(95);
	});

	it('a 5xx part is not split and keeps its retryable error; the rest of the level is still sent', async () => {
		const f = recording(
			fakeResend((c) => (c.to.length === 50 && c.to[0] === 'r0@ourco.example' ? jsonRes({ name: 'internal_server_error', message: 'Try again' }, 500) : null))
		);
		const messages = list(100, [10, 80]);
		const res = await provider(f.fn).sendBatch(messages);
		// The first half: three tries, never split; its rows say 500, not permanent.
		expect(f.calls.filter((c) => c.to[0] === 'r0@ourco.example' && c.to.length === 50)).toHaveLength(3);
		const firstHalf = new Set(messages.slice(0, 50).map((m) => m.to));
		expect(f.calls.some((c) => c.to.length < 50 && c.to.some((t) => firstHalf.has(t)))).toBe(false);
		for (let i = 0; i < 50; i++) expect(res[i]).toMatchObject({ ok: false, permanent: false, code: 500, transport: true });
		// The second half still went down to its bad address.
		for (let i = 50; i < 100; i++) {
			if (i === 80) expect(res[i]).toMatchObject({ ok: false, permanent: true, code: 400 });
			else expect(res[i]).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
		}
		const accepted = acceptedTo(f.calls, f.statuses);
		expect(new Set(accepted).size).toBe(accepted.length);
	});

	it('a 500 or a dropped request first, then a recipient refusal on the retry with the same key: split, nothing sent twice', async () => {
		for (const first of ['500', 'abort'] as const) {
			let failed = false;
			const f = recording(
				fakeResend(() => {
					if (failed) return null;
					failed = true;
					if (first === 'abort') throw new Error('The operation was aborted due to timeout');
					return jsonRes({ name: 'internal_server_error', message: 'Try again' }, 500);
				})
			);
			const messages = list(100, [37]);
			const res = await provider(f.fn).sendBatch(messages);
			// The aborted try never reached Resend's answer, so the fake recorded the call but no status.
			const statuses = first === 'abort' ? [0, ...f.statuses] : f.statuses;
			expect(f.calls[0].to).toHaveLength(100);
			expect(f.calls[1].to).toHaveLength(100);
			expect(f.calls[1].key).toBe(f.calls[0].key);
			expect(statuses[1]).toBe(400);
			expect(f.calls.length).toBeGreaterThan(2); // split after the refusal
			res.forEach((r, i) => {
				if (i === 37) expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
				else expect(r).toMatchObject({ ok: true, messageId: `rs-${messages[i].to}` });
			});
			const accepted = acceptedTo(f.calls, statuses);
			expect(accepted).toHaveLength(99);
			expect(new Set(accepted).size).toBe(99);
		}
	});
});

describe('Resend: refusals that are not about a recipient are never split', () => {
	it('a bad key (400 validation_error "API key is invalid") on 100: one call, a rejected-key error, not permanent', async () => {
		const f = fakeResend(() => jsonRes(fx.errorInvalidKeyValidation, 400));
		const res = await provider(f.fn).sendBatch(list(100, [5]));
		expect(f.calls).toHaveLength(1);
		expect(res).toHaveLength(100);
		for (const r of res) {
			expect(r).toMatchObject({ ok: false, permanent: false, code: 400 });
			expect(!r.ok && r.error).toContain(RESEND_REJECTED_KEY_ERROR);
			expect(!r.ok && r.error).not.toContain(fx.FAKE_RESEND_KEY);
		}
	});

	it('a bad key whose message echoes the key: the key is scrubbed from the rows', async () => {
		const f = fakeResend(() => jsonRes({ ...fx.errorInvalidKeyValidation, message: `API key is invalid: ${fx.FAKE_RESEND_KEY}` }, 400));
		const res = await provider(f.fn).sendBatch(list(3));
		expect(f.calls).toHaveLength(1);
		for (const r of res) expect(!r.ok && r.error).not.toContain(fx.FAKE_RESEND_KEY);
	});

	it('an invalid `from` (422 or 400): one call, every row fails permanently as before', async () => {
		const a = fakeResend(() => jsonRes(fx.errorInvalidParameter, 422));
		const resA = await provider(a.fn).sendBatch(list(100));
		expect(a.calls).toHaveLength(1);
		for (const r of resA) expect(r).toMatchObject({ ok: false, permanent: true, code: 422 });

		const b = fakeResend(() => jsonRes({ statusCode: 400, name: 'validation_error', message: 'Invalid `from` field. The email address needs to follow the `email@example.com` format.' }, 400));
		const resB = await provider(b.fn).sendBatch(list(100));
		expect(b.calls).toHaveLength(1);
		for (const r of resB) expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
	});

	it('a missing field, a bad attachment, header or tag, or an unreadable message: one call each', async () => {
		const answers = [
			jsonRes({ statusCode: 422, name: 'missing_required_field', message: 'Missing `to` field.' }, 422),
			jsonRes({ statusCode: 422, name: 'invalid_attachment', message: 'Attachment must have either a `content` or `path`.' }, 422),
			jsonRes({ statusCode: 422, name: 'invalid_parameter', message: 'Invalid `headers` field.' }, 422),
			jsonRes({ statusCode: 422, name: 'validation_error', message: 'The `tags` field is invalid.' }, 422),
			jsonRes({ name: 'validation_error' }, 400),
			new Response('not json', { status: 400 })
		];
		for (const answer of answers) {
			const f = fakeResend(() => answer.clone());
			const res = await provider(f.fn).sendBatch(list(10, [3]));
			expect(f.calls).toHaveLength(1);
			for (const r of res) expect(r.ok).toBe(false);
		}
	});
});

describe('isRecipientRefusal', () => {
	it('is true for Resend’s wording about a recipient field', () => {
		expect(isRecipientRefusal(fx.errorBatchValidation.message)).toBe(true);
		expect(isRecipientRefusal('The `to` field must contain at least 1 recipient.')).toBe(true);
		expect(isRecipientRefusal('Invalid `cc` field.')).toBe(true);
		expect(isRecipientRefusal('Invalid `BCC` field.')).toBe(true);
		expect(isRecipientRefusal('Invalid `reply_to` field.')).toBe(true);
		expect(isRecipientRefusal("Invalid 'to' field.")).toBe(true);
		expect(isRecipientRefusal('The "reply_to" field is invalid.')).toBe(true);
		expect(isRecipientRefusal('invalid to field')).toBe(true);
	});

	it('is false for a shared field, a missing field, a bad key or an unreadable message', () => {
		expect(isRecipientRefusal(fx.errorInvalidParameter.message)).toBe(false);
		expect(isRecipientRefusal('Invalid `from` field. The email address needs to follow the `email@example.com` format.')).toBe(false);
		expect(isRecipientRefusal(fx.errorInvalidKeyValidation.message)).toBe(false);
		expect(isRecipientRefusal('Missing `to` field.')).toBe(false);
		expect(isRecipientRefusal('Invalid `headers` field.')).toBe(false);
		expect(isRecipientRefusal('The `tags` field is invalid.')).toBe(false);
		expect(isRecipientRefusal('Invalid `subject` field.')).toBe(false);
		expect(isRecipientRefusal('')).toBe(false);
		expect(isRecipientRefusal(undefined)).toBe(false);
		expect(isRecipientRefusal(null)).toBe(false);
		expect(isRecipientRefusal(42)).toBe(false);
	});
});

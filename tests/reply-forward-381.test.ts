import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { stripTrailingQuoteIntro } from '../src/lib/email-text';
import {
	buildReplyForward,
	formatAddress,
	forwardSenderAddress,
	forwardSubject,
	sendReplyForward,
	threadingHeaders
} from '../src/lib/server/reply-forward';
import { POST as inbound } from '../src/routes/api/inbound/+server';
import { clearDomainCache } from '../src/lib/server/public-url';

const db = (env as any).DB as D1Database;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

describe('stripTrailingQuoteIntro (#381)', () => {
	it.each([
		['EN', 'Sounds good.\n\nOn Wed, Oct 21, 2026 at 10:00 AM Sam <owner@example.com> wrote:'],
		['ES', 'Gracias!\n\nEl mié, 21 oct 2026 a la(s) 10:00 a.m., <owner@example.com> escribió:'],
		['FR', 'Merci.\nLe mer. 21 oct. 2026 à 10:00, Sam <owner@example.com> a écrit :'],
		['DE', 'Danke.\n\nAm Mi., 21. Okt. 2026 um 10:00 Uhr schrieb Sam <owner@example.com>:'],
		['Outlook', 'Thanks.\n\n-----Original Message-----\n\n']
	])('drops a dangling %s intro line', (_lang, input) => {
		const out = stripTrailingQuoteIntro(input);
		expect(out).not.toMatch(/wrote|escribió|écrit|schrieb|Original Message/);
		expect(out.length).toBeGreaterThan(0);
	});

	it('handles an intro wrapped over two lines and trailing > markers', () => {
		expect(stripTrailingQuoteIntro('Yes.\n\nOn Wed, Oct 21, 2026, Sam <owner@example.com>\nwrote:\n>\n')).toBe('Yes.');
	});

	it('leaves normal text alone', () => {
		const t = 'On Monday I will call you.\nThe report was written: great.\nThanks';
		expect(stripTrailingQuoteIntro(t)).toBe(t);
		const mid = 'On Wed Sam wrote:\nsomething still follows';
		expect(stripTrailingQuoteIntro(mid)).toBe(mid);
		expect(stripTrailingQuoteIntro('Am I late? Let me know.')).toBe('Am I late? Let me know.');
	});
});

describe('forward helpers (#381)', () => {
	it('quotes and escapes display names', () => {
		expect(formatAddress('Rivera, Jordan via Acme CRM', 'a@x.example.net')).toBe(
			'"Rivera, Jordan via Acme CRM" <a@x.example.net>'
		);
		expect(formatAddress('Bob "The" \\Builder', 'a@x.example.net')).toBe('"Bob \\"The\\" \\\\Builder" <a@x.example.net>');
		expect(formatAddress('Evil\r\nBcc: x@y.z', 'a@x.example.net')).toBe('"Evil Bcc: x@y.z" <a@x.example.net>');
		expect(formatAddress('', 'a@x.example.net')).toBe('a@x.example.net');
		const enc = formatAddress('José Núñez', 'a@x.example.net');
		expect(enc).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@x\.example\.net>$/);
		const b64 = enc.slice(10, enc.indexOf('?= '));
		expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe('José Núñez');
	});

	it('picks INBOUND_FORWARD_FROM, then REVIEW_FROM, then POSTMARK_FROM', () => {
		expect(forwardSenderAddress({ INBOUND_FORWARD_FROM: 'crm@x.example.net', REVIEW_FROM: 'r@x.example.net', POSTMARK_FROM: 'p@x.example.net' })).toBe('crm@x.example.net');
		expect(forwardSenderAddress({ INBOUND_FORWARD_FROM: '', REVIEW_FROM: 'r@x.example.net', POSTMARK_FROM: 'p@x.example.net' })).toBe('r@x.example.net');
		expect(forwardSenderAddress({ POSTMARK_FROM: 'p@x.example.net' })).toBe('p@x.example.net');
	});

	it('only accepts a sender on the POSTMARK_FROM domain (case-insensitive exact match)', () => {
		expect(
			forwardSenderAddress({ INBOUND_FORWARD_FROM: 'user@gmail.com', REVIEW_FROM: 'r@x.example.net', POSTMARK_FROM: 'p@x.example.net' })
		).toBe('r@x.example.net');
		expect(forwardSenderAddress({ INBOUND_FORWARD_FROM: 'crm@X.EXAMPLE.NET', POSTMARK_FROM: 'p@x.example.net' })).toBe('crm@X.EXAMPLE.NET');
		// Subdomains and look-alikes don't match.
		expect(
			forwardSenderAddress({ INBOUND_FORWARD_FROM: 'crm@mail.x.example.net', REVIEW_FROM: 'r@evilx.example.net', POSTMARK_FROM: 'p@x.example.net' })
		).toBe('p@x.example.net');
		// No usable POSTMARK_FROM → no verified domain → nothing passes.
		expect(forwardSenderAddress({ INBOUND_FORWARD_FROM: 'crm@x.example.net', REVIEW_FROM: 'r@x.example.net' })).toBe('');
		expect(forwardSenderAddress({ INBOUND_FORWARD_FROM: 'crm@x.example.net', POSTMARK_FROM: 'not-an-email' })).toBe('');
	});

	it('subject is Re: <original> without doubling', () => {
		expect(forwardSubject('Hello')).toBe('Re: Hello');
		expect(forwardSubject('Re: Hello')).toBe('Re: Hello');
		expect(forwardSubject('RE: re: Fwd: Hello')).toBe('Re: Hello');
		expect(forwardSubject('')).toBe('Re: (no subject)');
	});

	it('threading headers only when the parent is known', () => {
		expect(threadingHeaders(null, 'CA1@mail.gmail.com')).toEqual([]);
		expect(threadingHeaders('pm-1', 'CA1@mail.gmail.com')).toEqual([
			{ Name: 'In-Reply-To', Value: '<pm-1@mtasv.net>' },
			{ Name: 'References', Value: '<pm-1@mtasv.net> <CA1@mail.gmail.com>' }
		]);
	});

	it('builds a forward from the CRM sender with the contact as Reply-To', () => {
		const m = buildReplyForward({
			senderAddress: 'assistant@example.com',
			to: 'owner@example.com',
			stream: 'outbound',
			contactEmail: 'jordan@example.org',
			contactName: 'Jordan Rivera',
			subject: 'Re: Hello',
			text: 'Gracias!\n\nEl mié, 21 oct 2026 a la(s) 10:00 a.m., <owner@example.com> escribió:',
			crmUrl: 'https://crm.test/conversations/c1-c5',
			appName: 'Acme CRM'
		});
		expect(m.From).toBe('"Jordan Rivera via Acme CRM" <assistant@example.com>');
		expect(m.ReplyTo).toBe('"Jordan Rivera" <jordan@example.org>');
		expect(m.Subject).toBe('Re: Hello');
		expect(m.TextBody).toBe(
			'Gracias!\n\n— Reply from Jordan Rivera <jordan@example.org> · View in CRM: https://crm.test/conversations/c1-c5'
		);
		expect(m.HtmlBody).not.toContain('escribió');
		expect(m.Headers).toBeUndefined();
	});

	it('falls back to the fallback sender when the dedicated one is refused', async () => {
		const calls: string[] = [];
		const send = (async (_t: string, msgs: any[]) => {
			calls.push(msgs[0].From);
			return calls.length === 1
				? [{ ErrorCode: 400, Message: "The 'From' address you supplied (crm@x.example.net) is not a Sender Signature" }]
				: [{ ErrorCode: 0, Message: 'OK', MessageID: 'm1' }];
		}) as any;
		const r = await sendReplyForward(
			't',
			{ From: '"Ann via Acme CRM" <crm@x.example.net>', To: 'a@x.example.net', Subject: 's', HtmlBody: '', TextBody: '', MessageStream: 'outbound' },
			'crm@x.example.net',
			'owner@x.example.net',
			send
		);
		expect(r).toEqual({ ok: true, fallbackUsed: true, error: null, messageId: 'm1' });
		expect(calls).toEqual(['"Ann via Acme CRM" <crm@x.example.net>', '"Ann via Acme CRM" <owner@x.example.net>']);
	});

	it('never retries from a fallback on another domain', async () => {
		const calls: string[] = [];
		const send = (async (_t: string, msgs: any[]) => {
			calls.push(msgs[0].From);
			return [{ ErrorCode: 400, Message: 'not a Sender Signature' }];
		}) as any;
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const r = await sendReplyForward(
			't',
			{ From: '"Ann via Acme CRM" <crm@x.example.net>', To: 'a@x.example.net', Subject: 's', HtmlBody: '', TextBody: '', MessageStream: 'outbound' },
			'crm@x.example.net',
			'owner@other.example.net',
			send
		);
		spy.mockRestore();
		expect(r.ok).toBe(false);
		expect(r.fallbackUsed).toBe(false);
		expect(calls).toEqual(['"Ann via Acme CRM" <crm@x.example.net>']);
	});
});

describe('POST /api/inbound forward (#381)', () => {
	const original = globalThis.fetch;
	let sent: any[] = [];
	let refuse: string | null = null;
	let ann: number;
	let camp: number;

	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM events'),
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM replies'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare('DELETE FROM contacts'),
			db.prepare("DELETE FROM app_state WHERE key IN ('inbound_forward_to', 'custom_domain', 'app_name')"),
			db.prepare("INSERT INTO app_state (key, value) VALUES ('app_name', 'Acme CRM')")
		]);
		clearDomainCache();
		sent = [];
		refuse = null;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/email/batch')) {
				const batch = JSON.parse(String(init?.body));
				sent.push(batch[0]);
				if (refuse && batch[0].From.includes(refuse)) {
					return new Response(JSON.stringify([{ ErrorCode: 400, Message: `The 'From' address you supplied (${refuse}) is not a Sender Signature on your account.` }]), { status: 200 });
				}
				return new Response(JSON.stringify([{ ErrorCode: 0, Message: 'OK', MessageID: 'fwd-1' }]), { status: 200 });
			}
			return new Response('not found', { status: 404 });
		}) as typeof fetch;

		ann = await id("INSERT INTO contacts (email, first_name) VALUES ('jo@example.org', 'Jordan') RETURNING id");
		camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('Hello, there', 'm', 'h', 'owner@example.com', 'sent', '2026-10-20 10:00:00') RETURNING id"
		);
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'jo@example.org', 'pm-1', 'accepted')")
			.bind(camp, ann)
			.run();
	});

	afterEach(() => {
		globalThis.fetch = original;
	});

	async function post(extraEnv: Record<string, string> = {}, body: Record<string, unknown> = {}) {
		return inbound({
			url: new URL('https://app.test/api/inbound?key=k'),
			request: new Request('https://app.test/api/inbound', {
				method: 'POST',
				body: JSON.stringify({
					FromFull: { Email: 'jo@example.org', Name: 'Rivera, "Jo"' },
					Subject: 'Re: Hello, there',
					MailboxHash: `c${camp}r${ann}`,
					TextBody: 'Gracias!\n\nEl mié, 21 oct 2026 a la(s) 10:00 a.m., <owner@example.com> escribió:',
					Headers: [{ Name: 'Message-ID', Value: '<CA9@mail.gmail.com>' }],
					...body
				})
			}),
			platform: {
				env: {
					DB: db,
					INBOUND_KEY: 'k',
					POSTMARK_TOKEN: 'tok',
					POSTMARK_STREAM_TX: 'outbound',
					POSTMARK_FROM: 'owner@example.com',
					INBOUND_FORWARD_TO: 'owner@example.com',
					REVIEW_FROM: 'assistant@example.com',
					PUBLIC_BASE_URL: 'https://crm.test',
					...extraEnv
				}
			}
		} as any);
	}

	it('sends from "<Contact> via <app name>" (Settings → Branding), Reply-To the contact, threaded, footer link', async () => {
		const res = await post();
		expect(res.status).toBe(200);
		expect(sent).toHaveLength(1);
		const m = sent[0];
		expect(m.From).toBe('"Rivera, \\"Jo\\" via Acme CRM" <assistant@example.com>');
		expect(m.From).not.toContain('jo@example.org');
		expect(m.To).toBe('owner@example.com');
		expect(m.ReplyTo).toBe('"Rivera, \\"Jo\\"" <jo@example.org>');
		expect(m.Subject).toBe('Re: Hello, there');
		expect(m.Headers).toEqual([
			{ Name: 'In-Reply-To', Value: '<pm-1@mtasv.net>' },
			{ Name: 'References', Value: '<pm-1@mtasv.net> <CA9@mail.gmail.com>' }
		]);
		expect(m.TextBody).not.toContain('escribió');
		expect(m.TextBody).toMatch(new RegExp(`View in CRM: https://crm\\.test/conversations/c${ann}-`));
	});

	it('prefers INBOUND_FORWARD_FROM', async () => {
		await post({ INBOUND_FORWARD_FROM: 'crm@example.com' });
		expect(sent[0].From).toMatch(/<crm@example\.com>$/);
	});

	it('skips an off-domain INBOUND_FORWARD_FROM in favour of REVIEW_FROM', async () => {
		await post({ INBOUND_FORWARD_FROM: 'user@gmail.com' });
		expect(sent).toHaveLength(1);
		expect(sent[0].From).toMatch(/<assistant@example\.com>$/);
	});

	it('all candidates off-domain → no send and an error logged', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await post({
				INBOUND_FORWARD_FROM: 'user@gmail.com',
				REVIEW_FROM: 'assistant@other.example.net',
				POSTMARK_FROM: 'not-an-email'
			});
			expect(res.status).toBe(200);
			expect(sent).toHaveLength(0);
			const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
			expect(logged).toMatch(/inbound forward skipped: no sender on the verified sending domain/);
			expect(logged).not.toContain('tok');
		} finally {
			spy.mockRestore();
		}
		// The reply is still captured.
		const row = await db.prepare('SELECT COUNT(*) AS n FROM replies').first<{ n: number }>();
		expect(row!.n).toBe(1);
	});

	it('never uses the forward-to inbox as From (no forwardList fallback)', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			// Forward-to inbox on another domain, no candidate on the sending domain.
			await post({
				INBOUND_FORWARD_TO: 'someone@gmail.com',
				INBOUND_FORWARD_FROM: 'crm@outside.example.net',
				REVIEW_FROM: 'review@outside.example.net',
				POSTMARK_FROM: ''
			});
			expect(sent).toHaveLength(0);
			// With a valid sending domain, From is the domain sender, never the inbox.
			await post({ INBOUND_FORWARD_TO: 'someone@gmail.com', REVIEW_FROM: 'review@outside.example.net' });
		} finally {
			spy.mockRestore();
		}
		expect(sent).toHaveLength(1);
		expect(sent[0].To).toBe('someone@gmail.com');
		expect(sent[0].From).toMatch(/<owner@example\.com>$/);
		expect(sent[0].From).not.toContain('someone@gmail.com');
	});

	it('falls back to POSTMARK_FROM when the dedicated sender is refused', async () => {
		refuse = 'assistant@example.com';
		const res = await post();
		expect(res.status).toBe(200);
		expect(sent).toHaveLength(2);
		expect(sent[1].From).toBe('"Rivera, \\"Jo\\" via Acme CRM" <owner@example.com>');
		expect(sent[1].ReplyTo).toBe(sent[0].ReplyTo);
	});

	it('an unknown sender links the CRM inbox and skips threading headers', async () => {
		await post({}, { FromFull: { Email: 'stranger@x.example.net' }, MailboxHash: '', Subject: 'Question', Headers: [] });
		const m = sent[0];
		expect(m.From).toBe('"stranger@x.example.net via Acme CRM" <assistant@example.com>');
		expect(m.ReplyTo).toBe('stranger@x.example.net');
		expect(m.Subject).toBe('Re: Question');
		expect(m.Headers).toBeUndefined();
		expect(m.TextBody).toContain('View in CRM: https://crm.test/conversations');
	});

	it("records the forward's Postmark MessageID on the reply (#585)", async () => {
		await post();
		expect(await db.prepare('SELECT forward_message_id FROM replies').first('forward_message_id')).toBe('fwd-1');
	});

	it('ignores mail from an internal sender instead of storing it as a contact reply (#585)', async () => {
		const uid = await id("INSERT INTO users (github_login, role, email) VALUES ('fwd-585', 'member', 'pat@ourteam.example') RETURNING id");
		try {
			const res = await post({}, { FromFull: { Email: 'pat@ourteam.example', Name: 'Pat' }, MailboxHash: '' });
			expect(await res.json()).toEqual({ ignored: 'internal' });
			expect(await db.prepare('SELECT COUNT(*) AS n FROM replies').first('n')).toBe(0);
			expect(sent).toHaveLength(0);
		} finally {
			await db.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
		}
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { readReplyTag, replyTagAddress, signReplyTag, MAX_LOCAL_PART } from '../src/lib/server/reply-tag';
import { sendCampaignEmail } from '../src/lib/server/send';
import { POST as inbound } from '../src/routes/api/inbound/+server';
import { clearDomainCache } from '../src/lib/server/public-url';

const db = (env as any).DB as D1Database;
const SECRET = 'test-session-secret';

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contacts')
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reply tag (#743)', () => {
	it('signs with lowercase letters and digits only and reads back', async () => {
		const tag = await signReplyTag(SECRET, 12, 345);
		expect(tag).toMatch(/^c12r345s[a-z2-7]{12}$/);
		expect(await readReplyTag(SECRET, tag)).toEqual({ kind: 'signed', campaignId: 12, contactId: 345 });
		// Case changes on the way back are fine.
		expect(await readReplyTag(SECRET, tag.toUpperCase())).toEqual({ kind: 'signed', campaignId: 12, contactId: 345 });
	});

	it('refuses a tag whose ids were changed', async () => {
		const tag = await signReplyTag(SECRET, 12, 345);
		const sig = tag.replace(/^c\d+r\d+s/, '');
		expect(await readReplyTag(SECRET, `c12r346s${sig}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `c13r345s${sig}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag('other-secret', tag)).toEqual({ kind: 'none' });
		expect(await readReplyTag('', tag)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c12r345s' + 'a'.repeat(12))).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c12r345sabc')).toEqual({ kind: 'none' });
	});

	it('reads the older unsigned form as legacy and anything else as none', async () => {
		expect(await readReplyTag(SECRET, 'c7r9')).toEqual({ kind: 'legacy', campaignId: 7, contactId: 9 });
		expect(await readReplyTag(SECRET, '')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'b42')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, null)).toEqual({ kind: 'none' });
	});

	it('refuses an id longer than 15 digits', async () => {
		const long = 1234567890123456; // 16 digits
		expect(await readReplyTag(SECRET, await signReplyTag(SECRET, long, 1))).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, await signReplyTag(SECRET, 1, long))).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `c${long}r1`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `c1r${long}`)).toEqual({ kind: 'none' });
		// 15 digits is still fine.
		expect(await readReplyTag(SECRET, 'c123456789012345r1')).toEqual({ kind: 'legacy', campaignId: 123456789012345, contactId: 1 });
	});

	it('refuses ids with leading zeros, signed or legacy; a bare 0 is canonical', async () => {
		const sig = (await signReplyTag(SECRET, 12, 345)).replace(/^c\d+r\d+s/, '');
		expect(await readReplyTag(SECRET, `c012r0345s${sig}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `c012r345s${sig}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `c12r0345s${sig}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c07r9')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c7r09')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c00r9')).toEqual({ kind: 'none' });
		// Contact 0 = a send without a contact row; its tag still reads back.
		expect(await readReplyTag(SECRET, await signReplyTag(SECRET, 5, 0))).toEqual({ kind: 'signed', campaignId: 5, contactId: 0 });
		expect(await readReplyTag(SECRET, 'c5r0')).toEqual({ kind: 'legacy', campaignId: 5, contactId: 0 });
	});

	it('refuses trailing or extra characters', async () => {
		const tag = await signReplyTag(SECRET, 1, 2);
		const sig = tag.replace(/^c\d+r\d+s/, '');
		expect(await readReplyTag(SECRET, `${tag}x`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `${tag}-`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c1r2-')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c1r2x')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c1 r2')).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, 'c1r2\t')).toEqual({ kind: 'legacy', campaignId: 1, contactId: 2 }); // outer whitespace is trimmed
		expect(await readReplyTag(SECRET, `c1r2s${sig.slice(0, 6)} ${sig.slice(6)}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `c1 r2s${sig}`)).toEqual({ kind: 'none' });
		expect(await readReplyTag(SECRET, `xc1r2s${sig}`)).toEqual({ kind: 'none' });
	});

	it('builds an address within 64 characters, else none', async () => {
		const local = 'f'.repeat(32);
		const addr = await replyTagAddress(`${local}@inbound.postmarkapp.com`, SECRET, 123456, 1234567);
		expect(addr).not.toBeNull();
		const [lp, domain] = addr!.split('@');
		expect(domain).toBe('inbound.postmarkapp.com');
		expect(lp.length).toBeLessThanOrEqual(MAX_LOCAL_PART);
		expect(lp).toMatch(/^[a-z0-9+]+$/);
		expect(await replyTagAddress(`${'f'.repeat(60)}@x.test`, SECRET, 1, 1)).toBeNull();
		expect(await replyTagAddress('reply@x.test', '', 1, 1)).toBeNull();
	});

	it('every send carries the signed tag in its Reply-To', async () => {
		const seen: Record<string, unknown>[] = [];
		vi.stubGlobal('fetch', (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>[];
			seen.push(...body);
			return new Response(JSON.stringify(body.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `pm-${i}` }))), { status: 200 });
		}) as typeof fetch);
		const ann = await id("INSERT INTO contacts (email, first_name) VALUES ('ann@ourco.example', 'Ann') RETURNING id");
		const camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Hi', 'x', 'h', 'news@ourco.example', 'sending') RETURNING id"
		);
		await sendCampaignEmail(db, {
			token: 'pm-token',
			secret: SECRET,
			baseUrl: 'https://crm.myapp.example',
			campaignId: camp,
			recipients: [{ id: ann, email: 'ann@ourco.example', name: null, first_name: 'Ann', last_name: null }],
			subject: 'Hi',
			htmlTemplate: '<p>Hi</p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>',
			textTemplate: 'Hi\n\nUnsubscribe: %%UNSUB_URL%%',
			from: 'news@ourco.example',
			stream: 'broadcast',
			replyToInbound: 'reply@inbound.ourco.example'
		});
		expect(seen).toHaveLength(1);
		const replyTo = String(seen[0].ReplyTo);
		const hash = /^reply\+(.+)@inbound\.ourco\.example$/.exec(replyTo)?.[1];
		expect(hash).toBe(await signReplyTag(SECRET, camp, ann));
	});
});

describe('inbound attribution by reply tag (#743)', () => {
	function ev(body: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
		return {
			url: new URL('https://app.test/api/inbound?key=k'),
			request: new Request('https://app.test/api/inbound', {
				method: 'POST',
				body: JSON.stringify({ Subject: 'Re: S', TextBody: 'hello', Headers: [], ...body })
			}),
			platform: { env: { DB: db, INBOUND_KEY: 'k', POSTMARK_FROM: 'me@ourco.example', SESSION_SECRET: SECRET, ...extraEnv } }
		} as any;
	}

	async function setup() {
		const ann = await id("INSERT INTO contacts (email) VALUES ('ann@x.example.net') RETURNING id");
		const bob = await id("INSERT INTO contacts (email) VALUES ('bob@x.example.net') RETURNING id");
		const camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('S', 'm', 'h', 'f', 'sent') RETURNING id"
		);
		return { ann, bob, camp };
	}

	async function lastReply() {
		return db
			.prepare('SELECT contact_id, campaign_id FROM replies ORDER BY id DESC LIMIT 1')
			.first<{ contact_id: number | null; campaign_id: number | null }>();
	}

	it('a signed tag files the reply under its campaign and contact', async () => {
		const { ann, camp } = await setup();
		const res = await inbound(ev({ FromFull: { Email: 'ann.alias@x.example.net' }, MailboxHash: await signReplyTag(SECRET, camp, ann) }));
		expect(res.status).toBe(200);
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: camp });
	});

	it('a tag with a changed contact id is not used; the sender decides', async () => {
		const { ann, bob, camp } = await setup();
		const sig = (await signReplyTag(SECRET, camp, ann)).replace(/^c\d+r\d+s/, '');
		await inbound(ev({ FromFull: { Email: 'ann@x.example.net' }, MailboxHash: `c${camp}r${bob}s${sig}` }));
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: null });
	});

	it('a changed tag from an unknown sender is stored without a contact', async () => {
		const { bob, camp } = await setup();
		const sig = (await signReplyTag(SECRET, camp, bob + 1)).replace(/^c\d+r\d+s/, '');
		await inbound(ev({ FromFull: { Email: 'someone@y.example.net' }, MailboxHash: `c${camp}r${bob}s${sig}` }));
		expect(await lastReply()).toEqual({ contact_id: null, campaign_id: null });
	});

	it('an older unsigned tag is accepted when the sender is that contact', async () => {
		const { ann, camp } = await setup();
		await inbound(ev({ FromFull: { Email: 'Ann@x.example.net' }, MailboxHash: `c${camp}r${ann}` }));
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: camp });
	});

	it('an older unsigned tag from a different sender is matched on the sender instead', async () => {
		const { ann, bob, camp } = await setup();
		await inbound(ev({ FromFull: { Email: 'ann@x.example.net' }, MailboxHash: `c${camp}r${bob}` }));
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: null });
		await inbound(ev({ FromFull: { Email: 'someone@y.example.net' }, MailboxHash: `c${camp}r${bob}` }));
		expect(await lastReply()).toEqual({ contact_id: null, campaign_id: null });
	});

	it('an older unsigned tag still finds the campaign through In-Reply-To', async () => {
		const { ann, bob, camp } = await setup();
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'pm-a', 'accepted')")
			.bind(camp, ann)
			.run();
		await inbound(
			ev({
				FromFull: { Email: 'ann@x.example.net' },
				MailboxHash: `c${camp}r${bob}`,
				Headers: [{ Name: 'In-Reply-To', Value: '<pm-a@mtasv.net>' }]
			})
		);
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: camp });
	});

	async function dirtyFlag(contactId: number) {
		const row = await db.prepare('SELECT dirty FROM contact_engagement WHERE contact_id = ?').bind(contactId).first<{ dirty: number }>();
		return row?.dirty ?? 0;
	}

	it('an uppercased signed tag is still attributed to its contact', async () => {
		const { ann, camp } = await setup();
		const tag = (await signReplyTag(SECRET, camp, ann)).toUpperCase();
		await inbound(ev({ FromFull: { Email: 'someone@y.example.net' }, MailboxHash: tag }));
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: camp });
	});

	it('an older unsigned tag is accepted when From carries a display name', async () => {
		const { ann, camp } = await setup();
		await inbound(
			ev({
				From: 'Ann Lee <ann@x.example.net>',
				FromName: 'Ann Lee',
				FromFull: { Email: 'ann@x.example.net', Name: 'Ann Lee' },
				MailboxHash: `c${camp}r${ann}`
			})
		);
		expect(await lastReply()).toEqual({ contact_id: ann, campaign_id: camp });
	});

	it('a tag that fails verification has no side effects on the tagged contact', async () => {
		const { ann, bob, camp } = await setup();
		await db.prepare('DELETE FROM contact_engagement').run();
		// Ann's signature on Bob's ids, then Bob's own signature with leading zeros.
		const annSig = (await signReplyTag(SECRET, camp, ann)).replace(/^c\d+r\d+s/, '');
		const bobSig = (await signReplyTag(SECRET, camp, bob)).replace(/^c\d+r\d+s/, '');
		for (const hash of [`c${camp}r${bob}s${annSig}`, `c0${camp}r0${bob}s${bobSig}`]) {
			const res = await inbound(ev({ FromFull: { Email: 'someone@y.example.net' }, MailboxHash: hash }));
			expect(res.status).toBe(200);
			const reply = await lastReply();
			expect(reply?.contact_id).not.toBe(bob);
			expect(reply).toEqual({ contact_id: null, campaign_id: null });
			expect(await dirtyFlag(bob)).toBe(0);
		}
	});

	it('the forward of a reply with a failed tag does not link the tagged contact', async () => {
		const { ann, bob, camp } = await setup();
		await db.prepare("DELETE FROM app_state WHERE key IN ('inbound_forward_to', 'custom_domain')").run();
		clearDomainCache();
		const sent: Record<string, any>[] = [];
		vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/email/batch')) {
				sent.push(JSON.parse(String(init?.body))[0]);
				return new Response(JSON.stringify([{ ErrorCode: 0, Message: 'OK', MessageID: 'fwd-1' }]), { status: 200 });
			}
			return new Response('not found', { status: 404 });
		}) as typeof fetch);
		const annSig = (await signReplyTag(SECRET, camp, ann)).replace(/^c\d+r\d+s/, '');
		await inbound(
			ev(
				{ FromFull: { Email: 'someone@y.example.net', Name: 'Someone' }, MailboxHash: `c${camp}r${bob}s${annSig}` },
				{
					POSTMARK_TOKEN: 'tok',
					POSTMARK_STREAM_TX: 'outbound',
					INBOUND_FORWARD_TO: 'ops@ourco.example',
					PUBLIC_BASE_URL: 'https://crm.test'
				}
			)
		);
		expect(sent).toHaveLength(1);
		const body = String(sent[0].TextBody);
		expect(body).toContain('View in CRM: https://crm.test/conversations');
		expect(body).not.toContain(`/contacts/${bob}`);
		expect(body).not.toContain(`/conversations/c${bob}-`);
	});
});

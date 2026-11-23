import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { renderForRecipient } from '../src/lib/server/render-preview';
import { GET } from '../src/routes/campaign/[id]/render/+server';

// #127: "View email" dialog renders through the exact send-time pipeline per recipient.
const db = (env as any).DB as D1Database;

const BODY_HTML =
	'<html><body>{{#if field:site_url}}A {{field:site_url}}{{else}}B{{/if}} <p>Hi {{first_name}}</p> <a href="%%UNSUB_URL%%">Unsubscribe</a></body></html>';

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeCampaign(bodyHtml = BODY_HTML): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status)
			 VALUES ('Hello {{first_name}}', 'md', ?, 'Hi {{first_name}}', 'alan@ourco.example', 'sent') RETURNING id`
		)
		.bind(bodyHtml)
		.first<{ id: number }>();
	return c!.id;
}

async function makeContact(email: string, firstName: string | null, meta: string | null): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email, first_name, meta) VALUES (?, ?, ?) RETURNING id')
		.bind(email, firstName, meta)
		.first<{ id: number }>();
	return c!.id;
}

async function makeRecipient(campaignId: number, contactId: number | null, email: string): Promise<number> {
	const r = await db
		.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, ?) RETURNING id')
		.bind(campaignId, contactId, email, 'accepted')
		.first<{ id: number }>();
	return r!.id;
}

function extractUnsubToken(html: string): string | null {
	const m = /\/unsubscribe\?t=([^"&]+)/.exec(html);
	return m ? m[1] : null;
}

describe('renderForRecipient (#127)', () => {
	it('renders conditionals + merge tags resolved, per-recipient unsubscribe link, for a contact with data', async () => {
		const campaignId = await makeCampaign();
		const contact1 = await makeContact('ann@x.example.net', 'Ann', '{"site_url":"https://example.com"}');
		const recipient1 = await makeRecipient(campaignId, contact1, 'ann@x.example.net');

		const result = await renderForRecipient(db, {
			campaignId,
			recipientId: recipient1,
			secret: 'test-secret',
			baseUrl: 'https://app.test'
		});

		expect(result).not.toBeNull();
		expect(result!.html).toContain('A https://example.com');
		expect(result!.html).toContain('Hi Ann');
		expect(result!.html).not.toContain('{{');
		expect(result!.html).toContain('/unsubscribe?t=');
		expect(result!.recipient).toEqual({ id: recipient1, email: 'ann@x.example.net', contact_id: contact1, name: 'Ann' });
	});

	it('falls back to else-branch and "there" for a contact with no data; unsub tokens differ per recipient', async () => {
		const campaignId = await makeCampaign();
		const contact1 = await makeContact('ann@x.example.net', 'Ann', '{"site_url":"https://example.com"}');
		const recipient1 = await makeRecipient(campaignId, contact1, 'ann@x.example.net');
		const contact2 = await makeContact('bob@x.example.net', null, null);
		const recipient2 = await makeRecipient(campaignId, contact2, 'bob@x.example.net');

		const result1 = await renderForRecipient(db, {
			campaignId,
			recipientId: recipient1,
			secret: 'test-secret',
			baseUrl: 'https://app.test'
		});
		const result2 = await renderForRecipient(db, {
			campaignId,
			recipientId: recipient2,
			secret: 'test-secret',
			baseUrl: 'https://app.test'
		});

		expect(result2).not.toBeNull();
		expect(result2!.html).toContain('B ');
		expect(result2!.html).toContain('Hi there');
		expect(result2!.html).not.toContain('{{');
		expect(result2!.html).toContain('/unsubscribe?t=');

		const token1 = extractUnsubToken(result1!.html);
		const token2 = extractUnsubToken(result2!.html);
		expect(token1).toBeTruthy();
		expect(token2).toBeTruthy();
		expect(token1).not.toBe(token2);
	});

	it('returns null for a recipient that belongs to a different campaign', async () => {
		const campaignId = await makeCampaign();
		const otherCampaignId = await makeCampaign();
		const contact = await makeContact('cross@x.example.net', 'Cross', null);
		const otherRecipient = await makeRecipient(otherCampaignId, contact, 'cross@x.example.net');

		const result = await renderForRecipient(db, {
			campaignId,
			recipientId: otherRecipient,
			secret: 'test-secret',
			baseUrl: 'https://app.test'
		});
		expect(result).toBeNull();
	});

	it('recipientId: null returns the template as authored, with conditionals unresolved', async () => {
		const campaignId = await makeCampaign();

		const result = await renderForRecipient(db, {
			campaignId,
			recipientId: null,
			secret: 'test-secret',
			baseUrl: 'https://app.test'
		});

		expect(result).not.toBeNull();
		expect(result!.recipient).toBeNull();
		expect(result!.html).toContain('{{#if');
		expect(result!.html).toContain('{{field:');
	});

	it('returns null for a missing campaign', async () => {
		const result = await renderForRecipient(db, {
			campaignId: 999999,
			recipientId: null,
			secret: 'test-secret',
			baseUrl: 'https://app.test'
		});
		expect(result).toBeNull();
	});
});

describe('GET /campaign/[id]/render (#127)', () => {
	function ev(campaignId: number | string, params: Record<string, string>, user: { id: number } | null = { id: 1 }) {
		const url = new URL(`https://app.test/campaign/${campaignId}/render`);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		return {
			request: new Request(url),
			platform: { env: { ...(env as object), SESSION_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://app.test' } },
			url,
			params: { id: String(campaignId) },
			locals: { user, authed: !!user }
		} as any;
	}

	it('401s with no session user', async () => {
		const res = await GET(ev(1, { as: 'template' }, null));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
	});

	it('404s for an unknown campaign id', async () => {
		const res = await GET(ev(999999, { as: 'template' }));
		expect(res.status).toBe(404);
	});

	it('400s for a malformed or missing "as" param', async () => {
		const campaignId = await makeCampaign();
		expect((await GET(ev(campaignId, { as: 'abc' }))).status).toBe(400);
		expect((await GET(ev(campaignId, {}))).status).toBe(400);
	});

	it('happy path: 200 with the rendered recipient JSON', async () => {
		const campaignId = await makeCampaign();
		const contact = await makeContact('ann@x.example.net', 'Ann', '{"site_url":"https://example.com"}');
		const recipient = await makeRecipient(campaignId, contact, 'ann@x.example.net');

		const res = await GET(ev(campaignId, { as: String(recipient) }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { recipient: unknown; html: string };
		expect(body.recipient).toEqual({ id: recipient, email: 'ann@x.example.net', contact_id: contact, name: 'Ann' });
		expect(body.html).toContain('Hi Ann');
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resolvePreviewTarget, searchCampaignRecipients } from '../src/lib/server/render-preview';
import { GET } from '../src/routes/campaign/[id]/recipients/+server';
import { viewEmailHref } from '../src/lib/view-email-href';

// #155: View email deep links (?as / ?as_contact) + the "Viewing as" recipient search.
const db = (env as any).DB as D1Database;

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

async function makeCampaign(): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status)
			 VALUES ('Hi', 'md', '<html><body>Hi {{first_name}}</body></html>', 'Hi', 'alan@ourco.example', 'sent') RETURNING id`
		)
		.first<{ id: number }>();
	return c!.id;
}

async function makeContact(email: string, first: string | null, last: string | null = null): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email, first_name, last_name) VALUES (?, ?, ?) RETURNING id')
		.bind(email, first, last)
		.first<{ id: number }>();
	return c!.id;
}

async function makeRecipient(campaignId: number, contactId: number | null, email: string, status = 'accepted'): Promise<number> {
	const r = await db
		.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, ?) RETURNING id')
		.bind(campaignId, contactId, email, status)
		.first<{ id: number }>();
	return r!.id;
}

describe('resolvePreviewTarget (#155)', () => {
	it('no params → template, no notice (not "the first recipient")', async () => {
		const cid = await makeCampaign();
		await makeRecipient(cid, await makeContact('ann@x.example.net', 'Ann'), 'ann@x.example.net');
		expect(await resolvePreviewTarget(db, cid, { as: null, asContact: null })).toEqual({ recipientId: null, notice: null });
		expect(await resolvePreviewTarget(db, cid, { as: 'template', asContact: null })).toEqual({ recipientId: null, notice: null });
	});

	it('?as=<recipientId> resolves only when the row belongs to this campaign', async () => {
		const cid = await makeCampaign();
		const other = await makeCampaign();
		const rid = await makeRecipient(cid, null, 'ann@x.example.net');
		const otherRid = await makeRecipient(other, null, 'bob@x.example.net');
		expect(await resolvePreviewTarget(db, cid, { as: String(rid), asContact: null })).toEqual({ recipientId: rid, notice: null });

		for (const as of [String(otherRid), '999999', 'abc', '-1']) {
			const t = await resolvePreviewTarget(db, cid, { as, asContact: null });
			expect(t.recipientId).toBeNull();
			expect(t.notice).toMatch(/template/);
		}
	});

	it('?as_contact=<contactId> resolves to that contact’s accepted row (latest), else a template notice', async () => {
		const cid = await makeCampaign();
		const phil = await makeContact('phil@x.example.net', 'Phil');
		await makeRecipient(cid, phil, 'phil@x.example.net', 'error');
		const accepted = await makeRecipient(cid, phil, 'phil@x.example.net');
		await makeRecipient(cid, phil, 'phil@x.example.net', 'error');
		expect(await resolvePreviewTarget(db, cid, { as: null, asContact: String(phil) })).toEqual({ recipientId: accepted, notice: null });

		const stranger = await makeContact('nope@x.example.net', 'Nope');
		const t = await resolvePreviewTarget(db, cid, { as: null, asContact: String(stranger) });
		expect(t).toEqual({ recipientId: null, notice: expect.stringMatching(/didn't receive/) });
		expect((await resolvePreviewTarget(db, cid, { as: null, asContact: 'x' })).recipientId).toBeNull();
	});

	it('?as wins over ?as_contact', async () => {
		const cid = await makeCampaign();
		const a = await makeContact('a@x.example.net', 'A');
		const b = await makeContact('b@x.example.net', 'B');
		const ra = await makeRecipient(cid, a, 'a@x.example.net');
		await makeRecipient(cid, b, 'b@x.example.net');
		expect((await resolvePreviewTarget(db, cid, { as: String(ra), asContact: String(b) })).recipientId).toBe(ra);
	});
});

describe('GET /campaign/[id]/recipients (#155)', () => {
	function ev(campaignId: number | string, q: string | null, user: { id: number } | null = { id: 1 }) {
		const url = new URL(`https://app.test/campaign/${campaignId}/recipients`);
		if (q !== null) url.searchParams.set('q', q);
		return { request: new Request(url), platform: { env }, url, params: { id: String(campaignId) }, locals: { user } } as any;
	}

	it('401s with no session user', async () => {
		const res = await GET(ev(1, 'ann', null));
		expect(res.status).toBe(401);
	});

	it('400s for a bad campaign id', async () => {
		expect((await GET(ev('abc', 'ann'))).status).toBe(400);
	});

	it('returns nothing under 2 characters', async () => {
		const cid = await makeCampaign();
		await makeRecipient(cid, null, 'ann@x.example.net');
		for (const q of [null, '', 'a', ' a ']) {
			const res = await GET(ev(cid, q));
			expect(await res.json()).toEqual({ results: [] });
		}
	});

	it('matches email and contact name, scoped to the campaign, one row per email', async () => {
		const cid = await makeCampaign();
		const other = await makeCampaign();
		const phil = await makeContact('pf@example.com', 'Phil', 'Farda');
		await makeRecipient(cid, phil, 'pf@example.com');
		const resent = await makeRecipient(cid, phil, 'pf@example.com'); // resend row
		await makeRecipient(cid, null, 'ann@x.example.net');
		await makeRecipient(other, null, 'phil-other@x.example.net');

		const byName = (await (await GET(ev(cid, 'phil far'))).json()) as { results: any[] };
		expect(byName.results).toEqual([{ id: resent, email: 'pf@example.com', contact_id: phil, name: 'Phil Farda' }]);

		const byEmail = (await (await GET(ev(cid, 'ANN@'))).json()) as { results: any[] };
		expect(byEmail.results.map((r) => r.email)).toEqual(['ann@x.example.net']);
		expect(byEmail.results[0].name).toBeNull();

		const none = (await (await GET(ev(cid, 'phil-other'))).json()) as { results: any[] };
		expect(none.results).toEqual([]);
	});

	it('caps at 10 results and escapes LIKE wildcards', async () => {
		const cid = await makeCampaign();
		for (let i = 0; i < 15; i++) await makeRecipient(cid, null, `user${i}@bulk.test`);
		const res = (await (await GET(ev(cid, 'bulk.test'))).json()) as { results: any[] };
		expect(res.results).toHaveLength(10);

		// '%' must be literal, not a wildcard.
		expect(await searchCampaignRecipients(db, cid, '%%')).toEqual([]);
		await makeRecipient(cid, null, '50%off@x.example.net');
		expect((await searchCampaignRecipients(db, cid, '0%o')).map((r) => r.email)).toEqual(['50%off@x.example.net']);
	});
});

describe('viewEmailHref (#155)', () => {
	it('recipient id → ?as=…#email', () => {
		expect(viewEmailHref(7, { recipientId: 42 })).toBe('/campaign/7?as=42#email');
	});
	it('contact id → ?as_contact=…#email', () => {
		expect(viewEmailHref(7, { contactId: 9 })).toBe('/campaign/7?as_contact=9#email');
	});
	it('recipient id wins over contact id', () => {
		expect(viewEmailHref(7, { recipientId: 42, contactId: 9 })).toBe('/campaign/7?as=42#email');
	});
	it('no person → plain campaign link (modal defaults to the template)', () => {
		expect(viewEmailHref(7)).toBe('/campaign/7');
		expect(viewEmailHref(7, { contactId: null })).toBe('/campaign/7');
	});
});

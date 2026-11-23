import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { describeAudience, audienceLabel, loadAudience, type AudienceInput } from '../src/lib/server/audience';

// #118: who a list-less campaign (direct / SEO Snapshot review / automation step) went to.
const db = (env as any).DB as D1Database;

const BASE: AudienceInput = {
	list_id: null,
	list_name: null,
	automation_id: null,
	automation_name: null,
	recipient_count: 0,
	sample: []
};

describe('describeAudience / audienceLabel', () => {
	it('a list wins over everything else', () => {
		const a = describeAudience({
			...BASE,
			list_id: 5,
			list_name: 'Newsletter',
			automation_id: 9,
			automation_name: 'Welcome drip',
			recipient_count: 3,
			sample: [{ id: 1, email: 'jane@x.example.net', contact_id: null }]
		});
		expect(a).toEqual({ kind: 'list', name: 'Newsletter', listId: 5 });
		expect(audienceLabel(a)).toBe('Newsletter');
	});

	it('falls back to automation when there is no list', () => {
		const a = describeAudience({
			...BASE,
			automation_id: 9,
			automation_name: 'Welcome drip',
			recipient_count: 1,
			sample: [{ id: 1, email: 'jane@x.example.net', contact_id: null }]
		});
		expect(a).toEqual({ kind: 'automation', name: 'Welcome drip', automationId: 9 });
		expect(audienceLabel(a)).toBe('automation: Welcome drip');
	});

	it('1 recipient: shows the single email, no "+more"', () => {
		const a = describeAudience({
			...BASE,
			recipient_count: 1,
			sample: [{ id: 1, email: 'jane@x.example.net', contact_id: null }]
		});
		expect(a).toEqual({
			kind: 'recipients',
			sample: [{ id: 1, email: 'jane@x.example.net', contact_id: null }],
			total: 1
		});
		expect(audienceLabel(a)).toBe('jane@x.example.net');
	});

	it('2-3 recipients: joins all of them, no "+more"', () => {
		const two = describeAudience({
			...BASE,
			recipient_count: 2,
			sample: [
				{ id: 1, email: 'jane@x.example.net', contact_id: null },
				{ id: 2, email: 'bob@y.example.net', contact_id: null }
			]
		});
		expect(audienceLabel(two)).toBe('jane@x.example.net, bob@y.example.net');

		const three = describeAudience({
			...BASE,
			recipient_count: 3,
			sample: [
				{ id: 1, email: 'jane@x.example.net', contact_id: null },
				{ id: 2, email: 'bob@y.example.net', contact_id: null },
				{ id: 3, email: 'carol@z.example.net', contact_id: null }
			]
		});
		expect(audienceLabel(three)).toBe('jane@x.example.net, bob@y.example.net, carol@z.example.net');
	});

	it('7 recipients: shows the 3-email sample plus "+4 more"', () => {
		const a = describeAudience({
			...BASE,
			recipient_count: 7,
			sample: [
				{ id: 1, email: 'jane@x.example.net', contact_id: null },
				{ id: 2, email: 'bob@y.example.net', contact_id: null },
				{ id: 3, email: 'carol@z.example.net', contact_id: null }
			]
		});
		expect(a).toMatchObject({ kind: 'recipients', total: 7 });
		expect(audienceLabel(a)).toBe('jane@x.example.net, bob@y.example.net, carol@z.example.net +4 more');
	});

	it('an oversized sample is still capped at 3 in both the derived Audience and the label', () => {
		const a = describeAudience({
			...BASE,
			recipient_count: 5,
			sample: [
				{ id: 1, email: 'a@x.example.net', contact_id: null },
				{ id: 2, email: 'b@x.example.net', contact_id: null },
				{ id: 3, email: 'c@x.example.net', contact_id: null },
				{ id: 4, email: 'd@x.example.net', contact_id: null }
			]
		});
		expect(a.kind === 'recipients' && a.sample.length).toBe(3);
		expect(audienceLabel(a)).toBe('a@x.example.net, b@x.example.net, c@x.example.net +2 more');
	});

	it('no list, no automation, no recipients → none → "—"', () => {
		const a = describeAudience({ ...BASE });
		expect(a).toEqual({ kind: 'none' });
		expect(audienceLabel(a)).toBe('—');
	});
});

describe('loadAudience (D1 round-trip)', () => {
	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare('DELETE FROM automation_steps'),
			db.prepare('DELETE FROM automations'),
			db.prepare('DELETE FROM list_members'),
			db.prepare('DELETE FROM lists'),
			db.prepare('DELETE FROM contacts')
		]);
	});

	it('a list-less campaign with 2 recipients (one contact, one bare email) returns the expected sample + total', async () => {
		const contact = await db
			.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id')
			.bind('jane@x.example.net')
			.first<{ id: number }>();

		const campaign = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at)
				 VALUES ('Hi', 'md', '<p>hi</p>', NULL, 'alan@ourco.example', 'sent', datetime('now'))
				 RETURNING id`
			)
			.first<{ id: number }>();
		const campaignId = campaign!.id;

		await db.batch([
			db
				.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, ?)')
				.bind(campaignId, contact!.id, 'jane@x.example.net', 'accepted'),
			db
				.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, ?)')
				.bind(campaignId, null, 'stranger@y.example.net', 'accepted')
		]);

		const audience = await loadAudience(db, campaignId);
		expect(audience.kind).toBe('recipients');
		if (audience.kind !== 'recipients') throw new Error('expected recipients');
		expect(audience.total).toBe(2);
		expect(audience.sample).toEqual([
			{ id: expect.any(Number), email: 'jane@x.example.net', contact_id: contact!.id },
			{ id: expect.any(Number), email: 'stranger@y.example.net', contact_id: null }
		]);
		expect(audienceLabel(audience)).toBe('jane@x.example.net, stranger@y.example.net');

		// Cleanup.
		await db.batch([
			db.prepare('DELETE FROM recipients WHERE campaign_id = ?').bind(campaignId),
			db.prepare('DELETE FROM campaigns WHERE id = ?').bind(campaignId),
			db.prepare('DELETE FROM contacts WHERE id = ?').bind(contact!.id)
		]);
	});

	it('a campaign with a list_id reports the list, ignoring any recipients rows', async () => {
		const list = await db
			.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id")
			.first<{ id: number }>();
		const campaign = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at)
				 VALUES ('Hi', 'md', '<p>hi</p>', ?, 'alan@ourco.example', 'sent', datetime('now'))
				 RETURNING id`
			)
			.bind(list!.id)
			.first<{ id: number }>();
		const campaignId = campaign!.id;

		const audience = await loadAudience(db, campaignId);
		expect(audience).toEqual({ kind: 'list', name: 'Newsletter', listId: list!.id });
	});

	it('an automation-step campaign (list_id NULL) reports the automation', async () => {
		const automation = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('Welcome drip', 'active') RETURNING id")
			.first<{ id: number }>();
		const campaign = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, automation_id, from_email, status, sent_at)
				 VALUES ('Hi', 'md', '<p>hi</p>', NULL, ?, 'alan@ourco.example', 'sent', datetime('now'))
				 RETURNING id`
			)
			.bind(automation!.id)
			.first<{ id: number }>();
		const campaignId = campaign!.id;

		const audience = await loadAudience(db, campaignId);
		expect(audience).toEqual({ kind: 'automation', name: 'Welcome drip', automationId: automation!.id });
	});

	it('an unknown campaign id returns none', async () => {
		const audience = await loadAudience(db, 999999);
		expect(audience).toEqual({ kind: 'none' });
	});
});

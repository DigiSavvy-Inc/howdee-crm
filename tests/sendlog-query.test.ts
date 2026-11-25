import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	parseSendLogFilter,
	sendLogFilterParams,
	sendLogWhere,
	isSendLogFiltered,
	SENDLOG_TYPE_SQL,
	type SendLogFilter
} from '../src/lib/server/sendlog-query';

// #106: the dashboard send log's pagination + Filters popover, mirroring contacts-query.test.ts.
const db = (env as any).DB as D1Database;

const EMPTY: SendLogFilter = { status: 'any', type: 'any', q: '', from: '', to: '' };

describe('parseSendLogFilter', () => {
	it('defaults to an unfiltered view when given nothing', () => {
		expect(parseSendLogFilter(new URLSearchParams())).toEqual(EMPTY);
	});

	it('clamps status to the known set and rejects junk', () => {
		expect(parseSendLogFilter(new URLSearchParams('status=sent')).status).toBe('sent');
		expect(parseSendLogFilter(new URLSearchParams('status=scheduled')).status).toBe('scheduled');
		expect(parseSendLogFilter(new URLSearchParams('status=bogus')).status).toBe('any');
		expect(parseSendLogFilter(new URLSearchParams('status=')).status).toBe('any');
	});

	it('clamps type to the known set and rejects junk', () => {
		expect(parseSendLogFilter(new URLSearchParams('type=automation')).type).toBe('automation');
		expect(parseSendLogFilter(new URLSearchParams('type=direct')).type).toBe('direct');
		expect(parseSendLogFilter(new URLSearchParams('type=resent')).type).toBe('resent');
		expect(parseSendLogFilter(new URLSearchParams('type=bogus')).type).toBe('any');
	});

	it('only accepts well-formed YYYY-MM-DD dates', () => {
		expect(parseSendLogFilter(new URLSearchParams('from=2026-01-15')).from).toBe('2026-01-15');
		expect(parseSendLogFilter(new URLSearchParams('from=not-a-date')).from).toBe('');
		expect(parseSendLogFilter(new URLSearchParams('to=01/15/2026')).to).toBe('');
	});
});

describe('isSendLogFiltered', () => {
	it('the empty filter is not filtered', () => {
		expect(isSendLogFiltered(EMPTY)).toBe(false);
	});

	it('any field narrows', () => {
		expect(isSendLogFiltered({ ...EMPTY, status: 'sent' })).toBe(true);
		expect(isSendLogFiltered({ ...EMPTY, type: 'direct' })).toBe(true);
		expect(isSendLogFiltered({ ...EMPTY, q: 'hi' })).toBe(true);
		expect(isSendLogFiltered({ ...EMPTY, from: '2026-01-01' })).toBe(true);
	});
});

describe('sendLogFilterParams', () => {
	it('omits empty/default fields', () => {
		expect(sendLogFilterParams(EMPTY)).toEqual({});
	});

	it('round-trips only the set fields', () => {
		const f: SendLogFilter = { ...EMPTY, q: 'newsletter', status: 'sent', type: 'direct' };
		expect(sendLogFilterParams(f)).toEqual({ q: 'newsletter', status: 'sent', type: 'direct' });
	});
});

describe('sendLogWhere (SQL shape)', () => {
	it('is empty (no WHERE) when nothing is set', () => {
		expect(sendLogWhere(EMPTY)).toEqual({ where: '', params: [] });
	});

	it('binds exactly one param per ? placeholder for a fully-populated filter', () => {
		const f: SendLogFilter = {
			status: 'sent',
			type: 'campaign',
			q: 'newsletter',
			from: '2026-01-01',
			to: '2026-01-31'
		};
		const { where, params } = sendLogWhere(f);
		expect(where.startsWith('WHERE ')).toBe(true);
		const placeholders = (where.match(/\?/g) ?? []).length;
		expect(placeholders).toBe(params.length);
	});

	it('#485: the q clause binds the raw text to instr (no LIKE pattern, so no D1 50-byte cap)', () => {
		const { where, params } = sendLogWhere({ ...EMPTY, q: 'a%b_c' });
		expect(where).not.toMatch(/\bLIKE\b/);
		expect(params).toContain('a%b_c');
	});

	it('type=resent filters on resend_status alone, independent of list_id/automation_step_id', () => {
		const { where, params } = sendLogWhere({ ...EMPTY, type: 'resent' });
		expect(where).toBe(`WHERE c.resend_status = ?`);
		expect(params).toEqual(['sent']);
	});
});

// --- D1 round-trip -------------------------------------------------------------------

describe('sendlog-query — D1 round-trip', () => {
	let listId: number;
	let automationId: number;
	let stepId: number;
	let plainId: number;
	let directId: number;
	let autoStepCampaignId: number;
	let resentId: number;

	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM events'),
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
			db.prepare('DELETE FROM automation_steps'),
			db.prepare('DELETE FROM automation_enrollments'),
			db.prepare('DELETE FROM automations'),
			db.prepare('DELETE FROM list_members'),
			db.prepare('DELETE FROM lists'),
			db.prepare('DELETE FROM contacts')
		]);

		const list = await db
			.prepare(`INSERT INTO lists (name, kind) VALUES ('slq-list', 'list') RETURNING id`)
			.first<{ id: number }>();
		listId = list!.id;

		const automation = await db
			.prepare(`INSERT INTO automations (name, status) VALUES ('slq-automation', 'active') RETURNING id`)
			.first<{ id: number }>();
		automationId = automation!.id;

		const step = await db
			.prepare(
				`INSERT INTO automation_steps
				   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
				 VALUES (?, 0, 0, 'slq-step', 'md', 'alan@ourco.example', 'email') RETURNING id`
			)
			.bind(automationId)
			.first<{ id: number }>();
		stepId = step!.id;

		// 1) Plain broadcast campaign — sent 2026-01-10.
		const plain = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at, recipient_count)
				 VALUES ('slq-plain', 'md', '<p>hi</p>', ?, 'alan@ourco.example', 'sent', '2026-01-10 12:00:00', 10)
				 RETURNING id`
			)
			.bind(listId)
			.first<{ id: number }>();
		plainId = plain!.id;

		// 2) Direct 1:1 send — list_id NULL, no automation_step_id. Sent 2026-01-15.
		const direct = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at, recipient_count)
				 VALUES ('slq-direct', 'md', '<p>hi</p>', NULL, 'alan@ourco.example', 'sent', '2026-01-15 12:00:00', 1)
				 RETURNING id`
			)
			.first<{ id: number }>();
		directId = direct!.id;

		// 3) Automation-step campaign — list_id NULL too, but automation_step_id set.
		const autoStep = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, automation_id, automation_step_id, sent_at, recipient_count)
				 VALUES ('slq-auto', 'md', '<p>hi</p>', NULL, 'alan@ourco.example', 'sent', ?, ?, '2026-01-20 12:00:00', 5)
				 RETURNING id`
			)
			.bind(automationId, stepId)
			.first<{ id: number }>();
		autoStepCampaignId = autoStep!.id;

		// 4) Resent campaign — kind='campaign' (has a list) AND resend_status='sent'.
		const resent = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at, recipient_count, resend_status, resent_at, resend_recipients)
				 VALUES ('slq-resent', 'md', '<p>hi</p>', ?, 'alan@ourco.example', 'sent', '2026-01-25 12:00:00', 8, 'sent', '2026-01-26 09:00:00', 3)
				 RETURNING id`
			)
			.bind(listId)
			.first<{ id: number }>();
		resentId = resent!.id;
	});

	async function kindOf(id: number): Promise<string> {
		const row = await db
			.prepare(`SELECT ${SENDLOG_TYPE_SQL} AS kind FROM campaigns c WHERE c.id = ?`)
			.bind(id)
			.first<{ kind: string }>();
		return row!.kind;
	}

	it('derives kind per row via SENDLOG_TYPE_SQL', async () => {
		expect(await kindOf(plainId)).toBe('campaign');
		expect(await kindOf(directId)).toBe('direct');
		expect(await kindOf(autoStepCampaignId)).toBe('automation');
		expect(await kindOf(resentId)).toBe('campaign'); // resend is independent of kind
	});

	async function matchingIds(f: SendLogFilter): Promise<number[]> {
		const { where, params } = sendLogWhere(f);
		const scoped = where ? `${where} AND c.subject LIKE 'slq-%'` : `WHERE c.subject LIKE 'slq-%'`;
		const res = await db
			.prepare(`SELECT c.id FROM campaigns c ${scoped} ORDER BY c.id`)
			.bind(...params)
			.all<{ id: number }>();
		return res.results.map((r) => r.id);
	}

	it('type=automation selects only the automation-step campaign', async () => {
		expect(await matchingIds({ ...EMPTY, type: 'automation' })).toEqual([autoStepCampaignId]);
	});

	it('type=direct selects only the direct send', async () => {
		expect(await matchingIds({ ...EMPTY, type: 'direct' })).toEqual([directId]);
	});

	it('type=campaign selects the plain + resent campaigns (both have a list, no automation step)', async () => {
		expect(await matchingIds({ ...EMPTY, type: 'campaign' })).toEqual([plainId, resentId].sort((a, b) => a - b));
	});

	it('type=resent selects only the resent campaign, regardless of kind', async () => {
		expect(await matchingIds({ ...EMPTY, type: 'resent' })).toEqual([resentId]);
	});

	it('date bounds filter on COALESCE(sent_at, scheduled_at, created_at)', async () => {
		expect(await matchingIds({ ...EMPTY, from: '2026-01-16' })).toEqual(
			[autoStepCampaignId, resentId].sort((a, b) => a - b)
		);
		expect(await matchingIds({ ...EMPTY, to: '2026-01-10' })).toEqual([plainId]);
		expect(await matchingIds({ ...EMPTY, from: '2026-01-14', to: '2026-01-21' })).toEqual(
			[directId, autoStepCampaignId].sort((a, b) => a - b)
		);
	});

	it('q filters on subject with LIKE escaping', async () => {
		expect(await matchingIds({ ...EMPTY, q: 'resent' })).toEqual([resentId]);
	});

	it('paginates with LIMIT ? OFFSET ? — per=2 gives 2 + 2 across all 4 rows', async () => {
		const { where, params } = sendLogWhere(EMPTY);
		const scoped = where ? `${where} AND c.subject LIKE 'slq-%'` : `WHERE c.subject LIKE 'slq-%'`;
		const per = 2;
		const page1 = await db
			.prepare(`SELECT c.id FROM campaigns c ${scoped} ORDER BY c.id LIMIT ? OFFSET ?`)
			.bind(...params, per, 0)
			.all<{ id: number }>();
		const page2 = await db
			.prepare(`SELECT c.id FROM campaigns c ${scoped} ORDER BY c.id LIMIT ? OFFSET ?`)
			.bind(...params, per, per)
			.all<{ id: number }>();
		expect(page1.results.length).toBe(2);
		expect(page2.results.length).toBe(2);
	});
});

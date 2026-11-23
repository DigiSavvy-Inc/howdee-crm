import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { claimScheduledCampaign } from '../src/lib/server/scheduled';

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.prepare('DELETE FROM campaigns').run();
});

describe('claimScheduledCampaign (#35)', () => {
	it('only one claimer wins; non-scheduled rows are unclaimable', async () => {
		const row = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, scheduled_at)
				 VALUES ('s', 'b', '<p>b</p>', 'a@b.example.net', 'scheduled', datetime('now', '-1 minute')) RETURNING id`
			)
			.first<{ id: number }>();
		expect(await claimScheduledCampaign(db, row!.id)).toBe(true);
		expect(await claimScheduledCampaign(db, row!.id)).toBe(false); // already 'sending'
		const status = await db.prepare('SELECT status FROM campaigns WHERE id = ?').bind(row!.id).first<{ status: string }>();
		expect(status?.status).toBe('sending');
	});
});

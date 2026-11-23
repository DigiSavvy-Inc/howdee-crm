import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { builtInByKey, runBuiltIn } from '../src/lib/server/reports/builtins';
import { rateTrend, tzWeekStart } from '../src/lib/server/reports/rate-trend';

const db = (env as { DB: D1Database }).DB;
const NOW = new Date('2026-10-24T12:00:00Z');
const UTC = 'UTC';
const HUMAN = JSON.stringify({ Client: { Name: 'Gmail', Family: 'Gmail' }, UserAgent: 'Mozilla/5.0', FirstOpen: false });
const PROXY = JSON.stringify({ Client: { Name: 'Apple Mail', Family: 'Apple Mail' }, UserAgent: 'Mail/1.0' });

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM lists'),
		db.prepare(`DELETE FROM app_state WHERE key = 'timezone'`)
	]);
});

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await db.prepare(sql).bind(...binds).first<{ id: number }>();
	if (!row) throw new Error(sql);
	return row.id;
}

async function run(sql: string, ...binds: unknown[]): Promise<void> {
	await db.prepare(sql).bind(...binds).run();
}

let n = 0;
async function recipient(campaignId: number): Promise<number> {
	n += 1;
	const contact = await id(`INSERT INTO contacts (email) VALUES (?) RETURNING id`, `p${n}@r455.test`);
	return id(
		`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted') RETURNING id`,
		campaignId,
		contact,
		`p${n}@r455.test`
	);
}

async function event(recipientId: number, type: string, at: string, detail: string | null = null): Promise<void> {
	await run(
		`INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at)
		 SELECT campaign_id, id, contact_id, ?, ?, ? FROM recipients WHERE id = ?`,
		type,
		detail,
		at,
		recipientId
	);
}

async function stepCampaign(status: string, sentAt: string | null): Promise<number> {
	const automation = await id(`INSERT INTO automations (name, status) VALUES ('Drip', 'active') RETURNING id`);
	const step = await id(
		`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
		 VALUES (?, 1, 0, 'Hi', 'x', 'f@x.example.net', 'email') RETURNING id`,
		automation
	);
	return id(
		`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, automation_id, automation_step_id, sent_at)
		 VALUES ('Hi', 'm', 'h', 'f@x.example.net', ?, NULL, ?, ?, ?) RETURNING id`,
		status,
		automation,
		step,
		sentAt
	);
}

/** Mondays (UTC) going back from 2026-10-19. */
function monday(weeksBack: number): string {
	return new Date(Date.parse('2026-10-19T00:00:00Z') - weeksBack * 7 * 86_400_000).toISOString().slice(0, 10);
}

describe('tzWeekStart', () => {
	it('buckets by the Monday in the operator timezone', () => {
		// Monday 03:00 UTC is still Sunday evening in Los Angeles.
		expect(tzWeekStart('2026-10-19 03:00:00', 'America/Los_Angeles')).toBe('2026-10-12');
		expect(tzWeekStart('2026-10-19 03:00:00', UTC)).toBe('2026-10-19');
		expect(tzWeekStart('', UTC)).toBeNull();
	});
});

describe('rate trend (#455)', () => {
	it('buckets automation recipients by their own send time, weekly', async () => {
		// Step campaign first sent before the window keeps sending into it (seed's 9120).
		const old = await stepCampaign('sent', '2025-08-04 10:00:00');
		const before = await recipient(old);
		await event(before, 'delivery', '2025-08-04 10:05:00');
		// 11 in-window weeks, skipping weeks 4 and 5 back (empty weeks in between).
		const weeks = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12];
		const ids: number[] = [];
		for (const back of weeks) {
			const r = await recipient(old);
			ids.push(r);
			await event(r, 'delivery', `${monday(back)} 15:00:00`);
		}
		await event(ids[0]!, 'click', `${monday(0)} 16:00:00`);
		await event(ids[1]!, 'open', `${monday(1)} 18:00:00`, HUMAN);
		await event(ids[2]!, 'open', `${monday(2)} 15:00:10`, PROXY);

		// A step campaign still sending, with a recipient that has no send event yet.
		const sending = await stepCampaign('sending', null);
		await recipient(sending);

		const rows = await rateTrend(db, NOW, UTC);
		expect(rows.some((row) => row.week === '')).toBe(false);
		const withSends = rows.filter((row) => row.automation_sent > 0);
		expect(withSends.map((row) => row.week)).toEqual(weeks.map(monday).sort());
		expect(withSends.every((row) => row.automation_sent === 1)).toBe(true);
		// The pre-window delivery is not counted.
		expect(rows.reduce((sum, row) => sum + row.automation_sent, 0)).toBe(11);
		expect(rows.find((row) => row.week === monday(0))).toMatchObject({ automation_open_rate: 100, automation_click_rate: 100 });
		expect(rows.find((row) => row.week === monday(1))).toMatchObject({ automation_open_rate: 100, automation_click_rate: 0 });
		// A proxy-only open isn't an opener.
		expect(rows.find((row) => row.week === monday(2))).toMatchObject({ automation_open_rate: 0 });
		// Empty weeks are emitted with 0 sent and null rates: a gap, not a point.
		for (const back of [4, 5]) {
			expect(rows.find((row) => row.week === monday(back))).toEqual({
				week: monday(back),
				open_rate: null,
				click_rate: null,
				automation_open_rate: null,
				automation_click_rate: null,
				sent: 0,
				automation_sent: 0
			});
		}
		expect(rows.map((row) => row.week)).toEqual([...rows.map((row) => row.week)].sort());
		expect(rows).toHaveLength(13);
	});

	it('keeps campaigns as their own series and buckets by the Settings → Timezone Monday', async () => {
		const list = await id(`INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id`);
		const broadcast = await id(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, sent_at)
			 VALUES ('News', 'm', 'h', 'f@x.example.net', 'sent', ?, '2026-10-19 03:00:00') RETURNING id`,
			list
		);
		const a = await recipient(broadcast);
		await recipient(broadcast);
		await event(a, 'delivery', '2026-10-19 03:01:00');
		await event(a, 'open', '2026-10-19 05:00:00', HUMAN);
		const step = await stepCampaign('sent', '2026-10-19 03:00:00');
		const s = await recipient(step);
		await event(s, 'delivery', '2026-10-19 03:00:30');

		await run(`INSERT INTO app_state (key, value) VALUES ('timezone', 'America/Los_Angeles')`);
		const def = builtInByKey('rate-trend')!;
		const result = await runBuiltIn(db, def, {}, { role: 'admin' }, NOW);
		expect(result.rows).toEqual([
			{
				week: '2026-10-12',
				open_rate: 50,
				click_rate: 0,
				automation_open_rate: 0,
				automation_click_rate: 0,
				sent: 2,
				automation_sent: 1
			}
		]);
		expect(result.columns[0]?.definition).toContain('America/Los_Angeles');
		expect(result.chartSeries?.yKeys).toEqual(['open_rate', 'click_rate', 'automation_open_rate', 'automation_click_rate']);
	});
});

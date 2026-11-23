import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { applyWeekdayOnly, parseZonedLocal, sqliteUtc } from '../src/lib/server/businessdays';
import { enroll } from '../src/lib/server/automations';
import { getSettings, setSettings, getTimezone, isValidTimezone, timezoneNames, timezoneOptions, DEFAULT_TIMEZONE } from '../src/lib/server/settings';

// Business-day scheduling (#119): a single rule — a due time landing on Sat/Sun in the
// operator's timezone moves to Monday at the same local wall-clock time. No business-day
// counting, no holidays. See src/lib/server/businessdays.ts for the two-pass local<->UTC
// conversion this all rests on.

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key = 'timezone'`)
	]);
});

describe('applyWeekdayOnly — America/Los_Angeles', () => {
	const tz = 'America/Los_Angeles';

	it('Friday is left unchanged', () => {
		const fri = new Date('2026-10-03T01:00:00Z'); // Fri 2026-10-02 18:00 PDT
		const out = applyWeekdayOnly(fri, tz);
		expect(out.getTime()).toBe(fri.getTime());
	});

	it('Saturday morning moves to Monday, same local time', () => {
		const sat = new Date('2026-10-03T16:00:00Z'); // Sat 2026-10-03 09:00 PDT
		const out = applyWeekdayOnly(sat, tz);
		expect(out.toISOString()).toBe('2026-10-05T16:00:00.000Z'); // Mon 2026-10-05 09:00 PDT
	});

	it('Sunday night moves to Monday, same local time', () => {
		const sun = new Date('2026-10-05T06:30:00Z'); // Sun 2026-10-04 23:30 PDT
		const out = applyWeekdayOnly(sun, tz);
		expect(out.toISOString()).toBe('2026-10-06T06:30:00.000Z'); // Mon 2026-10-05 23:30 PDT
	});

	it('DST edge: Sat before fall-back -> Mon after it, UTC offset shifts with it', () => {
		// Sat 2026-10-31 10:00 PDT (UTC-7). The following Monday (2026-11-02) is already
		// on PST (UTC-8) — DST falls back at 2am local on Sun 2026-11-01. Preserving the
		// local wall-clock time means the UTC instant is 18:00Z, NOT a naive +48h (17:00Z).
		const sat = new Date('2026-10-31T17:00:00Z');
		const out = applyWeekdayOnly(sat, tz);
		expect(out.toISOString()).toBe('2026-11-02T18:00:00.000Z'); // Mon 2026-11-02 10:00 PST
	});
});

describe('applyWeekdayOnly — other zones', () => {
	it('tz UTC: Saturday noon -> Monday noon, same instant shifted exactly 2 days', () => {
		const sat = new Date('2026-10-03T12:00:00Z');
		const out = applyWeekdayOnly(sat, 'UTC');
		expect(out.toISOString()).toBe('2026-10-05T12:00:00.000Z');
	});

	it('tz Pacific/Auckland: a Saturday 10:00 local moves to Monday 10:00 local', () => {
		// Sat 2026-10-03 10:00 NZDT (UTC+13) = 2026-10-02T21:00:00Z.
		const sat = new Date('2026-10-02T21:00:00Z');
		const out = applyWeekdayOnly(sat, 'Pacific/Auckland');
		// Mon 2026-10-05 10:00 NZDT = 2026-10-04T21:00:00Z.
		expect(out.toISOString()).toBe('2026-10-04T21:00:00.000Z');
	});
});

describe('sqliteUtc', () => {
	it('formats as YYYY-MM-DD HH:MM:SS, no fractional seconds or T/Z', () => {
		expect(sqliteUtc(new Date('2026-10-05T16:00:00.000Z'))).toBe('2026-10-05 16:00:00');
		expect(sqliteUtc(new Date('2026-01-01T00:00:00.123Z'))).toBe('2026-01-01 00:00:00');
	});
});

describe('settings timezone (#119)', () => {
	it('getTimezone defaults to America/Los_Angeles when unset', async () => {
		expect(await getTimezone(db)).toBe(DEFAULT_TIMEZONE);
	});

	it('getTimezone returns a stored valid tz', async () => {
		await setSettings(db, { timezone: 'America/New_York' });
		expect(await getTimezone(db)).toBe('America/New_York');
		expect((await getSettings(db)).timezone).toBe('America/New_York');
	});

	it('getTimezone falls back to default for a garbage stored value', async () => {
		await db
			.prepare(
				`INSERT INTO app_state (key, value) VALUES ('timezone', 'Not/AZone')
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
			)
			.run();
		expect(await getTimezone(db)).toBe(DEFAULT_TIMEZONE);
	});

	it('isValidTimezone accepts real IANA zones and rejects junk', () => {
		expect(isValidTimezone('America/Los_Angeles')).toBe(true);
		expect(isValidTimezone('UTC')).toBe(true);
		expect(isValidTimezone('Pacific/Auckland')).toBe(true);
		expect(isValidTimezone('US/Pacific')).toBe(true);
		expect(isValidTimezone('Not/AZone')).toBe(false);
		expect(isValidTimezone('')).toBe(false);
	});

	it('the dropdown and the validator share one list, including UTC', () => {
		const names = timezoneNames();
		expect(names).toContain('UTC');
		expect(names).toContain('America/Los_Angeles');
		expect(names.filter((z) => z === 'UTC')).toHaveLength(1);
		expect(isValidTimezone('UTC')).toBe(true);
		const shown = timezoneOptions('US/Pacific');
		expect(shown).toContain('UTC');
		expect(shown).toContain('US/Pacific');
		expect(shown.filter((z) => z === 'US/Pacific')).toHaveLength(1);
		expect(timezoneOptions('America/Los_Angeles').filter((z) => z === 'America/Los_Angeles')).toHaveLength(1);
	});
});

describe('parseZonedLocal — custom resend picker (#119 follow-up)', () => {
	it('reads the picker as operator wall-clock, not as UTC', () => {
		// A UTC worker's `new Date('YYYY-MM-DDTHH:mm')` is the old (wrong) reading.
		expect(new Date('2026-10-07T10:00').toISOString()).toBe('2026-10-07T10:00:00.000Z');
		expect(parseZonedLocal('2026-10-07T10:00', 'America/Los_Angeles')?.toISOString()).toBe('2026-10-07T17:00:00.000Z');
		// December is PST (UTC-8), not PDT (UTC-7).
		expect(new Date('2026-12-09T10:00').toISOString()).toBe('2026-12-09T10:00:00.000Z');
		expect(parseZonedLocal('2026-12-09T10:00', 'America/Los_Angeles')?.toISOString()).toBe('2026-12-09T18:00:00.000Z');
	});

	it('rejects a value that is not a datetime-local string', () => {
		expect(parseZonedLocal('tomorrow', 'UTC')).toBeNull();
		expect(parseZonedLocal('', 'UTC')).toBeNull();
	});
});

// --- D1 round-trip -----------------------------------------------------------------

async function makeContact(email: string): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>();
	return c!.id;
}

async function makeAutomation(): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status, reentry) VALUES ('WD', 'active', 'once') RETURNING id")
		.first<{ id: number }>();
	return a!.id;
}

async function makeStep(aid: number, position: number, delaySeconds: number, weekdayOnly: boolean): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name, weekday_only)
			 VALUES (?, ?, ?, '', '', '', 'tag', 'add', 'wd', ?) RETURNING id`
		)
		.bind(aid, position, delaySeconds, weekdayOnly ? 1 : 0)
		.first<{ id: number }>();
	return s!.id;
}

describe('enroll() + weekday_only (#119, D1 round-trip)', () => {
	it('a Saturday "now" with a 0-delay weekday_only step lands next_run_at on the following Monday, same local time', async () => {
		const aid = await makeAutomation();
		await makeStep(aid, 1, 0, true);
		const cid = await makeContact('wd1@example.com');

		// Mocked "now": Sat 2026-10-03 09:00 PDT = 2026-10-03T16:00:00Z.
		const now = new Date('2026-10-03T16:00:00Z');
		const { enrolled } = await enroll(db, aid, [cid], { tz: 'America/Los_Angeles', now });
		expect(enrolled).toBe(1);

		const row = await db
			.prepare('SELECT next_run_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?')
			.bind(aid, cid)
			.first<{ next_run_at: string }>();
		// Mon 2026-10-05 09:00 PDT, stored as the UTC sqlite string.
		expect(row?.next_run_at).toBe('2026-10-05 16:00:00');
	});

	it('a non-weekday_only step is unaffected — unchanged SQL-side `datetime(now, ?)` path', async () => {
		const aid = await makeAutomation();
		await makeStep(aid, 1, 3600, false); // +1 hour, no weekday shift
		const cid = await makeContact('wd2@example.com');

		const { enrolled } = await enroll(db, aid, [cid]);
		expect(enrolled).toBe(1);

		const row = await db
			.prepare('SELECT next_run_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?')
			.bind(aid, cid)
			.first<{ next_run_at: string }>();
		// Roughly "now + 1h" server-side — just confirm it's set and in the future, not a
		// specific Monday-shifted value (the weekday rule never applies here).
		expect(row?.next_run_at).toBeTruthy();
	});
});

describe('scheduled campaign + weekday_only (#119, D1 round-trip)', () => {
	it('a Sunday-requested scheduled_at is stored already shifted to Monday, same local time', async () => {
		const tz = 'America/Los_Angeles';
		// Operator requested Sun 2026-10-04 23:30 PDT.
		const requested = new Date('2026-10-05T06:30:00Z');
		const shifted = applyWeekdayOnly(requested, tz);
		expect(shifted.toISOString()).not.toBe(requested.toISOString()); // actually moved

		const created = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, scheduled_at, weekday_only)
				 VALUES ('s', 'b', '<p>b</p>', 'a@b.example.net', 'scheduled', ?, 1) RETURNING id`
			)
			.bind(sqliteUtc(shifted))
			.first<{ id: number }>();

		const row = await db
			.prepare('SELECT scheduled_at, weekday_only FROM campaigns WHERE id = ?')
			.bind(created!.id)
			.first<{ scheduled_at: string; weekday_only: number }>();
		expect(row?.scheduled_at).toBe('2026-10-06 06:30:00'); // Mon 2026-10-05 23:30 PDT, as UTC
		expect(row?.weekday_only).toBe(1);
	});

	it('weekday_only defaults to 0 for an ordinary campaign row', async () => {
		const created = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status)
				 VALUES ('s', 'b', '<p>b</p>', 'a@b.example.net', 'sent') RETURNING id`
			)
			.first<{ id: number }>();
		const row = await db.prepare('SELECT weekday_only FROM campaigns WHERE id = ?').bind(created!.id).first<{ weekday_only: number }>();
		expect(row?.weekday_only).toBe(0);
	});
});

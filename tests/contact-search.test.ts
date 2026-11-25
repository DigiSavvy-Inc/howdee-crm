import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { buildContactSearch } from '../src/lib/server/contact-search';

const db = (env as any).DB as D1Database;

// Unique-prefixed test emails so cleanup is scoped and never touches other tests' rows.
const JANE_EMAIL = 'qa-search-jane@example.test';
const BOB_EMAIL = 'qa-search-bob@example.test';
const PROMO_EMAIL = 'qa-search-50%_off@example.test';
const TEST_EMAILS = [JANE_EMAIL, BOB_EMAIL, PROMO_EMAIL];

async function cleanup() {
	await db
		.prepare('DELETE FROM contacts WHERE email IN (?, ?, ?)')
		.bind(...TEST_EMAILS)
		.run();
}

beforeEach(cleanup);
afterEach(cleanup);

describe('buildContactSearch (pure)', () => {
	it('returns an empty where/binds for an empty string', () => {
		expect(buildContactSearch('')).toEqual({ where: '', binds: [] });
	});

	it('returns an empty where/binds for a whitespace-only string', () => {
		expect(buildContactSearch('   \t  ')).toEqual({ where: '', binds: [] });
	});

	it('#485: binds the raw text and matches with instr, never a LIKE pattern', () => {
		const { where, binds } = buildContactSearch('50%_off\\x');
		expect(binds.length).toBeGreaterThan(0);
		for (const b of binds) expect(b).toBe('50%_off\\x');
		expect(where).not.toMatch(/\bLIKE\b/);
		expect(where).toContain('instr(');
	});

	it('binds one value per ? placeholder in where', () => {
		const { where, binds } = buildContactSearch('jane doe');
		const placeholders = (where.match(/\?/g) ?? []).length;
		expect(placeholders).toBe(binds.length);
		expect(binds.length).toBe(7); // email, name, first_name, last_name, company, derived display name, linked company name
	});
});

describe('buildContactSearch (D1 round-trip)', () => {
	beforeEach(async () => {
		await db
			.prepare(
				`INSERT INTO contacts (email, first_name, last_name, name, subscribed, source)
				 VALUES (?, 'Jane', 'Doe', NULL, 1, 'test')`
			)
			.bind(JANE_EMAIL)
			.run();
		await db
			.prepare(
				`INSERT INTO contacts (email, first_name, last_name, name, subscribed, source)
				 VALUES (?, 'Bob', 'Ray', NULL, 1, 'test')`
			)
			.bind(BOB_EMAIL)
			.run();
		await db
			.prepare(
				`INSERT INTO contacts (email, first_name, last_name, name, subscribed, source)
				 VALUES (?, 'Promo', 'Contact', NULL, 1, 'test')`
			)
			.bind(PROMO_EMAIL)
			.run();
	});

	async function matchingEmails(q: string): Promise<string[]> {
		const { where, binds } = buildContactSearch(q);
		const res = await db
			.prepare(`SELECT id, email FROM contacts ${where}`)
			.bind(...binds)
			.all<{ id: number; email: string }>();
		return res.results.map((r) => r.email);
	}

	it('"jane doe" matches a contact with only first_name/last_name set (no combined name)', async () => {
		const emails = await matchingEmails('jane doe');
		expect(emails).toContain(JANE_EMAIL);
		expect(emails).not.toContain(BOB_EMAIL);
	});

	it('a query containing literal %/_ matches only the exact substring, not as wildcards', async () => {
		const emails = await matchingEmails('50%_off');
		expect(emails).toContain(PROMO_EMAIL);
		expect(emails).not.toContain(JANE_EMAIL);
		expect(emails).not.toContain(BOB_EMAIL);
	});

	it('a non-matching query returns none of the test rows', async () => {
		const emails = await matchingEmails('zzzzqqqq-nomatch');
		const hits = emails.filter((e) => TEST_EMAILS.includes(e));
		expect(hits.length).toBe(0);
	});
});

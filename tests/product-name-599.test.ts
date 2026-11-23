import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_APP_NAME, DEFAULT_SHORT_NAME, PRODUCT_NAME } from '../src/lib/branding';
import { buildManifest, getBranding } from '../src/lib/server/branding';
import { USER_AGENT } from '../src/lib/server/user-agent';
import { forwardNameSuffix } from '../src/lib/server/reply-forward';
import { jobEmailSubject } from '../src/lib/server/ai/jobs-email';
import pkg from '../package.json';

// #599: "Howdee CRM" is the product name (#707). One constant; a stored name still wins.

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.prepare(`DELETE FROM app_state WHERE key IN ('app_name', 'app_short_name', 'logo_key')`).run();
});

describe('working product name', () => {
	it('defaults come from one constant', () => {
		expect(PRODUCT_NAME).toBe('Howdee CRM');
		expect(DEFAULT_APP_NAME).toBe(PRODUCT_NAME);
		expect(DEFAULT_SHORT_NAME).toBe(PRODUCT_NAME);
		expect(USER_AGENT).toBe('howdee-crm');
		expect(pkg.name).toBe('howdee-crm');
		expect(pkg.private).toBe(true);
	});

	it('an install without a stored name shows Howdee CRM', async () => {
		const b = await getBranding(db);
		expect(b).toMatchObject({ appName: 'Howdee CRM', shortName: 'Howdee CRM' });
		expect(buildManifest(b)).toMatchObject({ name: 'Howdee CRM', short_name: 'Howdee CRM' });
	});

	it('an install with a stored name keeps it everywhere', async () => {
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('app_name', 'DS Email Marketing'), ('app_short_name', 'DS Email')`)
			.run();
		const b = await getBranding(db);
		expect(b).toMatchObject({ appName: 'DS Email Marketing', shortName: 'DS Email' });
		expect(buildManifest(b)).toMatchObject({ name: 'DS Email Marketing', short_name: 'DS Email' });
		expect(forwardNameSuffix(b.appName)).toBe('via DS Email Marketing');
		const now = new Date('2026-10-19T15:00:00Z');
		expect(jobEmailSubject({ name: 'Digest', schedule_kind: 'weekly' }, now, 'UTC', b.appName)).toBe(
			'DS Email Marketing digest, week of October 19, 2026'
		);
	});
});

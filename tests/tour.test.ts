import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { POST as dismissTour } from '../src/routes/api/tour/dismiss/+server';
import { findActiveUserById } from '../src/lib/server/users';
import { STEPS } from '../src/lib/tour-steps';
import { isSetupWizardUrl, tourShouldAutoStart } from '../src/lib/tour-start';

const db = (env as any).DB as D1Database;

const PREFIX = 'tour-test-';

async function cleanup() {
	await db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`).run();
}

function ev(user: { id: number } | null) {
	return {
		request: new Request('https://app.test/api/tour/dismiss', { method: 'POST' }),
		platform: { env },
		url: new URL('https://app.test/api/tour/dismiss'),
		params: {},
		locals: { user, authed: !!user }
	} as any;
}

describe('POST /api/tour/dismiss', () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it('401s with no session user', async () => {
		const res = await dismissTour(ev(null));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
	});

	it('marks the tour dismissed and findActiveUserById reports tourSeen: true', async () => {
		const insert = await db
			.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member')`)
			.bind(`${PREFIX}jdoe`)
			.run();
		const userId = insert.meta.last_row_id as number;

		const before = await findActiveUserById(db, userId);
		expect(before?.tourSeen).toBe(false);

		const res = await dismissTour(ev({ id: userId }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const row = await db
			.prepare(`SELECT tour_dismissed_at FROM users WHERE id = ?`)
			.bind(userId)
			.first<{ tour_dismissed_at: string | null }>();
		expect(row?.tour_dismissed_at).toBeTruthy();

		const after = await findActiveUserById(db, userId);
		expect(after?.tourSeen).toBe(true);
	});
});

describe('tour steps content', () => {
	it('has unique ids', () => {
		const ids = STEPS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every target selector starts with [data-tour=', () => {
		for (const step of STEPS) {
			if (step.target !== null) {
				expect(step.target.startsWith('[data-tour=')).toBe(true);
			}
		}
	});

	it('has no Webhooks nav step — Webhooks lives under Settings (#136)', () => {
		expect(STEPS.some((s) => s.target === '[data-tour="nav-/webhooks"]')).toBe(false);
		expect(STEPS.find((s) => s.id === 'settings')?.body).toContain('Webhooks');
	});

	it('points the Settings step at the user chip — Settings lives in the avatar menu (#141)', () => {
		expect(STEPS.some((s) => s.target === '[data-tour="nav-/settings"]')).toBe(false);
		const settings = STEPS.find((s) => s.id === 'settings');
		expect(settings?.target).toBe('[data-tour="user"]');
		expect(settings?.body).toContain('Settings, the tour, and sign-out live under your avatar');
	});
});

describe('tour auto-start (#731)', () => {
	const u = (path: string) => new URL(`https://app.test${path}`);
	const fresh = { tourSeen: false, seenLocal: false };

	it('does not open over the first-run setup wizard', () => {
		expect(isSetupWizardUrl(u('/settings/setup?first=1'))).toBe(true);
		expect(isSetupWizardUrl(u('/settings/setup?wizard=address'))).toBe(true);
		expect(isSetupWizardUrl(u('/settings/setup?wizard=nonsense'))).toBe(true);
		expect(isSetupWizardUrl(u('/settings/setup/?wizard=sending'))).toBe(true);
		expect(tourShouldAutoStart({ ...fresh, url: u('/settings/setup?first=1') })).toBe(false);
		expect(tourShouldAutoStart({ ...fresh, url: u('/settings/setup?wizard=test') })).toBe(false);
	});

	it('opens for a new user on any other page, including the plain checklist', () => {
		expect(tourShouldAutoStart({ ...fresh, url: u('/') })).toBe(true);
		expect(tourShouldAutoStart({ ...fresh, url: u('/contacts?wizard=address') })).toBe(true);
		expect(tourShouldAutoStart({ ...fresh, url: u('/settings/setup') })).toBe(true);
		expect(tourShouldAutoStart({ ...fresh, url: u('/settings/setup?first=0') })).toBe(true);
	});

	it('keeps the first-time rule: never once seen in the DB or this browser', () => {
		expect(tourShouldAutoStart({ tourSeen: true, seenLocal: false, url: u('/') })).toBe(false);
		expect(tourShouldAutoStart({ tourSeen: false, seenLocal: true, url: u('/') })).toBe(false);
	});
});

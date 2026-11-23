import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	addLabel,
	automationsListQuery,
	resolveStatusFilter,
	STATUS_COOKIE
} from '../src/lib/server/automation-labels';
import { automationsFilterUrl, tagParam } from '../src/lib/automations-filter';
import { load } from '../src/routes/automations/+page.server';

// #200: status filter as segmented buttons, persisted in the `automations_status` cookie.
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM tick_log'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations')
	]);
});

async function makeAutomation(name: string, status: 'draft' | 'active' | 'paused'): Promise<number> {
	const a = await db
		.prepare('INSERT INTO automations (name, status) VALUES (?, ?) RETURNING id')
		.bind(name, status)
		.first<{ id: number }>();
	return a!.id;
}

type SetCall = { name: string; value: string; opts: Record<string, unknown> };

function fakeEvent(qs: string, cookie?: string) {
	const sets: SetCall[] = [];
	const url = new URL(`https://app.test/automations${qs}`);
	const event = {
		platform: { env },
		url,
		cookies: {
			get: (name: string) => (name === STATUS_COOKIE ? cookie : undefined),
			set: (name: string, value: string, opts: Record<string, unknown>) => sets.push({ name, value, opts })
		}
	} as any;
	return { event, sets };
}

describe('resolveStatusFilter', () => {
	it('param beats cookie, cookie beats none, invalid values are ignored', () => {
		expect(resolveStatusFilter('paused', 'draft')).toEqual({ status: 'paused', write: 'paused' });
		expect(resolveStatusFilter('all', 'draft')).toEqual({ status: null, write: 'all' });
		expect(resolveStatusFilter(null, 'draft')).toEqual({ status: 'draft', write: null });
		expect(resolveStatusFilter(null, 'all')).toEqual({ status: null, write: null });
		expect(resolveStatusFilter(null, undefined)).toEqual({ status: null, write: null });
		expect(resolveStatusFilter(null, 'bogus')).toEqual({ status: null, write: null });
		expect(resolveStatusFilter('bogus', 'active')).toEqual({ status: 'active', write: null });
	});
});

describe('/automations load — status cookie', () => {
	it('writes the cookie for an explicit ?status= and filters by it', async () => {
		await makeAutomation('A', 'active');
		await makeAutomation('P', 'paused');
		const { event, sets } = fakeEvent('?status=paused', 'active');
		const data = (await load(event)) as any;
		expect(data.filter.status).toBe('paused');
		expect(data.automations.map((a: any) => a.name)).toEqual(['P']);
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({
			name: STATUS_COOKIE,
			value: 'paused',
			opts: { path: '/automations', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 }
		});
	});

	it('applies the cookie on a clean URL without rewriting it', async () => {
		await makeAutomation('A', 'active');
		await makeAutomation('P', 'paused');
		const { event, sets } = fakeEvent('', 'paused');
		const data = (await load(event)) as any;
		expect(data.filter.status).toBe('paused');
		expect(data.automations.map((a: any) => a.name)).toEqual(['P']);
		expect(sets).toHaveLength(0);
	});

	it('?status=all clears the filter and writes all', async () => {
		await makeAutomation('A', 'active');
		await makeAutomation('P', 'paused');
		const { event, sets } = fakeEvent('?status=all', 'paused');
		const data = (await load(event)) as any;
		expect(data.filter.status).toBeNull();
		expect(data.automations).toHaveLength(2);
		expect(sets.map((s) => s.value)).toEqual(['all']);
	});

	it('ignores an invalid cookie', async () => {
		await makeAutomation('A', 'active');
		await makeAutomation('P', 'paused');
		const { event, sets } = fakeEvent('', 'nonsense');
		const data = (await load(event)) as any;
		expect(data.filter.status).toBeNull();
		expect(data.automations).toHaveLength(2);
		expect(sets).toHaveLength(0);
	});

	it('cookie-applied status combines with a tag param (#432)', async () => {
		const a = await makeAutomation('A', 'active');
		const p = await makeAutomation('P', 'paused');
		await makeAutomation('P2', 'paused');
		await addLabel(db, a, 'nurture');
		await addLabel(db, p, 'nurture');
		const { event } = fakeEvent('?tag=nurture', 'paused');
		const data = (await load(event)) as any;
		expect(data.filter).toEqual({ tag: 'nurture', status: 'paused' });
		expect(data.automations.map((r: any) => r.name)).toEqual(['P']);
		expect(data.statusCounts).toEqual({ all: 2, active: 1, paused: 1, draft: 0 });
	});

	it('an old ?label= link still filters (#432)', async () => {
		const a = await makeAutomation('A', 'active');
		await makeAutomation('B', 'active');
		await addLabel(db, a, 'nurture');
		const { event } = fakeEvent('?label=nurture');
		const data = (await load(event)) as any;
		expect(data.filter.tag).toBe('nurture');
		expect(data.automations.map((r: any) => r.name)).toEqual(['A']);
	});

	it('?tag= wins over ?label=', async () => {
		const a = await makeAutomation('A', 'active');
		const b = await makeAutomation('B', 'active');
		await addLabel(db, a, 'nurture');
		await addLabel(db, b, 'onboarding');
		const { event } = fakeEvent('?tag=onboarding&label=nurture');
		const data = (await load(event)) as any;
		expect(data.automations.map((r: any) => r.name)).toEqual(['B']);
	});
});

describe('automationsListQuery statusCounts', () => {
	it('counts per status under the label filter, ignoring the status filter', async () => {
		const a1 = await makeAutomation('A1', 'active');
		const a2 = await makeAutomation('A2', 'active');
		const d1 = await makeAutomation('D1', 'draft');
		await makeAutomation('P1', 'paused'); // unlabelled
		for (const id of [a1, a2, d1]) await addLabel(db, id, 'nurture');

		const all = await automationsListQuery(db, { label: null, status: 'draft' });
		expect(all.statusCounts).toEqual({ all: 4, active: 2, paused: 1, draft: 1 });
		expect(all.matched).toBe(1);

		const byLabel = await automationsListQuery(db, { label: 'nurture', status: 'active' });
		expect(byLabel.statusCounts).toEqual({ all: 3, active: 2, paused: 0, draft: 1 });
		expect(byLabel.matched).toBe(2);
	});
});

describe('automationsFilterUrl', () => {
	it('keeps the tag when switching status', () => {
		const f = { status: 'paused', tag: 'nurture' };
		expect(automationsFilterUrl(f, { status: 'active' })).toBe('?status=active&tag=nurture');
		expect(automationsFilterUrl(f, { status: 'all' })).toBe('?status=all&tag=nurture');
		expect(automationsFilterUrl({ status: null, tag: 'nurture' }, { status: 'draft' })).toBe('?tag=nurture&status=draft');
	});

	it('carries the effective status into tag links and drops nulls', () => {
		const f = { status: 'paused', tag: null };
		expect(automationsFilterUrl(f, { tag: 'x' })).toBe('?status=paused&tag=x');
		expect(automationsFilterUrl(f)).toBe('?status=paused');
		expect(automationsFilterUrl({ status: null, tag: null })).toBe('?');
	});

	it('reads ?tag= first, then a legacy ?label= (#432)', () => {
		expect(tagParam(new URLSearchParams('tag=a&label=b'))).toBe('a');
		expect(tagParam(new URLSearchParams('label=b'))).toBe('b');
		expect(tagParam(new URLSearchParams(''))).toBe('');
	});
});

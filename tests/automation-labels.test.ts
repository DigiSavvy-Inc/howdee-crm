import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	normalizeLabel,
	addLabel,
	removeLabel,
	listLabels,
	copyLabels,
	allLabelsWithCounts,
	labelsByAutomation,
	automationsListQuery,
	MAX_LABELS_PER_AUTOMATION
} from '../src/lib/server/automation-labels';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listAutomations } from '../src/routes/api/v1/automations/+server';

// #74: free-form labels on automations — organisation only, not a `lists(kind='tag')` grouping.
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		// Campaigns reference steps (automation_step_id) — clear them first.
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		// Null self-referencing parents next — a bulk DELETE trips the FK otherwise.
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeAutomation(
	name: string,
	status: 'draft' | 'active' | 'paused' = 'active'
): Promise<number> {
	const a = await db
		.prepare('INSERT INTO automations (name, status) VALUES (?, ?) RETURNING id')
		.bind(name, status)
		.first<{ id: number }>();
	return a!.id;
}

function ev(path: string, token: string | undefined) {
	const url = new URL(`https://app.test${path}`);
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	return {
		request: new Request(url, { method: 'GET', headers }),
		platform: { env },
		url,
		params: {}
	} as any;
}

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

describe('normalizeLabel', () => {
	it('trims and collapses internal whitespace', () => {
		expect(normalizeLabel('  Onboarding  ')).toBe('Onboarding');
		expect(normalizeLabel('big   nurture   flow')).toBe('big nurture flow');
	});
	it('rejects too-long and empty labels', () => {
		expect(normalizeLabel('a'.repeat(31))).toBeNull();
		expect(normalizeLabel('')).toBeNull();
		expect(normalizeLabel('   ')).toBeNull();
	});
	it('accepts the boundary lengths', () => {
		expect(normalizeLabel('a')).toBe('a');
		expect(normalizeLabel('a'.repeat(30))).toBe('a'.repeat(30));
	});
});

describe('addLabel / listLabels / removeLabel', () => {
	it('dedupes case-insensitively', async () => {
		const aid = await makeAutomation('A');
		expect(await addLabel(db, aid, 'Nurture')).toEqual({ ok: true, label: 'Nurture' });
		expect(await addLabel(db, aid, 'nurture')).toEqual({ ok: true, label: 'nurture' });
		expect(await listLabels(db, aid)).toEqual(['Nurture']);
	});

	it('rejects invalid input with the documented message', async () => {
		const aid = await makeAutomation('A');
		expect(await addLabel(db, aid, '   ')).toEqual({ ok: false, error: 'Tags are 1–30 characters.' });
		expect(await addLabel(db, aid, 'x'.repeat(31))).toEqual({ ok: false, error: 'Tags are 1–30 characters.' });
	});

	it('caps at MAX_LABELS_PER_AUTOMATION', async () => {
		const aid = await makeAutomation('A');
		for (let i = 0; i < MAX_LABELS_PER_AUTOMATION; i++) {
			expect((await addLabel(db, aid, `label-${i}`)).ok).toBe(true);
		}
		expect(await listLabels(db, aid)).toHaveLength(MAX_LABELS_PER_AUTOMATION);
		const over = await addLabel(db, aid, 'one-too-many');
		expect(over).toEqual({ ok: false, error: 'An automation can have up to 10 tags.' });

		// Re-adding an existing label at the cap is still a no-op success.
		expect(await addLabel(db, aid, 'label-0')).toEqual({ ok: true, label: 'label-0' });
	});

	it('removes a label', async () => {
		const aid = await makeAutomation('A');
		await addLabel(db, aid, 'demo');
		await removeLabel(db, aid, 'demo');
		expect(await listLabels(db, aid)).toEqual([]);
	});
});

describe('copyLabels', () => {
	it('copies every label from one automation to another', async () => {
		const from = await makeAutomation('Source');
		const to = await makeAutomation('Dest');
		await addLabel(db, from, 'onboarding');
		await addLabel(db, from, 'demo');
		await copyLabels(db, from, to);
		expect(await listLabels(db, to)).toEqual(['demo', 'onboarding']);
		// Source is untouched.
		expect(await listLabels(db, from)).toEqual(['demo', 'onboarding']);
	});
});

describe('allLabelsWithCounts', () => {
	it('orders by count desc, then label', async () => {
		const a = await makeAutomation('A');
		const b = await makeAutomation('B');
		const c = await makeAutomation('C');
		await addLabel(db, a, 'nurture');
		await addLabel(db, b, 'nurture');
		await addLabel(db, c, 'onboarding');
		const counts = await allLabelsWithCounts(db);
		expect(counts).toEqual([
			{ label: 'nurture', count: 2 },
			{ label: 'onboarding', count: 1 }
		]);
	});
});

describe('labelsByAutomation', () => {
	it('chunks beyond 90 ids and maps only labelled automations', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 95; i++) {
			ids.push(await makeAutomation(`Bulk ${i}`));
		}
		await addLabel(db, ids[0], 'first');
		await addLabel(db, ids[94], 'last');

		const map = await labelsByAutomation(db, ids);
		expect(map.get(ids[0])).toEqual(['first']);
		expect(map.get(ids[94])).toEqual(['last']);
		expect(map.get(ids[50])).toBeUndefined();
		expect(map.size).toBe(2);
	});
});

describe('automationsListQuery', () => {
	it('filters by status and by label, combinable', async () => {
		const active = await makeAutomation('Active One', 'active');
		const paused = await makeAutomation('Paused One', 'paused');
		await addLabel(db, active, 'nurture');
		await addLabel(db, paused, 'nurture');

		const all = await automationsListQuery(db, { label: null, status: null });
		expect(all.total).toBe(2);
		expect(all.matched).toBe(2);

		const byLabel = await automationsListQuery(db, { label: 'nurture', status: null });
		expect(byLabel.matched).toBe(2);
		expect(byLabel.total).toBe(2);

		const byLabelAndStatus = await automationsListQuery(db, { label: 'nurture', status: 'active' });
		expect(byLabelAndStatus.matched).toBe(1);
		expect(byLabelAndStatus.automations[0].id).toBe(active);

		const noMatch = await automationsListQuery(db, { label: 'ghost', status: null });
		expect(noMatch.matched).toBe(0);
		expect(noMatch.total).toBe(2); // total stays unfiltered
	});
});

describe('GET /api/v1/automations label filter', () => {
	it('returns labels on every row and filters by ?label=', async () => {
		const nurtureA = await makeAutomation('Nurture A', 'active');
		const nurtureB = await makeAutomation('Nurture B', 'paused');
		const plain = await makeAutomation('Plain', 'active');
		await addLabel(db, nurtureA, 'nurture');
		await addLabel(db, nurtureB, 'nurture');

		const token = await makeKey('read');
		const all = await jsonOf(await listAutomations(ev('/api/v1/automations', token)));
		const plainRow = all.data.find((a: any) => a.id === plain);
		expect(plainRow.labels).toEqual([]);

		const filtered = await jsonOf(await listAutomations(ev('/api/v1/automations?label=nurture', token)));
		expect(filtered.data).toHaveLength(2);
		expect(filtered.data.map((a: any) => a.id).sort()).toEqual([nurtureA, nurtureB].sort());
		for (const row of filtered.data) expect(row.labels).toEqual(['nurture']);

		const combined = await jsonOf(
			await listAutomations(ev('/api/v1/automations?label=nurture&status=paused', token))
		);
		expect(combined.data).toHaveLength(1);
		expect(combined.data[0].id).toBe(nurtureB);
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { bulkTargetOptions, looksArchived, pickableTarget, RULES_SEGMENT_REASON } from '../src/lib/bulk-targets';
import { firstEnabled, searchRows, stepEnabled } from '../src/lib/search-select';
import { actions as contactActions } from '../src/routes/contacts/+page.server';
import { actions as listActions } from '../src/routes/lists/[id]/+page.server';
import bulkBar from '../src/lib/components/ContactBulkBar.svelte?raw';
import contactsPage from '../src/routes/contacts/+page.svelte?raw';
import listPage from '../src/routes/lists/[id]/+page.svelte?raw';
import searchSelect from '../src/lib/components/SearchSelect.svelte?raw';

// #688: the bulk bar's list / segment targets are one searchable picker — live groups before
// archived ones, rules segments listed but not pickable, and refused by the server too.

const groups = [
	{ id: 1, name: 'zz-archived · Old webinar', kind: 'list', count: 3 },
	{ id: 2, name: 'Newsletter', kind: 'list', count: 1240 },
	{ id: 3, name: 'Hot leads', kind: 'segment', dynamic: true },
	{ id: 4, name: 'VIP', kind: 'segment', count: 1 },
	{ id: 5, name: 'Customers (archived)', kind: 'list', archived: true, count: 9 },
	{ id: 6, name: 'Partners', kind: 'list', count: 0 }
];

describe('#688 bulk target options', () => {
	it('groups Lists then Segments, live before archived, keeping the given order', () => {
		const opts = bulkTargetOptions(groups);
		expect(opts.map((o) => o.value)).toEqual([2, 6, 1, 5, 3, 4]);
		expect(opts.map((o) => o.group)).toEqual(['Lists', 'Lists', 'Lists', 'Lists', 'Segments', 'Segments']);
	});

	it('shows counts and marks rules segments not selectable with the reason', () => {
		const opts = bulkTargetOptions(groups);
		expect(opts.find((o) => o.value === 2)?.detail).toBe('1,240 contacts');
		expect(opts.find((o) => o.value === 4)?.detail).toBe('1 contact');
		const rules = opts.find((o) => o.value === 3)!;
		expect(rules.disabled).toBe(true);
		expect(rules.detail).toBe(RULES_SEGMENT_REASON);
		expect(pickableTarget(opts, 3)).toBe(false);
		expect(pickableTarget(opts, 4)).toBe(true);
		expect(pickableTarget(opts, '')).toBe(false);
		expect(pickableTarget(opts, 99)).toBe(false);
	});

	it('spots archived names', () => {
		expect(looksArchived({ name: 'zz-archived · x' })).toBe(true);
		expect(looksArchived({ name: 'Plain (archived)' })).toBe(true);
		expect(looksArchived({ name: 'Newsletter' })).toBe(false);
		expect(looksArchived({ name: 'Newsletter', archived: true })).toBe(true);
	});

	it('archived groups stay findable by search', () => {
		const rows = searchRows(bulkTargetOptions(groups), 'webinar', { allowEmpty: { label: 'New segment…', always: true } });
		expect(rows.flat.map((r) => r.label)).toEqual(['New segment…', 'zz-archived · Old webinar']);
	});

	it('keyboard steps skip disabled rows; the empty row stays first while typing', () => {
		const opts = bulkTargetOptions(groups.filter((g) => g.kind === 'segment'));
		const rows = searchRows(opts, '', { allowEmpty: { label: 'New segment…', always: true } });
		expect(rows.flat.map((r) => r.label)).toEqual(['New segment…', 'Hot leads', 'VIP']);
		expect(stepEnabled(rows.flat, 0, 1)).toBe(2); // skips Hot leads
		expect(stepEnabled(rows.flat, 2, -1)).toBe(0);
		expect(stepEnabled(rows.flat, 2, 1)).toBe(0); // wraps
		const onlyDisabled = searchRows(opts, 'hot').flat;
		expect(firstEnabled(onlyDisabled)).toBe(0);
		expect(stepEnabled(onlyDisabled, 0, 1)).toBe(0);
		// Without `always`, existing callers keep the old behaviour.
		expect(searchRows(opts, 'v', { allowEmpty: { label: 'Any' } }).flat.map((r) => r.label)).toEqual(['VIP']);
	});
});

describe('#688 wiring (source level)', () => {
	it('the bar uses SearchSelect for list and segment targets with the same field names', () => {
		expect(bulkBar).toContain('import SearchSelect');
		expect(bulkBar).toMatch(/<SearchSelect\s+name="segment_id"/);
		expect(bulkBar).toMatch(/<SearchSelect\s+name="list_id"/);
		expect(bulkBar).toContain('name="new_segment"');
		expect(bulkBar).not.toContain('<select name="segment_id"');
		expect(bulkBar).not.toContain('<select name="list_id"');
	});
	it('both pages pass rules segments to the picker', () => {
		expect(contactsPage).not.toContain('data.segments.filter((s) => !s.dynamic)');
		expect(listPage).not.toMatch(/addTargets=\{[^}]*!x\.dynamic/);
	});
	it('SearchSelect never picks a disabled row', () => {
		expect(searchSelect).toContain('if (!rowEnabled(r)) return;');
		expect(searchSelect).toContain('aria-disabled');
	});
});

// --- Server: a rules segment is refused as an add target ---------------------------------
const db = (env as any).DB as D1Database;
function form(fields: Record<string, string>): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return fd;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('#688 server refuses a rules segment as an add target', () => {
	it('on /contacts and on /lists/[id]', async () => {
		const c = (await db.prepare("INSERT INTO contacts (email) VALUES ('a@b.test') RETURNING id").first<{ id: number }>())!.id;
		const rules = JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'is', value: 'yes' }] });
		const seg = (await db
			.prepare("INSERT INTO lists (name, kind, rules) VALUES ('Rules seg', 'segment', ?) RETURNING id")
			.bind(rules)
			.first<{ id: number }>())!.id;
		const page = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Page list', 'list') RETURNING id").first<{ id: number }>())!.id;

		const viaContacts = await contactActions.addToSegment({
			platform: { env },
			request: new Request('https://app.test/contacts?/addToSegment', {
				method: 'POST',
				body: form({ segment_id: String(seg), contact_ids: String(c) })
			})
		} as any);
		expect(viaContacts).toMatchObject({ status: 400 });

		const viaList = await listActions.addToSegment({
			platform: { env },
			params: { id: String(page) },
			request: new Request(`https://app.test/lists/${page}?/addToSegment`, {
				method: 'POST',
				body: form({ segment_id: String(seg), contact_ids: String(c) })
			})
		} as any);
		expect(viaList).toMatchObject({ status: 400 });

		const n = await db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?').bind(seg).first<{ n: number }>();
		expect(n?.n).toBe(0);
	});
});

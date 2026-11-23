import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { load, actions } from '../src/routes/lists/[id]/+page.server';
import { POST as bulkApi } from '../src/routes/api/v1/contacts/bulk/+server';
import { generateApiKey } from '../src/lib/server/api-keys';
import { parseRules } from '../src/lib/server/segment-query';
import { exclusionTagName } from '../src/lib/segment-exclusion';
import bulkBar from '../src/lib/components/ContactBulkBar.svelte?raw';
import groupsPage from '../src/routes/groups/[kind]/+page.svelte?raw';
import automationsPage from '../src/routes/automations/+page.svelte?raw';
import conversationsPage from '../src/routes/conversations/+page.svelte?raw';

// "Exclude from this segment": a dynamic segment has no membership rows, so the bulk bar
// used to offer no way out of one (its "Remove from" picker never listed the segment).
// Now the selection gets the segment's exclusion tag and the segment a `tag is absent`
// rule — once; a later run only tags. Shared by the page action and the Data API.
const db = (env as any).DB as D1Database;

type Fields = Record<string, string | string[]>;
function form(fields: Fields): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
	return fd;
}
function loadEvent(listId: number, qs = '') {
	return { platform: { env }, params: { id: String(listId) }, url: new URL(`https://app.test/lists/${listId}${qs}`) } as any;
}
const run = async (listId: number, qs = '') => (await load(loadEvent(listId, qs))) as any;
function actionEvent(action: string, listId: number, fields: Fields) {
	return {
		platform: { env },
		params: { id: String(listId) },
		request: new Request(`https://app.test/lists/${listId}?/${action}`, { method: 'POST', body: form(fields) })
	} as any;
}
async function contact(email: string, source: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email, source, subscribed) VALUES (?, ?, 1) RETURNING id').bind(email, source).first<{ id: number }>())!.id;
}
async function group(name: string, kind: string, rules: unknown = null): Promise<number> {
	return (await db
		.prepare('INSERT INTO lists (name, kind, rules) VALUES (?, ?, ?) RETURNING id')
		.bind(name, kind, rules ? JSON.stringify(rules) : null)
		.first<{ id: number }>())!.id;
}
async function tagsOf(contactId: number): Promise<string[]> {
	const r = await db
		.prepare(
			`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id
			 WHERE lm.contact_id = ? AND l.kind = 'tag' ORDER BY l.name`
		)
		.bind(contactId)
		.all<{ name: string }>();
	return r.results.map((x) => x.name);
}
async function storedRules(id: number) {
	const r = await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(id).first<{ rules: string | null }>();
	return parseRules(r?.rules);
}
const emails = (data: any) => data.members.map((m: any) => m.email).sort();

const COLD = { match: 'all', rules: [{ field: 'source', op: 'is', value: 'cold' }] };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM api_keys')
	]);
});

/** Segment "Cold" = source is cold → ann, bob, cat. */
async function fixture() {
	const ann = await contact('ann@x.test', 'cold');
	const bob = await contact('bob@x.test', 'cold');
	const cat = await contact('cat@x.test', 'cold');
	const seg = await group('Cold', 'segment', COLD);
	return { ann, bob, cat, seg };
}

describe('exclude from a dynamic segment (/lists/[id] ?/excludeFromSegment)', () => {
	it('tags the selection and adds a "tag is absent" rule; the member table drops them', async () => {
		const f = await fixture();
		expect(emails(await run(f.seg))).toEqual(['ann@x.test', 'bob@x.test', 'cat@x.test']);

		const out = await actions.excludeFromSegment(actionEvent('excludeFromSegment', f.seg, { contact_ids: String(f.bob) }));
		expect(out).toMatchObject({ affected: 1, skipped: 0 });
		expect((out as any).bulkSuccess).toMatch(/^Excluded 1 from “Cold”/);

		expect(await tagsOf(f.bob)).toEqual(['excluded: Cold']);
		expect(exclusionTagName('Cold')).toBe('excluded: Cold');
		const rules = await storedRules(f.seg);
		expect(rules).toEqual({ match: 'all', rules: [...COLD.rules, { field: 'tag', op: 'not', value: 'excluded: Cold' }] });

		const after = await run(f.seg);
		expect(emails(after)).toEqual(['ann@x.test', 'cat@x.test']);
		expect(after.total).toBe(2);
	});

	it('a second run only tags (one rule, ever); removing the tag lets a contact back in', async () => {
		const f = await fixture();
		await actions.excludeFromSegment(actionEvent('excludeFromSegment', f.seg, { contact_ids: String(f.bob) }));
		const again = await actions.excludeFromSegment(actionEvent('excludeFromSegment', f.seg, { contact_ids: [String(f.bob), String(f.cat)] }));
		expect(again).toMatchObject({ affected: 1, skipped: 1 });
		expect((again as any).bulkSuccess).toMatch(/1 already excluded/);
		expect((await storedRules(f.seg))!.rules).toHaveLength(2);
		expect(emails(await run(f.seg))).toEqual(['ann@x.test']);

		// Drop the tag from bob: the rule stays, bob is a member again.
		await db
			.prepare(`DELETE FROM list_members WHERE contact_id = ? AND list_id = (SELECT id FROM lists WHERE kind = 'tag' AND name = ?)`)
			.bind(f.bob, 'excluded: Cold')
			.run();
		expect(emails(await run(f.seg))).toEqual(['ann@x.test', 'bob@x.test']);
	});

	it('"all matching" + the page filter excludes only the intersection', async () => {
		const f = await fixture();
		const out = await actions.excludeFromSegment(actionEvent('excludeFromSegment', f.seg, { all: '1', q: 'cat' }));
		expect(out).toMatchObject({ affected: 1 });
		expect(await tagsOf(f.cat)).toEqual(['excluded: Cold']);
		expect(await tagsOf(f.ann)).toEqual([]);
		expect(emails(await run(f.seg))).toEqual(['ann@x.test', 'bob@x.test']);
	});

	it('refuses a hand-picked segment (remove them instead) and changes nothing', async () => {
		const ann = await contact('ann@x.test', 'cold');
		const picked = await group('Picked', 'segment');
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(picked, ann).run();
		const res = await actions.excludeFromSegment(actionEvent('excludeFromSegment', picked, { contact_ids: String(ann) }));
		expect((res as any).status).toBe(400);
		expect((res as any).data.bulkError).toMatch(/isn't a dynamic segment/);
		expect(await tagsOf(ann)).toEqual([]);
		expect(await storedRules(picked)).toBeNull();
	});

	it('refuses a segment matching ANY of several rules, before tagging anyone', async () => {
		const ann = await contact('ann@x.test', 'cold');
		const any = await group('Either', 'segment', {
			match: 'any',
			rules: [
				{ field: 'source', op: 'is', value: 'cold' },
				{ field: 'source', op: 'is', value: 'warm' }
			]
		});
		const res = await actions.excludeFromSegment(actionEvent('excludeFromSegment', any, { contact_ids: String(ann) }));
		expect((res as any).status).toBe(400);
		expect((res as any).data.bulkError).toMatch(/matches ANY of its rules/);
		expect(await tagsOf(ann)).toEqual([]);
		expect((await storedRules(any))!.rules).toHaveLength(2);
		// The tag may exist (find-or-create ran) but nobody carries it and no rule names it.
		expect(await db.prepare('SELECT COUNT(*) AS n FROM list_members').first<{ n: number }>()).toMatchObject({ n: 0 });
	});
});

describe('POST /api/v1/contacts/bulk exclude_segment', () => {
	async function key(): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
			.bind('t', k.tokenHash, k.prefix, k.last4, 'read_write')
			.run();
		return k.token;
	}
	function call(token: string, body: unknown) {
		const url = new URL('https://app.test/api/v1/contacts/bulk');
		return bulkApi({
			request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
			platform: { env },
			url,
			params: {}
		} as any);
	}
	const json = async (res: Response) => JSON.parse(await res.text());

	it('takes the segment by name or id and needs one', async () => {
		const f = await fixture();
		const t = await key();
		expect((await call(t, { action: 'exclude_segment', ids: [f.bob] })).status).toBe(400);
		const res = await call(t, { action: 'exclude_segment', segment: 'Cold', ids: [f.bob] });
		expect(res.status).toBe(200);
		expect((await json(res)).data).toMatchObject({ action: 'exclude_segment', matched: 1, affected: 1 });
		expect(await tagsOf(f.bob)).toEqual(['excluded: Cold']);
		const byId = await call(t, { action: 'exclude_segment', segment: f.seg, ids: [f.cat] });
		expect((await json(byId)).data).toMatchObject({ affected: 1 });
		expect((await storedRules(f.seg))!.rules).toHaveLength(2);
	});
});

describe('every selection bar is the BulkBar shell', () => {
	it('contacts, groups, automations and conversations all render <BulkBar> and no hand-rolled .bulkbar', () => {
		for (const src of [bulkBar, groupsPage, automationsPage, conversationsPage]) {
			expect(src).toContain('<BulkBar ');
			expect(src).toContain('</BulkBar>');
			expect(src).not.toContain('class="bulkbar"');
			expect(src).not.toContain('>Clear</button>'); // the shell owns Clear
		}
		expect(bulkBar).toContain('placement="top"');
	});
});

describe('bulk bar source: one Action picker instead of a row per action', () => {
	const row = bulkBar.slice(bulkBar.indexOf('<div class="bulk-row">'), bulkBar.indexOf('<Modal'));

	it('keeps the count line (#571) and puts every other action behind the picker', () => {
		expect(bulkBar).toContain('<select id="bulk-action" bind:value={action}>');
		for (const label of ['Lists', 'Tags', 'Segments', 'Automations', 'Engagement', 'Archive and delete']) {
			expect(row).toContain(`<optgroup label="${label}">`);
		}
		for (const a of ['addToList', 'removeFromList', 'bulkTag', 'removeTag', 'addToSegment', 'excludeFromSegment', 'addToAutomation', 'bulkSetTier', 'bulkAdjustScore', 'archiveContacts', 'restoreContacts']) {
			expect(row.match(new RegExp(`action="\\?/${a}"`, 'g'))).toHaveLength(1);
		}
		// No always-visible label column rows any more.
		expect(bulkBar).not.toContain('<span class="muted">Add to list</span>');
		expect(bulkBar).not.toContain('class="bulk-row deletebar"');
	});

	it('offers Exclude from this segment only on a dynamic segment, with the tag named in the confirm', () => {
		expect(row).toContain('{#if canExclude}<option value="exclude_segment">Exclude from this segment</option>{/if}');
		expect(bulkBar).toContain("const canExclude = $derived(!!current?.dynamic);");
		expect(row).toContain('They get the tag “${exclusionTag}”');
	});
});

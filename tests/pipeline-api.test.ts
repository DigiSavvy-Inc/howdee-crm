// #207: pipeline Data API — stages, card list filters + paging, contact pipeline GET/POST/DELETE,
// key scopes, and the api actor on history rows.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { addToPipeline, listStages, updateCard } from '../src/lib/server/pipeline';
import { GET as getStages } from '../src/routes/api/v1/pipeline/stages/+server';
import { GET as getCards } from '../src/routes/api/v1/pipeline/cards/+server';
import {
	GET as getContactPipeline,
	POST as postContactPipeline,
	DELETE as deleteContactPipeline
} from '../src/routes/api/v1/contacts/[id]/pipeline/+server';

const db = (env as any).DB as D1Database;
const PREFIX = 'pipeapi-test-';

async function makeKey(scope: ApiScope): Promise<{ token: string; id: number }> {
	const k = await generateApiKey();
	const row = await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?) RETURNING id`)
		.bind('pipe key', k.tokenHash, k.prefix, k.last4, scope)
		.first<{ id: number }>();
	return { token: k.token, id: row!.id };
}

function ev(path: string, method: string, token: string | undefined, body?: unknown, params: Record<string, string> = {}) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		platform: { env },
		url,
		params
	} as any;
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM pipeline_stages'),
		db.prepare(`DELETE FROM contacts WHERE email LIKE ?`).bind(`${PREFIX}%`),
		db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`),
		db.prepare(
			`INSERT INTO pipeline_stages (name, color, position, kind) VALUES
			 ('Lead','muted',0,'open'),('Qualified','viz-3',1,'open'),('Proposal','viz-2',2,'open'),
			 ('Negotiation','viz-1',3,'open'),('Won','success',4,'won'),('Lost','danger',5,'lost')`
		)
	]);
});

async function contact(name: string): Promise<number> {
	const row = await db
		.prepare('INSERT INTO contacts (email, name, company) VALUES (?, ?, ?) RETURNING id')
		.bind(`${PREFIX}${name.toLowerCase()}@example.com`, name, 'Acme')
		.first<{ id: number }>();
	return row!.id;
}
async function user(login: string): Promise<number> {
	const row = await db
		.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`)
		.bind(`${PREFIX}${login}`)
		.first<{ id: number }>();
	return row!.id;
}
async function stageId(name: string): Promise<number> {
	return (await listStages(db)).find((s) => s.name === name)!.id;
}
const sys = { kind: 'system' as const };
const p = (id: number) => ({ id: String(id) });

describe('auth', () => {
	it('401 without a key, 403 for a read key on POST/DELETE', async () => {
		expect((await getStages(ev('/api/v1/pipeline/stages', 'GET', undefined))).status).toBe(401);
		expect((await getCards(ev('/api/v1/pipeline/cards', 'GET', undefined))).status).toBe(401);
		const c = await contact('Auth');
		expect((await getContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'GET', undefined, undefined, p(c)))).status).toBe(401);
		const ro = await makeKey('read');
		const post = await postContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'POST', ro.token, { stage_name: 'Lead' }, p(c)));
		expect(post.status).toBe(403);
		expect((await deleteContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'DELETE', ro.token, undefined, p(c)))).status).toBe(403);
	});
});

describe('GET /api/v1/pipeline/stages', () => {
	it('lists stages by position with card counts and totals', async () => {
		const { token } = await makeKey('read');
		const a = await contact('A');
		const b = await contact('B');
		await addToPipeline(db, a, await stageId('Lead'), sys, { value: 100 });
		await addToPipeline(db, b, await stageId('Lead'), sys, { value: 250 });
		const res = await getStages(ev('/api/v1/pipeline/stages', 'GET', token));
		expect(res.status).toBe(200);
		const d = (await jsonOf(res)).data;
		expect(d.map((s: any) => s.name)).toEqual(['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']);
		expect(d[0]).toMatchObject({ name: 'Lead', color: 'muted', position: 0, kind: 'open', card_count: 2, total_value: 350 });
		expect(d[1]).toMatchObject({ card_count: 0, total_value: 0 });
		expect(d[4].kind).toBe('won');
		expect(Object.keys(d[0]).sort()).toEqual(['card_count', 'color', 'id', 'kind', 'name', 'position', 'total_value']);
	});
});

describe('GET /api/v1/pipeline/cards', () => {
	it('filters by stage name/id and owner none, pages, and orders by stage then position', async () => {
		const { token } = await makeKey('read');
		const owner = await user('owner');
		const a = await contact('A');
		const b = await contact('B');
		const c = await contact('C');
		await addToPipeline(db, a, await stageId('Qualified'), sys, { value: 10 });
		await addToPipeline(db, b, await stageId('Lead'), sys);
		await addToPipeline(db, c, await stageId('Lead'), sys, { owner });

		const all = await jsonOf(await getCards(ev('/api/v1/pipeline/cards', 'GET', token)));
		expect(all.data.map((x: any) => x.contact_id)).toEqual([b, c, a]);
		expect(all.pagination).toEqual({ limit: 50, offset: 0, total: 3, has_more: false });
		expect(all.data[2]).toMatchObject({
			contact_id: a,
			email: `${PREFIX}a@example.com`,
			name: 'A',
			company: 'Acme',
			stage_name: 'Qualified',
			value: 10,
			owner_user_id: null,
			owner_login: null
		});
		expect(all.data[1]).toMatchObject({ owner_user_id: owner, owner_login: `${PREFIX}owner` });

		const byName = await jsonOf(await getCards(ev('/api/v1/pipeline/cards?stage=lead', 'GET', token)));
		expect(byName.data.map((x: any) => x.contact_id)).toEqual([b, c]);
		const qid = await stageId('Qualified');
		const byId = await jsonOf(await getCards(ev(`/api/v1/pipeline/cards?stage=${qid}`, 'GET', token)));
		expect(byId.data.map((x: any) => x.contact_id)).toEqual([a]);

		const none = await jsonOf(await getCards(ev('/api/v1/pipeline/cards?owner=none', 'GET', token)));
		expect(none.data.map((x: any) => x.contact_id)).toEqual([b, a]);
		const byLogin = await jsonOf(await getCards(ev(`/api/v1/pipeline/cards?owner=${PREFIX}OWNER`, 'GET', token)));
		expect(byLogin.data.map((x: any) => x.contact_id)).toEqual([c]);

		const page = await jsonOf(await getCards(ev('/api/v1/pipeline/cards?limit=2&offset=1', 'GET', token)));
		expect(page.data.map((x: any) => x.contact_id)).toEqual([c, a]);
		expect(page.pagination).toEqual({ limit: 2, offset: 1, total: 3, has_more: false });
		const first = await jsonOf(await getCards(ev('/api/v1/pipeline/cards?limit=1', 'GET', token)));
		expect(first.pagination.has_more).toBe(true);
	});

	it('400 on an unknown stage or owner', async () => {
		const { token } = await makeKey('read');
		const res = await getCards(ev('/api/v1/pipeline/cards?stage=Nope', 'GET', token));
		expect(res.status).toBe(400);
		expect((await jsonOf(res)).error).toMatch(/Unknown stage/);
		expect((await getCards(ev('/api/v1/pipeline/cards?stage=999999', 'GET', token))).status).toBe(400);
		expect((await getCards(ev('/api/v1/pipeline/cards?owner=nobody-here', 'GET', token))).status).toBe(400);
	});
});

describe('GET /api/v1/contacts/:id/pipeline', () => {
	it('400 on a bad id, 404 on a missing contact, null card when not on the board', async () => {
		const { token } = await makeKey('read');
		expect((await getContactPipeline(ev('/api/v1/contacts/abc/pipeline', 'GET', token, undefined, { id: 'abc' }))).status).toBe(400);
		expect((await getContactPipeline(ev('/api/v1/contacts/999999/pipeline', 'GET', token, undefined, { id: '999999' }))).status).toBe(404);
		const c = await contact('Off');
		const res = await getContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'GET', token, undefined, p(c)));
		expect(res.status).toBe(200);
		expect((await jsonOf(res)).data).toEqual({ card: null, history: [] });
	});

	it('returns the card and history newest first', async () => {
		const { token } = await makeKey('read');
		const c = await contact('On');
		await addToPipeline(db, c, await stageId('Lead'), sys);
		await addToPipeline(db, c, await stageId('Proposal'), sys);
		await updateCard(db, c, { note: 'hi' });
		const d = (await jsonOf(await getContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'GET', token, undefined, p(c))))).data;
		expect(d.card).toMatchObject({ contact_id: c, stage_name: 'Proposal', note: 'hi' });
		expect(d.card.created_at).toBeTruthy();
		expect(d.card.updated_at).toBeTruthy();
		expect(d.history).toHaveLength(2);
		expect(d.history[0]).toMatchObject({ from_stage: 'Lead', to_stage: 'Proposal', actor_kind: 'system', actor_label: null });
		expect(d.history[1]).toMatchObject({ from_stage_id: null, from_stage: null, to_stage: 'Lead' });
	});
});

describe('POST /api/v1/contacts/:id/pipeline', () => {
	it('adds a card (201) with an api-actor history row', async () => {
		const key = await makeKey('read_write');
		const c = await contact('New');
		const res = await postContactPipeline(
			ev(`/api/v1/contacts/${c}/pipeline`, 'POST', key.token, { stage_name: 'qualified', value: '$1,200', note: 'warm' }, p(c))
		);
		expect(res.status).toBe(201);
		const d = (await jsonOf(res)).data;
		expect(d.card).toMatchObject({ contact_id: c, stage_name: 'Qualified', value: 1200, note: 'warm' });
		expect(d.history).toHaveLength(1);
		expect(d.history[0]).toMatchObject({ from_stage_id: null, to_stage: 'Qualified', actor_kind: 'api', actor_id: key.id, actor_label: 'pipe key' });
	});

	it('moves by stage_name (200), edits value with key-present semantics, null clears', async () => {
		const key = await makeKey('read_write');
		const c = await contact('Mover');
		await postContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'POST', key.token, { stage_id: await stageId('Lead'), value: 500, note: 'n' }, p(c)));
		const res = await postContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'POST', key.token, { stage_name: 'NEGOTIATION', note: null }, p(c)));
		expect(res.status).toBe(200);
		const d = (await jsonOf(res)).data;
		expect(d.card).toMatchObject({ stage_name: 'Negotiation', value: 500, note: null });
		expect(d.history[0]).toMatchObject({ from_stage: 'Lead', to_stage: 'Negotiation', actor_kind: 'api', actor_id: key.id });

		const cleared = await postContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'POST', key.token, { value: null }, p(c)));
		expect(cleared.status).toBe(200);
		const d2 = (await jsonOf(cleared)).data;
		expect(d2.card).toMatchObject({ stage_name: 'Negotiation', value: null });
		expect(d2.history).toHaveLength(2); // no stage change → no new history row
	});

	it('400s: junk value, unknown stage, no stage for a new card, non-object body, bad id; 404 missing contact', async () => {
		const key = await makeKey('read_write');
		const c = await contact('Bad');
		const url = `/api/v1/contacts/${c}/pipeline`;
		const junk = await postContactPipeline(ev(url, 'POST', key.token, { stage_name: 'Lead', value: 'lots' }, p(c)));
		expect(junk.status).toBe(400);
		expect((await jsonOf(junk)).error).toMatch(/value/i);
		expect((await postContactPipeline(ev(url, 'POST', key.token, { stage_name: 'Nope' }, p(c)))).status).toBe(400);
		expect((await postContactPipeline(ev(url, 'POST', key.token, { value: 5 }, p(c)))).status).toBe(400);
		expect((await postContactPipeline(ev(url, 'POST', key.token, null, p(c)))).status).toBe(400);
		expect((await postContactPipeline(ev(url, 'POST', key.token, [1], p(c)))).status).toBe(400);
		expect((await postContactPipeline(ev(url, 'POST', key.token, { stage_name: 'Lead', owner: 'nobody-here' }, p(c)))).status).toBe(400);
		expect((await postContactPipeline(ev('/api/v1/contacts/x/pipeline', 'POST', key.token, { stage_name: 'Lead' }, { id: 'x' }))).status).toBe(400);
		expect((await postContactPipeline(ev('/api/v1/contacts/999999/pipeline', 'POST', key.token, { stage_name: 'Lead' }, { id: '999999' }))).status).toBe(404);
		// Nothing was written by any of the rejected calls.
		const n = await db.prepare('SELECT COUNT(*) AS n FROM pipeline_cards WHERE contact_id = ?').bind(c).first<{ n: number }>();
		expect(n?.n).toBe(0);
	});

	it('sets and clears the owner by login', async () => {
		const key = await makeKey('read_write');
		const owner = await user('rep');
		const c = await contact('Owned');
		const url = `/api/v1/contacts/${c}/pipeline`;
		const set = (await jsonOf(await postContactPipeline(ev(url, 'POST', key.token, { stage_name: 'Lead', owner: `${PREFIX}rep` }, p(c))))).data;
		expect(set.card).toMatchObject({ owner_user_id: owner, owner_login: `${PREFIX}rep` });
		const cleared = (await jsonOf(await postContactPipeline(ev(url, 'POST', key.token, { owner: null }, p(c))))).data;
		expect(cleared.card.owner_user_id).toBeNull();
	});
});

describe('DELETE /api/v1/contacts/:id/pipeline', () => {
	it('removes the card with an api history row; removed:false when not on the board; 404 missing', async () => {
		const key = await makeKey('read_write');
		const c = await contact('Gone');
		await addToPipeline(db, c, await stageId('Lead'), sys);
		const res = await deleteContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'DELETE', key.token, undefined, p(c)));
		expect(res.status).toBe(200);
		expect((await jsonOf(res)).data).toEqual({ removed: true });
		const ro = await makeKey('read');
		const d = (await jsonOf(await getContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'GET', ro.token, undefined, p(c))))).data;
		expect(d.card).toBeNull();
		expect(d.history[0]).toMatchObject({ from_stage: 'Lead', to_stage_id: null, actor_kind: 'api', actor_id: key.id });

		const again = await deleteContactPipeline(ev(`/api/v1/contacts/${c}/pipeline`, 'DELETE', key.token, undefined, p(c)));
		expect((await jsonOf(again)).data).toEqual({ removed: false });
		expect((await deleteContactPipeline(ev('/api/v1/contacts/999999/pipeline', 'DELETE', key.token, undefined, { id: '999999' }))).status).toBe(404);
	});
});

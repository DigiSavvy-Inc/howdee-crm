// #206: pipeline — stage CRUD/reorder/delete-with-move, card add/move/remove + history,
// UNIQUE contact, board totals, days in stage, list sort, and permissions.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	addToPipeline,
	boardData,
	cardFor,
	createStage,
	deleteStage,
	listStages,
	moveCard,
	nudgeStage,
	parseValue,
	removeFromPipeline,
	reorderStages,
	updateCard,
	updateStage,
	type Actor
} from '../src/lib/server/pipeline';
import { sortCards, daysSince } from '../src/lib/pipeline';
import { actions as boardActions, load as boardLoad } from '../src/routes/pipeline/+page.server';
import { actions as stageActions, load as stagesLoad } from '../src/routes/pipeline/stages/+page.server';

const db = (env as any).DB as D1Database;
const PREFIX = 'pipeline-test-';
const user: Actor = { kind: 'user', id: 1 };

async function reset() {
	await db.batch([
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
}
beforeEach(reset);

async function contact(name: string, extra: { company?: string } = {}): Promise<number> {
	const row = await db
		.prepare('INSERT INTO contacts (email, name, company) VALUES (?, ?, ?) RETURNING id')
		.bind(`${PREFIX}${name.toLowerCase()}@example.com`, name, extra.company ?? null)
		.first<{ id: number }>();
	return row!.id;
}
async function stageId(name: string): Promise<number> {
	return (await listStages(db)).find((s) => s.name === name)!.id;
}
async function history(contactId: number) {
	return (
		await db
			.prepare('SELECT from_stage_id, to_stage_id, actor_kind, actor_id FROM pipeline_history WHERE contact_id = ? ORDER BY id')
			.bind(contactId)
			.all<{ from_stage_id: number | null; to_stage_id: number | null; actor_kind: string; actor_id: number | null }>()
	).results;
}

describe('stages', () => {
	it('seeds six defaults in order (migration 0062 shape)', async () => {
		const s = await listStages(db);
		expect(s.map((x) => x.name)).toEqual(['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']);
		expect(s.map((x) => x.kind)).toEqual(['open', 'open', 'open', 'open', 'won', 'lost']);
	});

	it('creates, updates, reorders and nudges', async () => {
		const r = await createStage(db, { name: '  Discovery  ', color: 'viz-2' });
		expect(r.ok).toBe(true);
		let s = await listStages(db);
		const d = s.at(-1)!;
		expect(d).toMatchObject({ name: 'Discovery', color: 'viz-2', kind: 'open', position: 6 });

		expect((await createStage(db, { name: '' })).ok).toBe(false);
		// Unknown colour falls back to muted — no raw colours stored.
		await updateStage(db, d.id, { name: 'Discovery call', color: '#ff0000' });
		expect((await listStages(db)).at(-1)).toMatchObject({ name: 'Discovery call', color: 'muted' });

		const ids = s.map((x) => x.id).reverse();
		expect((await reorderStages(db, ids)).ok).toBe(true);
		expect((await listStages(db)).map((x) => x.id)).toEqual(ids);
		expect((await reorderStages(db, ids.slice(1))).ok).toBe(false); // must name every stage

		await nudgeStage(db, ids[1]!, -1);
		s = await listStages(db);
		expect(s[0]!.id).toBe(ids[1]);
		expect(s[1]!.id).toBe(ids[0]);
	});

	it('keeps at least one open stage', async () => {
		const ids = (await listStages(db)).filter((s) => s.kind === 'open').map((s) => s.id);
		for (const id of ids.slice(1)) expect((await deleteStage(db, id, null)).ok).toBe(true);
		const del = await deleteStage(db, ids[0]!, null);
		expect(del).toEqual({ ok: false, error: "The last open stage can't be deleted." });
		expect((await updateStage(db, ids[0]!, { kind: 'won' })).ok).toBe(false);
	});

	it('deleting a stage with cards needs a destination; cards + history move there', async () => {
		const a = await contact('Ada');
		const b = await contact('Bob');
		const c = await contact('Cy');
		const lead = await stageId('Lead');
		const prop = await stageId('Proposal');
		await addToPipeline(db, a, prop, user);
		await addToPipeline(db, b, lead, user);
		await moveCard(db, b, prop, user);
		await addToPipeline(db, c, lead, user);
		const enteredBefore = await db
			.prepare('SELECT entered_stage_at FROM pipeline_cards WHERE contact_id = ?')
			.bind(a)
			.first<{ entered_stage_at: string }>();

		expect((await deleteStage(db, prop, null)).ok).toBe(false);
		expect((await deleteStage(db, prop, prop)).ok).toBe(false);
		const r = await deleteStage(db, prop, lead);
		expect(r).toEqual({ ok: true, moved: 2 });

		const board = await boardData(db);
		const leadCol = board.stages.find((s) => s.id === lead)!;
		// Cy (already in Lead) stays first; Ada + Bob land after it, keeping their order.
		expect(leadCol.cards.map((x) => x.contact_id)).toEqual([c, a, b]);
		const enteredAfter = await db
			.prepare('SELECT entered_stage_at FROM pipeline_cards WHERE contact_id = ?')
			.bind(a)
			.first<{ entered_stage_at: string }>();
		expect(enteredAfter!.entered_stage_at).toBe(enteredBefore!.entered_stage_at);
		const sys = await db
			.prepare(`SELECT contact_id, to_stage_id FROM pipeline_history WHERE actor_kind = 'system' ORDER BY id`)
			.all<{ contact_id: number; to_stage_id: number }>();
		expect(sys.results).toEqual([
			{ contact_id: a, to_stage_id: lead },
			{ contact_id: b, to_stage_id: lead }
		]);
		const refs = await db
			.prepare('SELECT COUNT(*) AS n FROM pipeline_history WHERE from_stage_id = ? OR to_stage_id = ?')
			.bind(prop, prop)
			.first<{ n: number }>();
		expect(refs!.n).toBe(0);
	});
});

describe('cards', () => {
	it('add / move / remove each write history with the actor', async () => {
		const a = await contact('Ada');
		const lead = await stageId('Lead');
		const prop = await stageId('Proposal');
		const add = await addToPipeline(db, a, lead, user, { value: 1200 });
		expect(add).toEqual({ ok: true, created: true });
		await moveCard(db, a, prop, { kind: 'automation', id: 7 });
		// A same-stage reorder is not a stage move — no history row.
		await moveCard(db, a, prop, user, { position: 0 });
		await removeFromPipeline(db, a, { kind: 'api', id: 3 });

		expect(await history(a)).toEqual([
			{ from_stage_id: null, to_stage_id: lead, actor_kind: 'user', actor_id: 1 },
			{ from_stage_id: lead, to_stage_id: prop, actor_kind: 'automation', actor_id: 7 },
			{ from_stage_id: prop, to_stage_id: null, actor_kind: 'api', actor_id: 3 }
		]);
		expect((await cardFor(db, a)).card).toBeNull();
		expect(await removeFromPipeline(db, a, user)).toEqual({ ok: true, removed: false });
	});

	it('one card per contact: adding again is a move, and the DB enforces UNIQUE', async () => {
		const a = await contact('Ada');
		const lead = await stageId('Lead');
		const won = await stageId('Won');
		await addToPipeline(db, a, lead, user, { value: 100 });
		const again = await addToPipeline(db, a, won, user, { value: 500 });
		expect(again).toEqual({ ok: true, created: false });
		const n = await db.prepare('SELECT COUNT(*) AS n FROM pipeline_cards WHERE contact_id = ?').bind(a).first<{ n: number }>();
		expect(n!.n).toBe(1);
		const { card } = await cardFor(db, a);
		expect(card).toMatchObject({ stage_id: won, value: 500, stage_name: 'Won', stage_kind: 'won' });

		await expect(
			db
				.prepare("INSERT INTO pipeline_cards (contact_id, stage_id, entered_stage_at) VALUES (?, ?, datetime('now'))")
				.bind(a, lead)
				.run()
		).rejects.toThrow(/UNIQUE/);
	});

	it('rejects unknown contacts and stages', async () => {
		const a = await contact('Ada');
		expect((await addToPipeline(db, a, 999999, user)).ok).toBe(false);
		expect((await addToPipeline(db, 999999, await stageId('Lead'), user)).ok).toBe(false);
		expect((await moveCard(db, a, await stageId('Lead'), user)).ok).toBe(false); // not on the board
	});

	it('positions within a column', async () => {
		const [a, b, c] = [await contact('Ada'), await contact('Bob'), await contact('Cy')];
		const lead = await stageId('Lead');
		for (const id of [a, b, c]) await addToPipeline(db, id, lead, user);
		await moveCard(db, c, lead, user, { position: 0 });
		const col = (await boardData(db)).stages.find((s) => s.id === lead)!;
		expect(col.cards.map((x) => x.contact_id)).toEqual([c, a, b]);
	});

	it('updateCard is key-present: omitted fields stay, null clears', async () => {
		const a = await contact('Ada');
		const u = await db
			.prepare("INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id")
			.bind(`${PREFIX}owner`)
			.first<{ id: number }>();
		await addToPipeline(db, a, await stageId('Lead'), user, { value: 10, note: 'hi' });
		await updateCard(db, a, { owner: u!.id });
		let { card } = await cardFor(db, a);
		expect(card).toMatchObject({ value: 10, note: 'hi', owner_user_id: u!.id, owner_login: `${PREFIX}owner` });
		await updateCard(db, a, { value: null });
		({ card } = await cardFor(db, a));
		expect(card).toMatchObject({ value: null, note: 'hi' });
		expect((await updateCard(db, a, { owner: 999999 })).ok).toBe(false);
	});

	it('parseValue', () => {
		expect(parseValue('')).toBeNull();
		expect(parseValue('$1,200')).toBe(1200);
		expect(parseValue('12.6')).toBe(13);
		expect(parseValue('abc')).toBeUndefined();
		expect(parseValue('-5')).toBeUndefined();
	});
});

describe('board', () => {
	it('per-stage counts/totals, owner + search filters', async () => {
		const [a, b, c] = [await contact('Ada', { company: 'Acme' }), await contact('Bob'), await contact('Cy')];
		const lead = await stageId('Lead');
		const prop = await stageId('Proposal');
		const u = await db
			.prepare("INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id")
			.bind(`${PREFIX}own`)
			.first<{ id: number }>();
		await addToPipeline(db, a, lead, user, { value: 1000, owner: u!.id });
		await addToPipeline(db, b, lead, user, { value: 250 });
		await addToPipeline(db, c, prop, user);

		const board = await boardData(db);
		expect(board.count).toBe(3);
		expect(board.total).toBe(1250);
		expect(board.stages.find((s) => s.id === lead)).toMatchObject({ count: 2, total: 1250 });
		expect(board.stages.find((s) => s.id === prop)).toMatchObject({ count: 1, total: 0 });
		expect(board.stages).toHaveLength(6); // empty stages still render

		expect((await boardData(db, { owner: u!.id })).count).toBe(1);
		expect((await boardData(db, { owner: 'none' })).count).toBe(2);
		expect((await boardData(db, { q: 'acme' })).stages.flatMap((s) => s.cards).map((x) => x.contact_id)).toEqual([a]);
		expect((await boardData(db, { q: '100%' })).count).toBe(0); // LIKE wildcards escaped
	});

	it('days in stage counts from entered_stage_at, reset by a stage move', async () => {
		const a = await contact('Ada');
		await addToPipeline(db, a, await stageId('Lead'), user);
		await db
			.prepare("UPDATE pipeline_cards SET entered_stage_at = datetime('now', '-5 days', '-1 hour') WHERE contact_id = ?")
			.bind(a)
			.run();
		expect((await cardFor(db, a)).card!.days_in_stage).toBe(5);
		await moveCard(db, a, await stageId('Lead'), user, { position: 0 }); // reorder only
		expect((await cardFor(db, a)).card!.days_in_stage).toBe(5);
		await moveCard(db, a, await stageId('Won'), user);
		expect((await cardFor(db, a)).card!.days_in_stage).toBe(0);
		expect(daysSince('2026-01-01 00:00:00', new Date('2026-01-03T12:00:00Z'))).toBe(2);
	});

	it('list sort, NULLs last both ways', () => {
		const rows = [
			{ name: 'bob', stage_position: 2, value: 50, owner_login: null, days_in_stage: 1, last_activity_at: null },
			{ name: 'Ada', stage_position: 0, value: null, owner_login: 'zed', days_in_stage: 9, last_activity_at: '2026-01-02 00:00:00' },
			{ name: 'cy', stage_position: 1, value: 900, owner_login: 'amy', days_in_stage: 3, last_activity_at: '2026-01-01 00:00:00' }
		];
		expect(sortCards(rows, 'name', 'asc').map((r) => r.name)).toEqual(['Ada', 'bob', 'cy']);
		expect(sortCards(rows, 'stage', 'desc').map((r) => r.name)).toEqual(['bob', 'cy', 'Ada']);
		expect(sortCards(rows, 'value', 'desc').map((r) => r.name)).toEqual(['cy', 'bob', 'Ada']);
		expect(sortCards(rows, 'value', 'asc').map((r) => r.name)).toEqual(['bob', 'cy', 'Ada']);
		expect(sortCards(rows, 'owner', 'asc').map((r) => r.name)).toEqual(['cy', 'Ada', 'bob']);
		expect(sortCards(rows, 'days', 'desc').map((r) => r.name)).toEqual(['Ada', 'cy', 'bob']);
		expect(sortCards(rows, 'activity', 'desc').map((r) => r.name)).toEqual(['Ada', 'cy', 'bob']);
	});
});

describe('permissions', () => {
	function ev(path: string, role: 'admin' | 'member', form?: Record<string, string>) {
		const url = new URL(`https://app.test${path}`);
		const body = new FormData();
		for (const [k, v] of Object.entries(form ?? {})) body.set(k, v);
		return {
			request: new Request(url, { method: 'POST', body }),
			platform: { env },
			url,
			params: {},
			locals: { user: { id: 42, github_login: 'x', name: null, avatar_url: null, role, tourSeen: true, navLayout: 'top' } },
			cookies: { get: () => undefined, set: () => {} }
		} as any;
	}

	it('members can move cards (history records the user)', async () => {
		const a = await contact('Ada');
		await addToPipeline(db, a, await stageId('Lead'), user);
		const prop = await stageId('Proposal');
		const res = await (boardActions.move as any)(ev('/pipeline', 'member', { contact_id: String(a), stage_id: String(prop) }));
		expect(res).toEqual({ pipelineOk: 'Moved.' });
		expect((await history(a)).at(-1)).toEqual({ from_stage_id: await stageId('Lead'), to_stage_id: prop, actor_kind: 'user', actor_id: 42 });

		const won = await (boardActions.mark as any)(ev('/pipeline', 'member', { contact_id: String(a), kind: 'won' }));
		expect(won).toEqual({ pipelineOk: 'Moved.' });
		expect((await cardFor(db, a)).card!.stage_kind).toBe('won');

		const page = await (boardLoad as any)(ev('/pipeline', 'member'));
		expect(page.board.count).toBe(1);
		expect(page.isAdmin).toBe(false);
	});

	it('only admins can load or edit stages', async () => {
		await expect((stagesLoad as any)(ev('/pipeline/stages', 'member'))).rejects.toMatchObject({ status: 403 });
		await expect(
			(stageActions.create as any)(ev('/pipeline/stages', 'member', { name: 'Nope' }))
		).rejects.toMatchObject({ status: 403 });
		const lead = await stageId('Lead');
		await expect(
			(stageActions.delete as any)(ev('/pipeline/stages', 'member', { id: String(lead) }))
		).rejects.toMatchObject({ status: 403 });

		const ok = await (stageActions.create as any)(ev('/pipeline/stages', 'admin', { name: 'Discovery', color: 'viz-1', kind: 'open' }));
		expect(ok).toEqual({ ok: 'Stage added.' });
		expect((await listStages(db)).some((s) => s.name === 'Discovery')).toBe(true);
	});
});

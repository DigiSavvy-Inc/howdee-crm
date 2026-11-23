// #207: pipeline as a contact condition — the /contacts `?pipeline=` filter (any / none /
// stage id), the Stage column lookup, and the `pipeline_stage` segment rule (is/not/none/any)
// via compileSegment, all against real D1 rows.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	contactsFilterParams,
	contactsWhere,
	isFiltered,
	parseContactsFilter
} from '../src/lib/server/contacts-query';
import { compileSegment, type SegmentRules } from '../src/lib/server/segment-query';
import { parsePipelineFilter, stageOptions, stagesForContacts } from '../src/lib/server/pipeline-query';

const db = (env as any).DB as D1Database;
const PREFIX = 'pipefilter-';

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM pipeline_stages'),
		db.prepare('DELETE FROM contacts WHERE email LIKE ?').bind(`${PREFIX}%`),
		db.prepare(
			`INSERT INTO pipeline_stages (name, color, position, kind) VALUES
			 ('Lead','muted',0,'open'),('Proposal','viz-2',1,'open'),('Won','success',2,'won')`
		)
	]);
});

async function contact(name: string): Promise<number> {
	const row = await db
		.prepare('INSERT INTO contacts (email, name) VALUES (?, ?) RETURNING id')
		.bind(`${PREFIX}${name}@example.com`, name)
		.first<{ id: number }>();
	return row!.id;
}

async function stageId(name: string): Promise<number> {
	return (await stageOptions(db)).find((s) => s.name === name)!.id;
}

async function card(contactId: number, stage: string): Promise<void> {
	await db
		.prepare("INSERT INTO pipeline_cards (contact_id, stage_id, entered_stage_at) VALUES (?, ?, datetime('now'))")
		.bind(contactId, await stageId(stage))
		.run();
}

/** Four contacts: lead, proposal, won on the board; `off` not on it. */
async function seed() {
	const lead = await contact('lead');
	const proposal = await contact('proposal');
	const won = await contact('won');
	const off = await contact('off');
	await card(lead, 'Lead');
	await card(proposal, 'Proposal');
	await card(won, 'Won');
	return { lead, proposal, won, off };
}

const short = (email: string) => email.slice(PREFIX.length).replace('@example.com', '');

async function filterNames(qs: string): Promise<string[]> {
	const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(qs)));
	const scoped = where ? `${where} AND email LIKE ?` : 'WHERE email LIKE ?';
	const rows = await db
		.prepare(`SELECT email FROM contacts ${scoped} ORDER BY email`)
		.bind(...params, `${PREFIX}%`)
		.all<{ email: string }>();
	return rows.results.map((r) => short(r.email));
}

async function members(rules: SegmentRules): Promise<string[]> {
	const c = compileSegment(rules);
	const rows = await db
		.prepare(`SELECT email FROM contacts WHERE id IN (${c.sql}) AND email LIKE ? ORDER BY email`)
		.bind(...c.binds, `${PREFIX}%`)
		.all<{ email: string }>();
	return rows.results.map((r) => short(r.email));
}

describe('parsing', () => {
	it('accepts any / none / a positive stage id, rejects junk', () => {
		expect(parsePipelineFilter('any')).toBe('any');
		expect(parsePipelineFilter('none')).toBe('none');
		expect(parsePipelineFilter('7')).toBe(7);
		expect(parsePipelineFilter('')).toBeNull();
		expect(parsePipelineFilter('0')).toBeNull();
		expect(parsePipelineFilter('-2')).toBeNull();
		expect(parsePipelineFilter('1.5')).toBeNull();
		expect(parsePipelineFilter('lead')).toBeNull();
		expect(parsePipelineFilter(null)).toBeNull();
	});

	it('round-trips through the contacts filter params and lights the Filters dot', () => {
		const f = parseContactsFilter(new URLSearchParams('pipeline=3'));
		expect(f.pipeline).toBe(3);
		expect(isFiltered(f)).toBe(true);
		expect(contactsFilterParams(f)).toEqual({ pipeline: '3' });
		expect(contactsFilterParams(parseContactsFilter(new URLSearchParams('pipeline=none')))).toEqual({ pipeline: 'none' });
		const junk = parseContactsFilter(new URLSearchParams('pipeline=bogus'));
		expect(junk.pipeline).toBeNull();
		expect(isFiltered(junk)).toBe(false);
	});
});

describe('/contacts ?pipeline= filter', () => {
	it('any = on the board, none = not on it, <id> = in that stage', async () => {
		await seed();
		expect(await filterNames('')).toEqual(['lead', 'off', 'proposal', 'won']);
		expect(await filterNames('pipeline=any')).toEqual(['lead', 'proposal', 'won']);
		expect(await filterNames('pipeline=none')).toEqual(['off']);
		expect(await filterNames(`pipeline=${await stageId('Proposal')}`)).toEqual(['proposal']);
		expect(await filterNames(`pipeline=${await stageId('Won')}`)).toEqual(['won']);
	});

	it('binds the stage id and composes with other filters', async () => {
		const { lead } = await seed();
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(lead).run();
		const id = await stageId('Lead');
		const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams(`pipeline=${id}`)));
		expect(params).toEqual([id]);
		expect(await filterNames(`pipeline=any&status=subscribed`)).toEqual(['proposal', 'won']);
		expect(await filterNames(`pipeline=${id}&status=subscribed`)).toEqual([]);
	});

	it('follows a card that moves stage or leaves the board', async () => {
		const { proposal } = await seed();
		await db.prepare('UPDATE pipeline_cards SET stage_id = ? WHERE contact_id = ?').bind(await stageId('Won'), proposal).run();
		expect(await filterNames(`pipeline=${await stageId('Won')}`)).toEqual(['proposal', 'won']);
		await db.prepare('DELETE FROM pipeline_cards WHERE contact_id = ?').bind(proposal).run();
		expect(await filterNames('pipeline=none')).toEqual(['off', 'proposal']);
	});
});

describe('Stage column lookup', () => {
	it('returns name + colour for the given contacts only', async () => {
		const { lead, won, off } = await seed();
		const map = await stagesForContacts(db, [lead, won, off]);
		expect(map[lead]).toEqual({ name: 'Lead', color: 'muted' });
		expect(map[won]).toEqual({ name: 'Won', color: 'success' });
		expect(map[off]).toBeUndefined();
		expect(Object.keys(map)).toHaveLength(2);
		expect(await stagesForContacts(db, [])).toEqual({});
	});

	it('lists stages in board order', async () => {
		expect((await stageOptions(db)).map((s) => s.name)).toEqual(['Lead', 'Proposal', 'Won']);
	});
});

describe('pipeline_stage segment rule', () => {
	const rule = (op: string, value?: string): SegmentRules => ({
		match: 'all',
		rules: [{ field: 'pipeline_stage', op, value }]
	});

	it('is / not (incl. contacts not on the board) / none / any', async () => {
		await seed();
		const proposal = String(await stageId('Proposal'));
		expect(await members(rule('is', proposal))).toEqual(['proposal']);
		expect(await members(rule('not', proposal))).toEqual(['lead', 'off', 'won']);
		expect(await members(rule('none'))).toEqual(['off']);
		expect(await members(rule('any'))).toEqual(['lead', 'proposal', 'won']);
	});

	it('binds the stage id and composes with other rules (ANY)', async () => {
		await seed();
		const lead = await stageId('Lead');
		const c = compileSegment(rule('is', String(lead)));
		expect(c.binds).toEqual([lead]);
		const anyOf: SegmentRules = {
			match: 'any',
			rules: [
				{ field: 'pipeline_stage', op: 'is', value: String(lead) },
				{ field: 'pipeline_stage', op: 'none' }
			]
		};
		expect(await members(anyOf)).toEqual(['lead', 'off']);
	});

	it('skips a misconfigured rule (no stage / bad op) like every other rule kind', () => {
		expect(compileSegment(rule('is', '')).sql).toBe('SELECT c.id FROM contacts c WHERE c.archived_at IS NULL AND (1=1)');
		expect(compileSegment(rule('not', 'abc')).sql).toBe('SELECT c.id FROM contacts c WHERE c.archived_at IS NULL AND (1=1)');
		expect(compileSegment(rule('bogus', '1')).sql).toBe('SELECT c.id FROM contacts c WHERE c.archived_at IS NULL AND (1=1)');
	});
});

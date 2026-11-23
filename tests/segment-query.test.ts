import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { compileSegment, parseRules, type SegmentRules } from '../src/lib/server/segment-query';

const db = (env as any).DB as D1Database;

async function ids(rules: SegmentRules): Promise<string[]> {
	const c = compileSegment(rules);
	const rows = await db.prepare(c.sql + ' ORDER BY c.email').bind(...c.binds).all<{ id: number }>();
	const out: string[] = [];
	for (const r of rows.results) {
		const e = await db.prepare('SELECT email FROM contacts WHERE id = ?').bind(r.id).first<{ email: string }>();
		out.push(e!.email);
	}
	return out;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	// alice: hot tag, tier=hot/score=92, opened recently, source=web, Acme
	// bob: no tag, tier=warm/score=40, subscribed, source=import, Globex
	// carol: unsubscribed
	await db.batch([
		db.prepare(`INSERT INTO contacts (id, email, subscribed, source, company, meta) VALUES (1,'alice@x.example.net',1,'web','Acme','{"tier":"hot","score":92}')`),
		db.prepare(`INSERT INTO contacts (id, email, subscribed, source, company, meta) VALUES (2,'bob@x.example.net',1,'import','Globex','{"tier":"warm","score":40}')`),
		db.prepare(`INSERT INTO contacts (id, email, subscribed, source) VALUES (3,'carol@x.example.net',0,'web')`),
		db.prepare(`INSERT INTO lists (id, name, kind) VALUES (10,'hot','tag')`),
		db.prepare(`INSERT INTO list_members (list_id, contact_id) VALUES (10,1)`),
		db.prepare(`INSERT INTO events (campaign_id, contact_id, type, recorded_at) VALUES (NULL,1,'open',datetime('now','-2 days'))`)
	]);
});

describe('compileSegment (#66)', () => {
	it('tag has / not', async () => {
		expect(await ids({ match: 'all', rules: [{ field: 'tag', op: 'has', value: 'hot' }] })).toEqual(['alice@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'tag', op: 'not', value: 'hot' }] })).toEqual(['bob@x.example.net', 'carol@x.example.net']);
	});

	it('subscribed filter', async () => {
		expect(await ids({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] })).toEqual(['alice@x.example.net', 'bob@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'subscribed', op: 'no' }] })).toEqual(['carol@x.example.net']);
	});

	it('custom field equals + numeric compare', async () => {
		expect(await ids({ match: 'all', rules: [{ field: 'field', op: 'eq', value2: 'tier', value: 'hot' }] })).toEqual(['alice@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'field', op: 'gte', value2: 'score', value: '50' }] })).toEqual(['alice@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'field', op: 'exists', value2: 'tier' }] })).toEqual(['alice@x.example.net', 'bob@x.example.net']);
	});

	it('engagement window (opened in last N days)', async () => {
		expect(await ids({ match: 'all', rules: [{ field: 'opened', op: 'in', value: '7' }] })).toEqual(['alice@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'opened', op: 'in', value: '1' }] })).toEqual([]); // open was 2 days ago
		// not-opened-in-30d among everyone (alice opened, so excluded)
		expect(await ids({ match: 'all', rules: [{ field: 'opened', op: 'not', value: '30' }] })).toEqual(['bob@x.example.net', 'carol@x.example.net']);
	});

	it('source + company', async () => {
		expect(await ids({ match: 'all', rules: [{ field: 'source', op: 'is', value: 'web' }] })).toEqual(['alice@x.example.net', 'carol@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'company', op: 'is', value: 'acme' }] })).toEqual(['alice@x.example.net']);
	});

	it('ALL vs ANY combination', async () => {
		const r: SegmentRules = { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'hot' }, { field: 'field', op: 'gte', value2: 'score', value: '90' }] };
		expect(await ids(r)).toEqual(['alice@x.example.net']);
		const any: SegmentRules = { match: 'any', rules: [{ field: 'tag', op: 'has', value: 'hot' }, { field: 'source', op: 'is', value: 'import' }] };
		expect(await ids(any)).toEqual(['alice@x.example.net', 'bob@x.example.net']);
	});

	it('empty rules select everyone; unknown rules are skipped', async () => {
		expect(await ids({ match: 'all', rules: [] })).toEqual(['alice@x.example.net', 'bob@x.example.net', 'carol@x.example.net']);
		expect(await ids({ match: 'all', rules: [{ field: 'bogus', op: 'x' }] })).toEqual(['alice@x.example.net', 'bob@x.example.net', 'carol@x.example.net']);
	});

	it('values are bound — injection attempt finds nothing, table intact', async () => {
		await ids({ match: 'all', rules: [{ field: 'tag', op: 'has', value: "x'); DROP TABLE contacts;--" }] });
		const n = await db.prepare('SELECT COUNT(*) AS n FROM contacts').first<{ n: number }>();
		expect(n?.n).toBe(3);
	});

	it('parseRules tolerates junk', () => {
		expect(parseRules(null)).toBeNull();
		expect(parseRules('not json')).toBeNull();
		expect(parseRules('{"match":"any","rules":[]}')).toEqual({ match: 'any', rules: [] });
	});
});

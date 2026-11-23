import { describe, it, expect, beforeAll } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { TOOLS } from '../src/lib/server/ai/tools';
import { caseProblems, collectCases, gradeRun } from '../scripts/assistant-evals-lib.mjs';
import { takeSnapshot, type Snapshot } from '../evals/harness/db-reset';
import { replayProvider, type Recording } from '../evals/harness/providers';
import { runEvalCase, type EvalCase } from '../evals/harness/run-case';
import fixtures from '../evals/fixtures.json';

// #391: the assistant eval suite's offline part. The golden cases (evals/assistant/*.json) are
// valid, the fixtures hold fake data only, and the CI subset (cases with "ci": true) replays
// its recorded model outputs (evals/recordings/) through the real loop, tools and D1 — graded
// by tool_calls only, so a renamed tool, a changed input schema, a write that stops waiting for
// Approve or a send-like tool appearing fails here without network or spend. The live suite is
// scripts/assistant-evals.mjs (docs/assistant-evals.md).

const caseFiles = import.meta.glob('../evals/assistant/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const recordingFiles = import.meta.glob('../evals/recordings/*.json', { eager: true, import: 'default' }) as Record<string, Recording>;
const rawFiles = import.meta.glob(['../evals/assistant/*.json', '../evals/fixtures.json', '../evals/recordings/*.json'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const cases = collectCases(caseFiles) as EvalCase[];
const recordings = new Map(Object.values(recordingFiles).map((r) => [r.case, r]));
const ciCases = cases.filter((c) => c.ci === true);
const known = new Set(TOOLS.map((t) => t.name));

describe('golden cases', () => {
	it('40–60 valid cases with unique ids, naming only tools that exist', () => {
		expect(cases.length).toBeGreaterThanOrEqual(40);
		expect(cases.length).toBeLessThanOrEqual(60);
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
		expect(cases.flatMap((c) => caseProblems(c, { known, fixtures }))).toEqual([]);
	});

	it('cover every category, with every grader kind in use', () => {
		const cats = new Set(cases.map((c) => c.category));
		for (const cat of ['reads', 'writes', 'refusals', 'injection', 'skills', 'jobs', 'visibility', 'structured']) expect(cats.has(cat)).toBe(true);
		const kinds = new Set(cases.flatMap((c) => c.graders.map((g) => g.kind)));
		for (const k of ['tool_calls', 'contains', 'regex', 'json_schema', 'llm_judge']) expect(kinds.has(k)).toBe(true);
	});

	it('every ci case has a recording, and every recording belongs to a ci case', () => {
		expect(ciCases.length).toBeGreaterThanOrEqual(10);
		for (const c of ciCases) expect(recordings.has(c.id), `no recording for ${c.id} (run the suite with --record)`).toBe(true);
		for (const id of recordings.keys()) expect(ciCases.some((c) => c.id === id), `stray recording ${id}`).toBe(true);
	});
});

// Real mail providers must never appear in eval data. Fixture emails must use reserved test
// domains (RFC 2606 / 6761).
const DENYLIST = [/gmail\.com/i, /yahoo\.com/i, /outlook\.com/i, /hotmail\.com/i, /icloud\.com/i];
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const RESERVED = /@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid))$/i;

describe('fixture data hygiene', () => {
	it('case files, fixtures and recordings contain no real mail providers', () => {
		for (const [file, text] of Object.entries(rawFiles)) {
			for (const re of DENYLIST) expect(re.test(text), `${file} matches ${re}`).toBe(false);
		}
	});

	it('every email address is on a reserved test domain', () => {
		for (const [file, text] of Object.entries(rawFiles)) {
			for (const email of text.match(EMAIL) ?? []) expect(RESERVED.test(email), `${file}: ${email}`).toBe(true);
		}
	});

	it('the denylist itself works', () => {
		expect(DENYLIST.some((re) => re.test('someone@gmail.com'))).toBe(true);
		expect(RESERVED.test('dana.reyes@acme-widgets.test')).toBe(true);
		expect(RESERVED.test('jane.doe@gmail.com')).toBe(false);
	});
});

describe('CI replay subset', () => {
	const db = (env as unknown as { EVAL_DB: D1Database }).EVAL_DB;
	let snapshot: Snapshot;

	beforeAll(async () => {
		await applyD1Migrations(db, (env as any).TEST_MIGRATIONS);
		snapshot = await takeSnapshot(db);
	});

	for (const c of ciCases) {
		it(c.id, async () => {
			const rec = recordings.get(c.id);
			if (!rec) throw new Error(`no recording for ${c.id}`);
			const run = await runEvalCase(c, {
				db,
				snapshot,
				fixtures,
				provider: (refs) => replayProvider(rec, refs),
				model: 'claude-sonnet-5-5',
				effort: 'medium',
				apiKey: 'sk-ant-replay',
				timeoutMs: 60_000
			});
			const graded = await gradeRun(run, c, { only: ['tool_calls'] });
			expect(graded.grades.filter((g) => g.pass === false), JSON.stringify(run.toolCalls)).toEqual([]);
			expect(graded.pass).toBe(true);
			// Nothing in a replay ever reaches a send path: no recipients were written.
			const sent = await db.prepare(`SELECT COUNT(*) AS n FROM recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE c.created_at >= datetime('now', '-1 minute')`).first<{ n: number }>();
			expect(sent?.n ?? 0).toBe(0);
		});
	}

	it('the DB is back to the migrated state between cases', async () => {
		const { restoreSnapshot } = await import('../evals/harness/db-reset');
		await db.prepare(`INSERT INTO contacts (email) VALUES ('leftover@example.com')`).run();
		await restoreSnapshot(db, snapshot);
		const n = await db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'leftover@example.com'`).first<{ n: number }>();
		expect(n?.n).toBe(0);
		const skills = await db.prepare('SELECT COUNT(*) AS n FROM ai_skills').first<{ n: number }>();
		expect(skills?.n).toBeGreaterThan(0); // seed rows come back
	});
});

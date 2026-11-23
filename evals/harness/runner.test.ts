// Assistant evals (#391): the shard entry point for scripts/assistant-evals.mjs. Not part of
// `npm test` (vitest.config.ts only includes tests/); the runner starts it through
// evals/vitest.config.ts with the shard in the EVAL_JOB binding. Each work item prints one
// RESULT_MARKER line; the config's onConsoleLog hands those to the runner.

import { it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { anthropicProvider } from '../../src/lib/server/ai/anthropic';
import { RESULT_MARKER } from '../../scripts/assistant-evals-lib.mjs';
import { takeSnapshot } from './db-reset';
import { replayProvider, type Recording } from './providers';
import { runEvalCase, type EvalCase } from './run-case';

type Job = {
	mode: 'live' | 'replay';
	model: string;
	effort: string | null;
	timeoutMs: number;
	fixtures: Record<string, unknown>;
	items: { case: EvalCase; attempt: number }[];
	recordings: Record<string, Recording>;
};

const e = env as unknown as { EVAL_DB: D1Database; TEST_MIGRATIONS: unknown; EVAL_JOB: string; EVAL_ANTHROPIC_KEY?: string };

it('runs the eval shard', async () => {
	const job = JSON.parse(e.EVAL_JOB) as Job;
	await applyD1Migrations(e.EVAL_DB, e.TEST_MIGRATIONS as Parameters<typeof applyD1Migrations>[1]);
	const snapshot = await takeSnapshot(e.EVAL_DB);
	const key = job.mode === 'live' ? (e.EVAL_ANTHROPIC_KEY ?? '') : 'sk-ant-replay';
	for (const item of job.items) {
		let line: Record<string, unknown>;
		try {
			const rec = job.recordings[item.case.id];
			if (job.mode === 'replay' && !rec) throw new Error('no recording');
			const run = await runEvalCase(item.case, {
				db: e.EVAL_DB,
				snapshot,
				fixtures: job.fixtures,
				provider: (refs) => (job.mode === 'replay' ? replayProvider(rec, refs) : anthropicProvider(key)),
				model: job.model,
				effort: job.effort,
				apiKey: key,
				timeoutMs: job.timeoutMs
			});
			line = { ...run, attempt: item.attempt };
		} catch (err) {
			line = { id: item.case.id, category: item.case.category, attempt: item.attempt, error: err instanceof Error ? err.message : String(err) };
		}
		console.log(`${RESULT_MARKER}${JSON.stringify(line)}`);
	}
}, 6 * 60 * 60 * 1000);

// Assistant evals (#391): the config scripts/assistant-evals.mjs starts once per shard. Same
// workerd + D1 setup as vitest.config.ts, but only the shard entry point, one worker, its own
// eval D1, and two bindings from the runner: EVAL_JOB (read from the file in EVAL_JOB_FILE) and
// EVAL_ANTHROPIC_KEY (live runs only). Result lines go to EVAL_OUT_FILE.

import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RESULT_MARKER } from '../scripts/assistant-evals-lib.mjs';

const root = path.join(__dirname, '..');

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(root, 'migrations'));
	const jobFile = process.env.EVAL_JOB_FILE;
	const outFile = process.env.EVAL_OUT_FILE;
	return {
		root,
		resolve: { alias: { $lib: path.join(root, 'src/lib') } },
		plugins: [
			cloudflareTest({
				miniflare: {
					compatibilityDate: '2026-01-01',
					d1Databases: { EVAL_DB: 'eval-db' },
					bindings: {
						TEST_MIGRATIONS: migrations,
						EVAL_JOB: jobFile ? readFileSync(jobFile, 'utf8') : '{"items":[]}',
						EVAL_ANTHROPIC_KEY: process.env.EVAL_ANTHROPIC_KEY ?? ''
					}
				}
			})
		],
		test: {
			include: ['evals/harness/runner.test.ts'],
			setupFiles: ['./tests/stub-doh.ts'],
			testTimeout: 6 * 60 * 60 * 1000,
			maxWorkers: 1,
			onConsoleLog(log: string) {
				if (!log.includes(RESULT_MARKER)) return;
				if (outFile) appendFileSync(outFile, log.endsWith('\n') ? log : `${log}\n`);
				return false;
			}
		}
	};
});

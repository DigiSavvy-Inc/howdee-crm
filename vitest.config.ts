import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { latestMigration } from './scripts/latest-migration.mjs';

// Runs tests inside workerd with a real D1 (miniflare), so SQL behaves exactly like prod.
// Migrations are read here and applied per-test-run by tests/apply-migrations.ts.
export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
	return {
		// #609: same build-time constant as vite.config.ts (Settings → Setup's migration check).
		define: { __LATEST_MIGRATION__: JSON.stringify(latestMigration()) },
		resolve: {
			alias: { $lib: path.join(__dirname, 'src/lib') } // SvelteKit alias for non-Kit test context
		},
		plugins: [
			cloudflareTest({
				// No wrangler configPath: its `main` points at build output that may not exist,
				// and these tests only need a D1 binding — declared directly.
				miniflare: {
					compatibilityDate: '2026-01-01',
					// EVAL_DB (#391): the assistant eval replay resets it between cases, so it
					// never shares the DB other suites write to.
					d1Databases: { DB: 'test-db', EVAL_DB: 'eval-db' },
					bindings: { TEST_MIGRATIONS: migrations }
				}
			})
		],
		test: {
			include: ['tests/**/*.test.ts'],
			setupFiles: ['./tests/apply-migrations.ts', './tests/fixture-admin.ts', './tests/stub-doh.ts', './tests/report-host.ts'],
			// #193: under load, unrelated files hit the 5s default and fail the suite.
			testTimeout: 30_000,
			// #288: cap concurrent workerd runners. With the default (one per core) two suites
			// running side by side start so many runners that some miss vitest's fixed 90s
			// WORKER_START_TIMEOUT ("Timeout starting cloudflare-pool runner", ECONNRESET).
			// The pool exposes no setting for that timeout, so fewer, steadier workers it is.
			maxWorkers: 4
		}
	};
});

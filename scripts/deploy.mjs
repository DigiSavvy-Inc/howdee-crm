import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runDeploy } from './deploy-plan.mjs';
import { resolveWranglerBin } from './wrangler-bin.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string | undefined} v */
function truthy(v) {
	return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Workers Builds sets WORKERS_CI (it's how wrangler's bundled ci-info recognises "Cloudflare
 * Workers"). A bare CI=1 is any CI, not Workers Builds.
 */
function isWorkersBuilds() {
	return truthy(process.env.WORKERS_CI);
}

/** CI=1, Workers Builds and other non-interactive runs: no SETUP_TOKEN is generated there. */
function isCi() {
	return truthy(process.env.CI) || isWorkersBuilds();
}

/**
 * Write the secrets to a temp file only this user can read, run `fn`, and always delete the folder:
 * in `finally`, and on SIGINT / SIGTERM / an uncaught exception while it exists.
 * @template T
 * @param {Record<string, string>} secrets
 * @param {(file: string) => T} fn
 * @returns {T}
 */
function withSecretsFile(secrets, fn) {
	const dir = mkdtempSync(path.join(tmpdir(), 'crm-deploy-'));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	/** @param {NodeJS.Signals} signal */
	const onSignal = (signal) => {
		cleanup();
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	/** @param {unknown} err */
	const onUncaught = (err) => {
		cleanup();
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	process.on('uncaughtException', onUncaught);
	process.on('exit', cleanup);
	try {
		const file = path.join(dir, 'secrets.json');
		writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
		return fn(file);
	} finally {
		cleanup();
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		process.off('uncaughtException', onUncaught);
		process.off('exit', cleanup);
	}
}

/**
 * `npm run deploy`: the I/O around scripts/deploy-plan.mjs (#730). An existing install deploys
 * exactly as before (classic mode); a new one gets its config, D1 database, R2 bucket and secrets
 * (install mode). The migration step is `--remote`, so run this against production only after review.
 */
function main() {
	const wranglerBin = resolveWranglerBin(require);
	const code = runDeploy({
		argv: process.argv.slice(2),
		ci: isCi(),
		workersBuilds: isWorkersBuilds(),
		run(step, opts = {}) {
			const [command, ...args] = step;
			// Use this install's wrangler, not whatever `wrangler` happens to be on PATH.
			const [bin, argv] = command === 'wrangler' ? [process.execPath, [wranglerBin, ...args]] : [command, args];
			if (!opts.capture) {
				// Interactive, as the deploy always ran: inherited stdio, inherited env.
				const result = spawnSync(bin, argv, { stdio: 'inherit' });
				if (result.error) {
					console.error(result.error.message);
					return { code: 1 };
				}
				return { code: result.status ?? 1 };
			}
			const result = spawnSync(bin, argv, {
				cwd: ROOT,
				stdio: ['inherit', 'pipe', 'pipe'],
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
				env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
			});
			if (result.error) return { code: 1, stdout: '', stderr: result.error.message };
			return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
		},
		exists: (file) => existsSync(path.join(ROOT, file)),
		read: (file) => readFileSync(path.join(ROOT, file), 'utf8'),
		write: (file, text) => {
			const full = path.join(ROOT, file);
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, text);
		},
		remove: (file) => rmSync(path.join(ROOT, file), { force: true }),
		randomBytes: (n) => new Uint8Array(randomBytes(n)),
		withSecretsFile,
		log: (line) => console.log(line)
	});
	process.exit(code);
}

const invokedDirectly =
	process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

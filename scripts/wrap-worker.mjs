// #729: run by `npm run build` right after `vite build`. Wraps the Cloudflare adapter's Worker so
// the app has a `scheduled` handler (the built-in clock); see scripts/wrap-worker-lib.mjs.
//
//   node scripts/wrap-worker.mjs [dir]     dir defaults to .svelte-kit/cloudflare
//
// The folder must be the one wrangler's `main` points at (`<dir>/_worker.js`); the template and
// our own wrangler.jsonc both use .svelte-kit/cloudflare/_worker.js.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { wrapWorker } from './wrap-worker-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Import specifier of internal-tick.ts from `dir`, POSIX, starting with `./` or `../`.
 * @param {string} dir
 */
export function tickModuleFrom(dir) {
	const rel = path.relative(dir, path.join(root, 'src/lib/server/internal-tick.ts')).split(path.sep).join('/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

function main() {
	const dir = path.resolve(root, process.argv[2] ?? '.svelte-kit/cloudflare');
	const fs = {
		exists: (/** @type {string} */ p) => existsSync(p),
		read: (/** @type {string} */ p) => readFileSync(p, 'utf8'),
		write: (/** @type {string} */ p, /** @type {string} */ text) => writeFileSync(p, text),
		rename: (/** @type {string} */ from, /** @type {string} */ to) => renameSync(from, to)
	};
	try {
		const { wrapped } = wrapWorker(dir.split(path.sep).join('/'), fs, { tickModule: tickModuleFrom(dir) });
		console.log(wrapped ? `wrap-worker: ${path.relative(root, dir)}/_worker.js now has the scheduled tick` : 'wrap-worker: already wrapped');
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main();

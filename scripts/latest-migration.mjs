// #609: the newest migration file name (e.g. "0122_brand_kit.sql"), read at build time by
// vite.config.ts / vitest.config.ts and baked in as __LATEST_MIGRATION__ for Settings → Setup.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function latestMigration(dir = path.join(root, 'migrations')) {
	try {
		const names = readdirSync(dir)
			.filter((n) => /^\d+.*\.sql$/.test(n))
			.sort();
		return names.at(-1) ?? '';
	} catch {
		return '';
	}
}

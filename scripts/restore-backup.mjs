#!/usr/bin/env node
// Restore a D1 backup (#308) made by src/lib/server/backups.ts. See docs/backups.md.
//
//   node scripts/restore-backup.mjs --dir ./backup-2026-10-17 --db postmark-restore --remote
//   node scripts/restore-backup.mjs --date 2026-10-17 --bucket postmark-marketing-media \
//        --dir ./backup-2026-10-17 --db postmark-restore --remote --table contacts
//
// Options:
//   --dir <path>        folder with manifest.json and the .ndjson.gz files (required)
//   --date <YYYY-MM-DD> with --bucket: download that backup from R2 into --dir first
//   --bucket <name>     R2 bucket name (the MEDIA binding's bucket: postmark-marketing-media)
//   --db <name>         D1 database to restore into (required unless --sql-only)
//   --local | --remote  which D1 (one is required unless --sql-only)
//   --table <name>      restore only this table (repeatable); default every table
//   --mode replace|missing
//                       replace = empty each table, then insert (default for a full restore)
//                       missing = INSERT OR IGNORE, only rows that aren't there (default with --table)
//   --out <file>        where to write the SQL (default <dir>/restore.sql)
//   --sql-only          write the SQL, don't run wrangler
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { buildRestoreSql, candidateNames, parseManifest, parseNdjson, selectTables } from './restore-backup-lib.mjs';
import { resolveWranglerBin } from './wrangler-bin.mjs';

const require = createRequire(import.meta.url);
const wranglerBin = resolveWranglerBin(require);

function parseArgs(argv) {
	const a = { tables: [], local: false, remote: false, sqlOnly: false };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${k} needs a value`);
			return v;
		};
		if (k === '--dir') a.dir = next();
		else if (k === '--date') a.date = next();
		else if (k === '--bucket') a.bucket = next();
		else if (k === '--db') a.db = next();
		else if (k === '--table') a.tables.push(next());
		else if (k === '--mode') a.mode = next();
		else if (k === '--out') a.out = next();
		else if (k === '--local') a.local = true;
		else if (k === '--remote') a.remote = true;
		else if (k === '--sql-only') a.sqlOnly = true;
		else throw new Error(`unknown option: ${k}`);
	}
	if (!a.dir) throw new Error('--dir is required');
	if (a.mode && a.mode !== 'replace' && a.mode !== 'missing') throw new Error('--mode is replace or missing');
	if (!a.sqlOnly) {
		if (!a.db) throw new Error('--db is required (or pass --sql-only)');
		if (a.local === a.remote) throw new Error('pass exactly one of --local / --remote');
	}
	return a;
}

function wrangler(args) {
	const r = spawnSync(process.execPath, [wranglerBin, ...args], { stdio: 'inherit' });
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed (${r.status})`);
}

function download(bucket, date, file, dir) {
	wrangler(['r2', 'object', 'get', `${bucket}/backups/${date}/${file}`, '--file', join(dir, file), '--remote']);
}

function findFile(dir, date, file) {
	for (const name of candidateNames(date, file)) {
		const p = join(dir, name);
		if (existsSync(p)) return p;
	}
	throw new Error(`missing ${file} in ${dir}`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.dir, { recursive: true });

	if (args.bucket && args.date) download(args.bucket, args.date, 'manifest.json', args.dir);
	const manifestPath = existsSync(join(args.dir, 'manifest.json'))
		? join(args.dir, 'manifest.json')
		: findFile(args.dir, args.date ?? '', 'manifest.json');
	const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
	const selected = selectTables(manifest, args.tables);
	const mode = args.mode ?? (args.tables.length ? 'missing' : 'replace');

	console.log(`Backup ${manifest.date} · schema ${manifest.schemaVersion ?? 'unknown'} · ${selected.length} table(s) · mode ${mode}`);
	if (mode === 'replace' && args.tables.length) {
		console.warn('Warning: replace mode empties these tables first; ON DELETE CASCADE also removes child rows in tables you did not select.');
	}

	const tables = [];
	for (const t of selected) {
		const rows = [];
		for (const f of t.files) {
			if (args.bucket && args.date) download(args.bucket, args.date, f, args.dir);
			rows.push(...parseNdjson(gunzipSync(readFileSync(findFile(args.dir, manifest.date, f))).toString('utf8')));
		}
		if (rows.length !== t.rows) throw new Error(`${t.name}: manifest says ${t.rows} rows, files have ${rows.length}`);
		tables.push({ name: t.name, rows });
		console.log(`  ${t.name}: ${rows.length} rows`);
	}

	const sql = buildRestoreSql(tables, { mode, redacted: manifest.redacted, date: manifest.date });
	const out = args.out ?? join(args.dir, 'restore.sql');
	writeFileSync(out, sql);
	console.log(`Wrote ${out} (${(sql.length / 1024).toFixed(0)} KB).`);
	if (manifest.redacted.length) {
		console.log(`Not in the backup (re-create after restoring): ${manifest.redacted.map((c) => `${c.table}.${c.column}`).join(', ')}; ${manifest.excludedTables.join(', ')}.`);
	}
	if (args.sqlOnly) return;

	wrangler(['d1', 'execute', args.db, args.remote ? '--remote' : '--local', '--file', out]);
	console.log('Restore finished. Spot-check counts, e.g.:');
	console.log(`  npx wrangler d1 execute ${args.db} ${args.remote ? '--remote' : '--local'} --command "SELECT COUNT(*) FROM contacts"`);
}

try {
	main();
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}

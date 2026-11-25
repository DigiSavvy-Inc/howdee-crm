// Nightly D1 backups to R2 (#308).
//
// Every table is exported as newline-delimited JSON, gzipped (CompressionStream), to the
// `MEDIA` bucket under `backups/YYYY-MM-DD/<table>.ndjson.gz` (the date is the app timezone's,
// Settings → Timezone). A table over PART_ROWS rows is split: `<table>.ndjson.gz`, then
// `<table>.2.ndjson.gz`, … — the manifest lists every file. `manifest.json` is written last,
// so a folder without one is an unfinished run.
//
// - Schedule: the heartbeat tick starts one run per local day once it is 03:00 or later
//   (`backup_cron_date` = that date, stamped before the run). Settings → Backups "Back up now"
//   starts one at any time (same folder for the day; it replaces that day's files).
// - Work is spread over ticks: each step exports whole PART_ROWS slices until TICK_BUDGET_MS
//   is spent, reading PAGE_ROWS rows per query (keyset on rowid). The cursor lives in
//   app_state `backup_run` (JSON). A lease (`backup_lock`) keeps a manual run and the tick
//   from running a step at the same time. A failing step retries on the next tick, up to
//   MAX_ATTEMPTS, then the run is dropped and the failure recorded.
// - Secrets are never written (EXCLUDED_TABLES, REDACTED_COLUMNS, EXCLUDED_APP_STATE_KEYS);
//   the manifest lists them. Sessions are HMAC-signed cookies and never stored in D1.
// - Retention: the newest 14 finished backups plus the newest 8 Sunday ones; every other
//   `backups/<date>/` folder is deleted after a run finishes.
// - Status: app_state `backup_last` (JSON of the last run, ok or not) and
//   `backup_last_success_at` (ISO). Settings warns when that is over 36h old.
//
// Restore: scripts/restore-backup.mjs + docs/backups.md.

import { getTimezone } from './settings';
import { localParts } from './businessdays';

export const BACKUP_PREFIX = 'backups/';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_VERSION = 1;
/** Rows per D1 query. */
export const PAGE_ROWS = 5000;
/** Rows per R2 object (and per resumable slice). */
export const PART_ROWS = 50_000;
/** Smaller pages for tables with big text columns (rendered HTML, raw email, payloads). */
export const HEAVY_PAGE_ROWS: Record<string, number> = {
	campaigns: 200,
	templates: 200,
	pages: 200,
	replies: 500,
	ai_messages: 500,
	webhook_events: 1000,
	luma_events: 1000,
};
export const TICK_BUDGET_MS = 20_000;
export const MAX_ATTEMPTS = 3;
export const NIGHTLY_HOUR = 3;
export const STALE_AFTER_MS = 36 * 3600_000;
export const KEEP_DAILY = 14;
export const KEEP_WEEKLY = 8;
const LOCK_LEASE_MS = 10 * 60_000;

const RUN_KEY = 'backup_run';
const LOCK_KEY = 'backup_lock';
const CRON_KEY = 'backup_cron_date';
const LAST_KEY = 'backup_last';
const SUCCESS_KEY = 'backup_last_success_at';

/** Whole tables never exported. */
export const EXCLUDED_TABLES: { table: string; reason: string }[] = [
	{ table: 'integration_secrets', reason: 'sealed integration and Anthropic tokens' },
	{ table: 'd1_migrations', reason: 'recreated by wrangler d1 migrations apply' }
];

/**
 * Columns dropped from every row. `restore` tells the restore script what to write instead:
 * `null` (the column is nullable) or `placeholder` (NOT NULL / UNIQUE — a per-row
 * `redacted:<table>:<n>` value that never authenticates anything).
 */
export const REDACTED_COLUMNS: { table: string; column: string; reason: string; restore: 'null' | 'placeholder' }[] = [
	{ table: 'api_keys', column: 'token_hash', reason: 'API key hashes', restore: 'placeholder' },
	{ table: 'webhook_keys', column: 'token', reason: 'form webhook keys (plaintext, before #742)', restore: 'placeholder' },
	{ table: 'webhook_keys', column: 'token_hash', reason: 'form webhook key hashes (#742)', restore: 'null' },
	{ table: 'mail_accounts', column: 'refresh_blob', reason: 'sealed Gmail refresh tokens', restore: 'placeholder' },
	{ table: 'users', column: 'password_hash', reason: 'password hashes', restore: 'null' },
	{ table: 'subscription_confirmations', column: 'token_hash', reason: 'double opt-in link hashes (#510)', restore: 'placeholder' },
	{ table: 'account_tokens', column: 'token_hash', reason: 'invite / reset / verify link hashes (#639)', restore: 'placeholder' }
];

/** app_state rows never exported (secrets). The run cursor and lease are skipped too. */
export const EXCLUDED_APP_STATE_KEYS: string[] = ['luma_webhook_secret'];
const SKIPPED_APP_STATE_KEYS = new Set([...EXCLUDED_APP_STATE_KEYS, RUN_KEY, LOCK_KEY]);

/** Not tables, listed so the manifest answers "where are the sessions?". */
export const NOT_STORED: string[] = ['sessions (HMAC-signed cookies, never stored in D1)'];

export type BackupTrigger = 'cron' | 'manual';

export type TableResult = { rows: number; bytes: number; files: string[] };

export type BackupRun = {
	date: string;
	trigger: BackupTrigger;
	startedAt: string;
	tables: string[];
	/** Index into `tables` of the table being exported. */
	index: number;
	/** Last exported rowid of the current table (null = start of the table). */
	afterRowid: number | null;
	/** 1-based part number of the next object for the current table. */
	part: number;
	done: Record<string, TableResult>;
	attempts: number;
	elapsedMs: number;
};

export type BackupManifest = {
	version: number;
	date: string;
	trigger: BackupTrigger;
	created_at: string;
	finished_at: string;
	duration_ms: number;
	schema_version: string | null;
	tables: Record<string, TableResult>;
	total_rows: number;
	total_bytes: number;
	excluded: {
		tables: { table: string; reason: string }[];
		columns: { table: string; column: string; reason: string; restore: 'null' | 'placeholder' }[];
		app_state_keys: string[];
		not_stored: string[];
	};
};

export type BackupLast =
	| { ok: true; date: string; trigger: BackupTrigger; finished_at: string; duration_ms: number; total_rows: number; total_bytes: number; tables: Record<string, number>; pruned: number }
	| { ok: false; date: string | null; trigger: BackupTrigger | null; at: string; error: string; gave_up: boolean };

/** The bucket surface this module uses — the real R2Bucket or a test stub. */
export type BackupBucket = Pick<R2Bucket, 'put' | 'get' | 'list' | 'delete'>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string | null }>();
	return row?.value ?? null;
}

async function putState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

async function deleteState(db: D1Database, key: string): Promise<void> {
	await db.prepare('DELETE FROM app_state WHERE key = ?').bind(key).run();
}

function parseJson<T>(s: string | null): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(?:[a-z0-9_]+(?:\.\d+)?\.ndjson\.gz|manifest\.json)$/i;

export function isBackupDate(s: string): boolean {
	return DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

export function isBackupFile(s: string): boolean {
	return FILE_RE.test(s);
}

export function backupKey(date: string, file: string): string {
	return `${BACKUP_PREFIX}${date}/${file}`;
}

/** Object name of a table's Nth part (1 = `<table>.ndjson.gz`). */
export function partFile(table: string, part: number): string {
	return part <= 1 ? `${table}.ndjson.gz` : `${table}.${part}.ndjson.gz`;
}

/** Local calendar date (YYYY-MM-DD) and hour in `tz`. */
export function localDateHour(now: Date, tz: string): { date: string; hour: number } {
	const p = localParts(now, tz);
	const pad = (n: number) => String(n).padStart(2, '0');
	return { date: `${p.y}-${pad(p.m)}-${pad(p.day)}`, hour: p.hour };
}

function errMessage(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Tables to export, in creation order (parents before children, mostly). */
export async function listBackupTables(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name NOT LIKE '!_cf!_%' ESCAPE '!'
			 ORDER BY rowid`
		)
		.all<{ name: string }>();
	const excluded = new Set(EXCLUDED_TABLES.map((t) => t.table));
	return results.map((r) => r.name).filter((n) => !excluded.has(n) && /^[A-Za-z0-9_]+$/.test(n));
}

/** Latest applied migration name, or null when the table isn't there (tests, odd setups). */
export async function schemaVersion(db: D1Database): Promise<string | null> {
	try {
		const row = await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>();
		return row?.name ?? null;
	} catch {
		return null;
	}
}

/** One row as it goes into the file: redacted columns dropped, blobs as `{ $blob: hex }`. */
export function cleanRow(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
	if (table === 'app_state' && SKIPPED_APP_STATE_KEYS.has(String(row.key))) return null;
	const out: Record<string, unknown> = {};
	const drop = new Set(REDACTED_COLUMNS.filter((c) => c.table === table).map((c) => c.column));
	for (const [k, v] of Object.entries(row)) {
		if (k === '__rowid' || drop.has(k)) continue;
		if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
			const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
			out[k] = { $blob: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') };
		} else if (Array.isArray(v) && v.every((b) => typeof b === 'number')) {
			// D1 returns BLOB columns as number arrays.
			out[k] = { $blob: (v as number[]).map((b) => (b & 255).toString(16).padStart(2, '0')).join('') };
		} else {
			out[k] = v;
		}
	}
	return out;
}

async function gzipLines(lines: AsyncIterable<string>): Promise<{ bytes: Uint8Array; count: number }> {
	const cs = new CompressionStream('gzip');
	const writer = cs.writable.getWriter();
	const collected = new Response(cs.readable).arrayBuffer();
	const enc = new TextEncoder();
	let count = 0;
	try {
		for await (const line of lines) {
			await writer.write(enc.encode(line + '\n'));
			count++;
		}
	} finally {
		await writer.close();
	}
	return { bytes: new Uint8Array(await collected), count };
}

/**
 * Export one slice (≤ PART_ROWS rows after `afterRowid`) of `table` to one object.
 * Returns the last rowid read and whether the table is finished.
 */
export async function exportSlice(
	db: D1Database,
	bucket: BackupBucket,
	date: string,
	table: string,
	part: number,
	afterRowid: number | null,
	opts: { pageRows?: number; partRows?: number } = {}
): Promise<{ rows: number; bytes: number; file: string; lastRowid: number | null; finished: boolean }> {
	const pageRows = opts.pageRows ?? HEAVY_PAGE_ROWS[table] ?? PAGE_ROWS;
	const partRows = opts.partRows ?? PART_ROWS;
	let last = afterRowid;
	let read = 0;
	let finished = false;

	async function* lines(): AsyncGenerator<string> {
		while (read < partRows) {
			const limit = Math.min(pageRows, partRows - read);
			const { results } = await db
				.prepare(`SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
				.bind(last ?? -1, limit)
				.all<Record<string, unknown>>();
			for (const r of results) {
				last = Number(r.__rowid);
				const clean = cleanRow(table, r);
				if (clean) yield JSON.stringify(clean);
			}
			read += results.length;
			if (results.length < limit) {
				finished = true;
				return;
			}
		}
		// Exactly partRows read: finished only if nothing follows.
		const more = await db
			.prepare(`SELECT 1 AS x FROM "${table}" WHERE rowid > ? LIMIT 1`)
			.bind(last ?? -1)
			.first();
		finished = !more;
	}

	const { bytes, count } = await gzipLines(lines());
	const file = partFile(table, part);
	await bucket.put(backupKey(date, file), bytes, {
		httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
		customMetadata: { rows: String(count) }
	});
	return { rows: count, bytes: bytes.byteLength, file, lastRowid: last, finished };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function readRun(db: D1Database): Promise<BackupRun | null> {
	return parseJson<BackupRun>(await getState(db, RUN_KEY));
}

export async function readLast(db: D1Database): Promise<{ last: BackupLast | null; lastSuccessAt: string | null }> {
	return {
		last: parseJson<BackupLast>(await getState(db, LAST_KEY)),
		lastSuccessAt: await getState(db, SUCCESS_KEY)
	};
}

async function claimLock(db: D1Database, now: Date): Promise<boolean> {
	const expires = new Date(now.getTime() + LOCK_LEASE_MS).toISOString();
	const res = await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
			 WHERE app_state.value IS NULL OR app_state.value < ?`
		)
		.bind(LOCK_KEY, expires, now.toISOString())
		.run();
	return (res.meta.changes ?? 0) > 0;
}

async function releaseLock(db: D1Database): Promise<void> {
	await putState(db, LOCK_KEY, '');
}

/** Start a run (no export yet). Refused while one is in progress. */
export async function startRun(
	db: D1Database,
	trigger: BackupTrigger,
	now = new Date(),
	tz?: string
): Promise<{ ok: true; run: BackupRun } | { ok: false; error: string }> {
	if (await readRun(db)) return { ok: false, error: 'A backup is already running.' };
	const zone = tz ?? (await getTimezone(db));
	const run: BackupRun = {
		date: localDateHour(now, zone).date,
		trigger,
		startedAt: now.toISOString(),
		tables: await listBackupTables(db),
		index: 0,
		afterRowid: null,
		part: 1,
		done: {},
		attempts: 0,
		elapsedMs: 0
	};
	await putState(db, RUN_KEY, JSON.stringify(run));
	return { ok: true, run };
}

export type StepResult =
	| { state: 'idle' }
	| { state: 'locked' }
	| { state: 'progress'; table: string | null; tablesDone: number; tablesTotal: number }
	| { state: 'finished'; manifest: BackupManifest; pruned: number }
	| { state: 'error'; error: string; gaveUp: boolean };

/**
 * Advance the current run within `budgetMs`. Writes the manifest, prunes old backups and
 * records `backup_last` when the last table is done.
 */
export async function runBackupStep(
	db: D1Database,
	bucket: BackupBucket,
	opts: { now?: () => number; budgetMs?: number; pageRows?: number; partRows?: number } = {}
): Promise<StepResult> {
	const clock = opts.now ?? Date.now;
	const t0 = clock();
	const run = await readRun(db);
	if (!run) return { state: 'idle' };
	if (!(await claimLock(db, new Date(t0)))) return { state: 'locked' };
	const budget = opts.budgetMs ?? TICK_BUDGET_MS;
	try {
		while (run.index < run.tables.length) {
			const table = run.tables[run.index];
			const slice = await exportSlice(db, bucket, run.date, table, run.part, run.afterRowid, opts);
			const prev = run.done[table] ?? { rows: 0, bytes: 0, files: [] };
			run.done[table] = { rows: prev.rows + slice.rows, bytes: prev.bytes + slice.bytes, files: [...prev.files, slice.file] };
			if (slice.finished) {
				run.index++;
				run.afterRowid = null;
				run.part = 1;
			} else {
				run.afterRowid = slice.lastRowid;
				run.part++;
			}
			run.attempts = 0;
			if (clock() - t0 >= budget) break;
		}
		run.elapsedMs += clock() - t0;

		if (run.index < run.tables.length) {
			await putState(db, RUN_KEY, JSON.stringify(run));
			return { state: 'progress', table: run.tables[run.index] ?? null, tablesDone: run.index, tablesTotal: run.tables.length };
		}

		const manifest = await finishRun(db, bucket, run, new Date(clock()));
		const pruned = await pruneBackups(bucket, run.date).catch((e) => {
			console.error('backup prune failed:', errMessage(e));
			return 0;
		});
		const last: BackupLast = {
			ok: true,
			date: run.date,
			trigger: run.trigger,
			finished_at: manifest.finished_at,
			duration_ms: manifest.duration_ms,
			total_rows: manifest.total_rows,
			total_bytes: manifest.total_bytes,
			tables: Object.fromEntries(Object.entries(manifest.tables).map(([t, r]) => [t, r.rows])),
			pruned
		};
		await putState(db, LAST_KEY, JSON.stringify(last));
		await putState(db, SUCCESS_KEY, manifest.finished_at);
		await deleteState(db, RUN_KEY);
		return { state: 'finished', manifest, pruned };
	} catch (e) {
		const error = errMessage(e);
		run.attempts++;
		run.elapsedMs += clock() - t0;
		const gaveUp = run.attempts >= MAX_ATTEMPTS;
		if (gaveUp) await deleteState(db, RUN_KEY);
		else await putState(db, RUN_KEY, JSON.stringify(run));
		const last: BackupLast = { ok: false, date: run.date, trigger: run.trigger, at: new Date(clock()).toISOString(), error, gave_up: gaveUp };
		await putState(db, LAST_KEY, JSON.stringify(last));
		console.error('backup step failed:', error);
		return { state: 'error', error, gaveUp };
	} finally {
		await releaseLock(db).catch(() => {});
	}
}

async function finishRun(db: D1Database, bucket: BackupBucket, run: BackupRun, end: Date): Promise<BackupManifest> {
	const tables: Record<string, TableResult> = {};
	for (const t of run.tables) tables[t] = run.done[t] ?? { rows: 0, bytes: 0, files: [] };
	const values = Object.values(tables);
	const manifest: BackupManifest = {
		version: MANIFEST_VERSION,
		date: run.date,
		trigger: run.trigger,
		created_at: run.startedAt,
		finished_at: end.toISOString(),
		duration_ms: run.elapsedMs,
		schema_version: await schemaVersion(db),
		tables,
		total_rows: values.reduce((n, r) => n + r.rows, 0),
		total_bytes: values.reduce((n, r) => n + r.bytes, 0),
		excluded: {
			tables: EXCLUDED_TABLES,
			columns: REDACTED_COLUMNS,
			app_state_keys: EXCLUDED_APP_STATE_KEYS,
			not_stored: NOT_STORED
		}
	};
	await bucket.put(backupKey(run.date, MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
		httpMetadata: { contentType: 'application/json' }
	});
	return manifest;
}

/**
 * The heartbeat entry: start tonight's run once it is 03:00+ local (once per local day),
 * then advance whatever run is in progress. Never throws.
 */
export async function runBackupTick(
	db: D1Database,
	bucket: BackupBucket | undefined,
	opts: { now?: () => number; budgetMs?: number; tz?: string } = {}
): Promise<{ skipped: string } | { started?: boolean } & StepResult> {
	try {
		if (!bucket) return { skipped: 'no MEDIA bucket' };
		const clock = opts.now ?? Date.now;
		const now = new Date(clock());
		let started = false;
		if (!(await readRun(db))) {
			const tz = opts.tz ?? (await getTimezone(db));
			const { date, hour } = localDateHour(now, tz);
			if (hour < NIGHTLY_HOUR) return { skipped: 'before 03:00' };
			if ((await getState(db, CRON_KEY)) === date) return { skipped: 'ran today' };
			await putState(db, CRON_KEY, date);
			const s = await startRun(db, 'cron', now, tz);
			started = s.ok;
		}
		const step = await runBackupStep(db, bucket, opts);
		return { started, ...step };
	} catch (e) {
		const error = errMessage(e);
		console.error('backup tick failed:', error);
		return { state: 'error', error, gaveUp: false };
	}
}

// ---------------------------------------------------------------------------
// Listing + retention
// ---------------------------------------------------------------------------

async function listAll(bucket: BackupBucket, options: R2ListOptions): Promise<R2Objects[]> {
	const pages: R2Objects[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 100; i++) {
		const page = await bucket.list({ ...options, cursor });
		pages.push(page);
		if (!page.truncated) break;
		cursor = (page as { cursor?: string }).cursor;
		if (!cursor) break;
	}
	return pages;
}

/** Every `backups/<date>/` folder in the bucket, newest first. */
export async function listBackupDates(bucket: BackupBucket): Promise<string[]> {
	const pages = await listAll(bucket, { prefix: BACKUP_PREFIX, delimiter: '/' });
	const dates = new Set<string>();
	for (const p of pages) {
		for (const pre of p.delimitedPrefixes ?? []) {
			const d = pre.slice(BACKUP_PREFIX.length).replace(/\/$/, '');
			if (isBackupDate(d)) dates.add(d);
		}
	}
	return [...dates].sort().reverse();
}

export async function readManifest(bucket: BackupBucket, date: string): Promise<BackupManifest | null> {
	const obj = await bucket.get(backupKey(date, MANIFEST_FILE));
	if (!obj) return null;
	try {
		return JSON.parse(await obj.text()) as BackupManifest;
	} catch {
		return null;
	}
}

/** Finished backups (those with a manifest), newest first. */
export async function listBackups(bucket: BackupBucket): Promise<BackupManifest[]> {
	const out: BackupManifest[] = [];
	for (const d of await listBackupDates(bucket)) {
		const m = await readManifest(bucket, d);
		if (m) out.push(m);
	}
	return out;
}

function isSunday(date: string): boolean {
	return new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
}

/** Which finished backup dates to keep: the newest `daily`, plus the newest `weekly` Sundays. */
export function retentionKeep(dates: string[], daily = KEEP_DAILY, weekly = KEEP_WEEKLY): Set<string> {
	const sorted = [...new Set(dates.filter(isBackupDate))].sort().reverse();
	const keep = new Set(sorted.slice(0, daily));
	for (const d of sorted.filter(isSunday).slice(0, weekly)) keep.add(d);
	return keep;
}

/**
 * Delete every backup folder outside the retention set. An unfinished folder (no manifest)
 * is deleted too, unless it's `activeDate` (the run in progress). Returns folders removed.
 */
export async function pruneBackups(bucket: BackupBucket, activeDate?: string): Promise<number> {
	const dates = await listBackupDates(bucket);
	const finished: string[] = [];
	for (const d of dates) if (await readManifest(bucket, d)) finished.push(d);
	const keep = retentionKeep(finished);
	let removed = 0;
	for (const d of dates) {
		if (keep.has(d) || d === activeDate) continue;
		const keys: string[] = [];
		for (const p of await listAll(bucket, { prefix: `${BACKUP_PREFIX}${d}/` })) for (const o of p.objects) keys.push(o.key);
		for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
		removed++;
	}
	return removed;
}

/** True when there's no success yet or the last one is over 36h old. */
export function backupIsStale(lastSuccessAt: string | null, now = Date.now()): boolean {
	const t = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
	return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

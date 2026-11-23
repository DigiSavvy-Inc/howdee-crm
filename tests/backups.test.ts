import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	backupIsStale,
	backupKey,
	listBackups,
	partFile,
	pruneBackups,
	readLast,
	readRun,
	retentionKeep,
	runBackupStep,
	runBackupTick,
	startRun,
	type BackupBucket,
	type BackupManifest
} from '../src/lib/server/backups';
import { buildRestoreSql, parseManifest, parseNdjson, selectTables, sqlLiteral, tableInsertSql, MAX_STATEMENT_BYTES } from '../scripts/restore-backup-lib.mjs';
import { load as backupsLoad } from '../src/routes/settings/backups/+page.server';
import { GET as downloadGet } from '../src/routes/settings/backups/download/[date]/[file]/+server';

const db = (env as any).DB as D1Database;

/** In-memory R2 stand-in: put/get/list (prefix + delimiter)/delete (one key or many). */
function fakeBucket() {
	const store = new Map<string, Uint8Array>();
	const toBytes = (v: unknown): Uint8Array =>
		typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
	const bucket = {
		store,
		async put(key: string, value: unknown) {
			store.set(key, toBytes(value));
			return {} as R2Object;
		},
		async get(key: string) {
			const b = store.get(key);
			if (!b) return null;
			return {
				body: new Blob([b as Uint8Array<ArrayBuffer>]).stream(),
				text: async () => new TextDecoder().decode(b),
				arrayBuffer: async () => b.slice().buffer
			} as unknown as R2ObjectBody;
		},
		async list(opts?: R2ListOptions) {
			const prefix = opts?.prefix ?? '';
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			const objects: { key: string }[] = [];
			const prefixes = new Set<string>();
			for (const k of keys) {
				const rest = k.slice(prefix.length);
				const cut = opts?.delimiter ? rest.indexOf(opts.delimiter) : -1;
				if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
				else objects.push({ key: k });
			}
			return { objects, delimitedPrefixes: [...prefixes], truncated: false } as unknown as R2Objects;
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		}
	};
	return bucket as typeof bucket & BackupBucket;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
	return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

async function rowsOf(bucket: ReturnType<typeof fakeBucket>, date: string, file: string) {
	const bytes = bucket.store.get(backupKey(date, file));
	if (!bytes) throw new Error(`no object ${file}`);
	return parseNdjson(await gunzip(bytes)) as Record<string, unknown>[];
}

function manifestOf(bucket: ReturnType<typeof fakeBucket>, date: string): BackupManifest {
	return JSON.parse(new TextDecoder().decode(bucket.store.get(backupKey(date, 'manifest.json'))!));
}

async function runToEnd(bucket: BackupBucket, opts: Parameters<typeof runBackupStep>[2] = {}) {
	for (let i = 0; i < 2000; i++) {
		const s = await runBackupStep(db, bucket, opts);
		if (s.state === 'finished') return { steps: i + 1, result: s };
		if (s.state === 'error' || s.state === 'idle') throw new Error(`step ${s.state}: ${'error' in s ? s.error : ''}`);
	}
	throw new Error('never finished');
}

const NOON = new Date('2026-10-14T12:00:00Z'); // a Wednesday

beforeEach(async () => {
	await db.prepare(`DELETE FROM app_state WHERE key LIKE 'backup_%' OR key = 'luma_webhook_secret'`).run();
});

async function seedContacts(n: number) {
	const stmts = [];
	for (let i = 0; i < n; i++) {
		stmts.push(db.prepare('INSERT INTO contacts (email, first_name) VALUES (?, ?)').bind(`b${i}-${crypto.randomUUID()}@example.com`, `N'${i}`));
	}
	await db.batch(stmts);
}

describe('backup export', () => {
	it('writes one gzipped ndjson object per table and a manifest', async () => {
		await seedContacts(3);
		const bucket = fakeBucket();
		const started = await startRun(db, 'manual', NOON, 'UTC');
		expect(started.ok).toBe(true);
		const { result } = await runToEnd(bucket);
		const m = result.manifest;
		expect(m.date).toBe('2026-10-14');
		expect(m.trigger).toBe('manual');
		expect(typeof m.duration_ms).toBe('number');
		expect('schema_version' in m).toBe(true);
		expect(m.tables.contacts.files).toEqual(['contacts.ndjson.gz']);

		const count = await db.prepare('SELECT COUNT(*) AS n FROM contacts').first<{ n: number }>();
		expect(m.tables.contacts.rows).toBe(count!.n);
		const rows = await rowsOf(bucket, '2026-10-14', 'contacts.ndjson.gz');
		expect(rows).toHaveLength(count!.n);
		expect(rows.some((r) => String(r.first_name).startsWith("N'"))).toBe(true);
		expect(rows[0]).not.toHaveProperty('__rowid');

		// Every listed file exists; manifest matches the store.
		for (const t of Object.values(m.tables)) for (const f of t.files) expect(bucket.store.has(backupKey(m.date, f))).toBe(true);
		expect(manifestOf(bucket, m.date).total_rows).toBe(m.total_rows);
		expect(await readRun(db)).toBeNull();
		const { last, lastSuccessAt } = await readLast(db);
		expect(last).toMatchObject({ ok: true, date: '2026-10-14' });
		expect(lastSuccessAt).toBe(m.finished_at);
		expect((await listBackups(bucket)).map((b) => b.date)).toEqual(['2026-10-14']);
	});

	it('leaves secrets out and lists the exclusions', async () => {
		await db.prepare(`INSERT INTO integration_secrets (provider, blob, last4, set_at) VALUES ('timing', 'v1.SECRETBLOB', 'abcd', datetime('now'))`).run();
		await db
			.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('k', 'HASHSECRET', 'dk_live_x', 'wxyz', 'read')`)
			.run();
		await db.prepare(`INSERT INTO webhook_keys (label, token) VALUES ('w', 'WEBHOOKSECRET')`).run();
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('luma_webhook_secret', 'whsec_SECRET')`).run();
		await db.prepare(`UPDATE users SET password_hash = 'pbkdf2-sha256$PWSECRET' WHERE id = (SELECT MIN(id) FROM users)`).run();

		const bucket = fakeBucket();
		await startRun(db, 'manual', NOON, 'UTC');
		const { result } = await runToEnd(bucket);
		const m = result.manifest;

		expect(m.tables).not.toHaveProperty('integration_secrets');
		expect([...bucket.store.keys()].some((k) => k.includes('integration_secrets'))).toBe(false);
		const all = (await Promise.all([...bucket.store.values()].map((b) => (b[0] === 0x1f ? gunzip(b) : new TextDecoder().decode(b))))).join('\n');
		for (const secret of ['SECRETBLOB', 'HASHSECRET', 'WEBHOOKSECRET', 'whsec_SECRET', 'PWSECRET']) expect(all).not.toContain(secret);

		const keys = await rowsOf(bucket, m.date, 'api_keys.ndjson.gz');
		expect(keys[0]).toMatchObject({ label: 'k', token_last4: 'wxyz' });
		expect(keys[0]).not.toHaveProperty('token_hash');
		const state = await rowsOf(bucket, m.date, 'app_state.ndjson.gz');
		expect(state.some((r) => r.key === 'luma_webhook_secret')).toBe(false);

		expect(m.excluded.tables.map((t) => t.table)).toContain('integration_secrets');
		expect(m.excluded.columns.map((c) => `${c.table}.${c.column}`)).toEqual(
			expect.arrayContaining(['api_keys.token_hash', 'webhook_keys.token', 'mail_accounts.refresh_blob', 'users.password_hash'])
		);
		expect(m.excluded.app_state_keys).toEqual(['luma_webhook_secret']);
		expect(m.excluded.not_stored.join(' ')).toMatch(/sessions/);
	});

	it('pages a table across steps with the cursor and splits it into parts', async () => {
		await seedContacts(25);
		const total = (await db.prepare('SELECT COUNT(*) AS n FROM contacts').first<{ n: number }>())!.n;
		const bucket = fakeBucket();
		await startRun(db, 'manual', NOON, 'UTC');

		// Budget 0 → one slice per step; watch the cursor while contacts is in progress.
		const opts = { pageRows: 4, partRows: 10, budgetMs: 0 };
		let sawCursor = false;
		for (let i = 0; i < 2000; i++) {
			const s = await runBackupStep(db, bucket, opts);
			if (s.state === 'finished') break;
			expect(s.state).toBe('progress');
			const run = await readRun(db);
			if (run && run.tables[run.index] === 'contacts' && run.afterRowid !== null) {
				sawCursor = true;
				expect(run.part).toBeGreaterThan(1);
			}
		}
		expect(sawCursor).toBe(true);
		const m = (await listBackups(bucket))[0];
		const parts = Math.ceil(total / 10);
		expect(m.tables.contacts.files).toEqual(Array.from({ length: parts }, (_, i) => partFile('contacts', i + 1)));
		const ids: number[] = [];
		for (const f of m.tables.contacts.files) for (const r of await rowsOf(bucket, m.date, f)) ids.push(Number(r.id));
		const expected = (await db.prepare('SELECT id FROM contacts ORDER BY rowid').all<{ id: number }>()).results.map((r) => r.id);
		expect(ids).toEqual(expected);
		expect(m.tables.contacts.rows).toBe(total);
	});

	it('refuses a second run while one is in progress', async () => {
		await startRun(db, 'manual', NOON, 'UTC');
		expect(await startRun(db, 'manual', NOON, 'UTC')).toMatchObject({ ok: false });
		await runToEnd(fakeBucket());
	});
});

describe('nightly schedule', () => {
	it('starts once per local day after 03:00', async () => {
		const bucket = fakeBucket();
		const at = (iso: string) => ({ now: () => Date.parse(iso), tz: 'America/Los_Angeles', budgetMs: 60_000 });
		// 02:30 in Los Angeles (PDT, UTC-7).
		expect(await runBackupTick(db, bucket, at('2026-10-14T09:30:00Z'))).toEqual({ skipped: 'before 03:00' });
		const first = await runBackupTick(db, bucket, at('2026-10-14T10:05:00Z'));
		expect(first).toMatchObject({ started: true, state: 'finished' });
		expect(await runBackupTick(db, bucket, at('2026-10-14T11:00:00Z'))).toEqual({ skipped: 'ran today' });
		expect(await runBackupTick(db, undefined)).toEqual({ skipped: 'no MEDIA bucket' });
		expect(bucket.store.has(backupKey('2026-10-14', 'manifest.json'))).toBe(true);
	});

	it('flags a stale backup after 36 hours', () => {
		const now = Date.parse('2026-10-14T12:00:00Z');
		expect(backupIsStale(null, now)).toBe(true);
		expect(backupIsStale('2026-10-13T12:00:00Z', now)).toBe(false);
		expect(backupIsStale('2026-10-12T23:00:00Z', now)).toBe(true);
	});
});

describe('retention', () => {
	const days = (n: number, from = '2026-10-31') => {
		const out: string[] = [];
		const d = new Date(`${from}T12:00:00Z`);
		for (let i = 0; i < n; i++) out.push(new Date(d.getTime() - i * 86400_000).toISOString().slice(0, 10));
		return out;
	};

	it('keeps the newest 14 daily plus the newest 8 Sundays', () => {
		const all = days(120);
		const keep = retentionKeep(all);
		const daily = all.slice(0, 14);
		const sundays = all.filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 0).slice(0, 8);
		expect([...keep].sort()).toEqual([...new Set([...daily, ...sundays])].sort());
		for (const d of daily) expect(keep.has(d)).toBe(true);
		expect(keep.has('2026-09-06')).toBe(true); // a Sunday 8 weeks back
		expect(keep.has(all[all.length - 1])).toBe(false);
		expect(sundays).toHaveLength(8);
	});

	it('prunes folders outside the set, unfinished ones, but never the active run', async () => {
		const bucket = fakeBucket();
		const all = days(30);
		for (const d of all) {
			await bucket.put(backupKey(d, 'contacts.ndjson.gz'), 'x');
			await bucket.put(backupKey(d, 'manifest.json'), JSON.stringify({ date: d }));
		}
		await bucket.put(backupKey('2026-08-01', 'contacts.ndjson.gz'), 'partial'); // no manifest
		await bucket.put(backupKey('2026-07-01', 'contacts.ndjson.gz'), 'active'); // no manifest, in progress
		await bucket.put('img/keep-me.png', 'other');
		const removed = await pruneBackups(bucket, '2026-07-01');
		const keep = retentionKeep(all);
		expect(removed).toBe(all.length - keep.size + 1);
		const left = new Set([...bucket.store.keys()].filter((k) => k.startsWith('backups/')).map((k) => k.split('/')[1]));
		expect([...left].sort()).toEqual([...keep, '2026-07-01'].sort());
		expect(bucket.store.has('img/keep-me.png')).toBe(true);
	});
});

describe('restore script helpers', () => {
	it('parses a manifest made by the export', async () => {
		const bucket = fakeBucket();
		await startRun(db, 'manual', NOON, 'UTC');
		const { result } = await runToEnd(bucket);
		const parsed = parseManifest(new TextDecoder().decode(bucket.store.get(backupKey(result.manifest.date, 'manifest.json'))!));
		expect(parsed.date).toBe('2026-10-14');
		expect(parsed.tables.find((t) => t.name === 'contacts')).toMatchObject({ files: ['contacts.ndjson.gz'] });
		expect(parsed.redacted).toContainEqual({ table: 'users', column: 'password_hash', restore: 'null' });
		expect(parsed.excludedTables).toContain('integration_secrets');
		expect(selectTables(parsed, ['contacts']).map((t) => t.name)).toEqual(['contacts']);
		expect(() => selectTables(parsed, ['nope'])).toThrow(/nope/);
	});

	it('rejects bad manifests', () => {
		expect(() => parseManifest('{')).toThrow(/JSON/);
		expect(() => parseManifest({ version: 2, date: '2026-10-14', tables: {} })).toThrow(/version/);
		expect(() => parseManifest({ version: 1, date: 'x', tables: {} })).toThrow(/date/);
		expect(() => parseManifest({ version: 1, date: '2026-10-14', tables: { 'a;b': { files: [] } } })).toThrow(/table/);
		expect(() => parseManifest({ version: 1, date: '2026-10-14', tables: { a: { files: ['../x'] } } })).toThrow(/file/);
	});

	it('builds SQL literals, placeholders and chunked big rows', () => {
		expect(sqlLiteral("it's")).toBe("'it''s'");
		expect(sqlLiteral(null)).toBe('NULL');
		expect(sqlLiteral(true)).toBe('1');
		expect(sqlLiteral({ $blob: 'ff00' })).toBe("X'ff00'");
		const { statements } = tableInsertSql('api_keys', [{ id: 1, label: 'a' }, { id: 2, label: 'b' }], {
			redacted: [{ table: 'api_keys', column: 'token_hash', restore: 'placeholder' }]
		});
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("'redacted:api_keys:1'");
		expect(statements[0]).toContain("'redacted:api_keys:2'");
		const big = tableInsertSql('campaigns', [{ id: 1, body_html: 'x'.repeat(250_000) }]);
		expect(big.usedBuffer).toBe(true);
		for (const s of big.statements) expect(new TextEncoder().encode(s).length).toBeLessThan(MAX_STATEMENT_BYTES);
		const sql = buildRestoreSql([{ name: 'contacts', rows: [{ id: 1 }] }], { mode: 'replace' });
		expect(sql).toMatch(/PRAGMA defer_foreign_keys = true;\nDELETE FROM "contacts";/);
	});

	it('restores missing rows from a backup (round trip on D1)', async () => {
		await seedContacts(2);
		const bucket = fakeBucket();
		await startRun(db, 'manual', NOON, 'UTC');
		const { result } = await runToEnd(bucket);
		const rows = await rowsOf(bucket, result.manifest.date, 'contacts.ndjson.gz');
		const victim = rows[rows.length - 1];
		await db.prepare('DELETE FROM contacts WHERE id = ?').bind(victim.id).run();

		const sql = buildRestoreSql([{ name: 'contacts', rows }], { mode: 'missing' });
		for (const stmt of sql.split('\n').filter((l) => l && !l.startsWith('--') && !l.startsWith('PRAGMA'))) await db.prepare(stmt).run();
		const back = await db.prepare('SELECT email, first_name FROM contacts WHERE id = ?').bind(victim.id).first();
		expect(back).toEqual({ email: victim.email, first_name: victim.first_name });
	});
});

describe('Settings → Backups', () => {
	it('is admin-only and streams a stored file', async () => {
		const bucket = fakeBucket();
		await startRun(db, 'manual', NOON, 'UTC');
		await runToEnd(bucket);
		const ev = (role: string) => ({ locals: { user: { id: 1, role } }, platform: { env: { MEDIA: bucket } } }) as any;
		await expect(backupsLoad({ ...ev('member'), platform: { env: { ...(env as any), MEDIA: bucket } } } as any)).rejects.toMatchObject({ status: 403 });
		const data = (await backupsLoad({ ...ev('admin'), platform: { env: { ...(env as any), MEDIA: bucket } } } as any)) as any;
		expect(data.backups[0].date).toBe('2026-10-14');
		expect(data.stale).toBe(false);

		await expect(downloadGet({ ...ev('member'), params: { date: '2026-10-14', file: 'manifest.json' } } as any)).rejects.toMatchObject({ status: 403 });
		await expect(downloadGet({ ...ev('admin'), params: { date: '2026-10-14', file: '../secret' } } as any)).rejects.toMatchObject({ status: 400 });
		const res = await downloadGet({ ...ev('admin'), params: { date: '2026-10-14', file: 'manifest.json' } } as any);
		expect(res.headers.get('content-disposition')).toContain('backup-2026-10-14-manifest.json');
		expect(JSON.parse(await res.text()).date).toBe('2026-10-14');
	});
});

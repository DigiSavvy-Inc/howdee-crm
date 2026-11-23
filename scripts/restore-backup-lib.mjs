// Pure helpers for scripts/restore-backup.mjs (#308): parse a backup manifest and turn
// ndjson rows into SQL for `wrangler d1 execute --file`. No Node imports, so the tests can
// load it inside workerd.

/** D1 refuses statements over 100 KB; stay well under. */
export const MAX_STATEMENT_BYTES = 90_000;
/** Rows per multi-row INSERT (SQLite caps VALUES lists at 500 terms). */
export const MAX_ROWS_PER_INSERT = 100;
/** Long strings are staged through a scratch table in chunks this many characters long. */
export const CHUNK_CHARS = 10_000;
const BUF = '_restore_buf';

/** @typedef {{ table: string, column: string, restore: 'null' | 'placeholder' }} Redacted */
/** @typedef {{ name: string, rows: number, files: string[] }} ManifestTable */
/**
 * @typedef {{ date: string, schemaVersion: string | null, createdAt: string | null, totalRows: number,
 *   tables: ManifestTable[], redacted: Redacted[], excludedTables: string[] }} ParsedManifest
 */

/**
 * Parse and check a manifest.json (string or object). Throws with a readable message.
 * @param {string | object} input
 * @returns {ParsedManifest}
 */
export function parseManifest(input) {
	/** @type {any} */
	let m;
	try {
		m = typeof input === 'string' ? JSON.parse(input) : input;
	} catch {
		throw new Error('manifest.json is not valid JSON');
	}
	if (!m || typeof m !== 'object') throw new Error('manifest.json is not an object');
	if (m.version !== 1) throw new Error(`unsupported manifest version: ${m.version}`);
	if (typeof m.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) throw new Error('manifest has no valid date');
	if (!m.tables || typeof m.tables !== 'object') throw new Error('manifest has no tables');
	/** @type {ManifestTable[]} */
	const tables = [];
	for (const [name, t] of /** @type {[string, any][]} */ (Object.entries(m.tables))) {
		if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`bad table name in manifest: ${name}`);
		const files = Array.isArray(t?.files) ? t.files : [];
		for (const f of files) {
			if (typeof f !== 'string' || !/^[A-Za-z0-9_]+(\.\d+)?\.ndjson\.gz$/.test(f)) throw new Error(`bad file name for ${name}: ${f}`);
		}
		tables.push({ name, rows: Number(t?.rows) || 0, files });
	}
	const columns = Array.isArray(m.excluded?.columns) ? m.excluded.columns : [];
	return {
		date: m.date,
		schemaVersion: typeof m.schema_version === 'string' ? m.schema_version : null,
		createdAt: m.created_at ?? null,
		totalRows: Number(m.total_rows) || 0,
		tables,
		redacted: columns
			.filter((/** @type {any} */ c) => c && typeof c.table === 'string' && typeof c.column === 'string')
			.map((/** @type {any} */ c) => /** @type {Redacted} */ ({ table: c.table, column: c.column, restore: c.restore === 'null' ? 'null' : 'placeholder' })),
		excludedTables: Array.isArray(m.excluded?.tables) ? m.excluded.tables.map((/** @type {any} */ t) => String(t?.table)) : []
	};
}

/**
 * The manifest's tables limited to `wanted` (empty = all), in manifest order.
 * @param {ParsedManifest} manifest
 * @param {string[]} wanted
 */
export function selectTables(manifest, wanted = []) {
	if (!wanted.length) return manifest.tables;
	const known = new Set(manifest.tables.map((t) => t.name));
	const missing = wanted.filter((w) => !known.has(w));
	if (missing.length) throw new Error(`not in this backup: ${missing.join(', ')}`);
	return manifest.tables.filter((t) => wanted.includes(t.name));
}

/**
 * Split ndjson text into row objects (blank lines skipped).
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export function parseNdjson(text) {
	const rows = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			throw new Error(`line ${i + 1} is not valid JSON`);
		}
	}
	return rows;
}

const quoteIdent = (/** @type {string} */ name) => `"${String(name).replace(/"/g, '""')}"`;
const quoteString = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;

/**
 * One value as an SQL literal.
 * @param {any} v
 * @returns {string}
 */
export function sqlLiteral(v) {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
	if (typeof v === 'bigint') return v.toString();
	if (typeof v === 'object' && typeof v.$blob === 'string' && /^[0-9a-f]*$/i.test(v.$blob)) return `X'${v.$blob}'`;
	if (typeof v === 'object') return quoteString(JSON.stringify(v));
	return quoteString(String(v));
}

const byteLength = (/** @type {string} */ s) => new TextEncoder().encode(s).length;

/**
 * SQL statements restoring one table's rows.
 * mode 'replace' = plain INSERT (the caller emptied the table first);
 * mode 'missing' = INSERT OR IGNORE (only rows whose key isn't there).
 * Redacted columns are written back as NULL or a unique `redacted:<table>:<n>` placeholder.
 * @param {string} table
 * @param {Record<string, unknown>[]} rows
 * @param {{ mode?: 'replace' | 'missing', redacted?: { table: string, column: string, restore: string }[] }} [opts]
 * @returns {{ statements: string[], usedBuffer: boolean }}
 */
export function tableInsertSql(table, rows, opts = {}) {
	const verb = opts.mode === 'missing' ? 'INSERT OR IGNORE INTO' : 'INSERT INTO';
	const redacted = (opts.redacted ?? []).filter((c) => c.table === table);
	/** @type {string[]} */
	const statements = [];
	let usedBuffer = false;
	/** @type {{ cols: string, tuples: string[], bytes: number }} */
	let batch = { cols: '', tuples: [], bytes: 0 };

	const flush = () => {
		if (batch.tuples.length) statements.push(`${verb} ${quoteIdent(table)} (${batch.cols}) VALUES ${batch.tuples.join(', ')};`);
		batch = { cols: '', tuples: [], bytes: 0 };
	};

	rows.forEach((raw, n) => {
		const row = { ...raw };
		for (const c of redacted) {
			if (!(c.column in row)) row[c.column] = c.restore === 'null' ? null : `redacted:${table}:${n + 1}`;
		}
		const keys = Object.keys(row);
		const cols = keys.map(quoteIdent).join(', ');
		const tuple = `(${keys.map((k) => sqlLiteral(row[k])).join(', ')})`;
		const head = `${verb} ${quoteIdent(table)} (${cols}) VALUES `;
		const size = byteLength(tuple);

		if (byteLength(head) + size + 2 > MAX_STATEMENT_BYTES) {
			// Too big for one statement: stage each long string in the scratch table.
			flush();
			usedBuffer = true;
			const parts = keys.map((k, i) => {
				const v = row[k];
				if (typeof v !== 'string' || v.length <= CHUNK_CHARS) return sqlLiteral(v);
				const id = i + 1;
				for (let at = 0; at < v.length; at += CHUNK_CHARS) {
					const chunk = quoteString(v.slice(at, at + CHUNK_CHARS));
					statements.push(
						at === 0
							? `INSERT INTO ${BUF} (id, v) VALUES (${id}, ${chunk});`
							: `UPDATE ${BUF} SET v = v || ${chunk} WHERE id = ${id};`
					);
				}
				return `(SELECT v FROM ${BUF} WHERE id = ${id})`;
			});
			statements.push(`${head}(${parts.join(', ')});`);
			statements.push(`DELETE FROM ${BUF};`);
			return;
		}

		if (
			batch.tuples.length &&
			(batch.cols !== cols || batch.tuples.length >= MAX_ROWS_PER_INSERT || byteLength(head) + batch.bytes + size + 2 > MAX_STATEMENT_BYTES)
		) {
			flush();
		}
		batch.cols = cols;
		batch.tuples.push(tuple);
		batch.bytes += size + 2;
	});
	flush();
	return { statements, usedBuffer };
}

/**
 * The whole restore file.
 * @param {{ name: string, rows: Record<string, unknown>[] }[]} tables in manifest order
 * @param {{ mode?: 'replace' | 'missing', redacted?: { table: string, column: string, restore: string }[], date?: string }} [opts]
 */
export function buildRestoreSql(tables, opts = {}) {
	const mode = opts.mode === 'missing' ? 'missing' : 'replace';
	const out = [
		`-- Restore from backup ${opts.date ?? ''} (${mode}) — generated by scripts/restore-backup.mjs`,
		'PRAGMA defer_foreign_keys = true;'
	];
	if (mode === 'replace') {
		// Children first, so ON DELETE actions have nothing left to touch.
		for (const t of [...tables].reverse()) out.push(`DELETE FROM ${quoteIdent(t.name)};`);
	}
	/** @type {string[]} */
	const body = [];
	let usedBuffer = false;
	for (const t of tables) {
		const res = tableInsertSql(t.name, t.rows, { mode, redacted: opts.redacted });
		usedBuffer ||= res.usedBuffer;
		body.push(`-- ${t.name}: ${t.rows.length} rows`, ...res.statements);
	}
	if (usedBuffer) out.push(`CREATE TABLE IF NOT EXISTS ${BUF} (id INTEGER PRIMARY KEY, v TEXT);`);
	out.push(...body);
	if (usedBuffer) out.push(`DROP TABLE IF EXISTS ${BUF};`);
	return out.join('\n') + '\n';
}

/**
 * File name in `dir`: the manifest's own name, or the Settings download name `backup-<date>-<file>`.
 * @param {string} date
 * @param {string} file
 */
export function candidateNames(date, file) {
	return [file, `backup-${date}-${file}`];
}

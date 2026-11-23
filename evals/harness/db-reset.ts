// Assistant evals (#391): put the eval D1 back to its freshly-migrated state between cases,
// so every case sees only its own fixture (counts, "how many…" questions). The suite uses
// its own binding (EVAL_DB), never the shared test DB.
//
// takeSnapshot() reads every table once, right after migrations (seed rows included).
// restoreSnapshot() deletes every row (children first) and re-inserts the snapshot (parents
// first, from PRAGMA foreign_key_list), in one batch with foreign keys deferred.

type TableSnap = { name: string; cols: string[]; rows: unknown[][] };
export type Snapshot = { tables: TableSnap[]; seq: { name: string; seq: number }[] };

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Tables ordered so a referenced (parent) table comes before the tables that reference it. */
function parentsFirst(names: string[], deps: Map<string, Set<string>>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (n: string, stack: Set<string>) => {
		if (seen.has(n) || stack.has(n)) return; // a cycle / self-reference: deferred FKs cover it
		stack.add(n);
		for (const p of deps.get(n) ?? []) if (p !== n && names.includes(p)) visit(p, stack);
		stack.delete(n);
		seen.add(n);
		out.push(n);
	};
	for (const n of [...names].sort()) visit(n, new Set());
	return out;
}

export async function takeSnapshot(db: D1Database): Promise<Snapshot> {
	const list = await db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table'
			   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'`
		)
		.all<{ name: string }>();
	const names = list.results.map((r) => r.name);
	const deps = new Map<string, Set<string>>();
	for (const n of names) {
		try {
			const fks = await db.prepare(`PRAGMA foreign_key_list(${quote(n)})`).all<{ table: string }>();
			deps.set(n, new Set(fks.results.map((f) => f.table)));
		} catch {
			deps.set(n, new Set()); // order unknown: the deferred-FK batch still restores it
		}
	}
	const tables: TableSnap[] = [];
	for (const n of parentsFirst(names, deps)) {
		const info = await db.prepare(`PRAGMA table_info(${quote(n)})`).all<{ name: string }>();
		const cols = info.results.map((c) => c.name);
		const rows = (await db.prepare(`SELECT ${cols.map(quote).join(', ')} FROM ${quote(n)} ORDER BY rowid`).raw()) as unknown[][];
		tables.push({ name: n, cols, rows });
	}
	let seq: Snapshot['seq'] = [];
	try {
		seq = (await db.prepare('SELECT name, seq FROM sqlite_sequence').all<{ name: string; seq: number }>()).results;
	} catch {
		/* no AUTOINCREMENT table */
	}
	return { tables, seq };
}

export async function restoreSnapshot(db: D1Database, snap: Snapshot): Promise<void> {
	const statements: D1PreparedStatement[] = [];
	for (const t of [...snap.tables].reverse()) statements.push(db.prepare(`DELETE FROM ${quote(t.name)}`));
	for (const t of snap.tables) {
		if (!t.rows.length) continue;
		const sql = `INSERT INTO ${quote(t.name)} (${t.cols.map(quote).join(', ')}) VALUES (${t.cols.map(() => '?').join(', ')})`;
		for (const row of t.rows) statements.push(db.prepare(sql).bind(...row));
	}
	try {
		await db.batch([db.prepare('PRAGMA defer_foreign_keys = on'), ...statements]);
	} catch {
		await db.batch(statements); // parents-first order alone is enough without self-references
	}
	// Same ids every case (best-effort: refs in recordings don't depend on it).
	try {
		await db.batch([
			db.prepare('DELETE FROM sqlite_sequence'),
			...snap.seq.map((s) => db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').bind(s.name, s.seq))
		]);
	} catch {
		/* D1 may refuse writes to sqlite_sequence: ids then keep counting up */
	}
}

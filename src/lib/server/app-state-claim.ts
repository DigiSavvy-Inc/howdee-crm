// #729: atomic claims on `app_state` for jobs the tick runs, so two clocks ticking in the same
// minute (the app's own Cron Trigger and the heartbeat Worker) can't both run one. Same shape as
// the backup and integration leases (backups.ts, integrations/index.ts): a conditional upsert whose
// `meta.changes` says whether this call won.

/**
 * Compare-and-set: store `next` under `key` only while the stored value is still `prev`
 * (`null` = no row yet, or a NULL value). True when this call wrote it. Two callers that read
 * the same `prev` can't both win: the second one finds `next` there and changes nothing.
 */
export async function casAppState(db: D1Database, key: string, prev: string | null, next: string): Promise<boolean> {
	const res = await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
			 WHERE app_state.value IS ?3`
		)
		.bind(key, next, prev)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Claim a lease (value = ISO expiry); false while another run holds an unexpired one. */
export async function claimLease(db: D1Database, key: string, now: Date, leaseMs: number): Promise<boolean> {
	const expires = new Date(now.getTime() + leaseMs).toISOString();
	const res = await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
			 WHERE app_state.value IS NULL OR app_state.value < ?`
		)
		.bind(key, expires, now.toISOString())
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Give a lease back (an empty value sorts before any ISO time, so the next claim wins). */
export async function releaseLease(db: D1Database, key: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, '', datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key)
		.run();
}

// #742: form webhook keys (`webhook_keys`, #48) — stored as a SHA-256 hash, looked up by hash.
// Keys made before migration 0138 are still plaintext until first used: the lookup falls back
// to the plaintext column, then writes the hash and replaces the plaintext with a placeholder
// in the same request. A placeholder row (`token_hash` set) never matches the fallback.
// Before migration 0138 is applied the new columns don't exist: the lookup then reads the
// plaintext `token` only and treats the key as trusted (`findPreMigrationKey`).
import { safeEqual } from './auth';
import { sha256Hex } from './api-keys';

export type WebhookKey = {
	id: number;
	default_list: string | null;
	source: string | null;
	default_tags: string | null;
	require_confirm: number;
	trust_body: number;
};

const COLS = 'id, default_list, source, default_tags, require_confirm, trust_body';

/** Placeholder written into the old plaintext column once a key is hashed. Not a secret. */
export const hashedPlaceholder = (hash: string) => `hashed:${hash}`;

/** True when the stored `token` is still the real key (an old key not yet moved over). */
export function isPlaintextToken(token: string | null | undefined): boolean {
	// `redacted:` = a backup restore's placeholder (backups.ts): never a key.
	return !!token && !/^(hashed|revoked|redacted):/.test(token);
}

/** 48 hex chars of CSPRNG. */
export function generateWebhookToken(): string {
	const b = new Uint8Array(24);
	crypto.getRandomValues(b);
	return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Columns for a new key: only the hash and the last 4 characters are stored. */
export async function newKeyColumns(token: string): Promise<{ token: string; token_hash: string; token_last4: string }> {
	const hash = await sha256Hex(token);
	return { token: hashedPlaceholder(hash), token_hash: hash, token_last4: token.slice(-4) };
}

/**
 * True only for SQLite's missing-column error on a column migration 0138 adds (`token_hash`,
 * `token_last4`, `trust_body`). Any other failure, including another missing column, stays a
 * failure. Same shape as `isMissingOptionalColumn` in users.ts.
 */
export function isPreMigrationKeyError(err: unknown): boolean {
	const pattern = /no such column:\s*(?:[\w"]+\.)?(?:token_hash|token_last4|trust_body)\b/i;
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current != null && !seen.has(current)) {
		if (typeof current === 'string') return pattern.test(current);
		if (typeof current !== 'object') return false;
		seen.add(current);
		const message = current instanceof Error ? current.message : '';
		if (pattern.test(message)) return true;
		if (!(current instanceof Error)) return false;
		current = current.cause;
	}
	return false;
}

/**
 * The lookup before migration 0138 (the code can run before the migration is applied): the
 * plaintext `token`, not revoked, treated as trusted like every key that existed then. Reads
 * only; no hash is written.
 */
async function findPreMigrationKey(db: D1Database, provided: string): Promise<WebhookKey | null> {
	const r = await db
		.prepare('SELECT id, default_list, source, default_tags, require_confirm, token FROM webhook_keys WHERE token = ? AND revoked_at IS NULL')
		.bind(provided)
		.first<Omit<WebhookKey, 'trust_body'> & { token: string }>();
	if (!r || !isPlaintextToken(r.token) || !safeEqual(r.token, provided)) return null;
	return pick({ ...r, trust_body: 1 });
}

/** The active key for `provided`, or null. Moves an old plaintext key over to its hash. */
export async function findWebhookKey(db: D1Database, provided: string): Promise<WebhookKey | null> {
	if (!provided || provided.length > 200) return null;
	try {
		return await findHashedKey(db, provided);
	} catch (e) {
		if (isPreMigrationKeyError(e)) return findPreMigrationKey(db, provided);
		throw e;
	}
}

async function findHashedKey(db: D1Database, provided: string): Promise<WebhookKey | null> {
	const hash = await sha256Hex(provided);
	const byHashLookup = async () => {
		const r = await db
			.prepare(`SELECT ${COLS}, token_hash FROM webhook_keys WHERE token_hash = ? AND revoked_at IS NULL`)
			.bind(hash)
			.first<WebhookKey & { token_hash: string }>();
		return r && safeEqual(r.token_hash, hash) ? pick(r) : null;
	};
	const byHash = await byHashLookup();
	if (byHash) return byHash;

	const old = await db
		.prepare(`SELECT ${COLS}, token FROM webhook_keys WHERE token = ? AND token_hash IS NULL AND revoked_at IS NULL`)
		.bind(provided)
		.first<WebhookKey & { token: string }>();
	// Another request may have moved this key over between the two reads.
	if (!old) return byHashLookup();
	if (!isPlaintextToken(old.token) || !safeEqual(old.token, provided)) return null;
	await db
		.prepare('UPDATE webhook_keys SET token_hash = ?, token_last4 = ?, token = ? WHERE id = ? AND token_hash IS NULL')
		.bind(hash, provided.slice(-4), hashedPlaceholder(hash), old.id)
		.run();
	return pick(old);
}

/**
 * #750: how many keys are still stored in plaintext (made before migration 0138 and never used
 * since). 0 before the migration is applied.
 */
export async function plaintextKeyCount(db: D1Database): Promise<number> {
	try {
		const rows = await db
			.prepare('SELECT token FROM webhook_keys WHERE token_hash IS NULL')
			.all<{ token: string | null }>();
		return rows.results.filter((r) => isPlaintextToken(r.token)).length;
	} catch (e) {
		if (isPreMigrationKeyError(e)) return 0;
		throw e;
	}
}

/**
 * #750: hash every key still stored in plaintext, the same move `findHashedKey` makes on a key's
 * first use: `token_hash` + `token_last4` written, the plaintext replaced by the placeholder. The
 * keys keep working (callers send the same key). Revoked keys never hold plaintext (0138, revoke).
 * Returns how many were hashed; `pending` = none were written because 0138 isn't applied.
 */
export async function hashPlaintextKeys(db: D1Database): Promise<{ hashed: number; pending?: true }> {
	let rows: { id: number; token: string | null }[];
	try {
		rows = (await db.prepare('SELECT id, token FROM webhook_keys WHERE token_hash IS NULL').all<{ id: number; token: string | null }>()).results;
	} catch (e) {
		if (isPreMigrationKeyError(e)) return { hashed: 0, pending: true };
		throw e;
	}
	let hashed = 0;
	for (const r of rows) {
		if (!r.token || !isPlaintextToken(r.token)) continue;
		const hash = await sha256Hex(r.token);
		const res = await db
			.prepare('UPDATE webhook_keys SET token_hash = ?, token_last4 = ?, token = ? WHERE id = ? AND token_hash IS NULL AND token = ?')
			.bind(hash, r.token.slice(-4), hashedPlaceholder(hash), r.id, r.token)
			.run();
		if ((res.meta?.changes ?? 0) > 0) hashed++;
	}
	return { hashed };
}

function pick(r: WebhookKey): WebhookKey {
	return {
		id: r.id,
		default_list: r.default_list,
		source: r.source,
		default_tags: r.default_tags,
		require_confirm: r.require_confirm,
		trust_body: r.trust_body
	};
}

// #744: moved to rate-limit.ts (shared by ingest, hosted forms and newsletter signup).
export { clientBucket } from './rate-limit';

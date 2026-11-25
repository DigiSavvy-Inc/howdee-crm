// Luma webhook signing secret (#70, #750).
//
// Stored in app_state `luma_webhook_secret`. Since #750 a value saved from Settings is sealed with
// MAIL_TOKEN_KEY (crypto-box `v1.` blob), like the other in-app secrets. Without a valid
// MAIL_TOKEN_KEY it is stored as before (plain), so an install without that key keeps working.
// A plain value saved before #750 keeps working as it is; it is sealed when the secret is next
// saved from Settings with a new value.
// A sealed value that can't be opened (key missing, wrong or rotated) counts as not set: the
// webhook refuses deliveries rather than fall back to the env secret.
// The value never reaches page data: Settings gets `lumaSecretSet` only.

import { isValidKey, open, seal } from './crypto-box';

export const LUMA_SECRET_KEY = 'luma_webhook_secret';
const SEALED_PREFIX = 'v1.';

type LumaEnv = { MAIL_TOKEN_KEY?: string; LUMA_WEBHOOK_SECRET?: string } | null | undefined;

/** True when the stored value is a sealed blob (not a plain `whsec_…`). */
export function isSealedLumaSecret(value: string | null | undefined): boolean {
	return !!value && value.startsWith(SEALED_PREFIX);
}

async function storedValue(db: D1Database): Promise<string> {
	const row = await db
		.prepare('SELECT value FROM app_state WHERE key = ?')
		.bind(LUMA_SECRET_KEY)
		.first<{ value: string | null }>();
	return row?.value?.trim() ?? '';
}

export type LumaSecretInfo = {
	/** Where the secret in effect comes from. */
	from: 'app' | 'env' | 'unreadable' | 'none';
	sealed: boolean;
};

/** The signing secret in effect: the app's (opened when sealed), else env LUMA_WEBHOOK_SECRET. */
export async function lumaSecretFor(db: D1Database, env: LumaEnv): Promise<string> {
	const stored = await storedValue(db);
	if (stored) {
		if (!isSealedLumaSecret(stored)) return stored;
		const key = env?.MAIL_TOKEN_KEY;
		if (!isValidKey(key)) return '';
		try {
			return (await open(key, stored)).trim();
		} catch {
			return '';
		}
	}
	return (env?.LUMA_WEBHOOK_SECRET ?? '').trim();
}

/** For Settings: where the secret comes from, never the value. */
export async function lumaSecretInfo(db: D1Database, env: LumaEnv): Promise<LumaSecretInfo> {
	const stored = await storedValue(db);
	if (stored) {
		const sealed = isSealedLumaSecret(stored);
		if (sealed && !(await lumaSecretFor(db, env))) return { from: 'unreadable', sealed };
		return { from: 'app', sealed };
	}
	return { from: (env?.LUMA_WEBHOOK_SECRET ?? '').trim() ? 'env' : 'none', sealed: false };
}

async function write(db: D1Database, value: string | null): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(LUMA_SECRET_KEY, value)
		.run();
}

/** Save (sealed when MAIL_TOKEN_KEY is valid) or clear ('' clears) the signing secret. */
export async function storeLumaSecret(db: D1Database, env: LumaEnv, raw: string): Promise<void> {
	const value = raw.trim();
	if (!value) return write(db, null);
	const key = env?.MAIL_TOKEN_KEY;
	await write(db, isValidKey(key) ? await seal(key, value) : value);
}

/**
 * Seal a plain value saved before #750, when MAIL_TOKEN_KEY is valid. Never throws. Not called on
 * a Settings save (a blank Luma field leaves the stored value alone); kept for a deliberate migration.
 */
export async function sealStoredLumaSecret(db: D1Database, env: LumaEnv): Promise<boolean> {
	try {
		const key = env?.MAIL_TOKEN_KEY;
		if (!isValidKey(key)) return false;
		const stored = await storedValue(db);
		if (!stored || isSealedLumaSecret(stored)) return false;
		await write(db, await seal(key, stored));
		return true;
	} catch (e) {
		console.error('luma secret seal failed:', e instanceof Error ? e.message.slice(0, 120) : 'error');
		return false;
	}
}

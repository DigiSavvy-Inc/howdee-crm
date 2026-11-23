// The Anthropic API key (#297): pasted in Settings → Assistant and stored like the
// integration tokens (#175) — an `integration_secrets` row with provider 'anthropic',
// sealed with MAIL_TOKEN_KEY, set/remove audited in `integration_syncs` (trigger 'token').
// Resolution: the in-app key, else the ANTHROPIC_API_KEY Worker secret (`anthropicKey`),
// else ''. The plaintext is never logged, returned to a page, or put in an error message;
// the UI sees only `last4`.

import { isValidKey } from '../crypto-box';
import { deleteSecret, openSecret, secretRow, storeSecret } from '../integrations/secrets';

export const ANTHROPIC_PROVIDER = 'anthropic';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const KEY_PREFIX = 'sk-ant-';
export const KEY_MIN = 20;
export const KEY_MAX = 300;
/** Shown (and returned by setKey) when in-app keys can't be stored. */
export const KEY_STORE_MISSING =
	'In-app keys need the MAIL_TOKEN_KEY Worker secret. Ask your operator to set it, or use the ANTHROPIC_API_KEY secret.';
/** How long one isolate trusts its last read of the stored key. */
export const KEY_CACHE_MS = 30_000;

// Same value as ./anthropic.ts (not imported, to keep this module free of import cycles).
const ANTHROPIC_VERSION = '2023-06-01';

/** The ANTHROPIC_API_KEY Worker secret alone, or '' when unset. Untyped on purpose: the
 *  name is an optional secret, so a generated Env without it must still compile. Callers
 *  want `resolveAnthropicKey` (in-app key first). */
export function anthropicKey(platformEnv: unknown): string {
	const v = (platformEnv as { ANTHROPIC_API_KEY?: unknown } | undefined)?.ANTHROPIC_API_KEY;
	return typeof v === 'string' ? v.trim() : '';
}

/** Untyped on purpose (like `anthropicKey`): both names are optional secrets. */
function mailTokenKey(platformEnv: unknown): string | undefined {
	const v = (platformEnv as { MAIL_TOKEN_KEY?: unknown } | undefined)?.MAIL_TOKEN_KEY;
	return typeof v === 'string' ? v : undefined;
}

/** In-app keys are usable only when MAIL_TOKEN_KEY is set to a valid 32-byte key. */
export function keyStoreReady(platformEnv: unknown): boolean {
	return isValidKey(mailTokenKey(platformEnv));
}

// Per-isolate memo of the stored key only (the Worker secret is read fresh every time).
const cache = new WeakMap<D1Database, { at: number; mailKey: string | undefined; value: string | null }>();

export function clearAnthropicKeyCache(db?: D1Database): void {
	if (db) cache.delete(db);
}

async function storedKey(db: D1Database, platformEnv: unknown): Promise<string | null> {
	const mailKey = mailTokenKey(platformEnv);
	const hit = cache.get(db);
	if (hit && hit.mailKey === mailKey && Date.now() - hit.at < KEY_CACHE_MS) return hit.value;
	let value: string | null = null;
	try {
		value = (await openSecret(db, mailKey, ANTHROPIC_PROVIDER))?.trim() || null;
	} catch {
		value = null; // a failed read falls back to the secret
	}
	cache.set(db, { at: Date.now(), mailKey, value });
	return value;
}

/** The in-app key, else the ANTHROPIC_API_KEY secret, else ''. */
export async function resolveAnthropicKey(db: D1Database | undefined | null, platformEnv: unknown): Promise<string> {
	if (db) {
		const stored = await storedKey(db, platformEnv);
		if (stored) return stored;
	}
	return anthropicKey(platformEnv);
}

/** What the Status card shows. Never the key or its blob. */
export type AnthropicKeyInfo = {
	source: 'app' | 'worker' | null;
	last4: string | null; // in-app key only
	setBy: string | null;
	setAt: string | null;
	/** An in-app row exists but can't be opened (MAIL_TOKEN_KEY missing or changed). */
	storedUnusable: boolean;
	/** The Worker secret is set — what Remove falls back to. */
	workerSecret: boolean;
	/** MAIL_TOKEN_KEY is valid, so the form can save. */
	storeReady: boolean;
};

export async function anthropicKeyInfo(db: D1Database, platformEnv: unknown): Promise<AnthropicKeyInfo> {
	const row = await secretRow(db, ANTHROPIC_PROVIDER);
	const workerSecret = !!anthropicKey(platformEnv);
	const usable = row ? !!(await storedKey(db, platformEnv)) : false;
	const base = { workerSecret, storeReady: keyStoreReady(platformEnv), setBy: row?.set_by_login ?? null, setAt: row?.set_at ?? null };
	if (row && usable) return { ...base, source: 'app', last4: row.last4, storedUnusable: false };
	return { ...base, source: workerSecret ? 'worker' : null, last4: null, storedUnusable: !!row };
}

/** Validate a pasted key; returns the cleaned value or an error (which never echoes it). */
export function cleanAnthropicKey(raw: string): { ok: true; key: string } | { ok: false; error: string } {
	const key = raw.trim();
	if (!key) return { ok: false, error: 'Paste a key first.' };
	if (/\s/.test(key)) return { ok: false, error: "A key can't contain spaces or line breaks." };
	if (!key.startsWith(KEY_PREFIX)) return { ok: false, error: `Anthropic API keys start with "${KEY_PREFIX}".` };
	if (key.length < KEY_MIN) return { ok: false, error: 'That key is too short.' };
	if (key.length > KEY_MAX) return { ok: false, error: 'That key is too long.' };
	return { ok: true, key };
}

export async function setAnthropicKey(db: D1Database, platformEnv: unknown, key: string, userId: number | null): Promise<{ last4: string }> {
	const out = await storeSecret(db, mailTokenKey(platformEnv), ANTHROPIC_PROVIDER, key, userId);
	clearAnthropicKeyCache(db);
	return out;
}

/** Remove the in-app key (the Worker secret, if any, takes over). False when none was set. */
export async function removeAnthropicKey(db: D1Database): Promise<boolean> {
	const removed = await deleteSecret(db, ANTHROPIC_PROVIDER);
	clearAnthropicKeyCache(db);
	return removed;
}

/** Replace every occurrence of the key in a message. */
export function scrubKey(message: string, key: string): string {
	return key ? message.split(key).join('[key]') : message;
}

export type KeyTest = { ok: true } | { ok: false; error: string };

/**
 * `GET /v1/models` with the key: OK, or an error message with the key scrubbed out.
 * Callers pass the global fetch (the default), never SvelteKit's event.fetch: that adds
 * Origin, which makes Anthropic demand the direct-browser-access header (see the testKey action).
 */
export async function testAnthropicKey(key: string, fetchFn: typeof fetch = fetch): Promise<KeyTest> {
	if (!key) return { ok: false, error: 'No key is set.' };
	let res: Response;
	try {
		res = await fetchFn(ANTHROPIC_MODELS_URL, {
			headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
			signal: AbortSignal.timeout(10_000)
		});
	} catch (e) {
		return { ok: false, error: scrubKey(`Couldn't reach Anthropic: ${e instanceof Error ? e.message : 'network error'}`, key) };
	}
	if (res.ok) return { ok: true };
	let detail = '';
	try {
		const body = (await res.json()) as { error?: { message?: unknown } };
		if (typeof body?.error?.message === 'string') detail = body.error.message;
	} catch {
		/* no JSON body */
	}
	const label = res.status === 401 ? 'Anthropic rejected the key' : `Anthropic returned ${res.status}`;
	// Scrub before truncating, so a cut can't leave part of the key behind.
	return { ok: false, error: scrubKey(detail ? `${label}: ${detail}` : label, key).slice(0, 300) };
}

// ---- OpenAI-compatible provider key (#696) ----
// Same storage and rules as the Anthropic key: an integration_secrets row (provider
// OPENAI_SECRET_PROVIDER) sealed with MAIL_TOKEN_KEY, set/remove audited in integration_syncs,
// else the OPENAI_API_KEY Worker secret, else ''. Never logged or shown (last4 only).

export const OPENAI_SECRET_PROVIDER = 'openai_compat';
export const OPENAI_KEY_MIN = 8;
export const OPENAI_KEY_MAX = 500;

/** The OPENAI_API_KEY Worker secret alone, or ''. Untyped on purpose (optional secret). */
export function openAiWorkerKey(platformEnv: unknown): string {
	const v = (platformEnv as { OPENAI_API_KEY?: unknown } | undefined)?.OPENAI_API_KEY;
	return typeof v === 'string' ? v.trim() : '';
}

const openAiCache = new WeakMap<D1Database, { at: number; mailKey: string | undefined; value: string | null }>();

export function clearOpenAiKeyCache(db?: D1Database): void {
	if (db) openAiCache.delete(db);
}

async function storedOpenAiKey(db: D1Database, platformEnv: unknown): Promise<string | null> {
	const mailKey = mailTokenKey(platformEnv);
	const hit = openAiCache.get(db);
	if (hit && hit.mailKey === mailKey && Date.now() - hit.at < KEY_CACHE_MS) return hit.value;
	let value: string | null = null;
	try {
		value = (await openSecret(db, mailKey, OPENAI_SECRET_PROVIDER))?.trim() || null;
	} catch {
		value = null;
	}
	openAiCache.set(db, { at: Date.now(), mailKey, value });
	return value;
}

/** The in-app OpenAI-compatible key, else the OPENAI_API_KEY secret, else ''. */
export async function resolveOpenAiKey(db: D1Database | undefined | null, platformEnv: unknown): Promise<string> {
	if (db) {
		const stored = await storedOpenAiKey(db, platformEnv);
		if (stored) return stored;
	}
	return openAiWorkerKey(platformEnv);
}

/** The key for a provider (#696): 'openai' → the OpenAI-compatible key, anything else → Anthropic's. */
export async function resolveProviderKey(db: D1Database | undefined | null, platformEnv: unknown, provider: string): Promise<string> {
	if (provider === 'openai') return resolveOpenAiKey(db, platformEnv);
	return resolveAnthropicKey(db, platformEnv);
}

export async function openAiKeyInfo(db: D1Database, platformEnv: unknown): Promise<AnthropicKeyInfo> {
	const row = await secretRow(db, OPENAI_SECRET_PROVIDER);
	const workerSecret = !!openAiWorkerKey(platformEnv);
	const usable = row ? !!(await storedOpenAiKey(db, platformEnv)) : false;
	const base = { workerSecret, storeReady: keyStoreReady(platformEnv), setBy: row?.set_by_login ?? null, setAt: row?.set_at ?? null };
	if (row && usable) return { ...base, source: 'app', last4: row.last4, storedUnusable: false };
	return { ...base, source: workerSecret ? 'worker' : null, last4: null, storedUnusable: !!row };
}

/** Validate a pasted OpenAI-compatible key (no prefix rule: OpenRouter and local servers differ). */
export function cleanOpenAiKey(raw: string): { ok: true; key: string } | { ok: false; error: string } {
	const key = raw.trim();
	if (!key) return { ok: false, error: 'Paste a key first.' };
	if (/\s/.test(key)) return { ok: false, error: "A key can't contain spaces or line breaks." };
	if (key.length < OPENAI_KEY_MIN) return { ok: false, error: 'That key is too short.' };
	if (key.length > OPENAI_KEY_MAX) return { ok: false, error: 'That key is too long.' };
	return { ok: true, key };
}

export async function setOpenAiKey(db: D1Database, platformEnv: unknown, key: string, userId: number | null): Promise<{ last4: string }> {
	const out = await storeSecret(db, mailTokenKey(platformEnv), OPENAI_SECRET_PROVIDER, key, userId);
	clearOpenAiKeyCache(db);
	return out;
}

/** Remove the in-app key (the Worker secret, if any, takes over). False when none was set. */
export async function removeOpenAiKey(db: D1Database): Promise<boolean> {
	const removed = await deleteSecret(db, OPENAI_SECRET_PROVIDER);
	clearOpenAiKeyCache(db);
	return removed;
}

/** `GET <base>/models` with the key: OK, or an error message with the key scrubbed out. */
export async function testOpenAiKey(key: string, baseUrl: string, fetchFn: typeof fetch = fetch): Promise<KeyTest> {
	if (!key) return { ok: false, error: 'No key is set.' };
	let res: Response;
	try {
		res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/models`, {
			headers: { authorization: `Bearer ${key}` },
			redirect: 'manual',
			signal: AbortSignal.timeout(10_000)
		});
	} catch (e) {
		return { ok: false, error: scrubKey(`Couldn't reach the endpoint: ${e instanceof Error ? e.message : 'network error'}`, key) };
	}
	if (res.ok) return { ok: true };
	let detail = '';
	try {
		const body = (await res.json()) as { error?: { message?: unknown } | string };
		const m = typeof body?.error === 'string' ? body.error : body?.error?.message;
		if (typeof m === 'string') detail = m;
	} catch {
		/* no JSON body */
	}
	const label = res.status === 401 ? 'The endpoint rejected the key' : `The endpoint returned ${res.status}`;
	return { ok: false, error: scrubKey(detail ? `${label}: ${detail}` : label, key).slice(0, 300) };
}

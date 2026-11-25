// The Anthropic API key (#297): pasted in Settings → Assistant and stored like the
// integration tokens (#175) — an `integration_secrets` row with provider 'anthropic',
// sealed with MAIL_TOKEN_KEY, set/remove audited in `integration_syncs` (trigger 'token').
// Resolution: the in-app key, else the ANTHROPIC_API_KEY Worker secret (`anthropicKey`),
// else ''. The plaintext is never logged, returned to a page, or put in an error message;
// the UI sees only `last4`.

import { OPENAI_DEFAULT_HOST, baseUrlHost, cleanHostSetting } from '$lib/ai-providers';
import { isValidKey, open, seal } from '../crypto-box';
import {
	auditSecretRemovalStatement,
	auditSecretStatement,
	deleteSecret,
	openSecret,
	secretRow,
	storeSealedSecretStatement,
	storeSecret
} from '../integrations/secrets';

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
//
// #748: a key follows the host. The in-app key is used only for the host it was saved for
// (app_state OPENAI_KEY_HOST_STATE, written by setOpenAiKey). A key saved before #748 has no host
// yet: `adoptOpenAiKeyHost` binds it to the host of the base URL stored at that moment, and every
// config save runs it before writing (so a save can never move an unbound key to a new host). A
// read binds it too, as a fallback, but only to a usable https (or loopback http) URL. The Worker
// secret is used only for the host the operator pinned (OPENAI_BASE_URL_HOST), else only for
// api.openai.com. A saved base URL that is no longer usable means no key at all.
// The binding is the host (with a non-default port), not the scheme: only loopback hosts may use
// http, so a key for https://localhost:8443 may also go to http://localhost:8443.
//
// The host row (app_state OPENAI_KEY_HOST_STATE) has exactly three states:
//   - missing: a key saved before #748 (nothing since has written the row). Only then is a key bound
//     to the saved base URL (`adoptOpenAiKeyHost`, or the read fallback in `storedOpenAi`).
//   - '' (empty): a key exists or is being written, or was removed, and is bound to no host: it is
//     sent nowhere. setOpenAiKey writes '' before it stores a new key, and removeOpenAiKey leaves ''
//     in the same batch that deletes the key, so a missing row can never appear after #748.
//   - a host: the key is sent to that host only.

export const OPENAI_SECRET_PROVIDER = 'openai_compat';
export const OPENAI_KEY_MIN = 8;
export const OPENAI_KEY_MAX = 500;
/** app_state key: the host the in-app key was saved for ('' = none: the key is never sent; a
 *  missing row = a key from before #748, see the three states above). */
export const OPENAI_KEY_HOST_STATE = 'openai_key_host';
/** Refusal when the key form was filled in for a base URL that is no longer the saved one. */
export const OPENAI_HOST_CHANGED = 'The base URL changed. Reload and try again.';
/** Refusal when the key form came without the host the page showed (an old or hand-made form). */
export const OPENAI_KEY_FORM_STALE = 'Reload the page and try again.';
// Same value as AI_CONFIG_KEY in ./config.ts (not imported: config.ts imports this module).
const ASSISTANT_CONFIG_STATE = 'ai_assistant_config';

/** The OPENAI_API_KEY Worker secret alone, or ''. Untyped on purpose (optional secret). */
export function openAiWorkerKey(platformEnv: unknown): string {
	const v = (platformEnv as { OPENAI_API_KEY?: unknown } | undefined)?.OPENAI_API_KEY;
	return typeof v === 'string' ? v.trim() : '';
}

/** The only host the OPENAI_API_KEY Worker secret is sent to: OPENAI_BASE_URL_HOST, else api.openai.com. */
export function pinnedOpenAiHost(platformEnv: unknown): string {
	const v = (platformEnv as { OPENAI_BASE_URL_HOST?: unknown } | undefined)?.OPENAI_BASE_URL_HOST;
	return cleanHostSetting(v) || OPENAI_DEFAULT_HOST;
}

/** The base URL inside a stored assistant config value, as stored ('' when none or unreadable). */
function rawBaseUrlOf(value: string | null | undefined): string {
	try {
		const cfg = value ? (JSON.parse(value) as { openai?: { baseUrl?: unknown } } | null) : null;
		const raw: unknown = cfg?.openai?.baseUrl;
		return typeof raw === 'string' ? raw.trim() : '';
	} catch {
		return '';
	}
}

/** The saved OpenAI-compatible base URL exactly as stored, '' when none. Unlike the config read
 *  (which turns an unusable URL into blank), an unusable value is returned as it is. */
export async function savedOpenAiBaseUrl(db: D1Database): Promise<string> {
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(ASSISTANT_CONFIG_STATE).first<{ value: string | null }>();
		return rawBaseUrlOf(row?.value);
	} catch {
		return '';
	}
}

/** The saved base URL is set but no longer accepted (e.g. plain http on a non-loopback host). */
export function baseUrlUnusable(raw: string): boolean {
	return !!raw.trim() && baseUrlHost(raw) === null;
}

/** The sealed key, its recorded host (null = no row) and the stored base URL, read in one batch so
 *  the three values belong together. */
type KeySnapshot = { blob: string | null; host: string | null; rawUrl: string };

async function readSnapshot(db: D1Database): Promise<KeySnapshot> {
	const [secret, host, cfg] = await db.batch([
		db.prepare('SELECT blob FROM integration_secrets WHERE provider = ?').bind(OPENAI_SECRET_PROVIDER),
		db.prepare('SELECT value FROM app_state WHERE key = ?').bind(OPENAI_KEY_HOST_STATE),
		db.prepare('SELECT value FROM app_state WHERE key = ?').bind(ASSISTANT_CONFIG_STATE)
	]);
	const blob = (secret.results[0] as { blob?: unknown } | undefined)?.blob;
	const hostRow = host.results[0] as { value: string | null } | undefined;
	const cfgRow = cfg.results[0] as { value: string | null } | undefined;
	return { blob: typeof blob === 'string' ? blob : null, host: hostRow ? (hostRow.value ?? '') : null, rawUrl: rawBaseUrlOf(cfgRow?.value) };
}

async function readKeyHost(db: D1Database): Promise<string | null> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(OPENAI_KEY_HOST_STATE).first<{ value: string | null }>();
	return row ? (row.value ?? '') : null;
}

/** Upsert of the host row, as a statement (for a db.batch). Never deletes the row: see the three states. */
function keyHostStatement(db: D1Database, host: string): D1PreparedStatement {
	return db
		.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(OPENAI_KEY_HOST_STATE, host);
}

async function writeKeyHost(db: D1Database, host: string): Promise<void> {
	await keyHostStatement(db, host).run();
}

/** Records a host only when none is recorded yet (a binding is never overwritten here). */
async function writeKeyHostIfMissing(db: D1Database, host: string): Promise<void> {
	await db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`).bind(OPENAI_KEY_HOST_STATE, host).run();
}

type StoredOpenAi = { value: string | null; host: string };
// `forHost` = the host the lookup was made for; the entry answers only a question about that host.
// A negative answer (no key, or a key for another host) is cached too, so a default install does not
// read the database on every call.
const openAiCache = new WeakMap<D1Database, { at: number; mailKey: string | undefined; forHost: string; entry: StoredOpenAi }>();

export function clearOpenAiKeyCache(db?: D1Database): void {
	if (db) openAiCache.delete(db);
}

/**
 * Binds a stored key that has no host yet to the host of the base URL stored now. A stored URL
 * that is not usable binds it to '' (never sent; it must be entered again). Does nothing when
 * there is no key or it already has a host. Run before anything changes the saved base URL.
 */
export async function adoptOpenAiKeyHost(db: D1Database): Promise<void> {
	const snap = await readSnapshot(db);
	if (!snap.blob || snap.host !== null) return;
	await writeKeyHostIfMissing(db, baseUrlHost(snap.rawUrl) ?? '');
	clearOpenAiKeyCache(db);
}

/** The in-app key and the host it was saved for ('' = none). A cached read is used only when the
 *  lookup it answered was made for `forHost`, so a stale entry can never answer for another host. */
async function storedOpenAi(db: D1Database, platformEnv: unknown, forHost: string): Promise<StoredOpenAi> {
	const mailKey = mailTokenKey(platformEnv);
	const hit = openAiCache.get(db);
	const sameForHost = !!hit && hit.forHost === forHost;
	if (hit && sameForHost && hit.mailKey === mailKey && Date.now() - hit.at < KEY_CACHE_MS) return hit.entry;
	let value: string | null = null;
	let host = '';
	try {
		const snap = await readSnapshot(db);
		if (snap.blob && isValidKey(mailKey)) {
			try {
				value = (await open(mailKey, snap.blob)).trim() || null;
			} catch {
				console.error('integration token for openai_compat could not be decrypted (wrong MAIL_TOKEN_KEY?)');
				value = null;
			}
		}
		// The three states of the host row: a host = that host only; '' = no host, send it nowhere;
		// missing (null) = a key saved before #748, the only case that is bound here.
		if (snap.host !== null) host = snap.host;
		else if (snap.blob) {
			// Fallback for a key saved before #748 that nothing has bound yet: bind it to the stored
			// URL's host, but only when that URL is usable. Otherwise it stays unbound and unsent.
			const adopted = baseUrlHost(snap.rawUrl);
			if (adopted) {
				await writeKeyHostIfMissing(db, adopted);
				host = (await readKeyHost(db)) ?? '';
			}
		}
	} catch {
		value = null; // can't tell which host the key is for: don't send it
		host = '';
	}
	const entry = { value, host };
	openAiCache.set(db, { at: Date.now(), mailKey, forHost, entry });
	return entry;
}

/**
 * The OpenAI-compatible key for requests to `baseUrl` (default: the saved base URL): the in-app
 * key when it was saved for that host, else the OPENAI_API_KEY secret when that host is the
 * pinned one, else ''. A saved base URL that is not usable means '' for every host.
 */
export async function resolveOpenAiKey(db: D1Database | undefined | null, platformEnv: unknown, baseUrl?: string): Promise<string> {
	const saved = db ? await savedOpenAiBaseUrl(db) : '';
	if (baseUrlUnusable(saved)) return '';
	const host = baseUrlHost(baseUrl ?? saved);
	if (!host) return '';
	if (db) {
		const stored = await storedOpenAi(db, platformEnv, host);
		if (stored.value && stored.host === host) return stored.value;
	}
	return host === pinnedOpenAiHost(platformEnv) ? openAiWorkerKey(platformEnv) : '';
}

/** The key for a provider (#696): 'openai' → the OpenAI-compatible key, anything else → Anthropic's.
 *  `baseUrl` (OpenAI-compatible only) = where the request goes; default the saved base URL. */
export async function resolveProviderKey(db: D1Database | undefined | null, platformEnv: unknown, provider: string, baseUrl?: string): Promise<string> {
	if (provider === 'openai') return resolveOpenAiKey(db, platformEnv, baseUrl);
	return resolveAnthropicKey(db, platformEnv);
}

export type OpenAiKeyInfo = AnthropicKeyInfo & {
	/** The host requests go to now (null = the saved base URL isn't usable). */
	host: string | null;
	/** The saved base URL is set but no longer accepted (#748): no key is sent anywhere. */
	baseUrlUnusable: boolean;
	/** The in-app key was saved for another address, so it isn't sent (#748). */
	hostMismatch: boolean;
	/** The Worker secret is set but only goes to `pinnedHost`, not to this address (#748). */
	workerSecretBlocked: boolean;
	pinnedHost: string;
};

export async function openAiKeyInfo(db: D1Database, platformEnv: unknown, baseUrl?: string): Promise<OpenAiKeyInfo> {
	const row = await secretRow(db, OPENAI_SECRET_PROVIDER);
	const saved = await savedOpenAiBaseUrl(db);
	const unusable = baseUrlUnusable(saved);
	const host = unusable ? null : baseUrlHost(baseUrl ?? saved);
	const pinnedHost = pinnedOpenAiHost(platformEnv);
	const workerSet = !!openAiWorkerKey(platformEnv);
	const workerUsable = workerSet && !!host && host === pinnedHost;
	const stored = row ? await storedOpenAi(db, platformEnv, host ?? '') : { value: null, host: '' };
	const usable = !!stored.value;
	const hostMatch = usable && !!host && stored.host === host;
	const base = {
		workerSecret: workerUsable,
		storeReady: keyStoreReady(platformEnv),
		setBy: row?.set_by_login ?? null,
		setAt: row?.set_at ?? null,
		host,
		baseUrlUnusable: !host,
		hostMismatch: usable && !!host && !hostMatch,
		workerSecretBlocked: workerSet && !!host && !workerUsable,
		pinnedHost
	};
	if (row && hostMatch) return { ...base, source: 'app', last4: row.last4, storedUnusable: false };
	return { ...base, source: workerUsable ? 'worker' : null, last4: null, storedUnusable: !!row && !usable };
}

/** Why there is no key for the saved address (#748). The same words for Test key and every feature. */
export function openAiNoKeyMessage(info: Pick<OpenAiKeyInfo, 'host' | 'hostMismatch' | 'workerSecretBlocked' | 'pinnedHost'>): string {
	if (!info.host) {
		return "The saved base URL isn't usable: it must start with https:// (http:// only for localhost, 127.0.0.1 or [::1]). Fix it in Settings → Assistant, then enter the key again.";
	}
	if (info.hostMismatch) return `The saved key is for a different address. Paste the key again for ${info.host} in Settings → Assistant.`;
	if (info.workerSecretBlocked) {
		return `No key is set for ${info.host}. The OPENAI_API_KEY secret is only sent to ${info.pinnedHost}: paste a key in Settings → Assistant, or ask your operator to set OPENAI_BASE_URL_HOST.`;
	}
	if (info.host === info.pinnedHost) return `No key is set for ${info.host}. Paste one in Settings → Assistant, or set the OPENAI_API_KEY secret.`;
	return `No key is set for ${info.host}. Paste one in Settings → Assistant.`;
}

/** '' when the OpenAI-compatible provider has a key for the saved base URL, else `openAiNoKeyMessage`. */
export async function openAiKeyProblem(db: D1Database | undefined | null, platformEnv: unknown): Promise<string> {
	if (await resolveOpenAiKey(db, platformEnv)) return '';
	if (db) return openAiNoKeyMessage(await openAiKeyInfo(db, platformEnv));
	const pinnedHost = pinnedOpenAiHost(platformEnv);
	return openAiNoKeyMessage({
		host: OPENAI_DEFAULT_HOST,
		hostMismatch: false,
		workerSecretBlocked: !!openAiWorkerKey(platformEnv) && pinnedHost !== OPENAI_DEFAULT_HOST,
		pinnedHost
	});
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

/** Thrown by setOpenAiKey when the saved base URL no longer has the host the form was filled in for. */
export class OpenAiHostChangedError extends Error {
	constructor() {
		super(OPENAI_HOST_CHANGED);
		this.name = 'OpenAiHostChangedError';
	}
}

/**
 * Store the key for the saved base URL's host (#748: it is only ever sent there). With
 * `expectHost` (the host the page showed), a different saved host throws OpenAiHostChangedError
 * and nothing is stored. The host row is set to '' (no host) before the new key is written, so a
 * reader never pairs the new key with the old host; then the sealed key and the real host are
 * written in one batch.
 */
export async function setOpenAiKey(
	db: D1Database,
	platformEnv: unknown,
	key: string,
	userId: number | null,
	opts: { expectHost?: string } = {}
): Promise<{ last4: string; host: string }> {
	const host = baseUrlHost(await savedOpenAiBaseUrl(db)) ?? '';
	if (opts.expectHost !== undefined && opts.expectHost !== host) throw new OpenAiHostChangedError();
	const mailKey = mailTokenKey(platformEnv);
	if (!isValidKey(mailKey)) throw new Error('MAIL_TOKEN_KEY is not set');
	await writeKeyHost(db, '');
	clearOpenAiKeyCache(db);
	const blob = await seal(mailKey, key);
	const last4 = key.slice(-4);
	await db.batch([
		storeSealedSecretStatement(db, OPENAI_SECRET_PROVIDER, blob, last4, userId),
		keyHostStatement(db, host),
		auditSecretStatement(db, OPENAI_SECRET_PROVIDER, 'set', last4)
	]);
	clearOpenAiKeyCache(db);
	return { last4, host };
}

/**
 * Remove the in-app key (the Worker secret, if any, takes over). False when none was set. One batch
 * deletes the key and leaves the host row at '' (it never deletes the row): a missing row would read
 * as a key from before #748, so a key another request is storing right now would be bound to
 * whatever base URL is saved at that moment.
 */
export async function removeOpenAiKey(db: D1Database): Promise<boolean> {
	const [, deleted] = await db.batch([
		auditSecretRemovalStatement(db, OPENAI_SECRET_PROVIDER),
		db.prepare('DELETE FROM integration_secrets WHERE provider = ? RETURNING last4').bind(OPENAI_SECRET_PROVIDER),
		keyHostStatement(db, '')
	]);
	clearOpenAiKeyCache(db);
	return (deleted.results?.length ?? 0) > 0;
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

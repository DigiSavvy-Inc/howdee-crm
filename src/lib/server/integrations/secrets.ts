// In-app provider tokens (#175). An admin pastes a token in Settings → Integrations; it's
// sealed with MAIL_TOKEN_KEY (AES-256-GCM, ../crypto-box.ts) and stored in
// `integration_secrets`. Resolution per provider: the in-app token, else the Worker secret
// (TIMING_API_TOKEN / GITHUB_TOKEN), else nothing.
//
// The plaintext never leaves the server: nothing here logs it, and the only part the UI or
// any load function sees is `last4`. Set/remove is audited as an `integration_syncs` row
// with trigger='token' and detail `{ action, last4 }`.
//
// The storage helpers (`secretRow`, `openSecret`, `storeSecret`, `deleteSecret`) take any
// provider name: the assistant's Anthropic key (#297, provider 'anthropic', ../ai/key.ts)
// uses them without joining the Timing/GitHub sync registry.

import { isValidKey, open, seal } from '../crypto-box';
import type { IntegrationEnv, ProviderId } from './index';

/** Providers whose credential is one pasted token (Zoho Books uses OAuth, #353 — below). */
export type TokenProviderId = Exclude<ProviderId, 'zoho_books'>;

export const SECRET_NAMES: Record<TokenProviderId, 'TIMING_API_TOKEN' | 'GITHUB_TOKEN'> = {
	timing: 'TIMING_API_TOKEN',
	github: 'GITHUB_TOKEN'
};

const PROVIDER_IDS = Object.keys(SECRET_NAMES) as TokenProviderId[];

export function isTokenProvider(p: string): p is TokenProviderId {
	return Object.prototype.hasOwnProperty.call(SECRET_NAMES, p);
}
// Timing's personal access tokens are long JWT-style strings (well over 500 chars, #350).
const MAX_TOKEN_LEN = 4096;

function has(v: string | undefined | null): v is string {
	return typeof v === 'string' && v.trim() !== '';
}

/** In-app tokens are usable only when MAIL_TOKEN_KEY is set to a valid 32-byte key. */
export function tokenKeyReady(env: IntegrationEnv): boolean {
	return isValidKey(env.MAIL_TOKEN_KEY);
}

export type SecretRow = { provider: string; blob: string; last4: string; set_at: string; set_by_login: string | null };

// ---- generic storage, keyed by any provider name (also used by the assistant key, #297) ----

/** The stored row (sealed blob + display fields) for `provider`, or null. */
export async function secretRow(db: D1Database, provider: string): Promise<SecretRow | null> {
	return db
		.prepare(
			`SELECT s.provider, s.blob, s.last4, s.set_at, u.github_login AS set_by_login
			 FROM integration_secrets s LEFT JOIN users u ON u.id = s.set_by WHERE s.provider = ?`
		)
		.bind(provider)
		.first<SecretRow>();
}

/** Decrypt the stored secret; null when there's no row, no valid key, or it won't open. */
export async function openSecret(db: D1Database, mailTokenKey: string | undefined, provider: string): Promise<string | null> {
	const row = await secretRow(db, provider);
	if (!row) return null;
	if (!isValidKey(mailTokenKey)) return null;
	try {
		return await open(mailTokenKey, row.blob);
	} catch {
		console.error(`integration token for ${provider} could not be decrypted (wrong MAIL_TOKEN_KEY?)`);
		return null;
	}
}

/** The audit row for a set / remove, as a statement (so it can go in a caller's db.batch). */
export function auditSecretStatement(db: D1Database, provider: string, action: 'set' | 'removed', last4: string | null): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO integration_syncs (provider, trigger, finished_at, ok, detail)
			 VALUES (?, 'token', datetime('now'), 1, ?)`
		)
		.bind(provider, JSON.stringify({ action, last4 }));
}

/** The upsert of an already sealed blob, as a statement (for a caller's db.batch). */
export function storeSealedSecretStatement(db: D1Database, provider: string, blob: string, last4: string, userId: number | null): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO integration_secrets (provider, blob, last4, set_by, set_at)
			 VALUES (?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(provider) DO UPDATE SET blob = excluded.blob, last4 = excluded.last4,
			   set_by = excluded.set_by, set_at = excluded.set_at`
		)
		.bind(provider, blob, last4, userId);
}

/** For a caller's db.batch: audits a removal when a row exists. Must run BEFORE the DELETE
 *  in the same batch (it reads last4 from the row about to go). Same detail as `auditSecretStatement`. */
export function auditSecretRemovalStatement(db: D1Database, provider: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO integration_syncs (provider, trigger, finished_at, ok, detail)
			 SELECT provider, 'token', datetime('now'), 1, json_object('action', 'removed', 'last4', last4)
			 FROM integration_secrets WHERE provider = ?`
		)
		.bind(provider);
}

async function audit(db: D1Database, provider: string, action: 'set' | 'removed', last4: string | null) {
	await auditSecretStatement(db, provider, action, last4).run();
}

/** Seal + store (replacing any previous row) and audit. Throws without a valid key. */
export async function storeSecret(
	db: D1Database,
	mailTokenKey: string | undefined,
	provider: string,
	token: string,
	userId: number | null,
	opts: { last4?: string } = {}
): Promise<{ last4: string }> {
	if (!isValidKey(mailTokenKey)) throw new Error('MAIL_TOKEN_KEY is not set');
	const blob = await seal(mailTokenKey, token);
	const last4 = opts.last4 ?? token.slice(-4);
	await storeSealedSecretStatement(db, provider, blob, last4, userId).run();
	await audit(db, provider, 'set', last4);
	return { last4 };
}

/** Delete the stored row and audit. False when none was set. */
export async function deleteSecret(db: D1Database, provider: string): Promise<boolean> {
	const row = await db
		.prepare(`DELETE FROM integration_secrets WHERE provider = ? RETURNING last4`)
		.bind(provider)
		.first<{ last4: string }>();
	if (!row) return false;
	await audit(db, provider, 'removed', row.last4);
	return true;
}

// ---- Timing / GitHub ----

const storedRow = secretRow;
const storedToken = (db: D1Database, env: IntegrationEnv, provider: ProviderId) => openSecret(db, env.MAIL_TOKEN_KEY, provider);

/** In-app token, else the Worker secret, else null. */
export async function getProviderToken(db: D1Database, env: IntegrationEnv, provider: TokenProviderId): Promise<string | null> {
	const stored = await storedToken(db, env, provider);
	if (has(stored)) return stored;
	const fromEnv = env[SECRET_NAMES[provider]];
	return has(fromEnv) ? fromEnv : null;
}

/**
 * The env the integrations registry should see: each provider's secret replaced by
 * `getProviderToken`. Idempotent, so resolving an already-resolved env is harmless.
 */
export async function resolveIntegrationEnv(db: D1Database, env: IntegrationEnv): Promise<IntegrationEnv> {
	const out: IntegrationEnv = { ...env };
	for (const p of PROVIDER_IDS) {
		out[SECRET_NAMES[p]] = (await getProviderToken(db, env, p)) ?? undefined;
	}
	if (out.ZOHO_BOOKS === undefined) out.ZOHO_BOOKS = await loadZohoEnv(db, env.MAIL_TOKEN_KEY);
	return out;
}

// ---- Zoho Books (#353) ----
// One sealed row (provider 'zoho_books') holds the whole OAuth config as JSON; the chosen
// organization is not secret and lives in app_state. No Worker-secret fallback.

export const ZOHO_PROVIDER = 'zoho_books';
export const ZOHO_ORG_KEY = 'zoho_books_org';

export type ZohoCreds = {
	dc: string;
	client_id: string;
	client_secret: string;
	refresh_token: string;
	/** From the token response (e.g. https://www.zohoapis.eu); validated before use. */
	api_domain?: string | null;
};

export type ZohoOrg = { id: string; name: string; currency_code: string | null };

export type ZohoEnv = ZohoCreds & { organization_id: string | null; currency_code: string | null };

export async function readZohoOrg(db: D1Database): Promise<ZohoOrg | null> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(ZOHO_ORG_KEY).first<{ value: string | null }>();
	try {
		const v = JSON.parse(row?.value ?? 'null') as ZohoOrg | null;
		return v && typeof v.id === 'string' && v.id ? v : null;
	} catch {
		return null;
	}
}

/** The opened Zoho config + chosen organization, or null when not connected / unopenable. */
export async function loadZohoEnv(db: D1Database, mailTokenKey: string | undefined): Promise<ZohoEnv | null> {
	const raw = await openSecret(db, mailTokenKey, ZOHO_PROVIDER);
	if (!raw) return null;
	let creds: ZohoCreds;
	try {
		creds = JSON.parse(raw) as ZohoCreds;
	} catch {
		return null;
	}
	if (!creds?.refresh_token || !creds.client_id || !creds.client_secret || !creds.dc) return null;
	const org = await readZohoOrg(db);
	return { ...creds, organization_id: org?.id ?? null, currency_code: org?.currency_code ?? null };
}

/** What the Token row on a provider card shows. Never includes the token or blob. */
export type TokenInfo = {
	/** Which token is in effect: the in-app one, the Worker secret, or none. */
	source: 'app' | 'worker' | null;
	last4: string | null;
	setBy: string | null;
	setAt: string | null;
	/** An in-app token row exists (even if it can't be opened right now). */
	stored: boolean;
	/** A stored token exists but can't be used (key missing or wrong). */
	storedUnusable: boolean;
	/** The Worker secret is set — what Remove falls back to. */
	workerSecret: boolean;
};

export async function tokenInfo(db: D1Database, env: IntegrationEnv, provider: ProviderId): Promise<TokenInfo> {
	const row = await storedRow(db, provider);
	const workerValue = isTokenProvider(provider) ? env[SECRET_NAMES[provider]] : undefined;
	const workerSecret = has(workerValue);
	const usable = row ? has(await storedToken(db, env, provider)) : false;
	if (row && usable) {
		return {
			source: 'app',
			last4: row.last4,
			setBy: row.set_by_login,
			setAt: row.set_at,
			stored: true,
			storedUnusable: false,
			workerSecret
		};
	}
	return {
		source: workerSecret ? 'worker' : null,
		last4: workerSecret ? workerValue!.trim().slice(-4) : null,
		setBy: row?.set_by_login ?? null,
		setAt: row?.set_at ?? null,
		stored: !!row,
		storedUnusable: !!row,
		workerSecret
	};
}

/** Validate a pasted token (a leading `Bearer ` is dropped); returns the cleaned value or an error message. */
export function cleanToken(raw: string): { ok: true; token: string } | { ok: false; error: string } {
	const token = raw.trim().replace(/^Bearer\s+/i, '');
	if (!token) return { ok: false, error: 'Paste a token first.' };
	if (token.length > MAX_TOKEN_LEN) return { ok: false, error: 'That token is too long.' };
	if (/\s/.test(token)) return { ok: false, error: "A token can't contain spaces or line breaks." };
	if (token.length < 8) return { ok: false, error: 'That token is too short.' };
	return { ok: true, token };
}

/** Seal + store (replacing any previous in-app token) and audit. Throws without a valid key. */
export async function setProviderToken(
	db: D1Database,
	env: IntegrationEnv,
	provider: TokenProviderId,
	token: string,
	userId: number | null
): Promise<{ last4: string }> {
	return storeSecret(db, env.MAIL_TOKEN_KEY, provider, token, userId);
}

/** Delete the in-app token (the Worker secret, if any, takes over). False when none was set. */
export async function removeProviderToken(db: D1Database, provider: TokenProviderId): Promise<boolean> {
	return deleteSecret(db, provider);
}

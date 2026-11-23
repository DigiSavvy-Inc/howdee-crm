// #71: external Data API keys. Bearer tokens for /api/v1/* — other apps read/write app data.
// Tokens are hashed at rest (SHA-256); the plaintext is shown once at creation and never
// stored. Auth flow: hash the presented bearer token, look it up by hash (unique-indexed,
// so the compare happens in the DB, not in app code — no string-timing surface), check scope.
import type { RequestEvent } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';

// #238: 'campaigns:draft' = may ONLY create (POST /api/v1/campaigns) and, since #252, edit
// (PATCH /api/v1/campaigns/:id) Compose drafts; no reads, no deletes.
// #347: 'automations:draft' = may ONLY create and edit draft / paused automations over
// /api/v1/automations (never activate, pause, enroll or delete); no reads.
export type ApiScope = 'read' | 'read_write' | 'campaigns:draft' | 'automations:draft';

/** Draft-only scopes: each works on its own endpoints and nowhere else. */
const DRAFT_SCOPES: Record<string, string> = {
	'campaigns:draft': 'can only create and edit Compose drafts',
	'automations:draft': 'can only create and edit automation drafts'
};

export type ApiKeyRow = {
	id: number;
	label: string;
	token_prefix: string;
	token_last4: string;
	scope: ApiScope;
	created_at: string;
	last_used_at: string | null;
	request_count: number;
	revoked_at: string | null;
};

const TOKEN_PREFIX = 'dk_live_';

/** SHA-256 hex digest (Web Crypto — Workers-native, no Node `crypto`). */
export async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A freshly minted key. `token` is the only time the plaintext exists — show it once. */
export type NewApiKey = {
	token: string;
	tokenHash: string;
	prefix: string; // dk_live_ + first 6 random hex — stored for display
	last4: string;
};

/** Mint a key: `dk_live_` + 48 hex chars of CSPRNG (192 bits). */
export async function generateApiKey(): Promise<NewApiKey> {
	const b = new Uint8Array(24);
	crypto.getRandomValues(b);
	const rand = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	const token = TOKEN_PREFIX + rand;
	return {
		token,
		tokenHash: await sha256Hex(token),
		prefix: TOKEN_PREFIX + rand.slice(0, 6),
		last4: rand.slice(-4)
	};
}

/** Masked identifier shown in the UI, e.g. `dk_live_a1b2c3…wxyz`. */
export function maskKey(prefix: string, last4: string): string {
	return `${prefix}…${last4}`;
}

export type AuthResult =
	| { ok: true; key: ApiKeyRow }
	| { ok: false; status: number; error: string };

/**
 * Authenticate a Data API request by its `Authorization: Bearer <token>` header and require
 * at least `requiredScope`. Bumps usage counters on success (best-effort). Returns a tagged
 * result so routes can map it straight to a JSON error response.
 */
export async function authenticateApiKey(
	event: RequestEvent,
	requiredScope: ApiScope
): Promise<AuthResult> {
	const found = await findApiKey(event);
	if (!found.ok) return found;
	const key = found.key;
	const db = getDB(event);

	// #238/#347: a draft-only key works on its own draft endpoints and nowhere else.
	if (key.scope in DRAFT_SCOPES && requiredScope !== key.scope) {
		return { ok: false, status: 403, error: `This key is scoped to ${key.scope} and ${DRAFT_SCOPES[key.scope]}.` };
	}
	if (requiredScope in DRAFT_SCOPES && key.scope !== 'read_write' && key.scope !== requiredScope) {
		return { ok: false, status: 403, error: `A read_write or ${requiredScope} key is required for this operation.` };
	}
	if (requiredScope === 'read_write' && key.scope !== 'read_write') {
		return { ok: false, status: 403, error: 'This key is read-only; a read_write key is required for this operation.' };
	}

	await bumpApiKeyUsage(db, key.id);
	return { ok: true, key };
}

/**
 * #348: the key behind `Authorization: Bearer <token>`, with no scope check and no counter
 * bump — the MCP endpoint decides per tool what the scope allows.
 */
export async function findApiKey(event: RequestEvent): Promise<AuthResult> {
	const header = event.request.headers.get('authorization') ?? '';
	const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
	if (!m) return { ok: false, status: 401, error: 'Missing or malformed Authorization header. Use: Authorization: Bearer <key>' };

	const hash = await sha256Hex(m[1]);
	const key = await getDB(event)
		.prepare(
			`SELECT id, label, token_prefix, token_last4, scope, created_at, last_used_at, request_count, revoked_at
			 FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL`
		)
		.bind(hash)
		.first<ApiKeyRow>();
	if (!key) return { ok: false, status: 401, error: 'Invalid or revoked API key.' };
	return { ok: true, key };
}

/** Best-effort usage tracking — never fail the request over a counter bump. */
export async function bumpApiKeyUsage(db: D1Database, keyId: number): Promise<void> {
	try {
		await db
			.prepare(`UPDATE api_keys SET request_count = request_count + 1, last_used_at = datetime('now') WHERE id = ?`)
			.bind(keyId)
			.run();
	} catch {
		/* ignore */
	}
}

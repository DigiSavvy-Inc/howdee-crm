// Integrations hub (#167): a small registry of outside services (Timing, GitHub) whose
// tokens are entered in Settings (encrypted in D1, #175 — ./secrets.ts) or fall back to
// Worker secrets, plus the one shared sync runner both Settings → Integrations
// ("Sync now") and the heartbeat tick use.
//
// - A provider is *configured* when its token resolves (in-app token or Worker secret). Whether it's *connected* is only known
//   from a live probe (Test connection); the last probe result is kept in app_state.
// - Every sync run writes an `integration_syncs` row (ok 1/0 + JSON detail). A run never
//   throws out of `runProviderSync` — errors land in the row.
// - The tick runs each configured provider at most once per CRON_INTERVAL_MS, stamped in
//   app_state `integration_cron_at:<provider>` before the run (a failing provider retries on
//   the next window, not every minute).
// - Runs never overlap per provider: a lease in app_state `integration_lock:<provider>`
//   claimed with a conditional upsert (checked via meta.changes), the same claim-before-work
//   idea as the automations tick. An expired lease (crashed run) is reclaimable.
//
// What a sync *does* is provider-owned and grows in later issues (#165). Timing (#168)
// refreshes the project-picker cache and rolls up hours for every company with an attached
// project (see ./timing.ts); GitHub syncs the repos attached to companies (#169, ./github.ts);
// Zoho Books mirrors invoices + payments of the customers linked to companies (#353, ./zoho.ts —
// OAuth, not a pasted token, so its card has its own connect form).

import { syncTimingCompanies, timingProjects } from './timing';
import { syncGithubRepos } from './github';
import { accessToken, apiBase, parseOrgs, syncZohoBooks, ZohoAuthError } from './zoho';
import { resolveIntegrationEnv, tokenInfo, type TokenInfo, type ZohoEnv } from './secrets';
import { evaluateMetricCrossings } from '../metric-trigger';
import { USER_AGENT } from '../user-agent';

export { resolveIntegrationEnv } from './secrets';

export type ProviderId = 'timing' | 'github' | 'zoho_books';
export type SyncTrigger = 'cron' | 'manual';

/**
 * The secrets this module reads. Typed loosely so tests can pass a plain object.
 * MAIL_TOKEN_KEY opens in-app tokens (#175): the entry points below resolve the provider
 * tokens through `resolveIntegrationEnv` (in-app token → Worker secret → unset).
 */
export type IntegrationEnv = {
	TIMING_API_TOKEN?: string;
	GITHUB_TOKEN?: string;
	MAIL_TOKEN_KEY?: string;
	/** Zoho Books (#353): the opened OAuth config + chosen org, filled by resolveIntegrationEnv. */
	ZOHO_BOOKS?: ZohoEnv | null;
};

export type ProbeState = 'connected' | 'rejected' | 'error';
export type ProbeResult = {
	state: ProbeState;
	/** Short human text, e.g. "Signed in as octocat" or "HTTP 401 — token rejected". */
	detail: string;
	checkedAt: string;
};

export type SyncDetail = { counts: Record<string, number>; errors: string[] };

export type FetchFn = typeof fetch;

export interface IntegrationProvider {
	provider: ProviderId;
	label: string;
	/** The Worker secret name — shown in the setup command, never its value. */
	secretName: keyof IntegrationEnv;
	/** Where to create the token (shown in the how-to). */
	tokenHelp: string;
	isConfigured(env: IntegrationEnv): boolean;
	probe(env: IntegrationEnv, f?: FetchFn): Promise<ProbeResult>;
	/** `companyId` narrows a sync to one company (company page "Sync now"). */
	sync(
		db: D1Database,
		env: IntegrationEnv,
		opts: { trigger: SyncTrigger; fetch?: FetchFn; companyId?: number }
	): Promise<SyncDetail>;
}

export const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCK_LEASE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const TIMING_BASE = 'https://web.timingapp.com/api/v1';
const GITHUB_BASE = 'https://api.github.com';

function nowIso(d = new Date()): string {
	return d.toISOString();
}

function has(v: string | undefined): v is string {
	return typeof v === 'string' && v.trim() !== '';
}

async function timedFetch(f: FetchFn, url: string, init: RequestInit): Promise<Response> {
	// `return await`, not `return`: under workerd a rejected promise handed straight back from an
	// async function surfaces as an unhandled rejection before the caller's catch adopts it.
	return await f(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** Map a probe HTTP response to a state: 401/403 = the secret is set but rejected. */
function httpState(status: number): ProbeState {
	if (status === 401 || status === 403) return 'rejected';
	return status >= 200 && status < 300 ? 'connected' : 'error';
}

function rejectedText(status: number): string {
	return status === 401 || status === 403 ? `HTTP ${status} — token rejected` : `HTTP ${status}`;
}

function errText(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function timingHeaders(env: IntegrationEnv) {
	return { Authorization: `Bearer ${env.TIMING_API_TOKEN}`, Accept: 'application/json' };
}

export const timingProvider: IntegrationProvider = {
	provider: 'timing',
	label: 'Timing',
	secretName: 'TIMING_API_TOKEN',
	tokenHelp: 'Timing web app → Account → API Keys',
	isConfigured: (env) => has(env.TIMING_API_TOKEN),
	async probe(env, f = fetch) {
		const checkedAt = nowIso();
		try {
			const res = await timedFetch(f, `${TIMING_BASE}/projects?limit=1`, { headers: timingHeaders(env) });
			const state = httpState(res.status);
			return { state, detail: state === 'connected' ? 'Projects API reachable' : rejectedText(res.status), checkedAt };
		} catch (e) {
			return { state: 'error', detail: errText(e), checkedAt };
		}
	},
	async sync(db, env, opts) {
		// Refresh the picker cache first — also the cheap auth check (401 → ok=0 row).
		const projects = await timingProjects(db, env, { fetch: opts.fetch, refresh: true });
		const res = await syncTimingCompanies(db, env, { fetch: opts.fetch, companyId: opts.companyId });
		return { counts: { projects: projects.length, ...res.counts }, errors: res.errors };
	}
};

function githubHeaders(env: IntegrationEnv) {
	return {
		Authorization: `Bearer ${env.GITHUB_TOKEN}`,
		Accept: 'application/vnd.github+json',
		'User-Agent': USER_AGENT
	};
}

export const githubProvider: IntegrationProvider = {
	provider: 'github',
	label: 'GitHub',
	secretName: 'GITHUB_TOKEN',
	tokenHelp: 'GitHub → Settings → Developer settings → Personal access tokens',
	isConfigured: (env) => has(env.GITHUB_TOKEN),
	async probe(env, f = fetch) {
		const checkedAt = nowIso();
		try {
			const res = await timedFetch(f, `${GITHUB_BASE}/user`, { headers: githubHeaders(env) });
			const state = httpState(res.status);
			if (state !== 'connected') return { state, detail: rejectedText(res.status), checkedAt };
			const user = (await res.json().catch(() => null)) as { login?: string } | null;
			const remaining = res.headers.get('x-ratelimit-remaining');
			const who = user?.login ? `Signed in as ${user.login}` : 'Token accepted';
			return { state, detail: remaining ? `${who} · ${remaining} API calls left this hour` : who, checkedAt };
		} catch (e) {
			return { state: 'error', detail: errText(e), checkedAt };
		}
	},
	sync: (db, env, opts) => syncGithubRepos(db, env, opts)
};

export const zohoBooksProvider: IntegrationProvider = {
	provider: 'zoho_books',
	label: 'Zoho Books',
	secretName: 'ZOHO_BOOKS',
	tokenHelp: 'api-console.zoho.com → Self Client',
	// Connected *and* an organization picked — until then there's nothing to sync.
	isConfigured: (env) => !!env.ZOHO_BOOKS?.refresh_token && !!env.ZOHO_BOOKS.organization_id,
	async probe(env, f = fetch) {
		const checkedAt = nowIso();
		const z = env.ZOHO_BOOKS!;
		try {
			const token = await accessToken(z, f);
			const res = await timedFetch(f, `${apiBase(z)}/organizations`, {
				headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' }
			});
			const state = httpState(res.status);
			if (state !== 'connected') return { state, detail: rejectedText(res.status), checkedAt };
			const org = parseOrgs(await res.json().catch(() => null)).find((o) => o.id === z.organization_id);
			if (!org) return { state: 'error', detail: 'The chosen organization is no longer visible to this client', checkedAt };
			return { state, detail: `Organization: ${org.name}${org.currency_code ? ` (${org.currency_code})` : ''}`, checkedAt };
		} catch (e) {
			return { state: e instanceof ZohoAuthError ? 'rejected' : 'error', detail: errText(e), checkedAt };
		}
	},
	async sync(db, env, opts) {
		try {
			return await syncZohoBooks(db, env.ZOHO_BOOKS!, opts);
		} catch (e) {
			// A refresh Zoho refuses means the connection is dead: show the card as rejected.
			if (e instanceof ZohoAuthError) {
				await setState(db, probeKey('zoho_books'), JSON.stringify({ state: 'rejected', detail: errText(e), checkedAt: nowIso() }));
			}
			throw e;
		}
	}
};

export const PROVIDERS: IntegrationProvider[] = [timingProvider, githubProvider, zohoBooksProvider];

/** Zoho Books scoped to one company's linked customers — the company page's Sync now. */
export function zohoProviderFor(companyId: number): IntegrationProvider {
	return { ...zohoBooksProvider, sync: (db, env, opts) => zohoBooksProvider.sync(db, env, { ...opts, companyId }) };
}

/** GitHub scoped to one company's repos — the company page's Sync now (same log + lock). */
export function githubProviderFor(companyId: number): IntegrationProvider {
	return { ...githubProvider, sync: (db, env, opts) => syncGithubRepos(db, env, { ...opts, companyId }) };
}

export function getProvider(id: string, providers = PROVIDERS): IntegrationProvider | undefined {
	return providers.find((p) => p.provider === id);
}

// ---------------------------------------------------------------------------
// app_state helpers
// ---------------------------------------------------------------------------

async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(key).first<{ value: string | null }>();
	return row?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

const lockKey = (p: ProviderId) => `integration_lock:${p}`;
const cronKey = (p: ProviderId) => `integration_cron_at:${p}`;
const probeKey = (p: ProviderId) => `integration_probe:${p}`;

/** Claim the per-provider lease; false when another run holds an unexpired one. */
async function claimLock(db: D1Database, p: ProviderId, now: Date): Promise<boolean> {
	const expires = new Date(now.getTime() + LOCK_LEASE_MS).toISOString();
	const res = await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
			 WHERE app_state.value IS NULL OR app_state.value < ?`
		)
		.bind(lockKey(p), expires, nowIso(now))
		.run();
	return (res.meta.changes ?? 0) > 0;
}

async function releaseLock(db: D1Database, p: ProviderId): Promise<void> {
	await setState(db, lockKey(p), '');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type RunResult =
	| { provider: ProviderId; skipped: 'not_configured' | 'locked' }
	| { provider: ProviderId; id: number; ok: boolean; detail: SyncDetail | { error: string } };

/**
 * Run one provider's sync and log it. Never throws: a sync error becomes an `ok=0` row.
 * Secret values are scrubbed from any error text before it's stored.
 */
export async function runProviderSync(
	db: D1Database,
	env: IntegrationEnv,
	provider: IntegrationProvider,
	trigger: SyncTrigger,
	opts: { now?: Date; fetch?: FetchFn; companyId?: number } = {}
): Promise<RunResult> {
	const p = provider.provider;
	env = await resolveIntegrationEnv(db, env);
	if (!provider.isConfigured(env)) return { provider: p, skipped: 'not_configured' };
	const now = opts.now ?? new Date();
	if (!(await claimLock(db, p, now))) return { provider: p, skipped: 'locked' };

	try {
		const row = await db
			.prepare(`INSERT INTO integration_syncs (provider, trigger) VALUES (?, ?) RETURNING id`)
			.bind(p, trigger)
			.first<{ id: number }>();
		const id = row!.id;

		let ok = true;
		let detail: SyncDetail | { error: string };
		try {
			detail = await provider.sync(db, env, { trigger, fetch: opts.fetch, companyId: opts.companyId });
		} catch (e) {
			ok = false;
			detail = { error: scrub(errText(e), env) };
		}
		if (ok && 'errors' in detail && detail.errors.length > 0) {
			detail = { ...detail, errors: detail.errors.map((m) => scrub(m, env)) };
		}

		await db
			.prepare(`UPDATE integration_syncs SET finished_at = datetime('now'), ok = ?, detail = ? WHERE id = ?`)
			.bind(ok ? 1 : 0, JSON.stringify(detail).slice(0, 4000), id)
			.run();
		// #170: "Company metric crossed" triggers compare against the previous sync's values.
		if (ok) await evaluateMetricCrossings(db).catch((e) => console.error('metric crossings failed:', e));
		return { provider: p, id, ok, detail };
	} finally {
		await releaseLock(db, p);
	}
}

function scrub(text: string, env: IntegrationEnv): string {
	let out = text;
	for (const v of [env.TIMING_API_TOKEN, env.GITHUB_TOKEN, env.ZOHO_BOOKS?.client_secret, env.ZOHO_BOOKS?.refresh_token]) {
		if (has(v)) out = out.split(v).join('[redacted]');
	}
	return out;
}

/**
 * Heartbeat hook: run every configured provider whose last cron run is older than
 * CRON_INTERVAL_MS. Unconfigured providers are skipped silently (no row, no stamp).
 */
export async function runIntegrationsTick(
	db: D1Database,
	env: IntegrationEnv,
	opts: { now?: Date; fetch?: FetchFn; providers?: IntegrationProvider[] } = {}
): Promise<RunResult[]> {
	const now = opts.now ?? new Date();
	env = await resolveIntegrationEnv(db, env);
	const results: RunResult[] = [];
	for (const provider of opts.providers ?? PROVIDERS) {
		if (!provider.isConfigured(env)) continue;
		const last = Date.parse((await getState(db, cronKey(provider.provider))) ?? '');
		if (Number.isFinite(last) && now.getTime() - last < CRON_INTERVAL_MS) continue;
		await setState(db, cronKey(provider.provider), nowIso(now));
		results.push(await runProviderSync(db, env, provider, 'cron', { now, fetch: opts.fetch }));
	}
	return results;
}

/** Probe a provider and remember the result for the Settings card. */
export async function testConnection(
	db: D1Database,
	env: IntegrationEnv,
	provider: IntegrationProvider,
	f?: FetchFn
): Promise<ProbeResult | null> {
	env = await resolveIntegrationEnv(db, env);
	if (!provider.isConfigured(env)) return null;
	const result = await provider.probe(env, f);
	result.detail = scrub(result.detail, env);
	await setState(db, probeKey(provider.provider), JSON.stringify(result));
	return result;
}

// ---------------------------------------------------------------------------
// Read side (Settings → Integrations)
// ---------------------------------------------------------------------------

export type SyncRow = {
	id: number;
	provider: ProviderId;
	trigger: SyncTrigger;
	started_at: string;
	finished_at: string | null;
	ok: number | null;
	detail: string | null;
};

/** Card state: not configured / configured but untested / connected / rejected / error. */
export type CardState = 'not_configured' | 'untested' | ProbeState;

export type ProviderStatus = {
	provider: ProviderId;
	label: string;
	secretName: string;
	tokenHelp: string;
	configured: boolean;
	state: CardState;
	probe: ProbeResult | null;
	lastSync: SyncRow | null;
	lastCronAt: string | null;
	/** Which token is in effect and its last 4 characters (#175) — never the token itself. */
	token: TokenInfo;
};

/** Forget the last probe (its token is gone); the card falls back to untested/not connected. */
export async function clearProbe(db: D1Database, p: ProviderId): Promise<void> {
	await db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(probeKey(p)).run();
}

export async function integrationsStatus(
	db: D1Database,
	rawEnv: IntegrationEnv,
	providers = PROVIDERS
): Promise<ProviderStatus[]> {
	const env = await resolveIntegrationEnv(db, rawEnv);
	const out: ProviderStatus[] = [];
	for (const p of providers) {
		const configured = p.isConfigured(env);
		let probe: ProbeResult | null = null;
		try {
			probe = JSON.parse((await getState(db, probeKey(p.provider))) ?? 'null');
		} catch {
			probe = null;
		}
		const lastSync = await db
			.prepare(
				`SELECT * FROM integration_syncs WHERE provider = ? AND trigger != 'token' ORDER BY id DESC LIMIT 1`
			)
			.bind(p.provider)
			.first<SyncRow>();
		out.push({
			provider: p.provider,
			label: p.label,
			secretName: p.secretName,
			tokenHelp: p.tokenHelp,
			configured,
			// A probe from before the secret was removed doesn't count.
			state: !configured ? 'not_configured' : (probe?.state ?? 'untested'),
			probe: configured ? probe : null,
			lastSync: lastSync ?? null,
			lastCronAt: await getState(db, cronKey(p.provider)),
			token: await tokenInfo(db, rawEnv, p.provider)
		});
	}
	return out;
}

export async function recentSyncs(db: D1Database, limit = 20): Promise<SyncRow[]> {
	const rows = await db
		.prepare(`SELECT * FROM integration_syncs ORDER BY id DESC LIMIT ?`)
		.bind(limit)
		.all<SyncRow>();
	return rows.results;
}

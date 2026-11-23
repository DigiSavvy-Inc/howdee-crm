// #609: Settings → Setup — what a working install needs, and what is still missing.
//
// Three groups: required (local reads only), Postmark (calls the Postmark API with the server
// token) and optional (one row per optional integration from the #605 table). A row is
// `ready`, `attention` (needs fixing) or `optional` (optional and not set up). Secrets are
// only ever reported as set / not set: no value, prefix or length reaches a row.
//
// `localRequiredAttention` is the cheap, network-free part the dashboard uses for its admin
// notice, so the dashboard never calls Postmark.

import { isEmail } from '$lib/csv';
import { safeEqual } from './auth';
import { secretRow, ZOHO_ORG_KEY, ZOHO_PROVIDER } from './integrations/secrets';
import { ANTHROPIC_PROVIDER, OPENAI_SECRET_PROVIDER } from './ai/key';
import { checkUnsubscribeHandling } from './domain-auth';

export type SetupState = 'ready' | 'attention' | 'optional';
export type SetupGroup = 'required' | 'postmark' | 'optional';

export type SetupCheck = {
	id: string;
	group: SetupGroup;
	label: string;
	state: SetupState;
	/** What was found — never a secret value. */
	detail: string;
	/** One line on how to fix it (only when not ready). */
	fix?: string;
	/** The settings page that covers it. */
	href?: string;
};

export type SetupReport = {
	checks: SetupCheck[];
	/** Required + Postmark rows that need attention. */
	attention: number;
};

/** A heartbeat tick older than this many minutes counts as stale (the cron runs every minute). */
export const TICK_STALE_MINUTES = 10;

const PM_API = 'https://api.postmarkapp.com';
const PM_TIMEOUT_MS = 8_000;

/**
 * The newest file in `migrations/`, baked in at build time by the `define` in vite.config.ts
 * and vitest.config.ts. Null when the build didn't define it.
 */
export function expectedMigration(): string | null {
	return typeof __LATEST_MIGRATION__ === 'string' && __LATEST_MIGRATION__ ? __LATEST_MIGRATION__ : null;
}

type AnyEnv = Record<string, unknown> | undefined | null;

function str(env: AnyEnv, name: string): string {
	const v = env?.[name];
	return typeof v === 'string' ? v.trim() : '';
}

function isSet(env: AnyEnv, name: string): boolean {
	return str(env, name) !== '';
}

/** A real From address: valid, and not a placeholder on example.com / .org / .net. */
export function usableFrom(value: string | null | undefined): boolean {
	const v = (value ?? '').trim().toLowerCase();
	if (!v || !isEmail(v)) return false;
	const domain = v.split('@')[1] ?? '';
	return !/(^|\.)example\.(com|org|net)$/.test(domain);
}

async function appState(db: D1Database, key: string): Promise<{ value: string | null; updated_at: string | null } | null> {
	return db.prepare(`SELECT value, updated_at FROM app_state WHERE key = ?`).bind(key).first<{ value: string | null; updated_at: string | null }>();
}

async function hasSecretRow(db: D1Database, provider: string): Promise<boolean> {
	try {
		return !!(await secretRow(db, provider));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------
// Required (local)

export async function migrationsCheck(db: D1Database, expected = expectedMigration()): Promise<SetupCheck> {
	const base = { id: 'migrations', group: 'required' as const, label: 'Database migrations' };
	let applied: string | null = null;
	try {
		applied = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>())?.name ?? null;
	} catch {
		applied = null;
	}
	const fix = 'Run `npm run deploy` (it applies the remote migrations first), or `npx wrangler d1 migrations apply <database> --remote`.';
	if (!applied) return { ...base, state: 'attention', detail: 'No migrations have been applied to this database.', fix };
	if (!expected) return { ...base, state: 'ready', detail: `Latest applied: ${applied}.` };
	if (applied === expected) return { ...base, state: 'ready', detail: `Up to date (${applied}).` };
	// Names start with a zero-padded number, so a plain compare orders them.
	if (applied > expected) return { ...base, state: 'ready', detail: `Latest applied: ${applied} (newer than this build's ${expected}).` };
	return { ...base, state: 'attention', detail: `Behind: latest applied is ${applied}, this build expects ${expected}.`, fix };
}

function bindingCheck(env: AnyEnv): SetupCheck {
	const bound = !!env?.MEDIA;
	return {
		id: 'media',
		group: 'required',
		label: 'Media bucket (R2 binding MEDIA)',
		state: bound ? 'ready' : 'attention',
		detail: bound ? 'Bound.' : 'Not bound.',
		fix: bound ? undefined : 'Add an `r2_buckets` entry with binding `MEDIA` to wrangler.jsonc and deploy.'
	};
}

function secretCheck(env: AnyEnv, name: string, label: string, fix: string): SetupCheck {
	const set = isSet(env, name);
	return {
		id: name.toLowerCase(),
		group: 'required',
		label,
		state: set ? 'ready' : 'attention',
		detail: set ? 'Set.' : 'Not set.',
		fix: set ? undefined : fix
	};
}

async function defaultFromCheck(db: D1Database, env: AnyEnv): Promise<SetupCheck> {
	const base = { id: 'default_from', group: 'required' as const, label: 'Default From address', href: '/settings' };
	const stored = (await appState(db, 'default_from'))?.value?.trim() || '';
	if (usableFrom(stored)) return { ...base, state: 'ready', detail: `Settings → General: ${stored}.` };
	const pmFrom = str(env, 'POSTMARK_FROM');
	if (usableFrom(pmFrom)) return { ...base, state: 'ready', detail: `POSTMARK_FROM in wrangler.jsonc: ${pmFrom}.` };
	return {
		...base,
		state: 'attention',
		detail: pmFrom ? `POSTMARK_FROM is a placeholder (${pmFrom}) and Settings has no Default From.` : 'Neither Settings → General nor POSTMARK_FROM has a From address.',
		fix: 'Set Default From in Settings → General (an address on a domain verified in Postmark), or POSTMARK_FROM in wrangler.jsonc.'
	};
}

export async function heartbeatCheck(db: D1Database): Promise<SetupCheck> {
	const base = { id: 'heartbeat', group: 'required' as const, label: 'Heartbeat (last tick)' };
	const row = await db
		.prepare(
			`SELECT updated_at, CAST((julianday('now') - julianday(updated_at)) * 1440 AS INTEGER) AS age
			 FROM app_state WHERE key = 'last_tick'`
		)
		.first<{ updated_at: string | null; age: number | null }>();
	const fix = 'Deploy the heartbeat Worker (heartbeat/) with the same CRON_KEY as this Worker; see heartbeat/README.md.';
	if (!row?.updated_at) return { ...base, state: 'attention', detail: 'The heartbeat has never ticked.', fix };
	const age = row.age ?? 0;
	if (age > TICK_STALE_MINUTES) return { ...base, state: 'attention', detail: `Last tick ${row.updated_at} UTC (${age} min ago).`, fix };
	return { ...base, state: 'ready', detail: `Last tick ${row.updated_at} UTC (${age} min ago).` };
}

/** The network-free required checks. */
export async function localRequiredChecks(db: D1Database, env: AnyEnv): Promise<SetupCheck[]> {
	const [migrations, from, heartbeat] = await Promise.all([migrationsCheck(db), defaultFromCheck(db, env), heartbeatCheck(db)]);
	return [
		migrations,
		bindingCheck(env),
		secretCheck(env, 'SESSION_SECRET', 'SESSION_SECRET', 'Run `npx wrangler secret put SESSION_SECRET` with a long random value.'),
		secretCheck(env, 'POSTMARK_TOKEN', 'Postmark server token', 'Run `npx wrangler secret put POSTMARK_TOKEN` with the Postmark server API token.'),
		from,
		secretCheck(env, 'CRON_KEY', 'CRON_KEY', 'Run `npx wrangler secret put CRON_KEY` here and on the heartbeat Worker, with the same value.'),
		heartbeat
	];
}

/** Count of required checks needing attention — the dashboard notice. No network calls. */
export async function localRequiredAttention(db: D1Database, env: AnyEnv): Promise<number> {
	return (await localRequiredChecks(db, env)).filter((c) => c.state === 'attention').length;
}

// ---------------------------------------------------------------------------------------
// Postmark

type PmRead = { status: number; body: unknown } | { status: 0; error: string };

async function pmGet(fetchFn: typeof fetch, token: string, path: string): Promise<PmRead> {
	try {
		const res = await fetchFn(`${PM_API}${path}`, {
			headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token },
			signal: AbortSignal.timeout(PM_TIMEOUT_MS)
		});
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		return { status: res.status, body };
	} catch (e) {
		return { status: 0, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
	}
}

const rejected = (r: PmRead) => r.status === 401 || r.status === 403;

/** True when the Postmark webhook URL is this install's `/api/webhook` with our key. */
export function webhookMatches(url: unknown, key: string): boolean {
	if (typeof url !== 'string' || !key) return false;
	try {
		const u = new URL(url);
		return u.pathname.replace(/\/+$/, '') === '/api/webhook' && safeEqual(u.searchParams.get('key') ?? '', key);
	} catch {
		return false;
	}
}

export async function postmarkChecks(env: AnyEnv, fetchFn: typeof fetch = fetch): Promise<SetupCheck[]> {
	const token = str(env, 'POSTMARK_TOKEN');
	const broadcast = str(env, 'POSTMARK_STREAM') || 'broadcast';
	const tx = str(env, 'POSTMARK_STREAM_TX') || 'outbound';
	// Token + streams are required checks; the webhook and unsubscribe handling are Postmark's own group.
	const tokenRow = { id: 'postmark_token', group: 'required' as const, label: 'Postmark server token' };
	const streamsRow = { id: 'postmark_streams', group: 'required' as const, label: 'Message streams' };
	const webhookRow = { id: 'postmark_webhook', group: 'postmark' as const, label: 'Postmark webhook', href: '/deliverability' };
	const unsubRow = { id: 'postmark_unsubscribe', group: 'postmark' as const, label: 'Custom unsubscribe handling', href: '/deliverability#domain-auth' };

	if (!token) {
		const skipped = 'Not checked: POSTMARK_TOKEN is not set.';
		return [
			{ ...tokenRow, state: 'attention', detail: 'POSTMARK_TOKEN is not set.', fix: 'Run `npx wrangler secret put POSTMARK_TOKEN` with the Postmark server API token.' },
			{ ...streamsRow, state: 'attention', detail: skipped },
			{ ...webhookRow, state: 'attention', detail: skipped },
			{ ...unsubRow, state: 'attention', detail: skipped }
		];
	}

	const [b, t, hooks] = await Promise.all([
		pmGet(fetchFn, token, `/message-streams/${encodeURIComponent(broadcast)}`),
		broadcast === tx ? Promise.resolve(null) : pmGet(fetchFn, token, `/message-streams/${encodeURIComponent(tx)}`),
		pmGet(fetchFn, token, `/webhooks?MessageStream=${encodeURIComponent(broadcast)}`)
	]);
	const reads = [b, t, hooks].filter((r): r is PmRead => !!r);

	let token_: SetupCheck;
	if (reads.some(rejected)) {
		token_ = { ...tokenRow, state: 'attention', detail: 'Postmark rejected the token.', fix: 'Use the Server API token (Postmark → Servers → your server → API Tokens), not the account token.' };
	} else if (reads.every((r) => r.status === 0)) {
		const err = (b as { error?: string }).error ?? 'no answer';
		token_ = { ...tokenRow, state: 'attention', detail: `Couldn't reach Postmark: ${err}.`, fix: 'Reload this page to check again.' };
	} else {
		token_ = { ...tokenRow, state: 'ready', detail: 'Postmark accepted the token.' };
	}
	const tokenOk = token_.state === 'ready';

	// Streams: both must answer 200.
	let streams: SetupCheck;
	if (!tokenOk) streams = { ...streamsRow, state: 'attention', detail: 'Not checked: the token check failed.' };
	else if (broadcast === tx) {
		streams = {
			...streamsRow,
			state: 'attention',
			detail: `POSTMARK_STREAM and POSTMARK_STREAM_TX are both "${broadcast}".`,
			fix: 'Use a broadcast stream for POSTMARK_STREAM and the transactional one (usually "outbound") for POSTMARK_STREAM_TX.'
		};
	} else {
		const missing: string[] = [];
		const other: string[] = [];
		for (const [name, r] of [[broadcast, b], [tx, t]] as [string, PmRead][]) {
			if (r.status === 200) continue;
			if (r.status === 404 || r.status === 422) missing.push(name);
			else other.push(`${name} (${r.status === 0 ? 'no answer' : `HTTP ${r.status}`})`);
		}
		if (!missing.length && !other.length) streams = { ...streamsRow, state: 'ready', detail: `"${broadcast}" (broadcast) and "${tx}" (transactional) exist.` };
		else
			streams = {
				...streamsRow,
				state: 'attention',
				detail: [missing.length ? `Not found: ${missing.join(', ')}.` : '', other.length ? `Couldn't read: ${other.join(', ')}.` : ''].filter(Boolean).join(' '),
				fix: 'Create the stream in Postmark (Servers → your server → Message Streams), or fix POSTMARK_STREAM / POSTMARK_STREAM_TX in wrangler.jsonc.'
			};
	}

	// Webhook on the broadcast stream, pointing at /api/webhook with our WEBHOOK_KEY.
	const key = str(env, 'WEBHOOK_KEY');
	const webhookFix = 'In Postmark → Servers → your server → the broadcast stream → Webhooks, add <this app>/api/webhook?key=<WEBHOOK_KEY> with every trigger on.';
	let webhook: SetupCheck;
	if (!key) webhook = { ...webhookRow, state: 'attention', detail: 'WEBHOOK_KEY is not set, so the webhook answers 401.', fix: 'Run `npx wrangler secret put WEBHOOK_KEY`, then point the Postmark webhook at /api/webhook?key=<WEBHOOK_KEY>.' };
	else if (!tokenOk) webhook = { ...webhookRow, state: 'attention', detail: 'Not checked: the token check failed.' };
	else if (hooks.status !== 200) webhook = { ...webhookRow, state: 'attention', detail: `Couldn't list webhooks (${hooks.status === 0 ? 'no answer' : `HTTP ${hooks.status}`}).`, fix: 'Reload this page to check again.' };
	else {
		const list = ((hooks.body as { Webhooks?: { Url?: unknown }[] } | null)?.Webhooks ?? []) as { Url?: unknown }[];
		webhook = list.some((h) => webhookMatches(h?.Url, key))
			? { ...webhookRow, state: 'ready', detail: `A webhook on "${broadcast}" points at this install.` }
			: { ...webhookRow, state: 'attention', detail: `No webhook on "${broadcast}" points at /api/webhook with this install's key.`, fix: webhookFix };
	}

	// Unsubscribe handling (#373), read from the broadcast stream answer.
	let unsub: SetupCheck;
	if (!tokenOk) unsub = { ...unsubRow, state: 'attention', detail: 'Not checked: the token check failed.' };
	else if (broadcast === tx || b.status !== 200) unsub = { ...unsubRow, state: 'attention', detail: `Not checked: the "${broadcast}" stream couldn't be read.` };
	else {
		const c = checkUnsubscribeHandling(broadcast, { ok: true, body: b.body });
		unsub =
			c.status === 'pass'
				? { ...unsubRow, state: 'ready', detail: c.summary }
				: { ...unsubRow, state: 'attention', detail: c.summary, fix: 'Use Switch to custom on Deliverability → Domain authentication.' };
	}

	return [token_, streams, webhook, unsub];
}

// ---------------------------------------------------------------------------------------
// Optional (#605 table)

function optional(id: string, label: string, set: boolean, setText: string, notSetText: string, href?: string): SetupCheck {
	return { id, group: 'optional', label, state: set ? 'ready' : 'optional', detail: set ? setText : notSetText, href };
}

export async function optionalChecks(db: D1Database, env: AnyEnv): Promise<SetupCheck[]> {
	const [timingRow, githubRow, zohoRow, zohoOrg, anthropicRow, luma, openaiRow] = await Promise.all([
		hasSecretRow(db, 'timing'),
		hasSecretRow(db, 'github'),
		hasSecretRow(db, ZOHO_PROVIDER),
		appState(db, ZOHO_ORG_KEY),
		hasSecretRow(db, ANTHROPIC_PROVIDER),
		appState(db, 'luma_webhook_secret'),
		hasSecretRow(db, OPENAI_SECRET_PROVIDER)
	]);
	const both = (a: string, b: string) => isSet(env, a) && isSet(env, b);
	return [
		optional('github_oauth', 'Sign in with GitHub', both('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'), 'GITHUB_CLIENT_ID and _SECRET are set.', 'Not set: password sign-in only.', '/settings/users'),
		optional('app_password', 'Break-glass server password', isSet(env, 'APP_PASSWORD'), 'APP_PASSWORD is set.', 'Not set.'),
		optional('setup_token', 'First-run setup token', isSet(env, 'SETUP_TOKEN'), 'SETUP_TOKEN is set; you can delete it now that an admin exists.', 'Not set.'),
		optional('mail_token_key', 'In-app secrets key', isSet(env, 'MAIL_TOKEN_KEY'), 'MAIL_TOKEN_KEY is set.', 'Not set: in-app tokens, Zoho and Gmail are off.', '/settings/integrations'),
		optional('timing', 'Timing', timingRow || isSet(env, 'TIMING_API_TOKEN'), timingRow ? 'Token set in the app.' : 'TIMING_API_TOKEN is set.', 'Not connected.', '/settings/integrations'),
		optional('github_token', 'GitHub repos', githubRow || isSet(env, 'GITHUB_TOKEN'), githubRow ? 'Token set in the app.' : 'GITHUB_TOKEN is set.', 'Not connected.', '/settings/integrations'),
		optional('zoho', 'Zoho Books', zohoRow && !!zohoOrg?.value, 'Connected.', zohoRow ? 'Connected, no organization picked.' : 'Not connected.', '/settings/integrations'),
		optional('google', 'Gmail sync', both('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'), 'GOOGLE_CLIENT_ID and _SECRET are set.', 'Not set.', '/settings/mail'),
		optional('anthropic', 'AI assistant', anthropicRow || isSet(env, 'ANTHROPIC_API_KEY'), anthropicRow ? 'Key set in the app.' : 'ANTHROPIC_API_KEY is set.', 'No key.', '/settings/assistant'),
		// #696: the optional second AI provider (OpenAI-compatible endpoint).
		optional('openai', 'AI: OpenAI-compatible provider', openaiRow || isSet(env, 'OPENAI_API_KEY'), openaiRow ? 'Key set in the app.' : 'OPENAI_API_KEY is set.', 'Not set: Claude only.', '/settings/assistant'),
		optional('postmark_account', 'Postmark account token', isSet(env, 'POSTMARK_ACCOUNT_TOKEN'), 'POSTMARK_ACCOUNT_TOKEN is set.', 'Not set: DKIM / Return-Path read from DNS only.', '/deliverability'),
		optional('inbound', 'Reply capture', both('INBOUND_KEY', 'POSTMARK_INBOUND_ADDRESS'), 'INBOUND_KEY and POSTMARK_INBOUND_ADDRESS are set.', 'Not set.', '/settings'),
		optional('luma', 'Luma registrants', !!luma?.value?.trim() || isSet(env, 'LUMA_WEBHOOK_SECRET'), 'Signing secret set.', 'Not set.', '/settings'),
		optional('ingest_key', 'Ingest key', isSet(env, 'INGEST_KEY'), 'INGEST_KEY is set.', 'Not set: webhook keys still work.', '/settings/webhooks'),
		optional('cf_api', 'Attach custom domain', isSet(env, 'CF_API_TOKEN') && both('CF_ACCOUNT_ID', 'WORKER_NAME'), 'CF_API_TOKEN, CF_ACCOUNT_ID and WORKER_NAME are set.', 'Not set: use the dashboard steps.', '/settings/domain'),
		optional('default_list', 'Default ingest list', isSet(env, 'DEFAULT_LIST_NAME'), 'DEFAULT_LIST_NAME is set.', 'Not set: ingest needs a list per request or key.', '/settings/webhooks'),
		optional('archive_routes', 'Newsletter archive routes', isSet(env, 'ARCHIVE_ROUTE_HOSTS'), 'ARCHIVE_ROUTE_HOSTS is set.', 'Not set.', '/settings/newsletter')
	];
}

// ---------------------------------------------------------------------------------------

export async function runSetupChecks(db: D1Database, env: AnyEnv, fetchFn: typeof fetch = fetch): Promise<SetupReport> {
	const [local, pm, opt] = await Promise.all([localRequiredChecks(db, env), postmarkChecks(env, fetchFn), optionalChecks(db, env)]);
	// The verified token row (and the streams row after it) replace the local "is it set" row.
	const verified = pm.filter((c) => c.group === 'required');
	const required = local.flatMap((c) => (c.id === 'postmark_token' ? verified : [c]));
	const checks = [...required, ...pm.filter((c) => c.group !== 'required'), ...opt];
	return { checks, attention: checks.filter((c) => c.state === 'attention').length };
}

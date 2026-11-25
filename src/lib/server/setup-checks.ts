// #609: Settings → Setup — what a working install needs, and what is still missing.
//
// Three groups: required (local reads only), Postmark (the active sending provider's own checks,
// #700 — for Postmark, its API with the server token) and optional (one row per optional integration from the #605 table). A row is
// `ready`, `attention` (needs fixing) or `optional` (optional and not set up). Secrets are
// only ever reported as set / not set: no value, prefix or length reaches a row.
//
// `localRequiredAttention` is the cheap, network-free part the dashboard uses for its admin
// notice, so the dashboard never calls Postmark.

import { isEmail } from '$lib/csv';
import { secretRow, ZOHO_ORG_KEY, ZOHO_PROVIDER } from './integrations/secrets';
import { ANTHROPIC_PROVIDER, OPENAI_SECRET_PROVIDER } from './ai/key';
import { mailSetup, postmarkCheckRows, resendCheckRows, webhookMatches } from './mail';
import { resolveMailCredentials } from './mail/config';
import { CLOCK_KEY, SENDS_SKIPPED_KEY, SKIP_KEY, TICK_SKIPPED_NO_PUBLIC_URL, TICK_SKIPPED_NO_SENDING } from './internal-tick';
import { sendingUnconfigured } from './db';
import { SEEN_BASE_URL_KEY } from './public-url';
import { FINISH_SETUP_FROM, FINISH_SETUP_SENDING } from '$lib/finish-setup';

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
	/** Rows that need attention (required and Postmark rows, plus a leftover SETUP_TOKEN). */
	attention: number;
};

/** A heartbeat tick older than this many minutes counts as stale (the cron runs every minute). */
export const TICK_STALE_MINUTES = 10;

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
		fix: 'Set it in the setup wizard (step 1) or Settings → General. Use an address on a domain verified in Postmark. POSTMARK_FROM in wrangler.jsonc works too. Until one is set, sends are refused with "Finish setup".'
	};
}

/** The last tick: when, how long ago, and which clock ran it (#729: `cron` = the app's own Cron
 *  Trigger, `http` = the CRON_KEY endpoint; null for ticks recorded before #729). The clock has its
 *  own key (CLOCK_KEY), so a long or cut-off `last_tick` summary never hides it. */
async function lastTick(db: D1Database): Promise<{ at: string; age: number; clock: 'cron' | 'http' | null } | null> {
	const row = await db
		.prepare(
			`SELECT t.updated_at, CAST((julianday('now') - julianday(t.updated_at)) * 1440 AS INTEGER) AS age, c.value AS clock
			 FROM app_state t LEFT JOIN app_state c ON c.key = ?
			 WHERE t.key = 'last_tick'`
		)
		.bind(CLOCK_KEY)
		.first<{ updated_at: string | null; age: number | null; clock: string | null }>();
	if (!row?.updated_at) return null;
	const clock = row.clock === 'cron' || row.clock === 'http' ? row.clock : null;
	return { at: row.updated_at, age: row.age ?? 0, clock };
}

/** #731: a new install that uses the built-in clock simply hasn't ticked yet. Said first, before
 *  any advice about `triggers.crons`, CRON_KEY or the heartbeat Worker. #732: Cloudflare can take
 *  up to 15 minutes to start a new schedule (measured: 8 minutes on a fresh account). */
export const FIRST_TICK_NOTE =
	'The built-in clock runs once a minute. On Cloudflare a new schedule can take up to 15 minutes to start after the first deploy.';

const CLOCK_TEXT = { cron: ' by the built-in clock', http: ' by the heartbeat endpoint' } as const;

export async function heartbeatCheck(db: D1Database): Promise<SetupCheck> {
	const base = { id: 'heartbeat', group: 'required' as const, label: 'Heartbeat (last tick)' };
	const tick = await lastTick(db);
	const fix =
		'Add `triggers.crons` to wrangler.jsonc (the built-in clock; `npm run build` adds the handler) and deploy, or deploy the heartbeat Worker (heartbeat/) with the same CRON_KEY as this Worker; see heartbeat/README.md.';
	if (!tick) return { ...base, state: 'attention', detail: 'The heartbeat has never ticked.', fix: `${FIRST_TICK_NOTE} If it still says this after that: ${fix}` };
	const detail = `Last tick ${tick.at} UTC (${tick.age} min ago)${tick.clock ? CLOCK_TEXT[tick.clock] : ''}.`;
	if (tick.age > TICK_STALE_MINUTES) return { ...base, state: 'attention', detail, fix };
	return { ...base, state: 'ready', detail };
}

/** #729: CRON_KEY only gates the HTTP tick endpoint (the heartbeat Worker, manual runs). With the
 *  built-in clock ticking it isn't needed, so "not set" is fine once that clock has ticked recently.
 *  /api/health still needs it (its only key). */
async function cronKeyCheck(db: D1Database, env: AnyEnv): Promise<SetupCheck> {
	const check = secretCheck(
		env,
		'CRON_KEY',
		'CRON_KEY',
		'Run `npx wrangler secret put CRON_KEY` here and on the heartbeat Worker, with the same value. Not needed when the built-in clock runs the tick (`triggers.crons` in wrangler.jsonc), except for /api/health.'
	);
	if (check.state === 'ready') return check;
	const tick = await lastTick(db);
	if (tick?.clock === 'cron' && tick.age <= TICK_STALE_MINUTES)
		return { ...check, state: 'ready', detail: 'Not set. Not needed: the built-in clock runs the tick (/api/health still needs it).', fix: undefined };
	if (!tick)
		return {
			...check,
			fix: `${FIRST_TICK_NOTE} After that this row turns ready by itself (only /api/health still needs CRON_KEY). If you use the heartbeat Worker instead, run \`npx wrangler secret put CRON_KEY\` here and on that Worker, with the same value.`
		};
	return check;
}

/** #729: the built-in clock ran nothing because the app has no public address (its links would
 *  point at the internal origin). #731: the origin recorded at first-admin creation (or chosen in
 *  the setup wizard, `public_base_url_seen`) counts as that address, so this row only shows while
 *  none of the three is set. */
async function publicUrlCheck(db: D1Database, env: AnyEnv): Promise<SetupCheck | null> {
	const skip = await appState(db, SKIP_KEY);
	if (skip?.value !== TICK_SKIPPED_NO_PUBLIC_URL) return null;
	if (isSet(env, 'PUBLIC_BASE_URL') || (await appState(db, 'custom_domain'))?.value?.trim() || (await appState(db, SEEN_BASE_URL_KEY))?.value?.trim()) return null;
	return {
		id: 'public_url',
		group: 'required',
		label: "App's public address",
		state: 'attention',
		detail: `The built-in clock skipped its tick at ${skip.updated_at ?? '?'} UTC: no public address is set, so unsubscribe and tracking links could not be built. Nothing was sent.`,
		fix: "Open the setup wizard's first step at the app's own address and choose “Use this address for links”, or set the address in Settings → Domain or PUBLIC_BASE_URL in wrangler.jsonc, then wait a minute.",
		href: '/settings/setup?wizard=address'
	};
}

/** #731: the last tick skipped every job that sends email because the provider resolution found no
 *  sending credentials (housekeeping still ran). Only listed while that is still true, decided the
 *  same provider-aware way as the tick (`providerFor`, through `mailSetup`). */
async function sendsSkippedCheck(db: D1Database, env: AnyEnv): Promise<SetupCheck | null> {
	const skip = await appState(db, SENDS_SKIPPED_KEY);
	if (skip?.value !== TICK_SKIPPED_NO_SENDING) return null;
	const { provider, creds } = await mailSetup(db, env);
	if (!sendingUnconfigured(provider, creds)) return null;
	return {
		id: 'tick_no_sending',
		group: 'required',
		label: 'Scheduled work',
		state: 'attention',
		detail: `The last tick (${skip.updated_at ?? '?'} UTC) sent nothing: no sending provider is connected yet. Scheduled campaigns stay scheduled and automation emails wait; housekeeping (backups, scoring, engagement, pruning) still runs.`,
		fix: 'Paste the token in Settings → Sending (or the setup wizard), then wait a minute.',
		href: '/settings/setup?wizard=sending'
	};
}

/** #731: automation emails held by a "Finish setup" hold right now (active passes whose last_error
 *  is one of the two messages). Counts only; a held pass fails after 24 hours (automations.ts). */
async function setupHoldsCheck(db: D1Database): Promise<SetupCheck | null> {
	const rows = await db
		.prepare(`SELECT last_error AS reason, COUNT(*) AS n FROM automation_enrollments WHERE status = 'active' AND last_error IN (?, ?) GROUP BY last_error`)
		.bind(FINISH_SETUP_FROM, FINISH_SETUP_SENDING)
		.all<{ reason: string; n: number }>();
	const count = (reason: string) => rows.results.find((r) => r.reason === reason)?.n ?? 0;
	const noFrom = count(FINISH_SETUP_FROM);
	const noSending = count(FINISH_SETUP_SENDING);
	if (!noFrom && !noSending) return null;
	const emails = (n: number) => `${n.toLocaleString('en-US')} automation email${n === 1 ? ' is' : 's are'} waiting`;
	const parts = [
		...(noSending ? [`${emails(noSending)}: no sending provider configured.`] : []),
		...(noFrom ? [`${emails(noFrom)}: no sender configured.`] : [])
	];
	return {
		id: 'automation_setup_holds',
		group: 'required',
		label: 'Automation emails',
		state: 'attention',
		detail: `${parts.join(' ')} A pass still waiting after 24 hours fails.`,
		fix: noSending
			? 'Paste the sending provider’s token in Settings → Sending (or the setup wizard); the waiting emails go out within about 10 minutes.'
			: 'Set the Default From address in Settings → General; the waiting emails go out within about 10 minutes.',
		href: noSending ? '/settings/setup?wizard=sending' : '/settings'
	};
}

/** #700: the sending provider's credential — Settings → Sending first, then the Worker secret.
 *  Same row id as before (`postmark_token`) while Postmark is the only adapter. A stored token
 *  that can't be read is a problem, never "set": sending is off then (no env fallback). */
async function providerTokenCheck(db: D1Database, env: AnyEnv): Promise<SetupCheck> {
	const creds = await resolveMailCredentials(db, env);
	if (creds.provider === 'resend') {
		// #702: Resend's API key, same rules (Settings first, unreadable = a problem).
		const rbase = { id: 'resend_api_key', group: 'required' as const, label: 'Resend API key', href: '/settings/sending' };
		const rfrom = creds.resend.apiKeyFrom;
		if (rfrom === 'none') return { ...rbase, state: 'attention', detail: 'Not set.', fix: 'Paste it in Settings → Sending, or run `npx wrangler secret put RESEND_API_KEY`.' };
		if (rfrom === 'unreadable') return { ...rbase, state: 'attention', detail: creds.resend.apiKeyError ?? 'Can’t be read.', fix: UNREADABLE_RESEND_FIX };
		return { ...rbase, state: 'ready', detail: rfrom === 'app' ? 'Set in Settings → Sending.' : 'Set.' };
	}
	const from = creds.postmark.tokenFrom;
	const base = { id: 'postmark_token', group: 'required' as const, label: 'Postmark server token', href: '/settings/sending' };
	if (from === 'none')
		return { ...base, state: 'attention', detail: 'Not set.', fix: 'Paste it in the setup wizard (step 2) or Settings → Sending. Or run `npx wrangler secret put POSTMARK_TOKEN`.' };
	if (from === 'unreadable') return { ...base, state: 'attention', detail: creds.postmark.tokenError ?? 'Can’t be read.', fix: UNREADABLE_TOKEN_FIX };
	return { ...base, state: 'ready', detail: from === 'app' ? 'Set in Settings → Sending.' : 'Set.' };
}

const UNREADABLE_RESEND_FIX =
	'Set MAIL_TOKEN_KEY back to the key the Resend key was saved with, or save the key again in Settings → Sending (Clear there falls back to RESEND_API_KEY).';

const UNREADABLE_TOKEN_FIX =
	'Set MAIL_TOKEN_KEY back to the key the token was saved with, or save the token again in Settings → Sending (Clear token there falls back to POSTMARK_TOKEN).';

/** The network-free required checks. */
export async function localRequiredChecks(db: D1Database, env: AnyEnv): Promise<SetupCheck[]> {
	const [migrations, from, heartbeat, token, cronKey, publicUrl, sendsSkipped, setupHolds] = await Promise.all([
		migrationsCheck(db),
		defaultFromCheck(db, env),
		heartbeatCheck(db),
		providerTokenCheck(db, env),
		cronKeyCheck(db, env),
		publicUrlCheck(db, env),
		sendsSkippedCheck(db, env),
		setupHoldsCheck(db)
	]);
	return [
		migrations,
		bindingCheck(env),
		secretCheck(env, 'SESSION_SECRET', 'SESSION_SECRET', 'Run `npx wrangler secret put SESSION_SECRET` with a long random value.'),
		token,
		from,
		cronKey,
		heartbeat,
		...(publicUrl ? [publicUrl] : []),
		...(sendsSkipped ? [sendsSkipped] : []),
		...(setupHolds ? [setupHolds] : [])
	];
}

/** Count of required checks needing attention — the dashboard notice. No network calls. */
export async function localRequiredAttention(db: D1Database, env: AnyEnv): Promise<number> {
	return (await localRequiredChecks(db, env)).filter((c) => c.state === 'attention').length;
}

// ---------------------------------------------------------------------------------------
// Sending provider (#700): the active provider answers its own checks. For Postmark these are
// the four #609 rows (token, streams, webhook, unsubscribe handling), now in mail/postmark.ts.

/** True when the Postmark webhook URL is this install's `/api/webhook` with our key. */
export { webhookMatches };

/** The Postmark rows for an env alone (no Settings → Sending values). */
export async function postmarkChecks(env: AnyEnv, fetchFn: typeof fetch = fetch): Promise<SetupCheck[]> {
	return postmarkCheckRows(
		{ token: str(env, 'POSTMARK_TOKEN'), broadcast: str(env, 'POSTMARK_STREAM'), transactional: str(env, 'POSTMARK_STREAM_TX'), webhookKey: str(env, 'WEBHOOK_KEY') },
		fetchFn
	);
}

/** The active provider's rows, credentials from Settings → Sending first, then the env. */
export async function providerChecks(db: D1Database, env: AnyEnv, fetchFn: typeof fetch = fetch): Promise<SetupCheck[]> {
	const { provider, creds } = await mailSetup(db, env);
	if (provider) return (await provider.check(fetchFn)).rows;
	if (creds.provider === 'resend') {
		// #702: Resend's own "not set" rows; an unreadable saved key says so.
		const rows = await resendCheckRows({ apiKey: '', webhookSecret: creds.resend.webhookSecret }, fetchFn);
		const bad = creds.resend.apiKeyError;
		return bad ? rows.map((r) => (r.id === 'resend_api_key' ? { ...r, detail: bad, fix: UNREADABLE_RESEND_FIX } : r)) : rows;
	}
	// Not configured: the provider's own "not set" rows.
	const rows = await postmarkCheckRows({ token: '', broadcast: creds.postmark.stream, transactional: creds.postmark.txStream, webhookKey: creds.postmark.webhookKey }, fetchFn);
	const unreadable = creds.postmark.tokenError;
	if (!unreadable) return rows;
	// A stored token that can't be read: say so instead of "not set".
	return rows.map((r) =>
		r.id === 'postmark_token'
			? { ...r, href: '/settings/sending', detail: unreadable, fix: UNREADABLE_TOKEN_FIX }
			: r.state === 'attention' && r.detail.startsWith('Not checked:')
				? { ...r, detail: 'Not checked: the saved sending token can’t be read.' }
				: r
	);
}

// ---------------------------------------------------------------------------------------
// Optional (#605 table)

function optional(id: string, label: string, set: boolean, setText: string, notSetText: string, href?: string): SetupCheck {
	return { id, group: 'optional', label, state: set ? 'ready' : 'optional', detail: set ? setText : notSetText, href };
}

/**
 * #747: Settings → Setup is only reachable signed in, so the first admin exists and `/setup` is
 * gone: SETUP_TOKEN does nothing any more. Unset is `ready` (nothing to do); still set is
 * `attention`, with the note that it can be deleted.
 */
export function setupTokenCheck(env: AnyEnv): SetupCheck {
	if (!isSet(env, 'SETUP_TOKEN')) {
		return { id: 'setup_token', group: 'optional', label: 'First-run setup token', state: 'ready', detail: 'Not set. The first admin exists, so it isn’t needed.' };
	}
	return {
		id: 'setup_token',
		group: 'optional',
		label: 'First-run setup token',
		state: 'attention',
		detail: 'SETUP_TOKEN is still set. The first admin exists, so it’s no longer needed and can be deleted.',
		fix: 'Run `npx wrangler secret delete SETUP_TOKEN`, or delete it in the Cloudflare dashboard (Workers & Pages, this Worker, Settings).'
	};
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
		setupTokenCheck(env),
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
	const [local, pm, opt] = await Promise.all([localRequiredChecks(db, env), providerChecks(db, env, fetchFn), optionalChecks(db, env)]);
	// The verified token row (and the streams row after it) replace the local "is it set" row.
	const verified = pm.filter((c) => c.group === 'required');
	const required = local.flatMap((c) => (c.id === 'postmark_token' || c.id === 'resend_api_key' ? verified : [c]));
	const checks = [...required, ...pm.filter((c) => c.group !== 'required'), ...opt];
	return { checks, attention: checks.filter((c) => c.state === 'attention').length };
}

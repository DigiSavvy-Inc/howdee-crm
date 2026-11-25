// #700: Settings → Sending storage and the credential resolver. Settings win over the Worker's
// environment (docs/sending-providers.md → Environment variables). The Postmark server token is
// sealed with MAIL_TOKEN_KEY in `integration_secrets` (provider `mail_postmark`), like the other
// integration secrets; the provider choice and stream names are plain JSON in
// `app_state.mail_settings`. Every change is appended to `app_state.mail_settings_events`
// (who, when, what — never a value).
//
// A token row that is stored but can't be opened (MAIL_TOKEN_KEY missing, invalid or rotated)
// fails closed: no env fallback, `tokenFrom: 'unreadable'` and `tokenError` say why, and every
// send fails with that message. Only "nothing stored" falls back to POSTMARK_TOKEN.
//
// No adapter imports here: the resolved credentials are plain data, so light modules can read
// them without reaching the sending code.

import { isValidKey, open } from '../crypto-box';
import { deleteSecret, secretRow, storeSecret, type SecretRow } from '../integrations/secrets';
import { DEFAULT_MAIL_PROVIDER, isMailProviderId, isTrackingMode, mailProviderAvailable, type MailProviderId, type TrackingMode } from './provider';

export const MAIL_SETTINGS_KEY = 'mail_settings';
export const MAIL_SETTINGS_EVENTS_KEY = 'mail_settings_events';
/** `integration_secrets.provider` of the Postmark server token set in Settings → Sending. */
export const POSTMARK_SECRET = 'mail_postmark';
const EVENTS_MAX = 100;
const STREAM_RE = /^[A-Za-z0-9_-]{1,100}$/;

export type MailSettings = {
	provider?: MailProviderId;
	postmark?: { stream?: string; txStream?: string };
	/** #701: who tracks opens and clicks (unset = MAIL_TRACKING, else the provider). */
	tracking?: TrackingMode;
};

/** `unreadable`: a token is stored in Settings → Sending but won't open — never replaced by the env. */
export type SecretSource = 'app' | 'env' | 'none' | 'unreadable';

/** What a send, the setup check and Settings → Sending say about an unreadable stored token. */
export const UNREADABLE_TOKEN_ERROR = "The sending token saved in Settings → Sending can't be read. Check MAIL_TOKEN_KEY, or save the token again.";

export type MailCredentials = {
	provider: MailProviderId;
	/** Where the provider choice came from. */
	providerFrom: 'settings' | 'env' | 'default';
	/** #701: the install's tracking choice. A provider that can't track (SMTP) always uses the
	 *  CRM whatever this says (`providerFor`). */
	tracking: TrackingMode;
	trackingFrom: 'settings' | 'env' | 'default';
	postmark: {
		token: string;
		tokenFrom: SecretSource;
		/** Set (and `token` empty) when the stored token can't be read: sends fail with this. */
		tokenError: string | null;
		stream: string;
		txStream: string;
		webhookKey: string;
		accountToken: string;
	};
};

/** The Worker env, or any env-shaped object (tests, callers' own env types). */
type AnyEnv = unknown;

function str(env: AnyEnv, name: string): string {
	const v = env && typeof env === 'object' ? (env as Record<string, unknown>)[name] : undefined;
	return typeof v === 'string' ? v.trim() : '';
}

export function normalizeMailSettings(raw: unknown): MailSettings {
	const out: MailSettings = {};
	if (!raw || typeof raw !== 'object') return out;
	const r = raw as Record<string, unknown>;
	if (isMailProviderId(r.provider)) out.provider = r.provider;
	const pm = r.postmark && typeof r.postmark === 'object' ? (r.postmark as Record<string, unknown>) : null;
	if (pm) {
		const p: NonNullable<MailSettings['postmark']> = {};
		if (typeof pm.stream === 'string' && STREAM_RE.test(pm.stream.trim())) p.stream = pm.stream.trim();
		if (typeof pm.txStream === 'string' && STREAM_RE.test(pm.txStream.trim())) p.txStream = pm.txStream.trim();
		out.postmark = p;
	}
	if (isTrackingMode(r.tracking)) out.tracking = r.tracking;
	return out;
}

export async function readMailSettings(db: D1Database | null | undefined): Promise<MailSettings> {
	if (!db) return {};
	try {
		const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(MAIL_SETTINGS_KEY).first<{ value: string | null }>();
		return row?.value ? normalizeMailSettings(JSON.parse(row.value)) : {};
	} catch {
		return {};
	}
}

async function writeMailSettings(db: D1Database, s: MailSettings): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(MAIL_SETTINGS_KEY, JSON.stringify(s))
		.run();
}

/** The active provider: Settings, else MAIL_PROVIDER, else Postmark. A provider whose adapter
 *  isn't in this build is never active. */
export function activeProviderId(settings: MailSettings, env: AnyEnv): { id: MailProviderId; from: MailCredentials['providerFrom'] } {
	if (settings.provider && mailProviderAvailable(settings.provider)) return { id: settings.provider, from: 'settings' };
	const fromEnv = str(env, 'MAIL_PROVIDER');
	if (isMailProviderId(fromEnv) && mailProviderAvailable(fromEnv)) return { id: fromEnv, from: 'env' };
	return { id: DEFAULT_MAIL_PROVIDER, from: 'default' };
}

type StoredSecret = { state: 'none' } | { state: 'ok'; value: string; row: SecretRow } | { state: 'unreadable'; row: SecretRow };

/** A secret saved in Settings → Sending: nothing stored, its value, or stored but unreadable.
 *  A failed row read (no table yet) counts as nothing stored. Never throws, never logs a value. */
async function readStoredSecret(db: D1Database, env: AnyEnv, provider: string): Promise<StoredSecret> {
	let row: SecretRow | null;
	try {
		row = await secretRow(db, provider);
	} catch {
		return { state: 'none' };
	}
	if (!row) return { state: 'none' };
	const key = str(env, 'MAIL_TOKEN_KEY') || undefined;
	if (!isValidKey(key)) return { state: 'unreadable', row };
	try {
		const value = (await open(key, row.blob)).trim();
		return value ? { state: 'ok', value, row } : { state: 'unreadable', row };
	} catch {
		return { state: 'unreadable', row };
	}
}

/** Every sending credential, Settings first, then the Worker's environment. Never throws. */
export async function resolveMailCredentials(db: D1Database | null | undefined, env: AnyEnv): Promise<MailCredentials> {
	const settings = await readMailSettings(db);
	const active = activeProviderId(settings, env);
	const stored: StoredSecret = db ? await readStoredSecret(db, env, POSTMARK_SECRET) : { state: 'none' };
	if (stored.state === 'unreadable') {
		console.error('mail: the Postmark token saved in Settings → Sending could not be read (MAIL_TOKEN_KEY missing, invalid or changed); sending is off until it is fixed');
	}
	const envToken = str(env, 'POSTMARK_TOKEN');
	const token = stored.state === 'ok' ? stored.value : stored.state === 'unreadable' ? '' : envToken;
	const envTracking = str(env, 'MAIL_TRACKING').toLowerCase();
	const tracking: { mode: TrackingMode; from: MailCredentials['trackingFrom'] } = settings.tracking
		? { mode: settings.tracking, from: 'settings' }
		: isTrackingMode(envTracking)
			? { mode: envTracking, from: 'env' }
			: { mode: 'provider', from: 'default' };
	return {
		provider: active.id,
		providerFrom: active.from,
		tracking: tracking.mode,
		trackingFrom: tracking.from,
		postmark: {
			token,
			tokenFrom: stored.state === 'ok' ? 'app' : stored.state === 'unreadable' ? 'unreadable' : envToken ? 'env' : 'none',
			tokenError: stored.state === 'unreadable' ? UNREADABLE_TOKEN_ERROR : null,
			// #731: both names have a stand-in, so no send path needs the vars.
			stream: settings.postmark?.stream || str(env, 'POSTMARK_STREAM') || 'broadcast',
			txStream: settings.postmark?.txStream || str(env, 'POSTMARK_STREAM_TX') || 'outbound',
			webhookKey: str(env, 'WEBHOOK_KEY'),
			accountToken: str(env, 'POSTMARK_ACCOUNT_TOKEN')
		}
	};
}

/** The legacy credential bundle (`{ token, stream, txStream }`) for code that still threads one. */
export async function resolvePostmarkCreds(db: D1Database | null | undefined, env: AnyEnv): Promise<{ token: string | undefined; stream: string | undefined; txStream: string | undefined }> {
	const c = await resolveMailCredentials(db, env);
	return { token: c.postmark.token || undefined, stream: c.postmark.stream || undefined, txStream: c.postmark.txStream || undefined };
}

// ---------------------------------------------------------------------------------------
// Writes (Settings → Sending, admin-only — the route checks the role)

export type MailSettingsEvent = { at: string; user_id: number | null; login: string | null; change: string };
type By = { id: number; github_login?: string | null } | null;

export async function logMailSettingsEvent(db: D1Database, change: string, by: By, now = new Date()): Promise<void> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(MAIL_SETTINGS_EVENTS_KEY).first<{ value: string | null }>();
	let list: MailSettingsEvent[] = [];
	try {
		const parsed = row?.value ? JSON.parse(row.value) : [];
		if (Array.isArray(parsed)) list = parsed;
	} catch {
		list = [];
	}
	list.push({ at: now.toISOString(), user_id: by?.id ?? null, login: by?.github_login ?? null, change });
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(MAIL_SETTINGS_EVENTS_KEY, JSON.stringify(list.slice(-EVENTS_MAX)))
		.run();
}

export async function mailSettingsEvents(db: D1Database, limit = 10): Promise<MailSettingsEvent[]> {
	try {
		const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(MAIL_SETTINGS_EVENTS_KEY).first<{ value: string | null }>();
		const list = row?.value ? (JSON.parse(row.value) as MailSettingsEvent[]) : [];
		return Array.isArray(list) ? list.slice(-limit).reverse() : [];
	} catch {
		return [];
	}
}

/** True while a broadcast is going out — the provider can't be switched then. */
export async function campaignSending(db: D1Database): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS x FROM campaigns WHERE status = 'sending' LIMIT 1`).first<{ x: number }>();
	return !!row;
}

export const SWITCH_WHILE_SENDING = "A campaign is sending. Wait for it to finish, then switch.";

export async function setActiveProvider(db: D1Database, id: MailProviderId, by: By): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
	if (!mailProviderAvailable(id)) return { ok: false, error: 'That provider isn’t available in this version yet.' };
	const current = await readMailSettings(db);
	if (current.provider === id) return { ok: true, changed: false };
	if (current.provider && (await campaignSending(db))) return { ok: false, error: SWITCH_WHILE_SENDING };
	await writeMailSettings(db, { ...current, provider: id });
	await logMailSettingsEvent(db, `provider set to ${id}`, by);
	return { ok: true, changed: true };
}

/** Postmark stream names; blank = fall back to POSTMARK_STREAM / POSTMARK_STREAM_TX. */
export async function setPostmarkStreams(
	db: D1Database,
	input: { stream: string; txStream: string },
	by: By
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
	const stream = input.stream.trim();
	const txStream = input.txStream.trim();
	for (const v of [stream, txStream]) if (v && !STREAM_RE.test(v)) return { ok: false, error: 'Stream names are letters, digits, - and _ only.' };
	if (stream && txStream && stream === txStream) return { ok: false, error: 'Use different streams for broadcast and transactional mail.' };
	const current = await readMailSettings(db);
	const next = { ...(stream ? { stream } : {}), ...(txStream ? { txStream } : {}) };
	if (JSON.stringify(current.postmark ?? {}) === JSON.stringify(next)) return { ok: true, changed: false };
	await writeMailSettings(db, { ...current, postmark: next });
	await logMailSettingsEvent(db, 'Postmark stream names changed', by);
	return { ok: true, changed: true };
}

/** #701: Settings → Sending → Open and click tracking. Only affects mail sent afterwards. */
export async function setTrackingMode(db: D1Database, mode: TrackingMode, by: By): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
	if (!isTrackingMode(mode)) return { ok: false, error: 'Choose by the provider or by the CRM.' };
	const current = await readMailSettings(db);
	if (current.tracking === mode) return { ok: true, changed: false };
	await writeMailSettings(db, { ...current, tracking: mode });
	await logMailSettingsEvent(db, `open and click tracking set to ${mode === 'crm' ? 'the CRM' : 'the provider'}`, by);
	return { ok: true, changed: true };
}

export function cleanPostmarkToken(raw: string): { ok: true; token: string } | { ok: false; error: string } {
	const token = raw.trim();
	if (!token) return { ok: false, error: 'Paste the Postmark Server API token.' };
	if (/\s/.test(token) || token.length < 8 || token.length > 200) return { ok: false, error: 'That doesn’t look like a Postmark Server API token.' };
	return { ok: true, token };
}

export function mailKeyReady(env: AnyEnv): boolean {
	return isValidKey(str(env, 'MAIL_TOKEN_KEY') || undefined);
}

/** Store the Postmark server token, sealed. The audit rows never carry any part of it. */
export async function setPostmarkToken(db: D1Database, env: AnyEnv, token: string, by: By): Promise<void> {
	await storeSecret(db, str(env, 'MAIL_TOKEN_KEY') || undefined, POSTMARK_SECRET, token, by?.id ?? null, { last4: '' });
	await logMailSettingsEvent(db, 'Postmark server token set', by);
}

export async function removePostmarkToken(db: D1Database, by: By): Promise<boolean> {
	const removed = await deleteSecret(db, POSTMARK_SECRET);
	if (removed) await logMailSettingsEvent(db, 'Postmark server token cleared', by);
	return removed;
}

/** Set / not set / stored but unreadable, and since when — never the value. */
export async function postmarkTokenInfo(
	db: D1Database,
	env: AnyEnv
): Promise<{ source: SecretSource; setAt: string | null; setBy: string | null; error: string | null }> {
	const stored = await readStoredSecret(db, env, POSTMARK_SECRET);
	if (stored.state === 'ok') return { source: 'app', setAt: stored.row.set_at, setBy: stored.row.set_by_login, error: null };
	if (stored.state === 'unreadable') return { source: 'unreadable', setAt: stored.row.set_at, setBy: stored.row.set_by_login, error: UNREADABLE_TOKEN_ERROR };
	return { source: str(env, 'POSTMARK_TOKEN') ? 'env' : 'none', setAt: null, setBy: null, error: null };
}

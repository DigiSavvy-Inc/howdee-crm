// Settings → Assistant (#287): stored as JSON in app_state `ai_assistant_config`. Invalid or
// missing values fall back to the defaults below. The key is the in-app key or the Worker
// secret ANTHROPIC_API_KEY (`resolveAnthropicKey`, ./key.ts, #297) — never shown or logged.
// #696: `openai` = the install's OpenAI-compatible endpoint (base URL, label, models; its key
// is OPENAI_SECRET_PROVIDER / OPENAI_API_KEY, ./key.ts) and `featureModels` = a default model
// per AI feature. Configs saved before #696 read as no other provider and no overrides, so an
// Anthropic-only install behaves exactly as before.

import { DEFAULT_EFFORT, DEFAULT_MODEL, MODELS, PROVIDER_LABELS, allModels, isEffort, modelInfo, providerOf, type Effort, type ModelInfo } from '$lib/ai-models';
import { AI_FEATURES, OPENAI_DEFAULTS, modelFitsFeature, normalizeOpenAiConfig, openAiModelInfos, type AiFeature, type OpenAiConfig } from '$lib/ai-providers';
import { resolveAnthropicKey, resolveProviderKey } from './key';

export const AI_CONFIG_KEY = 'ai_assistant_config';

/** Who may use the assistant (#292): nobody, the users in `allowedUserIds`, or everyone signed in. */
export type AssistantAccess = 'off' | 'selected' | 'everyone';
export const ASSISTANT_ACCESS: AssistantAccess[] = ['off', 'selected', 'everyone'];

/** #327: who the assistant may write code & snippets for — nobody, admins, or everyone with access. */
export type CodePermission = 'off' | 'admins' | 'everyone';
export const CODE_PERMISSIONS: CodePermission[] = ['off', 'admins', 'everyone'];

export type AssistantConfig = {
	access: AssistantAccess;
	allowedUserIds: number[]; // used when access = 'selected'; kept when switching away
	allowedModels: string[];
	defaultModel: string;
	defaultEffort: Effort;
	monthlyCapUsd: number; // whole app, per UTC month
	dailyUserCapUsd: number; // per user, per UTC day
	retentionDays: number; // stored only in Phase 1 (pruning is Phase 4)
	/** #322 addendum: Settings → Assistant → Permissions. Off (default, and for configs saved
	 *  before the key existed) = delete_contacts is not offered and is refused if called. */
	allowDelete: boolean;
	/** #327: Permissions → "Code & snippets". Off (default, and for older configs) = the prompt
	 *  says code isn't enabled; checked against the signed-in user's role on every request. */
	allowCode: CodePermission;
	/** #387: "Draft reply" in the Conversations Reply box. On (default, and for configs saved
	 *  before the key existed); only an explicit false from an admin turns it off. */
	draftReply: boolean;
	/** #679: "Ask AI" in the editors' selection bubble. On (default, and for configs saved
	 *  before the key existed); only an explicit false from an admin turns it off. */
	editorAsk: boolean;
	/** #696: the OpenAI-compatible provider (no models = not used). */
	openai: OpenAiConfig;
	/** #696: a default model per feature; missing = the default model (resend subjects: Haiku). */
	featureModels: Partial<Record<AiFeature, string>>;
};

export const ASSISTANT_DEFAULTS: AssistantConfig = {
	access: 'off',
	allowedUserIds: [],
	allowedModels: MODELS.map((m) => m.id),
	defaultModel: DEFAULT_MODEL,
	defaultEffort: DEFAULT_EFFORT,
	monthlyCapUsd: 50,
	dailyUserCapUsd: 10,
	retentionDays: 180,
	allowDelete: false,
	allowCode: 'off',
	draftReply: true,
	editorAsk: true,
	openai: OPENAI_DEFAULTS,
	featureModels: {}
};

export const CAP_MAX_USD = 10_000;
export const RETENTION_MAX_DAYS = 3650;

function money(v: unknown, dflt: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n) || n < 0) return dflt;
	return Math.min(CAP_MAX_USD, Math.round(n * 100) / 100);
}

function userIds(v: unknown): number[] {
	if (!Array.isArray(v)) return [];
	const ids = v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
	return [...new Set(ids)].sort((a, b) => a - b);
}

/** `access` when valid; else the pre-#292 `enabled` flag (true → everyone, anything else → off). */
function accessOf(r: Record<string, unknown>): AssistantAccess {
	if (typeof r.access === 'string' && (ASSISTANT_ACCESS as string[]).includes(r.access)) return r.access as AssistantAccess;
	return r.enabled === true ? 'everyone' : 'off';
}

/** Normalise any input (stored JSON or a form) into a valid config. `enabled` is read, never written. */
export function normalizeConfig(raw: unknown): AssistantConfig {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const d = ASSISTANT_DEFAULTS;
	const openai = normalizeOpenAiConfig(r.openai);
	const extra = openAiModelInfos(openai);
	const catalog = allModels(extra);
	const allowed = Array.isArray(r.allowedModels)
		? catalog.map((m) => m.id).filter((id) => (r.allowedModels as unknown[]).includes(id))
		: d.allowedModels;
	const allowedModels = allowed.length ? allowed : [d.defaultModel];
	let defaultModel = typeof r.defaultModel === 'string' && modelInfo(r.defaultModel, extra) ? (modelInfo(r.defaultModel, extra) as ModelInfo).id : d.defaultModel;
	if (!allowedModels.includes(defaultModel)) defaultModel = allowedModels[0];
	const featureModels: Partial<Record<AiFeature, string>> = {};
	const fm = r.featureModels && typeof r.featureModels === 'object' ? (r.featureModels as Record<string, unknown>) : {};
	for (const f of AI_FEATURES) {
		const m = typeof fm[f] === 'string' ? modelInfo(fm[f] as string, extra) : null;
		if (m && allowedModels.includes(m.id) && modelFitsFeature(m, f)) featureModels[f] = m.id;
	}
	const days = Math.floor(Number(r.retentionDays));
	return {
		access: accessOf(r),
		allowedUserIds: userIds(r.allowedUserIds),
		allowedModels,
		defaultModel,
		defaultEffort: isEffort(r.defaultEffort) ? r.defaultEffort : d.defaultEffort,
		monthlyCapUsd: money(r.monthlyCapUsd, d.monthlyCapUsd),
		dailyUserCapUsd: money(r.dailyUserCapUsd, d.dailyUserCapUsd),
		retentionDays: Number.isFinite(days) && days >= 1 ? Math.min(RETENTION_MAX_DAYS, days) : d.retentionDays,
		allowDelete: r.allowDelete === true, // only an explicit true turns it on; missing (old configs) = off
		allowCode: typeof r.allowCode === 'string' && (CODE_PERMISSIONS as string[]).includes(r.allowCode) ? (r.allowCode as CodePermission) : 'off',
		draftReply: r.draftReply !== false, // missing (older configs) = on; only an explicit false turns it off
		editorAsk: r.editorAsk !== false, // #679: same rule
		openai,
		featureModels
	};
}

export async function getAssistantConfig(db: D1Database): Promise<AssistantConfig> {
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(AI_CONFIG_KEY).first<{ value: string | null }>();
		return normalizeConfig(row?.value ? JSON.parse(row.value) : null);
	} catch {
		return { ...ASSISTANT_DEFAULTS };
	}
}

/** Save after normalising (unknown models / effort / bad numbers fall back to defaults). */
export async function saveAssistantConfig(db: D1Database, cfg: { [K in keyof AssistantConfig | 'enabled']?: unknown }): Promise<AssistantConfig> {
	const clean = normalizeConfig(cfg);
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(AI_CONFIG_KEY, JSON.stringify(clean))
		.run();
	return clean;
}

// ---- permissions (#322 addendum) ----

/** The refusal shown when delete_contacts is called or approved while the setting is off. */
export const DELETE_OFF_MESSAGE = 'Deleting contacts is turned off in Settings → Assistant → Permissions.';

/** app_state key holding the Permissions audit trail: a JSON array of
 *  { at, user_id, login, setting, value }, newest last, capped at SETTING_EVENTS_MAX.
 *  The dashboard activity feed reads it (type `assistant_setting`, ../activity.ts), the same
 *  pattern as `domain_auth_events` (#304) — no table, no migration. */
export const SETTING_EVENTS_KEY = 'ai_setting_events';
const SETTING_EVENTS_MAX = 100;

export type AssistantSettingEvent =
	| { at: string; user_id: number; login: string; setting: 'allowDelete'; value: boolean }
	| { at: string; user_id: number; login: string; setting: 'allowCode'; value: CodePermission };

/** Append one audit row (newest last, capped) to the Permissions trail. */
async function logSettingEvent(
	db: D1Database,
	change: { setting: 'allowDelete'; value: boolean } | { setting: 'allowCode'; value: CodePermission },
	by: { id: number; github_login: string },
	now: Date
): Promise<void> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(SETTING_EVENTS_KEY).first<{ value: string | null }>();
	let events: unknown[] = [];
	try {
		const parsed = row?.value ? JSON.parse(row.value) : [];
		if (Array.isArray(parsed)) events = parsed;
	} catch {
		/* a broken list starts over */
	}
	const event = {
		at: now.toISOString().slice(0, 19).replace('T', ' '),
		user_id: by.id,
		login: by.github_login,
		...change
	} as AssistantSettingEvent;
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(SETTING_EVENTS_KEY, JSON.stringify([...events, event].slice(-SETTING_EVENTS_MAX)))
		.run();
}

/**
 * Turn "Allow the assistant to delete contacts" on or off, keeping the rest of the config.
 * A real change appends an audit row naming who changed it; saving the same value writes nothing.
 */
export async function setAllowDelete(
	db: D1Database,
	allow: boolean,
	by: { id: number; github_login: string },
	now = new Date()
): Promise<{ config: AssistantConfig; changed: boolean }> {
	const current = await getAssistantConfig(db);
	if (current.allowDelete === allow) return { config: current, changed: false };
	const config = await saveAssistantConfig(db, { ...current, allowDelete: allow });
	await logSettingEvent(db, { setting: 'allowDelete', value: allow }, by, now);
	return { config, changed: true };
}

/** #327: set "Code & snippets" (off / admins / everyone). Same audit rule as setAllowDelete. */
export async function setAllowCode(
	db: D1Database,
	value: CodePermission,
	by: { id: number; github_login: string },
	now = new Date()
): Promise<{ config: AssistantConfig; changed: boolean }> {
	const current = await getAssistantConfig(db);
	if (current.allowCode === value) return { config: current, changed: false };
	const config = await saveAssistantConfig(db, { ...current, allowCode: value });
	await logSettingEvent(db, { setting: 'allowCode', value }, by, now);
	return { config, changed: true };
}

/** #387: whether this user gets the Conversations "Draft reply" button (setting on + assistant access). */
export function draftReplyVisible(cfg: AssistantConfig, user: AccessUser): boolean {
	return cfg.draftReply && userHasAccess(cfg, user);
}

/** #679: whether this user gets "Ask AI" in the editors (setting on + assistant access). */
export function editorAskVisible(cfg: AssistantConfig, user: AccessUser): boolean {
	return cfg.editorAsk && userHasAccess(cfg, user);
}

/** #327: whether the assistant may write code for this user (role read server-side per request). */
export function codeAllowedFor(cfg: Pick<AssistantConfig, 'allowCode'>, user: { role?: string } | null | undefined): boolean {
	if (!user) return false;
	if (cfg.allowCode === 'everyone') return true;
	if (cfg.allowCode === 'admins') return user.role === 'admin';
	return false;
}

// ---- models per feature (#696) ----

/** The install's models of other providers (pass to `modelInfo(id, …)`). */
export function configModels(cfg: Pick<AssistantConfig, 'openai'>): ModelInfo[] {
	return openAiModelInfos(cfg.openai ?? OPENAI_DEFAULTS); // a hand-built config may lack it
}

/** A model by id, including the install's other providers. */
export function configModelInfo(cfg: Pick<AssistantConfig, 'openai'>, id: string | null | undefined): ModelInfo | null {
	return modelInfo(id, configModels(cfg));
}

/**
 * The model a feature uses: its Settings override, else `fallback` (default: the default
 * model), else the first allowed model that fits. Only allowed models; tool features only
 * get models with tool support. Null when none fits.
 */
export function featureModel(cfg: AssistantConfig, feature: AiFeature, fallback?: string | null): ModelInfo | null {
	const extra = configModels(cfg);
	const pick = (id: string | null | undefined): ModelInfo | null => {
		const m = modelInfo(id, extra);
		return m && cfg.allowedModels.includes(m.id) && modelFitsFeature(m, feature) ? m : null;
	};
	return pick(cfg.featureModels?.[feature]) ?? pick(fallback ?? cfg.defaultModel) ?? cfg.allowedModels.map(pick).find((m) => m !== null) ?? null;
}

/** '' when the model's provider has a key, else the message to show (#696). */
export async function modelKeyProblem(db: D1Database | null | undefined, platformEnv: unknown, model: Pick<ModelInfo, 'provider'>): Promise<string> {
	const id = providerOf(model);
	if (await resolveProviderKey(db, platformEnv, id)) return '';
	return id === 'anthropic'
		? "Assistant isn't set up. An admin needs to paste a key in Settings → Assistant or set the ANTHROPIC_API_KEY secret."
		: `No key is set for ${PROVIDER_LABELS[id]}. An admin needs to paste one in Settings → Assistant or set the OPENAI_API_KEY secret.`;
}

export type AssistantAvailability =
	| { available: true }
	| { available: false; reason: 'no_key' | 'disabled' | 'not_allowed'; message: string };

type AccessUser = { id: number; role?: string } | null | undefined;

/** Whether this user is let in by the Access setting (ignores the key). The break-glass
 *  APP_PASSWORD sign-in is a session for `firstActiveAdmin()` — a real users row — so it is
 *  allowed exactly when that admin is (listed, or access = everyone). */
export function userHasAccess(cfg: AssistantConfig, user: AccessUser): boolean {
	if (!user || !Number.isInteger(user.id)) return false;
	if (cfg.access === 'everyone') return true;
	if (cfg.access === 'selected') return cfg.allowedUserIds.includes(user.id);
	return false;
}

/** The header sparkle button + Cmd/Ctrl+J: shown to anyone with access, and to admins while
 *  access is off (so they can find the "turn it on" message). */
export function assistantVisible(cfg: AssistantConfig, user: AccessUser): boolean {
	if (!user) return false;
	return userHasAccess(cfg, user) || (cfg.access === 'off' && user.role === 'admin');
}

export async function availability(
	db: D1Database | null | undefined,
	cfg: AssistantConfig,
	platformEnv: unknown,
	user: AccessUser
): Promise<AssistantAvailability> {
	// #696: any configured provider counts here; the model a feature then picks is checked
	// with `modelKeyProblem`. With only Anthropic this is the same check as before.
	if (!(await resolveAnthropicKey(db, platformEnv)) && !(cfg.openai?.models.length && (await resolveProviderKey(db, platformEnv, 'openai')))) {
		return { available: false, reason: 'no_key', message: "Assistant isn't set up. An admin needs to paste a key in Settings → Assistant or set the ANTHROPIC_API_KEY secret." };
	}
	if (cfg.access === 'off') return { available: false, reason: 'disabled', message: 'The assistant is turned off (Settings → Assistant).' };
	if (!userHasAccess(cfg, user)) {
		return { available: false, reason: 'not_allowed', message: "The assistant isn't turned on for your account. Ask an admin." };
	}
	return { available: true };
}

// ---- spend ----

/** 'YYYY-MM-DD HH:MM:SS' (SQLite datetime) of the start of `now`'s UTC day / month. */
export function utcDayStart(now: Date): string {
	return `${now.toISOString().slice(0, 10)} 00:00:00`;
}
export function utcMonthStart(now: Date): string {
	return `${now.toISOString().slice(0, 7)}-01 00:00:00`;
}

/** Chat turns plus scheduled-job runs (#303, ai_job_runs: a run counts for its creator) plus
 *  account briefs (#388, company_briefs: an on-demand brief counts for who clicked; the
 *  heartbeat's, user_id NULL, only toward the app's monthly total). */
export async function spentMicros(db: D1Database, since: string, userId?: number): Promise<number> {
	const sql = userId
		? `SELECT (SELECT COALESCE(SUM(m.cost_micros), 0) FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id
		           WHERE m.created_at >= ? AND t.user_id = ?)
		        + (SELECT COALESCE(SUM(cost_micros), 0) FROM ai_job_runs WHERE started_at >= ? AND user_id = ?)
		        + (SELECT COALESCE(SUM(cost_micros), 0) FROM company_briefs WHERE generated_at >= ? AND user_id = ?) AS n`
		: `SELECT (SELECT COALESCE(SUM(cost_micros), 0) FROM ai_messages WHERE created_at >= ?)
		        + (SELECT COALESCE(SUM(cost_micros), 0) FROM ai_job_runs WHERE started_at >= ?)
		        + (SELECT COALESCE(SUM(cost_micros), 0) FROM company_briefs WHERE generated_at >= ?) AS n`;
	const stmt = userId ? db.prepare(sql).bind(since, userId, since, userId, since, userId) : db.prepare(sql).bind(since, since, since);
	return (await stmt.first<{ n: number }>())?.n ?? 0;
}

export type SpendCheck = { ok: true } | { ok: false; message: string };

/** Refuse a new turn once the app's monthly or the user's daily spend reached its cap. */
export async function spendCheck(db: D1Database, cfg: AssistantConfig, userId: number, now = new Date()): Promise<SpendCheck> {
	const [month, day] = await Promise.all([
		spentMicros(db, utcMonthStart(now)),
		spentMicros(db, utcDayStart(now), userId)
	]);
	if (month >= cfg.monthlyCapUsd * 1_000_000) {
		return { ok: false, message: `The assistant reached this month's spend cap ($${cfg.monthlyCapUsd.toFixed(2)}). An admin can raise it in Settings → Assistant.` };
	}
	if (day >= cfg.dailyUserCapUsd * 1_000_000) {
		return { ok: false, message: `You reached today's assistant spend cap ($${cfg.dailyUserCapUsd.toFixed(2)}). It resets at midnight UTC.` };
	}
	return { ok: true };
}

export type UsageRow = {
	month: string;
	user_id: number;
	github_login: string | null;
	turns: number;
	input_tokens: number;
	output_tokens: number;
	cost_micros: number;
};

/** Usage by user and month (newest month first) for Settings → Assistant. */
export async function usageByUserMonth(db: D1Database, months = 12): Promise<UsageRow[]> {
	const rows = await db
		.prepare(
			`SELECT substr(m.created_at, 1, 7) AS month, t.user_id, u.github_login,
			        COUNT(*) AS turns, COALESCE(SUM(m.input_tokens + m.cache_read_tokens + m.cache_write_tokens), 0) AS input_tokens,
			        COALESCE(SUM(m.output_tokens), 0) AS output_tokens, COALESCE(SUM(m.cost_micros), 0) AS cost_micros
			 FROM ai_messages m
			 JOIN ai_threads t ON t.id = m.thread_id
			 LEFT JOIN users u ON u.id = t.user_id
			 WHERE m.role = 'assistant' AND m.created_at >= date('now', 'start of month', ?)
			 GROUP BY month, t.user_id
			 ORDER BY month DESC, cost_micros DESC`
		)
		.bind(`-${Math.max(0, months - 1)} months`)
		.all<UsageRow>();
	return rows.results;
}

// ---- usage insights (#310) ----

export type UsageInsights = {
	days: number;
	/** Chat model calls + scheduled-job runs per model, most spend first. */
	byModel: { model: string; calls: number; cost_micros: number }[];
	/** Tools the model called in chat, most used first (≤ 10). */
	topTools: { name: string; calls: number }[];
	/** Chat turns = messages the users typed; average = chat spend ÷ turns (approval resumes included). */
	turns: number;
	chatCostMicros: number;
	avgTurnMicros: number | null;
	feedback: { up: number; down: number };
	/** Latest thumbs-down answers: which conversation, whose, which model. */
	recentDown: { message_id: number; at: string; model: string | null; title: string; github_login: string | null }[];
};

/** Settings → Assistant usage (#310), over the last `days` days. */
export async function usageInsights(db: D1Database, days = 30): Promise<UsageInsights> {
	const since = `-${Math.max(1, Math.floor(days))} days`;
	const [byModel, topTools, turns, chat, feedback, recentDown] = await db.batch([
		db
			.prepare(
				`SELECT COALESCE(model, '') AS model, SUM(calls) AS calls, SUM(cost) AS cost_micros FROM (
				   SELECT model, COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS cost FROM ai_messages
				   WHERE role = 'assistant' AND created_at >= datetime('now', ?) GROUP BY model
				   UNION ALL
				   SELECT model, COUNT(*), COALESCE(SUM(cost_micros), 0) FROM ai_job_runs
				   WHERE started_at >= datetime('now', ?) AND status <> 'skipped' GROUP BY model)
				 GROUP BY COALESCE(model, '') ORDER BY cost_micros DESC, calls DESC`
			)
			.bind(since, since),
		db
			.prepare(
				`SELECT json_extract(b.value, '$.name') AS name, COUNT(*) AS calls
				 FROM ai_messages m, json_each(m.content) b
				 WHERE m.role = 'assistant' AND m.created_at >= datetime('now', ?)
				   AND json_valid(m.content) AND json_extract(b.value, '$.type') = 'tool_use'
				 GROUP BY name ORDER BY calls DESC, name LIMIT 10`
			)
			.bind(since),
		db.prepare(`SELECT COUNT(*) AS n FROM ai_messages WHERE role = 'user' AND created_at >= datetime('now', ?)`).bind(since),
		db.prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS n FROM ai_messages WHERE role = 'assistant' AND created_at >= datetime('now', ?)`).bind(since),
		db
			.prepare(
				`SELECT COALESCE(SUM(feedback = 1), 0) AS up, COALESCE(SUM(feedback = -1), 0) AS down
				 FROM ai_messages WHERE feedback IS NOT NULL AND feedback_at >= datetime('now', ?)`
			)
			.bind(since),
		db
			.prepare(
				`SELECT m.id AS message_id, m.feedback_at AS at, m.model, t.title, u.github_login
				 FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id LEFT JOIN users u ON u.id = t.user_id
				 WHERE m.feedback = -1 AND m.feedback_at >= datetime('now', ?)
				 ORDER BY m.feedback_at DESC, m.id DESC LIMIT 10`
			)
			.bind(since)
	]);
	const nTurns = (turns.results[0] as { n: number } | undefined)?.n ?? 0;
	const chatCost = (chat.results[0] as { n: number } | undefined)?.n ?? 0;
	const fb = (feedback.results[0] as { up: number; down: number } | undefined) ?? { up: 0, down: 0 };
	return {
		days,
		byModel: byModel.results as UsageInsights['byModel'],
		topTools: (topTools.results as UsageInsights['topTools']).filter((t) => typeof t.name === 'string' && t.name),
		turns: nTurns,
		chatCostMicros: chatCost,
		avgTurnMicros: nTurns > 0 ? Math.round(chatCost / nTurns) : null,
		feedback: { up: fb.up, down: fb.down },
		recentDown: recentDown.results as UsageInsights['recentDown']
	};
}

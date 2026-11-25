// Suggestions settings (#712) — `app_state.suggestions_config` (JSON), read leniently. Written
// by Settings → Suggestions (#715, `/settings/suggestions`); off until an admin turns it on.

import { normalizeSuggestionsConfig, type SuggestionsConfig } from '$lib/suggestions';

export const CONFIG_KEY = 'suggestions_config';
/** When the last full rules pass finished; deleting it makes the next tick run one. */
export const RULES_AT_KEY = 'suggestions_rules_at';
/** A rules pass in progress: `{ rule, started_at }` (index into RULE_KEYS). */
export const PASS_KEY = 'suggestions_pass';
/** New suggestions made today: `{ day, created }` (UTC day). */
export const DAILY_KEY = 'suggestions_daily';

export async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

export async function deleteState(db: D1Database, key: string): Promise<void> {
	await db.prepare('DELETE FROM app_state WHERE key = ?').bind(key).run();
}

export async function getSuggestionsConfig(db: D1Database): Promise<SuggestionsConfig> {
	const raw = await getState(db, CONFIG_KEY);
	if (!raw) return normalizeSuggestionsConfig(null);
	try {
		return normalizeSuggestionsConfig(JSON.parse(raw));
	} catch {
		return normalizeSuggestionsConfig(null);
	}
}

/** Save (already validated by the caller) and ask the next tick for a fresh rules pass. */
export async function saveSuggestionsConfig(db: D1Database, cfg: unknown): Promise<SuggestionsConfig> {
	const clean = normalizeSuggestionsConfig(cfg);
	await setState(db, CONFIG_KEY, JSON.stringify(clean));
	await requestSuggestionsPass(db);
	return clean;
}

/** The next heartbeat tick runs the rules without waiting for the hourly pass. */
export async function requestSuggestionsPass(db: D1Database): Promise<void> {
	await deleteState(db, RULES_AT_KEY);
}

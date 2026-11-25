// #479: the pre-send check policy in app_state (rules in $lib/presend-policy). No migration:
// unset keys read as the defaults (Block on blocking checks, admins may override, keep trying
// 15 minutes, no email).
import { normalizePolicy, type PresendPolicy } from '$lib/presend-policy';

export const POLICY_KEYS = {
	enforcement: 'presend_enforcement',
	levels: 'presend_levels',
	override: 'presend_override',
	retryMinutes: 'presend_retry_minutes',
	notifyEmail: 'presend_notify_email'
} as const;

export async function getPresendPolicy(db: D1Database): Promise<PresendPolicy> {
	const rows = await db
		.prepare(`SELECT key, value FROM app_state WHERE key IN (?, ?, ?, ?, ?)`)
		.bind(...Object.values(POLICY_KEYS))
		.all<{ key: string; value: string }>();
	const get = (k: string) => rows.results.find((r) => r.key === k)?.value;
	return normalizePolicy({
		enforcement: get(POLICY_KEYS.enforcement),
		levels: get(POLICY_KEYS.levels),
		override: get(POLICY_KEYS.override),
		retryMinutes: get(POLICY_KEYS.retryMinutes),
		notifyEmail: get(POLICY_KEYS.notifyEmail)
	});
}

export async function savePresendPolicy(db: D1Database, policy: PresendPolicy): Promise<void> {
	const p = normalizePolicy(policy);
	const values: [string, string][] = [
		[POLICY_KEYS.enforcement, p.enforcement],
		[POLICY_KEYS.levels, JSON.stringify(p.levels)],
		[POLICY_KEYS.override, p.override],
		[POLICY_KEYS.retryMinutes, String(p.retryMinutes)],
		[POLICY_KEYS.notifyEmail, p.notifyEmail ? '1' : '0']
	];
	await db.batch(
		values.map(([k, v]) =>
			db
				.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
				.bind(k, v)
		)
	);
}

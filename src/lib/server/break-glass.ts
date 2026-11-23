// #533: the break-glass sign-in (shared APP_PASSWORD on /login) — lockout + audit trail.
//
// Lockout reuses the #211 `login_attempts` counters under the fixed key `break-glass`: 5
// failures in 15 minutes from anyone lock break-glass for everyone (global), 20 failures from
// one IP (shared with username + password sign-in) lock that IP. A success resets the global
// counter. Every attempt — refused, wrong, right — also gets a `break_glass_events` row (time,
// IP hash, outcome, the admin signed in) that admins see on Settings → Users. The posted
// password is never logged or stored.

import { safeEqual } from './auth';
import { lockoutMinutes, recordAttempt } from './login-attempts';
import { ipHash } from './rate-limit';

export const BREAK_GLASS_ATTEMPT_KEY = 'break-glass';
export const BREAK_GLASS_KEEP_DAYS = 365;

export type BreakGlassOutcome = 'ok' | 'failed' | 'locked' | 'no_admin';

export type BreakGlassCheck = { ok: true } | { ok: false; status: 401 } | { ok: false; status: 429; minutes: number };

export async function recordBreakGlassEvent(
	db: D1Database,
	input: { ip: string; secret: string; outcome: BreakGlassOutcome; userId?: number | null }
): Promise<void> {
	await db
		.prepare(`INSERT INTO break_glass_events (ip_hash, outcome, user_id) VALUES (?, ?, ?)`)
		.bind(await ipHash(input.ip, input.secret), input.outcome, input.userId ?? null)
		.run();
}

/**
 * Check a typed break-glass password under the lockout. A refusal or a wrong password is
 * recorded (audit, and the lockout counter for a wrong one); a match is recorded by the caller
 * once it knows which admin it signs in as (`breakGlassSucceeded` / `no_admin`).
 */
export async function checkBreakGlass(
	db: D1Database,
	input: { expected: string; typed: string; ip: string; secret: string }
): Promise<BreakGlassCheck> {
	const minutes = await lockoutMinutes(db, BREAK_GLASS_ATTEMPT_KEY, input.ip);
	if (minutes > 0) {
		// Not added to login_attempts, so hammering a lock doesn't extend it.
		await recordBreakGlassEvent(db, { ip: input.ip, secret: input.secret, outcome: 'locked' });
		return { ok: false, status: 429, minutes };
	}
	if (!input.expected || !safeEqual(input.typed, input.expected)) {
		await recordAttempt(db, BREAK_GLASS_ATTEMPT_KEY, input.ip, false);
		await recordBreakGlassEvent(db, { ip: input.ip, secret: input.secret, outcome: 'failed' });
		return { ok: false, status: 401 };
	}
	return { ok: true };
}

/** A right password that signed in as `userId`: resets the global counter and audits it. */
export async function breakGlassSucceeded(db: D1Database, input: { ip: string; secret: string; userId: number }) {
	await recordAttempt(db, BREAK_GLASS_ATTEMPT_KEY, input.ip, true);
	await recordBreakGlassEvent(db, { ip: input.ip, secret: input.secret, outcome: 'ok', userId: input.userId });
}

export type BreakGlassEventRow = {
	id: number;
	at: string;
	ip_hash: string | null;
	outcome: BreakGlassOutcome;
	user_id: number | null;
	login: string | null;
};

/** Newest break-glass attempts, for Settings → Users. */
export async function listBreakGlassEvents(db: D1Database, limit = 20): Promise<BreakGlassEventRow[]> {
	const { results } = await db
		.prepare(
			`SELECT e.id, e.at, e.ip_hash, e.outcome, e.user_id, u.github_login AS login
			 FROM break_glass_events e LEFT JOIN users u ON u.id = e.user_id
			 ORDER BY e.id DESC LIMIT ?`
		)
		.bind(limit)
		.all<BreakGlassEventRow>();
	return results ?? [];
}

/** Heartbeat housekeeping (with the login-attempt prune): drop rows older than a year. */
export async function pruneBreakGlassEvents(db: D1Database): Promise<number> {
	const res = await db
		.prepare(`DELETE FROM break_glass_events WHERE at < datetime('now', ?)`)
		.bind(`-${BREAK_GLASS_KEEP_DAYS} days`)
		.run();
	return res.meta.changes ?? 0;
}

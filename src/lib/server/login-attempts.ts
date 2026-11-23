// #211: username + password sign-in — attempt log, lockout, and the check itself.
//
// Lockout: 5 failures for a username (counted since that username's last successful sign-in)
// or 20 failures from one IP, within 15 minutes → 429 until the oldest counted failure ages
// out. A success resets the username counter only; the IP counter never resets on success, so
// signing in to one account can't buy more guesses against others. Attempts made while locked
// out are refused before the KDF and not logged, so they don't extend the lock.

import { hashPassword, needsRehash, verifyPassword } from './password';
import { findPasswordCredential, replacePasswordHash, touchLastLogin } from './users';

export const LOCK_WINDOW_MINUTES = 15;
export const MAX_USERNAME_FAILURES = 5;
export const MAX_IP_FAILURES = 20;
const PRUNE_AFTER_DAYS = 30;

export function normalizeUsername(input: string): string {
	return input.trim().toLowerCase().slice(0, 100);
}

function minutesUntilClear(at: string | undefined): number {
	if (!at) return 0;
	const since = Date.parse(at.replace(' ', 'T') + 'Z');
	if (Number.isNaN(since)) return LOCK_WINDOW_MINUTES;
	const left = since + LOCK_WINDOW_MINUTES * 60_000 - Date.now();
	return Math.max(1, Math.ceil(left / 60_000));
}

/** Minutes until this username / IP may try again; 0 when not locked out. */
export async function lockoutMinutes(db: D1Database, username: string, ip: string): Promise<number> {
	const window = `-${LOCK_WINDOW_MINUTES} minutes`;
	// The Nth-newest counted failure: once it leaves the window the count drops below N.
	const byUser = await db
		.prepare(
			`SELECT at FROM login_attempts
			 WHERE username = ? AND ok = 0 AND at > datetime('now', ?)
			   AND id > COALESCE((SELECT MAX(id) FROM login_attempts WHERE username = ? AND ok = 1), 0)
			 ORDER BY id DESC LIMIT 1 OFFSET ?`
		)
		.bind(username, window, username, MAX_USERNAME_FAILURES - 1)
		.first<{ at: string }>();
	const byIp = await db
		.prepare(
			`SELECT at FROM login_attempts
			 WHERE ip = ? AND ok = 0 AND at > datetime('now', ?)
			 ORDER BY id DESC LIMIT 1 OFFSET ?`
		)
		.bind(ip, window, MAX_IP_FAILURES - 1)
		.first<{ at: string }>();
	return Math.max(minutesUntilClear(byUser?.at), minutesUntilClear(byIp?.at));
}

export async function recordAttempt(db: D1Database, username: string, ip: string, ok: boolean): Promise<void> {
	await db
		.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES (?, ?, ?)`)
		.bind(username, ip, ok ? 1 : 0)
		.run();
}

export type PasswordSignIn =
	| { ok: true; userId: number }
	| { ok: false; status: 401 }
	| { ok: false; status: 429; minutes: number };

/**
 * Check a username + password. Wrong username, wrong password, no password set and a
 * disabled user all come back as the same `401` — the caller shows one generic message.
 */
export async function signInWithPassword(
	db: D1Database,
	input: { username: string; password: string; ip: string }
): Promise<PasswordSignIn> {
	const username = normalizeUsername(input.username);
	const minutes = await lockoutMinutes(db, username, input.ip);
	if (minutes > 0) return { ok: false, status: 429, minutes };

	const cred = username ? await findPasswordCredential(db, username) : null;
	// Always runs the KDF (verifyPassword hashes against a dummy when there's no hash).
	const match = await verifyPassword(input.password, cred?.password_hash);
	if (!cred || !match || cred.disabled_at) {
		await recordAttempt(db, username, input.ip, false);
		return { ok: false, status: 401 };
	}

	await recordAttempt(db, username, input.ip, true);
	await touchLastLogin(db, cred.id);
	if (needsRehash(cred.password_hash)) {
		await replacePasswordHash(db, cred.id, await hashPassword(input.password));
	}
	return { ok: true, userId: cred.id };
}

/** Heartbeat housekeeping: drop attempts older than 30 days. */
export async function pruneLoginAttempts(db: D1Database): Promise<{ deleted: number }> {
	const res = await db
		.prepare(`DELETE FROM login_attempts WHERE at < datetime('now', ?)`)
		.bind(`-${PRUNE_AFTER_DAYS} days`)
		.run();
	return { deleted: res.meta.changes ?? 0 };
}

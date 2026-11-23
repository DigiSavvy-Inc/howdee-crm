// #606: first-run setup. A fresh database has no users; `/setup` creates the first admin,
// gated by the SETUP_TOKEN secret. Once any user exists, setup is gone (404).

import { isEmail } from '$lib/csv';
import { safeEqual } from './auth';
import { lockoutMinutes, recordAttempt } from './login-attempts';
import { credentialStamp, hashPassword, passwordPolicyError } from './password';
import { isValidGitHubLogin } from './users';

/**
 * The `login_attempts.username` key wrong setup tokens are counted under. It can't be a real
 * username (a GitHub login has no ':' and an email has an '@'), so it never collides.
 */
export const SETUP_ATTEMPT_KEY = 'setup:token';

/** True once the users table has any row — active, disabled, admin or member. */
export async function hasAnyUser(db: D1Database): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS one FROM users LIMIT 1`).first<{ one: number }>();
	return !!row;
}

/**
 * The configured SETUP_TOKEN, trimmed ('' when unset). SETUP_TOKEN is an optional secret, so the
 * generated `Env` may not declare it; read it through a cast rather than depend on that type.
 */
export function setupToken(env: object | undefined): string {
	const e = (env ?? {}) as { SETUP_TOKEN?: string };
	return (e.SETUP_TOKEN ?? '').trim();
}

export type SetupTokenCheck = { ok: true } | { ok: false; status: 401 } | { ok: false; status: 429; minutes: number };

/**
 * Check a typed setup token in constant time, sharing the sign-in lockout (per key + per IP).
 * A failure is recorded; the value itself is never logged or stored.
 */
export async function checkSetupToken(
	db: D1Database,
	expected: string,
	typed: string,
	ip: string
): Promise<SetupTokenCheck> {
	const minutes = await lockoutMinutes(db, SETUP_ATTEMPT_KEY, ip);
	if (minutes > 0) return { ok: false, status: 429, minutes };
	if (!expected || !safeEqual(typed.trim(), expected)) {
		await recordAttempt(db, SETUP_ATTEMPT_KEY, ip, false);
		return { ok: false, status: 401 };
	}
	return { ok: true };
}

export type FirstAdminInput = {
	name: string;
	email: string;
	password: string;
	confirm: string;
	githubLogin: string;
};

export type FirstAdminErrors = Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'githubLogin', string>>;

/**
 * The sign-in username for the first admin: the GitHub login when given, else the email
 * address. An email can never be a GitHub login, so GitHub sign-in can't claim that row.
 */
export function firstAdminUsername(input: Pick<FirstAdminInput, 'email' | 'githubLogin'>): string {
	const gh = input.githubLogin.trim().replace(/^@/, '').toLowerCase();
	return gh || input.email.trim().toLowerCase();
}

export function validateFirstAdmin(input: FirstAdminInput): FirstAdminErrors {
	const errors: FirstAdminErrors = {};
	const name = input.name.trim();
	const email = input.email.trim();
	const gh = input.githubLogin.trim().replace(/^@/, '');
	if (!name) errors.name = 'Enter your name.';
	else if (name.length > 100) errors.name = 'Use at most 100 characters.';
	if (!email) errors.email = 'Enter your email address.';
	else if (email.length > 254 || !isEmail(email)) errors.email = "That doesn't look like an email address.";
	if (gh && !isValidGitHubLogin(gh)) errors.githubLogin = "That doesn't look like a valid GitHub login.";
	const policy = passwordPolicyError(input.password, firstAdminUsername(input));
	if (policy) errors.password = policy;
	else if (input.password !== input.confirm) errors.confirm = "The passwords don't match.";
	return errors;
}

export type CreateFirstAdmin = { ok: true; id: number; username: string } | { ok: false; reason: 'exists' };

/**
 * Insert the first admin with a password (not must-change). The insert only happens while
 * the users table is empty, so two racing submissions can't both create an admin.
 * Call `validateFirstAdmin` first.
 */
export async function createFirstAdmin(db: D1Database, input: FirstAdminInput): Promise<CreateFirstAdmin> {
	const username = firstAdminUsername(input);
	const hash = await hashPassword(input.password);
	const res = await db
		.prepare(
			// #639: the operator typed this address alongside SETUP_TOKEN, so it counts as verified.
			`INSERT INTO users (github_login, name, email, role, password_hash, password_set_at, must_change_password, email_verified_at)
			 SELECT ?, ?, ?, 'admin', ?, ?, 0, datetime('now')
			 WHERE NOT EXISTS (SELECT 1 FROM users)`
		)
		.bind(username, input.name.trim(), input.email.trim().toLowerCase(), hash, credentialStamp())
		.run();
	if (!res.meta.changes) return { ok: false, reason: 'exists' };
	return { ok: true, id: res.meta.last_row_id as number, username };
}

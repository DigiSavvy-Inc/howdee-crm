// #88: the sign-in allowlist. GitHub OAuth resolves to a row here; the shared-password
// fallback (break-glass, only while APP_PASSWORD is set) signs in as the first active admin.

import { parseNavLayout, type NavLayout } from '$lib/nav-layout';

export type UserRole = 'admin' | 'member';

export type UserRow = {
	id: number;
	github_login: string;
	github_id: number | null;
	name: string | null;
	avatar_url: string | null;
	role: UserRole;
	created_at: string;
	last_login_at: string | null;
	disabled_at: string | null;
	tour_dismissed_at: string | null;
	nav_layout: NavLayout;
	/** #211: 1 when a password hash is stored (the hash itself never leaves this module). */
	has_password: number;
	/** #211: last credential change ('YYYY-MM-DD HH:MM:SS.SSS' UTC); older sessions are rejected. */
	password_set_at: string | null;
	must_change_password: number;
	/** #639: the user's address (sign-in mail: invites, resets, verification), or null. */
	email: string | null;
	/** #639: when `email` was confirmed; NULL = unverified (no reset mail goes there). */
	email_verified_at: string | null;
};

export type SessionUser = Pick<UserRow, 'id' | 'github_login' | 'name' | 'avatar_url' | 'role'> & {
	tourSeen: boolean;
	navLayout: NavLayout;
	/** #211: see UserRow.password_set_at. */
	passwordSetAt: string | null;
	/** #211: every route but /account/password is blocked until this clears. */
	mustChangePassword: boolean;
};

// Columns added by later migrations (0046 nav_layout, 0064 passwords). A Worker that ships
// before its migration retries without them and uses the defaults below instead of 500ing.
const OPTIONAL_USER_COLUMNS =
	', nav_layout, (password_hash IS NOT NULL) AS has_password, password_set_at, must_change_password, email, email_verified_at';
type OptionalCols = Pick<
	UserRow,
	'nav_layout' | 'has_password' | 'password_set_at' | 'must_change_password' | 'email' | 'email_verified_at'
>;
const OPTIONAL_DEFAULTS: OptionalCols = {
	nav_layout: 'top',
	has_password: 0,
	password_set_at: null,
	must_change_password: 0,
	email: null,
	email_verified_at: null
};

const USER_COLUMNS_WITHOUT_NAV =
	'id, github_login, github_id, name, avatar_url, role, created_at, last_login_at, disabled_at, tour_dismissed_at';
const USER_COLUMNS = `${USER_COLUMNS_WITHOUT_NAV}${OPTIONAL_USER_COLUMNS}`;

const SESSION_COLUMNS_WITHOUT_NAV = 'id, github_login, name, avatar_url, role, tour_dismissed_at';
const SESSION_COLUMNS = `${SESSION_COLUMNS_WITHOUT_NAV}${OPTIONAL_USER_COLUMNS}`;

type SqlBind = string | number | null;
type SessionRow = Pick<
	UserRow,
	'id' | 'github_login' | 'name' | 'avatar_url' | 'role' | 'tour_dismissed_at'
>;

/**
 * True only for SQLite's missing-column error on one of the optional columns (`nav_layout`,
 * migration 0046; the password columns, 0064). Any other failure, including a different
 * missing column, stays a failure.
 */
function isMissingOptionalColumn(err: unknown): boolean {
	const pattern =
		/no such column:\s*(?:[\w"]+\.)?(?:nav_layout|password_hash|password_set_at|must_change_password|email_verified_at)\b/i;
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current != null && !seen.has(current)) {
		if (typeof current === 'string') return pattern.test(current);
		if (typeof current !== 'object') return false;
		seen.add(current);
		const message = current instanceof Error ? current.message : '';
		if (pattern.test(message)) return true;
		if (!(current instanceof Error)) return false;
		current = current.cause;
	}
	return false;
}

async function firstUserRow<T extends object>(
	db: D1Database,
	columns: string,
	fallbackColumns: string,
	tail: string,
	bindings: SqlBind[]
): Promise<(T & OptionalCols) | null> {
	try {
		const row = await db
			.prepare(`SELECT ${columns} FROM users ${tail}`)
			.bind(...bindings)
			.first<T & OptionalCols>();
		return row ?? null;
	} catch (err) {
		if (!isMissingOptionalColumn(err)) throw err;
		const row = await db
			.prepare(`SELECT ${fallbackColumns} FROM users ${tail}`)
			.bind(...bindings)
			.first<T>();
		if (!row) return null;
		return { ...row, ...OPTIONAL_DEFAULTS };
	}
}

async function allUserRows(db: D1Database, tail: string, bindings: SqlBind[]): Promise<UserRow[]> {
	try {
		const res = await db
			.prepare(`SELECT ${USER_COLUMNS} FROM users ${tail}`)
			.bind(...bindings)
			.all<UserRow>();
		return res.results ?? [];
	} catch (err) {
		if (!isMissingOptionalColumn(err)) throw err;
		const res = await db
			.prepare(`SELECT ${USER_COLUMNS_WITHOUT_NAV} FROM users ${tail}`)
			.bind(...bindings)
			.all<Omit<UserRow, keyof OptionalCols>>();
		return (res.results ?? []).map((row) => ({ ...row, ...OPTIONAL_DEFAULTS }));
	}
}

/** Active user by id, trimmed to the fields a session needs. */
export async function findActiveUserById(db: D1Database, id: number): Promise<SessionUser | null> {
	const row = await firstUserRow<SessionRow>(
		db,
		SESSION_COLUMNS,
		SESSION_COLUMNS_WITHOUT_NAV,
		'WHERE id = ? AND disabled_at IS NULL',
		[id]
	);
	if (!row) return null;
	const { tour_dismissed_at, nav_layout, password_set_at, must_change_password } = row;
	return {
		id: row.id,
		github_login: row.github_login,
		name: row.name,
		avatar_url: row.avatar_url,
		role: row.role,
		tourSeen: !!tour_dismissed_at,
		navLayout: parseNavLayout(nav_layout),
		passwordSetAt: password_set_at ?? null,
		mustChangePassword: !!must_change_password
	};
}

/** Active user by GitHub login, case-insensitive (column is NOCASE; input is also normalized). */
export async function findActiveUserByLogin(db: D1Database, login: string): Promise<UserRow | null> {
	const normalized = login.trim().toLowerCase();
	if (!normalized) return null;
	return firstUserRow<Omit<UserRow, keyof OptionalCols>>(
		db,
		USER_COLUMNS,
		USER_COLUMNS_WITHOUT_NAV,
		'WHERE github_login = ? AND disabled_at IS NULL',
		[normalized]
	);
}

/**
 * Resolve a GitHub OAuth login to an allowlisted user, updating that row for the login.
 * Prefers a `github_id` match (survives renames); falls back to a login match, but only
 * when that row isn't already pinned to a *different* github_id (no hijacking). Returns
 * null when neither matches, the row is disabled, or the login collides with another id.
 */
export async function resolveGitHubUser(
	db: D1Database,
	gh: { id: number; login: string; name: string | null; avatar_url: string | null }
): Promise<UserRow | null> {
	const login = gh.login.trim().toLowerCase();
	if (!login) return null;

	let row = await firstUserRow<Omit<UserRow, keyof OptionalCols>>(
		db,
		USER_COLUMNS,
		USER_COLUMNS_WITHOUT_NAV,
		'WHERE github_id = ? AND disabled_at IS NULL',
		[gh.id]
	);

	if (!row) {
		const byLogin = await firstUserRow<Omit<UserRow, keyof OptionalCols>>(
			db,
			USER_COLUMNS,
			USER_COLUMNS_WITHOUT_NAV,
			'WHERE github_login = ? AND disabled_at IS NULL',
			[login]
		);
		if (!byLogin) return null;
		// A login match is only usable if unpinned or already pinned to this same id.
		if (byLogin.github_id !== null && byLogin.github_id !== gh.id) return null;
		row = byLogin;
	}

	// A *different* row may already hold this login (e.g. a renamed GitHub account that
	// now collides with a separately-added row). Writing `login` into `row` in that case
	// would fail the UPDATE against the UNIQUE (NOCASE) constraint — so keep this row's
	// existing login instead of failing the whole sign-in.
	const conflict = await db
		.prepare(`SELECT id FROM users WHERE github_login = ? AND id != ?`)
		.bind(login, row.id)
		.first<{ id: number }>();
	const nextLogin = conflict ? row.github_login : login;

	await db
		.prepare(
			`UPDATE users
			 SET github_id = ?, github_login = ?, name = ?, avatar_url = ?, last_login_at = datetime('now')
			 WHERE id = ?`
		)
		.bind(gh.id, nextLogin, gh.name, gh.avatar_url, row.id)
		.run();

	return firstUserRow<Omit<UserRow, keyof OptionalCols>>(
		db,
		USER_COLUMNS,
		USER_COLUMNS_WITHOUT_NAV,
		'WHERE id = ?',
		[row.id]
	);
}

/** The break-glass password login signs in as this user (lowest id, active admin). */
export async function firstActiveAdmin(db: D1Database): Promise<UserRow | null> {
	return firstUserRow<Omit<UserRow, keyof OptionalCols>>(
		db,
		USER_COLUMNS,
		USER_COLUMNS_WITHOUT_NAV,
		`WHERE role = 'admin' AND disabled_at IS NULL ORDER BY id ASC LIMIT 1`,
		[]
	);
}

/** GitHub username rules: 1-39 chars, alphanumeric, single hyphens, no leading/trailing hyphen. */
export function isValidGitHubLogin(login: string): boolean {
	return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login);
}

/** All users for the admin list, active first sorted by role then login, disabled last. */
export async function listUsers(db: D1Database): Promise<UserRow[]> {
	return allUserRows(
		db,
		`ORDER BY disabled_at IS NOT NULL, role = 'admin' DESC, github_login`,
		[]
	);
}

/** Any user row by id, active or not (the admin UI needs to look up disabled rows too). */
export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
	return firstUserRow<Omit<UserRow, keyof OptionalCols>>(
		db,
		USER_COLUMNS,
		USER_COLUMNS_WITHOUT_NAV,
		'WHERE id = ?',
		[id]
	);
}

/** How many active admins exist — the floor `canActOn` protects against dropping below 1. */
export async function countActiveAdmins(db: D1Database): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Add a new allowlisted user (no GitHub id yet — that's pinned on their first sign-in). */
export async function createUser(db: D1Database, login: string, role: UserRole): Promise<UserRow> {
	const normalized = login.trim().toLowerCase();
	if (!isValidGitHubLogin(normalized)) {
		throw new Error("That doesn't look like a valid GitHub login.");
	}
	// github_login is COLLATE NOCASE UNIQUE, so this also catches case-only collisions.
	const existing = await db
		.prepare(`SELECT id FROM users WHERE github_login = ?`)
		.bind(normalized)
		.first<{ id: number }>();
	if (existing) {
		throw new Error('That GitHub login is already on the list.');
	}
	let id: number;
	try {
		const res = await db
			.prepare(`INSERT INTO users (github_login, role) VALUES (?, ?)`)
			.bind(normalized, role)
			.run();
		id = res.meta.last_row_id as number;
	} catch {
		// Race with another insert of the same (case-insensitive) login between the check
		// above and this insert — surface the same friendly message either way.
		throw new Error('That GitHub login is already on the list.');
	}
	const row = await getUserById(db, id);
	if (!row) throw new Error('Could not create that user.');
	return row;
}

export async function setUserRole(db: D1Database, id: number, role: UserRole): Promise<void> {
	await db.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, id).run();
}

export async function setUserDisabled(db: D1Database, id: number, disabled: boolean): Promise<void> {
	if (disabled) {
		await db.prepare(`UPDATE users SET disabled_at = datetime('now') WHERE id = ?`).bind(id).run();
	} else {
		await db.prepare(`UPDATE users SET disabled_at = NULL WHERE id = ?`).bind(id).run();
	}
}

export async function deleteUser(db: D1Database, id: number): Promise<void> {
	await db.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
}

/** #104: mark the first-run product tour dismissed (finished or skipped) for this user. */
export async function markTourDismissed(db: D1Database, userId: number): Promise<void> {
	await db
		.prepare(`UPDATE users SET tour_dismissed_at = datetime('now') WHERE id = ?`)
		.bind(userId)
		.run();
}

/** #134: save this user's nav layout preference ('top' | 'left'). */
export async function setNavLayout(db: D1Database, userId: number, layout: NavLayout): Promise<void> {
	await db
		.prepare(`UPDATE users SET nav_layout = ? WHERE id = ?`)
		.bind(parseNavLayout(layout), userId)
		.run();
}

/**
 * #211: the stored password for a username + password sign-in (login is case-insensitive).
 * Returns disabled rows too — the caller still runs the KDF and answers with the same error.
 */
export async function findPasswordCredential(
	db: D1Database,
	login: string
): Promise<{ id: number; password_hash: string | null; disabled_at: string | null } | null> {
	const normalized = login.trim().toLowerCase();
	if (!normalized) return null;
	const row = await db
		.prepare(`SELECT id, password_hash, disabled_at FROM users WHERE github_login = ?`)
		.bind(normalized)
		.first<{ id: number; password_hash: string | null; disabled_at: string | null }>();
	return row ?? null;
}

/** #211: the stored hash, for checking a user's current password on the Account page. */
export async function getPasswordHash(db: D1Database, id: number): Promise<string | null> {
	const row = await db
		.prepare(`SELECT password_hash FROM users WHERE id = ?`)
		.bind(id)
		.first<{ password_hash: string | null }>();
	return row?.password_hash ?? null;
}

/**
 * #211: store a new password hash and stamp `password_set_at` = `stamp`, which signs out
 * every session issued before it. `mustChange` = 1 for an admin-generated password.
 */
export async function setUserPassword(
	db: D1Database,
	id: number,
	hash: string,
	mustChange: boolean,
	stamp: string
): Promise<void> {
	await db
		.prepare(
			`UPDATE users SET password_hash = ?, password_set_at = ?, must_change_password = ? WHERE id = ?`
		)
		.bind(hash, stamp, mustChange ? 1 : 0, id)
		.run();
}

/** #211: remove the password (GitHub-only again). Stamps `password_set_at`, so sessions end too. */
export async function clearUserPassword(db: D1Database, id: number, stamp: string): Promise<void> {
	await db
		.prepare(
			`UPDATE users SET password_hash = NULL, password_set_at = ?, must_change_password = 0 WHERE id = ?`
		)
		.bind(stamp, id)
		.run();
}

/** #211: replace the hash after an iteration bump without moving `password_set_at`. */
export async function replacePasswordHash(db: D1Database, id: number, hash: string): Promise<void> {
	await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(hash, id).run();
}

export async function touchLastLogin(db: D1Database, id: number): Promise<void> {
	await db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(id).run();
}

/** #639: is this address already a user's email or username (case-insensitive)? */
export async function emailInUse(db: D1Database, email: string, exceptUserId = 0): Promise<boolean> {
	const e = email.trim().toLowerCase();
	const row = await db
		.prepare(`SELECT id FROM users WHERE (email = ? OR github_login = ?) AND id != ? LIMIT 1`)
		.bind(e, e, exceptUserId)
		.first<{ id: number }>();
	return !!row;
}

/**
 * #639: change (or clear, with '') a user's email. A different address is unverified until its
 * link is opened; saving the same address keeps its state. False when another user has it.
 */
export async function setUserEmail(db: D1Database, id: number, email: string): Promise<boolean> {
	const e = email.trim().toLowerCase();
	if (e && (await emailInUse(db, e, id))) return false;
	try {
		await db
			.prepare(
				`UPDATE users
				 SET email_verified_at = CASE WHEN email = ? THEN email_verified_at ELSE NULL END,
				     email = ?
				 WHERE id = ?`
			)
			.bind(e, e || null, id)
			.run();
	} catch {
		return false; // UNIQUE race with another write
	}
	return true;
}

/** #639: mark this user's email verified — only while it still equals `email`. */
export async function markEmailVerified(db: D1Database, id: number, email: string): Promise<boolean> {
	const res = await db
		.prepare(`UPDATE users SET email_verified_at = datetime('now') WHERE id = ? AND email = ?`)
		.bind(id, email.trim().toLowerCase())
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** #639: the active user whose *verified* email is this address — the only reset recipient. */
export async function findUserByVerifiedEmail(
	db: D1Database,
	email: string
): Promise<{ id: number; github_login: string; email: string } | null> {
	const e = email.trim().toLowerCase();
	if (!e) return null;
	const row = await db
		.prepare(
			`SELECT id, github_login, email FROM users
			 WHERE email = ? AND email_verified_at IS NOT NULL AND disabled_at IS NULL LIMIT 1`
		)
		.bind(e)
		.first<{ id: number; github_login: string; email: string }>();
	return row ?? null;
}

/** The user-management actions the `/settings/users` route exposes. */
export type UserAction = 'setRole' | 'disable' | 'enable' | 'remove' | 'generatePassword' | 'clearPassword' | 'setEmail';

/**
 * Guards every user-management mutation: only admins may act, nobody may act on their own
 * row, the last active admin can't be disabled/removed/demoted, and enable/disable refuse
 * a no-op so the caller can surface *why* nothing changed instead of silently succeeding.
 * `newRole` is only meaningful (and only checked) for the `setRole` action.
 */
export function canActOn(
	actor: SessionUser,
	target: UserRow,
	action: UserAction,
	newRole: UserRole | undefined,
	activeAdminCount: number
): { ok: true } | { ok: false; reason: string } {
	if (actor.role !== 'admin') {
		return { ok: false, reason: 'Only admins can manage users.' };
	}
	if (target.id === actor.id) {
		return { ok: false, reason: "You can't change your own account." };
	}

	const targetActive = target.disabled_at === null;
	const wouldDropLastAdmin =
		activeAdminCount <= 1 &&
		target.role === 'admin' &&
		targetActive &&
		(action === 'disable' || action === 'remove' || (action === 'setRole' && newRole === 'member'));
	if (wouldDropLastAdmin) {
		return { ok: false, reason: "You can't remove the last admin." };
	}

	if (action === 'enable' && targetActive) {
		return { ok: false, reason: 'Already enabled.' };
	}
	if (action === 'disable' && !targetActive) {
		return { ok: false, reason: 'Already disabled.' };
	}

	return { ok: true };
}

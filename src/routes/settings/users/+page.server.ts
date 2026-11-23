import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	listUsers,
	getUserById,
	createUser,
	setUserRole,
	setUserDisabled,
	deleteUser,
	canActOn,
	countActiveAdmins,
	setUserPassword,
	clearUserPassword,
	setUserEmail,
	type UserRole,
	type UserAction
} from '$lib/server/users';
import { credentialStamp, generatePassword, hashPassword } from '$lib/server/password';
import { listBreakGlassEvents } from '$lib/server/break-glass';
import {
	listPendingInvites,
	requestIp,
	resendInvite,
	revokeInvite,
	sendInvite,
	sendVerification,
	type AccountEnv
} from '$lib/server/account-tokens';
import { isEmail } from '$lib/csv';

function accountEnv(event: { platform?: App.Platform }): AccountEnv {
	return (event.platform?.env ?? {}) as AccountEnv;
}

/**
 * #211: store a fresh generated password (must change on first sign-in) and return the
 * plaintext for the one-time modal. It's never logged or stored anywhere else.
 */
async function issueGeneratedPassword(db: D1Database, userId: number): Promise<string> {
	const password = generatePassword();
	await setUserPassword(db, userId, await hashPassword(password), true, credentialStamp());
	return password;
}

function requireAdmin(locals: App.Locals | undefined) {
	if (locals?.user?.role !== 'admin') throw error(403, 'Admins only.');
}

function parseId(data: FormData): number | null {
	const id = Number(data.get('id'));
	return Number.isInteger(id) && id > 0 ? id : null;
}

function parseRole(data: FormData): UserRole {
	return String(data.get('role') ?? '') === 'admin' ? 'admin' : 'member';
}

/** Shared by every mutating action: load the target, run the guard, bail with the same
 *  shape either way. Returns the target row when the action is allowed to proceed. */
async function loadAndGuard(
	db: D1Database,
	actor: NonNullable<App.Locals['user']>,
	id: number | null,
	action: UserAction,
	newRole: UserRole | undefined
) {
	if (!id) return { error: fail(400, { error: 'Missing user.' }) } as const;
	const target = await getUserById(db, id);
	if (!target) throw error(404, 'User not found.');
	const activeAdminCount = await countActiveAdmins(db);
	const check = canActOn(actor, target, action, newRole, activeAdminCount);
	if (!check.ok) return { error: fail(400, { error: check.reason }) } as const;
	return { target } as const;
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event.locals);
	const db = getDB(event);
	return {
		users: await listUsers(db),
		me: event.locals.user,
		invites: await listPendingInvites(db),
		// #533: break-glass sign-in audit (attempts + successes), newest first.
		breakGlass: {
			enabled: !!event.platform?.env?.APP_PASSWORD,
			events: await listBreakGlassEvents(db, 20)
		}
	};
};

function parseInviteId(data: FormData): number {
	const id = Number(data.get('invite_id'));
	return Number.isInteger(id) && id > 0 ? id : 0;
}

export const actions: Actions = {
	add: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const login = String(data.get('github_login') ?? '');
		const role = parseRole(data);
		if (!login.trim()) return fail(400, { error: 'Enter a GitHub login.' });
		try {
			const user = await createUser(db, login, role);
			if (data.get('generate_password')) {
				const password = await issueGeneratedPassword(db, user.id);
				return { ok: `Added @${user.github_login}.`, generated: { login: user.github_login, password } };
			}
			return { ok: `Added @${user.github_login}.` };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not add that user.' });
		}
	},

	setRole: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const id = parseId(data);
		const role = parseRole(data);
		const guarded = await loadAndGuard(db, event.locals.user!, id, 'setRole', role);
		if ('error' in guarded) return guarded.error;
		await setUserRole(db, guarded.target.id, role);
		return { ok: `@${guarded.target.github_login} is now ${role === 'admin' ? 'an admin' : 'a member'}.` };
	},

	disable: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const id = parseId(data);
		const guarded = await loadAndGuard(db, event.locals.user!, id, 'disable', undefined);
		if ('error' in guarded) return guarded.error;
		await setUserDisabled(db, guarded.target.id, true);
		return { ok: `Disabled @${guarded.target.github_login}.` };
	},

	enable: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const id = parseId(data);
		const guarded = await loadAndGuard(db, event.locals.user!, id, 'enable', undefined);
		if ('error' in guarded) return guarded.error;
		await setUserDisabled(db, guarded.target.id, false);
		return { ok: `Enabled @${guarded.target.github_login}.` };
	},

	// #211: admins can only generate a password for someone else — never see or choose one.
	generatePassword: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const guarded = await loadAndGuard(db, event.locals.user!, parseId(data), 'generatePassword', undefined);
		if ('error' in guarded) return guarded.error;
		const password = await issueGeneratedPassword(db, guarded.target.id);
		return {
			ok: `New password generated for @${guarded.target.github_login}.`,
			generated: { login: guarded.target.github_login, password }
		};
	},

	clearPassword: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const guarded = await loadAndGuard(db, event.locals.user!, parseId(data), 'clearPassword', undefined);
		if ('error' in guarded) return guarded.error;
		await clearUserPassword(db, guarded.target.id, credentialStamp());
		return { ok: `Cleared @${guarded.target.github_login}'s password — GitHub sign-in only.` };
	},

	// #639: invitations by email — the person sets their own name and password at /invite/<token>.
	invite: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '');
		const res = await sendInvite(
			db,
			accountEnv(event),
			{ email, role: parseRole(data), actor: event.locals?.user ?? null, ip: requestIp(event) }
		);
		if (!res.ok) return fail(res.status, { error: res.error, inviteEmail: email });
		return { ok: res.message };
	},

	resendInvite: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const res = await resendInvite(getDB(event), accountEnv(event), {
			id: parseInviteId(data),
			actor: event.locals?.user ?? null,
			ip: requestIp(event)
		});
		if (!res.ok) return fail(res.status, { error: res.error });
		return { ok: res.message };
	},

	revokeInvite: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const res = await revokeInvite(getDB(event), { id: parseInviteId(data), actor: event.locals?.user ?? null });
		if (!res.ok) return fail(res.status, { error: res.error });
		return { ok: res.message };
	},

	// #639: change someone's email. A new address is unverified (no reset mail goes there)
	// until the person opens the link sent to it.
	setEmail: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const guarded = await loadAndGuard(db, event.locals.user!, parseId(data), 'setEmail', undefined);
		if ('error' in guarded) return guarded.error;
		const email = String(data.get('email') ?? '').trim().toLowerCase();
		if (email && (email.length > 254 || !isEmail(email))) return fail(400, { error: "That doesn't look like an email address." });
		const before = (guarded.target.email ?? '').toLowerCase();
		if (email === before) return { ok: 'Nothing changed.' };
		if (!(await setUserEmail(db, guarded.target.id, email))) {
			return fail(400, { error: 'Another user already has that address.' });
		}
		const who = `@${guarded.target.github_login}`;
		if (!email) return { ok: `Removed ${who}'s email.` };
		const sent = await sendVerification(db, accountEnv(event), guarded.target.id);
		return sent.ok
			? { ok: `Email for ${who} changed. A confirmation link went to ${email}.` }
			: { ok: `Email for ${who} changed, but the confirmation email failed: ${sent.error}` };
	},

	remove: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const data = await event.request.formData();
		const id = parseId(data);
		const guarded = await loadAndGuard(db, event.locals.user!, id, 'remove', undefined);
		if ('error' in guarded) return guarded.error;
		await deleteUser(db, guarded.target.id);
		return { ok: `Removed @${guarded.target.github_login}.` };
	}
};

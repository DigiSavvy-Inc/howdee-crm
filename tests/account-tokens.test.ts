import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';

// #639: invitations, password reset and email verification — hashed single-use tokens, expiry,
// cancel-older, the same reset answer for known and unknown addresses, rate limits, the role on
// accept, other sessions ending on reset, and only admins inviting. No email leaves: Postmark's
// sendBatch is replaced, as in the double opt-in tests.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch
}));

import { createSession, sessionPredates, verifySession, SESSION_COOKIE } from '../src/lib/server/auth';
import { sha256Hex } from '../src/lib/server/api-keys';
import { credentialStamp, hashPassword, parseStamp } from '../src/lib/server/password';
import { findActiveUserById, getUserById, setUserEmail, setUserPassword, type SessionUser } from '../src/lib/server/users';
import {
	claimToken,
	issueToken,
	peekToken,
	RATE_LIMITS,
	RESET_MIN_MS,
	RESET_SENT_MESSAGE,
	sendInvite,
	sqlTime,
	TOKEN_TTL_MS
} from '../src/lib/server/account-tokens';
import { actions as resetRequestActions } from '../src/routes/reset/+page.server';
import { load as resetLoad, actions as resetActions } from '../src/routes/reset/[token]/+page.server';
import { load as inviteLoad, actions as inviteActions } from '../src/routes/invite/[token]/+page.server';
import { actions as verifyActions } from '../src/routes/verify/[token]/+page.server';
import { actions as usersActions } from '../src/routes/settings/users/+page.server';

const db = (env as { DB: D1Database }).DB;
const SECRET = 'account-tokens-639';
const GOOD_PASSWORD = 'plum tractor velvet';
const testEnv = { DB: db, SESSION_SECRET: SECRET, POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'from@example.com', PUBLIC_BASE_URL: 'https://crm.test' };

function cookieJar() {
	const jar: Record<string, string | undefined> = {};
	return {
		jar,
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			jar[name] = undefined;
		},
		getAll: () => [],
		serialize: () => ''
	};
}

function event(path: string, opts: { fields?: Record<string, string>; params?: Record<string, string>; user?: SessionUser | null; ip?: string; noLocals?: boolean } = {}) {
	const url = new URL(`https://crm.test${path}`);
	const headers = { 'cf-connecting-ip': opts.ip ?? 'ip-639', origin: 'https://crm.test' };
	let request: Request;
	if (opts.fields) {
		const body = new FormData();
		for (const [k, v] of Object.entries(opts.fields)) body.set(k, v);
		request = new Request(url, { method: 'POST', body, headers });
	} else {
		request = new Request(url, { method: 'GET', headers });
	}
	return {
		request,
		url,
		params: opts.params ?? {},
		platform: { env: testEnv },
		...(opts.noLocals ? {} : { locals: { user: opts.user ?? null, authed: !!opts.user } }),
		cookies: cookieJar(),
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {}
	} as any;
}

const ADMIN: SessionUser = {
	id: 1,
	github_login: 'ourco-admin',
	name: 'Dee Admin',
	avatar_url: null,
	role: 'admin',
	tourSeen: true,
	navLayout: 'top',
	passwordSetAt: null,
	mustChangePassword: false
};

async function makeUser(login: string, email: string | null, role: 'admin' | 'member' = 'member', verified = true): Promise<number> {
	const res = await db
		.prepare(`INSERT INTO users (github_login, role, email, email_verified_at) VALUES (?, ?, ?, ?)`)
		.bind(login, role, email, verified ? sqlTime(Date.now()) : null)
		.run();
	return res.meta.last_row_id as number;
}

/** The token in the last email handed to Postmark, for `kind`'s path. */
function lastToken(kind: 'invite' | 'reset' | 'verify'): string {
	const calls = spies.sendBatch.mock.calls;
	const msgs = calls[calls.length - 1][1] as { TextBody: string; To: string }[];
	const m = new RegExp(`/${kind}/([A-Za-z0-9_-]{43})`).exec(msgs[0].TextBody);
	if (!m) throw new Error(`no ${kind} token in the email`);
	return m[1];
}

function sentTo(): string[] {
	return spies.sendBatch.mock.calls.flatMap((c) => (c[1] as { To: string }[]).map((m) => m.To));
}

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.prepare(`DELETE FROM account_tokens`).run();
	await db.prepare(`DELETE FROM account_token_events`).run();
	await db.prepare(`DELETE FROM login_attempts`).run();
	await db.prepare(`DELETE FROM users WHERE id != 1`).run();
});

describe('#639 tokens', () => {
	it('stores only the SHA-256 of the token, never the token', async () => {
		const id = await makeUser('hash-user', 'hash@example.com');
		const t = await issueToken(db, { kind: 'reset', email: 'hash@example.com', userId: id });
		expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const row = await db.prepare(`SELECT * FROM account_tokens WHERE id = ?`).bind(t.id).first<Record<string, unknown>>();
		expect(row!.token_hash).toBe(await sha256Hex(t.token));
		expect(Object.values(row!)).not.toContain(t.token);
	});

	it('is single use', async () => {
		const id = await makeUser('once-user', 'once@example.com');
		const t = await issueToken(db, { kind: 'verify', email: 'once@example.com', userId: id });
		const peek = await peekToken(db, 'verify', t.token);
		expect(peek.ok).toBe(true);
		expect(await claimToken(db, t.id)).toBe(true);
		expect(await claimToken(db, t.id)).toBe(false);
		expect(await peekToken(db, 'verify', t.token)).toEqual({ ok: false, reason: 'used' });
	});

	it('expires: reset after 1 hour, invite after 7 days, verify after 24 hours', async () => {
		const now = Date.now();
		const id = await makeUser('exp-user', 'exp@example.com');
		const reset = await issueToken(db, { kind: 'reset', email: 'exp@example.com', userId: id, now: now - TOKEN_TTL_MS.reset - 1000 });
		expect(await peekToken(db, 'reset', reset.token)).toEqual({ ok: false, reason: 'expired' });
		expect(await claimToken(db, reset.id)).toBe(false);

		const invite = await issueToken(db, { kind: 'invite', email: 'new@example.com', role: 'member', now: now - 6 * 24 * 3600_000 });
		expect((await peekToken(db, 'invite', invite.token)).ok).toBe(true);
		const oldInvite = await issueToken(db, { kind: 'invite', email: 'other@example.com', role: 'member', now: now - TOKEN_TTL_MS.invite - 1000 });
		expect(await peekToken(db, 'invite', oldInvite.token)).toEqual({ ok: false, reason: 'expired' });

		const verify = await issueToken(db, { kind: 'verify', email: 'exp@example.com', userId: id, now: now - 23 * 3600_000 });
		expect((await peekToken(db, 'verify', verify.token)).ok).toBe(true);
	});

	it('a new token of a kind cancels the older unused ones for that user or address', async () => {
		const id = await makeUser('cancel-user', 'cancel@example.com');
		const first = await issueToken(db, { kind: 'reset', email: 'cancel@example.com', userId: id });
		const keep = await issueToken(db, { kind: 'verify', email: 'cancel@example.com', userId: id });
		const second = await issueToken(db, { kind: 'reset', email: 'cancel@example.com', userId: id });
		expect(await peekToken(db, 'reset', first.token)).toEqual({ ok: false, reason: 'used' });
		expect((await peekToken(db, 'reset', second.token)).ok).toBe(true);
		expect((await peekToken(db, 'verify', keep.token)).ok).toBe(true); // other kinds untouched
	});

	it('refuses a token of another kind, and junk', async () => {
		const id = await makeUser('kind-user', 'kind@example.com');
		const t = await issueToken(db, { kind: 'verify', email: 'kind@example.com', userId: id });
		expect(await peekToken(db, 'reset', t.token)).toEqual({ ok: false, reason: 'invalid' });
		expect(await peekToken(db, 'reset', 'nope')).toEqual({ ok: false, reason: 'invalid' });
	});
});

describe('#639 password reset', () => {
	async function ask(email: string, ip = 'ip-reset') {
		const start = Date.now();
		const res = await resetRequestActions.default(event('/reset', { fields: { email }, ip }));
		return { res, ms: Date.now() - start };
	}

	it('answers known and unknown addresses with the same sentence, and only mails the verified user', async () => {
		await makeUser('known-user', 'known@example.com');
		const known = await ask('known@example.com');
		const unknown = await ask('nobody@example.com');
		expect(known.res).toEqual({ sent: RESET_SENT_MESSAGE });
		expect(unknown.res).toEqual(known.res);
		expect(known.ms).toBeGreaterThanOrEqual(RESET_MIN_MS - 5);
		expect(unknown.ms).toBeGreaterThanOrEqual(RESET_MIN_MS - 5);
		expect(sentTo()).toEqual(['known@example.com']);
	});

	it('never sends to an unverified address', async () => {
		await makeUser('unverified-user', 'unverified@example.com', 'member', false);
		const r = await ask('unverified@example.com');
		expect(r.res).toEqual({ sent: RESET_SENT_MESSAGE });
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('rate-limits requests per address (same answer, no more mail)', async () => {
		await makeUser('limit-user', 'limit@example.com');
		for (let i = 0; i < RATE_LIMITS.reset.perKey + 1; i++) {
			const r = await ask('limit@example.com', `ip-${i}`);
			expect(r.res).toEqual({ sent: RESET_SENT_MESSAGE });
		}
		expect(spies.sendBatch).toHaveBeenCalledTimes(RATE_LIMITS.reset.perKey);
	});

	it('rate-limits requests per IP', async () => {
		for (let i = 0; i < RATE_LIMITS.reset.perIp; i++) {
			await db.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES (?, 'busy-ip', 2)`).bind(`reset:x${i}`).run();
		}
		await makeUser('ip-user', 'ip@example.com');
		await ask('ip@example.com', 'busy-ip');
		expect(spies.sendBatch).not.toHaveBeenCalled();
	});

	it('sets the new password, ends the other sessions and signs the user in', async () => {
		const id = await makeUser('reset-user', 'reset@example.com');
		await setUserPassword(db, id, await hashPassword('old password value'), false, credentialStamp(Date.now() - 60_000));
		const oldSession = await verifySession(SECRET, await createSession(SECRET, id));
		await ask('reset@example.com');
		const token = lastToken('reset');

		const loaded = await resetLoad(event(`/reset/${token}`, { params: { token } }));
		expect(loaded).toMatchObject({ ready: true });

		const ev = event(`/reset/${token}`, { params: { token }, fields: { password: GOOD_PASSWORD, confirm: GOOD_PASSWORD } });
		let redirected = false;
		try {
			await resetActions.default(ev);
		} catch (e) {
			redirected = isRedirect(e);
		}
		expect(redirected).toBe(true);
		const user = await findActiveUserById(db, id);
		const stamp = parseStamp(user!.passwordSetAt);
		expect(sessionPredates(oldSession!.issuedAt, stamp)).toBe(true); // the old session is out
		const fresh = await verifySession(SECRET, ev.cookies.jar[SESSION_COOKIE]);
		expect(fresh?.userId).toBe(id);
		expect(sessionPredates(fresh!.issuedAt, stamp)).toBe(false); // the new one survives

		// Single use: the same link again is dead.
		const again = await resetActions.default(event(`/reset/${token}`, { params: { token }, fields: { password: GOOD_PASSWORD, confirm: GOOD_PASSWORD } }));
		expect((again as { status: number }).status).toBe(400);
	});

	it('applies the password rules', async () => {
		const id = await makeUser('rules-user', 'rules@example.com');
		const t = await issueToken(db, { kind: 'reset', email: 'rules@example.com', userId: id });
		const res = await resetActions.default(event(`/reset/${t.token}`, { params: { token: t.token }, fields: { password: 'short', confirm: 'short' } }));
		expect((res as { status: number }).status).toBe(400);
		expect((await peekToken(db, 'reset', t.token)).ok).toBe(true); // not used up by a refusal
	});

	it('rate-limits bad token links per IP', async () => {
		for (let i = 0; i < RATE_LIMITS.open.perIp; i++) {
			await resetLoad(event('/reset/bad', { params: { token: `bad-${i}` }, ip: 'guess-ip' }));
		}
		const id = await makeUser('open-user', 'open@example.com');
		const t = await issueToken(db, { kind: 'reset', email: 'open@example.com', userId: id });
		const blocked = await resetLoad(event(`/reset/${t.token}`, { params: { token: t.token }, ip: 'guess-ip' }));
		expect(blocked).toMatchObject({ ready: false });
		const fine = await resetLoad(event(`/reset/${t.token}`, { params: { token: t.token }, ip: 'other-ip' }));
		expect(fine).toMatchObject({ ready: true });
	});
});

describe('#639 invitations', () => {
	it('a non-admin cannot invite', async () => {
		const member: SessionUser = { ...ADMIN, id: 99, github_login: 'member', role: 'member' };
		for (const ev of [
			event('/settings/users', { fields: { email: 'x@example.com', role: 'member' }, user: member }),
			event('/settings/users', { fields: { email: 'x@example.com', role: 'member' }, noLocals: true })
		]) {
			let status = 0;
			try {
				await usersActions.invite(ev);
			} catch (e) {
				if (isHttpError(e)) status = e.status;
			}
			expect(status).toBe(403);
		}
		const direct = await sendInvite(db, testEnv, { email: 'x@example.com', role: 'admin', actor: member, ip: 'i' });
		expect(direct).toMatchObject({ ok: false, status: 403 });
		expect(spies.sendBatch).not.toHaveBeenCalled();
		const n = await db.prepare(`SELECT COUNT(*) AS n FROM account_tokens`).first<{ n: number }>();
		expect(n!.n).toBe(0);
	});

	it('invites, lists, and the accepted account gets the invited role and a verified email', async () => {
		const sent = await usersActions.invite(event('/settings/users', { fields: { email: 'New.Admin@Example.com', role: 'admin' }, user: ADMIN }));
		expect(sent).toMatchObject({ ok: expect.stringContaining('new.admin@example.com') });
		expect(sentTo()).toEqual(['new.admin@example.com']);
		const token = lastToken('invite');

		const loaded = await inviteLoad(event(`/invite/${token}`, { params: { token } }));
		expect(loaded).toMatchObject({ ready: true, email: 'new.admin@example.com', role: 'admin' });

		const ev = event(`/invite/${token}`, {
			params: { token },
			fields: { name: 'New Admin', password: GOOD_PASSWORD, confirm: GOOD_PASSWORD, github_login: '' }
		});
		let redirected = false;
		try {
			await inviteActions.default(ev);
		} catch (e) {
			redirected = isRedirect(e);
		}
		expect(redirected).toBe(true);
		const session = await verifySession(SECRET, ev.cookies.jar[SESSION_COOKIE]);
		const user = await getUserById(db, session!.userId);
		expect(user).toMatchObject({ role: 'admin', email: 'new.admin@example.com', github_login: 'new.admin@example.com', name: 'New Admin' });
		expect(user!.email_verified_at).toBeTruthy();
		expect(user!.has_password).toBe(1);
		expect(await peekToken(db, 'invite', token)).toEqual({ ok: false, reason: 'used' });
	});

	it('a member invite makes a member; resend replaces the link; revoke kills it', async () => {
		await usersActions.invite(event('/settings/users', { fields: { email: 'mem@example.com', role: 'member' }, user: ADMIN }));
		const first = lastToken('invite');
		const row = await db.prepare(`SELECT id FROM account_tokens WHERE kind = 'invite' AND cancelled_at IS NULL`).first<{ id: number }>();
		await usersActions.resendInvite(event('/settings/users', { fields: { invite_id: String(row!.id) }, user: ADMIN }));
		const second = lastToken('invite');
		expect(second).not.toBe(first);
		expect(await peekToken(db, 'invite', first)).toEqual({ ok: false, reason: 'used' });
		const pending = await db.prepare(`SELECT id, role FROM account_tokens WHERE kind = 'invite' AND cancelled_at IS NULL`).first<{ id: number; role: string }>();
		expect(pending!.role).toBe('member');
		await usersActions.revokeInvite(event('/settings/users', { fields: { invite_id: String(pending!.id) }, user: ADMIN }));
		expect(await peekToken(db, 'invite', second)).toEqual({ ok: false, reason: 'used' });
	});

	it('refuses to invite an address that is already a user, and rate-limits per address', async () => {
		await makeUser('taken-user', 'taken@example.com');
		const taken = await sendInvite(db, testEnv, { email: 'taken@example.com', role: 'member', actor: ADMIN, ip: 'a' });
		expect(taken).toMatchObject({ ok: false, status: 400 });
		for (let i = 0; i < RATE_LIMITS.invite.perKey; i++) {
			expect((await sendInvite(db, testEnv, { email: 'spam@example.com', role: 'member', actor: ADMIN, ip: `a${i}` })).ok).toBe(true);
		}
		const over = await sendInvite(db, testEnv, { email: 'spam@example.com', role: 'member', actor: ADMIN, ip: 'z' });
		expect(over).toMatchObject({ ok: false, status: 429 });
	});

	it('the stored campaign copy never holds the link', async () => {
		await sendInvite(db, testEnv, { email: 'copy@example.com', role: 'member', actor: ADMIN, ip: 'c' });
		const token = lastToken('invite');
		const row = await db
			.prepare(`SELECT body_html, body_text FROM campaigns ORDER BY id DESC LIMIT 1`)
			.first<{ body_html: string; body_text: string }>();
		expect(row!.body_html).not.toContain(token);
		expect(row!.body_text).not.toContain(token);
	});
});

describe('#639 email verification', () => {
	it('an admin-changed email is unverified until its link is opened, and gets no reset mail meanwhile', async () => {
		const id = await makeUser('change-user', 'old@example.com');
		const res = await usersActions.setEmail(event('/settings/users', { fields: { id: String(id), email: 'fresh@example.com' }, user: ADMIN }));
		expect(res).toMatchObject({ ok: expect.stringContaining('fresh@example.com') });
		let user = await getUserById(db, id);
		expect(user).toMatchObject({ email: 'fresh@example.com', email_verified_at: null });
		const token = lastToken('verify');

		spies.sendBatch.mockClear();
		await resetRequestActions.default(event('/reset', { fields: { email: 'fresh@example.com' } }));
		expect(spies.sendBatch).not.toHaveBeenCalled();

		const done = await verifyActions.default(event(`/verify/${token}`, { params: { token }, fields: {} }));
		expect(done).toMatchObject({ verified: true });
		user = await getUserById(db, id);
		expect(user!.email_verified_at).toBeTruthy();
	});

	it('a verify link for an address the account no longer has does nothing', async () => {
		const id = await makeUser('moved-user', 'a@example.com', 'member', false);
		const t = await issueToken(db, { kind: 'verify', email: 'a@example.com', userId: id });
		await setUserEmail(db, id, 'b@example.com');
		const res = await verifyActions.default(event(`/verify/${t.token}`, { params: { token: t.token }, fields: {} }));
		expect((res as { status: number }).status).toBe(400);
		expect((await getUserById(db, id))!.email_verified_at).toBeNull();
	});
});

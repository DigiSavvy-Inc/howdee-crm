import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { googleConfigured } from '$lib/server/gmail';
import { isValidKey } from '$lib/server/crypto-box';
import {
	disconnectMailAccount,
	getMailAccount,
	getInternalDomains,
	gmailInConversations,
	mailStatus,
	refilterStoredMail,
	setGmailInConversations,
	setInternalDomains,
	setMailPaused,
	syncMailAccount
} from '$lib/server/mail-sync';
import { domainOf, parseDomainList } from '$lib/mail-filter';

// Settings → Mail (#158): connect a Gmail mailbox (/auth/google), see its sync state, pause
// it, sync now, disconnect (revoke + delete). #443: Internal domains (never a conversation)
// and "Show Gmail threads in Conversations".
// #585: every signed-in user connects and manages their own mailbox, so replies sent from any
// teammate's Gmail reach the conversations. Admins see, pause and disconnect every mailbox and
// alone change Internal domains and the Conversations switch.

function requireAdmin(locals: App.Locals | undefined) {
	if (locals?.user?.role !== 'admin') throw error(403, 'Admins only.');
}

function requireUser(locals: App.Locals | undefined) {
	const user = locals?.user ?? null;
	if (!user) throw error(403, 'Sign in first.');
	return user;
}

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event.locals);
	const isAdmin = user.role === 'admin';
	const env = event.platform?.env;
	const db = getDB(event);
	const accounts = await mailStatus(db, isAdmin ? {} : { userId: user.id });
	let internalDomains: string | null = null;
	if (isAdmin) {
		const saved = await getInternalDomains(db);
		internalDomains = (saved ?? [...new Set(accounts.map((a) => domainOf(a.email)).filter(Boolean))]).join(', ');
	}
	return {
		isAdmin,
		googleConfigured: googleConfigured(env),
		tokenKeyReady: isValidKey(env?.MAIL_TOKEN_KEY),
		accounts,
		internalDomains,
		inConversations: await gmailInConversations(db),
		redirectUri: `${event.url.origin}/auth/google/callback`,
		connected: event.url.searchParams.get('connected') === '1',
		error: event.url.searchParams.get('error')
	};
};

/** The posted mailbox, when the user may act on it: an admin any, a member only their own. */
async function accountFrom(event: Parameters<Actions[string]>[0]) {
	const user = requireUser(event.locals);
	const data = await event.request.formData();
	const id = Number(data.get('account_id'));
	if (user.role !== 'admin') {
		const acct = Number.isInteger(id) && id > 0 ? await getMailAccount(getDB(event), id) : null;
		if (!acct || acct.user_id !== user.id) throw error(403, 'You can only manage the mailbox you connected.');
	}
	if (!Number.isInteger(id) || id <= 0) return { err: fail(400, { error: 'Unknown mailbox.' }) } as const;
	return { id, data } as const;
}

export const actions: Actions = {
	pause: async (event) => {
		const r = await accountFrom(event);
		if ('err' in r) return r.err;
		const paused = r.data.get('paused') === '1';
		if (!(await setMailPaused(getDB(event), r.id, paused))) return fail(404, { error: 'Unknown mailbox.' });
		return { paused };
	},

	sync: async (event) => {
		const r = await accountFrom(event);
		if ('err' in r) return r.err;
		const db = getDB(event);
		// #443: re-apply the internal / automated rules to what is already stored first.
		const purged = await refilterStoredMail(db, event.platform?.env?.MEDIA);
		const res = await syncMailAccount(db, event.platform?.env ?? {}, r.id, { fetch: event.fetch, force: true });
		if (res.skipped === 'locked') return fail(409, { error: 'A sync is already running — try again in a minute.' });
		if (res.error) return fail(502, { error: res.error });
		return { synced: { scanned: res.scanned, stored: res.stored, done: !!res.done, purged } };
	},

	internalDomains: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const domains = parseDomainList(String(data.get('internal_domains') ?? '').slice(0, 2000));
		const db = getDB(event);
		await setInternalDomains(db, domains);
		const purged = await refilterStoredMail(db, event.platform?.env?.MEDIA);
		return { domainsSaved: domains, purged };
	},

	inConversations: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const on = data.get('on') === '1';
		await setGmailInConversations(getDB(event), on);
		return { inConversations: on };
	},

	disconnect: async (event) => {
		const r = await accountFrom(event);
		if ('err' in r) return r.err;
		const env = event.platform?.env;
		const res = await disconnectMailAccount(getDB(event), env ?? {}, r.id, { fetch: event.fetch, media: env?.MEDIA });
		if (!res.removed) return fail(404, { error: 'Unknown mailbox.' });
		return { disconnected: true, revoked: res.revoked };
	}
};

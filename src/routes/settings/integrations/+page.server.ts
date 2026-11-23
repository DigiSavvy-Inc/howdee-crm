import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	clearProbe,
	getProvider,
	integrationsStatus,
	recentSyncs,
	runProviderSync,
	testConnection,
	type IntegrationEnv
} from '$lib/server/integrations';
import {
	cleanToken,
	deleteSecret,
	isTokenProvider,
	loadZohoEnv,
	readZohoOrg,
	removeProviderToken,
	setProviderToken,
	storeSecret,
	tokenKeyReady,
	ZOHO_PROVIDER
} from '$lib/server/integrations/secrets';
import {
	cachedOrganizations,
	chooseOrganization,
	clearZohoState,
	exchangeGrantCode,
	fetchOrganizations,
	memberAccessOn,
	setMemberAccess,
	ZOHO_DCS,
	ZOHO_SCOPES
} from '$lib/server/integrations/zoho';

// Settings → Integrations (#167). Admin-only, like Users. Tokens are entered here and stored
// encrypted with MAIL_TOKEN_KEY (#175), or set as Worker secrets (the fallback). Neither the
// token nor its sealed blob is ever returned to the page — only its last 4 characters.

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

function integrationEnv(platform: App.Platform | undefined): IntegrationEnv {
	return {
		TIMING_API_TOKEN: platform?.env?.TIMING_API_TOKEN,
		GITHUB_TOKEN: platform?.env?.GITHUB_TOKEN,
		MAIL_TOKEN_KEY: platform?.env?.MAIL_TOKEN_KEY
	};
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event.locals);
	const db = getDB(event);
	const env = integrationEnv(event.platform);
	const zenv = await loadZohoEnv(db, env.MAIL_TOKEN_KEY);
	return {
		providers: await integrationsStatus(db, env),
		syncs: await recentSyncs(db, 20),
		tokenKeyReady: tokenKeyReady(env),
		// Zoho Books (#353): never the client secret or refresh token — the data center, the
		// org choice and the cached org list only (client id last 4 is on the provider's token row).
		zoho: {
			connected: !!zenv,
			dc: zenv?.dc ?? null,
			org: await readZohoOrg(db),
			orgs: zenv ? await cachedOrganizations(db) : [],
			memberAccess: await memberAccessOn(db),
			dcs: [...ZOHO_DCS],
			scopes: ZOHO_SCOPES
		}
	};
};

async function providerFrom(event: Parameters<Actions[string]>[0]) {
	requireAdmin(event.locals);
	const data = await event.request.formData();
	const id = String(data.get('provider') ?? '');
	const provider = getProvider(id);
	if (!provider) return { err: fail(400, { error: 'Unknown integration.' }) } as const;
	return { provider, data } as const;
}

export const actions: Actions = {
	test: async (event) => {
		const r = await providerFrom(event);
		if ('err' in r) return r.err;
		const env = integrationEnv(event.platform);
		const probe = await testConnection(getDB(event), env, r.provider);
		if (!probe) return fail(400, { provider: r.provider.provider, error: 'No token is set.' });
		return { provider: r.provider.provider, probe };
	},

	sync: async (event) => {
		const r = await providerFrom(event);
		if ('err' in r) return r.err;
		const env = integrationEnv(event.platform);
		const result = await runProviderSync(getDB(event), env, r.provider, 'manual');
		if ('skipped' in result) {
			const msg =
				result.skipped === 'locked' ? 'A sync is already running — try again in a minute.' : 'No token is set.';
			return fail(409, { provider: r.provider.provider, error: msg });
		}
		return { provider: r.provider.provider, synced: result.ok };
	},

	// Save an in-app token (#175): seal + store, then probe right away so the card shows the
	// real state. Failure payloads never carry the submitted value.
	setToken: async (event) => {
		const r = await providerFrom(event);
		if ('err' in r) return r.err;
		const p = r.provider.provider;
		if (!isTokenProvider(p)) return fail(400, { provider: p, error: 'This integration connects with its own form.' });
		const env = integrationEnv(event.platform);
		if (!tokenKeyReady(env)) {
			return fail(400, { provider: p, error: 'Set MAIL_TOKEN_KEY to enable in-app tokens.' });
		}
		const cleaned = cleanToken(String(r.data.get('token') ?? ''));
		if (!cleaned.ok) return fail(400, { provider: p, error: cleaned.error });
		const db = getDB(event);
		const { last4 } = await setProviderToken(db, env, p, cleaned.token, event.locals.user?.id ?? null);
		const probe = await testConnection(db, env, r.provider, event.fetch);
		return { provider: p, tokenSaved: last4, probe };
	},

	// Remove the in-app token; the Worker secret (if any) takes over and is probed.
	removeToken: async (event) => {
		const r = await providerFrom(event);
		if ('err' in r) return r.err;
		const p = r.provider.provider;
		if (!isTokenProvider(p)) return fail(400, { provider: p, error: 'This integration connects with its own form.' });
		const db = getDB(event);
		const env = integrationEnv(event.platform);
		await removeProviderToken(db, p);
		await clearProbe(db, p);
		const probe = await testConnection(db, env, r.provider, event.fetch);
		return { provider: p, tokenRemoved: true, fallback: probe !== null };
	},

	// ---- Zoho Books (#353) ----
	// Connect: exchange the Self Client grant code for a refresh token, seal the config, then
	// list the organizations for the picker. Failure payloads never echo the submitted values.
	zohoConnect: async (event) => {
		requireAdmin(event.locals);
		const env = integrationEnv(event.platform);
		const p = ZOHO_PROVIDER;
		if (!tokenKeyReady(env)) return fail(400, { provider: p, error: 'Set MAIL_TOKEN_KEY to connect Zoho Books.' });
		const data = await event.request.formData();
		const res = await exchangeGrantCode({
			dc: String(data.get('dc') ?? ''),
			client_id: String(data.get('client_id') ?? ''),
			client_secret: String(data.get('client_secret') ?? ''),
			code: String(data.get('code') ?? '')
		});
		if (!res.ok) return fail(400, { provider: p, error: res.error });
		const db = getDB(event);
		await storeSecret(db, env.MAIL_TOKEN_KEY, p, JSON.stringify(res.creds), event.locals.user?.id ?? null, {
			last4: res.creds.client_id.slice(-4)
		});
		await clearProbe(db, p);
		try {
			const orgs = await fetchOrganizations(db, res.creds);
			if (orgs.length === 1) await chooseOrganization(db, orgs[0].id);
			return { provider: p, zohoConnected: true, orgCount: orgs.length };
		} catch (e) {
			return { provider: p, zohoConnected: true, orgError: `Connected, but the organizations couldn't be listed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` };
		}
	},

	zohoOrgs: async (event) => {
		requireAdmin(event.locals);
		const env = integrationEnv(event.platform);
		const db = getDB(event);
		const z = await loadZohoEnv(db, env.MAIL_TOKEN_KEY);
		if (!z) return fail(400, { provider: ZOHO_PROVIDER, error: 'Zoho Books is not connected.' });
		try {
			const orgs = await fetchOrganizations(db, z);
			return { provider: ZOHO_PROVIDER, orgCount: orgs.length };
		} catch (e) {
			return fail(502, { provider: ZOHO_PROVIDER, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
		}
	},

	zohoOrg: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const db = getDB(event);
		const org = await chooseOrganization(db, String(data.get('organization_id') ?? ''));
		if (!org) return fail(400, { provider: ZOHO_PROVIDER, error: 'Pick one of the listed organizations.' });
		await clearProbe(db, ZOHO_PROVIDER);
		return { provider: ZOHO_PROVIDER, orgSaved: org.name };
	},

	// Disconnect: drop the sealed config + org choice. Links and mirrored rows stay, so
	// reconnecting the same organization picks up where it left off.
	zohoDisconnect: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		await deleteSecret(db, ZOHO_PROVIDER);
		await clearZohoState(db);
		await clearProbe(db, ZOHO_PROVIDER);
		return { provider: ZOHO_PROVIDER, zohoDisconnected: true };
	},

	zohoAccess: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		await setMemberAccess(getDB(event), data.get('member_access') === '1');
		return { provider: ZOHO_PROVIDER, accessSaved: true };
	}
};

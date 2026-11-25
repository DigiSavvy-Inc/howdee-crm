import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	attachDomain,
	checkDomainStatus,
	clearCustomDomain,
	readDomainConfig,
	resolveBaseUrl,
	saveCustomDomain,
	setRedirect,
	validateHostname,
	workerName
} from '$lib/server/public-url';

// Settings → Domain (#120). Admin-only: the app's public hostname (app_state custom_domain),
// a reachability check, attach-to-Worker (CF_API_TOKEN) or dashboard steps, and the
// "Redirect other hosts" switch read by hooks.server.ts.

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event.locals);
	const cfg = await readDomainConfig(getDB(event));
	const env = event.platform?.env as { PUBLIC_BASE_URL?: string; CF_API_TOKEN?: string } | undefined;
	const effective = resolveBaseUrl(cfg.domain, env?.PUBLIC_BASE_URL, event.url.origin, cfg.seen);
	return {
		domain: cfg.domain,
		redirect: cfg.redirect,
		status: cfg.status && cfg.status.domain === cfg.domain ? cfg.status : null,
		effective,
		envBase: env?.PUBLIC_BASE_URL?.trim() || null,
		requestHost: event.url.hostname,
		hasToken: !!env?.CF_API_TOKEN?.trim(),
		service: workerName(event.platform?.env) || 'your Worker'
	};
};

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const v = validateHostname(data.get('hostname'));
		if (!v.ok) return fail(400, { action: 'save', error: v.error, hostname: String(data.get('hostname') ?? '') });
		await saveCustomDomain(getDB(event), v.hostname);
		return { action: 'save', saved: true };
	},

	clear: async (event) => {
		requireAdmin(event.locals);
		await clearCustomDomain(getDB(event));
		return { action: 'clear', cleared: true };
	},

	status: async (event) => {
		requireAdmin(event.locals);
		const db = getDB(event);
		const cfg = await readDomainConfig(db);
		if (!cfg.domain) return fail(400, { action: 'status', error: 'Save a custom domain first.' });
		const status = await checkDomainStatus(db, cfg.domain);
		return { action: 'status', status };
	},

	attach: async (event) => {
		requireAdmin(event.locals);
		const cfg = await readDomainConfig(getDB(event));
		if (!cfg.domain) return fail(400, { action: 'attach', error: 'Save a custom domain first.' });
		const attach = await attachDomain(cfg.domain, event.platform?.env);
		return { action: 'attach', attach };
	},

	redirect: async (event) => {
		requireAdmin(event.locals);
		const on = (await event.request.formData()).get('redirect') === 'on';
		const res = await setRedirect(getDB(event), on);
		if (!res.ok) return fail(400, { action: 'redirect', error: res.error });
		return { action: 'redirect', redirect: on };
	}
};

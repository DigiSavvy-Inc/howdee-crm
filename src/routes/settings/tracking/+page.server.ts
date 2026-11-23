import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { siteTrackingLinksEnabled } from '$lib/server/site-tracking';
import {
	addSite,
	listSites,
	rotateSiteKey,
	setSiteEnabled,
	siteStatus,
	updateSite,
	validateSiteForm
} from '$lib/server/tracking-admin';
import { DISABLED_SNIPPET } from '$lib/tracking-snippet';

// Settings → Tracking (#152). Admin-only, like Users and Integrations: sites, their
// public keys, the paste-ready snippet, a live status check, and the global
// "Decorate email links" switch (app_state `site_tracking_links`, read by the send path).

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event.locals);
	const db = getDB(event);
	return {
		sites: await listSites(db),
		linksEnabled: await siteTrackingLinksEnabled(db),
		baseUrl: await publicBaseUrlFor(event)
	};
};

function siteId(data: FormData): number | null {
	const id = Number(data.get('id'));
	return Number.isInteger(id) && id > 0 ? id : null;
}

export const actions: Actions = {
	add: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const v = validateSiteForm(data);
		if (!v.ok) return fail(400, { action: 'add', error: v.error });
		const { id } = await addSite(getDB(event), v.value);
		return { action: 'add', id, added: true };
	},

	update: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const id = siteId(data);
		if (!id) return fail(400, { action: 'update', error: 'Unknown site.' });
		const v = validateSiteForm(data);
		if (!v.ok) return fail(400, { action: 'update', id, error: v.error });
		if (!(await updateSite(getDB(event), id, v.value))) return fail(404, { action: 'update', id, error: 'Unknown site.' });
		return { action: 'update', id, saved: true };
	},

	toggle: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const id = siteId(data);
		const enabled = data.get('enabled') === '1';
		if (!id || !(await setSiteEnabled(getDB(event), id, enabled))) {
			return fail(404, { action: 'toggle', id, error: 'Unknown site.' });
		}
		return { action: 'toggle', id, enabled };
	},

	rotate: async (event) => {
		requireAdmin(event.locals);
		const id = siteId(await event.request.formData());
		const key = id ? await rotateSiteKey(getDB(event), id) : null;
		if (!key) return fail(404, { action: 'rotate', id, error: 'Unknown site.' });
		return { action: 'rotate', id, rotated: true };
	},

	setLinks: async (event) => {
		requireAdmin(event.locals);
		const on = (await event.request.formData()).get('links') === 'on';
		await getDB(event)
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES ('site_tracking_links', ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(on ? 'on' : 'off')
			.run();
		return { action: 'setLinks', linksEnabled: on };
	},

	/** Fetch the site's own /t.js (proves the tag URL works) and report recent events. */
	status: async (event) => {
		requireAdmin(event.locals);
		const id = siteId(await event.request.formData());
		const db = getDB(event);
		const site = id
			? await db.prepare('SELECT site_key FROM tracking_sites WHERE id = ?').bind(id).first<{ site_key: string }>()
			: null;
		if (!id || !site) return fail(404, { action: 'status', id, error: 'Unknown site.' });

		let snippet: 'ok' | 'disabled' | 'error' = 'error';
		try {
			const res = await event.fetch(`/t.js?k=${encodeURIComponent(site.site_key)}`);
			const text = res.ok ? await res.text() : '';
			snippet = !res.ok ? 'error' : text === DISABLED_SNIPPET ? 'disabled' : 'ok';
		} catch {
			snippet = 'error';
		}
		const status = await siteStatus(db, id);
		return { action: 'status', id, snippet, ...status!, checkedAt: new Date().toISOString() };
	}
};

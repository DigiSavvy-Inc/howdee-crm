import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { getArchiveSettings, publishedForAdmin, saveArchiveSettings, unpublishIssue } from '$lib/server/newsletter-archive';
import { getForm } from '$lib/server/forms';
import { plainFormProblem } from '$lib/server/form-plain';
import { ARCHIVE_PATH, WEB_TEMPLATE_KIND } from '$lib/newsletter-archive';
import {
	archiveRouteHosts,
	clearPublicHost,
	crmBases,
	proxySnippets,
	readArchivePublicConfig,
	recordBrowserTest,
	removeProxySecret,
	rotateProxySecret,
	savePublicHost,
	setArchiveRedirect,
	testPublicConnection,
	validatePublicHost
} from '$lib/server/archive-public';

// #481: Settings → Newsletter archive (admin-only load + every action).
const adminOnly = (event: { locals: App.Locals }) => event.locals?.user?.role === 'admin';

export const load: PageServerLoad = async (event) => {
	if (!adminOnly(event)) throw error(403, 'Only an admin can manage the newsletter archive.');
	const db = getDB(event);
	const [settings, issues, templates, groups] = await Promise.all([
		getArchiveSettings(db),
		publishedForAdmin(db),
		db.prepare('SELECT id, name FROM templates WHERE kind = ? ORDER BY name COLLATE NOCASE').bind(WEB_TEMPLATE_KIND).all<{ id: number; name: string }>(),
		// Lists (incl. public topics) and segments a broadcast can go to.
		db
			.prepare(
				`SELECT id, name, kind, public_topic, topic_label FROM lists
				 WHERE kind IN ('list', 'segment') ORDER BY kind, name COLLATE NOCASE`
			)
			.all<{ id: number; name: string; kind: string; public_topic: number | null; topic_label: string | null }>()
	]);
	const base = await publicBaseUrlFor(event);
	// #587: published forms for the Subscribe popup, each with why it can't be used (or null).
	const published = await db
		.prepare("SELECT slug FROM forms WHERE status = 'published' ORDER BY name COLLATE NOCASE")
		.all<{ slug: string }>();
	const signupForms: { slug: string; name: string; problem: string | null }[] = [];
	for (const r of published.results) {
		const f = await getForm(db, r.slug);
		if (f) signupForms.push({ slug: f.slug, name: f.name, problem: plainFormProblem(f) });
	}
	// #491: Public address — the archive on another host (example.com/newsletter).
	const pub = await readArchivePublicConfig(db);
	return {
		settings,
		publicHost: {
			routeHosts: archiveRouteHosts(event.platform?.env),
			host: pub.host,
			redirect: pub.redirect,
			status: pub.status,
			statusCurrent: !!pub.status && pub.status.host === pub.host,
			hasSecret: !!pub.secretHash,
			crmUrl: base,
			snippets: proxySnippets(base, null)
		},
		publicUrl: `${base}${ARCHIVE_PATH}`,
		issues: issues.map((i) => ({ ...i, url: `${base}${ARCHIVE_PATH}/${i.slug}` })),
		templates: templates.results,
		signupForms,
		groups: groups.results.map((g) => ({
			id: g.id,
			name: g.public_topic ? `${(g.topic_label ?? '').trim() || g.name} (topic)` : g.kind === 'segment' ? `${g.name} (segment)` : g.name
		}))
	};
};

export const actions: Actions = {
	save: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const templateId = Number(data.get('template_id')) || null;
		const err = await saveArchiveSettings(db, {
			enabled: data.get('enabled') === '1',
			title: String(data.get('title') ?? ''),
			intro: String(data.get('intro') ?? ''),
			subscribeUrl: String(data.get('subscribe_url') ?? ''),
			templateId,
			indexable: data.get('indexable') === '1',
			autoGroups: data.getAll('auto_group').map(Number),
			signupForm: String(data.get('signup_form') ?? '')
		});
		if (err) return fail(400, { error: err });
		return { saved: true };
	},

	// #491: Public address.
	savePublicHost: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const v = validatePublicHost(data.get('host'), await crmBases(db, event.platform?.env));
		if (!v.ok) return fail(400, { hostError: v.error });
		await savePublicHost(db, v.hostname);
		return { hostSaved: true };
	},

	clearPublicHost: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		await clearPublicHost(getDB(event));
		return { hostCleared: true };
	},

	testPublicHost: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const db = getDB(event);
		const cfg = await readArchivePublicConfig(db);
		if (!cfg.host) return fail(400, { hostError: 'Save a public address first.' });
		const status = await testPublicConnection(db, cfg.host);
		return { hostTested: status.ok };
	},

	// #495: Test connection's fallback — the result the admin's browser got fetching the feed.
	recordPublicTest: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const cfg = await readArchivePublicConfig(db);
		if (!cfg.host) return fail(400, { hostError: 'Save a public address first.' });
		const rawCode = String(data.get('code') ?? '').trim();
		const n = Number(rawCode);
		const code = rawCode && Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
		// A pass is the same rule the server-side test applies: a 200 (the page checked the header).
		const ok = data.get('ok') === '1' && code === 200;
		const status = await recordBrowserTest(db, cfg.host, { ok, code });
		return { hostTested: status.ok };
	},

	setPublicRedirect: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const on = (await event.request.formData()).get('on') === '1';
		const res = await setArchiveRedirect(getDB(event), on);
		if (!res.ok) return fail(400, { hostError: res.error });
		return { redirectSaved: on };
	},

	rotateProxySecret: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const db = getDB(event);
		const secret = await rotateProxySecret(db);
		// Shown once: the plaintext lives only in this response.
		return { proxySecret: secret, proxySnippets: proxySnippets(await publicBaseUrlFor(event), secret) };
	},

	removeProxySecret: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		await removeProxySecret(getDB(event));
		return { secretRemoved: true };
	},

	remove: async (event) => {
		if (!adminOnly(event)) return fail(403, { error: 'Only an admin can manage the newsletter archive.' });
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing campaign.' });
		await unpublishIssue(getDB(event), id);
		return { removed: true };
	}
};

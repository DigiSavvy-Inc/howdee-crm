import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const pages = await db
		.prepare('SELECT id, slug, title, published, created_at, updated_at FROM pages ORDER BY updated_at DESC')
		.all<{ id: number; slug: string; title: string; published: number; created_at: string; updated_at: string }>();
	const baseUrl = await publicBaseUrlFor(event);
	return { pages: pages.results, baseUrl };
};

export const actions: Actions = {
	create: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const title = String(data.get('title') ?? '').trim();
		const slug = String(data.get('slug') ?? '').trim().toLowerCase();
		if (!title) return fail(400, { error: 'Give the page a title.' });
		if (!SLUG_RE.test(slug) || slug.length > 60) {
			return fail(400, { error: 'Slug must be lowercase letters/numbers with hyphens (e.g. how-you-signed-up).' });
		}
		const existing = await db.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first<{ id: number }>();
		if (existing) return fail(400, { error: `A page with slug “${slug}” already exists.` });

		const row = await db
			.prepare('INSERT INTO pages (slug, title) VALUES (?, ?) RETURNING id')
			.bind(slug, title)
			.first<{ id: number }>();
		throw redirect(303, `/pages/${row!.id}`);
	},

	delete: async (event) => {
		const db = getDB(event);
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing page.' });
		await db.prepare('DELETE FROM pages WHERE id = ?').bind(id).run();
		return { ok: true };
	}
};

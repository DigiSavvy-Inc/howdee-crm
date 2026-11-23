import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { MAX_PAGE_BLOCKS_JSON, pageBlocksForEditor, readPageBlocks } from '$lib/server/pages';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	if (!id) throw error(404, 'Page not found');

	const page = await db
		.prepare('SELECT id, slug, title, blocks, published, created_at, updated_at FROM pages WHERE id = ?')
		.bind(id)
		.first<{ id: number; slug: string; title: string; blocks: string; published: number; created_at: string; updated_at: string }>();
	if (!page) throw error(404, 'Page not found');

	const baseUrl = await publicBaseUrlFor(event);
	return { page: { ...page, blocks: pageBlocksForEditor(page.blocks) }, baseUrl, wideLayout: true };
};

export const actions: Actions = {
	// Save title/slug/blocks. Blocks arrive as JSON from the visual editor (#261) and are
	// sanitised (allowlisted types/marks/attrs) so malformed input never stores junk.
	save: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const title = String(data.get('title') ?? '').trim();
		const slug = String(data.get('slug') ?? '').trim().toLowerCase();
		const blocks = readPageBlocks(String(data.get('blocks') ?? '[]'));
		const json = JSON.stringify(blocks);
		if (!title) return fail(400, { error: 'Title is required.' });
		if (!SLUG_RE.test(slug) || slug.length > 60) {
			return fail(400, { error: 'Slug must be lowercase letters/numbers with hyphens.' });
		}
		if (json.length > MAX_PAGE_BLOCKS_JSON) return fail(400, { error: 'This page is too long to save. Split it into two pages.' });
		const clash = await db
			.prepare('SELECT id FROM pages WHERE slug = ? AND id != ?')
			.bind(slug, id)
			.first<{ id: number }>();
		if (clash) return fail(400, { error: `Another page already uses slug “${slug}”.` });

		const res = await db
			.prepare("UPDATE pages SET title = ?, slug = ?, blocks = ?, updated_at = datetime('now') WHERE id = ?")
			.bind(title, slug, json, id)
			.run();
		if (!res.meta.changes) return fail(404, { error: 'Page not found.' });
		return { saved: true };
	},

	publish: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const to = String((await event.request.formData()).get('to')) === '1' ? 1 : 0;
		await db
			.prepare("UPDATE pages SET published = ?, updated_at = datetime('now') WHERE id = ?")
			.bind(to, id)
			.run();
		return { ok: true };
	},

	delete: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		await db.prepare('DELETE FROM pages WHERE id = ?').bind(id).run();
		throw redirect(303, '/pages');
	}
};

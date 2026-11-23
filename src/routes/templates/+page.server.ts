import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { builtInBlocks } from '$lib/server/newsletter-archive';
import { WEB_TEMPLATE_KIND } from '$lib/newsletter-archive';

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const templates = await db
		.prepare('SELECT id, name, kind, created_at, updated_at FROM templates ORDER BY updated_at DESC')
		.all<{ id: number; name: string; kind: string; created_at: string; updated_at: string }>();
	return { templates: templates.results };
};

export const actions: Actions = {
	create: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const name = String(data.get('name') ?? '').trim();
		const rawKind = String(data.get('kind') ?? 'builder');
		const kind = rawKind === 'html' ? 'html' : rawKind === WEB_TEMPLATE_KIND ? WEB_TEMPLATE_KIND : 'builder';
		if (!name) return fail(400, { error: 'Give the template a name.' });
		// Builder templates start with a content area — the layout-shell model (#64):
		// the template is chrome; campaign content lands in the content block at send.
		// #481: a web (newsletter archive) template starts from the built-in default, or blank.
		const seed =
			kind === WEB_TEMPLATE_KIND && data.get('start') !== 'blank'
				? JSON.stringify(await builtInBlocks(db, await publicBaseUrlFor(event)))
				: kind !== 'html'
					? JSON.stringify([{ id: crypto.randomUUID(), type: 'content' }])
					: null;
		const row = await db
			.prepare('INSERT INTO templates (name, kind, blocks) VALUES (?, ?, ?) RETURNING id')
			.bind(name, kind, seed)
			.first<{ id: number }>();
		throw redirect(303, `/templates/${row!.id}`);
	},

	delete: async (event) => {
		const db = getDB(event);
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing template.' });
		await db.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
		return { ok: true };
	}
};

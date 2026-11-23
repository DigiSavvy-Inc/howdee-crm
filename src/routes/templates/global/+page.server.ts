import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { MERGE_TAGS } from '$lib/server/email';
import { blocksForEditor, readTemplateBlocks } from '$lib/server/templates';

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const rows = await db
		.prepare("SELECT key, value FROM app_state WHERE key IN ('global_email_header', 'global_email_footer')")
		.all<{ key: string; value: string | null }>();
	// #255: legacy markdown text blocks open in the visual editor as rich blocks.
	const get = (k: string) => blocksForEditor(rows.results.find((r) => r.key === k)?.value, { allowContent: false });
	return { header: get('global_email_header'), footer: get('global_email_footer'), mergeTags: MERGE_TAGS, wideLayout: true };
};

export const actions: Actions = {
	save: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const header = readTemplateBlocks(String(data.get('header') ?? '[]'), { allowContent: false });
		const footer = readTemplateBlocks(String(data.get('footer') ?? '[]'), { allowContent: false });
		const upsert = db.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		);
		const res = await db.batch([
			upsert.bind('global_email_header', JSON.stringify(header).slice(0, 100_000)),
			upsert.bind('global_email_footer', JSON.stringify(footer).slice(0, 100_000))
		]);
		if (!res.every((r) => r.success)) return fail(500, { error: 'Could not save.' });
		return { saved: true };
	}
};

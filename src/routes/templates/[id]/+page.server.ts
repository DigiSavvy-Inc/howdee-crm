import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { MERGE_TAGS } from '$lib/server/email';
import { blocksForEditor, loadGlobalChrome, readTemplateBlocks, readTemplateCanvas } from '$lib/server/templates';
import { countContentAreas, parseCanvas, type Block } from '$lib/blocks';
import { WEB_DEFAULTS, WEB_FONTS, WEB_FONT_SIZES, WEB_TEMPLATE_KIND, WEB_WIDTHS, defaultArchiveTheme, sanitizeWebCanvas, webCanvasFromEmail, webCanvasFromForm } from '$lib/newsletter-archive';
import { getArchiveTheme } from '$lib/server/newsletter-archive';

/** #493: a copy never shares block ids with its source (sections and column cells too). */
function freshIds(blocks: Block[]): Block[] {
	return blocks.map((b) => {
		const c = { ...b, id: crypto.randomUUID() } as Block;
		if (c.type === 'section') c.blocks = freshIds(c.blocks);
		if (c.type === 'columns') c.cells = c.cells.map(freshIds);
		return c;
	});
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	if (!id) throw error(404, 'Template not found');
	const t = await db
		.prepare('SELECT id, name, kind, blocks, html, use_global_header, use_global_footer, canvas, created_at, updated_at FROM templates WHERE id = ?')
		.bind(id)
		.first<{ id: number; name: string; kind: string; blocks: string | null; html: string | null; use_global_header: number; use_global_footer: number; canvas: string | null; created_at: string; updated_at: string }>();
	if (!t) throw error(404, 'Template not found');
	// #595: a web template's Page settings default to the install's archive theme.
	const theme = t.kind === WEB_TEMPLATE_KIND ? await getArchiveTheme(db) : defaultArchiveTheme();
	// #255: legacy markdown text blocks open in the visual editor as rich blocks.
	// #270: the email canvas opens as a sanitised object ({} = none).
	return {
		template: {
			...t,
			blocks: t.kind === 'html' ? [] : blocksForEditor(t.blocks, { allowContent: true }),
			canvas: t.kind === WEB_TEMPLATE_KIND ? {} : parseCanvas(t.canvas),
			// #481: a web template's page settings (background, width, font, size, link colour).
			webCanvas: t.kind === WEB_TEMPLATE_KIND ? sanitizeWebCanvas(t.canvas) : null
		},
		webOptions: { widths: WEB_WIDTHS, sizes: WEB_FONT_SIZES, fonts: WEB_FONTS.map((f) => ({ key: f.key, label: f.label })), defaults: { bg: theme.bg, link: theme.link, width: WEB_DEFAULTS.width, fontSize: WEB_DEFAULTS.fontSize } },
		mergeTags: MERGE_TAGS,
		// #493: just made by "Copy as newsletter archive page".
		copied: event.url.searchParams.get('copied') === '1',
		wideLayout: true
	};
};

export const actions: Actions = {
	save: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Name is required.' });

		const t = await db.prepare('SELECT kind FROM templates WHERE id = ?').bind(id).first<{ kind: string }>();
		if (!t) return fail(404, { error: 'Template not found.' });

		if (t.kind === 'html') {
			const html = String(data.get('html') ?? '');
			await db
				.prepare("UPDATE templates SET name = ?, html = ? , updated_at = datetime('now') WHERE id = ?")
				.bind(name, html.slice(0, 200_000), id)
				.run();
		} else if (t.kind === WEB_TEMPLATE_KIND) {
			// #481: page-mode blocks (one content area) + the web canvas; no email chrome toggles.
			const blocks = readTemplateBlocks(String(data.get('blocks') ?? '[]'), { allowContent: true });
			const canvas = webCanvasFromForm(data);
			await db
				.prepare("UPDATE templates SET name = ?, blocks = ?, canvas = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(name, JSON.stringify(blocks).slice(0, 200_000), Object.keys(canvas).length ? JSON.stringify(canvas) : null, id)
				.run();
		} else {
			const blocks = readTemplateBlocks(String(data.get('blocks') ?? '[]'), { allowContent: true });
			const useHeader = data.get('use_global_header') ? 1 : 0;
			const useFooter = data.get('use_global_footer') ? 1 : 0;
			const canvas = readTemplateCanvas(data.get('canvas'));
			await db
				.prepare(
					"UPDATE templates SET name = ?, blocks = ?, use_global_header = ?, use_global_footer = ?, canvas = ?, updated_at = datetime('now') WHERE id = ?"
				)
				.bind(name, JSON.stringify(blocks).slice(0, 200_000), useHeader, useFooter, canvas, id)
				.run();
		}
		return { saved: true };
	},

	// #493: a one-time copy of a builder template as a web (newsletter archive) template.
	copyAsWeb: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const src = await db
			.prepare('SELECT name, kind, blocks, canvas, use_global_header, use_global_footer FROM templates WHERE id = ?')
			.bind(id)
			.first<{ name: string; kind: string; blocks: string | null; canvas: string | null; use_global_header: number; use_global_footer: number }>();
		if (!src) throw error(404, 'Template not found');
		if (src.kind !== 'builder') return fail(400, { error: 'Only builder email templates can be copied as a newsletter archive page.' });

		const chrome = src.use_global_header || src.use_global_footer ? await loadGlobalChrome(db) : { header: [], footer: [] };
		const chromeBlocks = (b: Block[]) => blocksForEditor(JSON.stringify(b), { allowContent: false });
		const all = [
			...(src.use_global_header ? chromeBlocks(chrome.header) : []),
			...blocksForEditor(src.blocks, { allowContent: true }),
			...(src.use_global_footer ? chromeBlocks(chrome.footer) : [])
		];
		let blocks = readTemplateBlocks(JSON.stringify(all), { allowContent: true });
		if (countContentAreas(blocks) === 0) blocks.push({ id: '', type: 'content' } as Block);
		blocks = freshIds(blocks);

		const canvas = webCanvasFromEmail(parseCanvas(src.canvas));
		const base = `${src.name} (web)`;
		// No LIKE: D1 refuses LIKE patterns over 50 bytes (#484); a substr prefix compare has no cap.
		const taken = await db
			.prepare('SELECT name FROM templates WHERE substr(name, 1, length(?1)) = ?1')
			.bind(base)
			.all<{ name: string }>();
		const names = new Set(taken.results.map((r) => r.name));
		let name = base;
		for (let n = 2; names.has(name); n++) name = `${base} ${n}`;

		const row = await db
			.prepare("INSERT INTO templates (name, kind, blocks, canvas) VALUES (?, 'web', ?, ?) RETURNING id")
			.bind(name, JSON.stringify(blocks), Object.keys(canvas).length ? JSON.stringify(canvas) : null)
			.first<{ id: number }>();
		throw redirect(303, `/templates/${row!.id}?copied=1`);
	},

	delete: async (event) => {
		const db = getDB(event);
		await db.prepare('DELETE FROM templates WHERE id = ?').bind(Number(event.params.id)).run();
		throw redirect(303, '/templates');
	}
};

import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { readTemplateBlocks, readTemplateCanvas, renderTemplatePreview, type Chrome } from '$lib/server/templates';
import { getArchiveTheme, renderWebTemplatePreview } from '$lib/server/newsletter-archive';
import { webCanvasFromForm } from '$lib/newsletter-archive';

// #255: Desktop / Mobile preview for the template editor and the Global header & footer
// page. Session-gated (not in PUBLIC_PREFIXES). Renders the unsaved blocks through the
// real assembler with sample campaign content. Form fields:
// - template: `blocks` + `use_global_header` / `use_global_footer` (saved chrome) +
//   `canvas` (#270);
// - global page: `header` + `footer` (unsaved chrome around a bare content area).
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		throw error(400, 'Expected form data.');
	}

	let html: string;
	if (data.get('web') === '1') {
		// #481: a web (newsletter archive) template around a sample issue.
		const blocks = readTemplateBlocks(String(data.get('blocks') ?? '[]'), { allowContent: true });
		html = renderWebTemplatePreview(blocks, webCanvasFromForm(data), await getArchiveTheme(db)); // #595
	} else if (data.has('header') || data.has('footer')) {
		const chrome: Chrome = {
			header: readTemplateBlocks(String(data.get('header') ?? '[]'), { allowContent: false }),
			footer: readTemplateBlocks(String(data.get('footer') ?? '[]'), { allowContent: false })
		};
		const template = { name: 'Preview', kind: 'builder', blocks: JSON.stringify([{ id: 'content', type: 'content' }]), html: null, use_global_header: 1, use_global_footer: 1 };
		html = await renderTemplatePreview(db, template, chrome);
	} else {
		const blocks = readTemplateBlocks(String(data.get('blocks') ?? '[]'), { allowContent: true });
		const template = {
			name: 'Preview',
			kind: 'builder',
			blocks: JSON.stringify(blocks),
			html: null,
			use_global_header: data.get('use_global_header') ? 1 : 0,
			use_global_footer: data.get('use_global_footer') ? 1 : 0,
			canvas: readTemplateCanvas(data.get('canvas')) // #270: the unsaved canvas
		};
		html = await renderTemplatePreview(db, template);
	}

	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
	});
};

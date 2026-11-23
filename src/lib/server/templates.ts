import {
	parseBlocks,
	renderBlocksEmailHtml,
	renderBlocksEmailText,
	markdownToHtml,
	sanitizeBlocks,
	keepFirstContentArea,
	CONTENT_PLACEHOLDER,
	parseCanvas,
	canvasIsSet,
	canvasPadding,
	countContentAreas,
	fontStack,
	type Block
} from '$lib/blocks';
import { upgradeLegacyBlocks } from '$lib/blocks-markdown';
import { renderEmailHtmlFromContent } from './email';
import { getSignature } from './email-signature';

// Template assembly (#64): [global header] + [template blocks] + [global footer],
// with every content-area block substituted by the campaign's composed content.
// Used by both the broadcast send and test sends so they always match.

export type TemplateRow = {
	name: string;
	kind: string;
	blocks: string | null;
	html: string | null;
	use_global_header: number;
	use_global_footer: number;
	/** #270: the email canvas JSON (templates.canvas, migration 0074); NULL = none. */
	canvas?: string | null;
};

export type Chrome = { header: Block[]; footer: Block[] };

/** #255: posted editor JSON → blocks to store. Sanitised; a template keeps at most one
 *  content area (the first), the global header/footer none. */
export function readTemplateBlocks(raw: unknown, opts: { allowContent: boolean }): Block[] {
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = [];
		}
	}
	// #262: a content area inside a section counts too.
	return keepFirstContentArea(sanitizeBlocks(parsed, { allowContent: opts.allowContent }));
}

/** #270: the posted canvas JSON → the column value (sanitised; nothing set = NULL, so a
 *  template without a canvas keeps rendering in the classic shell). */
export function readTemplateCanvas(raw: unknown): string | null {
	const canvas = parseCanvas(typeof raw === 'string' ? raw : null);
	return canvasIsSet(canvas) ? JSON.stringify(canvas) : null;
}

/** #255: stored template / header / footer JSON → the editor's rich shape (legacy
 *  markdown text blocks converted; nothing is written until Save). */
export function blocksForEditor(json: string | null | undefined, opts: { allowContent: boolean }): Block[] {
	return upgradeLegacyBlocks(sanitizeBlocks(parseBlocks(json), { allowContent: opts.allowContent }));
}

export async function loadGlobalChrome(db: D1Database): Promise<{ header: Block[]; footer: Block[] }> {
	const rows = await db
		.prepare("SELECT key, value FROM app_state WHERE key IN ('global_email_header', 'global_email_footer')")
		.all<{ key: string; value: string | null }>();
	const get = (k: string) => parseBlocks(rows.results.find((r) => r.key === k)?.value);
	return { header: get('global_email_header'), footer: get('global_email_footer') };
}

/** Assemble a builder template + composed content (markdown, or #250 editor blocks)
 *  into email-safe inner HTML and a text alternative. If the template has no
 *  content-area block, the content is appended after the template's blocks. */
export async function assembleBuilderEmail(
	db: D1Database,
	template: TemplateRow,
	content: string | Block[],
	/** Unsaved header/footer (the Global header & footer page's preview). */
	chromeOverride?: Chrome
): Promise<{ innerHtml: string; text: string }> {
	const chrome = chromeOverride ?? (await loadGlobalChrome(db));
	const canvas = parseCanvas(template.canvas);
	const tplBlocks = parseBlocks(template.blocks);
	const all: Block[] = [
		...(template.use_global_header ? chrome.header : []),
		...tplBlocks,
		...(template.use_global_footer ? chrome.footer : [])
	];

	// The content's own blocks can't carry a content area (sanitised without one).
	const contentBlocks = Array.isArray(content) ? sanitizeBlocks(content, { allowContent: false }) : null;
	const contentMd = contentBlocks ? '' : String(content ?? '');
	// #270: with a canvas, content in a top-level area (or appended) lays itself out like
	// the card (padded runs, full-bleed sections); inside a section it renders bare.
	const topLevel = all.some((b) => b.type === 'content') || countContentAreas(all) === 0;
	const side = canvasIsSet(canvas) ? canvasPadding(canvas).side : 0;
	const contentHtml = contentBlocks
		? renderBlocksEmailHtml(contentBlocks, canvas, { layout: topLevel ? 'fill' : 'bare' })
		: topLevel && side
			? `<div class="ds-pad" style="padding:0 ${side}px;">${markdownToHtml(contentMd)}</div>`
			: markdownToHtml(contentMd);
	const contentText = contentBlocks ? renderBlocksEmailText(contentBlocks) : contentMd.trim();

	let innerHtml = renderBlocksEmailHtml(all, canvas);
	let text = renderBlocksEmailText(all);

	// #275: the canvas body font / line height (unset = the system stack at 1.6, as before).
	const wrapStyle = `font-family:${fontStack(canvas.font)};font-size:${canvas.fontSize ?? 16}px;line-height:${canvas.lineHeight ?? 1.6};`;
	if (innerHtml.includes(CONTENT_PLACEHOLDER)) {
		const wrapped = `<div style="${wrapStyle}">${contentHtml}</div>`;
		innerHtml = innerHtml.replaceAll(CONTENT_PLACEHOLDER, wrapped);
		text = text.replaceAll(CONTENT_PLACEHOLDER, contentText);
	} else {
		innerHtml += `\n<div style="${wrapStyle}">${contentHtml}</div>`;
		text = `${text}\n\n${contentText}`.trim();
	}

	return { innerHtml, text };
}

/** Stand-in campaign content for template previews (#255). */
export const SAMPLE_CONTENT = `## Your campaign headline

Hi {{first_name}}, this is where a campaign's content lands. Whatever you write in
Compose fills the **content area** of this template.

- The global header and footer wrap it (when the template includes them)
- The signature and unsubscribe line come after`;

/** #255: the full email document for a template preview — the real assembler and shell
 *  with SAMPLE_CONTENT in the content area. Merge tags stay unfilled. */
export async function renderTemplatePreview(db: D1Database, template: TemplateRow, chromeOverride?: Chrome): Promise<string> {
	const { innerHtml } = await assembleBuilderEmail(db, template, SAMPLE_CONTENT, chromeOverride);
	return renderEmailHtmlFromContent(innerHtml, { unsubscribe: true, canvas: parseCanvas(template.canvas), signature: await getSignature(db) });
}

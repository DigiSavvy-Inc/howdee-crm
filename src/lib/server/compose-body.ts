// #250: one place that turns a compose body (visual-editor blocks, or legacy markdown)
// into the stored/sent HTML + text templates. Send, test send, save draft and the
// editor's preview all call it, so the preview is the real send renderer.
import { parseBlocks, sanitizeBlocks, blocksAreEmpty, renderBlocksEmailHtml, renderBlocksEmailText, type Block } from '$lib/blocks';
import { blocksToMarkdown } from '$lib/blocks-markdown';
import { renderEmailHtml, renderEmailHtmlFromContent, renderEmailText, type RenderOpts } from './email';
import { getSignature } from './email-signature';
import { assembleBuilderEmail, type TemplateRow } from './templates';
import { parseCanvas } from '$lib/blocks';

export type ComposeBody = {
	/** Sanitised blocks, or null for a markdown-only body. */
	blocks: Block[] | null;
	/** The markdown — as posted, or exported from the blocks. */
	md: string;
};

/** Read `body_blocks` (JSON) / `body_md` from a compose form. Blocks win when posted;
 *  they are sanitised here and `md` becomes their markdown export. */
export function readComposeBody(data: FormData): ComposeBody {
	return composeBodyFrom(String(data.get('body_blocks') ?? ''), String(data.get('body_md') ?? ''));
}

/** The same rules for a non-form caller (#345): `blocks` is a block array or its JSON;
 *  a usable array wins (sanitised, `md` = its export), else the trimmed markdown. */
export function composeBodyFrom(blocks: unknown, md: string | null | undefined): ComposeBody {
	let parsed: unknown = blocks;
	if (typeof blocks === 'string') {
		const raw = blocks.trim();
		parsed = null;
		if (raw) {
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = null;
			}
		}
	}
	if (Array.isArray(parsed)) {
		const sanitized = sanitizeBlocks(parsed, { allowContent: false });
		return { blocks: sanitized, md: blocksAreEmpty(sanitized) ? '' : blocksToMarkdown(sanitized) };
	}
	return { blocks: null, md: String(md ?? '').trim() };
}

/** Stored `body_blocks` → blocks, or null (NULL / unreadable column = markdown). */
export function storedBlocks(json: string | null | undefined): Block[] | null {
	if (!json) return null;
	const blocks = parseBlocks(json);
	return blocks.length ? sanitizeBlocks(blocks, { allowContent: false }) : null;
}

export function bodyIsEmpty(body: ComposeBody): boolean {
	return body.blocks ? blocksAreEmpty(body.blocks) : !body.md;
}

/** JSON for the `body_blocks` column (NULL for a markdown body). */
export function bodyBlocksColumn(body: ComposeBody): string | null {
	return body.blocks ? JSON.stringify(body.blocks) : null;
}

/** HTML + text templates for a body with no template: blocks through the block
 *  renderer, markdown through the markdown one — both inside the same email shell. */
export function renderBody(body: ComposeBody, opts: RenderOpts = {}): { html: string; text: string } {
	if (body.blocks) {
		return {
			html: renderEmailHtmlFromContent(renderBlocksEmailHtml(body.blocks), opts),
			text: renderEmailText(renderBlocksEmailText(body.blocks), opts)
		};
	}
	return { html: renderEmailHtml(body.md, opts), text: renderEmailText(body.md, opts) };
}

/** Same, with a builder template: the body fills the template's content area. */
export async function renderBodyInTemplate(
	db: D1Database,
	template: TemplateRow,
	body: ComposeBody,
	opts: RenderOpts = {}
): Promise<{ html: string; text: string }> {
	const assembled = await assembleBuilderEmail(db, template, body.blocks ?? body.md);
	// #594: the signature setting, unless the caller already loaded it.
	const signature = opts.signature === undefined ? await getSignature(db) : opts.signature;
	return {
		// #270: the template's canvas wraps the email (none = the classic shell).
		html: renderEmailHtmlFromContent(assembled.innerHtml, { ...opts, signature, canvas: parseCanvas(template.canvas) }),
		text: renderEmailText(assembled.text, { unsubscribe: opts.unsubscribe, originNote: opts.originNote, signature })
	};
}

// Email bodies the assistant writes (#309), for campaign drafts and automation email steps.
// The model passes Markdown (`body_markdown`) or the app's block format (`body_blocks`); both
// end up as sanitised blocks — the visual editor's format (#250) — plus their Markdown export,
// exactly what compose's readComposeBody stores.

import { blocksAreEmpty, hasTocBlock, sanitizeBlocks, type Block } from '$lib/blocks';
import { blocksToMarkdown, markdownToBlocks } from '$lib/blocks-markdown';
import type { ComposeBody } from '../../compose-body';
import { ToolInputError } from './types';

export const BODY_JSON_MAX = 200_000; // campaign-drafts MAX_BODY

export const BODY_PROPS = {
	body_markdown: {
		type: 'string',
		description:
			'The email body as Markdown (headings, paragraphs, lists, **bold**, [links](https://…), merge tags like {{first_name}}). Converted to the visual editor blocks. No signature or unsubscribe footer — the app adds them. For a table of contents use body_blocks.'
	},
	body_blocks: {
		type: 'array',
		items: { type: 'object' },
		description:
			"Alternative to body_markdown: the app's block format (e.g. { type: 'paragraph', content: [{ type: 'text', text: '…' }] }, { type: 'heading', level: 2, content: [{ type: 'text', text: '…' }] }). A table of contents is { type: 'toc', levels: [2], title?: 'In this email' }: levels = the heading levels it lists (1, 2, 3); its list of jump links is built automatically from the body's headings, so never write the entries yourself. Unknown blocks are dropped."
	}
};

/** Blocks from a Markdown string or a block array (sanitised); null when neither was given.
 *  `part`: the blocks go into an existing body (a section rewrite), where a table of contents
 *  on its own is content (#560: it lists the body's headings; a whole body of just one is empty). */
export function blocksArg(input: Record<string, unknown>, opts: { allowEmpty?: boolean; part?: boolean } = {}): Block[] | null {
	let blocks: Block[];
	if (Array.isArray(input.body_blocks)) blocks = sanitizeBlocks(input.body_blocks, { allowContent: false });
	else if (typeof input.body_markdown === 'string') blocks = sanitizeBlocks(markdownToBlocks(input.body_markdown), { allowContent: false });
	else return null;
	if (!opts.allowEmpty && blocksAreEmpty(blocks) && !(opts.part && hasTocBlock(blocks))) throw new ToolInputError('The body is empty.');
	if (JSON.stringify(blocks).length > BODY_JSON_MAX) throw new ToolInputError('That body is too long.');
	return blocks;
}

/** A body as compose stores it: blocks + their Markdown export. */
export function bodyOf(blocks: Block[]): ComposeBody {
	return { blocks, md: blocksAreEmpty(blocks) ? '' : blocksToMarkdown(blocks) };
}

/** The blocks of a stored body: `body_blocks`, else the Markdown converted (as compose does on load). */
export function storedOrConverted(blocksJson: string | null, md: string, stored: (j: string | null) => Block[] | null): Block[] {
	return stored(blocksJson) ?? sanitizeBlocks(markdownToBlocks(md ?? ''), { allowContent: false });
}

/** #560: a table of contents read on its own lists nothing (its entries are the body's headings). */
const tocLine = (b: Extract<Block, { type: 'toc' }>) =>
	`Table of contents${b.title ? ` “${b.title}”` : ''}: jump links to the ${b.levels.map((l) => `H${l}`).join(', ')} headings, built automatically`;

/** One line per block, so the model can name the section to rewrite. */
export function sectionList(blocks: Block[]): { index: number; type: string; text: string }[] {
	return blocks.map((b, index) => {
		const text = b.type === 'toc' ? tocLine(b) : blocksToMarkdown([b]).replace(/\s+/g, ' ').trim();
		return { index, type: b.type, text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
	});
}

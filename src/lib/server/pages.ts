import { parseBlocks, sanitizeBlocks, type Block } from '$lib/blocks';
import { upgradeLegacyBlocks } from '$lib/blocks-markdown';

/** Stored page JSON is capped so a save can't fill the row (#56). */
export const MAX_PAGE_BLOCKS_JSON = 100_000;

/** #261: a stored hosted page → the visual editor's shape. Legacy markdown `text` blocks
 *  open as rich blocks; rows nobody re-saves keep rendering as stored (renderPageHtml
 *  accepts both shapes). Pages have no content area. */
export function pageBlocksForEditor(json: string | null | undefined): Block[] {
	return upgradeLegacyBlocks(sanitizeBlocks(parseBlocks(json), { allowContent: false }));
}

/** The editor's posted JSON → sanitised blocks to store. */
export function readPageBlocks(raw: string): Block[] {
	return sanitizeBlocks(parseBlocks(raw), { allowContent: false });
}

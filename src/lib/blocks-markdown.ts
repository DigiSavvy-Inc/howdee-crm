// The implementation lives in @digisavvy/block-editor (#558); this shim keeps `$lib/blocks-markdown` imports working.
export {
	blocksToMarkdown,
	markdownToBlocks,
	upgradeLegacyBlocks
} from '@digisavvy/block-editor/blocks';

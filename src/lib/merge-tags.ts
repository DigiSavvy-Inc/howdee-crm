// The implementation lives in @digisavvy/block-editor (#558); this shim keeps `$lib/merge-tags` imports working.
export {
	applyMergeTokens,
	escapeLeftoverMergeTokens,
	hasCompanyTags,
	isMergeToken,
	parseCompanyToken,
	parseMarkdownPreservingMergeTags,
	parseMarkdownSafe,
	shieldMergeTokens,
	splitMergeTokens,
	unescapeHtmlText,
	type TemplateMode
} from '@digisavvy/block-editor/blocks';

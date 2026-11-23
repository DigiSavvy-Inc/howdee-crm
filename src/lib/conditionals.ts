// The implementation lives in @digisavvy/block-editor (#558); this shim keeps `$lib/conditionals` imports working.
export {
	buildCondCtx,
	checkCondition,
	conditionalTagResult,
	evaluateConditionals,
	formatTagCondition,
	hasConditionals,
	stripConditionalTags,
	type CondCtx
} from '@digisavvy/block-editor/blocks';

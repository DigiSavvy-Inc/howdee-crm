<script lang="ts">
	import { stageColorVar } from '$lib/pipeline';

	// Pipeline stage pill (#206): the stage colour is the dot + a tinted border only; the
	// label stays in the text token.
	let { name, color }: { name: string; color: string | null } = $props();
</script>

<span class="pill" style="--stage: {stageColorVar(color)}"><span class="dot" aria-hidden="true"></span>{name}</span>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		padding: var(--space-xxs) var(--space-xs);
		border: 0;
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium);
		white-space: nowrap;
		color: var(--neutral-10);
		background: var(--neutral-3);
		box-shadow: inset 0 0 0 var(--border-s) color-mix(in srgb, var(--stage) 45%, var(--neutral-4));
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-full);
		background: var(--stage);
		flex-shrink: 0;
	}
</style>

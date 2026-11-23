<script lang="ts">
	// Sort direction caret for table headings (#209). Renders nothing when the column isn't sorted.
	import Icon from '$lib/components/Icon.svelte';

	let { dir }: { dir: 'asc' | 'desc' | null } = $props();
</script>

{#if dir}<span class="caret"><Icon name={dir === 'desc' ? 'chevron-down' : 'chevron-up'} size={16} /></span>{/if}

<style>
	.caret { margin-left: var(--space-xxs); }
</style>

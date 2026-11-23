<script lang="ts">
	import type { Snippet } from 'svelte';

	// The selection bar every table shares: "N selected" first, the screen's actions, Clear last
	// (right-aligned). Same card, type and control height everywhere — /contacts and /lists/[id]
	// (ContactBulkBar), /groups/[kind], /automations and /conversations. `placement="bottom"`
	// sticks the bar above the viewport's bottom edge for tables whose bar sits under the rows;
	// "top" sits above the rows.
	let {
		count,
		onClear,
		placement = 'bottom',
		label = 'Bulk actions',
		children
	}: {
		count: string;
		onClear: () => void;
		placement?: 'top' | 'bottom';
		label?: string;
		children: Snippet;
	} = $props();
</script>

<div class="bulkbar" class:bottom={placement === 'bottom'} role="region" aria-label={label}>
	<strong class="bulk-count">{count}</strong>
	{@render children()}
	<button type="button" class="secondary clear" onclick={onClear}>Clear</button>
</div>

<style>
	.bulkbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-s);
		margin-bottom: var(--space-m);
		padding: var(--space-s) var(--space-m);
		border: 0;
		border-radius: var(--radius-m);
		background: var(--surface);
		box-shadow: var(--border-shadow-s), var(--shadow-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
	}
	/* Floating over the rows below: stronger shadow, no gap to the next block. */
	.bottom {
		position: sticky;
		bottom: 0.75rem;
		z-index: 2;
		margin: var(--space-s) 0 0;
		box-shadow: var(--border-shadow-s), var(--shadow-m);
	}
	.bulk-count {
		white-space: nowrap;
	}
	.clear {
		margin-left: auto;
	}
	/* Fields and buttons in the bar share one height, whatever the screen puts in it. */
	.bulkbar :global(button),
	.bulkbar :global(input:not([type='checkbox'])),
	.bulkbar :global(select) {
		box-sizing: border-box;
		height: 36px;
	}
</style>

<script lang="ts">
	// A row of KPI numbers as one bordered card split into equal cells by 1px dividers (#340).
	// Children are StatCell components. Laid out by the group's own width (container query),
	// so the left-sidebar layout behaves too:
	//   < 600px      2 columns (phones, #331); an odd last cell spans the row
	//   600–899px    one row for up to 4 cells, 3 columns for 5+ (the last cell fills its row)
	//   ≥ 900px      one row for up to 6 cells; 7+ cells wrap into balanced rows (#429):
	//                7–8 → 4 columns, 9–10 → 5 columns, 11+ → 6 columns (the last cell fills its row)
	import type { Snippet } from 'svelte';

	let { label, children }: { label?: string; children: Snippet } = $props();
</script>

<div class="stat-wrap">
	<div class="stat-group" role={label ? 'group' : undefined} aria-label={label}>
		{@render children()}
	</div>
</div>

<style>
	.stat-wrap {
		container-type: inline-size;
		margin: var(--card-gap) 0;
	}
	.stat-group {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		background: var(--surface);
		border-radius: var(--radius-m);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-s);
		/* Clips each cell's left / top divider at the group's outer edge (see StatCell). */
		overflow: hidden;
	}
	@container (max-width: 599px) {
		.stat-group > :global(.stat-cell:last-child:nth-child(odd)) {
			grid-column: 1 / -1;
		}
	}
	@container (min-width: 600px) {
		.stat-group {
			grid-template-columns: none;
			grid-auto-flow: column;
			grid-auto-columns: minmax(0, 1fr);
		}
	}
	@container (min-width: 600px) and (max-width: 899px) {
		.stat-group:has(> :global(:nth-child(5))) {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			grid-auto-flow: row;
		}
		.stat-group:has(> :global(:nth-child(5))) > :global(.stat-cell:last-child:nth-child(3n + 1)) {
			grid-column: 1 / -1;
		}
		.stat-group:has(> :global(:nth-child(5))) > :global(.stat-cell:last-child:nth-child(3n + 2)) {
			grid-column: span 2;
		}
	}
	@container (min-width: 900px) {
		/* Bands are exclusive so one band's last-cell span never leaks into another's.
		   A short last row ends in a cell spanning the leftover columns (7 → 4 + 3, 9 → 5 + 4). */
		.stat-group:has(> :global(:nth-child(7))):not(:has(> :global(:nth-child(9)))) {
			grid-template-columns: repeat(4, minmax(0, 1fr));
			grid-auto-flow: row;
		}
		.stat-group:has(> :global(:nth-child(7))):not(:has(> :global(:nth-child(9)))) > :global(.stat-cell:last-child:nth-child(4n + 3)) {
			grid-column: span 2;
		}
		.stat-group:has(> :global(:nth-child(9))):not(:has(> :global(:nth-child(11)))) {
			grid-template-columns: repeat(5, minmax(0, 1fr));
			grid-auto-flow: row;
		}
		.stat-group:has(> :global(:nth-child(9))):not(:has(> :global(:nth-child(11)))) > :global(.stat-cell:last-child:nth-child(5n + 4)) {
			grid-column: span 2;
		}
		.stat-group:has(> :global(:nth-child(11))) {
			grid-template-columns: repeat(6, minmax(0, 1fr));
			grid-auto-flow: row;
		}
		.stat-group:has(> :global(:nth-child(11))) > :global(.stat-cell:last-child:nth-child(6n + 1)) {
			grid-column: 1 / -1;
		}
		.stat-group:has(> :global(:nth-child(11))) > :global(.stat-cell:last-child:nth-child(6n + 2)) {
			grid-column: span 5;
		}
		.stat-group:has(> :global(:nth-child(11))) > :global(.stat-cell:last-child:nth-child(6n + 3)) {
			grid-column: span 4;
		}
		.stat-group:has(> :global(:nth-child(11))) > :global(.stat-cell:last-child:nth-child(6n + 4)) {
			grid-column: span 3;
		}
		.stat-group:has(> :global(:nth-child(11))) > :global(.stat-cell:last-child:nth-child(6n + 5)) {
			grid-column: span 2;
		}
	}
</style>

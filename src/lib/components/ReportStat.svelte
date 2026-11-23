<script lang="ts">
	import StatCell from '$lib/components/StatCell.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import type { MetricFormat } from '$lib/report-metrics';
	import { formatCell, numericColumns } from '$lib/report-view';

	let {
		columns,
		row
	}: {
		columns: { key: string; label: string; format: MetricFormat }[];
		row: Record<string, unknown> | null;
	} = $props();

	const cells = $derived(numericColumns(columns));
</script>

{#if row && cells.length}
	<StatGroup label="Summary">
		{#each cells as column (column.key)}
			<StatCell label={column.label} value={formatCell(row[column.key], column.format)} />
		{/each}
	</StatGroup>
{/if}

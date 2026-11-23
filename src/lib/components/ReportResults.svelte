<script lang="ts">
	import EngagementHeatmap from '$lib/components/EngagementHeatmap.svelte';
	import ReportChart from '$lib/components/ReportChart.svelte';
	import ReportStat from '$lib/components/ReportStat.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	import { chartView, formatCell, heatmapGrid, recordHref } from '$lib/report-view';
	import type { ReportSpec } from '$lib/report-spec';
	import type { ReportResult } from '$lib/server/reports/engine';

	let {
		spec,
		result,
		error,
		tz,
		onSort
	}: {
		spec: ReportSpec;
		result: ReportResult | null;
		error: string | null;
		/** Settings → Timezone for date-time cells (#456). */
		tz?: string;
		onSort?: (key: string) => void;
	} = $props();

	const chart = $derived(spec.chart ?? 'table');
	const linkKey = $derived(
		result?.columns.find((column) => column.format === 'text')?.key ?? result?.columns[0]?.key ?? null
	);
	const view = $derived(
		result && chart !== 'table' && chart !== 'stat'
			? chartView(result, { chart: chart === 'line' ? 'line' : 'bar', sort: spec.sort })
			: null
	);
	// #454: weekday × hour rows; until a report returns them, a heatmap falls back to bars.
	const heat = $derived(chart === 'heatmap' && result ? heatmapGrid(result.rows) : null);

	function dirOf(key: string): 'asc' | 'desc' | null {
		if (spec.sort?.key !== key) return null;
		return spec.sort.dir;
	}

	function hrefFor(index: number): string | null {
		const id = result?.recordIds?.[index];
		return recordHref(spec.entity, id);
	}
</script>

{#if error}
	<p class="err" role="alert">{error}</p>
{:else if result}
	<p class="count">
		{result.total} {result.total === 1 ? (result.rowLabel?.one ?? 'row') : (result.rowLabel?.many ?? 'rows')}
		{#if result.note}· {result.note}{:else if result.truncated}· showing first {result.rows.length}{/if}
	</p>

	{#if chart === 'stat'}
		<ReportStat columns={result.columns} row={result.rows[0] ?? null} />
	{:else if heat}
		<EngagementHeatmap
			heat={{ ...heat, total: result.heatmap?.total ?? heat.total, tz: result.heatmap?.tz ?? '', days: result.heatmap?.days ?? 0, proxySkipped: result.heatmap?.proxySkipped ?? 0, truncated: result.heatmap?.truncated ?? false }}
		/>
	{:else if view}
		<ReportChart kind={chart === 'line' ? 'line' : 'bar'} {view} />
	{/if}

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					{#each result.columns as column (column.key)}
						<th class:num={column.format !== 'text' && column.format !== 'date'}>
							{#if onSort}
								<button type="button" class="sort" onclick={() => onSort(column.key)}>
									{column.label}<SortCaret dir={dirOf(column.key)} />
								</button>
							{:else}
								{column.label}
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if result.rows.length === 0}
					<tr><td class="empty" colspan={result.columns.length}>No rows match this report.</td></tr>
				{:else}
					{#each result.rows as row, index (index)}
						<tr>
							{#each result.columns as column (column.key)}
								{@const text = formatCell(row[column.key], column.format, tz)}
								{@const href = result.links?.[column.key]?.[index] ?? (column.key === linkKey ? hrefFor(index) : null)}
								<td class:num={column.format !== 'text' && column.format !== 'date'}>
									{#if href}<a {href}>{text}</a>{:else}{text}{/if}
								</td>
							{/each}
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	{#if result.secondary}
		<h3 class="secondary-title">{result.secondary.title}</h3>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						{#each result.secondary.columns as column (column.key)}
							<th class:num={column.format !== 'text' && column.format !== 'date'}>{column.label}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each result.secondary.rows as row, index (index)}
						<tr>
							{#each result.secondary.columns as column (column.key)}
								{@const href = result.secondary.links?.[column.key]?.[index] ?? null}
								{@const text = formatCell(row[column.key], column.format)}
								<td class:num={column.format !== 'text' && column.format !== 'date'}>{#if href}<a {href}>{text}</a>{:else}{text}{/if}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<details class="glossary">
		<summary>How these are calculated</summary>
		<dl>
			{#each result.columns as column (column.key)}
				<div>
					<dt>{column.label}</dt>
					<dd>{column.definition}</dd>
				</div>
			{/each}
		</dl>
	</details>
{/if}

<style>
	.err {
		color: var(--error);
		margin: 0 0 var(--space-s);
	}
	.count {
		margin: 0 0 var(--space-s);
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.table-wrap {
		max-width: 100%;
	}
	.secondary-title {
		margin: var(--space-m) 0 var(--space-s);
		font-size: var(--size-s);
	}
	table {
		width: max-content;
		min-width: 100%;
	}
	th,
	td {
		white-space: nowrap;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	button.sort {
		background: none;
		border: none;
		box-shadow: none;
		padding: 0;
		font: inherit;
		font-weight: var(--weight-ui-heavy);
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	button.sort:hover {
		background: none;
		box-shadow: none;
		color: var(--link-hover);
	}
	.empty {
		color: var(--muted);
		white-space: normal;
	}
	.glossary {
		margin-top: var(--space-m);
	}
	summary {
		cursor: pointer;
		font-weight: var(--weight-ui-medium);
	}
	dl {
		margin: var(--space-s) 0 0;
	}
	dl div {
		margin: 0 0 var(--space-xs);
	}
	dt {
		font-weight: var(--weight-ui-medium);
	}
	dd {
		margin: 0;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
</style>

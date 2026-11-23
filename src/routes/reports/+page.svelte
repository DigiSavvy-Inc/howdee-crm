<script lang="ts">
	import EngagementHeatmap from '$lib/components/EngagementHeatmap.svelte';
	import ReportChart from '$lib/components/ReportChart.svelte';
	import ReportStat from '$lib/components/ReportStat.svelte';
	import { chartView, formatCell, heatmapGrid } from '$lib/report-view';

	let { data } = $props();

	let query = $state('');
	let folder = $state('');

	const visible = $derived(
		data.library.filter((item) => {
			if (folder && item.folder !== folder) return false;
			const q = query.trim().toLowerCase();
			if (!q) return true;
			return item.name.toLowerCase().includes(q) || (item.description ?? '').toLowerCase().includes(q);
		})
	);
	const groups = $derived(
		data.folders
			.map((name) => ({ name, items: visible.filter((item) => item.folder === name) }))
			.filter((group) => group.items.length > 0)
	);
</script>

<svelte:head><title>Reports</title></svelte:head>

<div class="head">
	<h1>Reports</h1>
	<a href="/reports/new"><button>New report</button></a>
</div>

{#if data.pinned.length}
	<section class="pinned" aria-label="Pinned reports">
		<h2>Pinned</h2>
		<div class="pins">
			{#each data.pinned as card (card.id)}
				<a class="card pin" href={card.href}>
					<span class="name">{card.name}</span>
					{#if card.error}
						<p class="err">{card.error}</p>
					{:else if card.chart === 'stat' && card.result}
						<ReportStat columns={card.result.columns} row={card.result.rows[0] ?? null} />
					{:else if (card.chart === 'bar' || card.chart === 'line' || card.chart === 'heatmap') && card.result?.chartSeries}
						{@const heat = card.chart === 'heatmap' ? heatmapGrid(card.result.rows) : null}
						{@const kind = card.chart === 'line' ? 'line' : 'bar'}
						{@const view = heat ? null : chartView(card.result, { chart: kind, sort: card.sort })}
						{#if heat}
							<EngagementHeatmap
								heat={{ ...heat, total: card.result.heatmap?.total ?? heat.total, tz: card.result.heatmap?.tz ?? '', days: card.result.heatmap?.days ?? 0, proxySkipped: card.result.heatmap?.proxySkipped ?? 0, truncated: card.result.heatmap?.truncated ?? false }}
							/>
						{:else if view}
							<ReportChart {kind} {view} />
						{/if}
					{:else if card.result}
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										{#each card.result.columns as column (column.key)}
											<th class:num={column.format !== 'text' && column.format !== 'date'}>{column.label}</th>
										{/each}
									</tr>
								</thead>
								<tbody>
									{#if card.result.rows.length === 0}
										<tr><td class="empty" colspan={card.result.columns.length}>No rows match this report.</td></tr>
									{:else}
										{#each card.result.rows as row, index (index)}
											<tr>
												{#each card.result.columns as column (column.key)}
													<td class:num={column.format !== 'text' && column.format !== 'date'}>{formatCell(row[column.key], column.format, data.tz)}</td>
												{/each}
											</tr>
										{/each}
									{/if}
								</tbody>
							</table>
						</div>
					{/if}
				</a>
			{/each}
		</div>
	</section>
{/if}

<section class="library" aria-label="Report library">
	<div class="filters">
		<label>Search <input type="search" bind:value={query} placeholder="Name or description" /></label>
		<label>
			Folder
			<select bind:value={folder}>
				<option value="">All folders</option>
				{#each data.folders as name (name)}
					<option value={name}>{name}</option>
				{/each}
			</select>
		</label>
	</div>

	{#if groups.length === 0}
		<p class="muted">No reports match.</p>
	{:else}
		{#each groups as group (group.name)}
			<section>
				<h2>{group.name}</h2>
				<ul>
					{#each group.items as item (item.id)}
						<li>
							<a href={item.href}>{item.name}</a>
							{#if item.builtIn}<span class="badge">Built-in</span>{/if}
							{#if item.description}<span class="desc">{item.description}</span>{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</section>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s);
	}
	.head a:hover {
		text-decoration: none;
	}
	h1 {
		margin: 0;
	}
	h2 {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		margin: 0 0 var(--space-s);
	}
	.pinned {
		margin-top: var(--space-l);
	}
	.pins {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
		gap: var(--card-gap);
		min-width: 0;
	}
	a.pin {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		min-width: 0;
		overflow: hidden;
		color: var(--text);
		text-decoration: none;
	}
	a.pin:hover {
		text-decoration: none;
	}
	.name {
		color: var(--link);
		text-decoration: underline;
		text-decoration-color: var(--link-underline);
		text-decoration-thickness: var(--link-underline-thickness);
		font-weight: var(--weight-ui-medium);
	}
	a.pin :global(.stat-wrap) {
		margin: 0;
	}
	.err {
		color: var(--error);
		margin: 0;
	}
	.table-wrap {
		max-width: 100%;
	}
	table {
		width: max-content;
		min-width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		text-align: left;
		white-space: nowrap;
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	th.num,
	td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.empty {
		color: var(--muted);
		white-space: normal;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		margin: var(--space-m) 0;
	}
	.filters label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		flex: 1 1 12rem;
		min-width: 0;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.filters input,
	.filters select {
		color: var(--text);
		width: 100%;
	}
	.library section + section {
		margin-top: var(--space-l);
	}
	.library ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.library li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-xs);
		min-width: 0;
	}
	.desc {
		flex-basis: 100%;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>

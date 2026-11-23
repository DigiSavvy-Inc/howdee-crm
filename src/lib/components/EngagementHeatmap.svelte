<script lang="ts">
	// Global day × hour heatmap (#116): people with a real (non-proxy) open or click (#457:
	// distinct people per slot, not events) of the last N days in
	// the operator timezone. One sequential hue — the cell colour is --viz-1 mixed into the
	// surface at 4 steps (more = darker on light, brighter on dark) — with a "fewer → more"
	// legend and a readout line for the hovered / keyboard-focused cell (arrow keys move it).
	// See CLAUDE.md "Charts".
	import { HEAT_DAYS, HEAT_LEVELS, HEAT_SAMPLED_NOTE, heatLevel, heatPeak, hourLong, hourShort } from '$lib/engagement-insights-view';

	type Heat = { grid: number[][]; total: number; proxySkipped: number; tz: string; days: number; truncated: boolean };
	let { heat }: { heat: Heat } = $props();

	const max = $derived(Math.max(0, ...heat.grid.flat()));
	const peak = $derived(heatPeak(heat.grid));
	const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

	// Active cell: row index into HEAT_DAYS + hour. Null = show the peak summary.
	let active = $state<{ row: number; hour: number } | null>(null);
	const plural = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

	const readout = $derived.by(() => {
		if (active) {
			const d = HEAT_DAYS[active.row];
			return `${DOW_NAMES[d.dow]} ${hourLong(active.hour)}: ${plural(heat.grid[d.dow][active.hour])}`;
		}
		if (peak) return `Busiest: ${DOW_NAMES[peak.dow]}s around ${hourLong(peak.hour)} (${plural(peak.n)})`;
		return '';
	});

	function onKey(e: KeyboardEvent) {
		const cur = active ?? { row: 0, hour: 0 };
		let { row, hour } = cur;
		if (e.key === 'ArrowRight') hour = Math.min(23, hour + 1);
		else if (e.key === 'ArrowLeft') hour = Math.max(0, hour - 1);
		else if (e.key === 'ArrowDown') row = Math.min(6, row + 1);
		else if (e.key === 'ArrowUp') row = Math.max(0, row - 1);
		else return;
		e.preventDefault();
		active = { row, hour };
	}
	function onFocus() {
		if (active) return;
		const r = peak ? HEAT_DAYS.findIndex((d) => d.dow === peak.dow) : 0;
		active = { row: r, hour: peak?.hour ?? 0 };
	}
</script>

{#if heat.total === 0}
	<p class="muted">No opens or clicks in the last {heat.days} days yet.</p>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="hm"
		role="group"
		tabindex="0"
		aria-label="People opening or clicking by weekday and hour, {heat.tz}. Arrow keys move between cells."
		onkeydown={onKey}
		onfocus={onFocus}
		onblur={() => (active = null)}
		onmouseleave={() => (active = null)}
	>
		<span></span>
		{#each { length: 24 } as _, h (h)}
			<span class="hm-hour muted" aria-hidden="true">{h % 3 === 0 ? hourShort(h) : ''}</span>
		{/each}
		{#each HEAT_DAYS as d, r (d.dow)}
			<span class="hm-day muted" aria-hidden="true">{d.label}</span>
			{#each heat.grid[d.dow] as v, h (h)}
				<span
					class="hm-cell l{heatLevel(v, max)}"
					class:on={active?.row === r && active?.hour === h}
					aria-hidden="true"
					onmouseenter={() => (active = { row: r, hour: h })}
				></span>
			{/each}
		{/each}
	</div>
	<p class="hm-readout" aria-live="polite">{readout}</p>
	<div class="hm-foot">
		<span class="hm-legend" aria-label="Colour scale: fewer to more">
			<span class="muted">Fewer</span>
			{#each { length: HEAT_LEVELS + 1 } as _, l (l)}
				<span class="hm-cell l{l}" aria-hidden="true"></span>
			{/each}
			<span class="muted">More</span>
		</span>
		<span class="muted">
			{plural(heat.total)} opened or clicked, last {heat.days} days · {heat.tz}{heat.proxySkipped
				? ` · ${heat.proxySkipped} auto-opens left out`
				: ''}{heat.truncated ? ` · ${HEAT_SAMPLED_NOTE}` : ''}
		</span>
	</div>
{/if}

<style>
	.hm {
		display: grid;
		grid-template-columns: 2rem repeat(24, minmax(0, 1fr));
		gap: 2px;
		max-width: 34rem;
		outline-offset: 4px;
	}
	.hm-hour {
		font-size: var(--size-xxs);
		line-height: 1;
		letter-spacing: var(--letter-spacing-xxs);
		white-space: nowrap;
		overflow: visible;
	}
	.hm-day {
		font-size: var(--size-xxs);
		line-height: 12px; /* matches the 12px cell row */
		letter-spacing: var(--letter-spacing-xxs);
	}
	.hm-cell {
		display: block;
		min-width: 6px;
		height: 12px;
		border-radius: 2px;
		background: var(--neutral-3);
	}
	.hm-cell.l1 {
		background: color-mix(in srgb, var(--viz-1) 25%, var(--surface));
	}
	.hm-cell.l2 {
		background: color-mix(in srgb, var(--viz-1) 50%, var(--surface));
	}
	.hm-cell.l3 {
		background: color-mix(in srgb, var(--viz-1) 75%, var(--surface));
	}
	.hm-cell.l4 {
		background: var(--viz-1);
	}
	.hm-cell.on {
		outline: 2px solid var(--text);
		outline-offset: 0;
	}
	.hm-readout {
		min-height: var(--line-s);
		margin: var(--space-xs) 0 var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.hm-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-m);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.hm-legend {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}
	.hm-legend .hm-cell {
		width: 12px;
	}
	.hm-legend .muted:first-child {
		margin-right: var(--space-xxs);
	}
	.hm-legend .muted:last-child {
		margin-left: var(--space-xxs);
	}
</style>

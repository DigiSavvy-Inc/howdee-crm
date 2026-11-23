<script lang="ts">
	// Multi-series trend chart (#565), the generalised GrowthChart (#423): one line per series on
	// a shared scale, one hue family told apart by dash pattern + a legend (never colour alone).
	// Hover or keyboard-focus a bucket (arrow keys move between them) for every series' numbers.
	// Math in $lib/trend-chart. See CLAUDE.md "Charts (#161)".
	import { trendEmpty, trendLine, trendPeak, trendPointText, trendTotals, trendX, type TrendPoint, type TrendSeries } from '$lib/trend-chart';

	let {
		points,
		series,
		unit,
		label,
		empty = 'Nothing to show yet.'
	}: { points: TrendPoint[]; series: TrendSeries[]; unit: 'day' | 'week' | 'month'; label: string; empty?: string } = $props();

	const W = 360;
	const H = 140;
	const PAD = 6;
	const BASE = 116;
	const geom = { width: W, base: BASE, pad: PAD };

	const peak = $derived(trendPeak(points, series));
	const totals = $derived(trendTotals(points, series));
	const isEmpty = $derived(trendEmpty(points, series));
	const prefix = $derived(unit === 'week' ? 'Week of ' : '');

	let active = $state<number | null>(null);
	const readout = $derived(
		active === null || !points[active]
			? 'Hover or focus a week for its numbers'
			: trendPointText(points[active], series, prefix)
	);
	const summary = $derived(`${label}: ` + points.map((p) => trendPointText(p, series)).join('; '));

	let hits = $state<HTMLDivElement>();
	function onKey(e: KeyboardEvent, i: number) {
		const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : null;
		if (to === null || to < 0 || to >= points.length) return;
		e.preventDefault();
		(hits?.children[to] as HTMLElement | undefined)?.focus();
	}
</script>

<div class="trend">
	<ul class="legend" aria-label="Legend">
		{#each series as s (s.key)}
			<li>
				<svg class="sw" width="20" height="6" aria-hidden="true">
					<line x1="1" x2="19" y1="3" y2="3" stroke={s.color} stroke-dasharray={s.dash ?? undefined} />
				</svg>
				{s.label} <strong>{(active !== null && points[active] ? Number(points[active][s.key]) || 0 : totals[s.key]).toLocaleString('en-US')}</strong>
			</li>
		{/each}
	</ul>
	{#if isEmpty}
		<p class="muted empty">{empty}</p>
	{:else}
		<p class="readout muted" aria-live="polite">{readout}</p>
		<div class="plot">
			<svg viewBox="0 0 {W} {H}" role="img" aria-label={summary} preserveAspectRatio="none">
				<line class="axis" x1={PAD} x2={W - PAD} y1={BASE} y2={BASE} />
				{#each series as s (s.key)}
					<polyline points={trendLine(points, s.key, peak, geom)} stroke={s.color} stroke-dasharray={s.dash ?? undefined} />
				{/each}
				{#if active !== null && points[active]}
					<line class="cursor" x1={trendX(active, points.length, geom)} x2={trendX(active, points.length, geom)} y1={PAD} y2={BASE} />
				{/if}
				<text class="tick" x={PAD} y={H - 4}>{points[0].label}</text>
				<text class="tick" x={W - PAD} y={H - 4} text-anchor="end">{points[points.length - 1].label}</text>
			</svg>
			<!-- Hit targets: one per bucket; hover, focus and arrow keys drive the readout. -->
			<div class="hits" bind:this={hits}>
				{#each points as p, i (p.start)}
					<button
						type="button"
						class="hit"
						aria-label={trendPointText(p, series, prefix)}
						onmouseenter={() => (active = i)}
						onmouseleave={() => (active = null)}
						onfocus={() => (active = i)}
						onblur={() => (active = null)}
						onkeydown={(e) => onKey(e, i)}
					></button>
				{/each}
			</div>
		</div>
		<p class="peak muted">Peak {peak.toLocaleString('en-US')} per {unit}</p>
	{/if}
</div>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs) var(--space-m);
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--text);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.sw line {
		stroke-width: 2;
	}
	.readout,
	.peak,
	.empty {
		margin: var(--space-xxs) 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		min-height: var(--line-xs);
	}
	.empty {
		margin-top: var(--space-s);
	}
	.plot {
		position: relative;
	}
	.plot > svg {
		display: block;
		width: 100%;
		height: 140px;
	}
	.axis {
		stroke: var(--border);
		stroke-width: 1;
	}
	polyline {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
	}
	.cursor {
		stroke: var(--muted);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}
	.tick {
		fill: var(--muted);
		font-size: 10px;
	}
	.hits {
		position: absolute;
		left: 0;
		right: 0;
		top: 0;
		height: 140px;
		display: flex;
	}
	.hit {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
		cursor: default;
	}
	.hit:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
</style>

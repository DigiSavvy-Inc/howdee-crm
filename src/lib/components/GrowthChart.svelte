<script lang="ts">
	// Contacts Overview growth (#423): new contacts vs unsubscribes per bucket, two lines in
	// one hue (--viz-1 solid = new, --viz-3 dashed = unsubscribed) — the dash and the legend
	// carry identity, never colour alone. Hover or focus a bucket for its numbers.
	// See CLAUDE.md "Charts (#161)".
	type Point = { start: string; label: string; added: number; unsubscribed: number };
	let { points, unit }: { points: Point[]; unit: 'day' | 'week' | 'month' } = $props();

	const W = 360;
	const H = 120;
	const PAD = 6;
	const BASE = 96;

	const peak = $derived(Math.max(1, ...points.map((p) => Math.max(p.added, p.unsubscribed))));
	const totals = $derived({
		added: points.reduce((a, p) => a + p.added, 0),
		unsubscribed: points.reduce((a, p) => a + p.unsubscribed, 0)
	});
	const step = $derived(points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0);
	const xAt = (i: number) => (points.length > 1 ? PAD + i * step : W / 2);
	const yAt = (v: number) => BASE - (v / peak) * (BASE - PAD);
	const line = (key: 'added' | 'unsubscribed') => points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p[key]).toFixed(1)}`).join(' ');

	let active = $state<number | null>(null);
	const bucketWord = $derived(unit === 'day' ? '' : unit === 'week' ? 'Week of ' : '');
	const readout = $derived(
		active === null || !points[active]
			? `${totals.added} new · ${totals.unsubscribed} unsubscribed in this period`
			: `${bucketWord}${points[active].label}: ${points[active].added} new · ${points[active].unsubscribed} unsubscribed`
	);
	const summary = $derived(
		`New contacts and unsubscribes per ${unit}: ` + points.map((p) => `${p.label} ${p.added} new, ${p.unsubscribed} unsubscribed`).join('; ')
	);
</script>

<div class="growth">
	<ul class="legend" aria-label="Legend">
		<li><span class="sw new" aria-hidden="true"></span>New <strong>{totals.added}</strong></li>
		<li><span class="sw unsub" aria-hidden="true"></span>Unsubscribed <strong>{totals.unsubscribed}</strong></li>
	</ul>
	<p class="readout muted" aria-live="polite">{readout}</p>
	{#if points.length}
		<svg viewBox="0 0 {W} {H}" role="img" aria-label={summary} preserveAspectRatio="none">
			<line class="axis" x1={PAD} x2={W - PAD} y1={BASE} y2={BASE} />
			<polyline class="l-new" points={line('added')} />
			<polyline class="l-unsub" points={line('unsubscribed')} />
			{#if active !== null && points[active]}
				<line class="cursor" x1={xAt(active)} x2={xAt(active)} y1={PAD} y2={BASE} />
			{/if}
			<text class="tick" x={PAD} y={H - 4}>{points[0].label}</text>
			<text class="tick" x={W - PAD} y={H - 4} text-anchor="end">{points[points.length - 1].label}</text>
		</svg>
		<!-- Hit targets: one per bucket, hover + keyboard focus drive the readout. -->
		<div class="hits">
			{#each points as p, i (p.start)}
				<button
					type="button"
					class="hit"
					aria-label="{bucketWord}{p.label}: {p.added} new, {p.unsubscribed} unsubscribed"
					onmouseenter={() => (active = i)}
					onmouseleave={() => (active = null)}
					onfocus={() => (active = i)}
					onblur={() => (active = null)}
				></button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.growth {
		position: relative;
	}
	.legend {
		display: flex;
		gap: var(--space-m);
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
	.sw {
		display: inline-block;
		width: 16px;
		height: 0;
		border-top: 2px solid var(--viz-1);
	}
	.sw.unsub {
		border-top: 2px dashed var(--viz-3);
	}
	.readout {
		margin: var(--space-xxs) 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		min-height: var(--line-xs);
	}
	svg {
		display: block;
		width: 100%;
		height: 120px;
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
	.l-new {
		stroke: var(--viz-1);
	}
	.l-unsub {
		stroke: var(--viz-3);
		stroke-dasharray: 4 3;
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
		bottom: 0;
		height: 120px;
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

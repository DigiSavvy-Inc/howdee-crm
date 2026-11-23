<script lang="ts">
	// Lightweight bar / line chart for reports (#355, multi-series #454). No chart library.
	// Shaping (series, order, time placement, gaps) is `chartView` in $lib/report-view.
	// Series identity: --viz-1 / --viz-3 hue pair, lines 3–4 dashed; a legend whenever
	// there are 2+ series, so colour is never the only cue. A null is a gap: the line
	// breaks and draws no dot, a bar leaves an empty dashed slot ("no sends"), while a real
	// 0 is a 1px bar on the axis. Hover or arrow keys (focused chart) show every series
	// for that point in the readout. See CLAUDE.md "Charts".
	import type { MetricFormat } from '$lib/report-metrics';
	import { formatCell, lineSegments, shortLabel, type ChartView } from '$lib/report-view';

	let { kind, view }: { kind: 'bar' | 'line'; view: ChartView } = $props();

	const VB_W = 360;
	const PAD_X = 8;
	const PAD_TOP = 8;
	const BASE = 104;
	const INNER = VB_W - PAD_X * 2;

	// Tick labels (10px .tick): rotated bar labels are end-anchored at their bar and run
	// down-left at ANGLE degrees. The viewBox grows to hold every label (frame below).
	const TICK_PX = 10;
	const ASC = 10;
	const DESC = 3;
	const EDGE = 2;
	const ANGLE = 40;
	const TILT = (ANGLE * Math.PI) / 180;
	const COS = Math.cos(TILT);
	const SIN = Math.sin(TILT);

	const count = $derived(view.labels.length);
	const multi = $derived(view.series.length > 1);
	const rotate = $derived(kind === 'bar' && count > 6);
	const peak = $derived(
		Math.max(0, ...view.series.flatMap((series) => series.values.filter((value): value is number => value != null)))
	);
	const format = $derived<MetricFormat>(view.format);

	let active = $state<number | null>(null);

	function valueText(value: number | null, i: number): string {
		if (value == null) return view.noSends[i] || format === 'pct' ? 'no sends' : 'no data';
		return formatCell(value, format);
	}

	function pointText(i: number): string {
		const label = view.labels[i] || '—';
		if (!multi) return `${label}: ${valueText(view.series[0]!.values[i] ?? null, i)}`;
		return `${label}: ` + view.series.map((series) => `${series.label} ${valueText(series.values[i] ?? null, i)}`).join(', ');
	}

	const summary = $derived(
		count
			? `${kind === 'bar' ? 'Bar' : 'Line'} chart of ${view.series.map((series) => series.label).join(', ')}. ` +
				view.labels.map((_, i) => pointText(i)).join('; ')
			: ''
	);

	function yOf(value: number): number {
		if (peak <= 0) return BASE;
		return BASE - Math.max(0, (Math.max(0, value) / peak) * (BASE - PAD_TOP));
	}

	// Line: x by slot (time buckets keep their gaps).
	function slotX(slot: number): number {
		if (view.slotCount <= 1) return VB_W / 2;
		return PAD_X + (INNER * slot) / (view.slotCount - 1);
	}
	function pointX(i: number): number {
		return kind === 'bar' ? groupBox(i).x + groupBox(i).w / 2 : slotX(view.slots[i] ?? i);
	}

	// Bar: one group per point, one bar per series.
	function groupBox(i: number): { x: number; w: number } {
		const gap = count > 1 ? 6 : 0;
		const w = Math.min(multi ? 40 : 28, (INNER - gap * (count - 1)) / count);
		const used = w * count + gap * (count - 1);
		return { x: PAD_X + (INNER - used) / 2 + i * (w + gap), w };
	}
	function barBox(i: number, s: number): { x: number; w: number } {
		const group = groupBox(i);
		const n = view.series.length;
		const inner = n > 1 ? 1 : 0;
		const w = (group.w - inner * (n - 1)) / n;
		return { x: group.x + s * (w + inner), w };
	}

	// Hover zone for point i: halfway to its neighbours.
	function zone(i: number): { x: number; w: number } {
		if (kind === 'bar') return groupBox(i);
		const x = pointX(i);
		const left = i > 0 ? (pointX(i - 1) + x) / 2 : PAD_X;
		const right = i < count - 1 ? (pointX(i + 1) + x) / 2 : VB_W - PAD_X;
		return { x: left, w: Math.max(1, right - left) };
	}

	function showTick(i: number): boolean {
		if (kind === 'bar' || count <= 6) return true;
		const last = count - 1;
		const step = Math.ceil(last / 4);
		return i === last || (i % step === 0 && last - i >= step / 2);
	}

	const ticks = $derived(view.labels.map((label, i) => (showTick(i) ? shortLabel(label, rotate ? 14 : 12) : null)));

	// Advance width of a tick label from Inter glyph classes (measured at 10px), erring a
	// little wide: too wide costs a few units of gutter, too narrow cuts the label off again.
	function textWidth(text: string): number {
		let em = 0;
		for (const ch of text) {
			if (/[MWmw…%@—]/.test(ch)) em += 0.95;
			else if (/[A-Z]/.test(ch) && ch !== 'I') em += 0.72;
			else if (/[\s.,:;'|/!Iijlftr1()-]/.test(ch)) em += 0.42;
			else em += 0.63;
		}
		return em * TICK_PX;
	}

	// A label's box in viewBox units. Rotated: rotate(-ANGLE) about the anchor (x, BASE + 10)
	// puts the text's start corner lowest and leftmost, its end just right of the anchor.
	function tickBox(i: number, text: string): { left: number; right: number; bottom: number } {
		const x = pointX(i);
		const len = textWidth(text);
		if (!rotate) return { left: x - len / 2, right: x + len / 2, bottom: BASE + 16 + DESC };
		return { left: x - len * COS - ASC * SIN, right: x + DESC * SIN, bottom: BASE + 10 + len * SIN + DESC * COS };
	}

	// viewBox: the plot's 0..VB_W, widened left/right and deepened as the labels need.
	const frame = $derived.by(() => {
		let left = 0;
		let right = VB_W;
		let bottom = BASE + 24;
		ticks.forEach((text, i) => {
			if (text == null) return;
			const box = tickBox(i, text);
			left = Math.min(left, box.left - EDGE);
			right = Math.max(right, box.right + EDGE);
			bottom = Math.max(bottom, box.bottom + EDGE);
		});
		const x = Math.floor(left);
		return { x, w: Math.ceil(right) - x, h: Math.ceil(bottom) };
	});

	function onKey(event: KeyboardEvent) {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const cur = active ?? (event.key === 'ArrowRight' ? -1 : count);
		active = Math.max(0, Math.min(count - 1, cur + (event.key === 'ArrowRight' ? 1 : -1)));
	}

	function latest(values: (number | null)[]): { value: number | null; i: number } {
		for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return { value: values[i]!, i };
		return { value: null, i: values.length - 1 };
	}
</script>

{#if count === 0}
	<p class="muted empty">No points to chart.</p>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="plot"
		role="group"
		tabindex="0"
		aria-label="{summary} Arrow keys move between points."
		onkeydown={onKey}
		onblur={() => (active = null)}
		onmouseleave={() => (active = null)}
	>
		<svg class="chart" viewBox="{frame.x} 0 {frame.w} {frame.h}" aria-hidden="true">
			<line x1={PAD_X} y1={BASE} x2={VB_W - PAD_X} y2={BASE} class="axis" />
			{#if kind === 'bar'}
				{#each view.labels as _, i (i)}
					{#each view.series as series, s (series.key)}
						{@const box = barBox(i, s)}
						{@const value = series.values[i] ?? null}
						{#if value == null}
							<rect x={box.x + 0.5} y={BASE - 12} width={Math.max(1, box.w - 1)} height="11.5" rx="2" class="gap-slot" />
						{:else}
							{@const y = yOf(value)}
							<rect x={box.x} y={Math.min(y, BASE - 1)} width={box.w} height={Math.max(BASE - y, 1)} rx="2" class="bar s{s}" />
						{/if}
					{/each}
				{/each}
			{:else}
				{#each view.series as series, s (series.key)}
					{#each lineSegments(series.values, view.slots) as run, r (r)}
						{#if run.length > 1}
							<polyline points={run.map((i) => `${pointX(i)},${yOf(series.values[i]!)}`).join(' ')} class="line s{s}" />
						{/if}
					{/each}
					{#each series.values as value, i (i)}
						{#if value != null}
							<circle cx={pointX(i)} cy={yOf(value)} r={active === i ? 3.5 : 2.5} class="dot s{s}" />
						{/if}
					{/each}
				{/each}
				{#if active != null}
					<line x1={pointX(active)} y1={PAD_TOP} x2={pointX(active)} y2={BASE} class="cursor" />
				{/if}
			{/if}
			{#each ticks as text, i (i)}
				{#if text != null}
					{#if rotate}
						<text x={pointX(i)} y={BASE + 10} text-anchor="end" transform="rotate({-ANGLE} {pointX(i)} {BASE + 10})" class="tick">{text}</text>
					{:else}
						<text x={pointX(i)} y={BASE + 16} text-anchor="middle" class="tick">{text}</text>
					{/if}
				{/if}
			{/each}
			{#each view.labels as _, i (i)}
				{@const z = zone(i)}
				<rect x={z.x} y={PAD_TOP} width={z.w} height={BASE - PAD_TOP} class="hit" role="presentation" onmouseenter={() => (active = i)}>
					<title>{pointText(i)}</title>
				</rect>
			{/each}
		</svg>
	</div>
	<p class="readout" aria-live="polite">{active != null ? pointText(active) : ''}</p>
	{#if multi}
		<ul class="legend" aria-label="Legend">
			{#each view.series as series, s (series.key)}
				{@const shown = active != null ? { value: series.values[active] ?? null, i: active } : latest(series.values)}
				<li>
					<svg class="swatch" viewBox="0 0 16 10" aria-hidden="true">
						{#if kind === 'line'}
							<line x1="1" y1="5" x2="15" y2="5" class="line s{s}" />
						{:else}
							<rect x="3" y="0" width="10" height="10" rx="2" class="bar s{s}" />
						{/if}
					</svg>
					<span>{series.label}</span>
					<span class="value">{valueText(shown.value, shown.i)}</span>
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<style>
	.chart {
		display: block;
		width: 100%;
		height: auto;
		max-height: 11rem;
	}
	.plot {
		outline-offset: 4px;
	}
	.axis {
		stroke: var(--border);
		stroke-width: 1;
	}
	.cursor {
		stroke: var(--border);
		stroke-width: 1;
	}
	.hit {
		fill: transparent;
	}
	.bar.s0,
	.dot.s0,
	.dot.s2 {
		fill: var(--viz-1);
	}
	.bar.s1,
	.dot.s1,
	.dot.s3 {
		fill: var(--viz-3);
	}
	.bar.s2 {
		fill: var(--viz-2);
	}
	.bar.s3 {
		fill: color-mix(in srgb, var(--viz-1) 45%, var(--surface));
	}
	.gap-slot {
		fill: none;
		stroke: var(--border);
		stroke-width: 1;
		stroke-dasharray: 2 2;
	}
	.line {
		fill: none;
		stroke-width: 1.75;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.line.s0,
	.line.s2 {
		stroke: var(--viz-1);
	}
	.line.s1,
	.line.s3 {
		stroke: var(--viz-3);
	}
	.line.s2,
	.line.s3 {
		stroke-dasharray: 4 3;
	}
	.tick {
		fill: var(--muted);
		font-family: var(--font-ui);
		font-size: 10px;
		font-weight: var(--weight-ui-regular);
	}
	.readout {
		min-height: var(--line-s);
		margin: var(--space-xxs) 0 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.legend {
		list-style: none;
		margin: var(--space-xxs) 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xxs) var(--space-m);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.swatch {
		width: 16px;
		height: 10px;
		flex: none;
	}
	.value {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.empty {
		margin: 0;
	}
</style>

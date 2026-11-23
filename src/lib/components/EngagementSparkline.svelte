<script lang="ts">
	// Monthly opens/clicks sparkline (#114) for the contact Engagement card. Paired thin
	// bars per month, one sequential hue (--viz-2 opens, --viz-1 clicks — clicks are the
	// stronger signal, so the "most" step), a legend with totals, and a hover/focus
	// tooltip per month. View math is pure in `$lib/engagement-view`. See CLAUDE.md "Charts".
	import { barHeights, monthLabel, type MonthPoint } from '$lib/engagement-view';

	let { points }: { points: MonthPoint[] } = $props();

	const MAX_PX = 36;
	const heights = $derived(barHeights(points, MAX_PX));
	const totals = $derived(
		points.reduce((a, p) => ({ opens: a.opens + p.opens, clicks: a.clicks + p.clicks }), { opens: 0, clicks: 0 })
	);
	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
</script>

<div class="sp">
	<div class="sp-bars" role="group" aria-label="Opens and clicks per month, last {points.length} months">
		{#each points as p, i (p.month)}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="sp-col"
				class:first={i === 0}
				class:last={i === points.length - 1}
				tabindex="0"
				role="img"
				aria-label="{monthLabel(p.month)}: {plural(p.opens, 'open')}, {plural(p.clicks, 'click')}"
			>
				<span class="sp-bar opens" style="height: {heights[i].opens}px" aria-hidden="true"></span>
				<span class="sp-bar clicks" style="height: {heights[i].clicks}px" aria-hidden="true"></span>
				<span class="sp-tip" aria-hidden="true">
					<strong>{monthLabel(p.month)}</strong>
					<span>{plural(p.opens, 'open')} · {plural(p.clicks, 'click')}</span>
				</span>
			</div>
		{/each}
	</div>
	<div class="sp-axis muted" aria-hidden="true">
		<span>{monthLabel(points[0]?.month ?? '')}</span>
		<span>{monthLabel(points[points.length - 1]?.month ?? '')}</span>
	</div>
	<ul class="sp-legend">
		<li><span class="sp-swatch opens" aria-hidden="true"></span>Opens <span class="sp-count">{totals.opens}</span></li>
		<li><span class="sp-swatch clicks" aria-hidden="true"></span>Clicks <span class="sp-count">{totals.clicks}</span></li>
	</ul>
</div>

<style>
	/* Shrink-wrap so the axis labels line up with the bars' ends. */
	.sp {
		display: inline-block;
		min-width: 12rem;
	}
	.sp-bars {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		height: 36px;
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted);
	}
	.sp-col {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 100%;
		outline-offset: 3px;
	}
	.sp-bar {
		display: block;
		width: 6px;
		border-radius: 2px 2px 0 0;
	}
	.opens {
		background: var(--viz-2);
	}
	.clicks {
		background: var(--viz-1);
	}
	.sp-tip {
		display: none;
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 5;
		flex-direction: column;
		gap: var(--space-xxs);
		padding: var(--space-xs) var(--space-s);
		white-space: nowrap;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--tracking-l);
		color: var(--neutral-10);
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-s);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
		pointer-events: none;
	}
	.sp-col.first .sp-tip {
		left: 0;
		transform: none;
	}
	.sp-col.last .sp-tip {
		left: auto;
		right: 0;
		transform: none;
	}
	.sp-col:hover .sp-tip,
	.sp-col:focus-visible .sp-tip {
		display: flex;
	}
	.sp-axis {
		display: flex;
		justify-content: space-between;
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		letter-spacing: var(--letter-spacing-xxs);
		margin-top: var(--space-xxs);
	}
	.sp-legend {
		display: flex;
		gap: var(--space-m);
		list-style: none;
		margin: var(--space-xs) 0 0;
		padding: 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.sp-legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.sp-swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}
	.sp-count {
		font-family: var(--font-data);
		font-weight: var(--weight-data-heavy);
	}
</style>

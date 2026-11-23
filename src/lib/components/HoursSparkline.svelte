<script lang="ts">
	// Weekly Timing hours sparkline (#567) for the company page's Timing panel. One series, one
	// hue (--viz-1), thin bars; a week with no snapshot is an empty dashed slot (a gap, never 0),
	// a real 0 is a 1px bar. Hover / keyboard-focus tooltip per week. Math: `$lib/company-panels`.
	import { sparkHeights, type WeekHours } from '$lib/company-panels';
	import { fmtHours } from '$lib/timing-format';

	let { weeks }: { weeks: WeekHours[] } = $props();

	const MAX_PX = 32;
	const heights = $derived(sparkHeights(weeks.map((w) => w.hours), MAX_PX));
	const label = (w: string) => new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const text = (w: WeekHours) => (w.hours == null ? 'no snapshot' : `${fmtHours(w.hours)} tracked`);
</script>

<div class="hs">
	<div class="hs-bars" role="group" aria-label="Timing hours per week, last {weeks.length} weeks">
		{#each weeks as w, i (w.week)}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="hs-col" class:first={i < 2} class:last={i > weeks.length - 3} tabindex="0" role="img" aria-label="Week of {label(w.week)}: {text(w)}">
				{#if heights[i] == null}
					<span class="hs-gap" aria-hidden="true"></span>
				{:else}
					<span class="hs-bar" style="height: {heights[i]}px" aria-hidden="true"></span>
				{/if}
				<span class="hs-tip" aria-hidden="true"><strong>Week of {label(w.week)}</strong><span>{text(w)}</span></span>
			</div>
		{/each}
	</div>
	<div class="hs-axis muted" aria-hidden="true">
		<span>{label(weeks[0]?.week ?? '')}</span>
		<span>this week</span>
	</div>
</div>

<style>
	.hs {
		max-width: 16rem;
		margin-top: var(--space-xs);
	}
	.hs-bars {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		height: 32px;
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted);
	}
	.hs-col {
		position: relative;
		flex: 1 1 0;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		height: 100%;
		outline-offset: 3px;
	}
	.hs-bar {
		display: block;
		width: 100%;
		max-width: 12px;
		border-radius: 2px 2px 0 0;
		background: var(--viz-1);
	}
	.hs-gap {
		display: block;
		width: 100%;
		max-width: 12px;
		height: 8px;
		border: 1px dashed var(--border);
		border-bottom: 0;
		border-radius: 2px 2px 0 0;
	}
	.hs-tip {
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
		color: var(--neutral-10);
		background: var(--surface);
		border-radius: var(--radius-s);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
		pointer-events: none;
	}
	.hs-col.first .hs-tip {
		left: 0;
		transform: none;
	}
	.hs-col.last .hs-tip {
		left: auto;
		right: 0;
		transform: none;
	}
	.hs-col:hover .hs-tip,
	.hs-col:focus-visible .hs-tip {
		display: flex;
	}
	.hs-axis {
		display: flex;
		justify-content: space-between;
		font-size: var(--size-xxs);
		line-height: var(--line-xxs);
		margin-top: var(--space-xxs);
	}
</style>

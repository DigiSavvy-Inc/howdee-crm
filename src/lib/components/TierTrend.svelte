<script lang="ts">
	// Tier distribution now + 90-day trend (#116), one row per tier: count, share-of-contacts
	// bar and a sparkline of daily snapshots (`engagement_tier_daily`). Single hue: the share
	// bar is --viz-2, the trend line --viz-1; each row is labelled, so no colour carries
	// identity. Hover/focus a row's trend for its first → latest values. See CLAUDE.md "Charts".
	import { TIERS, TIER_LABELS, type TierName } from '$lib/engagement-view';
	import { sparkPoints, trendEnds, signed, monthDay } from '$lib/engagement-insights-view';

	type Trend = { days: string[]; series: Record<TierName, (number | null)[]>; snapshots: number };
	// #423: `trend` null = counts and shares only (the contacts Overview when a filter is on —
	// the daily snapshots are audience-wide). `tierHref` overrides each tier's link.
	let {
		tiers,
		trend = null,
		tierHref = (t: string) => `/contacts?tier=${t}`
	}: { tiers: Record<string, number>; trend?: Trend | null; tierHref?: (t: string) => string } = $props();

	const W = 90;
	const H = 20;
	const total = $derived(TIERS.reduce((a, t) => a + (tiers[t] ?? 0), 0));
	const firstDay = $derived(trend ? (trend.days.find((_, i) => TIERS.some((t) => trend.series[t][i] !== null)) ?? null) : null);
</script>

<table class="tt">
	<thead>
		<tr>
			<th scope="col">Tier</th>
			<th scope="col" class="num">Now</th>
			<th scope="col">Share</th>
			{#if trend}<th scope="col">{trend.days.length}-day trend</th>{/if}
		</tr>
	</thead>
	<tbody>
		{#each TIERS as t (t)}
			{@const n = tiers[t] ?? 0}
			{@const share = total ? n / total : 0}
			{@const ends = trend ? trendEnds(trend.series[t]) : null}
			{@const pts = trend ? sparkPoints(trend.series[t], W, H) : null}
			<tr>
				<th scope="row"><a href={tierHref(t)}>{TIER_LABELS[t]}</a></th>
				<td class="num">{n}</td>
				<td>
					<span class="share" title="{Math.round(share * 100)}% of contacts">
						<span class="share-bar" style="width: {n > 0 ? Math.max(3, share * 100) : 0}%"></span>
					</span>
				</td>
				{#if trend}<td>
					{#if pts && ends}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<span
							class="spark"
							tabindex="0"
							role="img"
							aria-label="{TIER_LABELS[t]}: {ends.first} on {monthDay(trend.days[ends.firstIdx])}, {ends.last} now"
						>
							<svg width={W} height={H} viewBox="-1 -1 {W + 2} {H + 2}" aria-hidden="true">
								<polyline points={pts} />
							</svg>
							<span class="delta">{signed(ends.last - ends.first)}</span>
							<span class="tip" aria-hidden="true">
								<strong>{TIER_LABELS[t]}</strong>
								<span>{monthDay(trend.days[ends.firstIdx])}: {ends.first} → now: {ends.last}</span>
							</span>
						</span>
					{:else}
						<span class="muted">—</span>
					{/if}
				</td>{/if}
			</tr>
		{/each}
	</tbody>
</table>
{#if trend && trend.snapshots < 2}
	<p class="muted note">
		The trend fills in from one snapshot a day{firstDay ? ` (first: ${monthDay(firstDay)})` : ''}.
	</p>
{/if}

<style>
	.tt {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.tt th,
	.tt td {
		padding: var(--space-xxs) var(--space-xs);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted);
		text-align: left;
		font-weight: var(--weight-data-regular);
		white-space: nowrap;
	}
	.tt thead th {
		background: none;
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	.tt tbody tr:last-child th,
	.tt tbody tr:last-child td {
		box-shadow: none;
	}
	.num {
		text-align: right !important;
		font-variant-numeric: tabular-nums;
		font-weight: var(--weight-data-heavy);
	}
	.share {
		display: block;
		width: 5rem;
		height: 8px;
		background: var(--neutral-3);
		border-radius: 4px;
		overflow: hidden;
	}
	.share-bar {
		display: block;
		height: 100%;
		background: var(--viz-2);
		border-radius: 4px;
	}
	.spark {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		outline-offset: 2px;
	}
	.spark polyline {
		fill: none;
		stroke: var(--viz-1);
		stroke-width: 1.5;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.delta {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.tip {
		display: none;
		position: absolute;
		bottom: calc(100% + var(--space-xs));
		right: 0;
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
	.spark:hover .tip,
	.spark:focus-visible .tip {
		display: flex;
	}
	.note {
		margin: var(--space-xs) 0 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
</style>

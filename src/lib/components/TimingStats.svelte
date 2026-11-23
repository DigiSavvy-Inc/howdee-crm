<script lang="ts">
	// Timing numbers for a company (#168): hours 7d / 30d / 90d / total + last tracked entry.
	// Used on the company page's Integrations card and the contact page's Company card.
	import { fmtHours, timeAgo } from '$lib/timing-format';
	type Timing = {
		hours_7d: number | null;
		hours_30d: number | null;
		hours_90d: number | null;
		hours_total: number | null;
		last_tracked_at: string | null;
		last_tracked_title: string | null;
		timing_synced_at: string | null;
	};
	let { timing }: { timing: Timing } = $props();
</script>

{#if timing.timing_synced_at}
	<dl class="hours">
		<div><dt>7 days</dt><dd>{fmtHours(timing.hours_7d)}</dd></div>
		<div><dt>30 days</dt><dd>{fmtHours(timing.hours_30d)}</dd></div>
		<div><dt>90 days</dt><dd>{fmtHours(timing.hours_90d)}</dd></div>
		<div><dt>Total</dt><dd>{fmtHours(timing.hours_total)}</dd></div>
	</dl>
	<p class="last muted">
		Last tracked:
		{#if timing.last_tracked_at}
			<span class="title">{timing.last_tracked_title ?? '(untitled)'}</span> · {timeAgo(timing.last_tracked_at)}
		{:else}—{/if}
	</p>
{:else}
	<p class="muted last">Not synced yet.</p>
{/if}

<style>
	.hours { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-l); margin: var(--space-xs) 0; }
	.hours div { display: flex; flex-direction: column; }
	.hours dt { color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.hours dd {
		margin: 0;
		font-family: var(--font-data);
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
		font-weight: var(--weight-data-heavy);
		font-variant-numeric: tabular-nums;
	}
	.last { font-size: var(--size-s); line-height: var(--line-s); margin: var(--space-xxs) 0 0; overflow-wrap: anywhere; }
	.title { color: var(--text); }
</style>

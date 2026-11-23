<script lang="ts">
	// Campaign Engagement bar (#161): one horizontal part-to-whole bar of accepted
	// recipients — Clicked · Opened, no click · No interaction — plus a legend row.
	// Pure: props in, markup out. Colors are the --viz-1/2/3 tokens in app.css (one
	// sequential teal ramp, separate validated steps for dark). See CLAUDE.md "Charts".
	import { barSegments, engagementHeadline, engagementNote, type EngagementCounts } from '$lib/engagement-bar';

	let {
		breakdown,
		collecting = false,
		whoHref
	}: {
		breakdown: EngagementCounts;
		/** Sends still in flight — numbers will keep moving. */
		collecting?: boolean;
		/** Link for a segment's recipient list (the page's ?who= drill-down). */
		whoHref: (key: 'clicked' | 'opened' | 'none') => string;
	} = $props();

	const segments = $derived(barSegments(breakdown));
	const visible = $derived(segments.filter((s) => s.count > 0));
	const head = $derived(engagementHeadline(breakdown));
	const note = $derived(engagementNote(breakdown));
	const fmt = (n: number) => n.toLocaleString('en-US');
	const autoOpens = $derived(
		breakdown.proxyOpens > 0 ? ` (incl. ${fmt(breakdown.proxyOpens)} auto-open${breakdown.proxyOpens === 1 ? '' : 's'})` : ''
	);
</script>

<div class="eb">
	<div class="eb-head">
		<span class="eb-big"><strong>{fmt(head.interacted)}</strong> interacted <span class="muted">of {fmt(breakdown.sent)}</span></span>
		<span class="eb-rate">
			{#if collecting}<span class="muted eb-collecting">collecting…</span>{/if}
			<strong>{head.rate}%</strong>
		</span>
	</div>

	{#if visible.length > 0}
		<div class="eb-bar" role="group" aria-label="Engagement breakdown">
			{#each visible as seg, i (seg.key)}
				<a
					class="eb-seg"
					class:first={i === 0}
					class:last={i === visible.length - 1}
					style="flex-grow: {seg.count}; background: {seg.color}"
					href={whoHref(seg.key)}
					aria-label="{seg.label}: {fmt(seg.count)} ({seg.pct}%){seg.key === 'opened' ? autoOpens : ''} — see who"
				>
					<span class="eb-tip" aria-hidden="true">
						<strong>{seg.label}</strong>
						<span>{fmt(seg.count)} · {seg.pct}%{seg.key === 'opened' ? autoOpens : ''}</span>
						<span class="eb-who">See who →</span>
					</span>
				</a>
			{/each}
		</div>
	{:else}
		<p class="muted eb-empty">Nothing delivered yet.</p>
	{/if}

	<ul class="eb-legend">
		{#each segments as seg (seg.key)}
			<li title={seg.key === 'opened' && autoOpens ? `Opened${autoOpens} — opens include Apple Mail auto-opens` : undefined}>
				<span class="eb-swatch" style="background: {seg.color}" aria-hidden="true"></span>
				<a href={whoHref(seg.key)}>{seg.label}</a>
				<span class="eb-count">{fmt(seg.count)}</span>
				<span class="muted">{seg.pct}%</span>
			</li>
		{/each}
	</ul>
	{#if note}<p class="muted eb-note">{note}</p>{/if}
</div>

<style>
	.eb-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-m);
		margin-bottom: var(--space-xs);
	}
	.eb-big strong,
	.eb-rate strong {
		font-family: var(--font-data);
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
		font-weight: var(--weight-data-heavy);
	}
	.eb-collecting {
		font-size: var(--size-s);
		line-height: var(--line-s);
		margin-right: var(--space-xs);
	}
	/* 12px bar; the 2px flex gap shows the card surface between segments. */
	.eb-bar {
		display: flex;
		gap: 2px;
		height: 12px;
	}
	.eb-seg {
		position: relative;
		flex-basis: 0;
		min-width: 3px; /* a non-zero segment never vanishes; its label lives in the legend */
		display: block;
		outline-offset: 3px;
	}
	/* Hit target taller than the 12px mark. */
	.eb-seg::before {
		content: '';
		position: absolute;
		inset: -6px 0;
	}
	.eb-seg.first {
		border-radius: 4px 0 0 4px;
	}
	.eb-seg.last {
		border-radius: 0 4px 4px 0;
	}
	.eb-seg.first.last {
		border-radius: 4px;
	}
	.eb-tip {
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
	.eb-seg.first .eb-tip {
		left: 0;
		transform: none;
	}
	.eb-seg.last:not(.first) .eb-tip {
		left: auto;
		right: 0;
		transform: none;
	}
	.eb-seg:hover .eb-tip,
	.eb-seg:focus-visible .eb-tip {
		display: flex;
	}
	.eb-who {
		color: var(--text);
	}
	.eb-empty {
		margin: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.eb-legend {
		list-style: none;
		margin: var(--space-s) 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs) var(--space-l);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.eb-legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.eb-legend a {
		color: var(--text);
	}
	.eb-swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex-shrink: 0;
	}
	.eb-count {
		font-family: var(--font-data);
		font-weight: var(--weight-data-heavy);
	}
	.eb-note {
		margin: var(--space-xs) 0 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
</style>

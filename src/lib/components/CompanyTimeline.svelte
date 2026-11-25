<script lang="ts">
	// Company timeline (#566): the account's activity — its contacts plus Gmail, GitHub, billing
	// and Timing — with source chips (`?tl=`) and "Show more" (`?tl_n=`). Rows: ActivityFeed.
	import { page } from '$app/state';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import { TIMELINE_SOURCES, TIMELINE_SIZES, nextTimelineSize } from '$lib/company-timeline';
	import type { CompanyTimeline } from '$lib/server/company-timeline';

	let { timeline }: { timeline: CompanyTimeline } = $props();

	const now = $derived.by(() => {
		void timeline;
		return new Date();
	});
	const chips = $derived(TIMELINE_SOURCES.filter((s) => timeline.sources.includes(s.key)));
	const next = $derived(timeline.more ? nextTimelineSize(timeline.size) : null);

	function href(over: { tl?: string; tl_n?: number }): string {
		const p = new URLSearchParams(page.url.searchParams.toString());
		if (over.tl !== undefined) {
			if (over.tl === 'all') p.delete('tl');
			else p.set('tl', over.tl);
			p.delete('tl_n'); // a new filter starts at the first page size
		}
		if (over.tl_n !== undefined) {
			if (over.tl_n === TIMELINE_SIZES[0]) p.delete('tl_n');
			else p.set('tl_n', String(over.tl_n));
		}
		const q = p.toString();
		return `${page.url.pathname}${q ? `?${q}` : ''}#timeline`;
	}
</script>

<section class="card" id="timeline">
	<h2>Timeline</h2>
	{#if chips.length > 1}
		<nav class="chips" aria-label="Timeline sources">
			<a class="chip" class:on={timeline.filter === 'all'} aria-current={timeline.filter === 'all' ? 'true' : undefined} href={href({ tl: 'all' })} data-sveltekit-reset="false">All</a>
			{#each chips as c (c.key)}
				<a class="chip" class:on={timeline.filter === c.key} aria-current={timeline.filter === c.key ? 'true' : undefined} href={href({ tl: c.key })} data-sveltekit-reset="false">{c.label}</a>
			{/each}
		</nav>
	{/if}
	{#if timeline.items.length === 0}
		<p class="muted empty">
			{timeline.sources.length ? 'Nothing here yet.' : 'No activity yet. It shows up here once a contact of this company opens, clicks, replies or visits, or a connected tool syncs.'}
		</p>
	{:else}
		<ActivityFeed items={timeline.items} {now} />
		{#if next}
			<p class="more"><a href={href({ tl_n: next })} data-sveltekit-reset="false">Show more</a></p>
		{/if}
	{/if}
</section>

<style>
	section {
		margin-bottom: var(--space-l);
	}
	h2 {
		margin-top: 0;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-bottom: var(--space-s);
	}
	.chip {
		padding: 0 var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	.chip:hover {
		text-decoration: none;
		color: var(--text);
		background: var(--neutral-muted);
	}
	.chip.on {
		color: var(--text);
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.empty,
	.more {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		margin: var(--space-s) 0 0;
	}
	@media (max-width: 768px) {
		.chip {
			padding: var(--space-xxs) var(--space-s);
		}
	}
</style>

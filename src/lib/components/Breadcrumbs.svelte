<script lang="ts">
	// Sitewide breadcrumbs for detail and sub pages (#265). The last item is the current page.
	// ≤ 640px the trail collapses to a single "← Parent" link (the nearest linked ancestor).
	import { crumbParent, crumbView, type Crumb } from '$lib/breadcrumbs';

	let { items }: { items: Crumb[] } = $props();

	const crumbs = $derived(crumbView(items));
	const parent = $derived(crumbParent(items));
</script>

<nav class="crumbs" aria-label="Breadcrumb">
	<ol class="trail">
		{#each crumbs as c, i (i)}
			<li class:current={c.current}>
				{#if c.current}
					<span aria-current="page" title={c.label}>{c.label}</span>
				{:else if c.href}
					<a href={c.href}>{c.label}</a>
				{:else}
					<span>{c.label}</span>
				{/if}
				{#if !c.current}<span class="sep" aria-hidden="true">›</span>{/if}
			</li>
		{/each}
	</ol>
	{#if parent}<a class="up" href={parent.href}>← {parent.label}</a>{/if}
</nav>

<style>
	.crumbs {
		margin: 0 0 var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		min-width: 0;
	}
	.trail {
		display: flex;
		align-items: baseline;
		gap: var(--space-xxs);
		margin: 0;
		padding: 0;
		list-style: none;
		min-width: 0;
	}
	li {
		display: flex;
		align-items: baseline;
		gap: var(--space-xxs);
		white-space: nowrap;
		color: var(--muted);
	}
	li.current {
		min-width: 0;
		overflow: hidden;
	}
	li.current span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.up {
		display: none;
	}
	@media (max-width: 640px) {
		.trail {
			display: none;
		}
		.up {
			display: inline;
		}
	}
</style>

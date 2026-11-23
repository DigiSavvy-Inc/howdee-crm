<script lang="ts">
	import logomark from '$lib/assets/logomark.svg';
	import UnsubscribeView from '$lib/components/UnsubscribeView.svelte';
	import { DEFAULT_BRANDING } from '$lib/branding';
	let { data } = $props();

	const branding = $derived(data.branding ?? DEFAULT_BRANDING);
	const states = [
		{ id: 'before', label: 'Before unsubscribing' },
		{ id: 'after', label: 'After unsubscribing' }
	] as const;
</script>

<svelte:head>
	<title>Unsubscribe page preview</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="bar" role="note">
	<strong>Preview</strong> — what a subscriber sees, with a sample address. Buttons don't do anything here.
	<a href="/settings/unsubscribe">Back to Settings</a>
</div>

{#each states as s (s.id)}
	<section aria-label={s.label}>
		<h2 class="state">{s.label}</h2>
		<UnsubscribeView
			cfg={data.page}
			logoSrc={branding.logoUrl ?? logomark}
			appName={branding.appName}
			state={s.id}
			email={data.email}
			topics={data.topics}
			preview
		/>
	</section>
{/each}

<style>
	.bar {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs) var(--space-m);
		align-items: center;
		padding: var(--space-xs) 16px;
		background: var(--surface-subtle);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	section { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.state {
		margin: 0;
		padding: var(--space-m) 16px 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium);
		color: var(--neutral-7);
		text-transform: uppercase;
	}
	section :global(.wrap) { min-height: auto; }
</style>

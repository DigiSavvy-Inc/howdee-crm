<script lang="ts">
	// #639: the centred card the signed-out account pages share (/invite, /reset, /verify) —
	// the same look as /login.
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import logomark from '$lib/assets/logomark.svg';
	import { DEFAULT_APP_NAME } from '$lib/branding';

	let { title, sub = '', children }: { title: string; sub?: string; children: Snippet } = $props();
	const branding = $derived(page.data.branding as { logoUrl?: string | null; appName?: string } | undefined);
	const logoSrc = $derived(branding?.logoUrl ?? logomark);
</script>

<svelte:head><title>{title} · {branding?.appName ?? DEFAULT_APP_NAME}</title></svelte:head>

<div class="wrap">
	<div class="card">
		<img class="logo" src={logoSrc} alt="" width="40" height="40" />
		<h1>{title}</h1>
		{#if sub}<p class="sub">{sub}</p>{/if}
		{@render children()}
	</div>
</div>

<style>
	.wrap {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: var(--space-m);
	}
	.card {
		width: 100%;
		max-width: 360px;
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		padding: var(--space-xl);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
	}
	.logo {
		display: block;
		border-radius: 50%;
	}
	h1 {
		margin: 0;
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
	}
	.sub {
		margin: 0;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.card :global(form) {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.card :global(label) {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	.card :global(input) {
		padding: var(--space-s);
		border-radius: var(--radius-s);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		background: var(--bg);
		color: var(--text);
	}
	.card :global(.field-err) {
		color: var(--danger);
	}
	.card :global(.hint) {
		margin: 0;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
</style>

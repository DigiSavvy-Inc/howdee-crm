<script lang="ts">
	// #509: the thanks page after a native (no-JS) form post. Same look as the form.
	import logomark from '$lib/assets/logomark.svg';
	import { DEFAULT_BRANDING } from '$lib/branding';
	import { styleVars } from '$lib/forms';
	let { data } = $props();
	const branding = $derived(data.branding ?? DEFAULT_BRANDING);
</script>

<svelte:head>
	<title>{data.title}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="thanks" style={styleVars(data.style)}>
	<div class="inner">
		{#if data.style.logo}<img class="logo" src={branding.logoUrl ?? logomark} alt={branding.appName} height="40" />{/if}
		<div class="md" role="status">{@html data.message_html}</div>
	</div>
</div>

<style>
	.thanks {
		min-height: 100dvh;
		background: var(--f-bg);
		color: var(--f-text);
		font-family: var(--f-font);
		font-size: 16px;
		line-height: 1.5;
		padding: 40px 16px;
	}
	.inner { max-width: var(--f-width); margin: 0 auto; }
	.logo { display: block; height: 40px; width: auto; max-width: 200px; margin: 0 0 16px; }
	.md :global(p) { margin: 0 0 10px; }
	.md :global(a) { color: inherit; text-decoration-color: var(--f-accent); }
</style>

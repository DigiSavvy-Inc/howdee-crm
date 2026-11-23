<script lang="ts">
	import { onMount } from 'svelte';
	import logomark from '$lib/assets/logomark.svg';
	import FormRenderer from '$lib/components/FormRenderer.svelte';
	import { DEFAULT_BRANDING } from '$lib/branding';
	import { EMBED_HEIGHT_MSG, EMBED_REDIRECT_MSG } from '$lib/form-embed';
	let { data } = $props();
	const branding = $derived(data.branding ?? DEFAULT_BRANDING);

	// #515: embedded (`?embed=1`): post the content height to the host page (embed.js sizes the
	// iframe) on load, resize, page step and the thank-you swap; a redirect outcome goes to the host.
	let root = $state<HTMLDivElement | null>(null);
	const target = $derived(data.embed?.origin ?? '*');
	function post(msg: Record<string, unknown>) {
		if (!data.embed || window.parent === window) return;
		window.parent.postMessage({ ...msg, slug: data.form.slug }, target);
	}
	onMount(() => {
		if (!data.embed || !root) return;
		const send = () => post({ type: EMBED_HEIGHT_MSG, height: Math.ceil(root!.getBoundingClientRect().height) });
		send();
		const ro = new ResizeObserver(send);
		ro.observe(root);
		return () => ro.disconnect();
	});
	const onredirect = $derived(
		data.embed && typeof window !== 'undefined' && window.parent !== window
			? (url: string) => post({ type: EMBED_REDIRECT_MSG, url })
			: null
	);
	const hiddenFields = $derived({
		...(data.embed?.pageUrl ? { _page_url: data.embed.pageUrl } : {}),
		...(data.embed?.referrer ? { _ref: data.embed.referrer } : {}),
		...(data.contactToken ? { _c: data.contactToken } : {})
	});
</script>

<svelte:head>
	<title>{data.spec.title}</title>
	{#if data.spec.settings.noindex}<meta name="robots" content="noindex" />{/if}
	<meta name="color-scheme" content="light dark" />
	{#if data.embed}
		<!-- #515: the host page shows through the frame. -->
		{@html '<' + 'style>html,body{background:transparent!important;margin:0}</' + 'style>'}
	{/if}
</svelte:head>

<div class="public-form" class:embed={!!data.embed} style={data.embed ? '' : `background:${data.spec.style.bg}`} bind:this={root}>
	<FormRenderer
		spec={data.spec}
		style={data.spec.style}
		prefill={data.prefill}
		action={data.embed ? `/f/${data.form.slug}/submit?embed=1` : `/f/${data.form.slug}/submit`}
		embedded={!!data.embed}
		logoSrc={branding.logoUrl ?? logomark}
		appName={branding.appName}
		error={data.submitError}
		{hiddenFields}
		lockedKey={data.lockedKey}
		{onredirect}
	/>
</div>

<style>
	.public-form { min-height: 100dvh; }
	.public-form.embed { min-height: 0; }
</style>

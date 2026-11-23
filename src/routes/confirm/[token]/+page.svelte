<script lang="ts">
	import logomark from '$lib/assets/logomark.svg';
	import ConfirmView from '$lib/components/ConfirmView.svelte';
	import { DEFAULT_BRANDING } from '$lib/branding';
	import type { ConfirmState } from '$lib/double-optin';
	let { data, form } = $props();

	const branding = $derived(data.branding ?? DEFAULT_BRANDING);
	const state = $derived<ConfirmState>((form?.state as ConfirmState | undefined) ?? data.state);
	const email = $derived((form?.email as string | undefined) || data.email);
	const error = $derived(form && 'error' in form ? ((form.error as string | undefined) ?? null) : null);
	// After a refused re-send the button stays off; otherwise the load's answer.
	const canResend = $derived(error ? false : data.canResend);
</script>

<svelte:head>
	<title>{state === 'confirmed' ? 'You’re in' : 'Confirm your subscription'}</title>
	<meta name="robots" content="noindex" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<ConfirmView cfg={data.cfg} logoSrc={branding.logoUrl ?? logomark} appName={branding.appName} {state} {email} {error} {canResend} accent={data.accent} />

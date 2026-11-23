<script lang="ts">
	import logomark from '$lib/assets/logomark.svg';
	import UnsubscribeView from '$lib/components/UnsubscribeView.svelte';
	import { DEFAULT_BRANDING } from '$lib/branding';
	import type { UnsubState } from '$lib/unsubscribe-page';
	let { data, form } = $props();

	const branding = $derived(data.branding ?? DEFAULT_BRANDING);
	const state = $derived<UnsubState>(
		form && 'resubscribed' in form && form.resubscribed
			? 'resubscribed'
			: (form && 'success' in form && form.success) || (form && 'resubError' in form)
				? 'after'
				: form && 'prefsSaved' in form && form.prefsSaved
					? 'prefsSaved'
					: data.invalid
						? 'invalid'
						: 'before'
	);
	const email = $derived(
		(form && 'email' in form && typeof form.email === 'string' && form.email) || (data.invalid ? '' : data.email)
	);
	const error = $derived(
		form && 'resubError' in form ? (form.resubError ?? null) : form && 'error' in form ? (form.error ?? null) : null
	);
</script>

<svelte:head>
	<title>{state === 'after' ? data.page.afterHeading : 'Unsubscribe'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<UnsubscribeView
	cfg={data.page}
	logoSrc={branding.logoUrl ?? logomark}
	appName={branding.appName}
	{state}
	{email}
	token={data.invalid ? '' : (data.token ?? '')}
	topics={data.invalid ? [] : data.topics}
	footerTopic={data.invalid ? null : data.footerTopic}
	listOrigin={data.invalid ? null : data.listOrigin}
	subscribed={data.invalid ? true : data.subscribed}
	{error}
	prefsKept={form && 'kept' in form ? (form.kept ?? null) : null}
	stillUnsubscribed={!!(form && 'stillUnsubscribed' in form && form.stillUnsubscribed)}
/>

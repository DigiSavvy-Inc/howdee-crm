<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountCard from '$lib/components/AccountCard.svelte';
	let { data, form } = $props();
	const verified = $derived(!!form && 'verified' in form && !!form.verified);
</script>

<AccountCard title="Confirm your email">
	{#if verified}
		<p class="notice ok" role="status">Your email address is confirmed.</p>
		<p class="hint"><a href="/account">Go to your account</a></p>
	{:else if !data.ready || form?.error}
		<p class="notice err" role="alert">{form?.error ?? data.error}</p>
		<p class="hint">Send a new link from your <a href="/account">account page</a>.</p>
	{:else}
		<p class="hint">Confirm <strong>{data.email}</strong> as the email for your account.</p>
		<form method="POST" use:enhance>
			<button type="submit">Confirm</button>
		</form>
	{/if}
</AccountCard>

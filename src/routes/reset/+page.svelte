<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountCard from '$lib/components/AccountCard.svelte';
	let { form } = $props();
</script>

<AccountCard title="Reset your password" sub="Enter the email address on your account. We'll send a link to choose a new password.">
	{#if form?.sent}
		<p class="notice ok" role="status">{form.sent}</p>
		<p class="hint"><a href="/login">Back to sign in</a></p>
	{:else}
		<form method="POST" use:enhance>
			<label>
				<span>Email</span>
				<input type="email" name="email" autocomplete="email" autocapitalize="none" spellcheck="false" required />
			</label>
			<button type="submit">Send reset link</button>
		</form>
		<p class="hint"><a href="/login">Back to sign in</a></p>
	{/if}
</AccountCard>

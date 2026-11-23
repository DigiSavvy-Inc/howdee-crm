<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountCard from '$lib/components/AccountCard.svelte';
	let { data, form } = $props();
	const dead = $derived(!data.ready || !!form?.dead);
</script>

<AccountCard title="Choose a new password" sub={dead ? '' : 'Saving it signs you out on every other device.'}>
	{#if dead}
		<p class="notice err" role="alert">{form?.error ?? data.error}</p>
		<p class="hint"><a href="/reset">Ask for a new link</a> · <a href="/login">Sign in</a></p>
	{:else}
		{#if form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
		<form method="POST" use:enhance>
			<label>
				<span>New password</span>
				<input type="password" name="password" autocomplete="new-password" minlength="12" required />
			</label>
			<label>
				<span>Repeat it</span>
				<input type="password" name="confirm" autocomplete="new-password" minlength="12" required />
			</label>
			<p class="hint">At least 12 characters, not your username, not a common password.</p>
			<button type="submit">Save and sign in</button>
		</form>
	{/if}
</AccountCard>

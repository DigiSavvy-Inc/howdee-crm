<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountCard from '$lib/components/AccountCard.svelte';
	let { data, form } = $props();
	const dead = $derived(!data.ready || (!!form && 'dead' in form && !!form.dead));
	const errs = $derived((form && 'errors' in form ? form.errors : {}) as Partial<Record<string, string>>);
	const values = $derived((form && 'values' in form ? form.values : {}) as { name?: string; github_login?: string });
</script>

<AccountCard
	title={dead ? 'Invitation' : 'Accept your invitation'}
	sub={dead ? '' : `You'll join as ${data.role === 'admin' ? 'an admin' : 'a member'} with ${data.email}.`}
>
	{#if dead}
		<p class="notice err" role="alert">{form?.error ?? data.error}</p>
		<p class="hint">Ask the person who invited you to send it again. · <a href="/login">Sign in</a></p>
	{:else}
		{#if form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
		<form method="POST" use:enhance>
			<label>
				<span>Your name</span>
				<input name="name" autocomplete="name" value={values.name ?? ''} required />
				{#if errs.name}<span class="field-err">{errs.name}</span>{/if}
			</label>
			<label>
				<span>Password</span>
				<input type="password" name="password" autocomplete="new-password" minlength="12" required />
				{#if errs.password}<span class="field-err">{errs.password}</span>{/if}
			</label>
			<label>
				<span>Repeat password</span>
				<input type="password" name="confirm" autocomplete="new-password" minlength="12" required />
				{#if errs.confirm}<span class="field-err">{errs.confirm}</span>{/if}
			</label>
			<label>
				<span>GitHub login (optional — your username, and lets you sign in with GitHub)</span>
				<input name="github_login" autocapitalize="none" spellcheck="false" value={values.github_login ?? ''} />
				{#if errs.githubLogin}<span class="field-err">{errs.githubLogin}</span>{/if}
			</label>
			<p class="hint">Without a GitHub login, your username is your email address.</p>
			<button type="submit">Create account</button>
		</form>
	{/if}
</AccountCard>

<script lang="ts">
	import PasswordForm from '$lib/components/PasswordForm.svelte';

	let { data, form } = $props();
</script>

<svelte:head><title>Choose a password</title></svelte:head>

<section class="card">
	<h1>{data.mustChange ? 'Choose a new password' : data.hasPassword ? 'Change password' : 'Set a password'}</h1>
	{#if data.mustChange}
		<p class="muted">
			You signed in with a password an admin generated. Pick your own to continue — the rest of
			the app opens once it's saved.
		</p>
	{/if}
	<PasswordForm
		hasPassword={data.hasPassword}
		mustChange={data.mustChange}
		error={form && 'pwError' in form ? (form.pwError as string) : null}
		ok={form && 'pwOk' in form ? (form.pwOk as string) : null}
	/>
	<form method="POST" action="/logout" class="signout">
		<button type="submit" class="secondary small">Sign out</button>
	</form>
</section>

<style>
	.card { max-width: 480px; margin: var(--space-m) auto; }
	h1 { margin: 0 0 var(--space-xs); font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	p { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.signout { margin: var(--space-m) 0 0; }
</style>

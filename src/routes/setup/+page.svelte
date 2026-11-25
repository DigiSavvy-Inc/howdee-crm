<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { replaceState } from '$app/navigation';
	import { tokenFromHash } from '$lib/setup-link';
	import logomark from '$lib/assets/logomark.svg';
	import { DEFAULT_APP_NAME } from '$lib/branding';
	let { data, form } = $props();
	const logoSrc = $derived(data.branding?.logoUrl ?? logomark);
	const values = $derived((form && 'values' in form ? form.values : null) ?? { name: '', email: '', github_login: '' });
	const errors = $derived((form && 'errors' in form ? form.errors : null) ?? {}) as Record<string, string | undefined>;

	// #731: the deploy's setup link is `/setup#token=…`. The fragment never reaches the server; read
	// it here, fill the field, then take it out of the address bar (and so out of the history).
	let token = $state('');
	let fromLink = $state(false);
	onMount(() => {
		const t = tokenFromHash(location.hash);
		if (location.hash) {
			try {
				replaceState(location.pathname + location.search, {});
			} catch {
				// The router isn't ready yet: drop the fragment directly.
				history.replaceState(history.state, '', location.pathname + location.search);
			}
		}
		if (t) {
			token = t;
			fromLink = true;
		}
	});
</script>

<svelte:head><title>Set up</title></svelte:head>

<div class="wrap">
	<div class="card">
		<img class="logo" src={logoSrc} alt="" width="40" height="40" />
		<h1>Set up {data.branding?.appName ?? DEFAULT_APP_NAME}</h1>

		{#if !data.tokenSet}
			<p class="sub">
				No users exist yet. To create the first admin, set a <code>SETUP_TOKEN</code> secret on this
				Worker, then reload this page.
			</p>
			<pre><code>npx wrangler secret put SETUP_TOKEN</code></pre>
			<p class="muted">
				Use any long random string. For local development, add <code>SETUP_TOKEN=…</code> to
				<code>.dev.vars</code> and restart <code>npm run dev</code>. Once the first admin exists this
				page goes away and the secret can be deleted.
			</p>
		{:else}
			<p class="sub">Create the first admin account. This page goes away once it exists.</p>

			{#if form && 'error' in form && form.error}<p class="err" role="alert">{form.error}</p>{/if}

			<form method="POST" use:enhance class="pwform">
				<label>
					<span>Setup token</span>
					<input type="password" name="token" autocomplete="off" bind:value={token} required />
					{#if fromLink}<span class="hint">Filled in from your setup link.</span>{/if}
				</label>
				<label>
					<span>Name</span>
					<input name="name" autocomplete="name" value={values.name} required />
					{#if errors.name}<span class="err">{errors.name}</span>{/if}
				</label>
				<label>
					<span>Email</span>
					<input type="email" name="email" autocomplete="email" value={values.email} required />
					{#if errors.email}<span class="err">{errors.email}</span>{/if}
				</label>
				<label>
					<span>GitHub login (optional)</span>
					<input
						name="github_login"
						autocomplete="off"
						autocapitalize="none"
						spellcheck="false"
						value={values.github_login}
					/>
					<span class="hint">Your username for signing in. Leave blank to sign in with your email address.</span>
					{#if errors.githubLogin}<span class="err">{errors.githubLogin}</span>{/if}
				</label>
				<label>
					<span>Password</span>
					<input type="password" name="password" autocomplete="new-password" minlength="12" required />
					<span class="hint">At least 12 characters.</span>
					{#if errors.password}<span class="err">{errors.password}</span>{/if}
				</label>
				<label>
					<span>Confirm password</span>
					<input type="password" name="confirm" autocomplete="new-password" required />
					{#if errors.confirm}<span class="err">{errors.confirm}</span>{/if}
				</label>
				<button type="submit">Create admin and sign in</button>
			</form>
		{/if}
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
	.muted,
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	pre {
		margin: 0;
		overflow-x: auto;
	}
	.pwform {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.pwform label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	input {
		padding: var(--space-s) var(--space-s);
		border-radius: var(--radius-s);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		background: var(--bg);
		color: var(--text);
	}
	button {
		margin-top: var(--space-xxs);
	}
	.err {
		margin: 0;
		color: var(--danger);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
</style>

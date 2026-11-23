<script lang="ts">
	import { enhance } from '$app/forms';
	import logomark from '$lib/assets/logomark.svg';
	import { DEFAULT_APP_NAME } from '$lib/branding';
	let { data, form } = $props();
	// #188: Settings → Branding (root layout load); bundled logo when none is uploaded.
	const logoSrc = $derived(data.branding?.logoUrl ?? logomark);
</script>

<svelte:head><title>Sign in</title></svelte:head>

<div class="wrap">
	<div class="card">
		<img class="logo" src={logoSrc} alt="" width="40" height="40" />
		<h1>{data.branding?.appName ?? DEFAULT_APP_NAME}</h1>
		<p class="sub">Sign in to continue.</p>

		{#if data.error || form?.error}<p class="err">{data.error ?? form?.error}</p>{/if}

		{#snippet ghMark()}
			<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
				<path
					fill="currentColor"
					d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
					0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
					-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
					.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
					-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09
					2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82
					2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01
					2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
				/>
			</svg>
		{/snippet}

		<!-- #605: without GitHub sign-in configured, password sign-in is the whole page. -->
		{#if data.github}
			<a class="gh" href="/auth/github">
				{@render ghMark()}
				Sign in with GitHub
			</a>
			<div class="or" aria-hidden="true"><span>or</span></div>
		{/if}

		<!-- #211: per-user password (username = GitHub login). -->
		<form method="POST" action="?/password" use:enhance class="pwform userpw">
			<label>
				<span>Username</span>
				<input
					name="username"
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					value={form && 'username' in form ? String(form.username) : ''}
					required
				/>
			</label>
			<label>
				<span>Password</span>
				<input type="password" name="password" autocomplete="current-password" required />
			</label>
			<button type="submit">Sign in</button>
		</form>
		<!-- #639 -->
		<p class="forgot"><a href="/reset">Forgot password?</a></p>

		{#if data.password}
			<details>
				<summary>Use the server password instead</summary>
				<form method="POST" action="?/server" use:enhance class="pwform">
					<input
						type="password"
						name="password"
						placeholder="Password"
						autocomplete="current-password"
						required
					/>
					<button type="submit">Sign in</button>
				</form>
			</details>
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
		max-width: 320px;
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		padding: var(--space-xl);
		border: 0;
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
	.gh {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		padding: var(--space-s) var(--space-s);
		border-radius: var(--radius-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		background: var(--text);
		color: var(--bg);
		font-weight: var(--weight-ui-heavy);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		text-decoration: none;
	}
	.gh:hover {
		opacity: 0.9;
		text-decoration: none;
	}
	details {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	summary {
		cursor: pointer;
		color: var(--muted);
	}
	.pwform {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		margin-top: var(--space-s);
	}
	.pwform.userpw {
		margin-top: 0;
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
	.or {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.or::before,
	.or::after {
		content: '';
		flex: 1;
		box-shadow: inset 0 var(--border-s) 0 var(--border);
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
	.forgot {
		margin: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.err {
		margin: 0;
		color: var(--danger);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
</style>

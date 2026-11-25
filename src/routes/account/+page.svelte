<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordForm from '$lib/components/PasswordForm.svelte';

	let { data, form } = $props();
	const a = $derived(data.account);

	function fmtDate(s: string | null): string {
		if (!s) return '';
		const d = new Date(s.replace(' ', 'T') + 'Z');
		return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
	}
</script>

<svelte:head><title>Account</title></svelte:head>

<div class="head"><h1>Account</h1></div>

<section class="card profile">
	{#if a.avatar_url}
		<img class="avatar" src={a.avatar_url} alt="" width="56" height="56" />
	{:else}
		<span class="avatar avatar-fallback">{(a.name || a.github_login).charAt(0).toUpperCase()}</span>
	{/if}
	<div>
		<div class="name">{a.name || `@${a.github_login}`}</div>
		<dl>
			<dt>Username</dt>
			<dd>{a.github_login}</dd>
			<dt>Role</dt>
			<dd><span class="badge" class:admin={a.role === 'admin'}>{a.role}</span></dd>
			<dt>Sign in with</dt>
			<dd>
				GitHub{#if a.github_id}&nbsp;<span class="muted">(connected, id {a.github_id})</span>{:else}&nbsp;<span
						class="muted">(connects on your first GitHub sign-in)</span
					>{/if}{#if a.hasPassword}&nbsp;· password{/if}
			</dd>
		</dl>
	</div>
</section>

<!-- #639: your email — where invites, password resets and confirmations go. -->
<section class="card" id="email">
	<h2>Email</h2>
	{#if a.email}
		<p class="muted">
			{a.email}
			{#if a.emailVerified}
				<span class="badge sent">verified</span> Password reset links go here.
			{:else}
				<span class="badge sending">unverified</span> Password reset links aren't sent here until you confirm it.
			{/if}
		</p>
	{:else}
		<p class="muted">No email yet. Add one so you can reset your password if you forget it.</p>
	{/if}
	{#if form && 'emailError' in form && form.emailError}<p class="notice err" role="alert">{form.emailError}</p>{/if}
	{#if form && 'emailOk' in form && form.emailOk}<p class="notice ok" role="status">{form.emailOk}</p>{/if}
	{#if a.email && !a.emailVerified}
		<form method="POST" action="?/resendVerify" use:enhance class="inline">
			<button type="submit" class="small">Send a new confirmation link</button>
		</form>
	{/if}
	<form method="POST" action="?/email" use:enhance class="email-form">
		<label>
			<span>{a.email ? 'New email' : 'Email'}</span>
			<input name="email" type="email" autocomplete="email" value={a.email ?? ''} />
		</label>
		{#if a.hasPassword}
			<label>
				<span>Current password</span>
				<input name="current_password" type="password" autocomplete="current-password" required />
			</label>
		{/if}
		<button type="submit">Save email</button>
	</form>
</section>

<!-- #715: hide the suggestions panel for yourself only. -->
<section class="card" id="suggestions">
	<h2>Suggestions panel</h2>
	<p class="muted">
		The panel at the bottom right suggests who to contact and what to send next, when an admin has turned Suggestions
		on. Turning it off hides the panel and its count for you only; the suggestions still exist for the rest of the team.
	</p>
	{#if form && 'panelError' in form && form.panelError}<p class="notice err" role="alert">{form.panelError}</p>{/if}
	{#if form && 'panelOk' in form && form.panelOk}<p class="notice ok" role="status">{form.panelOk}</p>{/if}
	<form method="POST" action="?/suggestionsPanel" use:enhance class="panel-form">
		<label class="check">
			<input type="checkbox" name="show" value="1" checked={data.suggestionsPanel} />
			Show the suggestions panel
		</label>
		<button type="submit" class="small">Save</button>
	</form>
</section>

<section class="card">
	<h2>Password</h2>
	{#if a.mustChange}
		<p class="muted">An admin generated a password for you. Choose your own to replace it.</p>
	{:else if a.hasPassword}
		<p class="muted">
			Set {fmtDate(a.passwordSetAt)}. Sign in with your username and this password, or with GitHub.
			Changing it signs out your other sessions.
		</p>
	{:else}
		<p class="muted">
			You sign in with GitHub. Set a password to also sign in with your username
			(<strong>{a.github_login}</strong>) and password.
		</p>
	{/if}
	<PasswordForm
		hasPassword={a.hasPassword}
		mustChange={a.mustChange}
		error={form && 'pwError' in form ? (form.pwError as string) : null}
		ok={form && 'pwOk' in form ? (form.pwOk as string) : null}
	/>
</section>

<style>
	.head { display: flex; align-items: center; gap: var(--space-s); margin-bottom: var(--space-s); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.card { margin-bottom: var(--space-m); max-width: 640px; }
	.card h2 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.card p { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.profile { display: flex; gap: var(--space-m); align-items: flex-start; }
	.avatar {
		display: inline-flex;
		flex: none;
		width: 56px;
		height: 56px;
		border-radius: 50%;
		object-fit: cover;
	}
	.avatar-fallback {
		align-items: center;
		justify-content: center;
		background: var(--surface-subtle);
		color: var(--muted);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		font-weight: var(--weight-ui-heavy);
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
	}
	.name { font-weight: var(--weight-ui-heavy); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); margin-bottom: var(--space-xs); }
	dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-xxs) var(--space-m); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	dt { color: var(--muted); }
	.email-form { display: flex; flex-direction: column; gap: var(--space-s); max-width: 360px; }
	.email-form label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.inline { margin: 0 0 var(--space-s); }
	.panel-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); }
	.check { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.small { padding: var(--space-xxs) var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	dd { margin: 0; }
	.badge.admin {
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 35%, var(--border));
	}
</style>

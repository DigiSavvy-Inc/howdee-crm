<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { UserRow } from '$lib/server/users';
	import Modal from '$lib/components/Modal.svelte';

	let { data, form } = $props();

	// #211: a generated password is shown once, here, then dropped when the modal closes.
	let generated = $state<{ login: string; password: string } | null>(null);
	let genOpen = $state(false);
	let copied = $state(false);
	$effect(() => {
		const g = form && 'generated' in form ? (form.generated as { login: string; password: string }) : null;
		if (g) {
			generated = g;
			copied = false;
			genOpen = true;
		}
	});
	$effect(() => {
		if (!genOpen) generated = null;
	});

	async function copyPassword() {
		if (!generated) return;
		await navigator.clipboard.writeText(generated.password);
		copied = true;
	}

	function passwordStatus(u: UserRow): string {
		if (!u.has_password) return 'none';
		if (u.must_change_password) return 'must change';
		const d = u.password_set_at ? new Date(u.password_set_at.replace(' ', 'T') + 'Z') : null;
		return d && !isNaN(d.getTime()) ? `set ${d.toLocaleDateString(undefined, { dateStyle: 'medium' })}` : 'set';
	}

	function confirmGenerate(u: UserRow) {
		return (e: { cancel: () => void }) => {
			if (u.has_password && !confirm(`Replace @${u.github_login}'s password? The old one stops working and they're signed out.`)) e.cancel();
		};
	}

	function confirmClear(login: string) {
		return (e: { cancel: () => void }) => {
			if (!confirm(`Clear @${login}'s password? They'll sign in with GitHub only, and are signed out now.`)) e.cancel();
		};
	}

	function initial(u: UserRow): string {
		return (u.name || u.github_login || '?').trim().charAt(0).toUpperCase();
	}

	function relativeTime(s: string | null): string {
		if (!s) return 'never';
		const then = new Date(s.replace(' ', 'T') + 'Z').getTime();
		if (isNaN(then)) return 'never';
		const seconds = Math.round((Date.now() - then) / 1000);
		if (seconds < 60) return 'just now';
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.round(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.round(days / 30);
		if (months < 12) return `${months}mo ago`;
		return `${Math.round(months / 12)}y ago`;
	}

	// #533: break-glass audit rows.
	const BREAK_GLASS_OUTCOMES: Record<string, { label: string; cls: string }> = {
		ok: { label: 'Signed in', cls: 'sent' },
		failed: { label: 'Wrong password', cls: 'failed' },
		locked: { label: 'Locked out', cls: 'failed' },
		no_admin: { label: 'No active admin', cls: 'sending' }
	};

	// #639: change someone's email — a modal with one field; the new address must be confirmed.
	let emailFor = $state<UserRow | null>(null);
	let emailOpen = $state(false);
	function openEmail(u: UserRow) {
		emailFor = u;
		emailOpen = true;
	}
	function closeEmailOnDone(): SubmitFunction {
		return () =>
			async ({ result, update }) => {
				if (result.type === 'success') emailOpen = false;
				await update();
			};
	}

	function confirmRevoke(email: string) {
		return (e: { cancel: () => void }) => {
			if (!confirm(`Revoke the invite for ${email}? Its link stops working.`)) e.cancel();
		};
	}

	function shortDate(s: string): string {
		const d = new Date(s.replace(' ', 'T') + 'Z');
		return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	function confirmRemove(login: string) {
		return (e: { cancel: () => void }) => {
			if (!confirm(`Remove @${login}? They'll no longer be able to sign in.`)) e.cancel();
		};
	}
</script>

<svelte:head><title>Users</title></svelte:head>

<div class="head">
	<h1>Users</h1>
</div>

{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.ok}<p class="ok">{form.ok}</p>{/if}

<section class="card" id="invite">
	<h2>Invite by email</h2>
	<p class="muted">
		They get a link to choose their name and password (valid 7 days, works once). Their address is
		verified when they accept.
	</p>
	<form method="POST" action="?/invite" use:enhance class="add-form">
		<input
			name="email"
			type="email"
			placeholder="name@example.com"
			autocomplete="off"
			value={form && 'inviteEmail' in form ? String(form.inviteEmail ?? '') : ''}
			required
		/>
		<select name="role">
			<option value="member" selected>Member</option>
			<option value="admin">Admin</option>
		</select>
		<button type="submit">Send invite</button>
	</form>
	{#if data.invites.length}
		<h3>Pending invites</h3>
		<ul class="invites">
			{#each data.invites as inv (inv.id)}
				<li>
					<span class="login">{inv.email}</span>
					<span class="badge" class:admin={inv.role === 'admin'}>{inv.role}</span>
					{#if inv.expired}
						<span class="badge failed">expired</span>
					{:else}
						<span class="muted">expires {shortDate(inv.expires_at)}</span>
					{/if}
					{#if inv.invited_by}<span class="muted">· by @{inv.invited_by}</span>{/if}
					<span class="row-actions">
						<form method="POST" action="?/resendInvite" use:enhance class="row-form">
							<input type="hidden" name="invite_id" value={inv.id} />
							<button type="submit" class="small">Resend</button>
						</form>
						<form method="POST" action="?/revokeInvite" use:enhance={confirmRevoke(inv.email)} class="row-form">
							<input type="hidden" name="invite_id" value={inv.id} />
							<button type="submit" class="small danger">Revoke</button>
						</form>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="card">
	<h2>Add a user</h2>
	<p class="muted">
		They sign in with GitHub; only logins on this list can get in. Their profile fills in on
		first sign-in.
	</p>
	<form method="POST" action="?/add" use:enhance class="add-form">
		<input name="github_login" placeholder="octocat" autocomplete="off" required />
		<select name="role">
			<option value="member" selected>Member</option>
			<option value="admin">Admin</option>
		</select>
		<button type="submit">Add</button>
		<label class="gen-check">
			<input type="checkbox" name="generate_password" value="1" />
			Generate a password now
		</label>
	</form>
</section>

<section class="card">
	<div class="tablewrap">
		<table>
			<thead>
				<tr>
					<th class="av-col"></th>
					<th>Login</th>
					<th>Role</th>
					<th>Last sign-in</th>
					<th>Password</th>
					<th>Status</th>
					<th class="act-col"></th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as u (u.id)}
					{@const isMe = u.id === data.me?.id}
					{@const active = !u.disabled_at}
					<tr>
						<td class="av-col">
							{#if u.avatar_url}
								<img class="avatar" src={u.avatar_url} alt="" width="32" height="32" />
							{:else}
								<span class="avatar avatar-fallback">{initial(u)}</span>
							{/if}
						</td>
						<td>
							<div class="login">@{u.github_login}</div>
							{#if u.name}<div class="muted name">{u.name}</div>{/if}
							{#if u.email}
								<div class="muted name">
									{u.email}
									{#if !u.email_verified_at}<span class="badge sending">unverified</span>{/if}
								</div>
							{/if}
						</td>
						<td><span class="badge" class:admin={u.role === 'admin'}>{u.role}</span></td>
						<td class="muted nowrap">{relativeTime(u.last_login_at)}</td>
						<td class="nowrap">
							{#if u.must_change_password && u.has_password}
								<span class="badge sending">must change</span>
							{:else}
								<span class:muted={!u.has_password}>{passwordStatus(u)}</span>
							{/if}
						</td>
						<td><span class="badge" class:sent={active} class:failed={!active}>{active ? 'Active' : 'Disabled'}</span></td>
						<td class="act-col">
							{#if isMe}
								<span class="badge you">you</span>
							{:else}
								<div class="row-actions">
									<form method="POST" action="?/setRole" use:enhance class="row-form">
										<input type="hidden" name="id" value={u.id} />
										<input type="hidden" name="role" value={u.role === 'admin' ? 'member' : 'admin'} />
										<button type="submit" class="small">
											{u.role === 'admin' ? 'Make member' : 'Make admin'}
										</button>
									</form>
									<form
										method="POST"
										action={active ? '?/disable' : '?/enable'}
										use:enhance
										class="row-form"
									>
										<input type="hidden" name="id" value={u.id} />
										<button type="submit" class="small">{active ? 'Disable' : 'Enable'}</button>
									</form>
									<button type="button" class="small" onclick={() => openEmail(u)}>
										{u.email ? 'Change email' : 'Add email'}
									</button>
									<form method="POST" action="?/generatePassword" use:enhance={confirmGenerate(u)} class="row-form">
										<input type="hidden" name="id" value={u.id} />
										<button type="submit" class="small">Generate password</button>
									</form>
									{#if u.has_password}
										<form
											method="POST"
											action="?/clearPassword"
											use:enhance={confirmClear(u.github_login)}
											class="row-form"
										>
											<input type="hidden" name="id" value={u.id} />
											<button type="submit" class="small">Clear password</button>
										</form>
									{/if}
									<form
										method="POST"
										action="?/remove"
										use:enhance={confirmRemove(u.github_login)}
										class="row-form"
									>
										<input type="hidden" name="id" value={u.id} />
										<button type="submit" class="small danger">Remove</button>
									</form>
								</div>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="7" class="muted empty">No users yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="card" id="break-glass">
	<h2>Break-glass sign-ins</h2>
	<p class="muted">
		The server password on the sign-in page signs in as the first active admin.
		{data.breakGlass.enabled
			? 'It is turned on (APP_PASSWORD is set). Every attempt is listed here.'
			: 'It is turned off (APP_PASSWORD is not set).'}
		After 5 wrong tries in 15 minutes it locks for everyone, and after 20 from one network.
	</p>
	{#if data.breakGlass.events.length}
		<div class="tablewrap">
			<table>
				<thead>
					<tr>
						<th>When</th>
						<th>Result</th>
						<th>Signed in as</th>
						<th>Network</th>
					</tr>
				</thead>
				<tbody>
					{#each data.breakGlass.events as ev (ev.id)}
						{@const o = BREAK_GLASS_OUTCOMES[ev.outcome] ?? { label: ev.outcome, cls: '' }}
						<tr>
							<td class="nowrap" title="{ev.at} UTC">{relativeTime(ev.at)}</td>
							<td><span class="badge {o.cls}">{o.label}</span></td>
							<td>{ev.outcome === 'ok' ? (ev.login ? `@${ev.login}` : '(removed user)') : '—'}</td>
							<td class="muted"><code title="Hash of the IP address; the address itself isn't kept">{ev.ip_hash ?? '—'}</code></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="muted">No break-glass attempts.</p>
	{/if}
</section>

<Modal title="Email address" bind:open={emailOpen}>
	{#if emailFor}
		<form method="POST" action="?/setEmail" use:enhance={closeEmailOnDone()} class="email-form">
			<input type="hidden" name="id" value={emailFor.id} />
			<label>
				<span>Email for @{emailFor.github_login}</span>
				<input name="email" type="email" value={emailFor.email ?? ''} autocomplete="off" />
			</label>
			<p class="muted">
				A new address stays unverified — no password reset goes to it — until they open the
				confirmation link we send there. Leave it blank to remove it.
			</p>
			<button type="submit">Save</button>
		</form>
	{/if}
</Modal>

<Modal title="Generated password" bind:open={genOpen}>
	{#if generated}
		<p>Password for <strong>@{generated.login}</strong> (username <code>{generated.login}</code>):</p>
		<div class="gen-row">
			<code class="gen-pw">{generated.password}</code>
			<button type="button" class="small" onclick={copyPassword}>{copied ? 'Copied!' : 'Copy'}</button>
		</div>
		<p class="muted">
			Share it over a secure channel; they'll be asked to change it on first sign-in. It won't be
			shown again.
		</p>
	{/if}
</Modal>

<style>
	.head { display: flex; align-items: center; gap: var(--space-s); margin-bottom: var(--space-s); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.card { margin-bottom: var(--space-m); max-width: 900px; }
	.card h2 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.card p { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.err { color: var(--danger); margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0 0 var(--space-s); }
	.add-form { display: flex; gap: var(--space-xs); align-items: center; margin: 0; flex-wrap: wrap; }
	.add-form input[name='github_login'] { flex: 1 1 14rem; }
	.tablewrap { overflow-x: auto; margin: calc(-1 * var(--space-m)) calc(-1 * var(--space-l)); }
	.tablewrap table { margin: 0; }
	.tablewrap th:first-child,
	.tablewrap td:first-child { padding-left: var(--space-l); }
	.tablewrap th:last-child,
	.tablewrap td:last-child { padding-right: var(--space-l); }
	.av-col { width: 1%; white-space: nowrap; }
	.act-col { width: 1%; white-space: nowrap; }
	.avatar {
		display: block;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
	}
	.avatar-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-subtle);
		color: var(--muted);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-heavy);
	}
	.login { font-weight: var(--weight-ui-medium); }
	.name { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.nowrap { white-space: nowrap; }
	.badge.admin {
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 35%, var(--border));
	}
	.badge.you {
		text-transform: uppercase;
		letter-spacing: var(--tracking-xl);
	}
	.row-actions { display: inline-flex; gap: var(--space-xs); flex-wrap: nowrap; }
	.row-form { margin: 0; display: inline-flex; }
	.small { padding: var(--space-xxs) var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.empty { text-align: center; padding: var(--space-l) 0; }
	.card h3 { margin: var(--space-m) 0 var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.invites { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	.invites li { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.invites .row-actions { margin-left: auto; }
	.add-form input[name='email'] { flex: 1 1 14rem; }
	.email-form { display: flex; flex-direction: column; gap: var(--space-s); }
	.email-form label { display: flex; flex-direction: column; gap: var(--space-xxs); }
	.gen-check { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.gen-row { display: flex; align-items: center; gap: var(--space-s); margin: var(--space-xxs) 0 var(--space-s); flex-wrap: wrap; }
	.gen-pw {
		font-size: var(--size-m);
		line-height: var(--line-m);
		padding: var(--space-xs) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-xs);
		user-select: all;
		letter-spacing: var(--tracking-xl);
	}
</style>

<script lang="ts">
	import { enhance } from '$app/forms';

	// #211: set / change your own password. Posts `?/password` on the page it's rendered on
	// (/account and /account/password both run `changeOwnPassword`).
	let {
		hasPassword,
		mustChange,
		error = null,
		ok = null
	}: { hasPassword: boolean; mustChange: boolean; error?: string | null; ok?: string | null } = $props();

	const MIN = 12;
	let next = $state('');
	let confirmPw = $state('');
	let busy = $state(false);

	// A hint only — the server's policy (length, not your username, not a common password) decides.
	const hint = $derived.by(() => {
		if (!next) return '';
		if (next.length < MIN) return `${next.length}/${MIN} characters`;
		const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(next)).length;
		if (next.length >= 20 || (next.length >= 16 && classes >= 3)) return 'Strong';
		if (next.length >= 14 || classes >= 3) return 'Good';
		return 'OK — longer is stronger';
	});
	const mismatch = $derived(!!confirmPw && confirmPw !== next);
</script>

<form
	method="POST"
	action="?/password"
	class="pwform"
	use:enhance={() => {
		busy = true;
		return async ({ update, result }) => {
			busy = false;
			if (result.type === 'success') {
				next = '';
				confirmPw = '';
			}
			await update();
		};
	}}
>
	{#if hasPassword && !mustChange}
		<label>
			<span>Current password</span>
			<input type="password" name="current_password" autocomplete="current-password" required />
		</label>
	{/if}
	<label>
		<span>New password</span>
		<input
			type="password"
			name="new_password"
			autocomplete="new-password"
			minlength={MIN}
			maxlength="128"
			bind:value={next}
			aria-describedby="pw-rule"
			required
		/>
	</label>
	<p class="rule muted" id="pw-rule">
		At least {MIN} characters, not your username, not a common password.
		{#if hint}<span class="hint">· {hint}</span>{/if}
	</p>
	<label>
		<span>Confirm new password</span>
		<input
			type="password"
			name="confirm_password"
			autocomplete="new-password"
			bind:value={confirmPw}
			aria-invalid={mismatch}
			required
		/>
	</label>
	{#if mismatch}<p class="err">The two passwords don't match yet.</p>{/if}
	{#if error}<p class="err" role="alert">{error}</p>{/if}
	{#if ok}<p class="ok" role="status">{ok}</p>{/if}
	<div>
		<button type="submit" disabled={busy}>
			{hasPassword && !mustChange ? 'Change password' : 'Set password'}
		</button>
	</div>
</form>

<style>
	.pwform {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		max-width: 22rem;
		margin: 0;
	}
	/* Field: label s/medium, gap xs; description neutral-7; error xs in the error colour. */
	label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-medium);
	}
	.rule {
		margin: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.hint {
		color: var(--text);
	}
	.err {
		margin: 0;
		color: var(--error);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	.ok {
		margin: 0;
	}
</style>

<script lang="ts">
	// #507: the contact header's Subscribed / Unsubscribed badge as a control. Clicking opens a
	// two-item menu; Unsubscribed asks for a reason, an optional note and "Also suppress in
	// Postmark" (default on, like the bulk bar), Subscribed confirms in one step. Both post
	// `?/setSubscribed`.
	// #510: a third state, Pending confirmation (double opt-in; the contact is `subscribed = 0`).
	// Its menu offers Resend confirmation (`?/resendConfirmation`, rate-limited) and Cancel
	// confirmation (`?/cancelConfirmation`, one-step confirm); Subscribed / Unsubscribed are
	// hidden — to subscribe without confirmation, cancel first, then pick Subscribed.
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { OPERATOR_UNSUB_REASON, UNSUBSCRIBE_REASONS } from '$lib/unsubscribe-page';

	let {
		subscribed,
		email,
		title = undefined,
		error = null,
		note = null,
		pending = false,
		confirmation = null,
		confirmError = null,
		confirmOk = null,
		variant = 'badge'
	}: {
		subscribed: boolean;
		email: string;
		title?: string;
		/** `?/setSubscribed` results (#507). */
		error?: string | null;
		note?: string | null;
		/** #510: double opt-in pending (only meaningful while unsubscribed). */
		pending?: boolean;
		confirmation?: {
			sentAt: string;
			lastSentAt: string | null;
			resendCount: number;
			expiresAt: string;
			expired: boolean;
			canResend: boolean;
		} | null;
		/** `?/resendConfirmation` / `?/cancelConfirmation` results (#510). */
		confirmError?: string | null;
		confirmOk?: string | null;
		/** #571: `button` = a plain Unsubscribe / Resubscribe button beside Edit / Archive that opens
		 * the same step in a dialog. Hidden while pending; results show under the badge instance. */
		variant?: 'badge' | 'button';
	} = $props();

	const isPending = $derived(pending && !subscribed);
	const mode = $derived<'sub' | 'unsub' | 'pending'>(isPending ? 'pending' : subscribed ? 'sub' : 'unsub');
	const badgeClass = $derived(mode === 'pending' ? 'sending' : mode === 'sub' ? 'sent' : 'failed');
	const label = $derived(mode === 'pending' ? 'Pending confirmation' : mode === 'sub' ? 'Subscribed' : 'Unsubscribed');
	const pendingTitle = $derived(
		confirmation
			? `Confirmation sent ${confirmation.sentAt} UTC${confirmation.resendCount ? ` · re-sent ${confirmation.resendCount}×, last ${confirmation.lastSentAt} UTC` : ''}${confirmation.expired ? ' · link expired' : ''}`
			: 'Waiting for them to confirm'
	);
	const resendBlocked = $derived(!!confirmation && !confirmation.canResend);
	const errorText = $derived(error ?? confirmError);
	const noteText = $derived(note ?? confirmOk);

	let open = $state(false);
	let confirming = $state<'unsub' | 'resub' | 'cancel' | null>(null);
	let reason = $state(OPERATOR_UNSUB_REASON);
	let unsubNote = $state('');
	let suppress = $state(true);
	let busy = $state(false);
	let root = $state<HTMLElement>();
	let dialogOpen = $state(false);
	// The dialog closed itself (Close, Esc, backdrop): drop the pending step with it.
	$effect(() => {
		if (variant === 'button' && !dialogOpen) confirming = null;
	});

	function close() {
		open = false;
		confirming = null;
		dialogOpen = false;
	}

	function pick(want: 'unsub' | 'resub' | 'cancel') {
		open = false;
		reason = OPERATOR_UNSUB_REASON;
		unsubNote = '';
		suppress = true;
		confirming = want;
		if (variant === 'button') dialogOpen = true;
	}

	// Outside dismiss runs on pointerdown, before any click handler changes the DOM: on click,
	// pick() has already removed the menu item, so it would look "outside" and close the confirm.
	function onWindowPointerDown(e: PointerEvent) {
		const target = e.target as Node | null;
		if (variant === 'button' || !(open || confirming) || !root || !target || !target.isConnected) return;
		if (!root.contains(target)) close();
	}

	function onKey(e: KeyboardEvent) {
		if (variant === 'badge' && e.key === 'Escape' && (open || confirming)) close();
	}

	const submit = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			busy = false;
			open = false;
			confirming = null;
			dialogOpen = false;
			await update({ reset: false });
		};
	};
</script>

{#snippet unsubFields()}
	<input type="hidden" name="subscribed" value="0" />
	<label>
		Reason
		<select name="reason" bind:value={reason}>
			<option value={OPERATOR_UNSUB_REASON}>{OPERATOR_UNSUB_REASON}</option>
			{#each UNSUBSCRIBE_REASONS as r (r)}<option value={r}>{r}</option>{/each}
		</select>
	</label>
	<label>
		Note <span class="muted">(optional)</span>
		<input type="text" name="note" maxlength="200" bind:value={unsubNote} />
	</label>
	<label class="check"><input type="checkbox" name="suppress" value="1" bind:checked={suppress} /> Also suppress in Postmark</label>
	<div class="sub-actions">
		<button type="submit" disabled={busy}>Unsubscribe</button>
		<button type="button" class="secondary" onclick={close}>Cancel</button>
	</div>
{/snippet}

{#snippet resubFields()}
	<input type="hidden" name="subscribed" value="1" />
	<p class="muted small">Only resubscribe people who have agreed to get your email.</p>
	<div class="sub-actions">
		<button type="submit" disabled={busy}>Resubscribe</button>
		<button type="button" class="secondary" onclick={close}>Cancel</button>
	</div>
{/snippet}

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onKey} />

{#if variant === 'button'}
	<!-- #571: the same step as the badge, from a plain button; hidden while double opt-in is pending. -->
	{#if mode !== 'pending'}
		<button type="button" class="secondary sub-btn" onclick={() => pick(subscribed ? 'unsub' : 'resub')}>
			{subscribed ? 'Unsubscribe' : 'Resubscribe'}
		</button>
		<Modal title={confirming === 'resub' ? `Resubscribe ${email}?` : `Unsubscribe ${email}?`} bind:open={dialogOpen}>
			{#if confirming === 'unsub'}
				<form class="sub-confirm sub-dialog" method="POST" action="?/setSubscribed" use:enhance={submit}>
					{@render unsubFields()}
				</form>
			{:else if confirming === 'resub'}
				<form class="sub-confirm sub-dialog" method="POST" action="?/setSubscribed" use:enhance={submit}>
					{@render resubFields()}
				</form>
			{/if}
		</Modal>
	{/if}
{:else}
<span class="sub-control" bind:this={root}>
	<button
		type="button"
		class="badge sub-badge {badgeClass}"
		aria-haspopup="menu"
		aria-expanded={open}
		title={mode === 'pending' ? pendingTitle : title}
		onclick={() => {
			confirming = null;
			open = !open;
		}}
	>
		{label}
		<Icon name="chevron-down" size={16} />
	</button>

	{#if open && mode === 'pending'}
		<div class="sub-pop sub-menu" role="menu">
			<form method="POST" action="?/resendConfirmation" use:enhance={submit}>
				<button
					type="submit"
					role="menuitem"
					disabled={busy || resendBlocked}
					title={resendBlocked ? 'Already re-sent 3 times, or sent less than 10 minutes ago.' : undefined}
				>
					Resend confirmation
				</button>
			</form>
			<button type="button" role="menuitem" onclick={() => pick('cancel')}>Cancel confirmation</button>
		</div>
	{:else if open}
		<div class="sub-pop sub-menu" role="menu">
			<button type="button" role="menuitemradio" aria-checked={subscribed} disabled={subscribed} onclick={() => pick('resub')}>
				Subscribed
			</button>
			<button type="button" role="menuitemradio" aria-checked={!subscribed} disabled={!subscribed} onclick={() => pick('unsub')}>
				Unsubscribed
			</button>
		</div>
	{/if}

	{#if confirming === 'unsub'}
		<form class="sub-pop sub-confirm" method="POST" action="?/setSubscribed" use:enhance={submit}>
			<p class="sub-title">Unsubscribe {email}?</p>
			{@render unsubFields()}
		</form>
	{:else if confirming === 'cancel'}
		<form class="sub-pop sub-confirm" method="POST" action="?/cancelConfirmation" use:enhance={submit}>
			<p class="sub-title">Cancel the pending confirmation? Their link stops working and they stay unsubscribed.</p>
			<div class="sub-actions">
				<button type="submit" disabled={busy}>Cancel confirmation</button>
				<button type="button" class="secondary" onclick={close}>Keep it</button>
			</div>
		</form>
	{:else if confirming === 'resub'}
		<form class="sub-pop sub-confirm" method="POST" action="?/setSubscribed" use:enhance={submit}>
			<p class="sub-title">Resubscribe {email}?</p>
			{@render resubFields()}
		</form>
	{/if}
</span>
{#if errorText}<span class="sub-error sub-result" role="alert">{errorText}</span>{/if}
{#if noteText && !errorText}<span class="muted small sub-result" role="status">{noteText}</span>{/if}
{/if}

<style>
	.sub-control {
		position: relative;
		display: inline-block;
	}
	.sub-badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		min-height: 0;
		cursor: pointer;
	}
	.sub-pop {
		position: absolute;
		top: calc(100% + var(--space-xxs));
		left: 0;
		z-index: 20;
		background: var(--surface);
		border: var(--border-s) solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-s);
	}
	.sub-menu {
		display: flex;
		flex-direction: column;
		padding: var(--space-xxs);
		min-width: 10rem;
	}
	.sub-menu form {
		display: contents;
	}
	.sub-menu button {
		background: none;
		color: var(--text);
		border: 0;
		text-align: left;
		padding: var(--space-xs) var(--space-s);
		font-weight: normal;
	}
	.sub-menu button:hover:not(:disabled) {
		background: var(--neutral-3);
	}
	.sub-menu button:disabled {
		color: var(--muted);
		font-weight: var(--weight-ui-medium);
	}
	.sub-confirm {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		padding: var(--space-m);
		width: min(22rem, 90vw);
	}
	.sub-dialog {
		padding: 0;
		width: auto;
	}
	.sub-btn {
		padding: var(--space-xs) var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		white-space: nowrap;
	}
	@media (max-width: 640px) {
		.sub-btn {
			padding: var(--space-xxs) var(--space-s);
		}
	}
	.sub-confirm label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
	}
	.sub-confirm label.check {
		flex-direction: row;
		align-items: center;
	}
	.sub-title {
		margin: 0;
		font-weight: var(--weight-ui-medium);
		overflow-wrap: anywhere;
	}
	.sub-actions {
		display: flex;
		gap: var(--space-s);
	}
	.small {
		font-size: var(--size-xs);
		margin: 0;
	}
	.sub-error {
		color: var(--danger);
		font-size: var(--size-xs);
	}
	/* #571: in the header's wrapping flex row, the result takes its own line after the buttons
	 * instead of squeezing the name. */
	.sub-result {
		flex-basis: 100%;
		order: 1;
	}
</style>

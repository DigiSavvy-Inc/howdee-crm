<script lang="ts">
	import type { Snippet } from 'svelte';

	// Native <dialog> wrapper (#51) — backdrop click + ESC close, title bar, scrollable body.
	// Control with `bind:open`. Forms inside keep use:enhance; close on success by setting
	// open = false in the enhance callback.
	let {
		title,
		open = $bindable(false),
		children
	}: { title: string; open?: boolean; children: Snippet } = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	class="modal"
	onclose={() => (open = false)}
	onclick={(e) => {
		if (e.target === dialog) open = false; // backdrop click
	}}
>
	<div class="modal-head">
		<strong>{title}</strong>
		<button type="button" class="secondary small" onclick={() => (open = false)}>Close</button>
	</div>
	<div class="modal-body">
		{@render children()}
	</div>
</dialog>

<style>
	.modal {
		width: min(640px, calc(100vw - 2rem));
		max-width: calc(100vw - 2rem);
		max-height: 90vh;
		padding: 0;
		border: 0;
		border-radius: var(--radius-m);
		background: var(--surface);
		color: var(--neutral-10);
		font-family: var(--font-ui);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		box-shadow: var(--border-shadow-s), var(--shadow-l);
	}
	.modal[open] {
		animation: modal-in var(--motion-large-duration) var(--motion-large-easing);
	}
	@keyframes modal-in {
		from {
			opacity: 0;
			transform: scale(var(--motion-popup-scale));
		}
	}
	.modal::backdrop {
		background: var(--backdrop);
	}
	.modal-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-m) var(--space-l);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
	}
	.modal-head strong {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--tracking-m);
		font-weight: var(--weight-ui-medium);
	}
	.modal-body {
		padding: var(--space-l);
		overflow-y: auto;
	}
	/* Dialog close = the theme's ghost close control. */
	button.small {
		background: var(--color-none);
		color: var(--neutral-10);
		box-shadow: none;
	}
	button.small:hover {
		background: var(--neutral-3-transparent);
	}
	button.small:focus-visible {
		box-shadow: var(--focus-halo);
	}
</style>

<script lang="ts">
	// #520: a long editor form's primary actions (Save, Preview, …), kept in view while the
	// form scrolls. Only the positioning changes: the buttons stay where the page puts them in
	// the DOM, so tab order, submit semantics and `form=` attributes work as before.
	//
	// - Desktop (> 768px): a thin full-width bar, sticky under the app header. A top-right chip
	//   would cover the block editor's own sticky toolbar / Design panel, so it is a bar and
	//   the editor's sticky offset grows by its height (--sticky-actions-top). It stacks above
	//   the Design panel (z-index 6 vs 5) for when the panel scrolls up past that offset.
	// - Phones (≤ 768px, the editor's Design-sheet breakpoint): fixed to the bottom of the
	//   viewport with safe-area padding. Its height (--sticky-actions-bottom) pads the page and
	//   lifts the Design sheet and the assistant bubble above it.
	//
	// Must be a direct child of the form (or another element spanning the form) for the
	// sticky bar to follow the whole form. A form that puts it last in the DOM gives it
	// `order: -1` so it still sits at the top on desktop.
	import type { Snippet } from 'svelte';

	let {
		children,
		dirty = false,
		dirtyText = 'Unsaved changes',
		status = ''
	}: {
		children: Snippet;
		/** Show the unsaved-changes note. */
		dirty?: boolean;
		dirtyText?: string;
		/** Shown when not dirty, e.g. "Saved." after a save. */
		status?: string;
	} = $props();

	let el: HTMLDivElement | undefined = $state();

	$effect(() => {
		const bar = el;
		if (!bar || typeof window === 'undefined') return;
		const root = document.documentElement;
		const mq = window.matchMedia('(max-width: 768px)');
		const apply = () => {
			const h = `${bar.offsetHeight}px`;
			root.style.setProperty(mq.matches ? '--sticky-actions-bottom' : '--sticky-actions-top', h);
			root.style.removeProperty(mq.matches ? '--sticky-actions-top' : '--sticky-actions-bottom');
		};
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
		ro?.observe(bar);
		mq.addEventListener('change', apply);
		apply();
		return () => {
			ro?.disconnect();
			mq.removeEventListener('change', apply);
			root.style.removeProperty('--sticky-actions-top');
			root.style.removeProperty('--sticky-actions-bottom');
		};
	});
</script>

<div class="sticky-actions" class:is-dirty={dirty} bind:this={el}>
	<span class="sa-status" role="status">
		{#if dirty}
			<span class="sa-dirty"><span class="sa-dot" aria-hidden="true"></span>{dirtyText}</span>
		{:else if status}
			<span class="sa-saved">{status}</span>
		{/if}
	</span>
	<div class="sa-buttons">
		{@render children()}
	</div>
</div>

<style>
	/* Desktop: thin sticky bar under the app header (--header-h is 0 in the sidebar layout).
	   z-index 6: below the header (10), menus/popovers, dialogs and the assistant panel; above
	   the editor's sticky toolbar (4), its block handles (5) and its sticky Design panel (5).
	   The panel sits below the bar via --sticky-actions-top while it is stuck, but at the end
	   of the editor its containing block pushes it up into the bar's row (as it already slid
	   under the app header); the bar must win there or Save is covered. */
	.sticky-actions {
		position: sticky;
		top: var(--header-h, 64px);
		z-index: 6;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-xs) var(--space-s);
		padding: var(--space-xs) var(--space-s);
		background: var(--surface);
		color: var(--text);
		border-radius: var(--radius-s);
		box-shadow: var(--border-shadow-s), var(--shadow-s);
	}
	.sa-status {
		margin-right: auto;
		min-width: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.sa-dirty {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.sa-dot {
		display: none;
		width: 8px;
		height: 8px;
		border-radius: var(--radius-full);
		background: var(--warn);
		flex: 0 0 auto;
	}
	.sa-buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-xs);
	}

	/* Phones: fixed to the bottom of the viewport, full width, above the home indicator. */
	@media (max-width: 768px) {
		.sticky-actions {
			position: fixed;
			top: auto;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 26; /* over the editor's collapsed Design sheet (25), which is lifted above it */
			border-radius: 0;
			padding: var(--space-xs) var(--space-s) calc(var(--space-xs) + env(safe-area-inset-bottom, 0px));
			box-shadow: inset 0 var(--border-s) 0 var(--border), var(--shadow-m);
		}
		.sa-dot {
			display: inline-block;
		}
		.sa-buttons {
			flex-wrap: nowrap;
		}
		/* The last field (and anything after the form) stays reachable above the bar. */
		:global(main:has(.sticky-actions)) {
			padding-bottom: calc(var(--space-xl) + var(--sticky-actions-bottom, 4rem));
		}
	}
</style>

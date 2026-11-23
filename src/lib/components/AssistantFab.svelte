<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { assistant, toggleAssistant } from '$lib/assistant.svelte';
	import { kbd } from '$lib/platform.svelte';

	// #293: a round launcher in the lower-right corner. Opens the same panel as the header
	// sparkle and Cmd+J / Ctrl+J; hidden while the panel is open (the panel has its own close).
	// The root layout only mounts it for users with assistant access (#292).
</script>

{#if !assistant.open}
	<button
		type="button"
		class="af"
		title="Assistant ({kbd('Mod+J')})"
		aria-label="Ask the assistant"
		onclick={toggleAssistant}
	><Icon name="sparkle" size={24} /></button>
{/if}

<style>
	/* The theme's primary button (--btn-primary-bg, white glyph, #340), round. */
	.af {
		--af-gap: 16px;
		position: fixed;
		right: calc(var(--af-gap) + env(safe-area-inset-right, 0px));
		bottom: calc(var(--af-gap) + env(safe-area-inset-bottom, 0px) + var(--af-lift, 0px) + var(--sticky-actions-bottom, 0px));
		z-index: 60;
		width: 48px;
		height: 48px;
		padding: 0;
		border-radius: var(--radius-full);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: var(--shadow-m);
		transition:
			background-color var(--motion-duration) var(--motion-easing),
			box-shadow var(--motion-duration) var(--motion-easing),
			bottom var(--motion-duration) var(--motion-easing);
	}
	.af:hover {
		box-shadow: var(--shadow-l);
	}
	.af:focus-visible {
		box-shadow: var(--focus-halo), var(--shadow-m);
	}
	.af :global(svg) {
		display: block;
	}
	@media (min-width: 769px) {
		.af {
			--af-gap: var(--space-l);
		}
	}

	/* Stay clear of bottom-pinned bars: the bulk bars on /automations and /groups (sticky,
	   bottom 0.75rem; they wrap to more rows on phones), the PWA update toast, and the
	   visual editor's Design sheet on phones. */
	:global(body:has(.bulkbar)) .af {
		--af-lift: 4.5rem;
	}
	/* #523: the block editor's Write mode hides it (Cmd+J / Ctrl+J still opens the panel). */
	:global(html[data-write-mode]) .af {
		display: none;
	}
	:global(body:has(.update-toast)) .af {
		--af-lift: 4.5rem;
	}
	@media (max-width: 768px) {
		:global(body:has(.bulkbar)) .af {
			--af-lift: 9rem;
		}
		:global(body:has(.be-body.editing .be-panel:not(.dormant))) .af {
			--af-lift: 44px;
		}
		:global(body:has(.be-body.editing .be-panel.open)) .af {
			--af-lift: 60vh;
		}
	}
</style>

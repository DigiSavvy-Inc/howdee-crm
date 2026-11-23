<script lang="ts">
	// Engagement tier pill (#114) — same tier colours as the dashboard's Engagement card.
	import { TIER_LABELS, type TierName } from '$lib/engagement-view';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons/glyphs';

	// #209: hot/warm/cool/cold get a glyph beside the text; never/new stay text-only.
	const TIER_ICONS: Partial<Record<TierName, IconName>> = { hot: 'tier-hot', warm: 'tier-warm', cool: 'tier-cool', cold: 'tier-cold' };

	let { tier, score = null }: { tier: TierName; score?: number | null } = $props();
	const title = $derived(score == null ? TIER_LABELS[tier] : `${TIER_LABELS[tier]} · score ${Math.round(score)} / 100`);
</script>

<span class="tier tier-{tier}" {title}>{#if TIER_ICONS[tier]}<Icon name={TIER_ICONS[tier]} size={14} strokeWidth={1.5} />{/if}{TIER_LABELS[tier]}</span>

<style>
	.tier {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		padding: var(--space-xxs) var(--space-xs);
		border: 0;
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium);
		white-space: nowrap;
		color: var(--neutral-8);
		background: var(--neutral-3);
	}
	/* Status tint + full-colour edge; label in body text for AA (see app.css .badge). */
	.tier-hot {
		color: var(--text);
		background: var(--error-transparent);
		box-shadow: inset 0 0 0 var(--border-s) var(--error);
	}
	.tier-warm {
		color: var(--text);
		background: var(--warning-transparent);
		box-shadow: inset 0 0 0 var(--border-s) var(--warning);
	}
	.tier-cool {
		color: var(--text);
		background: var(--option-badge-background);
	}
</style>

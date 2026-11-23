<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons/glyphs';
	import { radioKeyTarget } from '$lib/trigger-type-picker';

	// Trigger type picker (#425): a radio group of small cards (a grid on wide drawers, one column
	// ≤ 640px). Each card is role="radio"; a visually hidden native radio per card carries the
	// form field, so ?/setTrigger still receives `name` (trigger_type) unchanged.
	let {
		options,
		value = $bindable(),
		name = 'trigger_type',
		label = 'Trigger type'
	}: {
		options: { type: string; label: string; description: string; icon: IconName }[];
		value: string;
		name?: string;
		label?: string;
	} = $props();

	let cards: HTMLButtonElement[] = $state([]);
	const uid = $props.id();
	const labelId = `ttp-${uid}`;
	// Roving tabindex: the checked card, else the first one, is the group's single tab stop.
	const tabStop = $derived(Math.max(0, options.findIndex((o) => o.type === value)));

	function pick(i: number, focus = false) {
		value = options[i].type;
		if (focus) cards[i]?.focus();
	}

	function onkeydown(e: KeyboardEvent, i: number) {
		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			pick(i);
			return;
		}
		const next = radioKeyTarget(e.key, i, options.length);
		if (next === null) return;
		e.preventDefault();
		pick(next, true);
	}
</script>

<div class="ttp">
	<span class="ttp-label" id={labelId}>{label}</span>
	<div class="ttp-grid" role="radiogroup" aria-labelledby={labelId}>
		{#each options as o, i (o.type)}
			<button
				type="button"
				class="ttp-card"
				class:on={value === o.type}
				role="radio"
				aria-checked={value === o.type}
				tabindex={i === tabStop ? 0 : -1}
				bind:this={cards[i]}
				onclick={() => pick(i)}
				onkeydown={(e) => onkeydown(e, i)}
			>
				<span class="ttp-icon"><Icon name={o.icon} size={16} /></span>
				<span class="ttp-text">
					<span class="ttp-name">{o.label}</span>
					<span class="ttp-desc">{o.description}</span>
				</span>
			</button>
			<input class="ttp-native" type="radio" {name} value={o.type} bind:group={value} tabindex="-1" aria-hidden="true" />
		{/each}
	</div>
</div>

<style>
	.ttp {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.ttp-label {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.ttp-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: var(--card-gap);
	}
	@media (max-width: 640px) {
		.ttp-grid {
			grid-template-columns: 1fr;
		}
	}
	/* Reset the global primary-button look: a card, not a button. */
	.ttp-card {
		display: flex;
		align-items: flex-start;
		gap: var(--space-xs);
		min-height: 44px;
		width: 100%;
		margin: 0;
		padding: var(--space-s);
		text-align: left;
		font-weight: inherit;
		color: var(--neutral-10);
		background: transparent;
		border: 0;
		border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		cursor: pointer;
		transform: none;
	}
	.ttp-card:hover {
		background: color-mix(in srgb, var(--accent) 4%, transparent);
		box-shadow: 0 0 0 var(--border-s) var(--muted);
	}
	.ttp-card:active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		transform: none;
	}
	.ttp-card.on {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		box-shadow: 0 0 0 var(--border-s) var(--accent);
	}
	.ttp-card:focus-visible {
		outline: 2px solid var(--color-1);
		outline-offset: 2px;
	}
	.ttp-icon {
		display: inline-flex;
		flex-shrink: 0;
		padding-top: 2px;
		color: var(--muted);
	}
	.ttp-card.on .ttp-icon {
		color: var(--neutral-10);
	}
	.ttp-text {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		min-width: 0;
	}
	.ttp-name {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-medium);
	}
	.ttp-desc {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	/* Kept in the DOM (and the form) but out of sight and out of the tab order. */
	.ttp-native {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
		opacity: 0;
		pointer-events: none;
	}
</style>

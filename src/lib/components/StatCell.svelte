<script lang="ts">
	// One cell of a StatGroup (#340): label (muted, small) → big number → small sub-text.
	// `href` makes the whole cell a link (hover tint); `active` marks the selected one (a
	// filter the page is showing); `tone="warn"` tints a number that needs attention.
	// `children` replaces the plain `sub` text when the sub-line needs markup.
	import type { Snippet } from 'svelte';

	let {
		label,
		value,
		sub,
		href,
		title,
		subTitle,
		active = false,
		tone,
		children
	}: {
		label: string;
		value: string | number;
		sub?: string;
		href?: string;
		title?: string;
		subTitle?: string;
		active?: boolean;
		tone?: 'warn';
		children?: Snippet;
	} = $props();
</script>

{#snippet body()}
	<span class="label">{label}</span>
	<span class="value">{value}</span>
	{#if children}
		<span class="sub" title={subTitle}>{@render children()}</span>
	{:else if sub}
		<span class="sub" title={subTitle}>{sub}</span>
	{/if}
{/snippet}

{#if href}
	<a class="stat-cell link" class:active class:warn={tone === 'warn'} {href} {title}>{@render body()}</a>
{:else}
	<div class="stat-cell" class:warn={tone === 'warn'} {title}>{@render body()}</div>
{/if}

<style>
	.stat-cell {
		/* Dividers: each cell draws its left and top edge; the group clips the outer ones. */
		--stat-dividers: calc(-1 * var(--border-s)) 0 0 0 var(--border), 0 calc(-1 * var(--border-s)) 0 0 var(--border);
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		min-width: 0;
		padding: var(--card-pad);
		background: var(--surface);
		box-shadow: var(--stat-dividers);
		color: var(--text);
		text-decoration: none;
		overflow-wrap: anywhere;
		transition: background-color var(--motion-duration) var(--motion-easing);
	}
	.label {
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.value {
		font-size: var(--size-xl);
		line-height: var(--line-xl);
		letter-spacing: var(--letter-spacing-xl);
		font-weight: var(--weight-ui-heavy);
		font-variant-numeric: tabular-nums;
		/* #436: never break inside a number ("$6,35" / "0.00"); the cell's overflow-wrap:
		   anywhere is for labels and sub-text. Narrow groups get more rows (StatGroup bands). */
		white-space: nowrap;
		overflow-wrap: normal;
	}
	.sub {
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--space-xs);
	}
	.link:hover {
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 6%, var(--surface));
	}
	/* The group clips overflow, so the focus outline sits inside the cell. */
	.link:focus-visible {
		outline-offset: -2px;
	}
	.link.active {
		background: color-mix(in srgb, var(--accent) 10%, var(--surface));
		box-shadow: var(--stat-dividers), inset 0 -2px 0 var(--accent);
	}
	.warn {
		background: color-mix(in srgb, var(--danger) 7%, var(--surface));
	}
	.warn .value {
		color: var(--danger);
	}
	/* Muted text steps up to neutral-8 on the tints: neutral-7 drops under 4.5:1 there in
	   light (4.45 on the 6% hover, 4.27 on the 10% active, 4.30 on the 7% warn); neutral-8
	   is 7.81:1 on white. */
	.link:hover :is(.label, .sub),
	.link.active :is(.label, .sub),
	.warn :is(.label, .sub) {
		color: var(--neutral-8);
	}
	/* #331: compact cells on phones — less padding, number one step down, sub-text at
	   --size-s, and everything wraps (never clips the numbers). */
	@container (max-width: 439px) {
		.stat-cell {
			padding: var(--space-s) var(--space-m);
		}
		.value {
			font-size: var(--size-l);
			line-height: var(--line-l);
			letter-spacing: var(--letter-spacing-l);
		}
		.sub {
			font-size: var(--size-s);
			line-height: var(--line-s);
			letter-spacing: var(--letter-spacing-s);
		}
	}
</style>

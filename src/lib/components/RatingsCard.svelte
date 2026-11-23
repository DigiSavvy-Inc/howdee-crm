<script lang="ts">
	// Contact page Ratings card (#589): ratings the contact gave us through a form's Rating
	// question, newest first — the value out of the highest in its style (stars / hearts filled up
	// to it, the face, or the number), the question, the form (linked) and the date. The page hides
	// the card when there are none.
	import { ratingGlyph, ratingSpoken, ratingText } from '$lib/form-rating';
	import type { ContactRatingRow } from '$lib/server/contact-ratings';

	let { ratings }: { ratings: ContactRatingRow[] } = $props();

	const settings = (r: ContactRatingRow) => ({ style: r.style, min: r.low, max: r.high, low_label: '', high_label: '' });
	const steps = (r: ContactRatingRow) => Array.from({ length: r.high - r.low + 1 }, (_, i) => r.low + i);
	const day = (iso: string) => iso.slice(0, 10);
</script>

<section class="card ratings">
	<h2>Ratings</h2>
	<ul>
		{#each ratings as r (r.id)}
			<li>
				<div class="line">
					<span class="glyphs" role="img" aria-label={ratingSpoken(settings(r), r.value)}>
						{#if r.style === 'stars' || r.style === 'hearts'}
							{#each steps(r) as v (v)}<span class="g" class:on={v <= r.value}>{@html ratingGlyph(r.style, v, 16)}</span>{/each}
						{:else if r.style === 'faces'}
							<span class="g face on">{@html ratingGlyph('faces', r.value, 18)}</span>
						{/if}
					</span>
					<strong class="value">{ratingText(r.value, { max: r.high })}</strong>
					<span class="q">{r.question}</span>
				</div>
				<p class="muted small">
					{#if r.form_id && r.form_name}<a href="/forms/{r.form_id}">{r.form_name}</a>{:else}Deleted form{/if}
					· <time datetime={r.created_at.replace(' ', 'T') + 'Z'}>{day(r.created_at)}</time>
				</p>
			</li>
		{/each}
	</ul>
</section>

<style>
	.ratings { margin-bottom: var(--space-l); }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	ul { list-style: none; margin: var(--space-s) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); }
	li + li { border-top: 1px solid var(--border); padding-top: var(--space-s); }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	.glyphs { display: inline-flex; flex-wrap: wrap; gap: 1px; color: var(--muted); }
	.glyphs:empty { display: none; }
	.g { display: inline-flex; }
	.g :global(svg) { fill: transparent; }
	.g :global(.rt-eye) { fill: currentColor; stroke: none; }
	.g :global(.rt-mouth) { fill: none; }
	.g.on { color: var(--btn-primary-bg); }
	.g.on:not(.face) :global(svg) { fill: currentColor; }
	.value { font-variant-numeric: tabular-nums; font-weight: var(--weight-ui-medium); }
	.q { min-width: 0; }
	p { margin: var(--space-xxs) 0 0; }
	.small { font-size: var(--size-s); line-height: var(--line-s); }
</style>

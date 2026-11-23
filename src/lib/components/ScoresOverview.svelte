<script lang="ts">
	// Dashboard Scores module (#468): one line per active score — band counts as a stacked bar
	// (highest band darkest, one sequential hue, a labelled legend so colour never carries
	// identity alone) and how many contacts changed band in the last 7 days. Each line links to
	// the Score distribution report. See CLAUDE.md "Charts".
	type Overview = {
		slug: string;
		name: string;
		total: number;
		bands: { label: string; contacts: number; share: number | null }[];
		moved: number;
	};
	let { scores, moveDays = 7 }: { scores: Overview[]; moveDays?: number } = $props();

	const SHADES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)'];
	function shade(i: number, n: number): string {
		if (n <= SHADES.length) return SHADES[i];
		// More bands than ramp steps: mix along the ramp, darkest (highest band) first.
		const pct = Math.round(100 - (i / (n - 1)) * 100);
		return `color-mix(in srgb, var(--viz-1) ${pct}%, var(--viz-3))`;
	}
	const href = (slug: string) => `/reports/b/score-distribution?p_score=${encodeURIComponent(slug)}`;
</script>

<ul class="scores">
	{#each scores as s (s.slug)}
		<li>
			<div class="head">
				<a href={href(s.slug)}>{s.name}</a>
				<span class="muted moved">{s.moved} moved band in {moveDays} days</span>
			</div>
			{#if s.total}
				<div class="bar" role="img" aria-label="{s.name}: {s.bands.map((b) => `${b.label} ${b.contacts}`).join(', ')}">
					{#each s.bands as b, i (b.label)}
						{#if b.contacts > 0}
							<span
								class="seg"
								style="flex-grow: {b.contacts}; background: {shade(i, s.bands.length)}"
								title="{b.label}: {b.contacts} ({b.share ?? 0}%)"
							></span>
						{/if}
					{/each}
				</div>
				<ul class="legend">
					{#each s.bands as b, i (b.label)}
						<li><span class="sw" style="background: {shade(i, s.bands.length)}"></span>{b.label} <span class="n">{b.contacts}</span></li>
					{/each}
				</ul>
			{:else}
				<p class="muted">No contacts yet.</p>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.scores {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	.moved {
		font-size: var(--size-xs);
	}
	.bar {
		display: flex;
		gap: 2px;
		height: 12px;
		margin-top: var(--space-xxs);
	}
	.seg {
		min-width: 3px;
	}
	.seg:first-child {
		border-radius: 4px 0 0 4px;
	}
	.seg:last-child {
		border-radius: 0 4px 4px 0;
	}
	.seg:only-child {
		border-radius: 4px;
	}
	.legend {
		list-style: none;
		margin: var(--space-xxs) 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xxs) var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		color: var(--muted);
	}
	.sw {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-right: var(--space-xxs);
	}
	.n {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
</style>

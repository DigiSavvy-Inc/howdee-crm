<script lang="ts">
	import { pointsText } from '$lib/scoring';
	import type { FormScoreRule } from '$lib/server/scoring/form-rules';

	// Form page → Settings tab → Scoring (#621), admins only: the score rules a submission of
	// this form earns points from (rules on this form and rules on any CRM form), and a link to
	// add one on Settings → Scoring with this form preselected.
	let { formId, rules }: { formId: number; rules: FormScoreRule[] } = $props();
</script>

<section class="card scoring" aria-labelledby="form-scoring-h">
	<h2 id="form-scoring-h">Scoring</h2>
	<p class="muted note">
		A submission that adds or updates a contact earns points from these score rules. Anonymous, spam and rejected
		submissions earn nothing.
	</p>
	{#if rules.length}
		<ul>
			{#each rules as r (r.rule_id)}
				<li class:off={!r.active || r.score_status !== 'active'}>
					<strong class="pts" class:neg={r.points < 0}>{pointsText(r.points)}</strong>
					<a href={`/settings/scoring/${r.score_id}`}>{r.score_name}</a>
					<span class="muted">
						{#if r.conditions}when {r.conditions}{:else if r.this_form}any submission of this form{:else}any CRM form{/if}
						{#if !r.active}· rule off{/if}
						{#if r.score_status !== 'active'}· score paused{/if}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted note">No score rules use this form yet.</p>
	{/if}
	<a class="btnlink sm" href={`/settings/scoring?form=${formId}`}>Add a score rule</a>
</section>

<style>
	.scoring { margin-top: var(--card-gap); max-width: 720px; }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); }
	.note { margin: var(--space-xxs) 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); }
	ul { list-style: none; margin: 0 0 var(--space-s); padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	li { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	li.off { opacity: 0.7; }
	.pts { min-width: 3.5em; font-variant-numeric: tabular-nums; }
	.muted { font-size: var(--size-xs); line-height: var(--line-xs); }
</style>

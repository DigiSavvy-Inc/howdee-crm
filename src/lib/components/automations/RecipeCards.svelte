<script lang="ts">
	// #398: "Start from a recipe" — one card per starter flow ($lib/automation-recipes). Posting
	// `?/fromRecipe` creates a draft from the recipe's spec and opens it in the editor. A recipe
	// that needs a list or a stage offers a picker; left empty, the draft starts on Manual.
	import { enhance } from '$app/forms';

	type RecipeCard = {
		key: string;
		name: string;
		description: string;
		needs: 'list' | 'stage' | null;
		needsLabel?: string;
		steps: number;
	};
	let {
		recipes,
		lists,
		stages,
		error = null,
		errorKey = null
	}: {
		recipes: RecipeCard[];
		lists: { id: number; name: string; kind: string }[];
		stages: { id: number; name: string }[];
		error?: string | null;
		errorKey?: string | null;
	} = $props();

	let open = $state(false);
	let busy = $state<string | null>(null);
	// A failed create keeps the cards open so the error shows next to its recipe.
	$effect(() => {
		if (error) open = true;
	});
</script>

<section class="card recipes" aria-labelledby="recipes-h">
	<div class="recipes-head">
		<h2 id="recipes-h">Start from a recipe</h2>
		<button type="button" class="link" aria-expanded={open} onclick={() => (open = !open)}>{open ? 'Hide' : 'Show recipes'}</button>
	</div>
	{#if open}
		<p class="muted intro">Each recipe creates a draft you can edit. Nothing is sent until you activate it.</p>
		<ul class="grid">
			{#each recipes as r (r.key)}
				<li class="recipe">
					<form
						method="POST"
						action="?/fromRecipe"
						use:enhance={() => {
							busy = r.key;
							return async ({ update }) => {
								await update();
								busy = null;
							};
						}}
					>
						<input type="hidden" name="recipe" value={r.key} />
						<h3>{r.name}</h3>
						<p class="desc">{r.description}</p>
						<p class="muted meta">{r.steps} steps</p>
						{#if r.needs === 'list'}
							<label class="pick">
								<span>{r.needsLabel ?? 'List'}</span>
								<select name="list_id">
									<option value="">Choose later (Manual trigger)</option>
									{#each lists as l (l.id)}
										<option value={l.id}>{l.name}{l.kind !== 'list' ? ` (${l.kind})` : ''}</option>
									{/each}
								</select>
							</label>
						{:else if r.needs === 'stage'}
							<label class="pick">
								<span>{r.needsLabel ?? 'Stage'}</span>
								<select name="stage_id">
									<option value="">Choose later (Manual trigger)</option>
									{#each stages as s (s.id)}
										<option value={s.id}>{s.name}</option>
									{/each}
								</select>
							</label>
						{/if}
						<button type="submit" disabled={busy !== null}>{busy === r.key ? 'Creating…' : 'Use this recipe'}</button>
						{#if error && errorKey === r.key}<p class="err" role="alert">{error}</p>{/if}
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.recipes {
		margin-bottom: var(--space-m);
	}
	.recipes-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s);
	}
	.recipes-head h2 {
		margin: 0;
	}
	.link {
		background: none;
		border: 0;
		padding: 0;
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		cursor: pointer;
	}
	.intro {
		margin: var(--space-xs) 0 var(--space-s);
	}
	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: var(--space-s);
	}
	.recipe form {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		height: 100%;
		margin: 0;
		padding: var(--space-s);
		border: var(--border-s) solid var(--border);
		border-radius: var(--radius-s);
	}
	.recipe h3 {
		margin: 0;
	}
	.desc {
		margin: 0;
		flex: 1;
	}
	.meta {
		margin: 0;
		font-size: var(--size-s);
	}
	.pick {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--size-s);
	}
	.err {
		color: var(--danger);
		font-size: var(--size-s);
		margin: 0;
	}
</style>

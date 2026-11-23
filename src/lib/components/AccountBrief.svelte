<script lang="ts">
	// Account brief card (#388) at the top of a company page. The brief is model output, so it
	// only reaches the DOM through renderBriefHtml (the assistant's safe Markdown renderer, #300:
	// raw HTML escaped, links only to app paths / http(s)); `[source]` tags become chips.
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { generatedText, renderBriefHtml, type BriefSource } from '$lib/account-brief';

	type Brief = {
		id: number;
		brief_md: string;
		one_liner: string;
		sources: BriefSource[];
		open_items: number;
		model: string;
		generated_at: string;
		my_vote: -1 | 1 | null;
	};
	let {
		brief,
		canGenerate,
		unavailable = null,
		error = null,
		notice = null
	}: { brief: Brief | null; canGenerate: boolean; unavailable?: string | null; error?: string | null; notice?: string | null } = $props();

	let busy = $state(false);
	const html = $derived(brief ? renderBriefHtml(brief.brief_md, brief.sources) : '');
	const genEnhance = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};
	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => update({ reset: false });
</script>

<section class="card brief" id="brief" aria-labelledby="brief-title">
	<div class="brief-head">
		<h2 id="brief-title"><Icon name="sparkle" size={20} /> Account brief</h2>
		{#if brief}<span class="muted when">Generated {generatedText(brief.generated_at)}</span>{/if}
		{#if canGenerate}
			<form method="POST" action="?/generateBrief" use:enhance={genEnhance} class="gen">
				<button type="submit" class="small" disabled={busy}>{busy ? 'Writing…' : brief ? 'Refresh' : 'Generate brief'}</button>
			</form>
		{/if}
	</div>

	{#if brief}
		{#if brief.one_liner}<p class="one-liner">{brief.one_liner}</p>{/if}
		<div class="brief-body">{@html html}</div>
		<div class="brief-foot">
			{#if brief.open_items > 0}<span class="muted">{brief.open_items} open item{brief.open_items === 1 ? '' : 's'}</span>{/if}
			<form method="POST" action="?/briefFeedback" use:enhance={keep} class="votes">
				<input type="hidden" name="brief_id" value={brief.id} />
				<button type="submit" name="vote" value="1" class="vote" class:on={brief.my_vote === 1} aria-pressed={brief.my_vote === 1} aria-label="Helpful" title="Helpful">
					<Icon name="thumbs-up" size={16} />
				</button>
				<button type="submit" name="vote" value="-1" class="vote" class:on={brief.my_vote === -1} aria-pressed={brief.my_vote === -1} aria-label="Not helpful" title="Not helpful">
					<Icon name="thumbs-down" size={16} />
				</button>
			</form>
		</div>
	{:else if canGenerate}
		<p class="muted">No brief yet. Generate one to summarise contacts, conversations, the pipeline and integrations for this company.</p>
	{:else}
		<p class="muted">No brief yet.{#if unavailable} {unavailable}{/if}</p>
	{/if}
	{#if error}<p class="err" role="alert">{error}</p>{/if}
	{#if notice}<p class="muted" role="status">{notice}</p>{/if}
</section>

<style>
	.brief-head { display: flex; align-items: center; gap: var(--space-s); flex-wrap: wrap; }
	.brief-head h2 { margin: 0; display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.when { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.gen { margin: 0 0 0 auto; }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.one-liner { font-weight: 600; margin: var(--space-s) 0 0; }
	.brief-body { margin-top: var(--space-xs); overflow-wrap: anywhere; }
	.brief-body :global(p) { margin: var(--space-xs) 0; }
	.brief-body :global(ul), .brief-body :global(ol) { margin: var(--space-xs) 0; padding-left: var(--space-l); }
	/* [source] tags → small chips (title set by linkSourceTags). */
	.brief-body :global(a[title^='Source: ']) {
		display: inline-block; padding: 0 var(--space-xxs); margin: 0 1px; border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border); background: var(--neutral-muted);
		color: var(--text); text-decoration: none; white-space: nowrap;
		font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs);
	}
	.brief-body :global(a[title^='Source: ']:hover) { color: var(--link-hover); }
	.brief-foot { display: flex; align-items: center; gap: var(--space-s); margin-top: var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.votes { display: flex; gap: var(--space-xxs); margin: 0 0 0 auto; }
	.vote { background: none; box-shadow: none; border: 0; padding: var(--space-xxs); color: var(--muted); cursor: pointer; border-radius: var(--radius); }
	.vote:hover { background: var(--neutral-muted); color: var(--text); }
	.vote.on { color: var(--text); box-shadow: 0 0 0 var(--border-s) var(--border); }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
</style>

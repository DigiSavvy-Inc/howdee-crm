<script lang="ts">
	import { enhance } from '$app/forms';
	import { noImplicitSubmit } from '$lib/no-implicit-submit';
	import BlockEditor from '@digisavvy/block-editor';
	import { uploadMedia } from '$lib/editor-host';
	import { editorActions, editorSlashActions } from '$lib/editor-host';
	import { editorLogos, editorSwatches } from '$lib/brand-kit';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import StickyActions from '$lib/components/StickyActions.svelte';
	import { renderPageHtml, type Block } from '$lib/blocks';
	let { data, form } = $props();

	let blocks = $state<Block[]>(data.page.blocks);
	let title = $state(data.page.title);
	let slug = $state(data.page.slug);
	const publicUrl = $derived(`${data.baseUrl}/p/${slug}`);
	// #261: Desktop / Mobile preview = the public page's own HTML, with unsaved changes.
	const renderPreview = async (b: Block[]) => renderPageHtml(title, b);
</script>

<svelte:head><title>Edit: {data.page.title}</title></svelte:head>

<Breadcrumbs items={[{ label: 'Creative' }, { label: 'Pages', href: '/pages' }, { label: data.page.title }]} />

<form
	use:noImplicitSubmit
	method="POST"
	action="?/save"
	use:enhance={() => async ({ update }) => update({ reset: false })}
	class="editor"
>
	<div class="head">
		<input class="title-in" name="title" bind:value={title} required maxlength="120" aria-label="Page title" />
		{#if data.page.published}<span class="badge sent">Published</span>{:else}<span class="badge draft">Draft</span>{/if}
	</div>

	<!-- #520: same DOM order as before (after the title); sticky / fixed by the component. -->
	<StickyActions status={form?.saved ? 'Saved.' : ''}>
		<button type="submit">Save</button>
	</StickyActions>

	<div class="slugrow">
		<span class="muted">{data.baseUrl}/p/</span>
		<input class="slug-in" name="slug" bind:value={slug} required maxlength="60" aria-label="Page slug" />
		{#if data.page.published}
			<a class="muted view" href={publicUrl} target="_blank" rel="noopener">View live ↗</a>
		{/if}
	</div>

	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.saved}<p class="ok">Saved.</p>{/if}

	<BlockEditor upload={uploadMedia} brandLogos={editorLogos(data.brandKit)} swatches={editorSwatches(data.brandKit)} bind:blocks name="blocks" target="page" placeholder="Start your page, or type '/' for blocks" preview={renderPreview} selectionActions={editorActions('page', data.editorAsk)} slashActions={editorSlashActions('page', data.editorAsk)} />
</form>

<div class="row2">
	<form method="POST" action="?/publish" use:enhance class="inline">
		<input type="hidden" name="to" value={data.page.published ? 0 : 1} />
		<button type="submit" class={data.page.published ? 'secondary' : ''}>
			{data.page.published ? 'Unpublish' : 'Publish'}
		</button>
	</form>
	<span class="muted hint">
		{data.page.published
			? 'Live — remember to Save your block changes first; Publish only flips visibility.'
			: 'Drafts return 404 publicly. Save your blocks, then publish when ready.'}
	</span>
	<form method="POST" action="?/delete" use:enhance class="inline del-form">
		<button type="submit" class="danger">Delete page</button>
	</form>
</div>

<style>
	.editor { display: flex; flex-direction: column; gap: var(--space-s); margin: 0 0 var(--space-m); }
	.head { display: flex; align-items: center; gap: var(--space-s); }
	.title-in { flex: 1; min-width: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); font-weight: var(--weight-ui-heavy); }
	.slugrow { display: flex; align-items: center; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); flex-wrap: wrap; }
	.slugrow > .muted { overflow-wrap: anywhere; min-width: 0; }
	.slug-in { font-family: var(--font-mono); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); width: 18rem; max-width: 100%; min-width: 0; }
	@media (max-width: 640px) {
		.head { flex-wrap: wrap; }
		.title-in { flex-basis: 100%; }
		.slug-in { flex: 1 1 12rem; }
	}
	.view { margin-left: var(--space-xs); }
	.err { color: var(--danger); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0; }
	.row2 { display: flex; align-items: center; gap: var(--space-s); margin-top: var(--space-m); flex-wrap: wrap; }
	.inline { margin: 0; }
	.del-form { margin-left: auto; }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); max-width: 40ch; }
</style>

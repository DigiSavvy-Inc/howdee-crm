<script lang="ts">
	import { enhance } from '$app/forms';
	import { noImplicitSubmit } from '$lib/no-implicit-submit';
	import BlockEditor from '@digisavvy/block-editor';
	import { uploadMedia } from '$lib/editor-host';
	import { editorActions, editorSlashActions } from '$lib/editor-host';
	import { editorLogos, editorSwatches } from '$lib/brand-kit';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import type { Block } from '$lib/blocks';
	let { data, form } = $props();

	let header = $state<Block[]>(data.header);
	let footer = $state<Block[]>(data.footer);

	// #255: both editors preview the same email — unsaved header + sample campaign
	// content + unsaved footer — through the real assembler.
	async function renderPreview(): Promise<string> {
		const fd = new FormData();
		fd.set('header', JSON.stringify(header));
		fd.set('footer', JSON.stringify(footer));
		const res = await fetch('/templates/preview', { method: 'POST', body: fd });
		if (!res.ok) throw new Error('preview failed');
		return res.text();
	}
</script>

<svelte:head><title>Global header & footer</title></svelte:head>

<Breadcrumbs items={[{ label: 'Creative' }, { label: 'Templates', href: '/templates' }, { label: 'Global header & footer' }]} />

<div class="head"><h1>Global header & footer</h1></div>
<p class="muted intro">
	These blocks wrap <strong>every builder-template campaign</strong>: header above the
	template, footer below it (before the signature and unsubscribe line). Individual
	templates can opt out with their “Include global header/footer” toggles. Typical use:
	a logo image up top, contact/social info at the bottom.
</p>

<form method="POST" action="?/save" use:noImplicitSubmit use:enhance={() => async ({ update }) => update({ reset: false })} class="editor">
	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.saved}<p class="ok">Saved.</p>{/if}

	<section class="card">
		<h2>Header</h2>
		<BlockEditor upload={uploadMedia} brandLogos={editorLogos(data.brandKit)} swatches={editorSwatches(data.brandKit)} bind:blocks={header} name="header" mergeTags={data.mergeTags} placeholder="Add a logo or a line above every template, or type '/' for blocks" preview={renderPreview} selectionActions={editorActions('email', data.editorAsk)} slashActions={editorSlashActions('email', data.editorAsk)} />
	</section>

	<section class="card">
		<h2>Footer</h2>
		<BlockEditor upload={uploadMedia} brandLogos={editorLogos(data.brandKit)} swatches={editorSwatches(data.brandKit)} bind:blocks={footer} name="footer" mergeTags={data.mergeTags} placeholder="Add contact or social info below every template, or type '/' for blocks" preview={renderPreview} selectionActions={editorActions('email', data.editorAsk)} slashActions={editorSlashActions('email', data.editorAsk)} />
	</section>

	<button type="submit">Save global header & footer</button>
</form>

<style>
	.head { display: flex; align-items: center; gap: var(--space-s); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 62ch; }
	.editor { display: flex; flex-direction: column; gap: var(--space-m); margin: 0; }
	.editor > button { align-self: flex-start; }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.err { color: var(--danger); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0; }
</style>

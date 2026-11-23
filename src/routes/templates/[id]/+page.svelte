<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { noImplicitSubmit } from '$lib/no-implicit-submit';
	import BlockEditor from '@digisavvy/block-editor';
	import { uploadMedia } from '$lib/editor-host';
	import { editorActions, editorSlashActions } from '$lib/editor-host';
	import { editorLogos, editorSwatches } from '$lib/brand-kit';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import StickyActions from '$lib/components/StickyActions.svelte';
	import { countContentAreas, type Block, type EmailCanvas } from '$lib/blocks';
	let { data, form } = $props();

	const isHtml = data.template.kind === 'html';
	// #481: a web template designs the public newsletter archive (page-mode blocks).
	const isWeb = untrack(() => data.template.kind === 'web');
	const wc = untrack(() => data.template.webCanvas ?? {});
	let webBg = $state(wc.bg ?? '');
	let webLink = $state(wc.link ?? '');
	let webWidth = $state(wc.width ? String(wc.width) : '');
	let webFont = $state(wc.font ?? '');
	let webSize = $state(wc.fontSize ? String(wc.fontSize) : '');
	let name = $state(data.template.name);
	let blocks = $state<Block[]>(data.template.blocks);
	let canvas = $state<EmailCanvas>(untrack(() => data.template.canvas)); // #270
	let html = $state(data.template.html ?? '');
	let useHeader = $state(untrack(() => data.template.use_global_header === 1));
	let useFooter = $state(untrack(() => data.template.use_global_footer === 1));
	let emailPreview = $state(false); // raw-HTML kind only; builder kind previews in the editor
	const contentAreas = $derived(countContentAreas(blocks));

	// #255: Desktop / Mobile preview through the real assembler (header + template +
	// sample campaign content + footer), with the unsaved blocks and toggles.
	async function renderPreview(b: Block[]): Promise<string> {
		const fd = new FormData();
		fd.set('blocks', JSON.stringify(b));
		if (isWeb) {
			fd.set('web', '1');
			for (const [k, v] of Object.entries({ web_bg: webBg, web_link: webLink, web_width: webWidth, web_font: webFont, web_size: webSize })) fd.set(k, v);
		}
		fd.set('canvas', JSON.stringify(canvas));
		if (useHeader) fd.set('use_global_header', '1');
		if (useFooter) fd.set('use_global_footer', '1');
		const res = await fetch('/templates/preview', { method: 'POST', body: fd });
		if (!res.ok) throw new Error('preview failed');
		return res.text();
	}
</script>

<svelte:head><title>Edit: {data.template.name}</title></svelte:head>

<Breadcrumbs items={[{ label: 'Creative' }, { label: 'Templates', href: '/templates' }, { label: data.template.name }]} />

<form method="POST" action="?/save" use:noImplicitSubmit use:enhance={() => async ({ update }) => update({ reset: false })} class="editor">
	<div class="head">
		<input class="title-in" name="name" bind:value={name} required maxlength="120" aria-label="Template name" />
		<span class="badge {isHtml ? 'draft' : isWeb ? 'scheduled' : 'sent'}">{isHtml ? 'HTML' : isWeb ? 'Web page' : 'Builder'}</span>
	</div>

	<!-- #520: same DOM order as before (after the name); sticky / fixed by the component. -->
	<StickyActions status={form?.saved ? 'Saved.' : ''}>
		{#if isHtml}
			<button type="button" class="secondary" onclick={() => (emailPreview = !emailPreview)}>
				{emailPreview ? 'Hide preview' : 'Preview'}
			</button>
		{/if}
		{#if !isHtml && !isWeb}
			<!-- #493: its own form (form=), since forms can't nest. -->
			<button type="submit" class="secondary" form="copy-as-web" title="Makes a Web page template with this layout for Settings → Newsletter archive.">Copy as newsletter archive page</button>
		{/if}
		<button type="submit">Save</button>
	</StickyActions>

	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.saved}<p class="ok">Saved.</p>{/if}
	{#if data.copied}
		<p class="ok">Copied from your email template. Blocks above the content area become the page header, below it the footer. Pick this template under Settings → Newsletter archive → Page template.</p>
	{/if}

	{#if isHtml}
		<p class="muted note">
			Paste full email HTML. Include <code>%%UNSUB_URL%%</code> where the unsubscribe link
			should go — if it's missing, the standard footer is appended at send. Merge tags
			(<code>{'{{first_name}}'}</code>, <code>{'{{company}}'}</code>, …) are filled per recipient.
		</p>
		<textarea name="html" rows="22" bind:value={html} spellcheck="false" placeholder="<!doctype html>…"></textarea>
	{:else if isWeb}
		<p class="muted note">
			Designs the public <a href="/settings/newsletter">newsletter archive</a>. Blocks above the
			<strong>Content area</strong> are the page header, blocks below it the footer; each issue (title, date,
			content, subscribe box, previous / next) lands in the content area, and the index page lists the issues
			there. Light and dark follow the reader's system setting.
		</p>
		<fieldset class="web-settings">
			<legend>Page settings</legend>
			<label>Background <input name="web_bg" bind:value={webBg} placeholder={data.webOptions.defaults.bg} maxlength="7" /></label>
			<label>Link colour <input name="web_link" bind:value={webLink} placeholder={data.webOptions.defaults.link} maxlength="7" /></label>
			<label>
				Content width
				<select name="web_width" bind:value={webWidth}>
					<option value="">Default ({data.webOptions.defaults.width}px)</option>
					{#each data.webOptions.widths as w (w)}<option value={String(w)}>{w}px</option>{/each}
				</select>
			</label>
			<label>
				Base font
				<select name="web_font" bind:value={webFont}>
					<option value="">Default</option>
					{#each data.webOptions.fonts as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
				</select>
			</label>
			<label>
				Text size
				<select name="web_size" bind:value={webSize}>
					<option value="">Default ({data.webOptions.defaults.fontSize}px)</option>
					{#each data.webOptions.sizes as z (z)}<option value={String(z)}>{z}px</option>{/each}
				</select>
			</label>
		</fieldset>
		{#if contentAreas === 0}
			<p class="notice warn" role="status">No content area yet: the issue will be added after the template's blocks.</p>
		{:else if contentAreas > 1}
			<p class="notice warn" role="status">This template has {contentAreas} content areas. Only the first is kept when you save.</p>
		{/if}
		<BlockEditor upload={uploadMedia} brandLogos={editorLogos(data.brandKit)} swatches={editorSwatches(data.brandKit)} bind:blocks name="blocks" target="page" allowContentArea preview={renderPreview} selectionActions={editorActions('page', data.editorAsk)} slashActions={editorSlashActions('page', data.editorAsk)} />
	{:else}
		<p class="muted note">
			Blocks render as email-safe HTML (tables — works in Gmail/Outlook). Add a
			<strong>Content area</strong> from the <kbd>/</kbd> menu where a campaign's content should
			land. <strong>Desktop</strong> / <strong>Mobile</strong> preview the whole email with sample content.
		</p>
		<div class="chrome-toggles">
			<label class="check"><input type="checkbox" name="use_global_header" bind:checked={useHeader} /> Include <a href="/templates/global">global header</a></label>
			<label class="check"><input type="checkbox" name="use_global_footer" bind:checked={useFooter} /> Include <a href="/templates/global">global footer</a></label>
		</div>
		{#if contentAreas === 0}
			<p class="notice warn" role="status">No content area yet: campaign content will be added after the template's blocks.</p>
		{:else if contentAreas > 1}
			<p class="notice warn" role="status">This template has {contentAreas} content areas. Only the first is kept when you save.</p>
		{/if}
		<BlockEditor upload={uploadMedia} brandLogos={editorLogos(data.brandKit)} swatches={editorSwatches(data.brandKit)} bind:blocks bind:canvas name="blocks" mergeTags={data.mergeTags} allowContentArea preview={renderPreview} selectionActions={editorActions('email', data.editorAsk)} slashActions={editorSlashActions('email', data.editorAsk)} />
	{/if}

	{#if isHtml && emailPreview}
		<div class="preview">
			<div class="preview-bar"><span class="muted">Email preview</span></div>
			<iframe title="Email preview" sandbox="" srcdoc={html}></iframe>
		</div>
	{/if}
</form>

{#if !isHtml && !isWeb}
	<!-- No use:enhance: a client-side redirect would reuse this component, whose editor state
	     (kind, blocks, canvas) is read once; a full load opens the copy cleanly. -->
	<form id="copy-as-web" method="POST" action="?/copyAsWeb" hidden></form>
{/if}

<form method="POST" action="?/delete" use:enhance class="del-form">
	<button type="submit" class="danger">Delete template</button>
</form>

<style>
	.editor { display: flex; flex-direction: column; gap: var(--space-s); margin: 0 0 var(--space-m); }
	.head { display: flex; align-items: center; gap: var(--space-s); }
	.title-in { flex: 1; min-width: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); font-weight: var(--weight-ui-heavy); }
	@media (max-width: 640px) {
		.head { flex-wrap: wrap; }
		.title-in { flex-basis: 100%; }
	}
	.note { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.chrome-toggles { display: flex; gap: var(--space-l); flex-wrap: wrap; }
	.check { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.note code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	textarea { width: 100%; font-family: var(--font-mono); font-size: var(--size-s); letter-spacing: var(--letter-spacing-s); line-height: var(--line-s); resize: vertical; }
	.note kbd { font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); box-shadow: 0 0 0 var(--border-s) var(--neutral-4); }
	/* #427: shared .notice.warn; the .editor column's gap already spaces it. */
	.notice { margin: 0; }
	.err { color: var(--danger); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0; }
	.preview { border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); overflow: hidden; }
	.preview-bar { padding: var(--space-xs) var(--space-s); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.preview iframe { display: block; width: 100%; height: 540px; border: 0; background: #fff; }
	.del-form { margin-top: var(--space-m); }
	.web-settings { display: flex; flex-wrap: wrap; gap: var(--space-s) var(--space-m); margin: 0; }
	.web-settings label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.web-settings input { width: 8rem; }
</style>

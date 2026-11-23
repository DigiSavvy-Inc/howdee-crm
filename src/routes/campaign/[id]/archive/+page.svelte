<script lang="ts">
	// #483: the newsletter archive's web-only version of one issue. Saving never touches the
	// sent email; Reset clears the web version (the page renders from the email again).
	import { enhance } from '$app/forms';
	import { noImplicitSubmit } from '$lib/no-implicit-submit';
	import { beforeNavigate } from '$app/navigation';
	import { untrack } from 'svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import BlockEditor from '@digisavvy/block-editor';
	import { uploadMedia } from '$lib/editor-host';
	import { editorActions, editorSlashActions } from '$lib/editor-host';
	import { editorLogos, editorSwatches } from '$lib/brand-kit';
	import StickyActions from '$lib/components/StickyActions.svelte';
	import type { Block } from '$lib/blocks';
	import { markdownToBlocks } from '$lib/blocks-markdown';
	import { fingerprint, isDirty } from '$lib/automation-editor';
	import { ISSUE_TEASER_MAX, ISSUE_TITLE_MAX } from '$lib/newsletter-archive';

	let { data, form } = $props();

	const LEAVE = 'You have unsaved changes to the archive version. Leave this page and lose them?';

	function seed() {
		const i = data.issue;
		return {
			title: i.title,
			teaser: i.teaser,
			// A raw-HTML campaign keeps its email layout until "Start from blank".
			mode: (i.htmlOnly && !i.blank ? 'original' : 'blocks') as 'original' | 'blocks',
			blocks: i.blocks ?? markdownToBlocks(i.bodyMd)
		};
	}
	const first = untrack(seed);
	let title = $state(first.title);
	let teaser = $state(first.teaser);
	let mode = $state(first.mode);
	let blocks = $state<Block[]>(first.blocks);
	let editorKey = $state(0);
	let busy = $state(false);

	const current = () => fingerprint({ title: title.trim(), teaser: teaser.trim(), mode, blocks: mode === 'blocks' ? blocks : null });
	// Baselined once the editor has normalised the blocks (or at once with no editor).
	let baseline = $state<string | null>(untrack(() => (first.mode === 'original' ? current() : null)));
	const webDirty = $derived(isDirty(baseline, current()));
	// #499: the issue number saves with the same form but is its own column.
	const numText = (n: number | null) => (n == null ? '' : String(n));
	let number = $state<string | number>(untrack(() => numText(data.issue.number)));
	const numberDirty = $derived(String(number ?? '').trim() !== numText(data.issue.number));
	const dirty = $derived(webDirty || numberDirty);

	function startBlank() {
		mode = 'blocks';
		blocks = [];
		editorKey++;
	}
	function keepEmailLayout() {
		mode = 'original';
		blocks = [];
	}

	beforeNavigate((nav) => {
		if (!dirty) return;
		if (nav.type === 'leave') nav.cancel();
		else if (!confirm(LEAVE)) nav.cancel();
	});
</script>

<svelte:window
	onbeforeunload={(e) => {
		if (dirty) e.preventDefault();
	}}
/>

<svelte:head><title>Archive version · {data.issue.subject}</title></svelte:head>

<Breadcrumbs
	items={[
		{ label: 'Campaigns', href: '/campaigns' },
		{ label: data.issue.subject || `Campaign #${data.issue.id}`, href: `/campaign/${data.issue.id}` },
		{ label: 'Newsletter archive version' }
	]}
/>

<h1>Newsletter archive version</h1>
<p class="notice" role="status">
	This changes the web page in the newsletter archive only. The email that was sent is unchanged, and the send log, resends and reports keep using it.
</p>
<p class="muted meta">
	{#if data.issue.editedAt}<span class="badge type">edited for web</span> Saved {data.issue.editedAt} UTC ·{:else}No web version yet: the page shows the email. ·{/if}
	{#if data.issue.published && data.url}In the archive: <a href={data.url} target="_blank" rel="noopener">{data.url}</a>{:else}Not published yet: publish it from <a href="/campaign/{data.issue.id}">the campaign page</a>.{/if}
	{#if !data.archiveEnabled}(The archive is off: <a href="/settings/newsletter">turn it on</a>.){/if}
</p>

{#if form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
{#if form?.saved && !dirty}<p class="notice ok" role="status">Saved. The archive page uses this version.</p>{/if}
{#if form?.reset}<p class="notice ok" role="status">Reset. The archive page shows the email again.</p>{/if}

<form
	use:noImplicitSubmit
	method="POST"
	action="?/save"
	class="arch-form"
	use:enhance={() => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			if (result.type === 'success') {
				baseline = current();
				number = numText(data.issue.number);
			}
		};
	}}
>
	<label class="field num">
		<span>Issue number</span>
		<input name="number" type="number" min="1" step="1" inputmode="numeric" bind:value={number} placeholder="None" />
		<small class="muted">Shown as “Issue {String(number ?? '').trim() || 'N'}” on the archive. Set when first published; blank = no number.</small>
	</label>
	<!-- Only the number changed: don't create a web version just for it. -->
	<input type="hidden" name="web_changed" value={numberDirty && !webDirty ? '0' : '1'} />
	<label class="field">
		<span>Title</span>
		<input name="title" bind:value={title} maxlength={ISSUE_TITLE_MAX} placeholder={data.issue.subject} />
		<small class="muted">Blank = the subject. The URL stays the same.</small>
	</label>
	<label class="field">
		<span>Teaser</span>
		<textarea name="teaser" rows="3" bind:value={teaser} maxlength={ISSUE_TEASER_MAX} placeholder={data.issue.defaultTeaser}></textarea>
		<small class="muted">Shown on the archive's index, in the feed and in search results. Blank = the preheader, else the opening text.</small>
	</label>

	<input type="hidden" name="body_mode" value={mode} />
	<div class="field">
		<span>Body</span>
		{#if mode === 'original'}
			<p class="notice">
				This email uses a raw HTML template, which can't be edited as blocks. The archive page shows the email's own layout.
				<button type="button" class="secondary small" onclick={startBlank}>Start from blank</button>
			</p>
		{:else}
			{#if data.issue.htmlOnly}
				<p class="notice warn">
					This body replaces the original email layout on the web page.
					<button type="button" class="secondary small" onclick={keepEmailLayout}>Use the email's layout instead</button>
				</p>
			{/if}
			{#key editorKey}
				<BlockEditor
					upload={uploadMedia}
					brandLogos={editorLogos(data.brandKit)}
					swatches={editorSwatches(data.brandKit)}
					bind:blocks
					mergeTags={data.mergeTags}
					selectionActions={editorActions('email', data.editorAsk)}
					slashActions={editorSlashActions('email', data.editorAsk, () => title || data.issue.subject)}
					onready={(b) => {
						blocks = b;
						baseline = current();
					}}
				/>
			{/key}
		{/if}
	</div>

	<!-- #520: stays last in the DOM (tab order); shown at the top on desktop via order: -1. -->
	<StickyActions {dirty} status={form?.saved ? 'Saved.' : ''}>
		<button type="submit" disabled={busy}>Save</button>
		<!-- Preview posts the unsaved fields to a new tab (its own form, below). -->
		<button type="submit" form="arch-preview" class="secondary">Preview</button>
	</StickyActions>
</form>

<form id="arch-preview" method="POST" action="/campaign/{data.issue.id}/archive/preview" target="_blank">
	<input type="hidden" name="title" value={title} />
	<input type="hidden" name="teaser" value={teaser} />
	<input type="hidden" name="body_mode" value={mode} />
	<input type="hidden" name="body_blocks" value={JSON.stringify(blocks)} />
</form>

{#if data.issue.editedAt}
	<form
		method="POST"
		action="?/reset"
		class="reset"
		use:enhance={({ cancel }) => {
			if (!confirm('Reset to the email version? The web title, teaser and body you saved are cleared.')) return cancel();
			return async ({ result, update }) => {
				await update();
				if (result.type !== 'success') return;
				const s = seed();
				title = s.title;
				teaser = s.teaser;
				mode = s.mode;
				blocks = s.blocks;
				baseline = mode === 'original' ? current() : null;
				editorKey++;
			};
		}}
	>
		<button type="submit" class="secondary">Reset to email version</button>
	</form>
{/if}

<style>
	.meta { margin: 0 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.meta a { overflow-wrap: anywhere; }
	.arch-form { display: grid; gap: var(--space-m); }
	.field { display: grid; gap: var(--space-xxs); }
	.field > span { font-weight: 600; }
	.field input, .field textarea { width: 100%; }
	.field.num input { max-width: 10rem; }
	.arch-form > :global(.sticky-actions) { order: -1; }
	.reset { margin: var(--space-l) 0 0; }
	.notice button { margin-left: var(--space-xs); }
</style>

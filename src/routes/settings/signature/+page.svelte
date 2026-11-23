<script lang="ts">
	import { enhance } from '$app/forms';
	import { SIGNATURE_MAX, simpleSignatureHtml, simpleSignatureText } from '$lib/signature';
	import { htmlToText } from '$lib/email-text';
	let { data, form } = $props();

	// The editor starts from what is saved (re-synced after each save / clear).
	let mode = $state<'simple' | 'html'>('simple');
	let source = $state('');
	let html = $state('');
	let text = $state('');
	let busy = $state(false);
	$effect.pre(() => {
		const s = data.signature;
		mode = s.source === null && s.html.trim() ? 'html' : 'simple';
		source = s.source ?? '';
		html = s.html;
		text = s.text;
	});

	const previewHtml = $derived(mode === 'simple' ? simpleSignatureHtml(source) : html.trim());
	const autoText = $derived(mode === 'simple' ? simpleSignatureText(source) : previewHtml ? htmlToText(previewHtml).trim() : '');
	const previewText = $derived(text.trim() || autoText);
	// Sandboxed (no scripts, no same-origin); the server sanitises the HTML again on save.
	const srcdoc = $derived(
		`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;background:#fff}a{text-decoration:none;color:#2563eb}</style></head><body>${previewHtml}</body></html>`
	);
</script>

<svelte:head><title>Signature</title></svelte:head>

<h1>Signature</h1>
<p class="muted intro">
	Added under every email the app sends with the standard layout: broadcasts, automation emails, scheduled sends,
	1:1 emails and conversation replies. Leave it empty for no signature. Raw HTML templates and the newsletter archive
	never show it.
</p>

<form
	method="POST"
	action="?/save"
	use:enhance={() => {
		busy = true;
		return async ({ update }) => {
			await update({ reset: false });
			busy = false;
		};
	}}
>
	<section class="card">
		<fieldset>
			<legend>Edit as</legend>
			<div class="radios">
				<label class="check"><input type="radio" name="mode" value="simple" bind:group={mode} /> Simple text</label>
				<label class="check"><input type="radio" name="mode" value="html" bind:group={mode} /> HTML (advanced)</label>
			</div>
		</fieldset>

		{#if mode === 'simple'}
			<label class="field"><span>Signature <span class="muted">(one line per row; <code>**bold**</code>, <code>*italic*</code>, <code>[label](https://…)</code>)</span></span>
				<textarea name="source" rows="8" maxlength={SIGNATURE_MAX} bind:value={source} placeholder={'--\n**Your name**\nYour title\n[Your company](https://example.com)'}></textarea>
			</label>
			{#if data.signature.source === null && data.signature.html.trim()}
				<p class="muted small">Saving as simple text replaces the saved HTML signature.</p>
			{/if}
		{:else}
			<label class="field"><span>Signature HTML <span class="muted">(pasted HTML is cleaned on save: no scripts, frames, forms or event handlers)</span></span>
				<textarea name="html" rows="10" maxlength={SIGNATURE_MAX} bind:value={html} class="mono" spellcheck="false"></textarea>
			</label>
		{/if}

		<label class="field"><span>Plain-text version <span class="muted">(for the text part of each email; leave empty to generate it)</span></span>
			<textarea name="text" rows="6" maxlength={SIGNATURE_MAX} bind:value={text} placeholder={autoText}></textarea>
		</label>
	</section>

	<section class="card">
		<h2>Preview</h2>
		{#if previewHtml || previewText}
			<iframe title="Signature preview" sandbox="" {srcdoc}></iframe>
			<details>
				<summary>Plain text</summary>
				<pre>{previewText}</pre>
			</details>
		{:else}
			<p class="muted">No signature. Emails end after their content.</p>
		{/if}
	</section>

	{#if form && 'error' in form && form.error}<p class="notice err" role="alert">{form.error}</p>{/if}
	{#if form && 'saved' in form && form.saved}<p class="notice ok" role="status">{form.empty ? 'Saved. No signature is set.' : 'Saved.'}</p>{/if}
	{#if form && 'cleared' in form && form.cleared}<p class="notice ok" role="status">Signature removed.</p>{/if}
	<div class="actions">
		<button type="submit" disabled={busy}>Save</button>
		<button type="submit" class="secondary" formaction="?/clear" formnovalidate disabled={busy}>Remove signature</button>
	</div>
</form>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); display: flex; flex-direction: column; gap: var(--space-s); }
	section.card p { max-width: 70ch; margin: 0; }
	fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
	legend { padding: 0; margin-bottom: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); }
	.radios { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-m); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 48rem; }
	.field textarea { width: 100%; }
	.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: var(--size-xs); }
	.check { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	iframe { width: 100%; max-width: 48rem; height: 14rem; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; }
	pre { white-space: pre-wrap; margin: var(--space-xs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-s); }
</style>

<script lang="ts">
	import { signatureHtml, type EmailSignature } from '$lib/signature';
	import { parseMarkdownPreservingMergeTags } from '$lib/merge-tags';

	type MergeTag = { tag: string; desc: string };

	let {
		value = $bindable(''),
		mergeTags = [],
		name = 'body_md',
		required = true,
		signature = null,
		placeholder = '# Hi {{first_name}}\n\nWrite your email in **markdown**.\n\n- Bullet points\n- [Links](https://example.com)'
	}: {
		value?: string;
		mergeTags?: MergeTag[];
		name?: string;
		required?: boolean;
		/** #594: the signature setting (null = none). */
		signature?: EmailSignature | null;
		placeholder?: string;
	} = $props();

	let bodyEl = $state<HTMLTextAreaElement | undefined>();

	function insertTag(tag: string) {
		const el = bodyEl;
		if (!el) {
			value += tag;
			return;
		}
		const s = el.selectionStart;
		const e = el.selectionEnd;
		value = value.slice(0, s) + tag + value.slice(e);
		queueMicrotask(() => {
			el.focus();
			el.selectionStart = el.selectionEnd = s + tag.length;
		});
	}

	function looksLikeUrl(s: string): boolean {
		return !/\s/.test(s) && /^(https?:\/\/|www\.|mailto:)\S+$/i.test(s);
	}

	// Selected text + pasted URL -> markdown link [selected](url).
	function onPaste(e: ClipboardEvent) {
		const el = bodyEl;
		if (!el) return;
		const start = el.selectionStart;
		const end = el.selectionEnd;
		if (start === end) return; // nothing selected — let the normal paste happen
		const pasted = (e.clipboardData?.getData('text/plain') ?? '').trim();
		if (!looksLikeUrl(pasted)) return;
		e.preventDefault();
		const url = /^www\./i.test(pasted) ? `https://${pasted}` : pasted;
		const selectedText = value.slice(start, end);
		const link = `[${selectedText}](${url})`;
		value = value.slice(0, start) + link + value.slice(end);
		queueMicrotask(() => {
			el.focus();
			el.selectionStart = el.selectionEnd = start + link.length;
		});
	}

	const preview = $derived.by(() => {
		const sig = signatureHtml(signature);
		return (value ? parseMarkdownPreservingMergeTags(value) : '') + (sig ? `<div class="sig-preview">${sig}</div>` : '');
	});
</script>

<div class="vars">
	<span class="vars-label">Personalization — click to insert:</span>
	{#each mergeTags as t (t.tag)}
		<button type="button" class="tag" title={t.desc} onclick={() => insertTag(t.tag)}>{t.tag}</button>
	{/each}
	<span class="vars-hint muted">Works in the subject too. Empty first name → “there”.</span>
</div>

<div class="editor">
	<div class="pane">
		<div class="pane-head">
			Markdown <span class="pane-tip">· select text, paste a URL → auto-link</span>
		</div>
		<textarea {name} bind:value bind:this={bodyEl} onpaste={onPaste} {placeholder} {required}
		></textarea>
	</div>
	<div class="pane">
		<div class="pane-head">Preview</div>
		<div class="preview">
			{#if value}{@html preview}{:else}<span class="muted">Preview appears here…</span>{/if}
		</div>
	</div>
</div>

<style>
	.vars {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-bottom: var(--space-s);
	}
	.vars-label {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		color: var(--muted);
		margin-right: var(--space-xxs);
	}
	/* Merge-tag inserters: small option-badge buttons (tint + body text, AA). */
	.tag {
		padding: var(--space-xxs) var(--space-xs);
		font-family: var(--font-mono);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-regular);
		background: var(--option-badge-background);
		color: var(--text);
		border: none;
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
	}
	.tag:hover {
		background: var(--option-badge-background);
		box-shadow: 0 0 0 var(--border-s) var(--color-1);
		filter: none;
	}
	.vars-hint {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		margin-left: var(--space-xxs);
	}
	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-m);
		min-height: 360px;
	}
	.pane {
		min-width: 0;
		display: flex;
		flex-direction: column;
		border: 0;
		border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-s);
		overflow: hidden;
		background: var(--surface);
	}
	.pane-head {
		padding: var(--space-xs) var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium);
		color: var(--muted);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
		background: var(--surface-subtle);
	}
	.pane-tip {
		font-weight: var(--weight-ui-regular);
	}
	textarea {
		flex: 1;
		border: none;
		border-radius: 0;
		box-shadow: none;
		resize: vertical;
		min-height: 320px;
		font-family: var(--font-mono);
		font-size: var(--size-s);
		line-height: var(--line-m);
	}
	textarea:hover,
	textarea:focus {
		box-shadow: none;
	}
	textarea:focus-visible {
		outline-offset: -2px;
	}
	.preview {
		flex: 1;
		padding: var(--space-s) var(--space-m);
		overflow: auto;
		font-size: var(--size-m);
		line-height: var(--line-m);
		overflow-wrap: anywhere;
	}
	.preview :global(h1) {
		font-size: var(--size-l);
		line-height: var(--line-l);
	}
	.preview :global(img) {
		max-width: 100%;
	}
	.preview :global(.sig-preview) {
		margin-top: var(--space-l);
		padding-top: var(--space-m);
		box-shadow: inset 0 var(--border-s) 0 var(--neutral-4);
	}
	@media (max-width: 900px) {
		.editor {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>

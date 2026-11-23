<script lang="ts">
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { untrack, type Snippet } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { formatMicros } from '$lib/ai-models';
	import { renderAssistantMarkdown } from '$lib/assistant-markdown';
	import { toolGroupLabel, toolLabel, tokensText, type ChatItem, type Feedback, type ToolRow } from '$lib/assistant-view';

	// One assistant reply in the panel (#300): tool activity (one row, or a collapsible
	// "Looked at N things" group), the answer as safe Markdown, a copy button and the cost.
	// While streaming, the accumulated text is re-parsed at most once per animation frame.
	// #301: `actions` (the panel's action cards for this turn) render after the tool rows and
	// before the answer.
	// #310: thumbs up / down on the answer, saved on the turn's last stored assistant row
	// (POST /api/assistant/messages/:id/feedback); clicking the chosen one again clears it.

	let { item, actions }: { item: Extract<ChatItem, { kind: 'assistant' }>; actions?: Snippet } = $props();

	let html = $state('');
	let raf = 0;
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	const render = (text: string) => renderAssistantMarkdown(text, browser ? [location.origin] : []);

	$effect(() => {
		const text = item.text;
		if (!item.streaming || !browser) {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			html = render(text);
			return;
		}
		if (!raf)
			raf = requestAnimationFrame(() => {
				raf = 0;
				html = render(untrack(() => item.text));
			});
	});
	$effect(() => () => {
		if (raf) cancelAnimationFrame(raf);
		clearTimeout(copyTimer);
	});

	let feedback = $state<Feedback | null>(null);
	let feedbackError = $state(false);
	$effect.pre(() => {
		feedback = item.feedback ?? null;
	});

	async function rate(value: Feedback) {
		const id = item.messageId;
		if (!id) return;
		const next = feedback === value ? null : value;
		const prev = feedback;
		feedback = next;
		feedbackError = false;
		try {
			const res = await fetch(`/api/assistant/messages/${id}/feedback`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: next === 1 ? 'up' : next === -1 ? 'down' : null })
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			feedback = prev;
			feedbackError = true;
		}
	}

	const errors = $derived(item.tools.filter((t) => t.status === 'error').length);

	function statusText(t: ToolRow): string {
		if (t.status === 'running') return 'running…';
		if (t.status === 'error') return 'error';
		if (t.count !== null) return `${t.count} result${t.count === 1 ? '' : 's'}`;
		return 'done';
	}

	// #327: a code block's Copy (its own text only) and "Show all" buttons, from the rendered markup.
	async function onCodeButton(btn: Element) {
		const block = btn.closest('.md-code');
		if (!block) return;
		if (btn.hasAttribute('data-code-expand')) {
			block.classList.remove('md-code-long');
			btn.remove();
			return;
		}
		const code = block.querySelector('pre code')?.textContent ?? '';
		const label = btn.querySelector('span');
		try {
			await navigator.clipboard.writeText(code);
			if (label) {
				label.textContent = 'Copied';
				setTimeout(() => (label.textContent = 'Copy'), 1500);
			}
		} catch {
			/* clipboard blocked */
		}
	}

	// App links navigate client-side and leave the panel open; external ones open a tab.
	function onTextClick(e: MouseEvent) {
		const codeBtn = (e.target as Element | null)?.closest?.('[data-code-copy], [data-code-expand]');
		if (codeBtn) {
			e.preventDefault();
			onCodeButton(codeBtn);
			return;
		}
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const a = (e.target as Element | null)?.closest?.('a[data-app-link]');
		if (!a) return;
		const href = a.getAttribute('href');
		if (!href) return;
		e.preventDefault();
		goto(href);
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(item.text);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked */
		}
	}
</script>

{#snippet toolRow(t: ToolRow)}
	<details class="am-tool" class:error={t.status === 'error'}>
		<summary title={t.name}>
			<Icon name={t.status === 'error' ? 'alert' : 'search'} size={16} />
			<span class="am-tool-label">{toolLabel(t)}</span>
			<span class="muted">{statusText(t)}</span>
		</summary>
		<div class="am-tool-detail muted">
			<code>{t.name}</code>{#if t.summary}<br />{t.summary}{/if}{#if t.error}<br />{t.error}{/if}
		</div>
	</details>
{/snippet}

{#if item.tools.length === 1}
	{@render toolRow(item.tools[0])}
{:else if item.tools.length > 1}
	<details class="am-group" class:error={errors > 0}>
		<summary>
			<Icon name="search" size={16} />
			<span class="am-tool-label">{toolGroupLabel(item.tools)}</span>
			{#if errors}<span class="muted">{errors} error{errors === 1 ? '' : 's'}</span>{/if}
		</summary>
		<div class="am-group-list">
			{#each item.tools as t (t.id)}
				{@render toolRow(t)}
			{/each}
		</div>
	</details>
{/if}
{@render actions?.()}
{#if item.text}
	<!-- Safe: renderAssistantMarkdown escapes all raw HTML and only emits allowlisted links. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="am-text" onclick={onTextClick}>{@html html}</div>
{/if}
{#if item.streaming && !item.text && !item.tools.length}<div class="muted">Thinking…</div>{/if}
{#if item.error}<p class="am-error">{item.error}</p>{/if}
{#if !item.streaming && (item.text || item.tokens > 0)}
	<div class="am-foot muted">
		{#if item.text}
			<button type="button" class="am-copy" title="Copy the Markdown" onclick={copy}>
				<Icon name="copy" size={16} />{copied ? 'Copied' : 'Copy'}
			</button>
		{/if}
		{#if item.messageId}
			<button type="button" class="am-rate" class:on={feedback === 1} aria-pressed={feedback === 1} title="Good answer" aria-label="Good answer" onclick={() => rate(1)}>
				<Icon name="thumbs-up" size={16} />
			</button>
			<button type="button" class="am-rate" class:on={feedback === -1} aria-pressed={feedback === -1} title="Missed the mark" aria-label="Missed the mark" onclick={() => rate(-1)}>
				<Icon name="thumbs-down" size={16} />
			</button>
			{#if feedbackError}<span class="am-error">Not saved</span>{/if}
		{/if}
		{#if item.tokens > 0}<span>≈ {formatMicros(item.costMicros)} · {tokensText(item.tokens)}</span>{/if}
	</div>
{/if}

<style>
	.am-tool, .am-group { border-radius: var(--radius-s); background: var(--neutral-2); }
	.am-group .am-tool { background: transparent; }
	summary {
		display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-xxs) var(--space-xs);
		cursor: pointer; font-size: var(--size-xs); line-height: var(--line-xs);
	}
	.am-tool.error > summary, .am-group.error > summary { color: var(--danger); }
	.am-tool-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.am-group-list { padding: 0 0 var(--space-xxs) var(--space-s); }
	.am-tool-detail { padding: 0 var(--space-xs) var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); }
	.am-tool-detail code { font-family: var(--font-mono); }
	.am-error { margin: 0; color: var(--danger); }
	.am-foot { display: flex; align-items: center; gap: var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); }
	.am-copy {
		display: inline-flex; align-items: center; gap: var(--space-xxs); padding: 2px var(--space-xxs);
		background: transparent; box-shadow: none; color: var(--neutral-8); font-size: var(--size-xs); line-height: var(--line-xs);
	}
	.am-copy:hover { background: var(--neutral-3); color: var(--neutral-10); }
	.am-rate {
		display: inline-flex; align-items: center; padding: 2px var(--space-xxs);
		background: transparent; box-shadow: none; color: var(--neutral-8);
	}
	.am-rate:hover { background: var(--neutral-3); color: var(--neutral-10); }
	.am-rate.on { background: var(--neutral-3); color: var(--neutral-10); }

	/* The rendered Markdown. */
	.am-text { min-width: 0; line-height: 1.55; overflow-wrap: anywhere; }
	.am-text > :global(:first-child) { margin-top: 0; }
	.am-text > :global(:last-child) { margin-bottom: 0; }
	.am-text :global(p) { margin: 0 0 var(--space-xs); }
	.am-text :global(:is(h3, h4)) { margin: var(--space-s) 0 var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); font-weight: var(--weight-ui-medium, 600); }
	.am-text :global(h4) { font-size: var(--size-xs); line-height: var(--line-xs); color: var(--neutral-8); }
	.am-text :global(:is(ul, ol)) { margin: 0 0 var(--space-xs); padding-left: 1.25em; }
	.am-text :global(li) { margin: 0; }
	.am-text :global(li > :is(ul, ol)) { margin: 0; }
	.am-text :global(li > p) { margin: 0; }
	.am-text :global(blockquote) { margin: 0 0 var(--space-xs); padding-left: var(--space-s); box-shadow: inset var(--border-m, 2px) 0 0 var(--neutral-4); color: var(--neutral-8); }
	.am-text :global(hr) { border: 0; height: var(--border-s, 1px); background: var(--neutral-4); margin: var(--space-s) 0; }
	.am-text :global(code) { font-family: var(--font-mono); font-size: 0.92em; padding: 1px 4px; border-radius: var(--radius-s); background: var(--neutral-3); }
	.am-text :global(.md-code) { margin: 0 0 var(--space-xs); border-radius: var(--radius-s); background: var(--neutral-2); min-width: 0; }
	.am-text :global(.md-code-bar) {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-xxs) 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); color: var(--neutral-8);
	}
	.am-text :global(.md-code-lang) { font-family: var(--font-mono); }
	.am-text :global(:is(.md-code-copy, .md-code-more)) {
		display: inline-flex; align-items: center; gap: var(--space-xxs); padding: 2px var(--space-xxs);
		background: transparent; box-shadow: none; color: var(--neutral-8); font-size: var(--size-xs); line-height: var(--line-xs);
	}
	.am-text :global(:is(.md-code-copy, .md-code-more):hover) { background: var(--neutral-3); color: var(--neutral-10); }
	.am-text :global(.md-code-more) { margin: 0 var(--space-xs) var(--space-xxs); }
	.am-text :global(.md-code pre) { margin: 0; background: none; }
	.am-text :global(.md-code-long pre) { max-height: calc(30 * 1.55em); overflow-y: hidden; }
	.am-text :global(pre) { margin: 0 0 var(--space-xs); padding: var(--space-xs) var(--space-s); border-radius: var(--radius-s); background: var(--neutral-2); overflow-x: auto; }
	.am-text :global(pre code) { padding: 0; background: none; white-space: pre; overflow-wrap: normal; }
	.am-text :global(.md-table) { margin: 0 0 var(--space-xs); max-width: 100%; overflow-x: auto; border-radius: var(--radius-s); box-shadow: 0 0 0 var(--border-s, 1px) var(--neutral-4); }
	.am-text :global(table) { border-collapse: collapse; width: max-content; min-width: 100%; font-size: var(--size-xs); line-height: var(--line-xs); }
	.am-text :global(:is(th, td)) { padding: var(--space-xxs) var(--space-xs); text-align: left; vertical-align: top; overflow-wrap: normal; white-space: nowrap; }
	.am-text :global(td:first-child) { white-space: normal; min-width: 8em; max-width: 16em; }
	.am-text :global(th) { font-weight: var(--weight-ui-medium, 600); background: var(--neutral-2); }
	.am-text :global(tbody tr) { box-shadow: inset 0 var(--border-s, 1px) 0 var(--neutral-4); }
	.am-text :global(.md-right) { text-align: right; font-variant-numeric: tabular-nums; }
	.am-text :global(.md-center) { text-align: center; }
</style>

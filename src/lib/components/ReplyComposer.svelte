<script lang="ts">
	// Reply composer (#159, restyled GitHub-style in #226): Write | Preview tabs, the textarea,
	// a hint line and the primary Send reply. Posts /conversations?/reply from any page and
	// handles the result here (not via the host page's form prop). Cmd+Enter (Mac) / Ctrl+Enter sends.
	// #387: "Draft reply" asks the assistant for a draft (streamed into the textarea); the
	// person edits and sends it. Shown when Settings → Assistant allows it for this user.
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { kbd } from '$lib/platform.svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { Conversation } from '$lib/server/conversations';
	import { parseMarkdownPreservingMergeTags } from '$lib/merge-tags';
	import { SseBuffer } from '$lib/sse';
	import {
		DRAFT_QUICK,
		DRAFT_TONES,
		INSTRUCTION_MAX,
		QUICK_LABELS,
		TONE_LABELS,
		contactWritesSpanish,
		type DraftQuick,
		type DraftTone
	} from '$lib/draft-reply';

	// #714: a suggestion's "Reply" step opens the thread with the box focused and its draft
	// opening line in it (`initialBody`); nothing is sent until the person presses Send reply.
	let { conv, initialBody = '', autofocus = false }: { conv: Conversation; initialBody?: string; autofocus?: boolean } = $props();

	const canDraft = $derived(page.data.draftReply === true);
	let tone = $state<DraftTone>('friendly');
	let instruction = $state('');
	let drafting = $state(false);
	let drafted = $state(false); // a draft exists → Regenerate + quick actions
	let draftNote = $state<string | null>(null);
	let draftError = $state<string | null>(null);
	let draftAbort: AbortController | null = null;
	const spanish = $derived(contactWritesSpanish(conv.messages.filter((m) => m.dir === 'in').map((m) => m.text ?? m.snippet)));

	async function draftReply(quick: DraftQuick | null = null) {
		if (drafting) return;
		if (!quick && body.trim() && !drafted && !confirm('Replace what you wrote with a draft?')) return;
		const current = body;
		drafting = true;
		draftError = null;
		draftNote = null;
		sent = false;
		tab = 'write';
		draftAbort = new AbortController();
		let got = false;
		try {
			const res = await fetch('/api/assistant/draft-reply', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conv_key: conv.key, tone, instruction, quick, draft: quick ? current : undefined }),
				signal: draftAbort.signal
			});
			if (!res.ok || !res.body) {
				let msg = `Draft failed (HTTP ${res.status}).`;
				try {
					msg = ((await res.json()) as { error?: string }).error ?? msg;
				} catch {
					/* not JSON */
				}
				draftError = msg;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			const sse = new SseBuffer();
			const handle = (data: string) => {
				let e: { type: string; text?: string; message?: string; words?: number };
				try {
					e = JSON.parse(data);
				} catch {
					return;
				}
				if (e.type === 'text' && e.text) {
					if (!got) body = '';
					got = true;
					body += e.text;
				} else if (e.type === 'done') {
					body = body.trim();
					drafted = true;
					draftNote = `Draft · ${e.words ?? 0} words. Review and edit it before sending.`;
				} else if (e.type === 'error') draftError = e.message ?? 'Draft failed.';
			};
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				for (const m of sse.push(decoder.decode(value, { stream: true }))) handle(m.data);
			}
			for (const m of sse.flush()) handle(m.data);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === 'AbortError')) draftError = 'The connection dropped.';
		} finally {
			drafting = false;
			draftAbort = null;
			if (draftError && got && !drafted) body = current; // a half draft never replaces what was there
		}
	}

	function stopDraft() {
		draftAbort?.abort();
	}

	let body = $state(untrack(() => initialBody));
	let textareaEl = $state<HTMLTextAreaElement>();
	onMount(() => {
		if (!autofocus || !textareaEl) return;
		textareaEl.scrollIntoView({ block: 'center' });
		textareaEl.focus({ preventScroll: true });
	});
	let tab = $state<'write' | 'preview'>('write');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let sent = $state(false);
	let form = $state<HTMLFormElement>();

	// Preview renders the markdown the way the email body does. Shown in a sandboxed frame
	// with no scripts, so raw HTML in the reply can't run here.
	const previewDoc = $derived(
		tab === 'preview'
			? `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:8px;color:#1f2328;background:#fff}</style></head><body>${parseMarkdownPreservingMergeTags(body)}</body></html>`
			: ''
	);

	const submit: SubmitFunction = () => {
		busy = true;
		error = null;
		sent = false;
		return async ({ result }) => {
			busy = false;
			if (result.type === 'success') {
				body = '';
				tab = 'write';
				sent = true;
				drafted = false;
				draftNote = null;
			} else if (result.type === 'failure') {
				error = String(result.data?.replyError ?? 'Send failed.');
			} else if (result.type === 'error') {
				error = result.error?.message ?? 'Send failed.';
			}
			// A sent reply (or a failed attempt) is now a message in this thread.
			if (result.type !== 'error') await invalidateAll();
		};
	};

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim() && !busy) {
			e.preventDefault();
			form?.requestSubmit();
		}
	}
</script>

<form class="composer" method="POST" action="/conversations?/reply" use:enhance={submit} bind:this={form}>
	<input type="hidden" name="conv_key" value={conv.key} />
	<input type="hidden" name="contact_id" value={conv.contact_id ?? ''} />
	<input type="hidden" name="email" value={conv.email} />
	<!-- Preview hides the textarea; keep the body in the post either way. -->
	{#if tab === 'preview'}<input type="hidden" name="body" value={body} />{/if}

	<div class="composer-head">
		<div class="tabs" role="tablist" aria-label="Reply editor">
			<button type="button" role="tab" class="tab" class:on={tab === 'write'} aria-selected={tab === 'write'} onclick={() => (tab = 'write')}>Write</button>
			<button type="button" role="tab" class="tab" class:on={tab === 'preview'} aria-selected={tab === 'preview'} onclick={() => (tab = 'preview')}>Preview</button>
		</div>
		<span class="to muted">To {conv.name || conv.email} · Re: {conv.subject}</span>
	</div>

	<div class="composer-body">
		{#if tab === 'write'}
			<label class="sr-only" for="reply-{conv.key}">Reply to {conv.name || conv.email}</label>
			<textarea
				id="reply-{conv.key}"
				name="body"
				rows="5"
				required
				placeholder="Write a reply…"
				bind:this={textareaEl}
				bind:value={body}
				disabled={busy || drafting}
				onkeydown={onKeydown}
			></textarea>
		{:else if body.trim()}
			<iframe class="preview" title="Reply preview" sandbox="" srcdoc={previewDoc}></iframe>
		{:else}
			<p class="muted nothing">Nothing to preview.</p>
		{/if}
	</div>

	{#if canDraft}
		<div class="draft" aria-label="Draft reply with the assistant">
			<div class="draft-row">
				<label class="sr-only" for="tone-{conv.key}">Tone</label>
				<select id="tone-{conv.key}" bind:value={tone} disabled={drafting}>
					{#each DRAFT_TONES as t (t)}<option value={t}>{TONE_LABELS[t]}</option>{/each}
				</select>
				<label class="sr-only" for="instr-{conv.key}">Instruction for the draft (optional)</label>
				<input
					id="instr-{conv.key}"
					class="instr"
					type="text"
					maxlength={INSTRUCTION_MAX}
					placeholder="Optional: decline politely, propose Tuesday…"
					bind:value={instruction}
					disabled={drafting}
				/>
				{#if drafting}
					<button type="button" onclick={stopDraft}>Stop</button>
				{:else}
					<button type="button" onclick={() => draftReply()} disabled={busy}>{drafted ? 'Regenerate' : 'Draft reply'}</button>
				{/if}
			</div>
			{#if drafted || (spanish && body.trim())}
				<div class="draft-row quick" role="group" aria-label="Adjust the draft">
					{#each DRAFT_QUICK as q (q)}
						{#if q !== 'spanish' || spanish || drafted}
							<button type="button" class="chip" class:offer={q === 'spanish' && spanish} onclick={() => draftReply(q)} disabled={drafting || busy || !body.trim()}>
								{QUICK_LABELS[q]}
							</button>
						{/if}
					{/each}
				</div>
			{/if}
			<p class="small" aria-live="polite">
				{#if drafting}<span class="muted">Drafting…</span>
				{:else if draftError}<span class="err" role="alert">{draftError}</span>
				{:else if draftNote}<span class="muted">{draftNote}</span>
				{:else if spanish}<span class="muted">They write in Spanish: draft, then Translate to Spanish.</span>{/if}
			</p>
		</div>
	{/if}

	<div class="composer-foot">
		<span class="hint muted">Markdown or plain text · sent from your default From address · {kbd('Mod+Enter')} to send</span>
		<span class="status">
			{#if error}<span class="err" role="alert">{error}</span>{/if}
			{#if sent}<span class="muted" role="status">Reply sent.</span>{/if}
		</span>
		<button type="submit" class="primary" disabled={busy || drafting || !body.trim()}>{busy ? 'Sending…' : 'Send reply'}</button>
	</div>
</form>

<style>
	.composer {
		border: 0; border-radius: var(--radius-m); background: var(--surface);
		box-shadow: var(--border-shadow-s), var(--shadow-s);
	}
	.composer-head {
		display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-xs) var(--space-m);
		padding: var(--space-xs);
	}
	/* Tabs: the theme's segmented list (neutral-3 track, selected tab raised on neutral-1). */
	.tabs {
		display: flex; gap: var(--space-xxs); padding: var(--space-xxs);
		background: var(--neutral-3); border-radius: var(--radius-m);
	}
	.tab {
		background: var(--color-none); border: 0; border-radius: var(--radius-s);
		padding: var(--space-xxs) var(--space-s); color: var(--neutral-7); cursor: pointer; box-shadow: none;
	}
	.tab:hover { color: var(--neutral-10); background: var(--color-none); box-shadow: none; }
	.tab:focus-visible { box-shadow: var(--focus-halo); }
	.tab.on { background: var(--neutral-1); color: var(--neutral-10); box-shadow: var(--shadow-s); }
	.to {
		font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xs);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
	}
	.composer-body { padding: 0 var(--space-xs) var(--space-xs); }
	textarea { display: block; width: 100%; min-height: 120px; resize: vertical; }
	/* Preview renders the email itself (white email canvas), not app chrome. */
	.preview {
		display: block; width: 100%; height: 200px; border: 0; border-radius: var(--radius-s); background: #fff;
		box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
	}
	.nothing { margin: var(--space-xs) 0; font-size: var(--size-s); line-height: var(--line-s); }
	.composer-foot {
		display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-m);
		padding: 0 var(--space-xs) var(--space-xs);
	}
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); flex: 1 1 16rem; }
	.status { font-size: var(--size-s); line-height: var(--line-s); }
	.err { color: var(--error); }
	/* #387: Draft reply row — tone, instruction, button; quick actions under it. */
	.draft { padding: 0 var(--space-xs) var(--space-xs); display: grid; gap: var(--space-xxs); }
	.draft-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	.instr { flex: 1 1 14rem; min-width: 0; }
	.chip { font-size: var(--size-xs); line-height: var(--line-xs); padding: var(--space-xxs) var(--space-s); }
	.chip.offer { box-shadow: 0 0 0 var(--border-s) var(--btn-primary-bg); }
	.small { margin: 0; font-size: var(--size-xs); line-height: var(--line-xs); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

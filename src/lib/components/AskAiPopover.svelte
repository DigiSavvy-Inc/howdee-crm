<script lang="ts">
	// Ask AI in the editor (#679). Mounted once in the root layout (for people the layout's
	// `editorAsk` lets in); every BlockEditor's Ask AI button / shortcut opens it through
	// `registerAskAi` ($lib/editor-host). It sends the held selection, the document and the
	// request to POST /api/assistant/editor, previews the streamed result as the blocks it
	// will become, and only Replace / Insert below change the document (one undo step each,
	// through the editor's host-action session). Escape, Discard or a click outside leave the
	// document untouched. Escape is caught on the window (capture phase) while it is open, so it
	// works wherever focus is and never also reaches the editor (Write mode stays on).
	import { onMount, tick } from 'svelte';
	import { sanitizeBlocks, sanitizeInline, renderInlineHtml, type Block, type Inline } from '$lib/blocks';
	import { SseBuffer } from '$lib/sse';
	import { registerAskAi, type AskAiOpen } from '$lib/editor-host';
	import {
		ASK_QUICK,
		LANGUAGE_MAX,
		PROMPT_MAX,
		QUICK_GROUP_LABELS,
		TRANSLATE_LANGUAGES,
		WRITE_STARTERS,
		hasContentBefore,
		quickLabel,
		readPartialResult,
		starterLabel,
		starterPrompt,
		type AskEvent,
		type AskQuick,
		type AskResult,
		type QuickGroup
	} from '$lib/editor-ask';
	import Icon from '$lib/components/Icon.svelte';

	// #680: the slash menu's Ask AI opens it in write mode (no selection): a prompt and the
	// WRITE_STARTERS instead of the quick actions, and one Insert (the caret's empty line becomes
	// the blocks, one undo step) instead of Replace / Insert below.
	type Req = { quick: AskQuick | null; language: string; prompt: string; title?: string };

	let session = $state.raw<AskAiOpen | null>(null);
	let view = $state<'ask' | 'result'>('ask');
	let prompt = $state('');
	let refine = $state('');
	let otherLanguage = $state('');
	let otherOpen = $state(false);
	let busy = $state(false);
	let streamJson = '';
	let preview = $state.raw<{ inline?: Inline[]; blocks?: Block[] } | null>(null);
	let result = $state.raw<AskResult | null>(null);
	let notes = $state<string[]>([]);
	let error = $state('');
	let canRetry = $state(false);
	let lastReq = $state.raw<Req | null>(null);
	let abort: AbortController | null = null;
	let rootEl = $state<HTMLDivElement | null>(null);
	let promptEl = $state<HTMLInputElement | null>(null);
	let refineEl = $state<HTMLInputElement | null>(null);
	let vw = $state(1024);
	let vh = $state(768);

	const groups = (['edit', 'tone', 'turn'] as QuickGroup[]).map((g) => ({ g, label: QUICK_GROUP_LABELS[g], items: ASK_QUICK.filter((q) => q.group === g) }));

	const writing = $derived(session?.mode === 'write');
	/** Write mode: is there content above the cursor (for Continue writing / Summarise)? */
	const hasAbove = $derived.by(() => {
		if (!session || session.mode !== 'write') return false;
		return hasContentBefore(session.ctx.document, session.cursor);
	});

	// Below the selection, or above it when there's no room; clamped into the viewport.
	const pos = $derived.by(() => {
		if (!session) return '';
		const width = Math.min(440, vw - 16);
		const left = Math.max(8, Math.min(session.place.left, vw - width - 8));
		const below = vh - session.place.top;
		if (below < 280 && session.place.selTop > below) return `left:${left}px;bottom:${Math.max(8, vh - session.place.selTop + 8)}px;width:${width}px`;
		return `left:${left}px;top:${Math.max(8, session.place.top + 8)}px;width:${width}px`;
	});

	function reset() {
		view = 'ask';
		prompt = '';
		refine = '';
		otherOpen = false;
		otherLanguage = '';
		busy = false;
		streamJson = '';
		preview = null;
		result = null;
		notes = [];
		error = '';
		canRetry = false;
		lastReq = null;
	}

	async function open(o: AskAiOpen) {
		abort?.abort();
		session?.ctx.close();
		reset();
		vw = window.innerWidth;
		vh = window.innerHeight;
		session = o;
		await tick();
		promptEl?.focus();
	}

	onMount(() => registerAskAi(open));

	// While open: Escape closes it (or the "Other…" language field first), whatever has focus.
	$effect(() => {
		if (!session) return;
		const onKeyCapture = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.isComposing) return;
			e.preventDefault();
			e.stopPropagation();
			if (otherOpen) {
				otherOpen = false;
				void keepFocus();
			} else close();
		};
		window.addEventListener('keydown', onKeyCapture, true);
		return () => window.removeEventListener('keydown', onKeyCapture, true);
	});

	/** A view change can remove the focused button (focus falls to <body>): keep it in here. */
	async function keepFocus() {
		await tick();
		if (session && rootEl && !rootEl.contains(document.activeElement)) rootEl.focus();
	}

	/** Close; `focusEditor` puts the cursor back on the (unchanged) selection. */
	function close(focusEditor = true) {
		abort?.abort();
		abort = null;
		const s = session;
		session = null;
		if (!s) return;
		if (focusEditor) s.ctx.restoreFocus();
		else s.ctx.close();
	}

	function partialPreview(json: string) {
		const p = readPartialResult(json);
		if (!p) return;
		if (p.blocks) preview = { blocks: sanitizeBlocks(p.blocks, { allowContent: false }) };
		else if (p.inline) preview = { inline: sanitizeInline(p.inline) };
	}

	async function run(req: Req, previous: AskResult | null = null, refineText = '') {
		const s = session;
		if (!s) return;
		abort?.abort();
		const ac = new AbortController();
		abort = ac;
		if (!previous) lastReq = req;
		view = 'result';
		void keepFocus();
		busy = true;
		error = '';
		canRetry = false;
		notes = [];
		streamJson = '';
		preview = previous ? preview : null;
		result = null;
		const body =
			s.mode === 'write'
				? {
						mode: 'write',
						target: s.target,
						selection: { text: '', inline: null, blocks: [], partial: false },
						document: s.ctx.document,
						cursor: s.cursor,
						subject: s.subject,
						prompt: req.prompt,
						previous,
						refine: refineText
					}
				: {
						target: s.target,
						selection: s.ctx.selection,
						document: s.ctx.document,
						quick: req.quick,
						language: req.language,
						prompt: req.prompt,
						previous,
						refine: refineText
					};
		try {
			const res = await fetch('/api/assistant/editor', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: ac.signal
			});
			if (!res.ok || !res.body) {
				let msg = "Ask AI couldn't start.";
				try {
					msg = ((await res.json()) as { error?: string }).error || msg;
				} catch {
					/* not JSON */
				}
				error = msg;
				canRetry = res.status >= 500 && res.status !== 503;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			const sse = new SseBuffer();
			let frame = 0;
			const handle = (e: AskEvent) => {
				if (e.type === 'text') {
					streamJson += e.text;
					if (!frame)
						frame = requestAnimationFrame(() => {
							frame = 0;
							if (!result) partialPreview(streamJson);
						});
				} else if (e.type === 'done') {
					result = e.result;
					notes = e.notes;
					preview = e.result.shape === 'inline' ? { inline: e.result.inline } : { blocks: e.result.blocks };
				} else if (e.type === 'error') {
					error = e.message;
					canRetry = true;
					preview = null;
				}
			};
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				for (const m of sse.push(decoder.decode(value, { stream: true }))) {
					try {
						handle(JSON.parse(m.data) as AskEvent);
					} catch {
						/* skip a malformed event */
					}
				}
			}
			for (const m of sse.flush()) {
				try {
					handle(JSON.parse(m.data) as AskEvent);
				} catch {
					/* skip */
				}
			}
			if (!result && !error) {
				error = 'Ask AI stopped before it finished. Try again.';
				canRetry = true;
			}
		} catch {
			if (ac.signal.aborted) {
				if (session && abort === ac && !result) {
					error = 'Stopped.';
					canRetry = true;
				}
			} else {
				error = "Couldn't reach the server. Check your connection and try again.";
				canRetry = true;
			}
		} finally {
			const current = abort === ac;
			if (current) {
				busy = false;
				abort = null;
			}
			if (result) {
				await tick();
				refineEl?.focus();
			} else if (current) await keepFocus(); // e.g. Stop was focused and is gone
		}
	}

	function quick(q: AskQuick) {
		run({ quick: q, language: '', prompt: '' });
	}

	function translate(language: string) {
		const l = language.trim().slice(0, LANGUAGE_MAX);
		if (l) run({ quick: 'translate', language: l, prompt: '' });
	}

	function ask() {
		const p = prompt.trim();
		if (p) run({ quick: null, language: '', prompt: p });
	}

	/** #680: a write starter sends its fixed request (titled with the starter's label). */
	function starter(s: (typeof WRITE_STARTERS)[number]) {
		const t = session?.target ?? 'email';
		run({ quick: null, language: '', prompt: starterPrompt(s, t), title: starterLabel(s, t) });
	}

	function retry() {
		if (lastReq) run(lastReq);
	}

	function doRefine() {
		const r = refine.trim();
		if (!r || !result) return;
		const prev = result;
		refine = '';
		run(lastReq ?? { quick: null, language: '', prompt: '' }, prev, r);
	}

	function asBlocks(r: AskResult): Block[] {
		return r.shape === 'blocks' ? r.blocks : [{ id: crypto.randomUUID(), type: 'paragraph', content: r.inline }];
	}

	/** Replace / Insert below (edit mode); in write mode Insert = the caret's empty line becomes
	 *  the blocks (`replaceSelection` on the empty range, one undo step). */
	function apply(how: 'replace' | 'insert') {
		const s = session;
		if (!s || !result) return;
		const ok =
			s.mode === 'write'
				? s.ctx.replaceSelection(asBlocks(result))
				: how === 'replace'
					? s.ctx.replaceSelection(result.shape === 'inline' ? result.inline : result.blocks)
					: s.ctx.insertAfterSelection(asBlocks(result));
		if (!ok) {
			error =
				s.mode === 'write'
					? 'That line changed in the editor, so the result has nowhere to go. Close this and type / on an empty line again.'
					: 'The selection changed in the editor, so the result has nowhere to go. Close this and select the text again.';
			canRetry = false;
			return;
		}
		session = null;
		s.ctx.restoreFocus();
	}

	function onWindowPointer(e: PointerEvent) {
		if (session && rootEl && e.target instanceof Node && !rootEl.contains(e.target)) close(false);
	}

	function onResize() {
		vw = window.innerWidth;
		vh = window.innerHeight;
	}
</script>

<svelte:window onpointerdown={onWindowPointer} onresize={onResize} />

{#snippet inl(runs: Inline[])}{@html renderInlineHtml(runs, '')}{/snippet}

{#snippet blockList(blocks: Block[], final: boolean)}
	<!-- Keyed by position: streamed (unvalidated) blocks may repeat an id. -->
	{#each blocks as b, bi (bi)}
		{#if b.type === 'heading'}
			{#if b.level === 1}<h3 class="aa-h1">{#if b.content}{@render inl(b.content)}{:else}{b.text}{/if}</h3>
			{:else if b.level === 2}<h4 class="aa-h2">{#if b.content}{@render inl(b.content)}{:else}{b.text}{/if}</h4>
			{:else}<h5 class="aa-h3">{#if b.content}{@render inl(b.content)}{:else}{b.text}{/if}</h5>{/if}
		{:else if b.type === 'paragraph'}
			<p>{@render inl(b.content)}</p>
		{:else if b.type === 'eyebrow'}
			<p class="aa-eyebrow">{@render inl(b.content)}</p>
		{:else if b.type === 'quote'}
			<blockquote>{@render inl(b.content)}</blockquote>
		{:else if b.type === 'callout'}
			<div class="aa-callout">{@render inl(b.content)}</div>
		{:else if b.type === 'list'}
			{#if b.ordered}<ol>{#each b.items as it, i (i)}<li>{@render inl(it)}</li>{/each}</ol>
			{:else}<ul>{#each b.items as it, i (i)}<li>{@render inl(it)}</li>{/each}</ul>{/if}
		{:else if b.type === 'button'}
			<p class="aa-btn-row" style="text-align:{b.align}"><span class="aa-btn">{b.label || 'Button'}</span>{#if !b.href}<span class="aa-muted"> · no link yet</span>{/if}</p>
		{:else if b.type === 'image'}
			{#if final && b.src}<img src={b.src} alt={b.alt} />{:else}<p class="aa-muted">[image{b.alt ? `: ${b.alt}` : ''}]</p>{/if}
		{:else if b.type === 'divider'}
			<hr />
		{:else if b.type === 'spacer'}
			<div class="aa-spacer"></div>
		{:else if b.type === 'milestones'}
			<div class="aa-miles">{#each b.items as m, i (i)}<div><strong>{@render inl(m.title)}</strong><span>{@render inl(m.label)}</span></div>{/each}</div>
		{:else if b.type === 'section'}
			<div class="aa-section" style="background:{b.bg};{b.color ? `color:${b.color}` : ''}">{@render blockList(b.blocks, final)}</div>
		{:else if b.type === 'columns'}
			<div class="aa-cols">{#each b.cells as c, i (i)}<div>{@render blockList(c, final)}</div>{/each}</div>
		{/if}
	{/each}
{/snippet}

{#if session}
	<div class="aa ds-ask-ai" role="dialog" aria-label="Ask AI" tabindex="-1" style={pos} bind:this={rootEl}>
		{#if view === 'ask' && writing}
			<form
				class="aa-ask"
				onsubmit={(e) => {
					e.preventDefault();
					ask();
				}}
			>
				<Icon name="sparkle" size={16} />
				<input bind:this={promptEl} bind:value={prompt} maxlength={PROMPT_MAX} placeholder="Ask AI to write…" aria-label="Ask AI to write" />
				<button type="submit" class="aa-go" disabled={!prompt.trim()}>Write</button>
			</form>
			<div class="aa-quick">
				<div class="aa-group" role="group" aria-label="Starters">
					<span class="aa-glabel">Start from</span>
					{#each WRITE_STARTERS as s (s.id)}
						<button
							type="button"
							class="secondary chip"
							disabled={s.needsAbove && !hasAbove}
							title={s.needsAbove && !hasAbove ? 'Needs content above the cursor' : undefined}
							onclick={() => starter(s)}>{starterLabel(s, session.target)}</button
						>
					{/each}
				</div>
			</div>
		{:else if view === 'ask'}
			<form
				class="aa-ask"
				onsubmit={(e) => {
					e.preventDefault();
					ask();
				}}
			>
				<Icon name="sparkle" size={16} />
				<input bind:this={promptEl} bind:value={prompt} maxlength={PROMPT_MAX} placeholder="Ask AI to edit this…" aria-label="Ask AI to edit this" />
				<button type="submit" class="aa-go" disabled={!prompt.trim()}>Ask</button>
			</form>
			<div class="aa-quick">
				{#each groups as grp (grp.g)}
					<div class="aa-group" role="group" aria-label={grp.label}>
						<span class="aa-glabel">{grp.label}</span>
						{#each grp.items as q (q.id)}
							<button type="button" class="secondary chip" onclick={() => quick(q.id)}>{q.label}</button>
						{/each}
					</div>
				{/each}
				<div class="aa-group" role="group" aria-label="Translate">
					<span class="aa-glabel">Translate</span>
					{#each TRANSLATE_LANGUAGES as l (l)}
						<button type="button" class="secondary chip" onclick={() => translate(l)}>{l}</button>
					{/each}
					{#if otherOpen}
						<form
							class="aa-other"
							onsubmit={(e) => {
								e.preventDefault();
								translate(otherLanguage);
							}}
						>
							<!-- svelte-ignore a11y_autofocus -->
							<input bind:value={otherLanguage} maxlength={LANGUAGE_MAX} placeholder="Language" aria-label="Language to translate into" autofocus />
							<button type="submit" class="secondary chip" disabled={!otherLanguage.trim()}>Translate</button>
						</form>
					{:else}
						<button type="button" class="secondary chip" onclick={() => (otherOpen = true)}>Other…</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="aa-head">
				<Icon name="sparkle" size={16} />
				<span class="aa-title">{lastReq?.title ?? (lastReq?.quick ? (lastReq.quick === 'translate' ? `Translate into ${lastReq.language}` : quickLabel(lastReq.quick)) : 'Ask AI')}</span>
				{#if busy}<span class="aa-muted" role="status">Writing…</span>{/if}
			</div>
			{#if notes.length}
				<ul class="aa-notes" role="status">
					{#each notes as n, i (i)}<li>{n}</li>{/each}
				</ul>
			{/if}
			{#if error}
				<p class="notice err" role="alert">{error}</p>
			{/if}
			{#if preview}
				<div class="aa-preview" class:streaming={busy && !result} aria-live="polite" aria-busy={busy}>
					{#if preview.inline}
						<p>{@render inl(preview.inline)}</p>
					{:else if preview.blocks}
						{@render blockList(preview.blocks, !!result)}
					{/if}
				</div>
			{:else if busy}
				<div class="aa-preview aa-muted">…</div>
			{/if}
			<div class="aa-actions">
				{#if busy}
					<button type="button" class="secondary" onclick={() => abort?.abort()}>Stop</button>
				{:else}
					{#if result && writing}
						<button type="button" onclick={() => apply('insert')}>Insert</button>
					{:else if result}
						<button type="button" onclick={() => apply('replace')}>Replace</button>
						<button type="button" class="secondary" onclick={() => apply('insert')}>Insert below</button>
					{/if}
					{#if lastReq && (result || canRetry)}
						<button type="button" class="secondary" onclick={retry}>Try again</button>
					{/if}
				{/if}
				<button type="button" class="secondary" onclick={() => close()}>Discard</button>
			</div>
			{#if result && !busy}
				<form
					class="aa-ask aa-refine"
					onsubmit={(e) => {
						e.preventDefault();
						doRefine();
					}}
				>
					<input bind:this={refineEl} bind:value={refine} maxlength={PROMPT_MAX} placeholder="Tell AI what to change…" aria-label="Refine the result" />
					<button type="submit" class="aa-go" disabled={!refine.trim()}>Refine</button>
				</form>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.aa {
		position: fixed;
		z-index: 1200;
		display: flex;
		flex-direction: column;
		gap: var(--space-s, 8px);
		max-height: min(70vh, 560px);
		overflow: auto;
		padding: 12px;
		border-radius: var(--radius, 8px);
		background: var(--surface, #fff);
		color: var(--text, inherit);
		box-shadow: 0 0 0 1px var(--border, #d0d7de), 0 8px 24px rgba(0, 0, 0, 0.16);
		font-size: 14px;
	}
	.aa:focus {
		outline: none;
	}
	.aa-ask {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.aa-ask input {
		flex: 1;
		min-width: 0;
	}
	.aa-quick {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.aa-group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.aa-glabel {
		width: 100%;
		font-size: 12px;
		color: var(--muted, #57606a);
	}
	.chip {
		font-size: var(--size-xs, 12px);
		line-height: var(--line-xs, 1.4);
		padding: var(--space-xxs, 2px) var(--space-s, 8px);
	}
	.aa-other {
		display: inline-flex;
		gap: 4px;
	}
	.aa-other input {
		width: 9rem;
	}
	.aa-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.aa-title {
		font-weight: 600;
		flex: 1;
	}
	.aa-muted {
		color: var(--muted, #57606a);
		font-size: 13px;
	}
	.aa-notes {
		margin: 0;
		padding: 6px 10px 6px 24px;
		border-radius: var(--radius, 8px);
		background: var(--warn-bg, #fff8c5);
		font-size: 13px;
	}
	.aa-preview {
		max-height: 300px;
		overflow: auto;
		padding: 10px 12px;
		border-radius: var(--radius, 8px);
		box-shadow: inset 0 0 0 1px var(--border, #d0d7de);
		line-height: 1.5;
	}
	.aa-preview.streaming {
		opacity: 0.75;
	}
	.aa-preview :global(a) {
		pointer-events: none;
		color: inherit;
		text-decoration: underline;
	}
	.aa-preview > :first-child {
		margin-top: 0;
	}
	.aa-preview > :last-child {
		margin-bottom: 0;
	}
	.aa-preview p,
	.aa-preview ul,
	.aa-preview ol,
	.aa-preview blockquote {
		margin: 0 0 8px;
	}
	.aa-h1 {
		font-size: 20px;
		margin: 0 0 8px;
	}
	.aa-h2 {
		font-size: 17px;
		margin: 0 0 8px;
	}
	.aa-h3 {
		font-size: 15px;
		margin: 0 0 8px;
	}
	.aa-eyebrow {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.aa-preview blockquote {
		padding-left: 10px;
		box-shadow: inset 3px 0 0 var(--border, #d0d7de);
	}
	.aa-callout {
		padding: 8px 10px;
		margin: 0 0 8px;
		border-radius: var(--radius, 8px);
		background: var(--bg-subtle, #f6f8fa);
	}
	.aa-btn {
		display: inline-block;
		padding: 6px 14px;
		border-radius: 6px;
		background: var(--btn-primary-bg, #147793);
		color: var(--btn-primary-text, #fff);
		font-weight: 600;
	}
	.aa-preview img {
		max-width: 100%;
		height: auto;
	}
	.aa-spacer {
		height: 12px;
	}
	.aa-miles {
		display: flex;
		gap: 12px;
		margin: 0 0 8px;
	}
	.aa-miles > div {
		display: flex;
		flex-direction: column;
	}
	.aa-section {
		padding: 10px;
		margin: 0 0 8px;
		border-radius: 6px;
	}
	.aa-cols {
		display: grid;
		grid-auto-columns: 1fr;
		grid-auto-flow: column;
		gap: 10px;
	}
	.aa-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.aa-refine {
		padding-top: 4px;
	}
	@media (max-width: 600px) {
		/* Phones: a bottom sheet across the screen. */
		.aa {
			left: 0 !important;
			right: 0;
			top: auto !important;
			bottom: 0 !important;
			width: auto !important;
			max-height: 75vh;
			border-radius: var(--radius, 8px) var(--radius, 8px) 0 0;
		}
	}
	@media (prefers-reduced-motion: no-preference) {
		.aa-preview.streaming {
			transition: opacity 150ms;
		}
	}
</style>

<script lang="ts">
	import { page } from '$app/state';
	import { browser } from '$app/env';
	import { tick, untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import AssistantMessage from '$lib/components/AssistantMessage.svelte';
	import { EFFORT_LABELS, formatMicros, type Effort } from '$lib/ai-models';
	import { SseBuffer } from '$lib/sse';
	import {
		EXAMPLE_PROMPTS,
		applyEvent,
		contextLabel,
		threadToItems,
		type ChatItem,
		type StoredMessage,
		type StreamEvent
	} from '$lib/assistant-view';
	import { ASSISTANT_WIDTH_KEY, assistant, assistantSelection, clampAssistantWidth, noteDraftUpdate } from '$lib/assistant.svelte';
	import AssistantActionCard from '$lib/components/AssistantActionCard.svelte';
	import { canUndo, draftIdOf, selectionLabel, upsertAction, type ActionCard } from '$lib/assistant-actions';

	// The in-app assistant (#287): a right drawer on desktop (380–640px, drag the left edge),
	// a full-screen sheet at ≤ 768px. Mounted once in the root layout, so a conversation
	// survives client-side navigation. #301: writes show as action cards (Undo, or Approve /
	// Cancel for a bulk change, which resumes the turn).

	type ModelOption = { id: string; label: string; efforts: Effort[] };
	type Status = {
		available: boolean;
		reason?: 'no_key' | 'disabled' | 'not_allowed';
		message?: string;
		models: ModelOption[];
		defaultModel: string;
		defaultEffort: Effort;
	};
	type ThreadSummary = { id: number; title: string; model: string; effort: string | null; updated_at: string; cost_micros: number };

	let status = $state<Status | null>(null);
	let statusError = $state('');
	let threadId = $state<number | null>(null);
	let threadCost = $state(0);
	let items = $state<ChatItem[]>([]);
	let model = $state('');
	let effort = $state<Effort>('medium');
	let input = $state('');
	let busy = $state(false);
	let showHistory = $state(false);
	let threads = $state<ThreadSummary[]>([]);
	let includeContext = $state(true);
	let width = $state(420);
	let controller: AbortController | null = null;
	let listEl = $state<HTMLElement | null>(null);
	let inputEl = $state<HTMLTextAreaElement | null>(null);

	const modelOpt = $derived(status?.models.find((m) => m.id === model) ?? null);
	const efforts = $derived(modelOpt?.efforts ?? []);
	// #309: on /compose?draft=<id> the draft id rides along as params.draft_id.
	const pageParams = $derived.by(() => {
		const params = { ...(page.params as Record<string, string>) };
		const draft = page.url.pathname === '/compose' ? page.url.searchParams.get('draft') : null;
		if (draft && /^\d+$/.test(draft)) params.draft_id = draft;
		return params;
	});
	const ctxLabel = $derived(
		assistantSelection.ids.length ? selectionLabel(assistantSelection.ids.length) : contextLabel(page.route.id, pageParams)
	);

	/** #309: a draft write (or its Undo) landed — tell the composer / campaign page. */
	function cardChanged(card: ActionCard) {
		if (canUndo(card) || card.status === 'undone') noteDraftUpdate(draftIdOf(card));
	}
	let cardBusy = $state<number | null>(null);
	let cardErrors = $state<Record<number, string>>({});

	if (browser) width = clampAssistantWidth(Number(localStorage.getItem(ASSISTANT_WIDTH_KEY)) || 420);

	async function loadStatus() {
		statusError = '';
		try {
			const res = await fetch('/api/assistant/status');
			if (!res.ok) throw new Error(String(res.status));
			const s = (await res.json()) as Status;
			status = s;
			if (!model || !s.models.some((m) => m.id === model)) model = s.defaultModel;
			if (!threadId) effort = s.defaultEffort;
		} catch {
			statusError = "Couldn't reach the assistant.";
		}
	}

	$effect(() => {
		if (!assistant.open) return;
		untrack(() => {
			loadStatus();
			tick().then(() => inputEl?.focus());
		});
	});

	async function scrollDown() {
		await tick();
		listEl?.scrollTo({ top: listEl.scrollHeight });
	}

	function newConversation() {
		if (busy) return;
		threadId = null;
		threadCost = 0;
		items = [];
		showHistory = false;
		if (status) {
			model = status.defaultModel;
			effort = status.defaultEffort;
		}
		inputEl?.focus();
	}

	async function openHistory() {
		showHistory = !showHistory;
		if (!showHistory) return;
		const res = await fetch('/api/assistant/threads');
		threads = res.ok ? ((await res.json()) as { threads: ThreadSummary[] }).threads : [];
	}

	async function openThread(id: number) {
		if (busy) return;
		const res = await fetch(`/api/assistant/threads/${id}`);
		if (!res.ok) return;
		const body = (await res.json()) as {
			thread: { id: number; model: string; effort: string | null; cost_micros: number };
			messages: StoredMessage[];
			actions?: ActionCard[];
		};
		threadId = body.thread.id;
		threadCost = body.thread.cost_micros;
		items = threadToItems(body.messages, body.actions ?? []);
		if (status?.models.some((m) => m.id === body.thread.model)) model = body.thread.model;
		if (body.thread.effort) effort = body.thread.effort as Effort;
		showHistory = false;
		scrollDown();
	}

	function sendExample(text: string) {
		input = text;
		send();
	}

	async function send() {
		const message = input.trim();
		if (!message || busy || !status?.available) return;
		input = '';
		items.push({ kind: 'user', text: message });
		items.push({ kind: 'assistant', text: '', tools: [], costMicros: 0, tokens: 0, streaming: true });
		const current = items[items.length - 1] as Extract<ChatItem, { kind: 'assistant' }>;
		await runStream(
			'/api/assistant/chat',
			{
				thread_id: threadId,
				message,
				model,
				effort: efforts.includes(effort) ? effort : null,
				page: includeContext
					? { route: page.url.pathname, params: pageParams, ...(assistantSelection.ids.length ? { selected: assistantSelection.ids } : {}) }
					: null
			},
			current
		);
	}

	/** #301: Approve / Cancel a paused write — the turn resumes as a new streamed reply. */
	async function resume(id: number, op: 'approve' | 'cancel') {
		if (busy) return;
		items.push({ kind: 'assistant', text: '', tools: [], costMicros: 0, tokens: 0, streaming: true });
		const current = items[items.length - 1] as Extract<ChatItem, { kind: 'assistant' }>;
		await runStream(`/api/assistant/actions/${id}`, { op }, current);
	}

	/** #301: Undo a write. A refusal (the record changed since) shows on the card. */
	async function undo(id: number) {
		if (cardBusy !== null) return;
		cardBusy = id;
		cardErrors = { ...cardErrors, [id]: '' };
		try {
			const res = await fetch(`/api/assistant/actions/${id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'undo' })
			});
			const body = (await res.json().catch(() => ({}))) as { action?: ActionCard; error?: string };
			if (body.action) {
				upsertAction(items, null, body.action);
				cardChanged(body.action);
			}
			if (!res.ok) cardErrors = { ...cardErrors, [id]: body.error ?? `Undo failed (HTTP ${res.status}).` };
		} catch {
			cardErrors = { ...cardErrors, [id]: 'The connection dropped.' };
		} finally {
			cardBusy = null;
		}
	}

	async function runStream(url: string, payload: unknown, current: Extract<ChatItem, { kind: 'assistant' }>) {
		busy = true;
		scrollDown();
		controller = new AbortController();
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal
			});
			if (!res.ok || !res.body) {
				let msg = `The assistant answered HTTP ${res.status}.`;
				try {
					const b = (await res.json()) as { error?: string; action?: ActionCard };
					msg = b.error ?? msg;
					if (b.action) upsertAction(items, null, b.action);
				} catch {
					/* not JSON */
				}
				current.error = msg;
				current.streaming = false;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			const sse = new SseBuffer();
			const handle = (data: string) => {
				let e: StreamEvent;
				try {
					e = JSON.parse(data) as StreamEvent;
				} catch {
					return;
				}
				if (e.type === 'thread') threadId = e.id;
				else if (e.type === 'action' || e.type === 'pending') {
					upsertAction(items, current, e.action);
					cardChanged(e.action);
				}
				else applyEvent(current, e);
				if (e.type === 'usage') threadCost += e.costMicros;
			};
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				for (const m of sse.push(decoder.decode(value, { stream: true }))) handle(m.data);
				scrollDown();
			}
			for (const m of sse.flush()) handle(m.data);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === 'AbortError')) current.error = 'The connection dropped.';
		} finally {
			applyEvent(current, { type: 'done', stopReason: 'end_turn' });
			busy = false;
			controller = null;
			scrollDown();
		}
	}

	function stop() {
		controller?.abort();
	}

	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	}

	function onPanelKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			if (busy) stop();
			else assistant.open = false;
		}
	}

	// Resize from the left edge (desktop only), saved per browser.
	function startResize(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => (width = clampAssistantWidth(window.innerWidth - ev.clientX));
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			localStorage.setItem(ASSISTANT_WIDTH_KEY, String(width));
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
	}
	function resizeKey(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		width = clampAssistantWidth(width + (e.key === 'ArrowLeft' ? 20 : -20));
		localStorage.setItem(ASSISTANT_WIDTH_KEY, String(width));
	}
</script>

{#if assistant.open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<aside class="ap" style:--ap-width="{width}px" aria-label="Assistant" onkeydown={onPanelKey}>
		<!-- A focusable separator with aria-valuenow is the ARIA window-splitter pattern. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="ap-resize"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize assistant"
			aria-valuemin={380}
			aria-valuemax={640}
			aria-valuenow={width}
			tabindex="0"
			onpointerdown={startResize}
			onkeydown={resizeKey}
		></div>
		<header class="ap-head">
			<span class="ap-title"><Icon name="sparkle" size={16} />Assistant</span>
			<div class="ap-head-actions">
				<button type="button" class="ap-icon" title="Conversation history" aria-pressed={showHistory} onclick={openHistory}>
					<Icon name="list" size={16} label="Conversation history" />
				</button>
				<button type="button" class="ap-icon" title="New conversation" disabled={busy} onclick={newConversation}>
					<Icon name="add" size={16} label="New conversation" />
				</button>
				<button type="button" class="ap-icon" title="Close (Esc)" onclick={() => (assistant.open = false)}>
					<Icon name="close" size={16} label="Close assistant" />
				</button>
			</div>
		</header>

		{#if status?.available}
			<div class="ap-controls">
				<label>
					<span class="sr-only">Model</span>
					<select bind:value={model} disabled={busy}>
						{#each status.models as m (m.id)}
							<option value={m.id}>{m.label}</option>
						{/each}
					</select>
				</label>
				{#if efforts.length}
					<label>
						<span class="sr-only">Effort</span>
						<select bind:value={effort} disabled={busy}>
							{#each efforts as e (e)}
								<option value={e}>{EFFORT_LABELS[e]} effort</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if threadCost > 0}<span class="ap-total" title="This conversation so far">≈ {formatMicros(threadCost)}</span>{/if}
			</div>
		{/if}

		{#if showHistory}
			<div class="ap-history">
				{#if threads.length === 0}
					<p class="muted">No conversations yet.</p>
				{:else}
					<ul>
						{#each threads as t (t.id)}
							<li>
								<button type="button" class:current={t.id === threadId} onclick={() => openThread(t.id)}>
									<span class="ap-h-title">{t.title || 'Untitled'}</span>
									<span class="muted">{t.updated_at.slice(0, 16)} UTC · {formatMicros(t.cost_micros)}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		<div class="ap-body" bind:this={listEl}>
			{#if statusError}
				<p class="ap-notice">{statusError}</p>
			{:else if status && !status.available}
				<div class="ap-notice">
					<strong>{status.reason === 'no_key' ? "Assistant isn't set up" : status.reason === 'not_allowed' ? 'Assistant not available' : 'Assistant is turned off'}</strong>
					<p class="muted">{status.message}</p>
				</div>
			{:else if items.length === 0}
				<div class="ap-empty muted">
					<p>Ask about your contacts, campaigns, automations, pipeline or deliverability.</p>
					<p>It works as you: it can tag, update fields, build segments and move pipeline cards, with Undo on every change. It can't send, schedule, enroll or delete.</p>
					{#if status?.available}
						<ul class="ap-examples" aria-label="Example questions">
							{#each EXAMPLE_PROMPTS as ex (ex)}
								<li><button type="button" class="ap-example" disabled={busy} onclick={() => sendExample(ex)}>{ex}</button></li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			{#each items as item, i (i)}
				{#if item.kind === 'user'}
					<div class="ap-msg ap-user">{item.text}</div>
				{:else}
					<div class="ap-msg ap-assistant" aria-live={item.streaming ? 'polite' : undefined}>
						<AssistantMessage {item}>
							{#snippet actions()}
								{#each item.actions ?? [] as a (a.id)}
									<AssistantActionCard
										action={a}
										busy={busy || cardBusy !== null}
										error={cardErrors[a.id] ?? ''}
										onUndo={undo}
										onApprove={(id) => resume(id, 'approve')}
										onCancel={(id) => resume(id, 'cancel')}
									/>
								{/each}
							{/snippet}
						</AssistantMessage>
					</div>
				{/if}
			{/each}
		</div>

		{#if status?.available}
			<form class="ap-compose" onsubmit={(e) => { e.preventDefault(); send(); }}>
				{#if includeContext}
					<span class="ap-chip">
						{ctxLabel}
						<button type="button" class="ap-chip-x" title="Don't send the page context" onclick={() => (includeContext = false)}>
							<Icon name="close" size={16} label="Remove page context" />
						</button>
					</span>
				{:else}
					<button type="button" class="ap-chip-add" onclick={() => (includeContext = true)}>+ Add page context</button>
				{/if}
				<textarea
					bind:this={inputEl}
					bind:value={input}
					rows="3"
					placeholder="Ask the assistant…"
					aria-label="Message the assistant"
					onkeydown={onInputKey}
				></textarea>
				<div class="ap-send">
					<span class="muted hint">Enter to send · Shift+Enter for a new line</span>
					{#if busy}
						<button type="button" class="secondary" onclick={stop}>Stop</button>
					{:else}
						<button type="submit" disabled={!input.trim()}>Send</button>
					{/if}
				</div>
			</form>
		{/if}
	</aside>
{/if}

<style>
	.ap {
		position: fixed; top: 0; right: 0; bottom: 0; z-index: 70;
		width: var(--ap-width, 420px); max-width: 100vw;
		display: flex; flex-direction: column;
		background: var(--surface); color: var(--neutral-10);
		box-shadow: var(--border-shadow-s), var(--shadow-l);
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--tracking-l);
	}
	.ap-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 1; }
	.ap-resize:hover, .ap-resize:focus-visible { background: var(--neutral-4); outline: none; }
	.ap-head {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs);
		padding: var(--space-s) var(--space-m); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
	}
	.ap-title { display: inline-flex; align-items: center; gap: var(--space-xs); font-weight: var(--weight-ui-medium); }
	.ap-head-actions { display: flex; gap: var(--space-xxs); }
	.ap-icon {
		width: 32px; height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
		background: transparent; color: var(--neutral-8); box-shadow: none;
	}
	.ap-icon:hover { background: var(--neutral-3); color: var(--neutral-10); }
	.ap-icon[aria-pressed='true'] { background: var(--neutral-3); }
	.ap-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); padding: var(--space-xs) var(--space-m); }
	.ap-controls select { width: auto; }
	.ap-total { margin-left: auto; color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); }
	.ap-history { max-height: 40%; overflow-y: auto; padding: 0 var(--space-m) var(--space-xs); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4); }
	.ap-history ul { list-style: none; margin: 0; padding: 0; }
	.ap-history button {
		width: 100%; text-align: left; display: flex; flex-direction: column; align-items: flex-start; gap: 0;
		background: transparent; color: var(--neutral-10); box-shadow: none; padding: var(--space-xs);
	}
	.ap-history button:hover, .ap-history button.current { background: var(--neutral-3); }
	.ap-history .muted { font-size: var(--size-xs); line-height: var(--line-xs); }
	.ap-h-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
	.ap-body { flex: 1; overflow-y: auto; padding: var(--space-s) var(--space-m); display: flex; flex-direction: column; gap: var(--space-s); }
	.ap-notice { padding: var(--space-s); border-radius: var(--radius-s); background: var(--neutral-2); }
	.ap-notice p { margin: var(--space-xxs) 0 0; }
	.ap-empty p { margin: 0 0 var(--space-xs); }
	.ap-examples { list-style: none; margin: var(--space-s) 0 0; padding: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xs); }
	.ap-example {
		text-align: left; padding: var(--space-xs) var(--space-s); border-radius: var(--radius-m);
		background: var(--surface); color: var(--neutral-10); box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
	}
	.ap-example:hover { background: var(--neutral-3); box-shadow: 0 0 0 var(--border-s) var(--neutral-5); }
	.ap-example:focus-visible { box-shadow: 0 0 0 var(--border-s) var(--color-1-transparent), var(--focus-halo); }
	.ap-msg { max-width: 100%; overflow-wrap: anywhere; }
	.ap-user {
		align-self: flex-end; max-width: 85%; white-space: pre-wrap;
		padding: var(--space-xs) var(--space-s); border-radius: var(--radius-m); background: var(--neutral-3);
	}
	.ap-assistant { display: flex; flex-direction: column; gap: var(--space-xxs); }
	.ap-compose { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-s) var(--space-m) var(--space-m); box-shadow: inset 0 var(--border-s) 0 var(--neutral-4); margin: 0; }
	.ap-compose textarea { resize: vertical; min-height: 4rem; width: 100%; }
	.ap-chip {
		align-self: flex-start; display: inline-flex; align-items: center; gap: var(--space-xxs);
		padding: 0 0 0 var(--space-xs); border-radius: var(--radius-full); background: var(--neutral-3);
		font-size: var(--size-xs); line-height: var(--line-xs);
	}
	.ap-chip-x { width: 24px; height: 24px; padding: 0; background: transparent; box-shadow: none; color: var(--neutral-8); display: inline-flex; align-items: center; justify-content: center; }
	.ap-chip-add { align-self: flex-start; padding: 0; background: transparent; box-shadow: none; color: var(--neutral-8); font-size: var(--size-xs); line-height: var(--line-xs); text-decoration: underline; }
	.ap-send { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

	/* Phones: a full-screen sheet; no resize handle. */
	@media (max-width: 768px) {
		.ap { width: 100vw; left: 0; }
		.ap-resize { display: none; }
		.hint { display: none; }
	}
</style>

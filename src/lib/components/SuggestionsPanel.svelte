<script lang="ts">
	// Suggestions panel (#714, spec docs/suggestions.md → "The panel"). Three states:
	//   pill   — "4 suggestions" bottom right, above the assistant bubble (or in its corner);
	//   card   — one suggestion: kind chip, subject link, reason, main next step, "2 of 7"
	//            with Previous / Next (also ← / → and a swipe);
	//   detail — a dialog (bottom sheet on phones) with the full reason, evidence links, every
	//            next step, the draft opening, Done / Snooze / Dismiss.
	// The root layout mounts it only when the server says the feature is open to this user
	// (`data.suggestions`, a count); the cards load from GET /api/suggestions on open. A next
	// step only navigates to a page with things filled in; Done / Snooze / Dismiss are the only
	// writes (POST /api/suggestions/<id>, a status change). Nothing here sends or saves anything else.
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { KIND_LABELS, shortDate } from '$lib/suggestions';
	import {
		DISMISS_REASON_MAX,
		SESSION_KEY,
		SNOOZE_CHOICES,
		allSteps,
		countLabel,
		memoryKey,
		nextStepHref,
		panelHiddenOn,
		readMemory,
		shouldAutoOpen,
		swipeDirection,
		wrapIndex,
		type PanelMemory
	} from '$lib/suggestions-panel';

	type Evidence = { id: string; type: string; label: string; url: string | null; at: string | null };
	type Step = { type: string; label: string; url: string };
	type Item = {
		id: number;
		kind: keyof typeof KIND_LABELS;
		subject_label: string | null;
		subject_url: string | null;
		title: string;
		why: string;
		draft_opening: string | null;
		evidence: Evidence[];
		action: (Step & { more?: Step[] }) | null;
		updated_at: string;
	};

	let {
		summary,
		userId,
		aboveFab = false
	}: { summary: { count: number; latest: string | null }; userId: number; aboveFab?: boolean } = $props();

	let view = $state<'pill' | 'card' | 'detail'>('pill');
	let items = $state<Item[]>([]);
	let loaded = $state(false);
	let loading = $state(false);
	let loadError = $state('');
	let index = $state(0);
	let localCount = $state<number | null>(null);
	let busy = $state(false);
	let actionError = $state('');
	let dismissing = $state(false);
	let dismissReason = $state('');
	let copied = $state(false);

	let pillEl = $state<HTMLButtonElement>();
	let cardEl = $state<HTMLElement>();
	let detailEl = $state<HTMLElement>();

	const count = $derived(localCount ?? summary.count);
	const hidden = $derived(panelHiddenOn(page.url.pathname));
	const current = $derived(items.length ? items[wrapIndex(index, items.length)] : null);
	const position = $derived(items.length ? wrapIndex(index, items.length) + 1 : 0);

	function memory(): PanelMemory {
		try {
			return readMemory(localStorage.getItem(memoryKey(userId)));
		} catch {
			return readMemory(null);
		}
	}
	function remember(patch: Partial<PanelMemory>) {
		try {
			localStorage.setItem(memoryKey(userId), JSON.stringify({ ...memory(), ...patch }));
		} catch {
			/* private mode: nothing remembered */
		}
	}

	async function load() {
		loading = true;
		loadError = '';
		try {
			const res = await fetch('/api/suggestions', { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { items: Item[]; count: number };
			items = body.items;
			localCount = body.count;
			index = 0;
			loaded = true;
			const newest = items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), summary.latest ?? '');
			remember({ seen: newest });
		} catch {
			loadError = "Suggestions couldn't load. Try again.";
		} finally {
			loading = false;
		}
	}

	async function openCard(focus = true) {
		view = 'card';
		remember({ minimized: false });
		if (!loaded) await load();
		if (focus) {
			await tick();
			cardEl?.focus();
		}
	}

	async function minimize() {
		view = 'pill';
		dismissing = false;
		remember({ minimized: true });
		await tick();
		pillEl?.focus();
	}

	async function openDetail() {
		if (!current) return;
		view = 'detail';
		actionError = '';
		dismissing = false;
		dismissReason = '';
		copied = false;
		await tick();
		detailEl?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
	}

	async function closeDetail() {
		view = 'card';
		dismissing = false;
		await tick();
		cardEl?.focus();
	}

	function step(delta: number) {
		if (items.length < 2) return;
		index = wrapIndex(index + delta, items.length);
	}

	function onCardKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			step(1);
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			step(-1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			minimize();
		}
	}

	let swipeStart: { x: number; y: number } | null = null;
	function onPointerDown(e: PointerEvent) {
		if (e.pointerType === 'mouse') return;
		swipeStart = { x: e.clientX, y: e.clientY };
	}
	function onPointerUp(e: PointerEvent) {
		if (!swipeStart) return;
		const dir = swipeDirection(e.clientX - swipeStart.x, e.clientY - swipeStart.y);
		swipeStart = null;
		if (dir) step(dir === -1 ? 1 : -1);
	}

	// Focus stays inside the open detail view; Escape closes it.
	function onDetailKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (dismissing) dismissing = false;
			else closeDetail();
			return;
		}
		if (e.key !== 'Tab' || !detailEl) return;
		const f = [...detailEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
			(el) => el.offsetParent !== null || el === document.activeElement
		);
		if (!f.length) return;
		const first = f[0];
		const last = f[f.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	async function act(body: Record<string, unknown>) {
		if (!current || busy) return;
		busy = true;
		actionError = '';
		const id = current.id;
		try {
			const res = await fetch(`/api/suggestions/${id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok && res.status !== 409) {
				const msg = await res.json().then((j) => (j as { message?: string } | null)?.message).catch(() => null);
				actionError = msg || "That didn't work. Try again.";
				return;
			}
			// 409 = someone else already closed it: it leaves this panel too.
			items = items.filter((i) => i.id !== id);
			localCount = items.length;
			index = wrapIndex(index, items.length);
			dismissing = false;
			if (!items.length) {
				view = 'pill';
				await tick();
				pillEl?.focus();
			} else {
				await closeDetail();
			}
		} catch {
			actionError = "That didn't work. Try again.";
		} finally {
			busy = false;
		}
	}

	async function copyOpening() {
		if (!current?.draft_opening) return;
		try {
			await navigator.clipboard.writeText(current.draft_opening);
			copied = true;
		} catch {
			copied = false;
		}
	}

	// A next step only navigates; leave the page uncovered.
	function followed() {
		view = 'pill';
		dismissing = false;
	}

	onMount(() => {
		let opened = false;
		try {
			opened = sessionStorage.getItem(SESSION_KEY) === '1';
		} catch {
			opened = true; // no storage: never pop up by itself
		}
		if (!hidden && shouldAutoOpen({ count: summary.count, latest: summary.latest, memory: memory(), openedThisSession: opened })) {
			try {
				sessionStorage.setItem(SESSION_KEY, '1');
			} catch {
				/* ignore */
			}
			openCard(false);
		}
	});

	// A page that hides the panel (compose, …) collapses it.
	$effect(() => {
		if (hidden && view !== 'pill') view = 'pill';
	});
</script>

<p class="sr-only" aria-live="polite" aria-atomic="true">{count > 0 ? countLabel(count) : 'No suggestions'}</p>

{#if !hidden && (count > 0 || view !== 'pill')}
	<div class="sp" class:above-fab={aboveFab}>
		{#if view === 'pill'}
			<button type="button" class="sp-pill" bind:this={pillEl} onclick={() => openCard()} aria-expanded="false" aria-controls="sp-card">
				<Icon name="suggestion" size={16} />
				<span>{countLabel(count)}</span>
			</button>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
			<section
				id="sp-card"
				class="sp-card"
				bind:this={cardEl}
				tabindex="-1"
				aria-roledescription="carousel"
				aria-label="Suggestions"
				onkeydown={onCardKey}
				onpointerdown={onPointerDown}
				onpointerup={onPointerUp}
				inert={view === 'detail'}
			>
				<header class="sp-head">
					<span class="sp-title"><Icon name="suggestion" size={16} /> Suggestions</span>
					<button type="button" class="sp-icon" onclick={minimize} aria-label="Minimise suggestions"><Icon name="chevron-down" size={16} /></button>
				</header>
				{#if loading && !loaded}
					<p class="muted small sp-body">Loading…</p>
				{:else if loadError}
					<div class="sp-body">
						<p class="small" role="alert">{loadError}</p>
						<button type="button" class="secondary sm" onclick={load}>Try again</button>
					</div>
				{:else if current}
					<div class="sp-body" role="group" aria-roledescription="slide" aria-label="{position} of {items.length}">
						<div class="sp-meta">
							<span class="sp-kind sp-kind-{current.kind}">{KIND_LABELS[current.kind] ?? current.kind}</span>
							{#if current.subject_url}
								<a href={current.subject_url} class="sp-subject" onclick={followed}>{current.subject_label ?? 'Open'}</a>
							{:else if current.subject_label}
								<span class="sp-subject">{current.subject_label}</span>
							{/if}
						</div>
						<p class="sp-why">{current.why || current.title}</p>
						<div class="sp-actions">
							{#if current.action}
								<a class="sp-btn" href={nextStepHref(current.action, current.draft_opening)} onclick={followed}>{current.action.label}</a>
							{/if}
							<button type="button" class="secondary sm" onclick={openDetail}>More</button>
						</div>
						<nav class="sp-pager" aria-label="Page through suggestions">
							<button type="button" class="sp-icon" onclick={() => step(-1)} disabled={items.length < 2} aria-label="Previous suggestion"><Icon name="chevron-left" size={16} /></button>
							<span class="muted small">{position} of {items.length}</span>
							<button type="button" class="sp-icon" onclick={() => step(1)} disabled={items.length < 2} aria-label="Next suggestion"><Icon name="chevron-right" size={16} /></button>
						</nav>
					</div>
				{:else}
					<p class="muted small sp-body">Nothing to follow up on right now.</p>
				{/if}
			</section>
		{/if}
	</div>
{/if}

{#if view === 'detail' && current && !hidden}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="sp-backdrop" aria-hidden="true" onclick={closeDetail}></div>
	<div
		class="sp-detail"
		role="dialog"
		aria-modal="true"
		aria-labelledby="sp-detail-title"
		bind:this={detailEl}
		tabindex="-1"
		onkeydown={onDetailKey}
	>
		<header class="sp-head">
			<span class="sp-kind sp-kind-{current.kind}">{KIND_LABELS[current.kind] ?? current.kind}</span>
			<button type="button" class="sp-icon" onclick={closeDetail} aria-label="Close details" data-autofocus><Icon name="close" size={16} /></button>
		</header>
		<h2 id="sp-detail-title" class="sp-h">{current.title}</h2>
		{#if current.subject_url}
			<p class="small"><a href={current.subject_url} onclick={followed}>{current.subject_label ?? 'Open'}</a></p>
		{/if}
		<p>{current.why}</p>

		{#if current.evidence.length}
			<h3 class="sp-h3">Why this suggestion</h3>
			<ul class="sp-evidence">
				{#each current.evidence as e (e.id)}
					<li>
						{#if e.url}<a href={e.url} onclick={followed}>{e.label}</a>{:else}<span>{e.label}</span>{/if}
						{#if e.at}<span class="muted small"> · {shortDate(e.at)}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if current.draft_opening}
			<h3 class="sp-h3">Draft opening line</h3>
			<blockquote class="sp-draft">{current.draft_opening}</blockquote>
			<button type="button" class="secondary sm" onclick={copyOpening}><Icon name="copy" size={16} /> {copied ? 'Copied' : 'Copy'}</button>
		{/if}

		<h3 class="sp-h3">Next step</h3>
		<div class="sp-actions">
			{#each allSteps(current.action) as s, i (s.type + s.url)}
				<a class={i === 0 ? 'sp-btn' : 'sp-btn secondary'} href={nextStepHref(s, current.draft_opening)} onclick={followed}>{s.label}</a>
			{/each}
		</div>
		<p class="muted small">Opens the page with things filled in. Nothing is sent or saved until you do it there.</p>

		<div class="sp-close-row">
			<button type="button" class="sm" onclick={() => act({ op: 'done' })} disabled={busy}>Done</button>
			<div class="sp-snooze" role="group" aria-label="Snooze">
				<span class="muted small">Snooze</span>
				{#each SNOOZE_CHOICES as c (c.days)}
					<button type="button" class="secondary sm" onclick={() => act({ op: 'snooze', days: c.days })} disabled={busy}>{c.label}</button>
				{/each}
			</div>
			{#if !dismissing}
				<button type="button" class="secondary sm" onclick={() => (dismissing = true)} disabled={busy}>Dismiss…</button>
			{/if}
		</div>
		{#if dismissing}
			<form
				class="sp-dismiss"
				onsubmit={(e) => {
					e.preventDefault();
					act({ op: 'dismiss', reason: dismissReason });
				}}
			>
				<label class="small" for="sp-dismiss-reason">Reason <span class="muted">(optional)</span></label>
				<input id="sp-dismiss-reason" bind:value={dismissReason} maxlength={DISMISS_REASON_MAX} placeholder="e.g. Already called them" />
				<button type="submit" class="sm" disabled={busy}>Dismiss</button>
				<button type="button" class="secondary sm" onclick={() => (dismissing = false)}>Cancel</button>
			</form>
		{/if}
		<p class="muted small">Done, Snooze and Dismiss apply to the whole team.</p>
		{#if actionError}<p class="small err" role="alert">{actionError}</p>{/if}
	</div>
{/if}

<style>
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

	/* Bottom right, above the assistant bubble (48px + gap) or in its corner. Lifts with the
	   same bottom bars AssistantFab avoids, plus --sticky-actions-bottom and the safe area. */
	.sp {
		--sp-gap: 16px;
		--sp-fab: 0px;
		position: fixed;
		right: calc(var(--sp-gap) + env(safe-area-inset-right, 0px));
		bottom: calc(var(--sp-gap) + env(safe-area-inset-bottom, 0px) + var(--sp-lift, 0px) + var(--sp-fab) + var(--sticky-actions-bottom, 0px));
		z-index: 60;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}
	.sp.above-fab {
		--sp-fab: calc(48px + var(--space-s));
	}
	/* The assistant panel is open: the bubble is gone, the pill keeps its place under the drawer. */
	@media (min-width: 769px) {
		.sp { --sp-gap: var(--space-l); }
	}
	:global(body:has(.bulkbar)) .sp,
	:global(body:has(.update-toast)) .sp {
		--sp-lift: 4.5rem;
	}
	:global(html[data-write-mode]) .sp {
		display: none;
	}

	.sp-pill {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-m);
		border-radius: var(--radius-full);
		box-shadow: var(--shadow-m);
		min-height: 36px;
	}
	.sp-pill:focus-visible { box-shadow: var(--focus-halo), var(--shadow-m); }

	.sp-card {
		width: min(360px, calc(100vw - 2 * var(--sp-gap)));
		background: var(--surface);
		color: var(--text);
		border: var(--border-s, 1px) solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-l);
		padding: var(--space-s) var(--space-m) var(--space-m);
		outline: none;
		touch-action: pan-y;
	}
	.sp-card:focus-visible { box-shadow: var(--focus-halo), var(--shadow-l); }
	.sp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s);
	}
	.sp-title {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-weight: var(--weight-ui-medium);
		font-size: var(--size-s);
	}
	.sp-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		min-height: 32px;
		padding: 0;
		background: transparent;
		color: var(--text);
		border: 0;
		border-radius: var(--radius-full);
	}
	.sp-icon:hover:not(:disabled) { background: var(--btn-hover); }
	.sp-icon:disabled { opacity: 0.4; }
	.sp-body { margin-top: var(--space-xs); }
	.sp-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.sp-kind {
		display: inline-block;
		padding: var(--space-xxs, 2px) var(--space-xs);
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		font-weight: var(--weight-ui-medium);
		background: var(--neutral-3);
		color: var(--text);
	}
	.sp-kind-follow_up { box-shadow: inset 0 0 0 1px var(--color-1); }
	.sp-kind-campaign { box-shadow: inset 0 0 0 1px var(--neutral-6, var(--border)); }
	.sp-kind-marketing { box-shadow: inset 0 0 0 1px var(--warning); }
	.sp-subject { font-weight: var(--weight-ui-medium); }
	.sp-why { margin: var(--space-xs) 0 var(--space-s); }
	.sp-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.sp-pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-s);
		margin-top: var(--space-s);
	}

	.sp-backdrop {
		position: fixed;
		inset: 0;
		background: var(--backdrop);
		z-index: 70;
	}
	.sp-detail {
		position: fixed;
		z-index: 71;
		right: calc(var(--space-l) + env(safe-area-inset-right, 0px));
		bottom: calc(var(--space-l) + env(safe-area-inset-bottom, 0px));
		width: min(480px, calc(100vw - 2 * var(--space-l)));
		max-height: min(80vh, 720px);
		overflow: auto;
		background: var(--surface);
		color: var(--text);
		border: var(--border-s, 1px) solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-l);
		padding: var(--space-m);
		outline: none;
	}
	.sp-h { font-size: var(--size-m); margin: var(--space-s) 0 var(--space-xs); }
	.sp-h3 { font-size: var(--size-s); margin: var(--space-m) 0 var(--space-xs); }
	.sp-evidence { margin: 0; padding-left: 1.1em; }
	.sp-evidence li + li { margin-top: var(--space-xxs, 2px); }
	.sp-draft {
		margin: 0 0 var(--space-xs);
		padding: var(--space-xs) var(--space-s);
		border-left: 2px solid var(--border);
		background: var(--surface-subtle);
	}
	.sp-close-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		margin-top: var(--space-m);
		padding-top: var(--space-s);
		border-top: 1px solid var(--border-muted);
	}
	.sp-snooze {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}
	.sp-dismiss {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		margin-top: var(--space-s);
	}
	.sp-dismiss input { flex: 1 1 12rem; min-width: 0; }
	.err { color: var(--danger); }
	.small { font-size: var(--size-xs); }
	/* A next step is a link (it only opens a page), drawn like the theme's buttons. */
	a.sp-btn {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: var(--space-xxs, 2px) var(--space-s);
		border-radius: var(--radius);
		background: var(--btn-primary-bg);
		color: var(--btn-primary-text);
		font-family: var(--font-ui);
		font-weight: var(--weight-ui-medium);
		font-size: var(--size-s);
		text-decoration-line: none;
	}
	a.sp-btn:hover { background: var(--btn-primary-hover); }
	a.sp-btn.secondary {
		background: color-mix(in srgb, var(--color-1) 20%, transparent);
		color: var(--text);
	}
	a.sp-btn.secondary:hover { background: var(--btn-secondary-hover); }

	/* Phones: the card spans the bottom; the detail view is a bottom sheet. */
	@media (max-width: 768px) {
		:global(body:has(.bulkbar)) .sp { --sp-lift: 9rem; }
		.sp-detail {
			left: 0;
			right: 0;
			bottom: 0;
			width: auto;
			max-height: 85vh;
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
			padding-bottom: calc(var(--space-m) + env(safe-area-inset-bottom, 0px));
		}
	}

	/* Slide in only when motion is welcome. */
	@media (prefers-reduced-motion: no-preference) {
		.sp-card { animation: sp-in var(--motion-duration) var(--motion-easing); }
		.sp-detail { animation: sp-in var(--motion-duration) var(--motion-easing); }
		.sp { transition: bottom var(--motion-duration) var(--motion-easing); }
	}
	@keyframes sp-in {
		from { opacity: 0; transform: translateY(12px); }
		to { opacity: 1; transform: none; }
	}
</style>

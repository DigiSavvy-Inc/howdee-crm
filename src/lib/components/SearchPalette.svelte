<script lang="ts">
	// Site-wide search (#477): a command-palette dialog over contacts, companies, campaigns and
	// automations, grouped. Mounted once in the root layout (signed-in pages only); opened with
	// Cmd+K (Mac) / Ctrl+K, `/` outside text fields, or the header's search button. The input is a
	// combobox over one listbox; ↑/↓ move across groups, Tab / Shift+Tab jump between groups,
	// Enter opens, Cmd+Enter / Ctrl+Enter opens in a new tab, Esc closes and focus goes back.
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { kbd } from '$lib/platform.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import TierBadge from '$lib/components/TierBadge.svelte';
	import { TIERS, type TierName } from '$lib/engagement-view';
	import {
		SEARCH_GROUPS,
		highlightParts,
		looksLikeEmail,
		loadRecent,
		pushRecent,
		saveRecent,
		seeAllHref,
		totalLabel,
		type RecentItem,
		type SearchGroupKey,
		type SearchResponse
	} from '$lib/site-search';

	let { open = $bindable(false), isAdmin = false }: { open?: boolean; isAdmin?: boolean } = $props();

	const DEBOUNCE_MS = 150;

	type Option = {
		id: string;
		group: string; // group key or 'recent' / 'create'
		kind: 'record' | 'seeall' | 'create';
		href: string;
		title: string;
		sub?: string;
		pill?: { kind: 'tier'; tier: TierName } | { kind: 'status'; status: string };
		recent?: RecentItem;
	};

	let query = $state('');
	let results = $state<SearchResponse | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let recent = $state<RecentItem[]>([]);
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let returnFocus: HTMLElement | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;

	const trimmed = $derived(query.trim());

	function fmtDate(s: string | null): string {
		if (!s) return '';
		const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
		return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}
	const tierOf = (t: string): TierName => ((TIERS as readonly string[]).includes(t) ? (t as TierName) : 'new');

	// Groups as rendered: each with its options (records + "See all"). Empty groups are hidden.
	const groups = $derived.by(() => {
		const out: { key: string; label: string; count?: string; options: Option[] }[] = [];
		if (!trimmed) {
			if (recent.length)
				out.push({
					key: 'recent',
					label: 'Recently opened',
					options: recent.map((r) => ({ id: `recent-${r.type}-${r.id}`, group: 'recent', kind: 'record', href: r.href, title: r.title, sub: r.sub, recent: r }))
				});
			return out;
		}
		if (!results || results.q !== trimmed) return out;
		for (const g of SEARCH_GROUPS) {
			const res = results[g.key];
			if (!res.items.length) continue;
			const options: Option[] = [];
			for (const it of res.items) {
				const base = { id: `opt-${g.key}-${it.id}`, group: g.key, kind: 'record' as const, href: it.href, title: it.title };
				if (g.key === 'contacts') {
					const c = it as SearchResponse['contacts']['items'][number];
					const sub = [c.title !== c.email ? c.email : '', c.company ?? ''].filter(Boolean).join(' · ');
					options.push({ ...base, sub, pill: { kind: 'tier', tier: tierOf(c.tier) }, recent: { type: g.key, id: it.id, title: it.title, sub: c.email, href: it.href } });
				} else if (g.key === 'companies') {
					const c = it as SearchResponse['companies']['items'][number];
					const sub = [c.domain ?? '', `${c.contact_count} contact${c.contact_count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
					options.push({ ...base, sub, recent: { type: g.key, id: it.id, title: it.title, sub: c.domain ?? undefined, href: it.href } });
				} else if (g.key === 'campaigns') {
					const c = it as SearchResponse['campaigns']['items'][number];
					const when = fmtDate(c.date);
					const sub = when ? `${c.status === 'scheduled' ? 'Scheduled' : c.status === 'sent' ? 'Sent' : ''} ${when}`.trim() : '';
					options.push({ ...base, sub, pill: { kind: 'status', status: c.status }, recent: { type: g.key, id: it.id, title: it.title, sub: 'Campaign', href: it.href } });
				} else {
					const a = it as SearchResponse['automations']['items'][number];
					options.push({ ...base, sub: a.trigger, pill: { kind: 'status', status: a.status }, recent: { type: g.key, id: it.id, title: it.title, sub: 'Automation', href: it.href } });
				}
			}
			if (res.total > res.items.length || res.capped)
				options.push({ id: `seeall-${g.key}`, group: g.key, kind: 'seeall', href: seeAllHref(g.key as SearchGroupKey, trimmed), title: `See all ${totalLabel(res)} ${g.noun}` });
			out.push({ key: g.key, label: g.label, count: totalLabel(res), options });
		}
		if (!out.length && isAdmin && looksLikeEmail(trimmed))
			out.push({
				key: 'create',
				label: 'Actions',
				options: [{ id: 'create-contact', group: 'create', kind: 'create', href: `/contacts?add=${encodeURIComponent(trimmed)}`, title: `Create contact with ${trimmed}` }]
			});
		return out;
	});
	const flat = $derived(groups.flatMap((g) => g.options));
	const activeOption = $derived(flat[activeIndex] ?? null);
	const noMatches = $derived(!!trimmed && !!results && results.q === trimmed && SEARCH_GROUPS.every((g) => !results![g.key].items.length));

	// Open / close: remember and restore focus, load recents; closing clears the search so the
	// next open starts empty, on the recents.
	$effect(() => {
		if (open) {
			returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			recent = loadRecent();
			activeIndex = 0;
			tick().then(() => {
				inputEl?.focus();
				inputEl?.select();
			});
		} else {
			// Closed (Esc, outside click, a choice, or the shortcut again): focus goes back.
			controller?.abort();
			if (timer) clearTimeout(timer);
			query = '';
			results = null;
			loading = false;
			failed = false;
			const el = returnFocus;
			returnFocus = null;
			if (el && document.contains(el)) tick().then(() => el.focus());
		}
	});

	function close() {
		open = false;
	}

	function onInput() {
		activeIndex = 0;
		failed = false;
		if (timer) clearTimeout(timer);
		controller?.abort();
		const q = query.trim();
		if (!q) {
			results = null;
			loading = false;
			return;
		}
		loading = true;
		timer = setTimeout(() => run(q), DEBOUNCE_MS);
	}

	async function run(q: string) {
		const ctl = new AbortController();
		controller = ctl;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=5`, { signal: ctl.signal, headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as SearchResponse;
			// A slow reply never overwrites a newer query.
			if (ctl.signal.aborted || controller !== ctl) return;
			results = body;
			activeIndex = 0;
		} catch (e) {
			if ((e as Error)?.name === 'AbortError' || controller !== ctl) return;
			failed = true;
		} finally {
			if (controller === ctl) loading = false;
		}
	}

	function choose(opt: Option, newTab = false) {
		if (opt.recent) {
			recent = pushRecent(loadRecent(), opt.recent);
			saveRecent(recent);
		}
		if (newTab) {
			window.open(opt.href, '_blank', 'noopener');
			return;
		}
		close();
		goto(opt.href);
	}

	async function scrollActive() {
		await tick();
		const el = activeOption ? document.getElementById(activeOption.id) : null;
		el?.scrollIntoView({ block: 'nearest' });
	}

	function jumpGroup(dir: 1 | -1) {
		if (!groups.length) return;
		const cur = activeOption?.group;
		let gi = groups.findIndex((g) => g.key === cur);
		gi = gi < 0 ? 0 : (gi + dir + groups.length) % groups.length;
		const first = groups[gi].options[0];
		activeIndex = flat.indexOf(first);
		scrollActive();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!flat.length) return;
			activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
			scrollActive();
			return;
		}
		if (e.key === 'Tab') {
			// Focus stays in the input (the only tabbable control); Tab moves between groups.
			e.preventDefault();
			jumpGroup(e.shiftKey ? -1 : 1);
			return;
		}
		if (e.key === 'Enter') {
			if (e.isComposing) return;
			e.preventDefault();
			if (activeOption) choose(activeOption, e.metaKey || e.ctrlKey);
			else if (trimmed) {
				// Nothing loaded yet: run the search now instead of waiting for the debounce.
				if (timer) clearTimeout(timer);
				run(trimmed);
			}
		}
	}

	// The app's badge tints: live / sent = success, in flight = warning, the rest neutral.
	function badgeClass(s: string): string {
		if (s === 'sent' || s === 'active') return 'sent';
		if (s === 'scheduled' || s === 'sending') return 'sending';
		if (s === 'failed') return 'failed';
		return 'draft';
	}
	function statusLabel(s: string): string {
		return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="sp-backdrop" onclick={close}></div>
	<div class="sp" role="dialog" aria-modal="true" aria-label="Search">
		<div class="sp-head">
			<Icon name="search" size={20} />
			<input
				bind:this={inputEl}
				bind:value={query}
				oninput={onInput}
				onkeydown={onKey}
				type="text"
				role="combobox"
				aria-expanded={flat.length > 0}
				aria-controls="sp-listbox"
				aria-autocomplete="list"
				aria-activedescendant={activeOption?.id}
				aria-label="Search contacts, companies, campaigns and automations"
				placeholder="Search contacts, companies, campaigns, automations…"
				autocomplete="off"
				spellcheck="false"
			/>
			<!-- Phones have no Esc key: the same button reads "Close" there. -->
			<button type="button" class="sp-close secondary small" onclick={close} aria-label="Close search"><span class="sp-close-wide">Esc</span><span class="sp-close-narrow">Close</span></button>
		</div>
		<div class="sp-body">
			<div id="sp-listbox" role="listbox" aria-label="Results">
				{#each groups as g (g.key)}
					<div role="group" aria-labelledby="sp-g-{g.key}" class="sp-group">
						<div class="sp-group-head" id="sp-g-{g.key}" role="presentation">
							<span>{g.label}</span>{#if g.count}<span class="sp-count">{g.count}</span>{/if}
						</div>
						{#each g.options as opt (opt.id)}
							{@const idx = flat.indexOf(opt)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								id={opt.id}
								role="option"
								tabindex="-1"
								aria-selected={idx === activeIndex}
								class="sp-opt"
								class:active={idx === activeIndex}
								class:seeall={opt.kind !== 'record'}
								onmousemove={() => (activeIndex = idx)}
								onmousedown={(e) => e.preventDefault()}
								onclick={(e) => choose(opt, e.metaKey || e.ctrlKey)}
							>
								<span class="sp-main">
									<span class="sp-title">
										{#if opt.kind === 'record' && trimmed}
											{#each highlightParts(opt.title, trimmed) as part, i (i)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
										{:else}
											{opt.title}{#if opt.kind === 'seeall'}&nbsp;→{/if}
										{/if}
									</span>
									{#if opt.sub}<span class="sp-sub">{opt.sub}</span>{/if}
								</span>
								{#if opt.pill?.kind === 'tier'}
									<TierBadge tier={opt.pill.tier} />
								{:else if opt.pill?.kind === 'status'}
									<span class="badge {badgeClass(opt.pill.status)}">{statusLabel(opt.pill.status)}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>
			{#if !trimmed && !recent.length}
				<p class="sp-note muted">Type to search contacts, companies, campaigns and automations.</p>
			{:else if failed}
				<p class="sp-note" role="alert">Search failed. Try again.</p>
			{:else if noMatches}
				<p class="sp-note muted" role="status">No matches for ‘{trimmed}’</p>
			{:else if loading && !groups.length}
				<p class="sp-note muted" role="status">Searching…</p>
			{/if}
		</div>
		<div class="sp-foot muted">
			<span>↑↓ move</span><span>Tab next group</span><span>Enter open</span><span>{kbd('Mod+Enter')} new tab</span><span>Esc close</span>
		</div>
	</div>
{/if}

<style>
	.sp-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgb(0 0 0 / 0.4);
	}
	.sp {
		position: fixed;
		z-index: 61;
		top: 10vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(640px, calc(100vw - 2 * var(--space-l)));
		max-height: 75vh;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		color: var(--text);
		border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border), 0 16px 48px rgb(0 0 0 / 0.25);
		overflow: hidden;
	}
	.sp-head {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-s) var(--space-m);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
		color: var(--muted);
	}
	.sp-head input {
		flex: 1;
		min-width: 0;
		border: 0;
		box-shadow: none;
		background: transparent;
		font-size: var(--size-m);
		line-height: var(--line-m);
		padding: var(--space-xxs) 0;
		color: var(--text);
	}
	.sp-head input:focus,
	.sp-head input:focus-visible {
		outline: none;
		box-shadow: none;
	}
	.sp-body {
		overflow-y: auto;
		padding: var(--space-xs) 0;
	}
	.sp-group + .sp-group {
		margin-top: var(--space-xs);
	}
	.sp-group-head {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-m);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-medium);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
	}
	.sp-count {
		font-weight: var(--weight-ui-regular);
	}
	.sp-opt {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-xs) var(--space-m);
		cursor: pointer;
	}
	.sp-opt.active {
		background: var(--neutral-3);
	}
	.sp-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.sp-title,
	.sp-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sp-sub {
		font-size: var(--size-s);
		line-height: var(--line-s);
		color: var(--muted);
	}
	.sp-opt.seeall .sp-title {
		font-size: var(--size-s);
		color: var(--muted);
	}
	.sp-title :global(mark) {
		background: color-mix(in srgb, var(--warning) 35%, transparent);
		color: inherit;
		border-radius: 2px;
	}
	.sp-note {
		margin: 0;
		padding: var(--space-s) var(--space-m);
		font-size: var(--size-s);
	}
	.sp-foot {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		padding: var(--space-xs) var(--space-m);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		box-shadow: inset 0 var(--border-s) 0 var(--border);
	}
	.sp-close-narrow {
		display: none;
	}
	/* Phones: full screen. */
	@media (max-width: 768px) {
		.sp {
			inset: 0;
			top: 0;
			left: 0;
			transform: none;
			width: 100%;
			max-height: none;
			height: 100%;
			border-radius: 0;
		}
		.sp-head input {
			/* ≥ 16px stops iOS Safari zooming in on focus (no 16px size step; --size-m is 15px). */
			font-size: 16px;
		}
		.sp-close-wide {
			display: none;
		}
		.sp-close-narrow {
			display: inline;
		}
		.sp-body {
			flex: 1;
		}
		.sp-foot {
			display: none;
		}
	}
</style>

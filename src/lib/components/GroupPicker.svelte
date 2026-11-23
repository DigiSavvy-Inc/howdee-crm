<script lang="ts">
	import { tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { PICKER_KINDS, allGroupsHref, groupPageHref, pickedGroup, pickerSections, type PickerGroup, type PickerKind } from '$lib/group-picker';

	// #583: Lists · Segments · Tags in one searchable menu next to the /contacts search. Picking a
	// row navigates to `hrefFor(id)` (the page sets `in=` and resets the page); each row also links
	// to the group's own page. Live (rule-based) segments have no memberships for `in=` to match,
	// so their row opens the segment's page instead.
	let {
		groups,
		active,
		hrefFor,
		clearHref
	}: {
		groups: Record<PickerKind, PickerGroup[]>;
		active: number | null;
		hrefFor: (id: number) => string;
		clearHref: string;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let root = $state<HTMLDivElement | null>(null);
	let button = $state<HTMLButtonElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);
	const sections = $derived(pickerSections(groups, query));
	const picked = $derived(pickedGroup(groups, active));
	const KIND_WORD: Record<PickerKind, string> = { list: 'List', segment: 'Segment', tag: 'Tag' };

	async function toggle() {
		open = !open;
		if (open) {
			query = '';
			await tick();
			input?.focus();
		}
	}
	function close(focusButton = true) {
		open = false;
		if (focusButton) button?.focus();
	}
	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) close(false);
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			close();
			return;
		}
		// Arrow keys walk the row links; Tab works too.
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const links = [...(root?.querySelectorAll<HTMLElement>('.gp-menu a.gp-pick, .gp-menu input') ?? [])];
		if (!links.length) return;
		e.preventDefault();
		const i = links.indexOf(document.activeElement as HTMLElement);
		const next = e.key === 'ArrowDown' ? (i + 1) % links.length : (i - 1 + links.length) % links.length;
		links[next].focus();
	}
	const fmt = (n: number) => n.toLocaleString('en-US');
</script>

<svelte:window onclick={onWindowClick} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gp" bind:this={root} onkeydown={onKeydown}>
	<button
		type="button"
		class="gp-btn"
		class:on={!!active}
		bind:this={button}
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={toggle}
	>
		{#if picked}
			<span class="gp-kind">{KIND_WORD[picked.kind]}:</span> <span class="gp-name">{picked.group.name}</span>
		{:else if active}
			In group #{active}
		{:else}
			Lists &amp; tags
		{/if}
		<Icon name="chevron-down" size={16} />
	</button>
	{#if open}
		<div class="gp-menu" role="dialog" aria-label="Show contacts in a list, segment or tag">
			<input
				type="search"
				bind:this={input}
				bind:value={query}
				placeholder="Find a list, segment or tag"
				aria-label="Find a list, segment or tag"
				autocomplete="off"
				spellcheck="false"
			/>
			<div class="gp-scroll">
				{#if active}
					<a class="gp-pick gp-any" href={clearHref} onclick={() => close(false)}>All contacts <span class="muted">(any group)</span></a>
				{/if}
				{#each sections as s (s.kind)}
					<div class="gp-sec">
						<div class="gp-title">{s.title}</div>
						{#if s.items.length === 0}
							<p class="gp-empty muted">None yet.</p>
						{/if}
						<ul>
							{#each s.items as g (g.id)}
								<li class:cur={active === g.id}>
									{#if g.dynamic}
										<a class="gp-pick" href={groupPageHref(g.id)} title="Live segment: opens its page">
											<span class="gp-label">{g.name}</span>
											<span class="gp-live">live</span>
											<span class="gp-count">{fmt(g.count)}</span>
										</a>
									{:else}
										<a class="gp-pick" href={hrefFor(g.id)} aria-current={active === g.id ? 'true' : undefined} onclick={() => close(false)}>
											<span class="gp-label">{g.name}</span>
											<span class="gp-count">{fmt(g.count)}</span>
										</a>
										<a class="gp-open" href={groupPageHref(g.id)} aria-label="Open {g.name}" title="Open {s.title.toLowerCase().slice(0, -1)} page">
											<Icon name="external" size={16} />
										</a>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/each}
				{#if query && sections.length === 0}
					<p class="gp-empty muted">No list, segment or tag matches “{query}”.</p>
				{/if}
			</div>
			<div class="gp-all">
				{#each PICKER_KINDS as k (k.kind)}<a href={allGroupsHref(k.kind)}>{k.allLabel}</a>{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.gp { position: relative; }
	.gp-btn {
		display: inline-flex; align-items: center; gap: var(--space-xxs); max-width: 16rem; height: 38px; box-sizing: border-box;
		padding: var(--space-xs) var(--space-s) var(--space-xs) var(--space-m); border: 0; border-radius: var(--radius-s);
		background: var(--btn-bg); color: var(--neutral-10); white-space: nowrap; cursor: pointer;
		font-size: var(--size-s); line-height: var(--line-s); font-weight: var(--weight-ui-medium);
		box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
	}
	.gp-btn:hover { background: var(--btn-hover); }
	.gp-btn.on { box-shadow: 0 0 0 var(--border-s) var(--color-1); color: var(--text); }
	.gp-kind { color: var(--muted); font-weight: var(--weight-ui-regular); }
	.gp-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.gp-menu {
		position: absolute; left: 0; top: calc(100% + var(--space-xxs)); z-index: 20; width: min(92vw, 340px);
		display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-s);
		background: var(--surface); color: var(--text); border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
	}
	.gp-menu input { width: 100%; }
	.gp-scroll { max-height: min(60vh, 420px); overflow: auto; display: flex; flex-direction: column; gap: var(--space-xs); }
	.gp-title {
		font-size: var(--size-xs); line-height: var(--line-xs); color: var(--muted); font-weight: var(--weight-ui-medium);
		text-transform: uppercase; letter-spacing: var(--tracking-l, 0.04em); padding: var(--space-xxs) var(--space-xs);
	}
	ul { list-style: none; margin: 0; padding: 0; }
	li { display: flex; align-items: center; border-radius: var(--radius-s); }
	li:hover, li.cur { background: var(--neutral-muted); }
	.gp-pick {
		flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-xs); color: var(--text); font-size: var(--size-s); line-height: var(--line-s);
		border-radius: var(--radius-s);
	}
	.gp-pick:hover { text-decoration: none; }
	.gp-any { margin-bottom: var(--space-xxs); }
	.gp-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
	.gp-count { color: var(--muted); font-variant-numeric: tabular-nums; font-size: var(--size-xs); line-height: var(--line-xs); }
	.gp-live {
		font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xs); border-radius: var(--radius-full);
		background: var(--neutral-3); color: var(--text);
	}
	.gp-open { display: inline-flex; align-items: center; padding: var(--space-xxs) var(--space-xs); color: var(--muted); border-radius: var(--radius-s); }
	.gp-open:hover { color: var(--text); }
	.gp-empty { margin: 0; padding: 0 var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	.gp-all {
		display: flex; flex-wrap: wrap; gap: var(--space-s); padding: var(--space-xs) var(--space-xs) 0;
		box-shadow: inset 0 var(--border-s) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s);
	}
	@media (max-width: 768px) {
		.gp-btn { height: 40px; }
		.gp-pick, .gp-open { min-height: 40px; }
	}
	@media (max-width: 640px) {
		.gp { position: static; }
		.gp-menu { left: 0; right: 0; width: auto; }
	}
</style>

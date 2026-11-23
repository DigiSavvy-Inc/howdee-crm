<script lang="ts">
	// Company combobox (#166): type to search existing companies (/api/companies/search);
	// ↑/↓ + Enter picks a match. Enter with nothing highlighted submits the form as typed —
	// the server finds-or-creates the company by name, so a new name creates it.
	let { name = 'company', value = '', placeholder = 'Acme Inc.' }: { name?: string; value?: string; placeholder?: string } = $props();

	type Option = { id: number; name: string; domain: string | null };
	// svelte-ignore state_referenced_locally
	let text = $state(value);
	let options = $state<Option[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;
	const listId = `company-picker-${Math.random().toString(36).slice(2, 8)}`;

	const exact = $derived(options.some((o) => o.name.toLowerCase() === text.trim().toLowerCase()));

	async function search(q: string) {
		const mine = ++seq;
		if (!q.trim()) {
			options = [];
			return;
		}
		try {
			const res = await fetch(`/api/companies/search?q=${encodeURIComponent(q.trim())}`);
			const rows = res.ok ? ((await res.json()) as Option[]) : [];
			if (mine === seq) options = rows;
		} catch {
			if (mine === seq) options = [];
		}
	}

	function onInput() {
		open = true;
		active = -1;
		clearTimeout(timer);
		timer = setTimeout(() => search(text), 150);
	}

	function pick(o: Option) {
		text = o.name;
		open = false;
		active = -1;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			open = true;
			active = options.length ? (active + 1) % options.length : -1;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = options.length ? (active <= 0 ? options.length - 1 : active - 1) : -1;
		} else if (e.key === 'Enter' && open && active >= 0 && options[active]) {
			e.preventDefault();
			pick(options[active]);
		} else if (e.key === 'Escape' && open) {
			e.preventDefault();
			open = false;
			active = -1;
		}
	}
</script>

<span class="picker">
	<input
		{name}
		bind:value={text}
		{placeholder}
		autocomplete="off"
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={open && (options.length > 0 || !!text.trim())}
		aria-controls={listId}
		aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
		oninput={onInput}
		onkeydown={onKeydown}
		onfocus={() => text.trim() && (open = true)}
		onblur={() => setTimeout(() => (open = false), 120)}
	/>
	{#if open && (options.length > 0 || text.trim())}
		<ul class="pop" id={listId} role="listbox">
			{#each options as o, i (o.id)}
				<li id="{listId}-{i}" role="option" aria-selected={i === active} class:active={i === active}>
					<button type="button" tabindex="-1" onmousedown={(e) => e.preventDefault()} onclick={() => pick(o)}>
						{o.name}{#if o.domain}<span class="muted"> · {o.domain}</span>{/if}
					</button>
				</li>
			{/each}
			{#if text.trim() && !exact}
				<li class="create muted" role="presentation">Enter saves “{text.trim()}” as a new company</li>
			{/if}
		</ul>
	{/if}
</span>

<style>
	.picker { position: relative; display: block; }
	.picker input { width: 100%; }
	.pop {
		position: absolute; top: calc(100% + var(--space-xxs)); left: 0; right: 0; z-index: 20;
		margin: 0; padding: var(--space-xxs); list-style: none; background: var(--surface);
		border: 0; border-radius: var(--radius-s);
		box-shadow: var(--border-shadow-s), var(--shadow-m); max-height: 16rem; overflow-y: auto;
	}
	/* Options: the theme's select option (highlighted = neutral-3). */
	.pop button {
		display: block; width: 100%; text-align: left; padding: var(--space-xxs) var(--space-xs);
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-regular);
		background: none; border: none; box-shadow: none; color: var(--neutral-10); border-radius: var(--radius-xs);
	}
	.pop li.active button, .pop button:hover { background: var(--neutral-3); }
	.create { padding: var(--space-xxs) var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); }
</style>

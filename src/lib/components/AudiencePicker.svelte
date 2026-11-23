<script lang="ts">
	// #332: pick several lists / segments as chips plus a searchable, grouped picker. Posts one
	// hidden `name` field per chosen group id (compose's include_id / exclude_id).
	import Icon from '$lib/components/Icon.svelte';

	type Group = { id: number; name: string; recipients: number; dynamic?: boolean };

	let {
		name,
		label,
		lists,
		segments,
		selected = $bindable([]),
		hidden = [],
		placeholder = 'Add a list or segment…'
	}: {
		name: string;
		label: string;
		lists: Group[];
		segments: Group[];
		selected?: number[];
		/** Ids chosen in the other picker — not offered here. */
		hidden?: number[];
		placeholder?: string;
	} = $props();

	const uid = $props.id();
	let query = $state('');
	let open = $state(false);
	let active = $state(0);

	const byId = $derived(new Map([...lists, ...segments].map((g) => [g.id, g])));
	const chosen = $derived(selected.map((id) => byId.get(id)).filter((g): g is Group => !!g));
	const match = (g: Group) => !selected.includes(g.id) && !hidden.includes(g.id) && g.name.toLowerCase().includes(query.trim().toLowerCase());
	const sections = $derived(
		[
			{ title: 'Lists', items: lists.filter(match) },
			{ title: 'Segments', items: segments.filter(match) }
		].filter((s) => s.items.length)
	);
	const flat = $derived(sections.flatMap((s) => s.items));

	function add(g: Group) {
		selected = [...selected, g.id];
		query = '';
		active = 0;
	}
	function remove(id: number) {
		selected = selected.filter((x) => x !== id);
	}
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			open = true;
			active = flat.length ? (active + 1) % flat.length : 0;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = flat.length ? (active - 1 + flat.length) % flat.length : 0;
		} else if (e.key === 'Enter') {
			if (open && flat[active]) {
				e.preventDefault();
				add(flat[active]);
			}
		} else if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Backspace' && !query && selected.length) {
			remove(selected[selected.length - 1]);
		}
	}
</script>

<div class="picker">
	<label class="cap" for="{uid}-q">{label}</label>
	{#each selected as id (id)}<input type="hidden" {name} value={id} />{/each}
	<div class="box">
		{#each chosen as g (g.id)}
			<span class="ap-chip">
				{g.name}
				<span class="muted">{g.recipients}</span>
				<button type="button" class="ap-x" aria-label="Remove {g.name}" onclick={() => remove(g.id)}><Icon name="close" size={16} /></button>
			</span>
		{/each}
		<input
			id="{uid}-q"
			class="ap-q"
			bind:value={query}
			{placeholder}
			autocomplete="off"
			role="combobox"
			aria-expanded={open && flat.length > 0}
			aria-controls="{uid}-list"
			aria-autocomplete="list"
			onfocus={() => (open = true)}
			oninput={() => ((open = true), (active = 0))}
			onblur={() => setTimeout(() => (open = false), 120)}
			{onkeydown}
		/>
	</div>
	{#if open && flat.length}
		<ul class="ap-list" id="{uid}-list" role="listbox" aria-label={label}>
			{#each sections as s (s.title)}
				<li class="ap-group" role="presentation">{s.title}</li>
				{#each s.items as g (g.id)}
					<li role="presentation">
						<button
							type="button"
							class="ap-opt"
							class:active={flat[active]?.id === g.id}
							role="option"
							aria-selected={flat[active]?.id === g.id}
							onmousedown={(e) => {
								e.preventDefault();
								add(g);
							}}
						>
							<span>{g.name}</span>
							<span class="muted">{g.recipients} subscribed</span>
						</button>
					</li>
				{/each}
			{/each}
		</ul>
	{/if}
</div>

<style>
	.picker {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.box {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xxs);
		padding: var(--space-xxs);
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		background: var(--surface);
	}
	.ap-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		padding: 0 0 0 var(--space-xs);
		border-radius: var(--radius-full);
		background: var(--bg);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--text);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.ap-x {
		display: inline-flex;
		padding: var(--space-xxs);
		background: transparent;
		border: none;
		border-radius: var(--radius-full);
		color: var(--muted);
	}
	.ap-x:hover {
		color: var(--text);
		filter: none;
	}
	.ap-q {
		flex: 1 1 10rem;
		min-width: 8rem;
		border: none;
		box-shadow: none;
		background: transparent;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.ap-q:focus {
		outline: none;
	}
	.box:focus-within {
		box-shadow: 0 0 0 var(--border-m, 2px) var(--accent);
	}
	.ap-list {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 20;
		margin: var(--space-xxs) 0 0;
		padding: var(--space-xxs);
		list-style: none;
		background: var(--surface);
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-m);
		max-height: 280px;
		overflow: auto;
	}
	.ap-group {
		padding: var(--space-xs) var(--space-xs) var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-heavy);
		color: var(--muted);
	}
	.ap-opt {
		display: flex;
		justify-content: space-between;
		gap: var(--space-s);
		width: 100%;
		text-align: left;
		padding: var(--space-xs);
		background: transparent;
		border: none;
		border-radius: var(--radius-xs);
		color: var(--text);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-regular);
	}
	.ap-opt:hover,
	.ap-opt.active {
		background: var(--bg);
		filter: none;
	}
</style>

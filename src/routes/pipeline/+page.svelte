<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	import { enhance, deserialize } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import Modal from '$lib/components/Modal.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import StagePill from '$lib/components/StagePill.svelte';
	import { relTime } from '$lib/reltime';
	import { formatValue, initials, sortCards, stageColorVar, type ListSort } from '$lib/pipeline';

	let { data, form } = $props();

	type Stage = (typeof data.board.stages)[number];
	type Card = Stage['cards'][number];

	// Local, optimistically-updated copy of the board; re-derived whenever the load reruns.
	let stages = $derived(data.board.stages.map((s) => ({ ...s, cards: [...s.cards] })));
	const openStages = $derived(stages.filter((s) => s.kind === 'open'));
	const closedStages = $derived(stages.filter((s) => s.kind !== 'open'));
	const allCards = $derived(stages.flatMap((s) => s.cards));
	const totalValue = $derived(allCards.reduce((a, c) => a + (c.value ?? 0), 0));
	const stageTotal = (s: Stage) => s.cards.reduce((a, c) => a + (c.value ?? 0), 0);

	// View: cookie/param choice wins; with none saved, phones (≤ 768px) default to the list.
	const narrow = new MediaQuery('max-width: 768px', false);
	const view = $derived(data.view ?? (narrow.current ? 'list' : 'kanban'));

	function urlWith(changes: Record<string, string | null>): string {
		const p = new URLSearchParams(page.url.searchParams.toString());
		for (const [k, v] of Object.entries(changes)) {
			if (v) p.set(k, v);
			else p.delete(k);
		}
		const s = p.toString();
		return s ? `?${s}` : '?';
	}

	// Filters: owner select + debounced search, all in the URL.
	// svelte-ignore state_referenced_locally
	let q = $state(data.filter.q);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(
			() => goto(urlWith({ q: q.trim() || null }), { replace: true, reset: false }),
			250
		);
	}
	function onOwnerChange(e: Event) {
		goto(urlWith({ owner: (e.currentTarget as HTMLSelectElement).value || null }), { reset: false });
	}

	let error = $state<string | null>(null);
	$effect(() => {
		if (form?.pipelineError) error = form.pipelineError;
	});

	// ---- card menu (⋯) ----
	let menuFor = $state<number | null>(null);
	let moveOpenFor = $state<number | null>(null);
	// Fixed-positioned so the board's / table's scroll boxes don't clip it.
	let menuPos = $state({ top: 0, right: 0 });
	function toggleMenu(e: MouseEvent, id: number) {
		e.stopPropagation();
		moveOpenFor = null;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menuPos = { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) };
		menuFor = menuFor === id ? null : id;
	}
	function closeMenus() {
		menuFor = null;
		moveOpenFor = null;
	}
	const closeAfter = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
		closeMenus();
		error = null;
		await update();
	};

	// ---- edit modal ----
	let editOpen = $state(false);
	let editing = $state<Card | null>(null);
	function openEdit(c: Card) {
		closeMenus();
		editing = c;
		editOpen = true;
	}

	// ---- add modal (contact typeahead → stage + value) ----
	let addOpen = $state(false);
	let addQ = $state('');
	let addPicked = $state<{ id: number; label: string } | null>(null);
	let addResults = $state<{ id: number; email: string; name: string | null; first_name: string | null; last_name: string | null }[]>([]);
	let addTimer: ReturnType<typeof setTimeout> | undefined;
	function onAddSearch() {
		addPicked = null;
		clearTimeout(addTimer);
		const term = addQ.trim();
		if (!term) {
			addResults = [];
			return;
		}
		addTimer = setTimeout(async () => {
			const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(term)}`);
			addResults = res.ok ? await res.json() : [];
		}, 200);
	}
	function contactLabel(r: { email: string; name: string | null; first_name: string | null; last_name: string | null }) {
		const n = r.name || [r.first_name, r.last_name].filter(Boolean).join(' ');
		return n ? `${n} · ${r.email}` : r.email;
	}
	function openAdd() {
		addQ = '';
		addPicked = null;
		addResults = [];
		addOpen = true;
	}

	// ---- drag & drop (native HTML5; the ⋯ menu is the keyboard/touch path) ----
	let dragId = $state<number | null>(null);
	let dropAt = $state<{ stageId: number; index: number } | null>(null);
	let expanded = $state<Record<number, boolean>>({});

	function onDragStart(e: DragEvent, c: Card) {
		dragId = c.contact_id;
		e.dataTransfer?.setData('text/plain', String(c.contact_id));
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function onDragEnd() {
		dragId = null;
		dropAt = null;
	}
	function indexFor(listEl: HTMLElement, y: number): number {
		const cards = [...listEl.querySelectorAll<HTMLElement>('[data-card]')].filter(
			(el) => Number(el.dataset.card) !== dragId
		);
		const i = cards.findIndex((el) => {
			const r = el.getBoundingClientRect();
			return y < r.top + r.height / 2;
		});
		return i < 0 ? cards.length : i;
	}
	function onDragOver(e: DragEvent, s: Stage) {
		if (dragId == null) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const list = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.cards');
		dropAt = { stageId: s.id, index: list ? indexFor(list, e.clientY) : 0 };
	}
	async function onDrop(e: DragEvent, s: Stage) {
		e.preventDefault();
		const id = dragId;
		const at = dropAt?.stageId === s.id ? dropAt.index : s.cards.length;
		onDragEnd();
		if (id == null) return;
		await moveTo(id, s.id, at);
	}

	/** Optimistic move, then the same `?/move` action the menu forms post. */
	async function moveTo(contactId: number, stageId: number, index?: number) {
		const from = stages.find((s) => s.cards.some((c) => c.contact_id === contactId));
		const to = stages.find((s) => s.id === stageId);
		if (!from || !to) return;
		const card = from.cards.find((c) => c.contact_id === contactId)!;
		const noop = from.id === to.id && (index === undefined || from.cards.indexOf(card) === index);
		if (noop) return;
		const rest = to.cards.filter((c) => c.contact_id !== contactId);
		const at = index === undefined ? rest.length : Math.min(index, rest.length);
		const moved = from.id === to.id ? card : { ...card, stage_id: to.id, stage_position: to.position, days_in_stage: 0 };
		const toCards = [...rest.slice(0, at), moved, ...rest.slice(at)];
		stages = stages.map((s) =>
			s.id === to.id
				? { ...s, cards: toCards }
				: s.id === from.id
					? { ...s, cards: s.cards.filter((c) => c.contact_id !== contactId) }
					: s
		);

		const fd = new FormData();
		fd.set('contact_id', String(contactId));
		fd.set('stage_id', String(stageId));
		if (index !== undefined) fd.set('position', String(at));
		const res = await fetch('?/move', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const result = deserialize(await res.text());
		error = result.type === 'failure' ? String(result.data?.pipelineError ?? 'Move failed.') : null;
		await invalidateAll();
	}

	// ---- list view sort (client-side) ----
	let sort = $state<ListSort>('stage');
	let dir = $state<'asc' | 'desc'>('asc');
	const listRows = $derived(sortCards(allCards, sort, dir));
	function sortBy(col: ListSort) {
		if (sort === col) dir = dir === 'asc' ? 'desc' : 'asc';
		else {
			sort = col;
			dir = col === 'value' || col === 'days' || col === 'activity' ? 'desc' : 'asc';
		}
	}
	function ariaSort(col: ListSort): 'ascending' | 'descending' | 'none' {
		return sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
	}
	const arrow = (col: ListSort): 'asc' | 'desc' | null => (sort === col ? dir : null);
	const stageById = $derived(new Map(stages.map((s) => [s.id, s])));
	const ownerLabel = (c: Card) => (c.owner_login ? c.owner_name || '@' + c.owner_login : '');
</script>

<svelte:head><title>Pipeline</title></svelte:head>
<svelte:window onclick={closeMenus} onkeydown={(e) => e.key === 'Escape' && closeMenus()} onresize={closeMenus} />
<svelte:document onscroll={() => menuFor != null && closeMenus()} />

{#snippet cardMenu(c: Card)}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="menu-wrap" onclick={(e) => e.stopPropagation()}>
		<button
			type="button"
			class="menu-btn"
			aria-label="Actions for {c.name}"
			aria-haspopup="menu"
			aria-expanded={menuFor === c.contact_id}
			onclick={(e) => toggleMenu(e, c.contact_id)}><Icon name="more" size={16} /></button
		>
		{#if menuFor === c.contact_id}
			<div class="menu" role="menu" style="top: {menuPos.top}px; right: {menuPos.right}px">
				<button type="button" role="menuitem" aria-expanded={moveOpenFor === c.contact_id}
					onclick={() => (moveOpenFor = moveOpenFor === c.contact_id ? null : c.contact_id)}><Icon name="move-stage" size={16} />Move to… <Icon name="chevron-right" size={16} class="sub-caret" /></button>
				{#if moveOpenFor === c.contact_id}
					<div class="submenu">
						{#each stages as s (s.id)}
							<form method="POST" action="?/move" use:enhance={closeAfter}>
								<input type="hidden" name="contact_id" value={c.contact_id} />
								<input type="hidden" name="stage_id" value={s.id} />
								<button type="submit" role="menuitem" disabled={s.id === c.stage_id}>
									<span class="dot" style="background: {stageColorVar(s.color)}"></span>{s.name}
								</button>
							</form>
						{/each}
					</div>
				{/if}
				<form method="POST" action="?/mark" use:enhance={closeAfter}>
					<input type="hidden" name="contact_id" value={c.contact_id} />
					<input type="hidden" name="kind" value="won" />
					<button type="submit" role="menuitem"><Icon name="stage-won" size={16} />Mark won</button>
				</form>
				<form method="POST" action="?/mark" use:enhance={closeAfter}>
					<input type="hidden" name="contact_id" value={c.contact_id} />
					<input type="hidden" name="kind" value="lost" />
					<button type="submit" role="menuitem"><Icon name="stage-lost" size={16} />Mark lost</button>
				</form>
				<button type="button" role="menuitem" onclick={() => openEdit(c)}><Icon name="edit" size={16} />Edit…</button>
				<a role="menuitem" href="/contacts/{c.contact_id}"><Icon name="contacts" size={16} />Open contact</a>
				<form method="POST" action="?/remove" use:enhance={closeAfter}>
					<input type="hidden" name="contact_id" value={c.contact_id} />
					<button type="submit" role="menuitem" class="danger"><Icon name="delete" size={16} />Remove</button>
				</form>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet column(s: Stage, compact: boolean)}
	{@const showCards = !compact || expanded[s.id] || dragId != null}
	<section
		class="col"
		class:compact
		class:over={dropAt?.stageId === s.id}
		aria-label="{s.name}: {s.cards.length} cards"
		ondragover={(e) => onDragOver(e, s)}
		ondrop={(e) => onDrop(e, s)}
		ondragleave={(e) => {
			if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropAt = null;
		}}
	>
		<header class="col-head">
			{#if s.kind === 'won' || s.kind === 'lost'}
				<span class="col-kind" style="color: {stageColorVar(s.color)}"><Icon name={s.kind === 'won' ? 'stage-won' : 'stage-lost'} size={16} /></span>
			{:else}
				<span class="dot" style="background: {stageColorVar(s.color)}" aria-hidden="true"></span>
			{/if}
			<strong class="col-name">{s.name}</strong>
			<span class="muted col-count">{s.cards.length}</span>
			<span class="muted col-total">{formatValue(stageTotal(s))}</span>
			{#if compact}
				<button type="button" class="link-btn" aria-expanded={!!expanded[s.id]}
					onclick={() => (expanded[s.id] = !expanded[s.id])}>{expanded[s.id] ? 'Hide' : 'Show'}</button>
			{/if}
		</header>
		{#if showCards}
			<ol class="cards">
				{#each s.cards as c, i (c.contact_id)}
					{#if dropAt?.stageId === s.id && dropAt.index === i && dragId !== c.contact_id}<li class="drop-line" aria-hidden="true"></li>{/if}
					<li
						class="kcard"
						class:dragging={dragId === c.contact_id}
						data-card={c.contact_id}
						draggable="true"
						ondragstart={(e) => onDragStart(e, c)}
						ondragend={onDragEnd}
					>
						<div class="kcard-top">
							<span class="grip"><Icon name="drag-handle" size={16} /></span>
							<Avatar contactId={c.contact_id} name={c.name} size={24} />
							<a class="kname" href="/contacts/{c.contact_id}" draggable="false">{c.name}</a>
							{@render cardMenu(c)}
						</div>
						{#if c.company}<div class="muted kco">{c.company}</div>{/if}
						<div class="kmeta">
							<span class="kval">{c.value == null ? '' : formatValue(c.value)}</span>
							<span class="muted" title="Entered {c.entered_stage_at} UTC">{c.days_in_stage}d</span>
							{#if c.owner_login}<span class="owner" title={ownerLabel(c)}>{initials(c.owner_name || c.owner_login)}</span>{/if}
						</div>
					</li>
				{/each}
				{#if dropAt?.stageId === s.id && dropAt.index >= s.cards.filter((c) => c.contact_id !== dragId).length}<li class="drop-line" aria-hidden="true"></li>{/if}
			</ol>
			{#if s.cards.length === 0 && !compact}<p class="muted empty">No cards</p>{/if}
		{/if}
	</section>
{/snippet}

<div class="head">
	<h1>Pipeline</h1>
	<span class="muted count">{allCards.length} · {formatValue(totalValue)}</span>
	<div class="view-toggle" role="group" aria-label="View">
		<a href={urlWith({ view: 'kanban' })} class:active={view === 'kanban'} aria-current={view === 'kanban' ? 'true' : undefined} data-sveltekit-reset="false"><Icon name="kanban" size={16} />Board</a>
		<a href={urlWith({ view: 'list' })} class:active={view === 'list'} aria-current={view === 'list' ? 'true' : undefined} data-sveltekit-reset="false"><Icon name="list" size={16} />List</a>
	</div>
	{#if data.isAdmin}<a class="gear" href="/pipeline/stages" title="Edit stages" aria-label="Edit stages"><Icon name="settings" size={20} /></a>{/if}
	<button type="button" class="add-btn" onclick={openAdd}>+ Add to pipeline</button>
</div>

<div class="filters">
	<label class="owner-filter">
		<span class="sr-only">Owner</span>
		<select value={data.filter.owner} onchange={onOwnerChange} aria-label="Owner">
			<option value="">All owners</option>
			<option value="none">Unassigned</option>
			{#each data.owners as u (u.id)}<option value={String(u.id)}>@{u.github_login}</option>{/each}
		</select>
	</label>
	<input type="search" class="search" bind:value={q} oninput={onSearchInput}
		placeholder="Search name, email or company…" aria-label="Search the pipeline" autocomplete="off" spellcheck="false" />
</div>

{#if error}<p class="err" role="alert">{error}</p>{/if}
{#if form?.pipelineOk && !error}<p class="ok" role="status">{form.pipelineOk}</p>{/if}

{#if view === 'kanban'}
	<div class="board" onscroll={closeMenus}>
		{#each openStages as s (s.id)}{@render column(s, false)}{/each}
		{#each closedStages as s (s.id)}{@render column(s, true)}{/each}
	</div>
{:else}
	<section class="card">
		{#if listRows.length === 0}
			<p class="muted">{data.filter.q || data.filter.owner ? 'No cards match.' : 'Nobody in the pipeline yet — add a contact.'}</p>
		{:else}
			<div class="table-wrap" onscroll={closeMenus}>
				<table>
					<thead>
						<tr>
							<th aria-sort={ariaSort('name')}><button type="button" class="sort" onclick={() => sortBy('name')}>Contact<SortCaret dir={arrow('name')} /></button></th>
							<th aria-sort={ariaSort('stage')}><button type="button" class="sort" onclick={() => sortBy('stage')}>Stage<SortCaret dir={arrow('stage')} /></button></th>
							<th class="num" aria-sort={ariaSort('value')}><button type="button" class="sort" onclick={() => sortBy('value')}>Value<SortCaret dir={arrow('value')} /></button></th>
							<th aria-sort={ariaSort('owner')}><button type="button" class="sort" onclick={() => sortBy('owner')}>Owner<SortCaret dir={arrow('owner')} /></button></th>
							<th class="num" aria-sort={ariaSort('days')}><button type="button" class="sort" onclick={() => sortBy('days')}>In stage<SortCaret dir={arrow('days')} /></button></th>
							<th aria-sort={ariaSort('activity')}><button type="button" class="sort" onclick={() => sortBy('activity')}>Last activity<SortCaret dir={arrow('activity')} /></button></th>
							<th><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each listRows as c (c.contact_id)}
							{@const st = stageById.get(c.stage_id)}
							<tr>
								<td>
									<div class="lname">
										<Avatar contactId={c.contact_id} name={c.name} size={24} />
										<span>
											<a href="/contacts/{c.contact_id}">{c.name}</a>
											{#if c.company}<span class="muted lco">{c.company}</span>{/if}
										</span>
									</div>
								</td>
								<td>
									<form method="POST" action="?/move" use:enhance={closeAfter} class="stage-form">
										<input type="hidden" name="contact_id" value={c.contact_id} />
										<span class="dot" style="background: {stageColorVar(st?.color)}" aria-hidden="true"></span>
										<select name="stage_id" value={String(c.stage_id)} aria-label="Stage for {c.name}"
											onchange={(e) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit()}>
											{#each stages as s (s.id)}<option value={String(s.id)}>{s.name}</option>{/each}
										</select>
										<noscript><button type="submit">Move</button></noscript>
									</form>
								</td>
								<td class="num">{formatValue(c.value)}</td>
								<td>{#if c.owner_login}<span title={ownerLabel(c)}>@{c.owner_login}</span>{:else}<span class="muted">—</span>{/if}</td>
								<td class="num">{c.days_in_stage}d</td>
								<td class="muted">{c.last_activity_at ? relTime(c.last_activity_at) : '—'}</td>
								<td class="act">{@render cardMenu(c)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<Modal title="Add to pipeline" bind:open={addOpen}>
	<form
		method="POST"
		action="?/add"
		class="mform"
		use:enhance={() => async ({ result, update }) => {
			if (result.type === 'success') addOpen = false;
			await update();
		}}
	>
		<label class="typeahead">
			Contact
			<input type="search" bind:value={addQ} oninput={onAddSearch} placeholder="Search name or email…" autocomplete="off" required={!addPicked} />
			<input type="hidden" name="contact_id" value={addPicked?.id ?? ''} />
			{#if addResults.length && !addPicked}
				<ul class="results" role="listbox">
					{#each addResults as r (r.id)}
						<li>
							<button type="button" role="option" aria-selected="false"
								onclick={() => {
									addPicked = { id: r.id, label: contactLabel(r) };
									addQ = contactLabel(r);
									addResults = [];
								}}>{contactLabel(r)}</button>
						</li>
					{/each}
				</ul>
			{/if}
		</label>
		<label>
			Stage
			<select name="stage_id" required>
				{#each stages as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
			</select>
		</label>
		<label>
			Value <span class="muted">(optional)</span>
			<input name="value" inputmode="numeric" placeholder="1200" autocomplete="off" />
		</label>
		<label>
			Owner
			<select name="owner" value={data.me ? String(data.me) : ''}>
				<option value="">Unassigned</option>
				{#each data.owners as u (u.id)}<option value={String(u.id)}>@{u.github_login}</option>{/each}
			</select>
		</label>
		<button type="submit" disabled={!addPicked}>Add</button>
		{#if form?.pipelineError && addOpen}<p class="err">{form.pipelineError}</p>{/if}
	</form>
</Modal>

<Modal title={editing ? `Edit · ${editing.name}` : 'Edit'} bind:open={editOpen}>
	{#if editing}
		<form
			method="POST"
			action="?/edit"
			class="mform"
			use:enhance={() => async ({ result, update }) => {
				if (result.type === 'success') editOpen = false;
				await update();
			}}
		>
			<input type="hidden" name="contact_id" value={editing.contact_id} />
			<label>
				Value
				<input name="value" inputmode="numeric" value={editing.value ?? ''} placeholder="1200" autocomplete="off" />
			</label>
			<label>
				Owner
				<select name="owner" value={editing.owner_user_id ? String(editing.owner_user_id) : ''}>
					<option value="">Unassigned</option>
					{#each data.owners as u (u.id)}<option value={String(u.id)}>@{u.github_login}</option>{/each}
				</select>
			</label>
			<label>
				Note
				<textarea name="note" rows="3" maxlength="2000">{editing.note ?? ''}</textarea>
			</label>
			<button type="submit">Save</button>
			{#if form?.pipelineError && editOpen}<p class="err">{form.pipelineError}</p>{/if}
		</form>
	{/if}
</Modal>

<style>
	.head { display: flex; align-items: center; gap: var(--space-s); margin-bottom: var(--space-s); flex-wrap: wrap; }
	h1 { margin: 0; }
	.count { margin-right: auto; }
	.view-toggle { display: inline-flex; border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); overflow: hidden; }
	.view-toggle a { display: inline-flex; align-items: center; gap: var(--space-xs); padding: var(--space-xxs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--text); text-decoration: none; }
	.view-toggle a + a { box-shadow: inset var(--border-s) 0 0 var(--border); }
	.view-toggle a:hover { text-decoration: none; background: var(--neutral-muted); }
	.view-toggle a.active { background: var(--neutral-muted); font-weight: var(--weight-ui-heavy); }
	.gear { display: inline-flex; color: var(--muted); padding: var(--space-xxs) var(--space-xs); }
	.gear:hover { color: var(--text); text-decoration: none; }
	.add-btn { padding: var(--space-xs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.filters { display: flex; gap: var(--space-xs); margin-bottom: var(--space-s); flex-wrap: wrap; }
	.search { flex: 1; max-width: 340px; }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); }
	.ok { color: var(--success); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

	/* Kanban */
	.board { display: flex; gap: var(--space-s); overflow-x: auto; padding-bottom: var(--space-s); align-items: flex-start; }
	.col {
		flex: 0 0 260px; background: var(--surface-subtle); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius); padding: var(--space-xs); min-height: 8rem;
	}
	.col.compact { flex-basis: 190px; min-height: 0; }
	.col.over { box-shadow: 0 0 0 var(--border-s) var(--accent); }
	.col-head { display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-xxs) var(--space-xxs) var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); flex-wrap: wrap; }
	.col-name { overflow-wrap: anywhere; }
	.col-total { margin-left: auto; font-variant-numeric: tabular-nums; }
	.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); min-height: 2rem; }
	.kcard {
		background: var(--surface); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius);
		padding: var(--space-xs) var(--space-s); cursor: grab; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
	}
	.kcard.dragging { opacity: 0.4; }
	.kcard-top { display: flex; align-items: center; gap: var(--space-xs); }
	.grip { display: inline-flex; color: var(--muted); margin-left: calc(-1 * var(--space-xxs)); margin-right: calc(-1 * var(--space-xxs)); opacity: 0.6; }
	.kcard:hover .grip { opacity: 1; }
	.col-kind { display: inline-flex; }
	.kname { flex: 1; min-width: 0; font-weight: var(--weight-ui-heavy); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.kco { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0 0 0 calc(24px + 16px + 2 * var(--space-xs) - 2 * var(--space-xxs)); overflow-wrap: anywhere; }
	.kmeta { display: flex; align-items: center; gap: var(--space-xs); margin-top: var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.kval { font-weight: var(--weight-ui-heavy); font-variant-numeric: tabular-nums; margin-right: auto; }
	.owner {
		display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
		background: var(--neutral-muted); color: var(--text); font-size: var(--size-xxs); line-height: var(--line-xxs); letter-spacing: var(--letter-spacing-xxs); font-weight: var(--weight-ui-heavy);
	}
	.drop-line { height: 3px; border-radius: var(--radius-xs); background: var(--accent); }
	.empty { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); text-align: center; margin: var(--space-xs) 0; }
	.link-btn {
		background: none; border: none; padding: 0; font: inherit; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); color: var(--link);
		text-decoration: underline; text-decoration-color: var(--link-underline); text-decoration-thickness: var(--link-underline-thickness); text-underline-offset: var(--link-underline-offset); cursor: pointer; box-shadow: none;
	}
	.link-btn:hover { background: none; box-shadow: none; color: var(--link-hover); text-decoration-thickness: var(--link-underline-thickness-hover); }

	/* ⋯ menu */
	.menu-wrap { position: relative; }
	.menu-btn {
		display: inline-flex; align-items: center; padding: 0 var(--space-xxs); background: transparent; border: 0;
		box-shadow: none; color: var(--muted);
	}
	.menu-btn:hover, .menu-btn[aria-expanded='true'] { box-shadow: 0 0 0 var(--border-s) var(--border); color: var(--text); background: var(--surface); }
	.menu {
		position: fixed; z-index: 50; min-width: 11rem; max-height: 70vh; overflow-y: auto;
		background: var(--surface); border: 0; border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium); padding: var(--space-xxs); display: flex; flex-direction: column;
	}
	.menu form { margin: 0; }
	.menu button, .menu a {
		display: flex; align-items: center; gap: var(--space-xs); width: 100%; text-align: left; padding: var(--space-xs) var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s); background: transparent; border: none; box-shadow: none; color: var(--text); border-radius: var(--radius-xs);
	}
	.menu button:hover:not(:disabled), .menu a:hover { background: var(--neutral-muted); text-decoration: none; }
	.menu button:disabled { color: var(--muted); }
	.menu .danger { color: var(--danger); }
	.menu :global(.sub-caret) { margin-left: auto; }
	.submenu { padding-left: var(--space-s); box-shadow: inset var(--border-l) 0 0 var(--border); margin: 0 0 var(--space-xxs) var(--space-xs); }

	/* List */
	button.sort {
		background: none; border: none; box-shadow: none; padding: 0; font: inherit; font-weight: var(--weight-ui-heavy);
		color: inherit; cursor: pointer; white-space: nowrap;
	}
	button.sort:hover { color: var(--link-hover); }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	.lname { display: flex; align-items: center; gap: var(--space-xs); }
	.lco { display: block; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.stage-form { display: inline-flex; align-items: center; gap: var(--space-xs); margin: 0; }
	.stage-form select { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); padding: var(--space-xxs) var(--space-xxs); }
	td.act { width: 2.5rem; }

	/* Modals */
	.mform { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.mform label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.mform button[type='submit'] { align-self: flex-start; }
	.typeahead { position: relative; }
	.results {
		list-style: none; margin: 0; padding: var(--space-xxs); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius);
		background: var(--surface); max-height: 14rem; overflow-y: auto;
	}
	.results button {
		width: 100%; text-align: left; background: transparent; border: none; box-shadow: none; padding: var(--space-xs) var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s); color: var(--text);
	}
	.results button:hover { background: var(--neutral-muted); }

	@media (max-width: 768px) {
		.search { max-width: none; }
		.menu-btn { min-width: 40px; min-height: 40px; }
		.menu button, .menu a { min-height: 40px; }
	}
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import type { SubmitFunction } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import BulkBar from '$lib/components/BulkBar.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	let { data, form } = $props();
	const canCreate = $derived(data.kind !== 'company'); // companies derive from contacts.company
	const kindWord = $derived(data.label.toLowerCase());

	let createOpen = $state(false);

	// Bulk selection (#215) — pruned to the rows on screen whenever the page reloads.
	let selected = $state<number[]>([]);
	$effect(() => {
		const onPage = new Set(data.groups.map((g) => g.id));
		const kept = selected.filter((id) => onPage.has(id));
		if (kept.length !== selected.length) selected = kept;
	});
	const allSelected = $derived(data.groups.length > 0 && selected.length === data.groups.length);
	const selectedRows = $derived(data.groups.filter((g) => selected.includes(g.id)));
	function toggle(id: number, on: boolean) {
		selected = on ? [...selected, id] : selected.filter((x) => x !== id);
	}

	function autosFor(id: number) {
		return data.automations.filter((a) => a.trigger_list_id === id);
	}

	// Delete modal: typed confirm past confirmMembers members or when an automation triggers
	// from the selection (the server re-checks).
	let deleteOpen = $state(false);
	let deleteConfirm = $state('');
	const deleteMembers = $derived(selectedRows.reduce((n, g) => n + (g.dynamic ? 0 : g.count), 0));
	const deleteAutos = $derived(data.automations.filter((a) => selected.includes(a.trigger_list_id)));
	const deleteActive = $derived(deleteAutos.filter((a) => a.status === 'active'));
	const deleteSent = $derived(selectedRows.filter((g) => g.campaign_count > 0));
	// #228: segment rules / Conditions that use the groups being deleted (not the skipped ones).
	const deleteRefs = $derived(
		data.ruleRefs.filter((r) => selectedRows.some((g) => g.id === r.groupId && g.campaign_count === 0))
	);
	const deleteSegRules = $derived(deleteRefs.filter((r) => r.kind === 'segment'));
	const deleteConditions = $derived([
		...new Map(deleteRefs.filter((r) => r.kind === 'condition').map((r) => [r.id, r])).values()
	]);
	const needTyped = $derived(deleteMembers > data.confirmMembers || deleteAutos.length > 0);

	let mergeOpen = $state(false);
	let mergeInto = $state('');
	let mergeNewName = $state('');
	let emptyOpen = $state(false);

	let renamingId = $state<number | null>(null);
	let renameValue = $state('');
	function startRename(id: number) {
		const g = data.groups.find((x) => x.id === id);
		if (!g) return;
		renamingId = id;
		renameValue = g.name;
	}

	$effect(() => {
		if (!deleteOpen) deleteConfirm = '';
	});
	$effect(() => {
		if (mergeOpen && !selected.includes(Number(mergeInto))) mergeInto = selected[0] ? String(selected[0]) : '';
		if (!mergeOpen) mergeNewName = '';
	});

	const exportHref = $derived(`/groups/${data.kind}/export?${selected.map((id) => `id=${id}`).join('&')}`);

	// #472: archive / restore (admin-only). The modal lists refused groups with the reason and
	// the segment / Condition rules that use the rest (they keep working: members stay).
	let archiveOpen = $state(false);
	let restoreOpen = $state(false);
	const archiveRefs = $derived(data.ruleRefs.filter((r) => selected.includes(r.groupId) && !data.archiveBlocks[r.groupId]));
	const archiveOk = $derived(selectedRows.filter((g) => !data.archiveBlocks[g.id]));

	function viewHref(archived: boolean): string {
		const p = new URLSearchParams();
		if (data.q) p.set('q', data.q);
		if (data.sort !== 'members') p.set('sort', data.sort);
		if (archived) p.set('archived', '1');
		const s = p.toString();
		return s ? `?${s}` : '?';
	}

	function sortHref(key: string): string {
		const p = new URLSearchParams();
		if (data.q) p.set('q', data.q);
		if (data.archived) p.set('archived', '1');
		if (key !== 'members') p.set('sort', key);
		const s = p.toString();
		return s ? `?${s}` : '?';
	}

	const bulkEnhance: SubmitFunction = () => async ({ update, result }) => {
		await update({ reset: false });
		if (result.type === 'success') {
			selected = [];
			deleteOpen = false;
			mergeOpen = false;
			emptyOpen = false;
			archiveOpen = false;
			restoreOpen = false;
			renamingId = null;
		}
	};
</script>

<svelte:head><title>All {data.plural}</title></svelte:head>

<Breadcrumbs items={[{ label: 'Contacts', href: '/contacts' }, { label: data.plural }]} />

<div class="head">
	<h1>{data.plural}</h1>
	<span class="muted count">{data.groups.length}</span>
	<form method="GET" class="search" role="search">
		<input name="q" value={data.q} placeholder="Search {data.plural.toLowerCase()}" aria-label="Search {data.plural.toLowerCase()}" />
		{#if data.sort !== 'members'}<input type="hidden" name="sort" value={data.sort} />{/if}
		{#if data.archived}<input type="hidden" name="archived" value="1" />{/if}
	</form>
	{#if data.archivable}
		<nav class="view-toggle" aria-label="Show">
			<a href={viewHref(false)} aria-current={!data.archived ? 'page' : undefined}>Active</a>
			<a href={viewHref(true)} aria-current={data.archived ? 'page' : undefined}>Archived</a>
		</nav>
	{/if}
	{#if canCreate}
		<button type="button" class="secondary new-btn" onclick={() => (createOpen = true)}>+ New {kindWord}</button>
	{/if}
</div>

{#if canCreate}
	<Modal title="New {kindWord}" bind:open={createOpen}>
		<form
			method="POST"
			action="?/create"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') createOpen = false;
				}}
			class="create-form"
		>
			<label>
				Name
				<!-- svelte-ignore a11y_autofocus -->
				<input name="name" autofocus required maxlength="60" placeholder="e.g. Newsletter subscribers" />
			</label>
			<label>
				Description <span class="muted">(optional)</span>
				<input name="description" maxlength="500" placeholder="What is this {kindWord} for?" autocomplete="off" />
			</label>
			<label>
				Origin / consent <span class="muted">(optional — how do contacts get here?)</span>
				<input name="origin" maxlength="500" placeholder="e.g. Double opt-in via website footer form" autocomplete="off" />
			</label>
			<button type="submit">Create {kindWord}</button>
		</form>
		{#if form?.error}<p class="err">{form.error}</p>{/if}
	</Modal>
{/if}

{#if form?.bulkMessage}<p class="bulk-flash" role="status">{form.bulkMessage}</p>{/if}
{#if form?.bulkError}<p class="bulk-flash err" role="alert">{form.bulkError}</p>{/if}

<section class="card">
	{#if data.groups.length === 0}
		<p class="muted">
			{#if data.q}
				No {data.plural.toLowerCase()} match “{data.q}”. <a href={data.archived ? '?archived=1' : '?'}>Clear search</a>
			{:else if data.archived}
				No archived {data.plural.toLowerCase()}.
			{:else}
				No {data.plural.toLowerCase()} yet.
				{#if data.kind === 'company'}Set a contact's company and it groups here automatically.{/if}
			{/if}
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						{#if data.manageable}
							<th class="cb">
								<input
									type="checkbox"
									aria-label="Select all {data.plural.toLowerCase()} on this page"
									checked={allSelected}
									onchange={(e) => (selected = e.currentTarget.checked ? data.groups.map((g) => g.id) : [])}
								/>
							</th>
						{/if}
						<th><a href={sortHref('name')}>{data.label}<SortCaret dir={data.sort === 'name' ? 'asc' : null} /></a></th>
						<th>Kind</th>
						<th><a href={sortHref('members')}>Contacts<SortCaret dir={data.sort === 'members' ? 'desc' : null} /></a></th>
						<th><a href={sortHref('created')}>Created<SortCaret dir={data.sort === 'created' ? 'desc' : null} /></a></th>
						<th>Last used</th>
						<th>Automations</th>
					</tr>
				</thead>
				<tbody>
					{#each data.groups as g (g.id)}
						{@const autos = autosFor(g.id)}
						<tr class:sel={selected.includes(g.id)}>
							{#if data.manageable}
								<td class="cb">
									<input
										type="checkbox"
										aria-label="Select {g.name}"
										checked={selected.includes(g.id)}
										onchange={(e) => toggle(g.id, e.currentTarget.checked)}
									/>
								</td>
							{/if}
							<td>
								{#if renamingId === g.id}
									<form method="POST" action="?/rename" use:enhance={bulkEnhance} class="rename-form">
										<input type="hidden" name="id" value={g.id} />
										<!-- svelte-ignore a11y_autofocus -->
										<input
											name="name"
											bind:value={renameValue}
											maxlength="60"
											required
											autofocus
											aria-label="New name for {g.name}"
											onkeydown={(e) => {
												if (e.key === 'Escape') renamingId = null;
											}}
										/>
										<button type="submit" class="small">Save</button>
										<button type="button" class="secondary small" onclick={() => (renamingId = null)}>Cancel</button>
									</form>
									{#if form?.renameError && form?.renameId === g.id}<p class="err">{form.renameError}</p>{/if}
								{:else}
									<a href="/lists/{g.id}">{g.name}</a>
									{#if g.description}<div class="muted desc">{g.description}</div>{/if}
									{#if form?.renameError && form?.renameId === g.id}<p class="err">{form.renameError}</p>{/if}
								{/if}
							</td>
							<td><span class="badge">{g.dynamic ? 'dynamic segment' : kindWord}</span></td>
							<td>{g.count}</td>
							<td class="muted">
								{g.created_at.slice(0, 10)}
								{#if g.archived_at}<div class="desc">Archived {g.archived_at.slice(0, 10)}</div>{/if}
							</td>
							<td class="muted">{g.last_used ? g.last_used.slice(0, 10) : '—'}</td>
							<td>
								{#if autos.length > 0}
									<span title={autos.map((a) => `${a.name} (${a.status})`).join(', ')}>{autos.length}</span>
								{:else}<span class="muted">0</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if data.manageable && selected.length > 0}
		<BulkBar count="{selected.length} selected" onClear={() => (selected = [])}>
			<div class="bulk-group">
				{#if selected.length === 1}
					<button type="button" class="secondary" onclick={() => startRename(selected[0])}>Rename</button>
				{/if}
				{#if data.mergeable}
					<button type="button" class="secondary" onclick={() => (mergeOpen = true)}>Merge</button>
				{/if}
				<button type="button" class="secondary" onclick={() => (emptyOpen = true)}>Empty</button>
				<a class="button-link" href={exportHref} download>Export CSV</a>
			</div>
			<div class="bulk-group">
				{#if data.archivable && data.isAdmin}
					{#if data.archived}
						<button type="button" class="secondary" onclick={() => (restoreOpen = true)}>Restore</button>
					{:else}
						<button type="button" class="secondary" onclick={() => (archiveOpen = true)}>Archive</button>
					{/if}
				{/if}
				<button type="button" class="danger" onclick={() => (deleteOpen = true)}>Delete</button>
			</div>
		</BulkBar>
	{/if}
</section>

<Modal title="Delete {selected.length} {selected.length === 1 ? kindWord : data.plural.toLowerCase()}?" bind:open={deleteOpen}>
	<form method="POST" action="?/delete" use:enhance={bulkEnhance} class="modal-form">
		{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
		<ul class="item-list">
			{#each selectedRows as g (g.id)}
				{@const autos = autosFor(g.id)}
				<li>
					<span class="item-name">{g.name}</span>
					<span class="muted">
						{g.count} contact{g.count === 1 ? '' : 's'}{#if g.dynamic} (by rules){/if}
						· {autos.filter((a) => a.status === 'active').length} active automation{autos.filter((a) => a.status === 'active').length === 1 ? '' : 's'}
						{#if g.campaign_count > 0}· sent to by {g.campaign_count} campaign{g.campaign_count === 1 ? '' : 's'}, will be skipped{/if}
					</span>
				</li>
			{/each}
		</ul>
		<p>
			Memberships are removed; <strong>contacts are never deleted</strong>.
			{#if data.kind === 'segment'}A segment's rules are deleted with it.{/if}
			This cannot be undone.
		</p>
		{#if deleteAutos.length > 0}
			<div class="warn-box">
				<p><strong>These automations trigger from the selection.</strong> They lose their trigger{#if deleteActive.length > 0}, and the active ones will be set to <strong>paused</strong>{/if} (labelled “trigger deleted”):</p>
				<ul>
					{#each deleteAutos as a (a.id)}<li><a href="/automations/{a.id}">{a.name}</a> <span class="muted">({a.status === 'active' ? 'active → paused' : a.status})</span></li>{/each}
				</ul>
			</div>
		{/if}
		{#if deleteRefs.length > 0}
			<div class="warn-box">
				<p>
					<strong>
						Used in {deleteSegRules.length} segment rule{deleteSegRules.length === 1 ? '' : 's'} /
						{deleteConditions.length} condition{deleteConditions.length === 1 ? '' : 's'}.
					</strong>
					Those rules will be marked “Deleted list”: a segment ignores them, a condition counts them as not matching.
				</p>
				<ul>
					{#each deleteSegRules as r, i (i)}<li>Segment <a href="/lists/{r.id}">{r.name}</a></li>{/each}
					{#each deleteConditions as r (r.id)}<li>Condition in <a href="/automations/{r.automationId}">{r.name}</a></li>{/each}
				</ul>
			</div>
		{/if}
		{#if deleteSent.length > 0}
			<p class="muted">A group a campaign was sent to is kept for the send history — empty it instead.</p>
		{/if}
		{#if needTyped}
			<label class="confirm-field">
				Type <code>delete</code> to confirm
				<input name="confirm" bind:value={deleteConfirm} autocomplete="off" />
			</label>
		{/if}
		<div class="modal-actions">
			<button type="button" class="secondary" onclick={() => (deleteOpen = false)}>Cancel</button>
			<button type="submit" class="danger" disabled={needTyped && deleteConfirm.trim().toLowerCase() !== 'delete'}>
				Delete {selected.length}
			</button>
		</div>
	</form>
</Modal>

{#if data.mergeable}
	<Modal title="Merge {selected.length} {data.plural.toLowerCase()}" bind:open={mergeOpen}>
		<form method="POST" action="?/merge" use:enhance={bulkEnhance} class="modal-form">
			{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
			<label class="field">
				Keep
				<select name="into" bind:value={mergeInto} disabled={mergeNewName.trim() !== ''}>
					{#each selectedRows as g (g.id)}<option value={String(g.id)}>{g.name} ({g.count})</option>{/each}
				</select>
			</label>
			<label class="field">
				…or merge into a new name <span class="muted">(an existing {kindWord} of that name is kept)</span>
				<input name="new_name" bind:value={mergeNewName} maxlength="60" autocomplete="off" placeholder="New {kindWord} name" />
			</label>
			<p>
				Contacts in the others are added to the kept {kindWord} (each contact once). Automation triggers and
				conditions{#if data.kind === 'tag'}, segment rules, tag steps and webhook default tags{:else}, campaigns and webhook default lists{/if}
				that point at them are repointed, then the others are deleted. Contacts moved by a merge don't start
				automations again.
			</p>
			{#if form?.mergeError}<p class="err">{form.mergeError}</p>{/if}
			<div class="modal-actions">
				<button type="button" class="secondary" onclick={() => (mergeOpen = false)}>Cancel</button>
				<button type="submit" disabled={mergeNewName.trim() === '' && selected.length < 2}>Merge</button>
			</div>
		</form>
	</Modal>
{/if}

{#if data.archivable && data.isAdmin}
	<Modal title="Archive {selected.length} {selected.length === 1 ? kindWord : data.plural.toLowerCase()}?" bind:open={archiveOpen}>
		<form method="POST" action="?/archive" use:enhance={bulkEnhance} class="modal-form">
			{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
			<ul class="item-list">
				{#each selectedRows as g (g.id)}
					<li>
						<span class="item-name">{g.name}</span>
						<span class="muted">
							{#if data.archiveBlocks[g.id]}can't be archived: {data.archiveBlocks[g.id]}{:else}{g.count} contact{g.count === 1 ? '' : 's'}{/if}
						</span>
					</li>
				{/each}
			</ul>
			<p>
				Archived {data.plural.toLowerCase()} are hidden from pickers and this page's Active view. Members, campaign
				history and reports are kept, and Restore brings them back exactly as they were.
			</p>
			{#if archiveRefs.length > 0}
				<div class="warn-box">
					<p><strong>Still used in rules.</strong> These keep working (members stay), but the group is hidden from pickers:</p>
					<ul>
						{#each archiveRefs as r, i (i)}
							{#if r.kind === 'segment'}<li>Segment <a href="/lists/{r.id}">{r.name}</a></li>
							{:else}<li>Condition in <a href="/automations/{r.automationId}">{r.name}</a></li>{/if}
						{/each}
					</ul>
				</div>
			{/if}
			<div class="modal-actions">
				<button type="button" class="secondary" onclick={() => (archiveOpen = false)}>Cancel</button>
				<button type="submit" disabled={archiveOk.length === 0}>Archive {archiveOk.length}</button>
			</div>
		</form>
	</Modal>

	<Modal title="Restore {selected.length} {selected.length === 1 ? kindWord : data.plural.toLowerCase()}?" bind:open={restoreOpen}>
		<form method="POST" action="?/restore" use:enhance={bulkEnhance} class="modal-form">
			{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
			<ul class="item-list">
				{#each selectedRows as g (g.id)}<li><span class="item-name">{g.name}</span></li>{/each}
			</ul>
			<p>They come back in pickers and the Active view, exactly as they were.</p>
			<div class="modal-actions">
				<button type="button" class="secondary" onclick={() => (restoreOpen = false)}>Cancel</button>
				<button type="submit">Restore {selected.length}</button>
			</div>
		</form>
	</Modal>
{/if}

<Modal title="Empty {selected.length} {selected.length === 1 ? kindWord : data.plural.toLowerCase()}?" bind:open={emptyOpen}>
	<form method="POST" action="?/empty" use:enhance={bulkEnhance} class="modal-form">
		{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
		<ul class="item-list">
			{#each selectedRows as g (g.id)}
				<li>
					<span class="item-name">{g.name}</span>
					<span class="muted">{#if g.dynamic}dynamic — skipped{:else}{g.count} contact{g.count === 1 ? '' : 's'}{/if}</span>
				</li>
			{/each}
		</ul>
		<p>Every member is removed; the {data.plural.toLowerCase()} and the contacts stay.</p>
		<div class="modal-actions">
			<button type="button" class="secondary" onclick={() => (emptyOpen = false)}>Cancel</button>
			<button type="submit" class="danger">Empty {selected.length}</button>
		</div>
	</form>
</Modal>

<style>
	.head { display: flex; align-items: baseline; gap: var(--space-s); margin-bottom: var(--space-m); flex-wrap: wrap; row-gap: var(--space-s); }
	h1 { margin: 0; }
	.count { margin-right: auto; }
	.search { margin: 0; }
	.view-toggle { display: flex; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.view-toggle a { padding: var(--space-xxs) var(--space-xs); border-radius: var(--radius-xs); color: var(--muted); text-decoration: none; }
	.view-toggle a[aria-current='page'] { color: var(--text); box-shadow: 0 0 0 var(--border-s) var(--border); }
	.search input { width: 14rem; max-width: 100%; }
	.new-btn { padding: var(--space-xs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	@media (max-width: 640px) {
		.new-btn { padding: var(--space-xxs) var(--space-s); }
	}
	.create-form { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.create-form label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.create-form button { align-self: flex-start; }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.desc { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); max-width: 28rem; }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	form { margin: 0; }
	th a { color: inherit; text-decoration: none; white-space: nowrap; }
	th.cb,
	td.cb { width: 1.75rem; padding-right: 0; }
	tr.sel td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
	.rename-form { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
	.rename-form input[name='name'] { width: 14rem; max-width: 100%; }
	.bulk-flash {
		margin: 0 0 var(--space-s);
		padding: var(--space-xs) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		background: var(--surface);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		overflow-wrap: anywhere;
	}
	.bulk-flash.err { color: var(--danger); box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 35%, var(--border)); }
	.bulk-group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	.modal-actions button { padding: var(--space-xs) var(--space-s); }
	.button-link {
		display: inline-flex;
		align-items: center;
		box-sizing: border-box;
		height: 36px;
		padding: var(--space-xs) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		text-decoration: none;
		color: var(--text);
	}
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	.modal-form { display: flex; flex-direction: column; gap: var(--space-s); }
	.modal-form p { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.item-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		max-height: 14rem;
		overflow-y: auto;
	}
	.item-list li { display: flex; flex-wrap: wrap; gap: var(--space-xxs) var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.item-name { font-weight: var(--weight-ui-medium); }
	.warn-box {
		padding: var(--space-xs) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warn) 45%, var(--border));
		border-radius: var(--radius-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.warn-box ul { margin: var(--space-xs) 0 0; padding-left: var(--space-m); }
	.field,
	.confirm-field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-xs); }
</style>

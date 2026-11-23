<script lang="ts">
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import BulkBar from '$lib/components/BulkBar.svelte';
	import RecipeCards from '$lib/components/automations/RecipeCards.svelte';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { triggerSummary } from '$lib/automation-trigger';
	import { shortDate } from '$lib/automation-editor';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import { automationsFilterUrl, STATUS_OPTIONS, TAG_CHIP_LIMIT } from '$lib/automations-filter';
	let { data, form } = $props();

	// `?new=1` (the dashboard's "New automation" button, #133) opens the create modal.
	let createOpen = $state(page.url.searchParams.get('new') === '1');

	function badgeClass(status: string): string {
		if (status === 'active') return 'sent';
		if (status === 'paused') return 'sending';
		return 'draft';
	}
	function delayless(s: string): string {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}

	// Filter bar (#74) — status + tag both live in the URL, so a filtered view is
	// bookmarkable (mirrors /contacts' urlWith()). The status also persists in a cookie
	// (#200); `data.filter.status` is the effective one, so links carry it either way.
	// #432: automation labels are called "tags" in the UI; the filter param is `?tag=`.
	const filtered = $derived(!!(data.filter.tag || data.filter.status));
	const tagSearch = $derived(data.labelCounts.length > TAG_CHIP_LIMIT);
	const tagOptions = $derived(data.labelCounts.map((lc) => ({ value: lc.label, label: lc.label, detail: String(lc.count) })));
	const sameTag = (l: string) => data.filter.tag?.toLowerCase() === l.toLowerCase();

	function urlWith(overrides: Record<string, string | null>): string {
		// #579: every filter link keeps the search; only "Clear search" (a plain /automations link) drops it.
		return automationsFilterUrl(data.filter, { ...(data.q ? { q: data.q } : {}), ...overrides });
	}

	// Bulk selection (#164). Ids are pruned to the rows on screen whenever the list reloads
	// (after a bulk action, a filter change, or a delete).
	let selected = $state<number[]>([]);
	$effect(() => {
		const onPage = new Set(data.automations.map((a) => a.id));
		const kept = selected.filter((id) => onPage.has(id));
		if (kept.length !== selected.length) selected = kept;
	});
	const allSelected = $derived(data.automations.length > 0 && selected.length === data.automations.length);
	const selectedRows = $derived(data.automations.filter((a) => selected.includes(a.id)));
	const selectedActive = $derived(selectedRows.reduce((n, a) => n + a.active_count, 0));
	const selectedSent = $derived(selectedRows.filter((a) => a.campaign_count > 0));

	function toggle(id: number, on: boolean) {
		selected = on ? [...selected, id] : selected.filter((x) => x !== id);
	}

	// Bulk forms post to `?/<action>&<current filter>` so the re-rendered page keeps the
	// status/tag filter even without JS.
	const filterSuffix = $derived.by(() => {
		const q = urlWith({}).slice(1);
		return q ? `&${q}` : '';
	});

	let bulkLabelName = $state('');
	let deleteOpen = $state(false);
	let deleteConfirm = $state('');
	$effect(() => {
		if (!deleteOpen) deleteConfirm = '';
	});

	const bulkEnhance: SubmitFunction = () => async ({ update, result }) => {
		await update({ reset: false });
		if (result.type === 'success') {
			selected = [];
			bulkLabelName = '';
			deleteOpen = false;
		}
	};
</script>

<svelte:head><title>Automations</title></svelte:head>

<div class="head">
	<h1>
		Automations
		{#if filtered || data.q}
			<span class="muted">{data.matched} of {data.total}</span>
		{:else}
			<span class="muted">{data.total}</span>
		{/if}
	</h1>
	<button type="button" onclick={() => (createOpen = true)}>+ New automation</button>
</div>

<Modal title="New automation" bind:open={createOpen}>
	<form
		method="POST"
		action="?/create"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success' || result.type === 'redirect') createOpen = false;
			}}
		class="newform"
	>
		<!-- svelte-ignore a11y_autofocus -->
		<input name="name" type="text" autofocus placeholder="e.g. Welcome series" aria-label="Automation name" />
		<button type="submit">Create</button>
	</form>
	{#if form?.error}<p class="err">{form.error}</p>{/if}
</Modal>

<RecipeCards
	recipes={data.recipes}
	lists={data.recipeLists}
	stages={data.recipeStages}
	error={form?.recipeError ?? null}
	errorKey={form?.recipeKey ?? null}
/>

{#if data.q}
	<!-- #477: arrived from the search palette's "See all N automations". -->
	<p class="muted small">Name or tag matching “{data.q}” · <a href="/automations">Clear search</a></p>
{/if}

<div class="filterbar">
	<nav class="status-seg" aria-label="Filter by status">
		{#each STATUS_OPTIONS as o (o.value)}
			{@const on = (data.filter.status ?? 'all') === o.value}
			<!-- #477: a status tab keeps the search; its counts are within the search too. -->
			<a class="seg" class:on href={urlWith({ status: o.value })} aria-current={on ? 'true' : undefined}>
				{#if o.value !== 'all'}<span class="dot {o.value}" aria-hidden="true"></span>{/if}
				{o.label}
				<span class="count">{data.statusCounts[o.value]}</span>
			</a>
		{/each}
	</nav>

	{#if data.labelCounts.length > 0}
		<div class="label-chips" role="group" aria-label="Filter by tag">
			<span class="tags-heading">Tags</span>
			{#if tagSearch}
				<!-- #432: many tags → a searchable picker plus the chip of the tag in use. -->
				{#key data.filter.tag}
					<SearchSelect
						value={data.filter.tag ?? ''}
						options={tagOptions}
						allowEmpty={{ label: 'All tags' }}
						placeholder="All tags"
						ariaLabel="Filter by tag"
						onpick={(v) => goto(urlWith({ tag: v === '' ? null : String(v) }))}
					/>
				{/key}
				{#if data.filter.tag}
					<a class="chip-link on" href={urlWith({ tag: null })} title="Stop filtering by this tag" aria-label="Remove tag filter {data.filter.tag}">
						{data.filter.tag} <Icon name="close" size={14} />
					</a>
				{/if}
			{:else}
				{#each data.labelCounts as lc (lc.label)}
					<a class="chip-link" class:on={sameTag(lc.label)} href={urlWith({ tag: sameTag(lc.label) ? null : lc.label })}>
						{lc.label} <span class="count">{lc.count}</span>
					</a>
				{/each}
			{/if}
		</div>
	{/if}

	{#if filtered}<a class="clear" href={urlWith({ tag: null, status: 'all' })}>Clear</a>{/if}
</div>

{#if form?.bulkMessage}<p class="bulk-flash" role="status">{form.bulkMessage}</p>{/if}
{#if form?.bulkError}<p class="bulk-flash err" role="alert">{form.bulkError}</p>{/if}

<section class="card list">
	{#if data.automations.length === 0}
		<p class="muted">
			{#if data.q}
				No automations match “{data.q}”.
				{#if filtered}<a href={urlWith({ tag: null, status: 'all' })}>Clear filters</a> ·{/if}
				<a href="/automations">Clear search</a>
			{:else if filtered}
				No automations match. <a href={urlWith({ tag: null, status: 'all' })}>Clear filters</a>
			{:else}
				No automations yet. Create one to build a timed email sequence.
			{/if}
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th class="cb">
							<input
								type="checkbox"
								aria-label="Select all automations on this page"
								checked={allSelected}
								onchange={(e) => (selected = e.currentTarget.checked ? data.automations.map((a) => a.id) : [])}
							/>
						</th>
						<th>Name</th><th>Tags</th><th>Status</th><th>Trigger</th><th>Steps</th><th>Active</th><th>Completed</th><th>Failed</th><th>Last activity</th>
					</tr>
				</thead>
				<tbody>
					{#each data.automations as a (a.id)}
						<tr class:sel={selected.includes(a.id)}>
							<td class="cb">
								<input
									type="checkbox"
									aria-label="Select {a.name}"
									checked={selected.includes(a.id)}
									onchange={(e) => toggle(a.id, e.currentTarget.checked)}
								/>
							</td>
							<td><a href="/automations/{a.id}">{a.name}</a></td>
							<td>
								{#if a.labels.length > 0}
									<div class="row-labels">
										{#each a.labels as l (l)}
											<a class="label-chip-sm" class:on={sameTag(l)} href={urlWith({ tag: l })} title="Show automations tagged {l}">{l}</a>
										{/each}
									</div>
								{:else}<span class="muted">—</span>{/if}
							</td>
							<td><span class="badge {badgeClass(a.status)}">{delayless(a.status)}</span></td>
							<td class="muted">{triggerSummary(a, data.triggerCtx)}</td>
							<td>{a.step_count}</td>
							<td>{a.active_count}</td>
							<td class="muted">{a.completed_count}</td>
							<td>
								{#if a.failed_count > 0}<a href="/automations/{a.id}?insp_status=failed#inspector">{a.failed_count}</a>{:else}<span class="muted">0</span>{/if}
							</td>
							<td class="muted">{a.last_activity_at ? shortDate(a.last_activity_at) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.labelCounts.length === 0}
			<p class="muted hint">
				No automation tags yet. Open an automation and use <strong>+ Tag</strong> next to its name, or tick a few rows
				here and use <strong>Add tag</strong>.
			</p>
		{/if}
	{/if}

	{#if selected.length > 0}
		<BulkBar count="{selected.length} selected" onClear={() => (selected = [])}>
			<form method="POST" action="?/bulkActivate{filterSuffix}" use:enhance={bulkEnhance} class="bulk-group">
				{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
				<button type="submit">Activate</button>
				<button type="submit" class="secondary" formaction="?/bulkPause{filterSuffix}">Pause</button>
			</form>
			<form method="POST" action="?/bulkAddLabel{filterSuffix}" use:enhance={bulkEnhance} class="bulk-group">
				{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
				<input
					name="label"
					bind:value={bulkLabelName}
					placeholder="tag"
					aria-label="Automation tag"
					list="bulk-label-options"
					autocomplete="off"
					maxlength="30"
					required
				/>
				<datalist id="bulk-label-options">
					{#each data.labelCounts as lc (lc.label)}<option value={lc.label}></option>{/each}
				</datalist>
				<button type="submit" class="secondary">Add tag</button>
				<button type="submit" class="secondary" formaction="?/bulkRemoveLabel{filterSuffix}">Remove tag</button>
			</form>
			<div class="bulk-group">
				<button type="button" class="danger" onclick={() => (deleteOpen = true)}>Delete</button>
			</div>
		</BulkBar>
	{/if}
</section>

<Modal title="Delete {selected.length} automation{selected.length === 1 ? '' : 's'}?" bind:open={deleteOpen}>
	<form method="POST" action="?/bulkDelete{filterSuffix}" use:enhance={bulkEnhance} class="delete-form">
		{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
		<ul class="delete-list">
			{#each selectedRows as a (a.id)}
				<li>
					<span class="delete-name">{a.name}</span>
					<span class="muted">
						{a.active_count} active enrollment{a.active_count === 1 ? '' : 's'}{#if a.campaign_count > 0}
							· has sent emails, will be skipped{/if}
					</span>
				</li>
			{/each}
		</ul>
		<p>
			<strong>{selectedActive} contact{selectedActive === 1 ? ' is' : 's are'}</strong> currently in these automations
			and will be removed from them. Steps, enrollment history and automation tags are deleted too. This cannot be undone.
		</p>
		{#if selectedSent.length > 0}
			<p class="muted">Automations that have already sent emails can't be deleted — pause them instead.</p>
		{/if}
		<label class="confirm-field">
			Type <code>delete</code> to confirm
			<input name="confirm" bind:value={deleteConfirm} autocomplete="off" />
		</label>
		<div class="delete-actions">
			<button type="button" class="secondary" onclick={() => (deleteOpen = false)}>Cancel</button>
			<button type="submit" class="danger" disabled={deleteConfirm.trim().toLowerCase() !== 'delete'}>
				Delete {selected.length}
			</button>
		</div>
	</form>
</Modal>

<section class="card engine-feed">
	<h2>Engine activity</h2>
	{#if data.tickLog.length === 0}
		<p class="muted">No engine activity logged yet.</p>
	{:else}
		<ul class="tick-list">
			{#each data.tickLog as t (t.id)}
				{@const parts = [
					`processed ${t.processed}`,
					t.sent > 0 ? `sent ${t.sent}` : null,
					t.advanced > 0 ? `advanced ${t.advanced}` : null,
					t.failed > 0 ? `failed ${t.failed}` : null,
					t.retried > 0 ? `retried ${t.retried}` : null
				].filter(Boolean)}
				<li class="tick-row"><span class="tick-time muted">{t.ran_at} UTC</span> · {parts.join(' · ')}</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s);
		margin-bottom: var(--space-m);
	}
	.newform {
		display: flex;
		gap: var(--space-xs);
		margin: 0;
	}
	.newform input {
		flex: 1;
	}
	.err {
		color: var(--danger);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		margin: var(--space-xs) 0 0;
	}
	.head h1 .muted {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-regular);
		margin-left: var(--space-xs);
	}
	.filterbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	/* Status segmented control (#200). Dots reuse the status badge colours (.badge.sent /
	   .sending / .draft in app.css). */
	.status-seg {
		display: inline-flex;
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}
	.seg {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--text);
		background: var(--surface);
		text-decoration: none;
		white-space: nowrap;
	}
	.seg + .seg {
		box-shadow: inset var(--border-s) 0 0 var(--border);
	}
	.seg:hover {
		background: var(--neutral-muted);
	}
	.seg.on {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text);
		font-weight: var(--weight-ui-medium);
	}
	.seg .count {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.seg.on .count {
		color: inherit;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		flex: none;
	}
	.dot.active {
		background: var(--success);
	}
	.dot.paused {
		background: var(--warn);
	}
	.dot.draft {
		background: var(--muted);
	}
	.label-chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}
	.tags-heading {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	.list .hint {
		margin: var(--space-s) 0 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.chip-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		padding: var(--space-xxs) var(--space-s);
		border-radius: var(--radius-full);
		background: var(--neutral-muted);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--text);
		text-decoration: none;
	}
	.chip-link .count {
		color: var(--muted);
	}
	.chip-link.on {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		color: var(--text);
	}
	.chip-link.on .count {
		color: inherit;
	}
	.filterbar .clear {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.row-labels {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xxs);
	}
	.label-chip-sm {
		display: inline-block;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		padding: 0 var(--space-xs);
		border-radius: var(--radius-full);
		background: var(--neutral-muted);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--muted);
	}
	a.label-chip-sm {
		text-decoration: none;
	}
	a.label-chip-sm:hover,
	a.label-chip-sm.on {
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		color: var(--text);
	}
	.list table a:not(.label-chip-sm) {
		font-weight: var(--weight-ui-medium);
	}
	th.cb,
	td.cb {
		width: 1.75rem;
		padding-right: 0;
	}
	tr.sel td {
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}
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
	.bulk-flash.err {
		color: var(--danger);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 35%, var(--border));
	}
	.bulk-group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		margin: 0;
		min-width: 0;
	}
	.bulk-group input {
		width: 10rem;
		max-width: 100%;
		min-width: 0;
	}
	.delete-actions button {
		padding: var(--space-xs) var(--space-s);
	}
	.delete-form {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.delete-form p {
		margin: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.delete-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		max-height: 14rem;
		overflow-y: auto;
	}
	.delete-list li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.delete-name {
		font-weight: var(--weight-ui-medium);
		overflow-wrap: anywhere;
	}
	.confirm-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.delete-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.engine-feed {
		margin-top: var(--space-m);
	}
	.engine-feed h2 {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		margin: 0 0 var(--space-xs);
	}
	.tick-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
	}
	.tick-row {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.tick-time {
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			align-items: flex-start;
			gap: var(--space-s);
		}
		.head button {
			padding: var(--space-xxs) var(--space-s);
		}
		.newform {
			flex-wrap: wrap;
		}
		.newform input {
			min-width: 0;
		}
		/* Four buttons → two rows of two, never a horizontal scroll. */
		.status-seg {
			display: grid;
			grid-template-columns: 1fr 1fr;
			width: 100%;
		}
		.seg + .seg {
			box-shadow: none;
		}
		.seg:nth-child(even) {
			box-shadow: inset var(--border-s) 0 0 var(--border);
		}
		.seg:nth-child(n + 3) {
			box-shadow: inset 0 var(--border-s) 0 var(--border);
		}
	}
</style>

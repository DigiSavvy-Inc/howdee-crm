<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { onMount, untrack } from 'svelte';
	import { TOPIC_BLURB_MAX, TOPIC_LABEL_MAX, topicDisplay } from '$lib/topics';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import Modal from '$lib/components/Modal.svelte';
	import ContactBulkBar from '$lib/components/ContactBulkBar.svelte';
	import ContactFilters from '$lib/components/ContactFilters.svelte';
	import RuleBuilder from '$lib/components/RuleBuilder.svelte';
	import type { SegmentRules } from '$lib/server/segment-query';
	import { conditionLabel, encodeCondition, groupMetrics, opsFor, visibleMetrics, type MetricCondition } from '$lib/company-metrics';

	let { data, form } = $props();
	const g = $derived(data.group);
	const isSegment = $derived(g.kind === 'segment');
	const kindLabel = $derived(
		g.kind === 'segment' ? 'Segment' : g.kind === 'tag' ? 'Tag' : g.kind === 'company' ? 'Company' : 'List'
	);
	const kindPlural = $derived(
		g.kind === 'segment' ? 'Segments' : g.kind === 'tag' ? 'Tags' : g.kind === 'company' ? 'Companies' : 'Lists'
	);

	let metaOpen = $state(false);
	// #414: topic fields in "Edit details" — refilled from the saved row each time it opens.
	let topicOn = $state(false);
	let topicLabelIn = $state('');
	let topicBlurbIn = $state('');
	$effect(() => {
		if (!metaOpen) return;
		untrack(() => {
			topicOn = g.public_topic === 1;
			topicLabelIn = g.topic_label ?? '';
			topicBlurbIn = g.topic_blurb ?? '';
		});
	});
	const topicShown = $derived(topicDisplay({ name: g.name, topic_label: topicLabelIn, topic_blurb: topicBlurbIn }));
	let rulesOpen = $state(false);
	let rules = $state<SegmentRules>(data.segRules as SegmentRules);

	// --- optional columns (per-browser preference) ---
	type ColKey = 'name' | 'status' | 'added' | 'source' | 'created' | 'tags';
	const COLUMNS: { key: ColKey; label: string }[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'status', label: 'Status' },
		{ key: 'added', label: 'Date added' },
		{ key: 'source', label: 'Source' },
		{ key: 'created', label: 'First seen' },
		{ key: 'tags', label: 'Tags' }
	];
	const COLS_KEY = 'ds-list-columns';
	let cols = $state<Record<ColKey, boolean>>({
		name: true,
		status: true,
		added: true,
		source: true,
		created: false,
		tags: false
	});
	let colsLoaded = $state(false);
	// Read the saved choice after hydration, so the server-rendered table (which can't
	// know it) matches the defaults on first paint, then save on every change.
	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null') as Partial<
				Record<ColKey, boolean>
			> | null;
			if (saved) for (const c of COLUMNS) if (typeof saved[c.key] === 'boolean') cols[c.key] = saved[c.key]!;
		} catch {
			/* ignore a corrupt preference */
		}
		colsLoaded = true;
	});
	$effect(() => {
		const snapshot = JSON.stringify(cols);
		if (!colsLoaded) return;
		try {
			localStorage.setItem(COLS_KEY, snapshot);
		} catch {
			/* private mode / quota — the toggle still works for this page view */
		}
	});
	// "Date added" only means anything where membership is stored rows (list_members).
	const visibleColumns = $derived(
		COLUMNS.filter((c) => (c.key === 'added' ? data.filterable : true) && cols[c.key])
	);
	const colCount = $derived(1 + 1 + visibleColumns.length + 1); // checkbox + email + on + row-action

	// --- popovers (filters / columns) ---
	let filtersOpen = $state(false);
	let colsOpen = $state(false);
	let filtersEl = $state<HTMLDetailsElement | null>(null);
	let colsEl = $state<HTMLDetailsElement | null>(null);
	function closeMenus(e: MouseEvent) {
		const t = e.target as Node;
		if (filtersOpen && filtersEl && !filtersEl.contains(t)) filtersOpen = false;
		if (colsOpen && colsEl && !colsEl.contains(t)) colsOpen = false;
	}

	// Bulk-select state. Shift-click range select, mirrors /contacts exactly — driven via
	// an explicit `selected` array (not bind:group) so the range fills in one update.
	let selected = $state<number[]>([]);
	let lastIndex = $state(-1);
	let selectAll = $state(false); // everything matching the filter (or rules), not just this page

	const allOnPage = $derived(data.members.length > 0 && selected.length === data.members.length);

	// Remove-from-group is only valid when membership is stored rows. Dynamic segments
	// (rules-based) have no list_members rows; company membership is derived from
	// contacts.company (synced automatically, not hand-editable).
	const canRemoveMembers = $derived(
		g.kind === 'list' || g.kind === 'tag' || (g.kind === 'segment' && !data.dynamic)
	);

	function toggleAll(e: Event) {
		const checked = (e.target as HTMLInputElement).checked;
		selected = checked ? data.members.map((c) => c.id) : [];
		lastIndex = -1;
		selectAll = false;
	}

	// Plain click toggles one row; shift-click fills the range to the clicked checkbox's
	// new state — same as /contacts.
	function rowClick(e: MouseEvent, i: number, id: number) {
		const willSelect = (e.target as HTMLInputElement).checked;
		const set = new Set(selected);
		if (e.shiftKey && lastIndex !== -1) {
			const [a, b] = lastIndex < i ? [lastIndex, i] : [i, lastIndex];
			for (const c of data.members.slice(a, b + 1)) {
				if (willSelect) set.add(c.id);
				else set.delete(c.id);
			}
		} else if (willSelect) {
			set.add(id);
		} else {
			set.delete(id);
		}
		selected = [...set];
		lastIndex = i;
		selectAll = false;
	}

	function clearSelection() {
		selected = [];
		lastIndex = -1;
		selectAll = false;
	}

	// --- links (always carry the active filter + page size) ---
	function urlWith(overrides: Record<string, string | number | null>): string {
		const p = new URLSearchParams(data.filterParams);
		p.set('per', String(data.per));
		for (const [k, v] of Object.entries(overrides)) {
			if (v === null || v === '') p.delete(k);
			else p.set(k, String(v));
		}
		return `?${p}`;
	}
	// Column → sort key. Stored-row groups sort by `memberQuery`'s keys; a dynamic segment
	// (#224) by the /contacts keys (`contactsOrder`), with no "Date added".
	const STATIC_SORTS: Record<string, string> = { email: 'email', name: 'name', status: 'status', added: 'added', created: 'created' };
	const DYNAMIC_SORTS: Record<string, string> = { email: 'email', name: 'name', status: 'subscribed', source: 'source', created: 'created_at' };
	function sortKeyOf(col: string): string | null {
		return (data.dynamic ? DYNAMIC_SORTS : STATIC_SORTS)[col] ?? null;
	}
	function sortUrl(key: string): string {
		const dir = data.sort === key && data.dir === 'desc' ? 'asc' : 'desc';
		return urlWith({ sort: key, dir, page: 1 });
	}
	function sortArrow(key: string): 'asc' | 'desc' | null {
		if (data.sort !== key) return null;
		return data.dir === 'asc' ? 'asc' : 'desc';
	}

	// #224: a dynamic segment's Filters popover keeps the page size and sort.
	const dynamicKeep = $derived({
		per: String(data.per),
		sort: data.filterParams.sort ?? '',
		dir: data.filterParams.dir ?? ''
	});

	// #224: "Exclude these / Require this" — confirm (with the count after) before saving.
	type Shortcut = NonNullable<typeof data.ruleShortcuts>['options'][number];
	let ruleOpen = $state(false);
	let pending = $state<{ option: Shortcut; mode: 'exclude' | 'require' } | null>(null);
	function openRule(option: Shortcut, mode: 'exclude' | 'require') {
		pending = { option, mode };
		ruleOpen = true;
	}
	const pendingChoice = $derived(pending ? pending.option[pending.mode] : null);
	function groupLabel(x: { name: string; kind: string }): string {
		return x.kind === 'list' ? x.name : `${x.name} (${x.kind})`;
	}

	// #170: company metric conditions — kept rows (checkboxes) + one new row, sent as `cm`.
	let cmMetric = $state('');
	let cmOps = $derived(opsFor(cmMetric));
	// #445: Billing metrics only for viewers who may see billing.
	const metricGroups = $derived(groupMetrics(visibleMetrics(data.billing)));
	const cmLabel = (m: MetricCondition) => conditionLabel(m, { billing: data.billing });

	// Filter form → a clean query string (no empty params).
	function applyFilters(e: SubmitEvent) {
		e.preventDefault();
		const fd = new FormData(e.currentTarget as HTMLFormElement);
		const p = new URLSearchParams();
		const cms: string[] = [];
		for (const [k, v] of fd) {
			const s = String(v).trim();
			if (!s) continue;
			if (k === 'status' && s === 'all') continue;
			if (k === 'cm_keep') {
				cms.push(s);
				continue;
			}
			if (k === 'cm_metric' || k === 'cm_op' || k === 'cm_value') continue;
			p.set(k, s);
		}
		const newValue = String(fd.get('cm_value') ?? '').trim();
		if (cmMetric && newValue !== '') cms.push(`${cmMetric}:${String(fd.get('cm_op') ?? '')}:${newValue}`);
		if (cms.length) p.set('cm', cms.join(','));
		p.set('per', String(data.per));
		if (data.filter.sort !== 'added') p.set('sort', data.filter.sort);
		if (data.filter.dir !== 'desc') p.set('dir', data.filter.dir);
		clearSelection();
		filtersOpen = false;
		goto(`?${p}`, { reset: false });
	}

	function groupName(id: number | null): string {
		return data.groups.find((x) => x.id === id)?.name ?? '';
	}

	const DATE_FMT = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	});
	// Stored as UTC "YYYY-MM-DD HH:MM:SS" — format in UTC so SSR and the client agree.
	function fmtDate(s: string | null): string {
		if (!s) return '—';
		const d = new Date(s.replace(' ', 'T') + 'Z');
		return isNaN(d.getTime()) ? s : DATE_FMT.format(d);
	}
</script>

<svelte:window onclick={closeMenus} />

<svelte:head><title>{g.name}</title></svelte:head>

<Breadcrumbs
	items={[{ label: 'Contacts', href: '/contacts' }, { label: kindPlural, href: `/groups/${g.kind}` }, { label: g.name }]}
/>

<div class="head">
	<h1>{g.name}</h1>
	<span class="badge {isSegment ? 'draft' : 'sent'}">{kindLabel}</span>
	<span class="muted count">
		{#if data.filterable && data.filtered}{data.matched} of {data.total} contacts
		{:else}{data.total} contact{data.total === 1 ? '' : 's'}{/if}
		<!-- #705: unsubscribed / archived members aren't shown or counted here. -->
		{#if data.hidden?.count}
			<span class="hidden-note" title="Unsubscribed and archived contacts are only shown on the Contacts page, with the Status or Archived filter.">
				{#each [{ label: 'unsubscribed', part: data.hidden.unsubscribed }, { label: 'archived', part: data.hidden.archived }] as h (h.label)}
					{#if h.part.count}
						{' '}· {h.part.count.toLocaleString('en-US')} {h.label}{#if h.part.href}{' '}(<a href={h.part.href}>view</a>){/if}
					{/if}
				{/each}
			</span>
		{/if}
	</span>
	<button type="button" class="secondary meta-btn" onclick={() => (metaOpen = true)}>Edit details</button>
	{#if data.archive.isAdmin && data.archive.archivable}
		{#if g.archived_at}
			<form method="POST" action="?/restoreGroup" use:enhance class="archive-form">
				<button type="submit" class="secondary meta-btn">Restore</button>
			</form>
		{:else}
			<form
				method="POST"
				action="?/archiveGroup"
				use:enhance={({ cancel }) => {
					if (!confirm(`Archive “${g.name}”? It's hidden from pickers; members and history are kept.`)) cancel();
				}}
				class="archive-form"
			>
				<button
					type="submit"
					class="secondary meta-btn"
					disabled={!!data.archive.block}
					title={data.archive.block ? `Can't archive: ${data.archive.block}` : undefined}>Archive</button
				>
			</form>
		{/if}
	{/if}
</div>

{#if g.archived_at}
	<p class="notice" role="status">Archived on {g.archived_at.slice(0, 10)}. Hidden from pickers.</p>
{/if}
{#if data.archive.block && !g.archived_at}
	<p class="muted archive-why">Can't archive: {data.archive.block}.</p>
{/if}
{#if form?.archiveError}<p class="notice err" role="alert">{form.archiveError}</p>{/if}
{#if form?.archiveOk}<p class="notice ok" role="status">{form.archiveOk}</p>{/if}

{#if g.description || g.origin}
	<div class="meta-block">
		{#if g.description}<p class="meta-desc">{g.description}</p>{/if}
		{#if g.origin}<p class="meta-origin muted"><strong>Origin / consent:</strong> {g.origin}</p>{/if}
	</div>
{:else}
	<p class="muted meta-empty">
		No description or origin recorded — for any audience you send to, note how its contacts
		got into the database. <button type="button" class="linkish" onclick={() => (metaOpen = true)}>Add it</button>
	</p>
{/if}

<Modal title="Edit {kindLabel.toLowerCase()} details" bind:open={metaOpen}>
	<form
		method="POST"
		action="?/updateMeta"
		use:enhance={() =>
			async ({ update, result }) => {
				await update({ reset: false });
				if (result.type === 'success') metaOpen = false;
			}}
		class="meta-form"
	>
		<label>
			Description <span class="muted">(what this {kindLabel.toLowerCase()} is for)</span>
			<textarea name="description" rows="2" maxlength="500" placeholder="e.g. Monthly newsletter audience">{g.description ?? ''}</textarea>
		</label>
		<label>
			Origin / consent
			<span class="muted">
				(how contacts got here — shown to recipients too: in the email footer as "You're
				receiving this email because: …" and on the unsubscribe page, so write it for them)
			</span>
			<textarea name="origin" rows="2" maxlength="500" placeholder="e.g. you signed up at example.com">{g.origin ?? ''}</textarea>
		</label>
		{#if g.kind === 'list'}
			<label class="topic-toggle">
				<input type="checkbox" name="public_topic" bind:checked={topicOn} />
				<span>Show as a <strong>subscription topic</strong> on the preference page <span class="muted">(recipients can opt in/out of this list when managing preferences)</span></span>
			</label>
			<!-- #414: subscribers see this label + blurb, never the list's name or description. -->
			<div class="topic-fields" hidden={!topicOn}>
				<label>
					Public label <span class="muted">(max {TOPIC_LABEL_MAX})</span>
					<input name="topic_label" bind:value={topicLabelIn} maxlength={TOPIC_LABEL_MAX} placeholder="e.g. Monthly newsletter" />
				</label>
				<label>
					Short description <span class="muted">(max {TOPIC_BLURB_MAX})</span>
					<input name="topic_blurb" bind:value={topicBlurbIn} maxlength={TOPIC_BLURB_MAX} placeholder="e.g. One email a month with what we shipped" />
				</label>
				<label class="topic-order">
					Order <span class="muted">(lower shows first)</span>
					<input name="topic_order" type="number" min="0" max="9999" step="1" value={g.topic_order ?? ''} />
				</label>
				<p class="topic-preview">
					{#if topicShown}
						How it appears: <strong>{topicShown.label}</strong>{#if topicShown.blurb} — {topicShown.blurb}{/if}
					{:else}
						<span class="warn-text">Hidden from subscribers until it has a public label — the list name looks internal.</span>
					{/if}
				</p>
			</div>
		{/if}
		<button type="submit">Save details</button>
	</form>
	{#if form?.metaError}<p class="err">{form.metaError}</p>{/if}
</Modal>

{#if isSegment}
	<section class="card seg-rules">
		<div class="sr-head">
			<h2>
				{#if data.dynamic}<span class="badge sent">Dynamic</span> Auto-updating segment{:else}Make this a dynamic segment{/if}
			</h2>
			<button type="button" class="secondary small" onclick={() => (rulesOpen = !rulesOpen)}>{rulesOpen ? 'Close' : data.dynamic ? 'Edit rules' : 'Add rules'}</button>
		</div>
		{#if data.dynamic}
			<p class="muted sr-note">Membership is computed live from the rules. Filters narrow this view; bulk actions apply to the filtered contacts.</p>
			{#if data.deletedRules > 0}
				<!-- #228: list rules whose group was deleted are left out of the compiled rules. -->
				<p class="sr-deleted" role="status">
					<Icon name="alert" size={16} />
					{data.deletedRules === 1 ? '1 rule references a deleted list and is ignored.' : `${data.deletedRules} rules reference a deleted list and are ignored.`}
					Edit rules to pick another list or remove {data.deletedRules === 1 ? 'it' : 'them'}.
				</p>
			{/if}
		{:else if !rulesOpen}
			<p class="muted sr-note">This is a hand-picked segment. Add rules to make it auto-update as contacts match (e.g. "tag is hot AND opened in the last 30 days").</p>
		{/if}
		{#if rulesOpen}
			<form method="POST" action="?/saveRules" use:enhance={() => async ({ update, result }) => { await update(); if (result.type === 'success') rulesOpen = false; }} class="sr-form">
				<RuleBuilder
					bind:rules
					companies={data.companyPicker}
					stages={data.stagePicker}
					topics={data.topicOptions}
					scores={data.scorePicks}
					fields={data.fieldPicks}
					forms={data.formOptions}
					tags={data.groups.filter((x) => x.kind === 'tag').map((x) => x.name)}
					groups={data.groups.filter((x) => x.kind !== 'tag' && !x.dynamic && x.id !== g.id)}
					metrics={visibleMetrics(data.billing)}
				/>
				<input type="hidden" name="rules" value={JSON.stringify(rules)} />
				<div class="sr-actions">
					<button type="submit">Save rules</button>
					<span class="muted">Save with no conditions to revert to a hand-picked segment.</span>
				</div>
			</form>
			{#if form?.rulesError}<p class="err">{form.rulesError}</p>{/if}
		{/if}
	</section>
{/if}

<section class="card">
	{#if form?.bulkError}<p class="err flash">{form.bulkError}</p>{/if}
	{#if form?.bulkSuccess}
		<p class="ok flash" role="status">{form.bulkSuccess}.{#if form.bulkHref}{' '}<a href={form.bulkHref}>Open</a>{/if}</p>
	{/if}

	{#if data.total === 0}
		<p class="muted">No contacts {data.dynamic ? 'match these rules yet' : `in this ${kindLabel.toLowerCase()} yet`}.</p>
	{:else}
		<div class="toolbar">
			<span class="muted range">
				{#if data.matched === 0}No matches{:else}Showing {data.from.toLocaleString('en-US')}–{data.to.toLocaleString('en-US')} of {data.matched.toLocaleString('en-US')}{#if data.dynamic && data.filtered}{' '}matching{/if}{/if}
			</span>
			<div class="tools">
				{#if data.filterable}
					<details class="menu" bind:this={filtersEl} bind:open={filtersOpen}>
						<summary class:on={data.filtered}>Filters{#if data.filtered}<span class="dot"></span>{/if}</summary>
						<form class="filters" method="GET" onsubmit={applyFilters}>
							<label>
								Search <span class="muted">name, email or company</span>
								<input name="q" value={data.filter.q} placeholder="jane, @gmail.com…" />
							</label>
							<label>
								Status
								<select name="status">
									<option value="all" selected={data.filter.status === 'all'}>Any (subscribed or pending)</option>
									<option value="subscribed" selected={data.filter.status === 'subscribed'}>Subscribed</option>
									<option value="pending" selected={data.filter.status === 'pending'}>Pending confirmation</option>
								</select>
							</label>
							<label>
								Source contains
								<input name="source" value={data.filter.source} placeholder="e.g. .csv, manual" />
							</label>
							<label>
								Added from
								<input type="date" name="added_from" value={data.filter.addedFrom} />
							</label>
							<label>
								Added to
								<input type="date" name="added_to" value={data.filter.addedTo} />
							</label>
							<label>
								Also in
								<select name="in">
									<option value="" selected={!data.filter.inGroup}>— any —</option>
									{#each data.groups as grp (grp.id)}
										{#if grp.id !== g.id}
											<option value={grp.id} selected={data.filter.inGroup === grp.id}>
												{grp.name}{grp.kind === 'list' ? '' : ` (${grp.kind})`}
											</option>
										{/if}
									{/each}
								</select>
							</label>
							<label>
								Not in
								<select name="notin">
									<option value="" selected={!data.filter.notInGroup}>— any —</option>
									{#each data.groups as grp (grp.id)}
										{#if grp.id !== g.id}
											<option value={grp.id} selected={data.filter.notInGroup === grp.id}>
												{grp.name}{grp.kind === 'list' ? '' : ` (${grp.kind})`}
											</option>
										{/if}
									{/each}
								</select>
							</label>
							<label>
								Has a company
								<select name="has_company">
									<option value="" selected={!data.filter.hasCompany}>— any —</option>
									<option value="yes" selected={data.filter.hasCompany === 'yes'}>Yes</option>
									<option value="no" selected={data.filter.hasCompany === 'no'}>No</option>
								</select>
							</label>
							<label>
								Submitted form
								<select name="form">
									<option value="" selected={!data.filter.form}>— no filter —</option>
									<option value="any" selected={data.filter.form === 'any'}>Any form</option>
									{#each data.formOptions as fo (fo.id)}
										<option value={fo.id} selected={data.filter.form === fo.id}>{fo.name}</option>
									{/each}
								</select>
							</label>
							<label>
								Submitted in the last N days
								<input type="number" name="form_days" min="1" max="3650" value={data.filter.formDays ?? ''} placeholder="any time" />
							</label>
							<div class="metric-filter">
								<span>Company metrics <span class="muted">(all must match)</span></span>
								{#each data.filter.metrics as m (encodeCondition(m))}
									<label class="mf-keep"><input type="checkbox" name="cm_keep" value={encodeCondition(m)} checked /> {cmLabel(m)}</label>
								{/each}
								{#if data.filter.metrics.length < 5}
									<div class="mf-row">
										<select name="cm_metric" bind:value={cmMetric} aria-label="Company metric">
											<option value="">Add a metric condition…</option>
											{#each metricGroups as mg (mg.group)}
												<optgroup label={mg.label}>{#each mg.metrics as cm (cm.key)}<option value={cm.key}>{cm.label}</option>{/each}</optgroup>
											{/each}
										</select>
										{#if cmMetric}
											<select name="cm_op" aria-label="Operator">
												{#each cmOps as o (o.op)}<option value={o.op}>{o.label}</option>{/each}
											</select>
											<input name="cm_value" type="number" step="any" placeholder={cmOps[0]?.op === 'older' ? 'days' : 'value'} aria-label="Value" />
										{/if}
									</div>
								{/if}
							</div>
							<div class="filter-actions">
								<button type="submit">Apply filters</button>
								{#if data.filtered}<a class="clear" href="?per={data.per}">Clear</a>{/if}
							</div>
						</form>
					</details>
				{:else if data.cfilter && data.groupOptions}
					<ContactFilters
						filter={data.cfilter}
						filtered={data.filtered}
						groupOptions={data.groupOptions}
						companyPicker={data.companyPicker}
						stagePicker={data.stagePicker}
						topicPicker={data.topicOptions}
						formPicker={data.formOptions}
						keep={dynamicKeep}
						clearHref="?per={data.per}"
						search
						billing={data.billing}
						onApply={clearSelection}
					/>
				{/if}

				<details class="menu" bind:this={colsEl} bind:open={colsOpen}>
					<summary title="Choose columns" aria-label="Choose columns"><Icon name="settings" size={16} /> Columns</summary>
					<div class="colmenu">
						{#each COLUMNS as c (c.key)}
							{#if c.key !== 'added' || data.filterable}
								<label class="colrow">
									<input type="checkbox" bind:checked={cols[c.key]} />
									{c.label}
								</label>
							{/if}
						{/each}
					</div>
				</details>

				<div class="per">
					<span class="muted">Per page:</span>
					{#each data.perOptions as opt (opt)}
						{#if opt === data.per}
							<span class="per-opt active">{opt}</span>
						{:else}
							<a class="per-opt" href={urlWith({ per: opt, page: 1 })} data-sveltekit-reset="false">{opt}</a>
						{/if}
					{/each}
				</div>
			</div>
		</div>

		{#if data.filterable && data.filtered}
			<p class="chips">
				{#if data.filter.q}<span class="chip">"{data.filter.q}"</span>{/if}
				{#if data.filter.status !== 'all'}<span class="chip">{data.filter.status}</span>{/if}
				{#if data.filter.source}<span class="chip">source ~ {data.filter.source}</span>{/if}
				{#if data.filter.addedFrom}<span class="chip">added ≥ {data.filter.addedFrom}</span>{/if}
				{#if data.filter.addedTo}<span class="chip">added ≤ {data.filter.addedTo}</span>{/if}
				{#if data.filter.inGroup}<span class="chip" title="in {groupName(data.filter.inGroup)}">in {groupName(data.filter.inGroup)}</span>{/if}
				{#if data.filter.notInGroup}<span class="chip" title="not in {groupName(data.filter.notInGroup)}">not in {groupName(data.filter.notInGroup)}</span>{/if}
				{#if data.filter.hasCompany}<span class="chip">{data.filter.hasCompany === 'yes' ? 'has a company' : 'no company'}</span>{/if}
				{#each data.filter.metrics as m (encodeCondition(m))}<span class="chip" title={cmLabel(m)}>{cmLabel(m)}</span>{/each}
				{#if data.filter.form}<span class="chip">submitted {data.filter.form === 'any' ? 'any form' : (data.formOptions.find((fo) => fo.id === data.filter.form)?.name ?? 'a deleted form')}{data.filter.formDays ? ` in ${data.filter.formDays} days` : ''}</span>{/if}
				<a class="clear" href="?per={data.per}">Clear filters</a>
			</p>
		{/if}

		{#if data.dynamic && data.filtered}
			<div class="chips rule-shortcuts">
				{#each data.ruleShortcuts?.options ?? [] as o (o.cond)}
					<span class="shortcut">
						<span class="chip" title="{o.cond === 'in' ? 'in' : 'not in'} {groupLabel(o.group)}">{o.cond === 'in' ? 'in' : 'not in'} {groupLabel(o.group)}</span>
						<button type="button" class="secondary small" onclick={() => openRule(o, 'exclude')}>Exclude these from this segment</button>
						<button type="button" class="secondary small" onclick={() => openRule(o, 'require')}>Require this for this segment</button>
					</span>
				{/each}
				{#if data.ruleShortcuts?.blocked}<span class="muted">{data.ruleShortcuts.blocked}</span>{/if}
				<a class="clear" href="?per={data.per}">Clear filters</a>
			</div>
			{#if form?.ruleError}<p class="err">{form.ruleError}</p>{/if}
		{/if}

		{#if selectAll || selected.length > 0}
			<ContactBulkBar
				{selected}
				all={selectAll}
				matched={data.matched}
				pageFull={allOnPage}
				cap={data.bulkCap}
				filterParams={data.filterParams}
				addTargets={data.groups
					.filter((x) => (x.kind === 'list' || x.kind === 'segment') && x.id !== g.id)
					.map((x) => ({ ...x, count: x.dynamic ? null : x.count }))}
				lists={data.groups.filter((x) => x.kind === 'list' && x.id !== g.id)}
				tags={data.groups.filter((x) => x.kind === 'tag')}
				automations={data.activeAutomations}
				groupMeta={data.groups}
				pageGroups={data.pageGroups}
				matchGroups={data.matchGroups}
				current={{ id: g.id, name: g.name, kind: kindLabel.toLowerCase(), removable: canRemoveMembers, dynamic: data.dynamic }}
				archiveMode="archive"
				scores={data.adjustScores}
				onSelectAll={() => (selectAll = true)}
				onClear={clearSelection}
				onDone={clearSelection}
			/>
		{/if}

		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th class="cb">
							<input
								type="checkbox"
								checked={allOnPage}
								onchange={toggleAll}
								aria-label="Select all on this page"
							/>
						</th>
						<th><a class="sort" href={sortUrl('email')} data-sveltekit-reset="false">Email<SortCaret dir={sortArrow('email')} /></a></th>
						{#each visibleColumns as c (c.key)}
							{@const sk = sortKeyOf(c.key)}
							{#if sk}
								<th><a class="sort" href={sortUrl(sk)} data-sveltekit-reset="false">{c.label}<SortCaret dir={sortArrow(sk)} /></a></th>
							{:else}
								<th>{c.label}</th>
							{/if}
						{/each}
						<th class="act-col"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.members as c, i (c.id)}
						<tr class:sel={selectAll || selected.includes(c.id)}>
							<td class="cb">
								<input
									type="checkbox"
									checked={selectAll || selected.includes(c.id)}
									onclick={(e) => rowClick(e, i, c.id)}
								/>
							</td>
							<td><a href="/contacts/{c.id}">{c.email}</a></td>
							{#each visibleColumns as col (col.key)}
								{#if col.key === 'name'}
									<td>{c.name || [c.first_name, c.last_name].filter(Boolean).join(' ')}</td>
								{:else if col.key === 'status'}
									<td>
										{#if c.subscribed}<span class="badge sent">Subscribed</span>
										{:else}<span class="badge failed">Unsubscribed</span>{/if}
									</td>
								{:else if col.key === 'added'}
									<td class="muted nowrap" title={c.added_at ?? ''}>{fmtDate(c.added_at)}</td>
								{:else if col.key === 'source'}
									<td class="muted">{c.source ?? ''}</td>
								{:else if col.key === 'created'}
									<td class="muted nowrap" title={c.created_at}>{fmtDate(c.created_at)}</td>
								{:else if col.key === 'tags'}
									<td class="tags">
										{#each data.tagsByContact[c.id] ?? [] as t (t)}<span class="badge">{t}</span>{/each}
									</td>
								{/if}
							{/each}
							<td class="act-col">
								<form
									class="row-form"
									method="POST"
									action="?/deleteContacts"
									use:enhance={({ cancel }) => {
										if (!confirm(`Delete ${c.email}? This permanently removes the contact and their campaign/tracking history everywhere. Unsubscribe records are kept. This cannot be undone.`)) {
											cancel();
											return;
										}
										return async ({ update }) => {
											await update();
											selected = selected.filter((id) => id !== c.id);
										};
									}}
								>
									<input type="hidden" name="contact_ids" value={c.id} />
									<button type="submit" class="row-x" title="Delete contact" aria-label="Delete contact"><Icon name="close" size={14} /></button>
								</form>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan={colCount} class="muted empty">
								No contacts match these filters. <a href="?per={data.per}">Clear filters</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.pageCount > 1}
			<nav class="pager">
				{#if data.page > 1}
					<a class="pg" href={urlWith({ page: data.page - 1 })} data-sveltekit-reset="false">← Prev</a>
				{:else}
					<span class="pg disabled">← Prev</span>
				{/if}
				<span class="muted pageinfo">Page {data.page} of {data.pageCount}</span>
				{#if data.page < data.pageCount}
					<a class="pg" href={urlWith({ page: data.page + 1 })} data-sveltekit-reset="false">Next →</a>
				{:else}
					<span class="pg disabled">Next →</span>
				{/if}
			</nav>
		{/if}
	{/if}
</section>

<Modal title={pending?.mode === 'require' ? 'Require this for this segment?' : 'Exclude these from this segment?'} bind:open={ruleOpen}>
	{#if pending && pendingChoice}
		<form method="POST" action="?/filterRule" use:enhance class="rule-form">
			<input type="hidden" name="cond" value={pending.option.cond} />
			<input type="hidden" name="group_id" value={pending.option.group.id} />
			<input type="hidden" name="mode" value={pending.mode} />
			<input type="hidden" name="per" value={data.per} />
			<p>Adds the rule <strong>{pendingChoice.text}</strong> to “{g.name}”, then clears the filter.</p>
			<p class="delta">
				{data.total.toLocaleString('en-US')} → <strong>{pendingChoice.count.toLocaleString('en-US')}</strong> contact{pendingChoice.count === 1 ? '' : 's'}
			</p>
			<div class="rule-actions">
				<button type="button" class="secondary" onclick={() => (ruleOpen = false)}>Cancel</button>
				<button type="submit">Add rule</button>
			</div>
		</form>
	{/if}
</Modal>

<style>
	.rule-shortcuts .shortcut { display: inline-flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; }
	.rule-form { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.rule-form p { margin: 0; }
	.rule-form .delta { font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.rule-actions { display: flex; justify-content: flex-end; gap: var(--space-xs); }
	.seg-rules { margin-bottom: var(--space-m); }
	.sr-deleted { display: flex; align-items: center; gap: var(--space-xs); margin: var(--space-xs) 0 0; padding: var(--space-xs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--text); background: color-mix(in srgb, var(--warn) 12%, transparent); border: 0; box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warn) 35%, var(--border)); border-radius: var(--radius); }
	.sr-deleted :global(svg) { color: var(--warn); flex: none; }
	.sr-head { display: flex; align-items: center; gap: var(--space-s); }
	.sr-head h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); display: flex; align-items: center; gap: var(--space-xs); }
	.sr-head .small { margin-left: auto; padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.sr-note { margin: var(--space-xs) 0 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.sr-form { margin-top: var(--space-s); display: flex; flex-direction: column; gap: var(--space-s); }
	.sr-actions { display: flex; align-items: center; gap: var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.topic-toggle { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.topic-toggle input { margin-top: var(--space-xxs); }
	.topic-fields { display: flex; flex-direction: column; gap: var(--space-s); padding-left: var(--space-l); }
	.topic-fields[hidden] { display: none; }
	.topic-order input { max-width: 8em; }
	.topic-preview { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.warn-text { color: var(--warn); }
	.archive-form { margin: 0; }
	.archive-form .meta-btn { margin-left: 0; }
	.archive-why { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.meta-btn { margin-left: auto;padding: var(--space-xs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.meta-block { margin: var(--space-xs) 0 var(--space-m); }
	.meta-desc { margin: 0 0 var(--space-xxs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.meta-origin { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.meta-empty { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.linkish {
		background: none; border: none; box-shadow: none; padding: 0; font-size: inherit;
		color: var(--link); cursor: pointer; text-decoration: underline; text-decoration-color: var(--link-underline); text-decoration-thickness: var(--link-underline-thickness); text-underline-offset: var(--link-underline-offset);
	}
	.linkish:hover { background: none; box-shadow: none; color: var(--link-hover); text-decoration-thickness: var(--link-underline-thickness-hover); }
	.meta-form { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.meta-form label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.meta-form textarea { resize: vertical; }
	.meta-form button { align-self: flex-start; }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.ok { color: var(--success); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	/* Bulk result banner, aligned with the card's content edge. */
	.flash { margin: 0 0 var(--space-m); padding: var(--space-xs) var(--space-s); border-radius: var(--radius-s); color: var(--text); }
	.ok.flash { background: color-mix(in srgb, var(--success) 12%, transparent); box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--success) 35%, var(--border)); }
	.err.flash { background: color-mix(in srgb, var(--danger) 10%, transparent); box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 35%, var(--border)); }
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-bottom: var(--space-m);
		flex-wrap: wrap;
	}
	h1 {
		margin: 0;
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
		word-break: break-word;
	}
	.count {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	@media (max-width: 640px) {
		.head {
			gap: var(--space-s);
		}
		h1 {
			flex: 1 1 100%;
		}
		.meta-btn {
			padding: var(--space-xxs) var(--space-s);
		}
	}
	/* #283: one row of same-height controls, centred on the range text. */
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-m);
		flex-wrap: wrap;
		margin-bottom: var(--space-s);
	}
	.range {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.tools {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		flex-wrap: wrap;
	}
	/* dropdown menus (filters, columns) */
	.menu {
		position: relative;
	}
	.menu summary {
		list-style: none;
		cursor: pointer;
		padding: var(--space-xxs) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		background: var(--btn-bg);
		user-select: none;
		white-space: nowrap;
	}
	.tools :global(.menu > summary) {
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		height: 36px;
	}
	.menu summary::-webkit-details-marker {
		display: none;
	}
	.menu summary:hover {
		background: var(--btn-hover);
	}
	.menu summary.on {
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		color: var(--text);
	}
	.dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-left: var(--space-xs);
		border-radius: var(--radius-full);
		background: var(--accent);
		vertical-align: middle;
	}
	.filters,
	.colmenu {
		position: absolute;
		right: 0;
		z-index: 20;
		margin-top: var(--space-xs);
		padding: var(--space-m);
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-lg);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
	}
	.filters {
		display: grid;
		grid-template-columns: repeat(2, minmax(150px, 1fr));
		gap: var(--space-s);
		width: min(94vw, 460px);
	}
	.filters label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	.filters input,
	.filters select {
		width: 100%;
	}
	.metric-filter { grid-column: 1 / -1; display: flex; flex-direction: column; gap: var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); color: var(--muted); }
	.metric-filter .mf-keep { flex-direction: row; align-items: center; gap: var(--space-xs); color: var(--text); }
	.metric-filter .mf-keep input { width: auto; }
	.mf-row { display: flex; gap: var(--space-xs); }
	.mf-row select, .mf-row input { width: auto; min-width: 0; flex: 1; }
	.filter-actions {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: var(--space-s);
	}
	.colmenu {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		min-width: 12rem;
	}
	.colrow {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.colrow input {
		width: auto;
	}
	@media (max-width: 640px) {
		/* anchor the popovers to the toolbar so they can't run off-screen */
		.toolbar {
			position: relative;
		}
		.menu {
			position: static;
		}
		.filters {
			left: 0;
			right: 0;
			width: auto;
		}
	}
	@media (max-width: 480px) {
		.filters {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.chips {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
		margin: 0 0 var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.chip {
		max-width: min(480px, 100%);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 var(--space-xs);
		border-radius: var(--radius-full);
		background: var(--neutral-muted);
		color: var(--text);
	}
	.clear {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.small {
		padding: var(--space-xxs) var(--space-xs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.cb {
		width: 1%;
		white-space: nowrap;
	}
	.nowrap {
		white-space: nowrap;
	}
	tr.sel {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	@media (max-width: 640px) {
		th.cb,
		td.cb {
			position: sticky;
			left: 0;
			z-index: 1;
			background: var(--surface);
		}
		th.cb {
			background: var(--surface-subtle);
		}
		tr.sel td.cb {
			background: color-mix(in srgb, var(--accent) 8%, var(--surface));
		}
	}
	th .sort {
		color: inherit;
	}
	.tags {
		display: table-cell;
	}
	.tags .badge {
		margin-right: var(--space-xxs);
	}
	.empty {
		text-align: center;
		padding: var(--space-l) 0;
	}
	.act-col { width: 1%; white-space: nowrap; }
	.row-form { margin: 0; display: inline-flex; }
	.row-x {
		padding: 0; width: 20px; height: 20px; line-height: 1; border: none; border-radius: var(--radius-full);
		background: transparent; color: var(--muted); box-shadow: none; font-size: var(--size-xs); letter-spacing: var(--letter-spacing-xs);
		opacity: 0; transition: opacity var(--motion-duration) var(--motion-easing);
	}
	tr:hover .row-x { opacity: 1; }
	.row-x:hover { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
	@media (max-width: 768px) {
		.row-x { min-width: 40px; min-height: 40px; opacity: 1; }
	}
	.per {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		padding-top: var(--space-xxs);
	}
	.per-opt {
		min-width: 1.9rem;
		text-align: center;
		padding: var(--space-xxs) var(--space-xs);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		color: var(--link);
	}
	.per-opt:hover {
		text-decoration: none;
		background: var(--neutral-muted);
	}
	.per-opt.active {
		background: var(--neutral-muted);
		color: var(--text);
		font-weight: var(--weight-ui-heavy);
		box-shadow: 0 0 0 var(--border-s) var(--border);
	}
	.pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-m);
		margin-top: var(--space-m);
		flex-wrap: wrap;
	}
	.pg {
		padding: var(--space-xs) var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--link);
	}
	.pg:hover {
		text-decoration: none;
		background: var(--neutral-muted);
	}
	.pg.disabled {
		color: var(--muted);
		opacity: 0.6;
		pointer-events: none;
	}
	.pageinfo {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
</style>

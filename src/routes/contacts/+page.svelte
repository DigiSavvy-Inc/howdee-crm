<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	import { enhance, deserialize } from '$app/forms';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Papa from 'papaparse';
	import { guessColumns } from '$lib/csv';
	import Modal from '$lib/components/Modal.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { isTier } from '$lib/engagement-view';
	import TierBadge from '$lib/components/TierBadge.svelte';
	import StagePill from '$lib/components/StagePill.svelte';
	import ContactBulkBar from '$lib/components/ContactBulkBar.svelte';
	import ContactFilters from '$lib/components/ContactFilters.svelte';
	import ContactsOverview from '$lib/components/ContactsOverview.svelte';
	import GroupPicker from '$lib/components/GroupPicker.svelte';
	import { chipOverrides } from '$lib/contact-filter-chips';

	let { data, form } = $props();

	// Column visibility (#55) — persisted per browser. Email is always shown (row link).
	const ALL_COLUMNS = [
		{ key: 'name', label: 'Name' },
		{ key: 'company', label: 'Company' },
		{ key: 'subscribed', label: 'Status' },
		{ key: 'source', label: 'Source' },
		{ key: 'created_at', label: 'Added' },
		{ key: 'tier', label: 'Tier' }, // #114 — optional: off until picked
		{ key: 'stage', label: 'Stage' }, // #207 — optional: off until picked
		{ key: 'score', label: 'Score' } // #467 — optional: one named score, picked below
	] as const;
	const OPTIONAL_COLS: string[] = ['tier', 'stage', 'score'];
	const DEFAULT_COLS: string[] = ALL_COLUMNS.filter((c) => !OPTIONAL_COLS.includes(c.key)).map((c) => c.key);
	const COLS_LS_KEY = 'contacts.columns';
	function loadCols(): string[] {
		if (!browser) return DEFAULT_COLS;
		try {
			const saved = JSON.parse(localStorage.getItem(COLS_LS_KEY) ?? 'null');
			if (Array.isArray(saved)) return saved.filter((k) => ALL_COLUMNS.some((c) => c.key === k));
		} catch {
			/* fall through to default */
		}
		return DEFAULT_COLS;
	}
	let visibleCols = $state(loadCols());
	let gearOpen = $state(false);
	function toggleCol(key: string) {
		visibleCols = visibleCols.includes(key) ? visibleCols.filter((k) => k !== key) : [...visibleCols, key];
		if (browser) localStorage.setItem(COLS_LS_KEY, JSON.stringify(visibleCols));
	}
	const show = $derived(new Set(visibleCols));
	// #467: which score the Score column shows — saved with the columns (`contacts.columns.score`).
	const SCORE_COL_LS_KEY = 'contacts.columns.score';
	function loadScoreCol(): number | null {
		if (!browser) return null;
		const n = Number(localStorage.getItem(SCORE_COL_LS_KEY));
		return Number.isInteger(n) && n > 0 ? n : null;
	}
	let scoreColPick = $state<number | null>(loadScoreCol());
	const scoreCol = $derived(data.scorePicks.find((s) => s.id === scoreColPick) ?? data.scorePicks[0] ?? null);
	function pickScoreCol(id: number) {
		scoreColPick = id;
		if (browser) localStorage.setItem(SCORE_COL_LS_KEY, String(id));
	}
	// #280: Active · Archived view (`?archived=1`); 'all' only comes from a hand-typed URL.
	const archivedView = $derived(data.filter.archived ?? 'active');

	// Links (always carry the active filters + page size, #94). Start from the server's
	// filterParams + per (+ sort/dir when non-default), apply overrides, drop
	// empty/null/default values so URLs stay clean.
	function urlWith(overrides: Record<string, string | number | null>): string {
		const p = new URLSearchParams(data.filterParams);
		for (const [k, v] of Object.entries(data.overviewParams)) p.set(k, v); // #423
		if (data.per !== 50) p.set('per', String(data.per));
		if (data.sort !== 'created_at') p.set('sort', data.sort);
		if (data.dir !== 'desc') p.set('dir', data.dir);
		for (const [k, v] of Object.entries(overrides)) {
			if (v === null || v === '') p.delete(k);
			else p.set(k, String(v));
		}
		if (p.get('page') === '1') p.delete('page');
		if (p.get('per') === '50') p.delete('per');
		if (p.get('sort') === 'created_at') p.delete('sort');
		if (p.get('dir') === 'desc') p.delete('dir');
		return `?${p}`;
	}
	// Engagement filters (#114).
	const ENGAGEMENT_PARAMS = { tier: null, opened_days: null, never_opened: null, opened_n: null, opened_of: null };
	// Deliverability filters (#279).
	const DELIVERY_PARAMS = { bounced: null, spam: null, campaign: null, campaign_who: null, hygiene: null };
	// Overview tile filters (#423).
	const OVERVIEW_PARAMS = { unsub_from: null, cooled_days: null, awaiting: null, awaiting_days: null, no_list: null };
	const OVERVIEW_KEYS = Object.keys(OVERVIEW_PARAMS);
	// #448 / #467 filters — "Clear all" drops them too (#583).
	const RULE_PARAMS = { topic_out: null, created_days: null, score: null, band: null };
	function urlClearFilters(): string {
		return urlWith({
			...RULE_PARAMS,
			status: null,
			source: null,
			company: null,
			company_id: null,
			added_from: null,
			added_to: null,
			in: null,
			notin: null,
			visited: null,
			visited_days: null,
			site: null,
			has_company: null,
			cm: null,
			pipeline: null,
			...ENGAGEMENT_PARAMS,
			...DELIVERY_PARAMS,
			...OVERVIEW_PARAMS,
			page: null
		});
	}
	function urlClearAll(): string {
		return urlWith({
			...ENGAGEMENT_PARAMS,
			...DELIVERY_PARAMS,
			...OVERVIEW_PARAMS,
			...RULE_PARAMS,
			q: null,
			status: null,
			source: null,
			company: null,
			company_id: null,
			added_from: null,
			added_to: null,
			in: null,
			notin: null,
			visited: null,
			visited_days: null,
			site: null,
			has_company: null,
			cm: null,
			pipeline: null,
			page: null
		});
	}

	// Sortable headers (#55) — sort lives in the URL; changing it resets to page 1.
	function sortUrl(col: string): string {
		const dir = data.sort === col && data.dir === 'desc' ? 'asc' : 'desc';
		return urlWith({ sort: col, dir, page: null });
	}
	function arrow(col: string): 'asc' | 'desc' | null {
		if (data.sort !== col) return null;
		return data.dir === 'desc' ? 'desc' : 'asc';
	}

	// Quick search (#91) — debounced, URL-driven (?q=) so it's bookmarkable and server-rendered.
	let q = $state(data.q);
	let lastPushed = data.q;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		// Only sync `q` from the server when the URL's q actually changed (e.g. back/forward
		// nav) — never on every round-trip, or it would stomp on in-progress typing.
		if (data.q !== lastPushed) {
			q = data.q;
			lastPushed = data.q;
		}
	});

	// Selection resets whenever the page, search, or filters change underneath it.
	let selected = $state<number[]>([]);
	let selectAll = $state(false); // #214: every contact matching the filter, not just this page
	let selectedKey = $state('');
	$effect(() => {
		const key = `${data.page}|${data.q}|${JSON.stringify(data.filterParams)}`;
		if (key !== selectedKey) {
			selected = [];
			selectAll = false;
			selectedKey = key;
		}
	});
	function clearSelection() {
		selected = [];
		selectAll = false;
		lastIndex = -1;
	}

	function navigate(value: string) {
		lastPushed = value;
		goto(urlWith({ q: value || null, page: null }), {
			replaceState: true,
			keepFocus: true,
			noScroll: true,
			invalidateAll: false
		});
	}

	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => navigate(q), 250);
	}

	function onSearchKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			clearTimeout(searchTimer);
			q = '';
			navigate('');
		}
	}

	function clearSearch() {
		clearTimeout(searchTimer);
		q = '';
		navigate('');
	}

	// Filters popover (shared component) — carries the search, sort and page size along.
	const filterKeep = $derived({
		q: data.filter.q,
		sort: data.sort === 'created_at' ? '' : data.sort,
		dir: data.dir === 'desc' ? '' : data.dir,
		per: data.per === 50 ? '' : String(data.per),
		archived: data.filterParams.archived ?? '', // #280: stay in the Archived view
		// #583: the status pills and the group picker live in the toolbar, not in the panel.
		status: data.filterParams.status ?? '',
		in: data.filterParams.in ?? '',
		...data.overviewParams, // #423: the Overview's period + feed options…
		...Object.fromEntries(OVERVIEW_KEYS.map((k) => [k, data.filterParams[k] ?? ''])) // …and its tile filters
	});
	// #583: status pills (same `status=` param) and the Lists · Segments · Tags picker (`in=`).
	// #705: Active (subscribed + pending) is the default outside the Archived view, where All is.
	const STATUS_PILLS = [
		{ value: 'active', label: 'Active' },
		{ value: 'subscribed', label: 'Subscribed' },
		{ value: 'pending', label: 'Pending' },
		{ value: 'unsubscribed', label: 'Unsubscribed' },
		{ value: 'all', label: 'All' }
	] as const;
	const defaultStatus = $derived(archivedView === 'archived' ? 'all' : 'active');
	const pickerGroups = $derived({ list: data.lists, segment: data.segments, tag: data.tags });

	// Modal state (#51): add/import/create-group live in dialogs, not always-open cards.
	let addOpen = $state(false);
	// #477: the search palette's "Create contact with this email" lands on /contacts?add=<email>.
	let addPrefill = $state('');
	$effect(() => {
		const add = page.url.searchParams.get('add');
		if (add) {
			addPrefill = add.trim().slice(0, 254);
			addOpen = true;
		}
	});
	let importOpen = $state(false);
	let createOpen = $state(false);
	let createKind = $state<'list' | 'segment' | 'tag'>('list');

	function openCreate(kind: 'list' | 'segment' | 'tag') {
		createKind = kind;
		createOpen = true;
	}

	// --- CSV import state ---
	let headers = $state<string[]>([]);
	let listName = $state('');
	let importListChoice = $state('__new__'); // '__new__' = create a list, else an existing list's name
	let map = $state({ email: '', name: '', first_name: '', last_name: '', company: '' });
	let splitName = $state(false);
	let fileName = $state('');
	let parsing = $state(false);
	let submitting = $state(false);

	// --- #306: import Hygiene preview ---
	type PreviewIssue = { row: number; email: string; notes: string[]; suggestion: string | null; invalid: boolean };
	type Preview = {
		counts: { rows: number; syntax: number; invalid: number; disposable: number; noMx: number; role: number; typo: number; unchecked: number };
		issues: PreviewIssue[];
		more: number;
	};
	let importFile = $state<File | null>(null);
	let preview = $state<Preview | null>(null);
	let previewing = $state(false);
	let previewError = $state('');
	let accepted = $state<Record<string, string>>({}); // original email → accepted fix
	const fixable = $derived(preview ? preview.issues.filter((i) => i.suggestion) : []);
	const acceptedCount = $derived(Object.keys(accepted).length);

	function resetPreview() {
		preview = null;
		previewError = '';
		accepted = {};
	}
	async function runPreview() {
		if (!importFile || !map.email) return;
		previewing = true;
		previewError = '';
		const fd = new FormData();
		fd.set('file', importFile);
		fd.set('email_col', map.email);
		try {
			const res = await fetch('?/importPreview', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success' && result.data?.preview) {
				preview = result.data.preview as Preview;
				accepted = {};
			} else {
				previewError = result.type === 'failure' ? String(result.data?.previewError ?? 'Check failed.') : 'Check failed.';
			}
		} catch {
			previewError = 'Check failed.';
		}
		previewing = false;
	}
	function toggleFix(i: PreviewIssue, on: boolean) {
		const next = { ...accepted };
		if (on && i.suggestion) next[i.email] = i.suggestion;
		else delete next[i.email];
		accepted = next;
	}
	function acceptAll() {
		accepted = Object.fromEntries(fixable.map((i) => [i.email, i.suggestion!]));
	}

	// --- Manual add: choose an existing list, or create one ---
	let manualListChoice = $state(''); // '' = none, a list name, or '__new__'
	let manualNewList = $state('');
	const manualListName = $derived(
		manualListChoice === '__new__' ? manualNewList : manualListChoice
	);

	// --- Bulk bar pickers (#214). #688: rules segments are passed too — "Add to segment" lists
	// them as not pickable (they fill from their rules); counts show in the searchable picker.
	const bulkLists = $derived(data.lists.map((l) => ({ id: l.id, name: l.name, kind: 'list', count: l.count })));
	const bulkSegments = $derived(
		data.segments.map((s) => ({ id: s.id, name: s.name, kind: 'segment', count: s.count, dynamic: !!s.dynamic }))
	);

	// #423: the Overview's Groups card (replaces the four group boxes).
	const groupCounts = $derived([
		{ kind: 'list' as const, label: 'Lists', count: data.lists.length },
		{ kind: 'segment' as const, label: 'Segments', count: data.segments.length },
		{ kind: 'tag' as const, label: 'Tags', count: data.tags.length },
		{ kind: 'company' as const, label: 'Companies', count: data.companies.length }
	]);

	const allSelected = $derived(
		data.contacts.length > 0 && selected.length === data.contacts.length
	);

	// Pager range text (#94).
	const from = $derived(data.matched === 0 ? 0 : (data.page - 1) * data.per + 1);
	const to = $derived(Math.min(data.page * data.per, data.matched));

	function toggleAll(e: Event) {
		const checked = (e.target as HTMLInputElement).checked;
		selected = checked ? data.contacts.map((c) => c.id) : [];
		selectAll = false;
		lastIndex = -1;
	}

	// Row checkbox clicks. Plain click toggles one; shift-click extends from the last
	// clicked row to this one (setting the whole range to this checkbox's new state), the
	// familiar file-list selection behavior. We drive `selected` manually (not bind:group)
	// so the range fill is a single update.
	let lastIndex = $state(-1);
	function rowClick(e: MouseEvent, i: number, id: number) {
		const willSelect = (e.target as HTMLInputElement).checked;
		const set = new Set(selected);
		if (e.shiftKey && lastIndex !== -1) {
			const [a, b] = lastIndex < i ? [lastIndex, i] : [i, lastIndex];
			for (const c of data.contacts.slice(a, b + 1)) {
				if (willSelect) set.add(c.id);
				else set.delete(c.id);
			}
		} else if (willSelect) {
			set.add(id);
		} else {
			set.delete(id);
		}
		selected = [...set];
		selectAll = false;
		lastIndex = i;
	}

	async function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		fileName = file.name;
		importFile = file;
		resetPreview();
		parsing = true;
		const text = await file.text();
		const res = Papa.parse<Record<string, string>>(text, {
			header: true,
			skipEmptyLines: true,
			preview: 1
		});
		headers = res.meta.fields ?? [];
		const g = guessColumns(headers);
		map = {
			email: g.email ?? '',
			name: g.name ?? '',
			first_name: g.first_name ?? '',
			last_name: g.last_name ?? '',
			company: g.company ?? ''
		};
		if (!listName) listName = file.name.replace(/\.csv$/i, '');
		parsing = false;
	}
</script>

<svelte:head><title>Contacts</title></svelte:head>

<div class="pagehead">
	<h1>Contacts</h1>
	<span class="head-actions">
		<button type="button" onclick={() => (addOpen = true)}>+ Add contacts</button>
		<button type="button" class="secondary" onclick={() => (importOpen = true)}>Import CSV</button>
		<a class="export-btn" href="/contacts/export" download title="Download every contact (with lists, tags, custom fields) as CSV">Export CSV</a>
	</span>
</div>

{#if form?.success}
	<p class="ok banner">
		Imported <strong>{form.imported}</strong> into “{form.listName}” —
		<strong>{form.added}</strong> new, <strong>{form.updated}</strong> updated.
		{#if form.duplicates}<span class="muted"> {form.duplicates} in-file duplicate(s) skipped.</span>{/if}
		{#if form.invalid}<span class="muted"> {form.invalid} invalid email(s) skipped.</span>{/if}
		{#if form.hygiene}
			<span class="muted">
				{#if form.hygiene.fixed} {form.hygiene.fixed} typo fix(es) applied.{/if}
				{#if form.hygiene.skipped} {form.hygiene.skipped} skipped by hygiene (no mail server / disposable).{:else if form.hygiene.invalid} {form.hygiene.invalid} tagged <code>hygiene:invalid</code> (new ones unsubscribed).{/if}
				{#if form.hygiene.role} {form.hygiene.role} role address(es).{/if}
			</span>
			{#if form.hygiene.invalid && !form.hygiene.skipped}<a href="/contacts?hygiene=invalid">Review invalid →</a>{/if}
		{/if}
	</p>
{/if}
{#if form?.manualSuccess}
	<p class="ok banner">
		Added <strong>{form.added}</strong> contact(s){#if form.listName} to “{form.listName}”{/if}.
		{#if form.duplicates}<span class="muted"> {form.duplicates} duplicate(s) skipped.</span>{/if}
		{#if form.invalid}<span class="muted"> {form.invalid} invalid skipped.</span>{/if}
		{#if form.hygiene?.invalid}<span class="muted"> {form.hygiene.invalid} tagged <code>hygiene:invalid</code> (no mail server / disposable).</span>{/if}
		{#if form.hygiene?.role}<span class="muted"> {form.hygiene.role} role address(es).</span>{/if}
		{#each form.hygiene?.suggestions ?? [] as sg (sg.email)}
			<span class="muted"> {sg.email}: did you mean {sg.suggestion}?</span>
		{/each}
	</p>
{/if}

<!-- #423: Overview (tiles, charts, needs attention, groups, the filter-aware feed) — same filter as the table. -->
<ContactsOverview
	overview={data.overview}
	feed={data.feed}
	actions={data.overviewActions}
	scopeLabel={data.scopeLabel}
	filterParams={data.filterParams}
	{groupCounts}
	{urlWith}
	clearHref={urlClearAll()}
	onCreate={openCreate}
	form={form && 'viewSaved' in form ? form : null}
/>

<Modal title="Import a CSV" bind:open={importOpen}>
	<form
		method="POST"
		action="?/import"
		enctype="multipart/form-data"
		use:enhance={() => {
			submitting = true;
			return async ({ update, result }) => {
				await update();
				submitting = false;
				if (result.type === 'success') {
					importOpen = false; // counts show in the page banner
					headers = [];
					fileName = '';
					importFile = null;
					resetPreview();
					importListChoice = '__new__';
				}
			};
		}}
	>
		<label class="file">
			<input type="file" name="file" accept=".csv,text/csv" onchange={onFile} required />
		</label>

		{#if parsing}<p class="muted">Reading {fileName}…</p>{/if}

		{#if headers.length > 0}
			<p class="muted detected">Detected columns in <strong>{fileName}</strong> — confirm the mapping:</p>
			<div class="grid">
				<label>Email column <span class="req">*</span>
					<select name="email_col" bind:value={map.email} onchange={resetPreview} required>
						<option value="" disabled>Select…</option>
						{#each headers as h (h)}<option value={h}>{h}</option>{/each}
					</select>
				</label>
				<label>Full name
					<select name="name_col" bind:value={map.name}>
						<option value="">— none —</option>
						{#each headers as h (h)}<option value={h}>{h}</option>{/each}
					</select>
				</label>
				<label>Company / Org
					<select name="company_col" bind:value={map.company}>
						<option value="">— none —</option>
						{#each headers as h (h)}<option value={h}>{h}</option>{/each}
					</select>
				</label>
				{#if !splitName}
					<label>First name
						<select name="first_col" bind:value={map.first_name}>
							<option value="">— none —</option>
							{#each headers as h (h)}<option value={h}>{h}</option>{/each}
						</select>
					</label>
					<label>Last name
						<select name="last_col" bind:value={map.last_name}>
							<option value="">— none —</option>
							{#each headers as h (h)}<option value={h}>{h}</option>{/each}
						</select>
					</label>
				{/if}
			</div>
			{#if map.name}
				<label class="split-row">
					<input type="checkbox" name="split_name" bind:checked={splitName} />
					Split the full-name column into First &amp; Last <span class="muted">(e.g. “Jane Doe” → Jane / Doe)</span>
				</label>
			{/if}
			<label class="listname">Import into
				<select bind:value={importListChoice}>
					<option value="__new__">＋ New list…</option>
					{#each data.lists as l (l.id)}
						<option value={l.name}>{l.name} ({l.count})</option>
					{/each}
				</select>
			</label>
			{#if importListChoice === '__new__'}
				<label class="listname">List name
					<input name="list_name" bind:value={listName} placeholder="e.g. Newsletter subscribers" />
				</label>
			{:else}
				<input type="hidden" name="list_name" value={importListChoice} />
			{/if}
			<div class="hygiene">
				<span class="hy-title">Hygiene</span>
				<button type="button" class="secondary" onclick={runPreview} disabled={previewing || !map.email}>
					{previewing ? 'Checking…' : preview ? 'Check again' : 'Check addresses'}
				</button>
				{#if previewError}<p class="err">{previewError}</p>{/if}
				{#if preview}
					{@const c = preview.counts}
					<p class="hy-counts">
						{c.rows} rows · <strong>{c.invalid}</strong> invalid ({c.noMx} no mail server, {c.disposable} disposable) ·
						{c.role} role · {c.typo} typo{c.typo === 1 ? '' : 's'}{#if c.syntax} · {c.syntax} bad syntax (skipped){/if}{#if c.unchecked}<span class="muted"> · {c.unchecked} domain check{c.unchecked === 1 ? '' : 's'} not run</span>{/if}
					</p>
					{#if preview.issues.length}
						{#if fixable.length}
							<p class="hy-fixall">
								<button type="button" class="secondary" onclick={acceptAll} disabled={acceptedCount === fixable.length}>
									Accept all {fixable.length} fix{fixable.length === 1 ? '' : 'es'}
								</button>
								{#if acceptedCount}<span class="muted">{acceptedCount} accepted</span>{/if}
							</p>
						{/if}
						<div class="hy-wrap">
							<table class="hy-table">
								<thead><tr><th>Row</th><th>Email</th><th>Hygiene</th><th>Fix</th></tr></thead>
								<tbody>
									{#each preview.issues as i (i.row)}
										<tr>
											<td>{i.row}</td>
											<td class="hy-email">{i.email}</td>
											<td class:err={i.invalid}>{i.notes.filter((n) => !n.startsWith('Did you mean')).join(' · ') || '—'}</td>
											<td>
												{#if i.suggestion}
													<label class="split-row">
														<input type="checkbox" checked={!!accepted[i.email]} onchange={(e) => toggleFix(i, (e.currentTarget as HTMLInputElement).checked)} />
														{i.suggestion}
													</label>
												{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						{#if preview.more}<p class="muted">{preview.more} more row{preview.more === 1 ? '' : 's'} with notes not listed.</p>{/if}
					{:else}
						<p class="ok">Every address passed.</p>
					{/if}
				{/if}
				<span class="hy-title">Rows with no mail server or a disposable domain</span>
				<label class="split-row">
					<input type="radio" name="invalid_mode" value="unsubscribe" checked />
					Import as unsubscribed, tagged <code>hygiene:invalid</code> <span class="muted">(existing contacts keep their status)</span>
				</label>
				<label class="split-row">
					<input type="radio" name="invalid_mode" value="skip" />
					Skip them
				</label>
				<input type="hidden" name="fixes" value={JSON.stringify(accepted)} />
			</div>
			<button type="submit" disabled={submitting || !map.email}>
				{submitting ? 'Importing…' : 'Import contacts'}
			</button>
		{/if}
	</form>

	{#if form?.error}<p class="err">{form.error}</p>{/if}
</Modal>

<Modal title="Add contacts manually" bind:open={addOpen}>
	<form
		method="POST"
		action="?/addManual"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success') addOpen = false; // counts show in the page banner
			}}
	>
		<label class="emails">
			Emails — one per line. Optionally add a name: <code>email, Full Name</code> or
			<code>Full Name &lt;email&gt;</code>
			<textarea
				name="emails"
				rows="5"
				value={addPrefill}
				placeholder={'jane@example.com\njohn@example.com, John Doe\nBob Smith <bob@example.com>'}
				required
			></textarea>
		</label>
		<div class="manual-meta">
			<label class="listname">
				Add to list <span class="muted">(optional)</span>
				<select bind:value={manualListChoice}>
					<option value="">— Don't add to a list —</option>
					{#if data.lists.length}
						<optgroup label="Existing lists">
							{#each data.lists as l (l.id)}
								<option value={l.name}>{l.name} ({l.count})</option>
							{/each}
						</optgroup>
					{/if}
					<option value="__new__">+ Create new list…</option>
				</select>
			</label>
			{#if manualListChoice === '__new__'}
				<label class="listname">
					New list name
					<input bind:value={manualNewList} placeholder="e.g. Newsletter subscribers" />
				</label>
			{/if}
			<label class="sourcefield">
				Source <span class="muted">(where from)</span>
				<input name="source" value="manual" placeholder="e.g. business card, event, referral" />
			</label>
		</div>
		<input type="hidden" name="list_name" value={manualListName} />
		<button type="submit">Add contacts</button>
	</form>
	{#if form?.manualError}<p class="err">{form.manualError}</p>{/if}
</Modal>

<Modal title="New {createKind}" bind:open={createOpen}>
	<form
		method="POST"
		action="?/createGroup"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success') createOpen = false;
			}}
		class="create-group"
	>
		<input type="hidden" name="kind" value={createKind} />
		<label class="listname">
			Name
			<!-- svelte-ignore a11y_autofocus -->
			<input
				name="name"
				autofocus
				required
				maxlength="60"
				placeholder={createKind === 'list' ? 'e.g. Newsletter subscribers' : createKind === 'segment' ? 'e.g. VIP customers' : 'e.g. hot'}
			/>
		</label>
		<p class="muted hint">
			{#if createKind === 'list'}Lists are audiences you import into and send campaigns to.{/if}
			{#if createKind === 'segment'}Segments are hand-picked subsets — add contacts from the table below.{/if}
			{#if createKind === 'tag'}Tags are lightweight labels — and an “added to tag” automation trigger.{/if}
		</p>
		<label class="listname">
			Description <span class="muted">(optional)</span>
			<input name="description" maxlength="500" placeholder="What is this {createKind} for?" autocomplete="off" />
		</label>
		<label class="listname">
			Origin / consent <span class="muted">(optional — how do contacts get here?)</span>
			<input name="origin" maxlength="500" placeholder="e.g. Double opt-in via website footer form" autocomplete="off" />
		</label>
		<button type="submit">Create {createKind}</button>
	</form>
	{#if form?.groupError}<p class="err">{form.groupError}</p>{/if}
</Modal>

{#if form?.segError}<p class="err">{form.segError}</p>{/if}

<section class="card">
	<!-- #283: title + count | view toggle; search · Filters · columns; chips (when any). -->
	<div class="contacts-toolbar">
		<div class="contacts-head">
			<h2>
				{archivedView === 'archived' ? 'Archived contacts' : 'Contacts'}
				{#if data.narrowed && archivedView !== 'archived'}
					<span class="muted">{data.matched.toLocaleString('en-US')} of {data.totals.total.toLocaleString('en-US')} matching</span>
				{:else}
					<span class="muted">{data.matched.toLocaleString('en-US')}</span>
				{/if}
			</h2>
			<nav class="view-seg" aria-label="Contacts view">
				<a class="seg" class:on={archivedView !== 'archived'} href={urlWith({ archived: null, page: null })} aria-current={archivedView !== 'archived' ? 'true' : undefined}>Active</a>
				<a class="seg" class:on={archivedView === 'archived'} href={urlWith({ archived: '1', page: null })} aria-current={archivedView === 'archived' ? 'true' : undefined}>Archived <span class="count">{data.totals.archived.toLocaleString('en-US')}</span></a>
			</nav>
		</div>

		<div class="contacts-tools">
			<div class="search">
				<input type="search" bind:value={q} oninput={onSearchInput} onkeydown={onSearchKey}
					placeholder="Search email, name or company" aria-label="Search contacts" autocomplete="off" spellcheck="false" />
				{#if q}<button type="button" class="clear" aria-label="Clear search" onclick={clearSearch}><Icon name="close" size={16} /></button>{/if}
			</div>

			<GroupPicker
				groups={pickerGroups}
				active={data.filter.inGroup}
				hrefFor={(id) => urlWith({ in: id, page: null })}
				clearHref={urlWith({ in: null, page: null })}
			/>

			<ContactFilters
				filter={data.filter}
				filtered={data.filtered}
				groupOptions={data.groupOptions}
				companyPicker={data.companyPicker}
				stagePicker={data.stagePicker}
				topicPicker={data.topicOptions}
				scorePicker={data.scorePicks}
				formPicker={data.formOptions}
				keep={filterKeep}
				clearHref={urlClearFilters()}
				toolbar
				campaignLabel={data.campaignLabel}
				billing={data.billing}
			/>

			<span class="gear-wrap">
				<button type="button" class="gear" title="Choose columns" aria-label="Choose columns" onclick={() => (gearOpen = !gearOpen)}><Icon name="settings" size={16} /></button>
				{#if gearOpen}
					<span class="gear-menu">
						{#each ALL_COLUMNS as col (col.key)}
							<label class="gear-item">
								<input type="checkbox" checked={show.has(col.key)} onchange={() => toggleCol(col.key)} />
								{col.label}
							</label>
						{/each}
						{#if show.has('score') && data.scorePicks.length > 1}
							<label class="gear-item">
								<span class="muted">Score:</span>
								<select value={scoreCol?.id ?? ''} onchange={(e) => pickScoreCol(Number((e.target as HTMLSelectElement).value))} aria-label="Score shown in the Score column">
									{#each data.scorePicks as sc (sc.id)}<option value={sc.id}>{sc.name}</option>{/each}
								</select>
							</label>
						{/if}
					</span>
				{/if}
			</span>
		</div>

		<nav class="status-pills" aria-label="Subscription status">
			{#each STATUS_PILLS as sp (sp.value)}
				<a class="pill" class:on={data.filter.status === sp.value} href={urlWith({ status: sp.value === defaultStatus ? null : sp.value, page: null })}
					aria-current={data.filter.status === sp.value ? 'true' : undefined}>{sp.label}</a>
			{/each}
		</nav>

		<!-- #583: one removable chip per active filter (contact-filter-chips.ts). -->
		{#if data.filterChips.length}
			<div class="contacts-chips" role="group" aria-label="Active filters">
				{#each data.filterChips as c, i (`${c.kind}-${i}`)}
					<span class="company-chip"><span class="chip-label" title={c.label}>{#if c.href}<a href={c.href}>{c.label}</a>{:else}{c.label}{/if}</span>
						<a class="chip-x" href={urlWith(chipOverrides(c))} aria-label="Remove filter: {c.label}"><Icon name="close" size={14} /></a></span>
				{/each}
				<a class="clear-all" href={urlClearFilters()}>Clear all</a>
			</div>
		{/if}
	</div>

	{#if form?.bulkError && !('viewSaved' in form)}<p class="err flash">{form.bulkError}</p>{/if}
	{#if form?.bulkSuccess && !('viewSaved' in form)}
		<p class="ok flash" role="status">{form.bulkSuccess}.{#if form.bulkHref}{' '}<a href={form.bulkHref}>Open</a>{/if}</p>
	{/if}

	<!-- #705: the default view is the active audience; say how many it hides and how to see them. -->
	{#if data.hidden && (data.hidden.unsubscribed || data.hidden.archived)}
		<p class="muted small hidden-note" role="status">
			{#if data.hidden.unsubscribed}<a href={data.hidden.unsubscribedHref}>{data.hidden.unsubscribed.toLocaleString('en-US')} unsubscribed</a>{/if}{#if data.hidden.unsubscribed && data.hidden.archived}{' and '}{/if}{#if data.hidden.archived}<a href={data.hidden.archivedHref}>{data.hidden.archived.toLocaleString('en-US')} archived</a>{/if}
			{data.hidden.unsubscribed + data.hidden.archived === 1 ? 'contact is' : 'contacts are'} hidden here and from lists, tags, segments, companies and reports.
		</p>
	{/if}

	{#if data.contacts.length === 0}
		{#if data.narrowed}
			<p class="muted">No contacts match. <a href={urlClearAll()}>Clear search &amp; filters</a></p>
		{:else if archivedView === 'archived'}
			<p class="muted">No archived contacts.</p>
		{:else}
			<p class="muted">No contacts yet. Import a CSV above.</p>
		{/if}
	{:else}
		{#if selectAll || selected.length > 0}
			<ContactBulkBar
				{selected}
				all={selectAll}
				matched={data.matched}
				pageFull={allSelected}
				cap={data.bulkCap}
				filterParams={data.filterParams}
				addTargets={[...bulkLists, ...bulkSegments]}
				lists={bulkLists}
				tags={data.tags}
				automations={data.activeAutomations}
				groupMeta={[...bulkLists, ...bulkSegments, ...data.tags.map((t) => ({ id: t.id, name: t.name, kind: 'tag' }))]}
				pageGroups={data.pageGroups}
				matchGroups={data.matchGroups}
				archiveMode={archivedView === 'archived' ? 'restore' : 'archive'}
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
						<th class="cb"><input type="checkbox" checked={allSelected} onchange={toggleAll} /></th>
						<th><a class="sort" href={sortUrl('email')} data-sveltekit-noscroll>Email<SortCaret dir={arrow('email')} /></a></th>
						{#if show.has('name')}<th><a class="sort" href={sortUrl('name')} data-sveltekit-noscroll>Name<SortCaret dir={arrow('name')} /></a></th>{/if}
						{#if show.has('company')}<th><a class="sort" href={sortUrl('company')} data-sveltekit-noscroll>Company<SortCaret dir={arrow('company')} /></a></th>{/if}
						{#if show.has('subscribed')}<th><a class="sort" href={sortUrl('subscribed')} data-sveltekit-noscroll>Status<SortCaret dir={arrow('subscribed')} /></a></th>{/if}
						{#if show.has('source')}<th><a class="sort" href={sortUrl('source')} data-sveltekit-noscroll>Source<SortCaret dir={arrow('source')} /></a></th>{/if}
						{#if show.has('created_at')}<th><a class="sort" href={sortUrl('created_at')} data-sveltekit-noscroll>Added<SortCaret dir={arrow('created_at')} /></a></th>{/if}
						{#if show.has('tier')}<th><a class="sort" href={sortUrl('tier')} data-sveltekit-noscroll>Tier<SortCaret dir={arrow('tier')} /></a></th>{/if}
						{#if show.has('stage')}<th>Stage</th>{/if}
						{#if show.has('score') && scoreCol}<th><a class="sort" href={sortUrl(`score:${scoreCol.id}`)} data-sveltekit-noscroll title="Score: {scoreCol.name}">{scoreCol.name}<SortCaret dir={arrow(`score:${scoreCol.id}`)} /></a></th>{/if}
						{#if archivedView === 'archived'}<th>Archived</th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each data.contacts as c, i (c.id)}
						<tr class:sel={selectAll || selected.includes(c.id)}>
							<td class="cb"><input type="checkbox" checked={selectAll || selected.includes(c.id)} onclick={(e) => rowClick(e, i, c.id)} /></td>
							<td><a href="/contacts/{c.id}">{c.email}</a></td>
							{#if show.has('name')}
								<td>
									<span class="name-cell">
										<Avatar contactId={c.id} name={c.name || [c.first_name, c.last_name].filter(Boolean).join(' ')} size={24} />
										<span>{c.name || [c.first_name, c.last_name].filter(Boolean).join(' ')}</span>
									</span>
								</td>
							{/if}
							{#if show.has('company')}<td class="muted">{#if c.company_id}<a href="/companies/{c.company_id}">{c.company ?? ''}</a>{:else}{c.company ?? ''}{/if}</td>{/if}
							{#if show.has('subscribed')}
								<td>
									<!-- #705: an archived contact reads Archived, whatever `subscribed` says. -->
									{#if c.archived_at}<span class="badge" title="Archived {c.archived_at.slice(0, 10)} · {c.subscribed ? 'subscribed' : c.confirm_pending ? 'pending confirmation' : 'unsubscribed'}">Archived</span>
									{:else if c.subscribed}<span class="badge sent">Subscribed</span>
									{:else if c.confirm_pending}<span class="badge sending" title="Double opt-in: waiting for them to confirm">Pending confirmation</span>
									{:else}<span class="badge failed">Unsubscribed</span>{/if}
								</td>
							{/if}
							{#if show.has('source')}<td class="muted">{c.source ?? ''}</td>{/if}
							{#if show.has('created_at')}<td class="muted">{c.created_at.slice(0, 10)}</td>{/if}
							{#if show.has('tier')}
								<td>{#if isTier(c.tier)}<TierBadge tier={c.tier} score={c.score} />{/if}</td>
							{/if}
							{#if show.has('stage')}
								{@const st = data.stageByContact[c.id]}
								<td>{#if st}<StagePill name={st.name} color={st.color} />{:else}<span class="muted">—</span>{/if}</td>
							{/if}
							{#if show.has('score') && scoreCol}
								{@const sv = data.scoresByContact[c.id]?.find((x) => x.id === scoreCol.id)}
								<td class="score-cell">
									<span class="num">{sv?.value ?? 0}</span>
									{#if sv?.band}<span class="band-pill">{sv.band}</span>{/if}
								</td>
							{/if}
							{#if archivedView === 'archived'}<td class="muted">{c.archived_at?.slice(0, 10) ?? ''}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.pageCount > 1 || data.matched > 25}
			<nav class="pager">
				{#if data.page > 1}
					<a class="pg" href={urlWith({ page: data.page - 1 })} data-sveltekit-noscroll>← Prev</a>
				{:else}
					<span class="pg disabled">← Prev</span>
				{/if}
				<span class="muted pageinfo">Showing {from}–{to} of {data.matched}</span>
				{#if data.page < data.pageCount}
					<a class="pg" href={urlWith({ page: data.page + 1 })} data-sveltekit-noscroll>Next →</a>
				{:else}
					<span class="pg disabled">Next →</span>
				{/if}
				<span class="per">
					<span class="muted">Per page:</span>
					{#each data.perOptions as opt (opt)}
						{#if opt === data.per}
							<span class="per-opt active">{opt}</span>
						{:else}
							<a class="per-opt" href={urlWith({ per: opt, page: 1 })} data-sveltekit-noscroll>{opt}</a>
						{/if}
					{/each}
				</span>
			</nav>
		{/if}
	{/if}
</section>

<style>
	.pagehead { display: flex; align-items: center; gap: var(--space-s); }
	.company-chip {
		display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs);
		padding: 0 var(--space-xxs) 0 var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius-full);
	}
	.chip-x { color: var(--muted); padding: 0 var(--space-xs); }
	.chip-x:hover { color: var(--text); text-decoration: none; }
	.pagehead h1 { margin-right: auto; }
	.head-actions { display: inline-flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; }
	@media (max-width: 640px) {
		.pagehead { flex-direction: column; align-items: flex-start; gap: var(--space-s); }
		.head-actions button, .head-actions .export-btn { padding: var(--space-xxs) var(--space-s); }
	}
	.banner { margin: var(--space-s) 0 0; }
	.create-group { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.create-group button { align-self: flex-start; }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0; }
	.export-btn {
		padding: var(--space-xs) var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s); color: var(--muted); white-space: nowrap;
	}
	.export-btn:hover { text-decoration: none; color: var(--text); box-shadow: 0 0 0 var(--border-s) var(--muted); }
	section { margin-bottom: var(--space-l); }
	h2 { margin-top: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	form { display: flex; flex-direction: column; gap: var(--space-m); align-items: flex-start; }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-s); width: 100%; }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--muted); }
	.listname { width: 100%; max-width: 360px; }
	.split-row { flex-direction: row; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--text); }
	.split-row input { width: auto; }
	.manual-meta { display: flex; flex-wrap: wrap; gap: var(--space-m); width: 100%; }
	.sourcefield { width: 100%; max-width: 280px; }
	.emails { width: 100%; max-width: 520px; }
	.emails textarea { width: 100%; font-family: var(--font-mono); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	code { background: var(--border); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.req { color: var(--danger); }
	.detected { margin: 0; }
	.hygiene { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xs); width: 100%; }
	.hy-title { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--muted); }
	.hy-counts, .hy-fixall { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.hy-fixall { display: flex; align-items: center; gap: var(--space-s); }
	.hy-wrap { width: 100%; max-height: 260px; overflow: auto; }
	.hy-table { width: 100%; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.hy-email { overflow-wrap: anywhere; }
	.err { color: var(--danger); }
	.ok { color: var(--success); }
	.cb { width: 1%; white-space: nowrap; }
	/* #105: a <span> wrapper inside the <td> (not display:flex on the <td> itself) keeps the
	   table's normal cell borders/padding/vertical alignment intact. */
	.name-cell { display: flex; align-items: center; gap: var(--space-xs); }
	tr.sel { background: color-mix(in srgb, var(--accent) 8%, transparent); }
	@media (max-width: 640px) {
		th.cb, td.cb { position: sticky; left: 0; z-index: 1; background: var(--surface); }
		th.cb { background: var(--surface-subtle); }
		tr.sel td.cb { background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
	}
	/* #283 toolbar: row 1 title/count + view toggle, row 2 search/Filters/columns, row 3 chips. */
	.contacts-toolbar { display: flex; flex-direction: column; gap: var(--space-s); margin-bottom: var(--space-m); }
	.contacts-head { display: flex; align-items: center; gap: var(--space-s); justify-content: space-between; flex-wrap: wrap; }
	.contacts-head h2 { margin: 0; display: flex; align-items: baseline; gap: var(--space-xs); white-space: nowrap; min-width: 0; }
	.contacts-head h2 .muted { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-regular); font-family: var(--font-ui); }
	.view-seg { flex: none; }
	.contacts-tools { display: flex; align-items: center; gap: var(--space-s); position: relative; }
	.contacts-tools :global(.menu > summary), .contacts-tools .gear, .search input { box-sizing: border-box; height: 38px; }
	.contacts-tools :global(.menu > summary) { display: inline-flex; align-items: center; }
	.contacts-tools .gear { display: inline-flex; align-items: center; justify-content: center; width: 38px; padding: 0; }
	/* #583: status pills under the search row. */
	.status-pills { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
	.status-pills .pill {
		display: inline-flex; align-items: center; min-height: 28px; padding: 0 var(--space-s); border-radius: var(--radius-full);
		font-size: var(--size-s); line-height: var(--line-s); color: var(--text); box-shadow: 0 0 0 var(--border-s) var(--border);
	}
	.status-pills .pill:hover { text-decoration: none; background: var(--neutral-muted); }
	.status-pills .pill.on {
		background: color-mix(in srgb, var(--accent) 14%, transparent); font-weight: var(--weight-ui-medium);
		box-shadow: 0 0 0 var(--border-s) var(--color-1);
	}
	.contacts-chips { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
	.contacts-chips .company-chip { max-width: min(480px, 100%); min-height: 28px; }
	.chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	.contacts-chips .chip-x { display: inline-flex; align-items: center; flex: none; }
	.clear-all { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-left: var(--space-xxs); }
	/* Bulk result banner, aligned with the card's content edge. */
	.flash {
		margin: 0 0 var(--space-m); padding: var(--space-xs) var(--space-s); border-radius: var(--radius-s);
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
	}
	.ok.flash { color: var(--text); background: color-mix(in srgb, var(--success) 12%, transparent); box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--success) 35%, var(--border)); }
	.err.flash { color: var(--text); background: color-mix(in srgb, var(--danger) 10%, transparent); box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 35%, var(--border)); }
	.search { position: relative; flex: 1 1 240px; min-width: 240px; }
	.search input { width: 100%; padding-right: var(--space-xl); }
	.search .clear {
		position: absolute; right: 0.3rem; top: 50%; transform: translateY(-50%);
		border: none; background: transparent; color: var(--muted); box-shadow: none;
		font-size: var(--size-m);
		letter-spacing: var(--letter-spacing-m); line-height: 1; padding: 0 var(--space-xs); cursor: pointer;
	}
	.search .clear:hover { color: var(--text); }
	.gear-wrap { position: relative; }
	.gear {
		padding: 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); background: transparent; color: var(--muted);
		border: 0; border-radius: var(--radius-xs); box-shadow: 0 0 0 var(--border-s) var(--border);
	}
	.gear:hover { color: var(--text); box-shadow: 0 0 0 var(--border-s) var(--muted); }
	.gear-menu {
		position: absolute; right: 0; top: calc(100% + 4px); z-index: 10;
		display: flex; flex-direction: column; gap: var(--space-xs); min-width: 9rem;
		background: var(--surface); border: 0; border-radius: var(--radius);
		padding: var(--space-s) var(--space-s); box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-m);
	}
	.gear-item { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	a.sort { color: inherit; text-decoration: none; white-space: nowrap; }
	a.sort:hover { color: var(--link-hover); }
	/* Pager (mirrors /lists/[id]) */
	.pager { display: flex; align-items: center; justify-content: center; gap: var(--space-m); margin-top: var(--space-m); flex-wrap: wrap; }
	.pg { padding: var(--space-xs) var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--link); }
	.pg:hover { text-decoration: none; background: var(--neutral-muted); }
	.pg.disabled { color: var(--muted); opacity: 0.6; pointer-events: none; }
	.pageinfo { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.per { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.per-opt {
		min-width: 1.9rem; text-align: center; padding: var(--space-xxs) var(--space-xs); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius); color: var(--link);
	}
	.per-opt:hover { text-decoration: none; background: var(--neutral-muted); }
	.per-opt.active { background: var(--neutral-muted); color: var(--text); font-weight: var(--weight-ui-heavy); box-shadow: 0 0 0 var(--border-s) var(--border); }
	@media (max-width: 768px) {
		.gear { min-width: 40px; min-height: 40px; }
		.search .clear { min-width: 40px; min-height: 40px; }
		.search input { padding-right: var(--space-xxl); }
		/* search full-width, Filters + columns below it; the filters popover anchors to
		   .contacts-tools (position: relative) so it can't run off-screen */
		.contacts-tools { flex-wrap: wrap; }
		.search { flex: 1 1 100%; min-width: 0; }
		.contacts-tools :global(.menu > summary), .contacts-tools .gear, .search input { height: 40px; }
		.contacts-tools .gear { width: 40px; }
	}
	@media (max-width: 640px) {
		.contacts-head h2 { flex-wrap: wrap; white-space: normal; }
		.contacts-chips .company-chip { max-width: 100%; }
	}
	/* #280: Active · Archived toggle (same look as the automations status control). */
	.view-seg {
		display: inline-flex;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}
	.view-seg .seg {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		color: var(--text);
		background: var(--surface);
		white-space: nowrap;
	}
	.view-seg .seg + .seg {
		box-shadow: inset var(--border-s) 0 0 var(--border);
	}
	.view-seg .seg:hover {
		background: var(--neutral-muted);
	}
	.view-seg .seg.on {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		font-weight: var(--weight-ui-medium);
	}
	.view-seg .count {
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	/* #467: the Score column — value + band pill. */
	.score-cell { white-space: nowrap; }
	.score-cell .num { font-variant-numeric: tabular-nums; }
	.band-pill {
		display: inline-block; margin-left: var(--space-xxs); padding: 0 var(--space-xs);
		font-size: var(--size-xs); line-height: var(--line-xs); border-radius: var(--radius-full);
		background: var(--neutral-3); color: var(--text);
	}
</style>

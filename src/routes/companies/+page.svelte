<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import Modal from '$lib/components/Modal.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import { fmtHours } from '$lib/timing-format';
	import { money, moneyTile, moneyWhole } from '$lib/money';
	import {
		defaultDirFor,
		defaultSortFor,
		filterLabel,
		lastTouchSource,
		tileVisibility,
		LAST_TOUCH_LABELS,
		type CompanyFilterKey,
		type CompanySortKey,
		type LastTouchSource
	} from '$lib/company-overview';
	let { data, form } = $props();

	let createOpen = $state(false);

	// Live search (mirrors /contacts #91) — debounced, URL-driven (?q=).
	// svelte-ignore state_referenced_locally
	let q = $state(data.q);
	// svelte-ignore state_referenced_locally
	let lastPushed = data.q;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		if (data.q !== lastPushed) {
			q = data.q;
			lastPushed = data.q;
		}
	});
	// Every URL carries q + filter; sort / dir only when they differ from the filter's defaults.
	function params(opts: { q?: string; filter?: CompanyFilterKey; sort?: CompanySortKey; dir?: 'asc' | 'desc'; page?: number }) {
		const p = new URLSearchParams();
		const qv = opts.q ?? data.q;
		const filter = opts.filter ?? data.filter;
		const sort = opts.sort ?? data.sort;
		const dir = opts.dir ?? data.dir;
		if (qv) p.set('q', qv);
		if (filter !== 'all') p.set('filter', filter);
		if (sort !== defaultSortFor(filter)) p.set('sort', sort);
		if (dir !== defaultDirFor(sort)) p.set('dir', dir);
		if (opts.page && opts.page > 1) p.set('page', String(opts.page));
		return `?${p}`;
	}
	function navigate(value: string) {
		lastPushed = value;
		goto(params({ q: value }), { replaceState: true, keepFocus: true, noScroll: true });
	}
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => navigate(q.trim()), 250);
	}
	function clearSearch() {
		clearTimeout(searchTimer);
		q = '';
		navigate('');
	}
	const pageUrl = (n: number) => params({ page: n });
	// Sortable columns (#168, #169, #436). Clicking the active column flips direction.
	function sortUrl(col: CompanySortKey): string {
		const dir = data.sort === col ? (data.dir === 'asc' ? 'desc' : 'asc') : defaultDirFor(col);
		return params({ sort: col, dir });
	}
	// A filter opens with its own default sort (chips keep the search).
	function filterUrl(f: CompanyFilterKey): string {
		const sort = defaultSortFor(f);
		return params({ filter: f, sort, dir: defaultDirFor(sort) });
	}
	const tileUrl = (f: CompanyFilterKey) => (f === 'all' ? '/companies' : `/companies?filter=${f}`);
	function arrow(col: string): 'asc' | 'desc' | null {
		if (data.sort !== col) return null;
		return data.dir === 'desc' ? 'desc' : 'asc';
	}
	const from = $derived(data.total === 0 ? 0 : (data.page - 1) * data.per + 1);
	const to = $derived(Math.min(data.page * data.per, data.total));
	const tiles = $derived(tileVisibility(data.state));
	const ov = $derived(data.overview);
	const bill = $derived(data.overview.billing);
	const billTitle = $derived(bill?.mixed ? `In ${bill.currency} + other currencies` : undefined);
	// Tile values are compact (#436); the hover title carries the exact figure, then the mixed-currency note.
	const tileTitle = (label: string, n: number | null | undefined): string =>
		[`${label} ${money(n, bill?.currency)}`, billTitle].filter(Boolean).join(' · ');
	const plural = (n: number, w: string) =>
		`${n} ${n === 1 ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's'}`;
</script>

<svelte:head><title>Companies</title></svelte:head>

<div class="head">
	<h1>Companies</h1>
	<span class="muted count">{data.total}</span>
	<button type="button" class="secondary new-btn" onclick={() => (createOpen = true)}>+ New company</button>
</div>

<Modal title="New company" bind:open={createOpen}>
	<form method="POST" action="?/create" use:enhance class="create-form">
		<label>
			Name
			<!-- svelte-ignore a11y_autofocus -->
			<input name="name" autofocus required maxlength="200" placeholder="Acme Inc." />
		</label>
		<label>
			Domain <span class="muted">(optional)</span>
			<input name="domain" maxlength="253" placeholder="acme.com" autocomplete="off" />
		</label>
		<label>
			Website <span class="muted">(optional)</span>
			<input name="website" maxlength="500" placeholder="https://acme.com" autocomplete="off" />
		</label>
		<button type="submit">Create company</button>
	</form>
	{#if form?.error}
		<p class="err">
			{form.error}
			{#if form.existingId}<a href="/companies/{form.existingId}">Open it →</a>{/if}
		</p>
	{/if}
</Modal>

<!-- #436: the pulse across every company (not the search / filter below). -->
<StatGroup label="Companies overview">
	<StatCell label="Companies" value={ov.total} href={tileUrl('all')} active={data.filter === 'all'}
		sub="{ov.linked} connected to Timing, GitHub or Zoho Books" />
	{#if tiles.active}
		<StatCell label="Active 30d" value={ov.active} href={tileUrl('active')} active={data.filter === 'active'}
			sub="{fmtHours(ov.hours30d)} tracked · {fmtHours(ov.hours7d)} in 7d" />
	{/if}
	{#if tiles.quiet}
		<StatCell label="Going quiet" value={ov.quiet} href={tileUrl('quiet')} active={data.filter === 'quiet'}
			tone={ov.quiet > 0 ? 'warn' : undefined} sub="hours in 90d, none in 30d" />
	{/if}
	{#if tiles.issues}
		<StatCell label="Open issues" value={ov.issuesOpen} href={tileUrl('issues')} active={data.filter === 'issues'}
			sub="+{ov.opened30d} opened · {ov.closed30d} closed in 30d" />
	{/if}
	{#if tiles.outstanding && bill}
		<StatCell label="Outstanding" value={moneyTile(bill.outstanding, bill.currency)} href={tileUrl('overdue')}
			active={data.filter === 'overdue'} tone={bill.overdue > 0 ? 'warn' : undefined}
			title={tileTitle('Outstanding', bill.outstanding)}
			sub="{bill.overdueCount} overdue · {moneyWhole(bill.overdue, bill.currency)}" />
	{/if}
	{#if tiles.invoiced && bill}
		<StatCell label="Invoiced 12m" value={moneyTile(bill.invoiced12m, bill.currency)}
			title={tileTitle('Invoiced 12m', bill.invoiced12m)}
			sub="{moneyWhole(bill.paid12m, bill.currency)} paid" />
	{/if}
</StatGroup>

{#if data.setup}
	<p class="muted setup">
		Timing: {plural(data.setup.timing, 'company')} linked · GitHub: {data.setup.github} ·
		{#if !data.setup.zohoConnected}
			Zoho Books: not connected — <a href="/settings/integrations">Connect →</a>
		{:else if data.setup.zoho === 0}
			Zoho Books: 0 companies linked — link customers from a company's Billing panel
		{:else}
			Zoho Books: {data.setup.zoho}
		{/if}
	</p>
{/if}

<section class="card">
	<nav class="filter-chips" aria-label="Filter companies">
		{#each data.filters as f (f.key)}
			<a class="chip-link" class:on={data.filter === f.key} href={filterUrl(f.key)}
				aria-current={data.filter === f.key ? 'page' : undefined} data-sveltekit-noscroll>{f.label}</a>
		{/each}
	</nav>
	<div class="search">
		<input type="search" bind:value={q} oninput={onSearchInput}
			onkeydown={(e) => e.key === 'Escape' && clearSearch()}
			placeholder="Search name or domain…" aria-label="Search companies" autocomplete="off" spellcheck="false" />
		{#if q}<button type="button" class="clear" aria-label="Clear search" onclick={clearSearch}><Icon name="close" size={16} /></button>{/if}
	</div>

	{#if data.companies.length === 0}
		<p class="muted">
			{#if data.filter !== 'all'}
				{#if data.q}No companies match “{data.q}” with the {filterLabel(data.filter)} filter.
				{:else}No companies with the {filterLabel(data.filter)} filter.{/if}
				<a href={filterUrl('all')}>Clear filter</a>
			{:else if data.q}No companies match “{data.q}”. <a href="/companies">Clear search</a>
			{:else}No companies yet. Set a contact's company, or create one.{/if}
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
							<th><a class="sort" href={sortUrl('name')} data-sveltekit-noscroll>Name<SortCaret dir={arrow('name')} /></a></th>
							<th>Domain</th><th>Contacts</th>
							<th class="num"><a class="sort" href={sortUrl('hours_30d')} data-sveltekit-noscroll>Hours 30d<SortCaret dir={arrow('hours_30d')} /></a></th>
							<th class="num"><a class="sort" href={sortUrl('open_issues')} data-sveltekit-noscroll>Open issues<SortCaret dir={arrow('open_issues')} /></a></th>
							{#if data.billing}
								<th class="num"><a class="sort" href={sortUrl('outstanding')} data-sveltekit-noscroll>Outstanding<SortCaret dir={arrow('outstanding')} /></a></th>
							{/if}
							<th><a class="sort" href={sortUrl('last_touch')} data-sveltekit-noscroll>Last touch<SortCaret dir={arrow('last_touch')} /></a></th>
						</tr>
				</thead>
				<tbody>
					{#each data.companies as co (co.id)}
						{@const src = lastTouchSource(co)}
						<tr>
							<td>
								<a href="/companies/{co.id}">{co.name}</a>
								{#if co.brief_one_liner}<span class="brief-line" title={co.brief_text ?? co.brief_one_liner}>{co.brief_one_liner}</span>{/if}
							</td>
							<td class="muted">{co.domain ?? ''}</td>
							<td>{co.contact_count}</td>
							<td class="num">
								{co.hours_30d === null ? '—' : fmtHours(co.hours_30d)}
								{#if (co.hours_7d ?? 0) > 0}<span class="sub">{fmtHours(co.hours_7d)} in 7d</span>{/if}
							</td>
							<td class="num">
								{co.issues_open ?? '—'}
								{#if (co.issues_opened_30d ?? 0) > 0 || (co.issues_closed_30d ?? 0) > 0}
									<span class="sub">+{co.issues_opened_30d ?? 0} / −{co.issues_closed_30d ?? 0} 30d</span>
								{/if}
							</td>
							{#if data.billing}
								<td class="num" title="Last invoice {co.last_invoice_at?.slice(0, 10) ?? '—'} · last payment {co.last_payment_at?.slice(0, 10) ?? '—'}">
									{money(co.ar_outstanding, co.billing_currency)}
									{#if (co.ar_overdue ?? 0) > 0}<span class="sub warn">{money(co.ar_overdue, co.billing_currency)} overdue</span>{/if}
								</td>
							{/if}
							<td class="muted">
								{#if co.last_touch_at}
									<span class="touch" title={src ? LAST_TOUCH_LABELS[src] : undefined}>
										{#if src}<Icon name={src} size={16} />{/if}{co.last_touch_at.slice(0, 10)}
									</span>
								{:else}—{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.pageCount > 1}
			<nav class="pager">
				{#if data.page > 1}<a class="pg" href={pageUrl(data.page - 1)} data-sveltekit-noscroll>← Prev</a>
				{:else}<span class="pg disabled">← Prev</span>{/if}
				<span class="muted pageinfo">Showing {from}–{to} of {data.total}</span>
				{#if data.page < data.pageCount}<a class="pg" href={pageUrl(data.page + 1)} data-sveltekit-noscroll>Next →</a>
				{:else}<span class="pg disabled">Next →</span>{/if}
			</nav>
		{/if}
	{/if}
</section>

<style>
	.head { display: flex; align-items: baseline; gap: var(--space-s); margin-bottom: var(--space-m); }
	h1 { margin: 0; }
	/* #388: the account brief one-liner under the name; hover (title) shows the full brief. */
	.brief-line { display: block; max-width: 36rem; color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: help; }
	.count { margin-right: auto; }
	.new-btn { padding: var(--space-xs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	@media (max-width: 640px) {
		.head { flex-wrap: wrap; row-gap: var(--space-s); }
		.new-btn { padding: var(--space-xxs) var(--space-s); }
	}
	.create-form { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.create-form label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.create-form button { align-self: flex-start; }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.search { position: relative; max-width: 360px; margin-bottom: var(--space-s); }
	.search input { width: 100%; padding-right: var(--space-xl); }
	.search .clear {
		position: absolute; right: 0.3rem; top: 50%; transform: translateY(-50%);
		border: none; background: transparent; color: var(--muted); box-shadow: none;
		font-size: var(--size-m);
		letter-spacing: var(--letter-spacing-m); line-height: 1; padding: 0 var(--space-xs); cursor: pointer;
	}
	.search .clear:hover { color: var(--text); }
	a.sort { color: inherit; text-decoration: none; white-space: nowrap; }
	a.sort:hover { color: var(--link-hover); }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	/* #436: setup line, filter chips (like /automations' label chips), cell second lines. */
	.setup { margin: calc(-1 * var(--space-xs)) 0 var(--card-gap); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.filter-chips { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-bottom: var(--space-s); }
	.chip-link {
		display: inline-flex; align-items: center; gap: var(--space-xxs);
		font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs);
		padding: var(--space-xxs) var(--space-s); border-radius: var(--radius-full);
		background: var(--neutral-muted); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
		color: var(--text); text-decoration: none;
	}
	.chip-link.on { background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: 0 0 0 var(--border-s) var(--accent); }
	.sub { display: block; color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; }
	.sub.warn { color: var(--warn); }
	.touch { display: inline-flex; align-items: center; gap: var(--space-xxs); white-space: nowrap; }
	.pager { display: flex; align-items: center; justify-content: center; gap: var(--space-m); margin-top: var(--space-m); flex-wrap: wrap; }
	.pg { padding: var(--space-xs) var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--link); }
	.pg:hover { text-decoration: none; background: var(--neutral-muted); }
	.pg.disabled { color: var(--muted); opacity: 0.6; pointer-events: none; }
	.pageinfo { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	@media (max-width: 768px) {
		.search { max-width: none; }
		.search .clear { min-width: 40px; min-height: 40px; }
		.search input { padding-right: var(--space-xxl); }
	}
</style>

<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SortCaret from '$lib/components/SortCaret.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import {
		SENDLOG_COLUMNS,
		DEFAULT_SENDLOG_COLUMNS,
		SENDLOG_COLS_LS_KEY,
		cleanSendLogColumns,
		rateText,
		type SendLogColumn
	} from '$lib/sendlog-columns';
	import { heldSummary, parseReport } from '$lib/presend-policy';

	let { data, form } = $props();

	// #481: bulk Publish to / Remove from the newsletter archive (admins; sent broadcasts).
	const isAdmin = $derived(data.user?.role === 'admin');
	let archiveIds = $state<number[]>([]);
	const archivable = (c: { kind: string; status: string }) => c.kind === 'campaign' && c.status === 'sent';

	// Column picker (#336) — persisted per browser like /contacts (#55). Subject is always shown.
	// The server renders the default set; the saved choice is applied on mount so SSR and
	// hydration agree (as /lists/[id] does).
	let visibleCols = $state<SendLogColumn[]>(DEFAULT_SENDLOG_COLUMNS);
	onMount(() => {
		try {
			visibleCols = cleanSendLogColumns(JSON.parse(localStorage.getItem(SENDLOG_COLS_LS_KEY) ?? 'null'));
		} catch {
			/* keep the default */
		}
	});
	function saveCols(cols: SendLogColumn[]) {
		visibleCols = cols;
		try {
			if (cols === DEFAULT_SENDLOG_COLUMNS) localStorage.removeItem(SENDLOG_COLS_LS_KEY);
			else localStorage.setItem(SENDLOG_COLS_LS_KEY, JSON.stringify(cols));
		} catch {
			/* storage unavailable — the choice lasts for this page view */
		}
	}
	function toggleCol(key: SendLogColumn) {
		saveCols(cleanSendLogColumns(visibleCols.includes(key) ? visibleCols.filter((k) => k !== key) : [...visibleCols, key]));
	}
	const columns = $derived(SENDLOG_COLUMNS.filter((c) => visibleCols.includes(c.key)));
	const isDefaultCols = $derived(
		visibleCols.length === DEFAULT_SENDLOG_COLUMNS.length && DEFAULT_SENDLOG_COLUMNS.every((k) => visibleCols.includes(k))
	);
	const TYPE_LABELS = { campaign: 'Campaign', direct: 'Direct (1:1)', automation: 'Automation' } as const;
	// Audience text for a row (#118) — one helper for the line under the subject and the column.
	function audienceText(c: { kind: string; audience: string }): string {
		if (!c.audience || c.audience === '—') return '';
		return c.kind === 'automation' ? c.audience.replace(/^automation:\s*/, '') : c.audience;
	}

	// Links (always carry the active filters + page size, #106). Mirrors /contacts's
	// urlWith (#94): start from the server's filterParams + per (+ sort/dir when
	// non-default), apply overrides, drop empty/null/default values so URLs stay clean.
	function urlWith(overrides: Record<string, string | number | null>): string {
		const p = new URLSearchParams(data.filterParams);
		if (data.per !== 25) p.set('per', String(data.per));
		if (data.sort !== 'date') p.set('sort', data.sort);
		if (data.dir !== 'desc') p.set('dir', data.dir);
		for (const [k, v] of Object.entries(overrides)) {
			if (v === null || v === '') p.delete(k);
			else p.set(k, String(v));
		}
		if (p.get('page') === '1') p.delete('page');
		if (p.get('per') === '25') p.delete('per');
		if (p.get('sort') === 'date') p.delete('sort');
		if (p.get('dir') === 'desc') p.delete('dir');
		return `?${p}`;
	}
	function urlClearFilters(): string {
		return urlWith({ status: null, type: null, q: null, from: null, to: null, page: null });
	}

	// Sortable headers (#80) — sort lives in the URL; changing it keeps filters and drops page.
	function sortUrl(col: string): string {
		const dir = data.sort === col && data.dir === 'desc' ? 'asc' : 'desc';
		return urlWith({ sort: col, dir, page: null });
	}
	function arrow(col: string): 'asc' | 'desc' | null {
		if (data.sort !== col) return null;
		return data.dir === 'desc' ? 'desc' : 'asc';
	}

	// Filters popover (mirrors /contacts, #94).
	let filtersOpen = $state(false);
	let filtersEl = $state<HTMLDetailsElement | null>(null);
	let colsOpen = $state(false);
	let colsEl = $state<HTMLDetailsElement | null>(null);
	function closeMenus(e: MouseEvent) {
		const t = e.target as Node;
		if (filtersOpen && filtersEl && !filtersEl.contains(t)) filtersOpen = false;
		if (colsOpen && colsEl && !colsEl.contains(t)) colsOpen = false;
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			filtersOpen = false;
			colsOpen = false;
		}
	}
	function applyFilters(e: SubmitEvent) {
		e.preventDefault();
		const fd = new FormData(e.currentTarget as HTMLFormElement);
		const p = new URLSearchParams();
		for (const [k, v] of fd) {
			const s = String(v).trim();
			if (!s) continue;
			if (k === 'status' && s === 'any') continue;
			if (k === 'type' && s === 'any') continue;
			if (k === 'sort' && s === 'date') continue;
			if (k === 'dir' && s === 'desc') continue;
			if (k === 'per' && s === '25') continue;
			p.set(k, s);
		}
		filtersOpen = false;
		goto(`?${p}`, { reset: false });
	}

	// Pager range text (#106).
	const from = $derived(data.matched === 0 ? 0 : (data.page - 1) * data.per + 1);
	const to = $derived(Math.min(data.page * data.per, data.matched));
</script>

<svelte:head><title>Campaigns</title></svelte:head>
<svelte:window onclick={(e: MouseEvent) => closeMenus(e)} onkeydown={onWindowKeydown} />

<div class="head">
	<h1>Campaigns</h1>
	<a href="/compose"><button>New campaign</button></a>
</div>

<StatGroup label="Campaign totals">
	<StatCell label="Campaigns sent" value={data.totals.campaigns} />
	<StatCell label="Emails delivered" value={data.totals.emails_sent} />
	<StatCell
		label="Open rate"
		value={data.rates.openRate === null ? '—' : `${data.rates.openRate}%`}
		sub="last 30 days"
		title="Unique openers ÷ delivered, broadcast campaigns sent in the last 30 days"
	/>
	<StatCell
		label="Click rate"
		value={data.rates.clickRate === null ? '—' : `${data.rates.clickRate}%`}
		sub="last 30 days"
		title="Unique clickers ÷ delivered, broadcast campaigns sent in the last 30 days"
	/>
	<StatCell label="Scheduled" value={data.totals.scheduled} />
</StatGroup>

<section class="card upcoming">
	<h2>Upcoming</h2>
	{#if data.upcoming.length === 0}
		<p class="muted">Nothing scheduled. Schedule a send from <a href="/compose">New campaign</a>.</p>
	{:else}
		<ul>
			{#each data.upcoming as u (`${u.kind}-${u.id}`)}
				<li>
					<span class="when"><Icon name="schedule" size={16} /> {u.at.slice(0, 16)} <span class="muted">UTC</span></span>
					<a href="/campaign/{u.id}">{u.subject}</a>
					{#if u.kind === 'resend'}<span class="badge type resent">resend to non-openers</span>{/if}
					{#if u.list_name}<span class="muted">· {u.list_name}</span>{/if}
					{#if u.weekday_only}<span class="muted">· weekdays only</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="card">
	<div class="loghead">
		<h2>
			Send log
			{#if data.filtered}
				<span class="muted">{data.matched} of {data.total} match{data.matched === 1 ? '' : 'es'}</span>
			{:else}
				<span class="muted">{data.total}</span>
			{/if}
		</h2>

		<details class="menu" bind:this={filtersEl} bind:open={filtersOpen}>
			<summary class:on={data.filtered}>Filters{#if data.filtered}<span class="dot"></span>{/if}</summary>
			<form class="filters" method="GET" onsubmit={applyFilters}>
				<label>
					Status
					<select name="status">
						<option value="any" selected={data.filter.status === 'any'}>Any</option>
						<option value="sent" selected={data.filter.status === 'sent'}>Sent</option>
						<option value="scheduled" selected={data.filter.status === 'scheduled'}>Scheduled</option>
						<option value="sending" selected={data.filter.status === 'sending'}>Sending</option>
						<option value="failed" selected={data.filter.status === 'failed'}>Failed</option>
						<option value="draft" selected={data.filter.status === 'draft'}>Draft</option>
					</select>
				</label>
				<label>
					Type
					<select name="type">
						<option value="any" selected={data.filter.type === 'any'}>Any</option>
						<option value="campaign" selected={data.filter.type === 'campaign'}>Campaign</option>
						<option value="direct" selected={data.filter.type === 'direct'}>Direct (1:1)</option>
						<option value="automation" selected={data.filter.type === 'automation'}>Automation</option>
						<option value="resent" selected={data.filter.type === 'resent'}>Resent</option>
					</select>
				</label>
				<label>
					Subject contains
					<input name="q" value={data.filter.q} placeholder="e.g. newsletter" />
				</label>
				<label>
					From
					<input type="date" name="from" value={data.filter.from} />
				</label>
				<label>
					To
					<input type="date" name="to" value={data.filter.to} />
				</label>
				<input type="hidden" name="sort" value={data.sort} />
				<input type="hidden" name="dir" value={data.dir} />
				<input type="hidden" name="per" value={data.per} />
				<div class="filter-actions">
					<button type="submit">Apply</button>
					{#if data.filtered}<a class="clear" href={urlClearFilters()}>Clear</a>{/if}
				</div>
			</form>
		</details>

		<details class="menu" bind:this={colsEl} bind:open={colsOpen}>
			<summary>Columns</summary>
			<div class="cols-menu">
				{#each SENDLOG_COLUMNS as col (col.key)}
					<label class="cols-item">
						<input type="checkbox" checked={visibleCols.includes(col.key)} onchange={() => toggleCol(col.key)} />
						{col.label}
					</label>
				{/each}
				<button type="button" class="link-btn" disabled={isDefaultCols} onclick={() => saveCols(DEFAULT_SENDLOG_COLUMNS)}>Reset to default</button>
			</div>
		</details>
	</div>

	{#if isAdmin}
		<!-- #481: the row checkboxes post with this form (form="archive-bulk"). -->
		<form id="archive-bulk" method="POST" action="?/archiveBulk" use:enhance={() => async ({ update }) => { await update(); archiveIds = []; }} class="archive-bar" class:show={archiveIds.length > 0}>
			<span>{archiveIds.length} selected</span>
			<button type="submit" name="op" value="publish" class="small">Publish to newsletter archive</button>
			<button type="submit" name="op" value="remove" class="secondary small">Remove from newsletter archive</button>
		</form>
		{#if form?.archiveDone}
			<p class="muted archive-msg" role="status">
				{form.archiveDone.op === 'publish' ? 'Published' : 'Removed'} {form.archiveDone.changed}{#if form.archiveDone.skipped} · {form.archiveDone.skipped} skipped (not a sent broadcast){/if}.
			</p>
		{:else if form?.archiveError}
			<p class="err archive-msg" role="alert">{form.archiveError}</p>
		{/if}
	{/if}
	{#if data.campaigns.length === 0}
		{#if data.filtered}
			<p class="muted">No sends match. <a href={urlClearFilters()}>Clear filters</a></p>
		{:else}
			<p class="muted">No campaigns yet. <a href="/compose">Start your first campaign →</a></p>
		{/if}
	{:else}
		<div class="table-wrap">
			<table class="log">
				<thead>
					<tr>
						{#if isAdmin}<th class="pick"><span class="sr-only">Select for the newsletter archive</span></th>{/if}
						<th><a class="sort" href={sortUrl('subject')} data-sveltekit-reset="false">Subject<SortCaret dir={arrow('subject')} /></a></th>
						{#each columns as col (col.key)}
							<th class:num-col={col.key !== 'status' && col.key !== 'audience' && col.key !== 'type' && col.key !== 'date'}>
								<a class="sort" href={sortUrl(col.key)} data-sveltekit-reset="false">{col.label}<SortCaret dir={arrow(col.key)} /></a>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each data.campaigns as c (c.id)}
						<tr>
							{#if isAdmin}
								<td class="pick">
									{#if archivable(c)}
										<input type="checkbox" form="archive-bulk" name="id" value={c.id} bind:group={archiveIds} aria-label="Select “{c.subject}” for the newsletter archive" />
									{/if}
								</td>
							{/if}
							<td>
								<a href="/campaign/{c.id}">{c.subject}</a>
								{#if c.in_archive}<span class="badge type" title="Published to the newsletter archive">in newsletter archive</span>{/if}
								{#if c.edited_for_web}<span class="badge type" title="The newsletter archive page uses a web-only version">edited for web</span>{/if}
								{#if c.kind === 'automation'}<span class="badge type">automation</span>{/if}
								{#if c.kind === 'direct'}<span class="badge type">direct</span>{/if}
								{#if c.resend_status === 'sent'}
									<span class="badge type resent" title="resent {c.resent_at} to {c.resend_recipients}">resent</span>
								{/if}
								{#if audienceText(c) && !visibleCols.includes('audience')}
									<div class="muted audience">{audienceText(c)}</div>
								{/if}
							</td>
							{#each columns as col (col.key)}
								{#if col.key === 'status'}
									<td>
										<span class="badge {c.status}">{c.status}</span>
										{#if c.held_at && c.status === 'scheduled'}
											<!-- #479 / #305: a held scheduled send. -->
											<div>
												<a class="badge failed" href="/campaign/{c.id}" title="Open it to re-check, edit or release"
													>Held: {c.held_reason === 'preflight' ? heldSummary(parseReport(c.preflight_report)) : 'deliverability alert'}</a
												>
											</div>
										{/if}
										{#if c.status === 'canceled'}<div><a class="small" href="/campaign/{c.id}">Edit & reschedule</a></div>{/if}
									</td>
								{:else if col.key === 'sent'}
									<td class="num-col">{c.recipient_count}</td>
								{:else if col.key === 'delivered'}
									<td class="num-col">{c.accepted}</td>
								{:else if col.key === 'open_rate'}
									<td class="num-col">{rateText(c.open_rate)}</td>
								{:else if col.key === 'opens'}
									<td class="num-col">{c.opens}</td>
								{:else if col.key === 'click_rate'}
									<td class="num-col">{rateText(c.click_rate)}</td>
								{:else if col.key === 'clicks'}
									<td class="num-col">{c.clicks}</td>
								{:else if col.key === 'ctor'}
									<td class="num-col">{rateText(c.ctor)}</td>
								{:else if col.key === 'unsubs'}
									<td class="num-col">{c.unsubs}</td>
								{:else if col.key === 'unsub_rate'}
									<td class="num-col">{rateText(c.unsub_rate)}</td>
								{:else if col.key === 'bounces'}
									<td class="num-col">{c.bounces}</td>
								{:else if col.key === 'bounce_rate'}
									<td class="num-col">{rateText(c.bounce_rate)}</td>
								{:else if col.key === 'replies'}
									<td class="num-col">{c.replies}</td>
								{:else if col.key === 'audience'}
									<td class="muted audience-cell">{audienceText(c) || '—'}</td>
								{:else if col.key === 'type'}
									<td>{TYPE_LABELS[c.kind]}</td>
								{:else if col.key === 'date'}
									<td class="muted">
										{#if c.kind === 'automation' && c.automation_id}
											step · <a href="/automations/{c.automation_id}">automation →</a>
										{:else if c.status === 'scheduled' && c.scheduled_at}
											<Icon name="schedule" size={16} /> {c.scheduled_at.slice(0, 16)}
										{:else}
											{(c.sent_at ?? c.created_at)?.slice(0, 16)}
										{/if}
									</td>
								{/if}
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.pageCount > 1 || data.matched > 25}
			<nav class="pager">
				{#if data.page > 1}
					<a class="pg" href={urlWith({ page: data.page - 1 })} data-sveltekit-reset="false">← Prev</a>
				{:else}
					<span class="pg disabled">← Prev</span>
				{/if}
				<span class="muted pageinfo">Showing {from}–{to} of {data.matched}</span>
				{#if data.page < data.pageCount}
					<a class="pg" href={urlWith({ page: data.page + 1 })} data-sveltekit-reset="false">Next →</a>
				{:else}
					<span class="pg disabled">Next →</span>
				{/if}
				<span class="per">
					<span class="muted">Per page:</span>
					{#each data.perOptions as opt (opt)}
						{#if opt === data.per}
							<span class="per-opt active">{opt}</span>
						{:else}
							<a class="per-opt" href={urlWith({ per: opt, page: 1 })} data-sveltekit-reset="false">{opt}</a>
						{/if}
					{/each}
				</span>
			</nav>
		{/if}
	{/if}
</section>

<style>
	/* #481: newsletter archive bulk bar + row picks */
	.archive-bar { display: none; align-items: center; gap: var(--space-s); flex-wrap: wrap; margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.archive-bar.show { display: flex; }
	.archive-msg { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.pick { width: 1%; white-space: nowrap; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.head a:hover {
		text-decoration: none;
	}
	h1 {
		margin: 0;
	}
	/* Mobile (#144): title above the action; stat tiles 2-up, then 1-up. */
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			align-items: flex-start;
			gap: var(--space-s);
		}
		.head button {
			padding: var(--space-xxs) var(--space-s);
		}
	}
	/* Upcoming (#132) — scheduled sends + pending resends. */
	.upcoming {
		margin-bottom: var(--space-l);
	}
	.upcoming h2 {
		margin: 0 0 var(--space-s);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.upcoming ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.upcoming li {
		padding: var(--space-xs) 0;
		box-shadow: inset 0 var(--border-s) 0 var(--border);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		overflow-wrap: anywhere;
	}
	.upcoming li:first-child {
		box-shadow: none;
	}
	.upcoming .when {
		display: inline-block;
		min-width: 11.5rem;
		font-variant-numeric: tabular-nums;
	}
	.loghead {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.loghead h2 {
		margin: 0;
		margin-right: auto;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	a.sort {
		color: inherit;
		text-decoration: none;
		white-space: nowrap;
	}
	a.sort:hover {
		color: var(--link-hover);
	}
	.badge.type {
		margin-left: var(--space-xs);
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 35%, var(--border));
	}
	.badge.type.resent {
		color: var(--text);
		background: color-mix(in srgb, var(--warning) 12%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warning) 35%, var(--border));
	}
	/* Audience hint (#118) — who a list-less/automation send went to, under the subject. */
	.audience {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		margin-top: var(--space-xxs);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 28rem;
	}
	/* Number columns (#336) line up on the right. */
	.log .num-col {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.audience-cell {
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Column picker (#336) — same popover look as Filters. */
	.cols-menu {
		position: absolute; right: 0; z-index: 20; margin-top: var(--space-xs); padding: var(--space-s) var(--space-m);
		background: var(--surface); border: 0; border-radius: var(--radius-lg);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
		display: flex; flex-direction: column; gap: var(--space-xs); min-width: 12rem;
		max-height: min(70vh, 32rem); overflow-y: auto;
	}
	.cols-item { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); white-space: nowrap; }
	.link-btn {
		align-self: flex-start; margin-top: var(--space-xxs); padding: 0; background: none; border: 0; box-shadow: none;
		color: var(--text); text-decoration: underline; text-decoration-color: var(--accent);
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); cursor: pointer;
	}
	.link-btn:disabled { color: var(--muted); text-decoration: none; cursor: default; }
	/* Phones: the table scrolls in its wrap with the subject pinned. */
	@media (max-width: 640px) {
		.log th:first-child,
		.log td:first-child {
			position: sticky;
			left: 0;
			z-index: 1;
			background: var(--surface);
			min-width: 9rem;
			max-width: 11rem;
			overflow-wrap: anywhere;
		}
		.log thead th:first-child {
			background: var(--surface-subtle);
		}
		.audience {
			max-width: 11rem;
		}
	}
	/* Filters popover (mirrors /contacts) */
	.menu { position: relative; }
	.menu summary {
		list-style: none; cursor: pointer; padding: var(--space-xxs) var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); background: var(--btn-bg); user-select: none;
		white-space: nowrap;
	}
	.menu summary::-webkit-details-marker { display: none; }
	.menu summary:hover { background: var(--btn-hover); }
	.menu summary.on { box-shadow: 0 0 0 var(--border-s) var(--accent); color: var(--text); }
	.dot {
		display: inline-block; width: 6px; height: 6px; margin-left: var(--space-xs); border-radius: var(--radius-full);
		background: var(--accent); vertical-align: middle;
	}
	.filters {
		position: absolute; right: 0; z-index: 20; margin-top: var(--space-xs); padding: var(--space-m);
		background: var(--surface); border: 0; border-radius: var(--radius-lg);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium); display: grid; grid-template-columns: repeat(2, minmax(150px, 1fr));
		gap: var(--space-s); width: min(94vw, 460px);
	}
	.filters label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); color: var(--muted); }
	.filters input, .filters select { width: 100%; }
	.filter-actions { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-s); }
	.filter-actions .clear { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	@media (max-width: 480px) {
		.filters { grid-template-columns: minmax(0, 1fr); width: min(80vw, 460px); }
	}
	/* Pager (mirrors /contacts) */
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
</style>

<script lang="ts">
	// The /contacts Overview (#423): KPI tiles, growth, by source / by list, engagement mix,
	// needs attention, groups and the filter-aware activity feed — all over the contacts the
	// page's filter matches. Collapsible (localStorage `contacts.overview`, open by default);
	// the period lives in the URL (`?period=`). Tiles and rows are links to the matching
	// /contacts filter.
	import { enhance } from '$app/forms';
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import TierTrend from '$lib/components/TierTrend.svelte';
	import GrowthChart from '$lib/components/GrowthChart.svelte';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import { PERIODS } from '$lib/contacts-overview';
	import type { ContactsOverview } from '$lib/server/contacts-overview';
	import type { ActivityExtra, ActivityGroup, ActivityItem } from '$lib/server/activity';

	type Feed = {
		items: ActivityItem[];
		groups: ActivityGroup[] | null;
		extras: Record<number, ActivityExtra>;
		size: number;
		sizes: number[];
		types: string[];
		period: boolean;
		group: boolean;
		typeOptions: { key: string; label: string }[];
	};
	type GroupCount = { kind: 'list' | 'segment' | 'tag' | 'company'; label: string; count: number };

	let {
		overview,
		feed,
		actions,
		scopeLabel,
		filterParams,
		groupCounts,
		urlWith,
		clearHref,
		onCreate,
		form = null
	}: {
		overview: ContactsOverview;
		feed: Feed;
		actions: { live: boolean; unmapped: string[]; reportHref: string };
		scopeLabel: string | null;
		filterParams: Record<string, string>;
		groupCounts: GroupCount[];
		urlWith: (o: Record<string, string | number | null>) => string;
		clearHref: string;
		onCreate: (kind: 'list' | 'segment' | 'tag') => void;
		form?: { viewSaved?: boolean; bulkSuccess?: string; bulkError?: string; bulkHref?: string | null } | null;
	} = $props();

	// Collapsed state per browser; SSR renders it open, the saved choice applies on mount.
	const LS_KEY = 'contacts.overview';
	let open = $state(true);
	onMount(() => {
		if (localStorage.getItem(LS_KEY) === 'closed') open = false;
	});
	function toggle() {
		open = !open;
		if (browser) localStorage.setItem(LS_KEY, open ? 'open' : 'closed');
	}

	const now = $derived.by(() => {
		void feed;
		return new Date();
	});
	const fmt = (n: number) => n.toLocaleString('en-US');
	const barMax = (rows: { n: number }[]) => Math.max(1, ...rows.map((r) => r.n));

	// Feed controls: everything rides the URL like the table's filters.
	const feedTypesSet = $derived(new Set(feed.types));
	function applyTypes(e: SubmitEvent) {
		e.preventDefault();
		const fd = new FormData(e.currentTarget as HTMLFormElement);
		const picked = fd.getAll('t').map(String);
		const all = picked.length === 0 || picked.length === feed.typeOptions.length;
		goto(urlWith({ feed_types: all ? null : picked.join(',') }), { reset: false });
	}
	const exportHref = $derived.by(() => {
		const p = new URLSearchParams(filterParams);
		if (feed.types.length) p.set('feed_types', feed.types.join(','));
		if (feed.period) p.set('feed_period', '1');
		if (overview.period !== '30d') p.set('period', overview.period);
		const q = p.toString();
		return `/contacts/activity/export${q ? `?${q}` : ''}`;
	});
	const periodLabel = $derived(PERIODS.find((p) => p.key === overview.period)?.label ?? overview.period);
	let saveMode = $state('0'); // '1' = live (rules), '0' = hand-picked snapshot
	$effect(() => {
		saveMode = actions.live ? '1' : '0';
	});
</script>

<section class="card overview" aria-labelledby="ov-title">
	<div class="ov-head">
		<h2 id="ov-title">
			<button type="button" class="ov-toggle" aria-expanded={open} aria-controls="ov-body" onclick={toggle}>
				<span class="caret" class:shut={!open} aria-hidden="true"></span>
				Overview
			</button>
		</h2>
		<nav class="seg" aria-label="Overview period">
			{#each PERIODS as p (p.key)}
				<a
					class="seg-opt"
					class:on={overview.period === p.key}
					aria-current={overview.period === p.key ? 'true' : undefined}
					href={urlWith({ period: p.key === '30d' ? null : p.key })}
					data-sveltekit-reset="false">{p.label}</a
				>
			{/each}
		</nav>
		<span class="ov-actions">
			<details class="pop">
				<summary>Save as segment</summary>
				<form
					method="POST"
					action="?/saveView"
					class="pop-body"
					use:enhance={() =>
						async ({ update }) => {
							await update({ reset: false });
						}}
				>
					{#each Object.entries(filterParams) as [k, v] (k)}<input type="hidden" name={k} value={v} />{/each}
					<label>Segment name <input name="new_segment" required maxlength="60" placeholder="e.g. Hot leads, no deal" /></label>
					{#if actions.live}
						<label class="radio"><input type="radio" name="live" value="1" bind:group={saveMode} /> Live segment — keeps matching as contacts change</label>
						<label class="radio"><input type="radio" name="live" value="0" bind:group={saveMode} /> Snapshot of today's {fmt(overview.scopeCount)}</label>
					{:else}
						<input type="hidden" name="live" value="0" />
						<p class="muted note">
							Saved as a hand-picked snapshot of the {fmt(overview.scopeCount)} contacts{#if actions.unmapped.length} — {actions.unmapped.join(', ')} can't be a segment rule{/if}.
						</p>
					{/if}
					<button type="submit">Save segment</button>
				</form>
			</details>
			<a class="btn-link" href={actions.reportHref}>Create report</a>
		</span>
	</div>

	{#if form?.viewSaved && (form.bulkSuccess || form.bulkError)}
		{#if form.bulkError}<p class="flash err" role="alert">{form.bulkError}</p>
		{:else}<p class="flash ok" role="status">{form.bulkSuccess}.{#if form.bulkHref}{' '}<a href={form.bulkHref}>Open</a>{/if}</p>{/if}
	{/if}

	{#if scopeLabel}
		<p class="scope">
			<span class="scope-chip" title={scopeLabel}>Overview for: {scopeLabel}</span>
			<a href={clearHref}>Clear</a>
		</p>
	{/if}

	<div id="ov-body" hidden={!open}>
		{#if overview.approximate}
			<p class="muted note">Over {fmt(50000)} contacts match — the charts below read the first {fmt(50000)} (approximate).</p>
		{/if}

		<StatGroup label="Contacts overview">
			{#each overview.tiles as t (t.key)}
				<StatCell label={t.label} value={fmt(t.value)} sub={t.sub} href={t.href ?? undefined} />
			{/each}
		</StatGroup>

		<div class="ov-grid">
			<section class="card sub">
				<h3>Growth <span class="muted">· {periodLabel}</span></h3>
				<GrowthChart points={overview.growth} unit={overview.growthUnit} />
			</section>

			<section class="card sub">
				<h3>By source</h3>
				{#if overview.sources.length === 0}
					<p class="muted note">No contacts.</p>
				{:else}
					{@const max = barMax(overview.sources)}
					<ul class="bars">
						{#each overview.sources as r (r.label)}
							<li>
								<span class="bar-label" title={r.label}>{#if r.href}<a href={r.href}>{r.label}</a>{:else}{r.label}{/if}</span>
								<span class="bar-track" aria-hidden="true"><span class="bar" style="width: {Math.max(3, (r.n / max) * 100)}%"></span></span>
								<span class="bar-n">{fmt(r.n)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="card sub">
				<h3>By list</h3>
				{#if overview.lists.length === 0}
					<p class="muted note">None of these contacts is in a list.</p>
				{:else}
					{@const max = barMax(overview.lists)}
					<ul class="bars">
						{#each overview.lists as r (r.href)}
							<li>
								<span class="bar-label" title={r.label}><a href={r.href}>{r.label}</a></span>
								<span class="bar-track" aria-hidden="true"><span class="bar" style="width: {Math.max(3, (r.n / max) * 100)}%"></span></span>
								<span class="bar-n">{fmt(r.n)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="card sub">
				<h3>Engagement mix</h3>
				<TierTrend tiers={overview.engagement.tiers} trend={overview.trend} tierHref={(t) => urlWith({ tier: t, page: null })} />
				<p class="muted note">
					Avg score {overview.engagement.average_score ?? '—'} · opened in 30d {fmt(overview.engagement.opened_last_30d)} ·
					clicked in 30d {fmt(overview.engagement.clicked_last_30d)}
				</p>
			</section>

			<section class="card sub">
				<h3>Needs attention</h3>
				{#if overview.attention.length === 0}
					<p class="muted note">Nothing needs attention.</p>
				{:else}
					<ul class="rows">
						{#each overview.attention.slice(0, 8) as a (a.key)}
							<li>
								<span class="row-label">{a.label}</span>
								<strong>{fmt(a.n)}</strong>
								<a href={a.href}>{a.action} →</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="card sub">
				<h3>Groups</h3>
				<ul class="rows">
					{#each groupCounts as g (g.kind)}
						<li>
							<a class="row-label" href="/groups/{g.kind}">{g.label}</a>
							<strong>{fmt(g.count)}</strong>
							{#if g.kind !== 'company'}
								<button type="button" class="mini-add" title="New {g.kind}" aria-label="New {g.kind}" onclick={() => onCreate(g.kind as 'list' | 'segment' | 'tag')}>+</button>
							{:else}
								<span class="mini-add-spacer"></span>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		</div>

		<section class="card sub feed">
			<div class="feed-head">
				<h3>Activity</h3>
				<form
					method="POST"
					action="?/feedSize"
					use:enhance={() =>
						async ({ update }) => {
							await update({ reset: false });
						}}
				>
					<label class="muted size">
						Show
						<select name="size" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
							{#each feed.sizes as n (n)}<option value={n} selected={n === feed.size}>{n}</option>{/each}
						</select>
					</label>
				</form>
				<a class="btn-link" href={exportHref} download>Export feed CSV</a>
			</div>
			<div class="feed-tools">
				<details class="pop">
					<summary>Types{#if feed.types.length}<span class="muted"> · {feed.types.length}</span>{/if}</summary>
					<form class="pop-body" onsubmit={applyTypes}>
						{#each feed.typeOptions as t (t.key)}
							<label class="radio"><input type="checkbox" name="t" value={t.key} checked={feedTypesSet.size === 0 || feedTypesSet.has(t.key)} /> {t.label}</label>
						{/each}
						<button type="submit">Apply</button>
					</form>
				</details>
				<a class="chip" class:on={feed.period} href={urlWith({ feed_period: feed.period ? null : '1' })} aria-current={feed.period ? 'true' : undefined} data-sveltekit-reset="false">This period ({periodLabel})</a>
				<a class="chip" class:on={feed.group} href={urlWith({ feed_group: feed.group ? null : '1' })} aria-current={feed.group ? 'true' : undefined} data-sveltekit-reset="false">Group by contact</a>
			</div>
			{#if (feed.groups ? feed.groups.length : feed.items.length) === 0}
				<p class="muted note">No activity for these contacts{feed.period ? ' in this period' : ''}.</p>
			{:else}
				<ActivityFeed items={feed.items} groups={feed.groups} extras={feed.extras} {now} />
			{/if}
		</section>
	</div>
</section>

<style>
	.overview {
		margin-bottom: var(--space-l);
	}
	.ov-head {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		flex-wrap: wrap;
	}
	.ov-head h2 {
		margin: 0 auto 0 0;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.ov-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
		color: var(--text);
		font: inherit;
		font-weight: var(--weight-ui-heavy);
		cursor: pointer;
	}
	.caret {
		width: 0;
		height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-top: 6px solid currentColor;
		transition: transform 0.15s;
	}
	.caret.shut {
		transform: rotate(-90deg);
	}
	.seg {
		display: inline-flex;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}
	.seg-opt {
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		color: var(--text);
		background: var(--surface);
	}
	.seg-opt + .seg-opt {
		box-shadow: inset var(--border-s) 0 0 var(--border);
	}
	.seg-opt:hover {
		text-decoration: none;
		background: var(--neutral-muted);
	}
	.seg-opt.on {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		font-weight: var(--weight-ui-medium);
	}
	.ov-actions {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.btn-link {
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		white-space: nowrap;
	}
	.btn-link:hover {
		text-decoration: none;
		box-shadow: 0 0 0 var(--border-s) var(--muted);
	}
	.pop {
		position: relative;
	}
	.pop > summary {
		list-style: none;
		cursor: pointer;
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		white-space: nowrap;
	}
	.pop > summary::-webkit-details-marker {
		display: none;
	}
	.pop-body {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 10;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		min-width: 16rem;
		padding: var(--space-s);
		background: var(--surface);
		border-radius: var(--radius);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-m);
	}
	.feed-tools .pop-body {
		left: 0;
		right: auto;
	}
	.pop-body label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		color: var(--muted);
	}
	.pop-body label.radio {
		flex-direction: row;
		align-items: center;
		gap: var(--space-xs);
		color: var(--text);
	}
	.pop-body label.radio input {
		width: auto;
	}
	.pop-body button {
		align-self: flex-start;
	}
	.scope {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin: var(--space-s) 0 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.scope-chip {
		padding: 0 var(--space-s);
		border-radius: var(--radius-full);
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: min(640px, 100%);
	}
	#ov-body {
		margin-top: var(--space-m);
	}
	.ov-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
		gap: var(--space-m);
		margin: var(--space-m) 0;
		align-items: start;
	}
	.sub {
		min-width: 0;
		margin: 0;
	}
	.sub h3 {
		margin: 0 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.note {
		margin: var(--space-xs) 0 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.bars,
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
	}
	.bars li {
		display: grid;
		grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.bar-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bar-track {
		display: block;
		height: 12px;
	}
	.bar {
		display: block;
		height: 12px;
		border-radius: 0 4px 4px 0;
		background: var(--viz-2);
	}
	.bar-n {
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.rows li {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-xxs) 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted);
	}
	.rows li:last-child {
		box-shadow: none;
	}
	.row-label {
		margin-right: auto;
		min-width: 0;
	}
	.mini-add {
		padding: 0 var(--space-xs);
		line-height: var(--line-s);
		background: transparent;
		color: var(--muted);
		border: var(--border-s) dashed var(--border);
		border-radius: var(--radius-xs);
		box-shadow: none;
	}
	.mini-add:hover {
		color: var(--text);
		border-style: solid;
	}
	.mini-add-spacer {
		width: 1.6rem;
	}
	.feed-head {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.feed-head h3 {
		margin: 0 auto 0 0;
	}
	.feed-head form {
		margin: 0;
	}
	.size {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.feed-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		margin-bottom: var(--space-s);
	}
	.chip {
		padding: 0 var(--space-s);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	.chip:hover {
		text-decoration: none;
		color: var(--text);
		background: var(--neutral-muted);
	}
	.chip.on {
		color: var(--text);
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.flash {
		margin: var(--space-s) 0 0;
		padding: var(--space-xs) var(--space-s);
		border-radius: var(--radius-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.flash.ok {
		background: color-mix(in srgb, var(--success) 12%, transparent);
	}
	.flash.err {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}
	@media (max-width: 640px) {
		.ov-head h2 {
			flex-basis: 100%;
		}
		/* #577: a wide table (Engagement mix) scrolls inside its card, never widens the page. */
		.sub {
			overflow-x: auto;
		}
	}
</style>

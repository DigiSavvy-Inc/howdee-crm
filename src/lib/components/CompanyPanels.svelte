<script lang="ts">
	// Company dashboard 4/4 (#567): the compact panels in the page's right column — open deals,
	// recent conversations (streamed; awaiting our reply first), Timing hours with a weekly
	// sparkline, GitHub counts + recent issues, and the billing summary (only when `billing` is
	// given, i.e. the viewer may see money). A panel only shows when its source has data; every
	// attach / sync / link control lives in the page's Manage integrations card.
	import Icon from './Icon.svelte';
	import StagePill from './StagePill.svelte';
	import HoursSparkline from './HoursSparkline.svelte';
	import { relTime } from '$lib/reltime';
	import { formatDateTime } from '$lib/report-view';
	import { daysSince, formatValue } from '$lib/pipeline';
	import { fmtHours } from '$lib/timing-format';
	import { money } from '$lib/money';
	import type { WeekHours } from '$lib/company-panels';
	import type { CompanyDashboard } from '$lib/server/company-dashboard';
	import type { ConversationPanelRow } from '$lib/server/company-conversations';
	import type { CompanyTiming } from '$lib/server/integrations/timing';
	import type { GithubMetrics } from '$lib/server/integrations/github';
	import type { BillingView } from '$lib/server/integrations/zoho';

	type Conversations = { rows: ConversationPanelRow[]; total: number; awaiting: number } | null;

	let {
		dashboard: d,
		conversations,
		timing,
		hoursWeekly,
		github,
		billing,
		tz
	}: {
		dashboard: CompanyDashboard;
		conversations: Promise<Conversations> | Conversations;
		timing: CompanyTiming | null;
		hoursWeekly: WeekHours[] | null;
		github: GithubMetrics | null;
		billing: BillingView | null;
		tz: string;
	} = $props();

	const DEALS_SHOWN = 5;
	const ISSUES_SHOWN = 5;
	const nameOf = (c: { email: string; name: string | null; first_name: string | null; last_name: string | null }) =>
		c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email;
	const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
	const timingOn = $derived(!!timing?.project_id && !!timing.timing_synced_at);
	const bm = $derived(billing?.links.length ? billing.metrics : null);
	// Past 30 days relTime() returns the date itself, so only add it while it differs.
	const lastPaid = $derived.by(() => {
		const d = bm?.last_payment_at;
		if (!d) return '—';
		const rel = relTime(d);
		return rel && rel !== d.slice(0, 10) ? `${d} (${rel})` : d;
	});
</script>

<section class="card panel" id="deals" aria-labelledby="co-deals-h">
	<h2 id="co-deals-h">Open deals <span class="muted">{d.openDeals.length}</span></h2>
	{#if d.openDeals.length === 0}
		<p class="muted small">No open deals. Add a contact to the <a href="/pipeline">pipeline</a> from their page.</p>
	{:else}
		<ul class="rows">
			{#each d.openDeals.slice(0, DEALS_SHOWN) as c (c.card_id)}
				{@const n = daysSince(c.entered_stage_at)}
				<li>
					<a class="main" href="/contacts/{c.id}">{nameOf(c)}</a>
					<span class="meta">
						<StagePill name={c.stage} color={c.color} />
						<span>{formatValue(c.value)}</span>
						<span class="muted" title="In this stage since {formatDateTime(c.entered_stage_at, tz)}">{days(n)} in stage</span>
					</span>
				</li>
			{/each}
		</ul>
		{#if d.openDeals.length > DEALS_SHOWN}
			<p class="foot"><a href="/pipeline">{d.openDeals.length - DEALS_SHOWN} more on the pipeline</a></p>
		{/if}
	{/if}
</section>

<section class="card panel" id="conversations" aria-labelledby="co-conv-h">
	<h2 id="co-conv-h">Conversations</h2>
	{#await conversations}
		<p class="muted small" role="status">Loading conversations…</p>
	{:then conv}
		{#if conv === null}
			<p class="err small">Couldn't load conversations.</p>
		{:else if conv.rows.length === 0}
			<p class="muted small">No replies or 1:1 emails with this company's contacts in the last 90 days.</p>
		{:else}
			<ul class="rows">
				{#each conv.rows as t (t.key)}
					<li>
						<a class="main" href="/conversations/{encodeURIComponent(t.key)}">{t.subject}</a>
						<span class="meta">
							{#if t.awaiting}<span class="badge sending">Awaiting our reply</span>{/if}
							{#if t.gmail}<span class="src" title="Includes Gmail messages"><Icon name="gmail" size={16} label="Gmail" /></span>{/if}
							<span class="muted">{t.who} · {t.count} message{t.count === 1 ? '' : 's'}</span>
							<span class="muted" title={formatDateTime(t.last_at, tz)}>{relTime(t.last_at)}</span>
						</span>
					</li>
				{/each}
			</ul>
			<p class="foot muted">
				{conv.total} in 90 days{#if conv.awaiting}{' '}· {conv.awaiting} awaiting our reply{/if}
			</p>
		{/if}
	{/await}
</section>

{#if timingOn && timing}
	<section class="card panel" id="timing" aria-labelledby="co-timing-h">
		<h2 id="co-timing-h"><Icon name="timing" size={16} /> Timing</h2>
		<dl class="nums">
			<div><dt>7 days</dt><dd>{fmtHours(timing.hours_7d)}</dd></div>
			<div><dt>30 days</dt><dd>{fmtHours(timing.hours_30d)}</dd></div>
			<div><dt>90 days</dt><dd>{fmtHours(timing.hours_90d)}</dd></div>
			<div><dt>Total</dt><dd>{fmtHours(timing.hours_total)}</dd></div>
		</dl>
		{#if hoursWeekly && hoursWeekly.some((w) => w.hours != null)}
			<HoursSparkline weeks={hoursWeekly} />
		{/if}
		<p class="foot muted">
			{#if timing.last_tracked_at}Last tracked: {timing.last_tracked_title ?? '(untitled)'} · {relTime(timing.last_tracked_at)}{:else}Nothing tracked yet.{/if}
		</p>
	</section>
{/if}

{#if github}
	<section class="card panel" id="github" aria-labelledby="co-gh-h">
		<h2 id="co-gh-h"><Icon name="github" size={16} /> GitHub</h2>
		<dl class="nums">
			<div><dt>Open</dt><dd>{github.issues_open ?? 0}</dd></div>
			<div><dt>Opened 30d</dt><dd>{github.issues_opened_30d ?? 0}</dd></div>
			<div><dt>Closed 30d</dt><dd>{github.issues_closed_30d ?? 0}</dd></div>
		</dl>
		{#if github.recent_issues.length}
			<ul class="rows">
				{#each github.recent_issues.slice(0, ISSUES_SHOWN) as i (i.html_url)}
					<li>
						<a class="main" href={i.html_url} target="_blank" rel="noopener noreferrer">{i.title}</a>
						<span class="meta">
							<span class="badge {i.state === 'open' ? 'sent' : 'draft'}">{i.state === 'open' ? 'Open' : 'Closed'}</span>
							<span class="muted">{i.repo ?? ''}#{i.number} · {relTime(i.updated_at)}</span>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		<p class="foot muted">Synced {github.github_synced_at ? relTime(github.github_synced_at) : 'never'}.</p>
	</section>
{/if}

{#if billing?.links.length}
	<section class="card panel" id="billing" aria-labelledby="co-bill-h">
		<h2 id="co-bill-h"><Icon name="billing" size={16} /> Billing <span class="muted">Zoho Books</span></h2>
		{#if bm}
			<dl class="nums">
				<div><dt>Outstanding</dt><dd>{money(bm.ar_outstanding, bm.billing_currency)}</dd></div>
				<div class:warn={(bm.ar_overdue ?? 0) > 0}><dt>Overdue</dt><dd>{money(bm.ar_overdue, bm.billing_currency)}</dd></div>
				<div><dt>Invoiced 12m</dt><dd>{money(bm.invoiced_12m, bm.billing_currency)}</dd></div>
				<div><dt>Paid 12m</dt><dd>{money(bm.paid_12m, bm.billing_currency)}</dd></div>
			</dl>
			<p class="foot muted">
				Last payment {lastPaid}.
				<a href="#manage-billing">Invoices and payments</a>
			</p>
		{:else}
			<p class="muted small">Not synced yet.</p>
		{/if}
	</section>
{/if}

<style>
	.panel {
		margin: 0;
		min-width: 0;
	}
	h2 {
		margin-top: 0;
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.small,
	.foot {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		margin: var(--space-xs) 0 0;
	}
	.err {
		color: var(--danger);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows li {
		display: grid;
		gap: var(--space-xxs);
		padding: var(--space-xs) 0;
		border-top: 1px solid var(--border);
		min-width: 0;
	}
	.rows li:first-child {
		border-top: 0;
	}
	.main {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.src {
		display: inline-flex;
		color: var(--muted);
	}
	.nums {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs) var(--space-l);
		margin: 0;
	}
	.nums div {
		display: flex;
		flex-direction: column;
	}
	.nums dt {
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.nums dd {
		margin: 0;
		font-family: var(--font-data);
		font-size: var(--size-m);
		line-height: var(--line-m);
		font-weight: var(--weight-data-heavy);
		font-variant-numeric: tabular-nums;
	}
	.nums .warn dd {
		color: var(--warn);
	}
</style>

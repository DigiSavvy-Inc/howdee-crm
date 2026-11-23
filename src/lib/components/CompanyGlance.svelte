<script lang="ts">
	// Company dashboard at-a-glance strip (#564): one StatGroup, a tile per data source the
	// company has (`dashboard.tiles` decides which), plus the rule-based "Going quiet" note.
	import StatGroup from './StatGroup.svelte';
	import StatCell from './StatCell.svelte';
	import { relTime } from '$lib/reltime';
	import { moneyTile } from '$lib/money';
	import { formatDateTime } from '$lib/report-view';
	import { formatValue } from '$lib/pipeline';
	import type { CompanyDashboard } from '$lib/server/company-dashboard';

	let { dashboard: d, companyId, tz }: { dashboard: CompanyDashboard; companyId: number; tz: string } = $props();

	const n = (v: number) => v.toLocaleString('en-US');
	const hours = (v: number | null | undefined) => `${(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
	const pct = $derived(d.contacts.total ? Math.round((d.contacts.subscribed / d.contacts.total) * 100) : 0);
</script>

<section class="glance" aria-label="At a glance">
	<StatGroup>
		{#each d.tiles as key (key)}
			{#if key === 'contacts'}
				<StatCell label="Contacts" value="{n(d.contacts.subscribed)} / {n(d.contacts.total)}" sub="subscribed / total ({pct}%)"
					href={d.contacts.total ? `/contacts?company_id=${companyId}` : undefined} />
			{:else if key === 'engaged'}
				<StatCell label="Engaged 30d" value={n(d.engaged30d)} sub="opened, clicked, replied or visited"
					title="Distinct contacts with a human open, a click, a reply or a site visit in the last 30 days. Apple Mail auto-opens and security-scanner clicks don't count." />
			{:else if key === 'last_touch' && d.lastTouchAt}
				<StatCell label="Last touch" value={relTime(d.lastTouchAt)} sub={formatDateTime(d.lastTouchAt, tz)}
					title="Newest open, click, reply, site visit, Timing entry or GitHub issue activity" />
			{:else if key === 'awaiting'}
				<StatCell label="Awaiting our reply" value={n(d.awaiting)} sub="they wrote last" tone={d.awaiting > 0 ? 'warn' : undefined}
					href={d.awaiting ? `/contacts?company_id=${companyId}&awaiting=1` : undefined} />
			{:else if key === 'deals'}
				<StatCell label="Open deals" value={n(d.deals.open)} sub={d.deals.value ? `${formatValue(d.deals.value)} total value` : 'no value set'} href="/pipeline" />
			{:else if key === 'hours' && d.hours}
				<StatCell label="Hours 30d" value={hours(d.hours.hours_30d)} sub="{hours(d.hours.hours_90d)} in 90d" href="#timing" />
			{:else if key === 'issues'}
				<StatCell label="Open issues" value={n(d.issuesOpen ?? 0)} sub="GitHub" href="#github" />
			{:else if key === 'outstanding' && d.billing}
				<StatCell label="Outstanding" value={moneyTile(d.billing.outstanding, d.billing.currency)} sub="Zoho Books" href="#billing" />
			{:else if key === 'overdue' && d.billing}
				<StatCell label="Overdue" value={moneyTile(d.billing.overdue, d.billing.currency)} sub="past due date" href="#billing"
					tone={(d.billing.overdue ?? 0) > 0 ? 'warn' : undefined} />
			{/if}
		{/each}
	</StatGroup>
	{#if d.goingQuiet}
		<p class="notice warn" role="status">
			Going quiet: Timing hours in the last 90 days but none in the last 30, and no touch in 30 days.
		</p>
	{/if}
</section>

<style>
	.glance { margin-bottom: var(--space-l); }
	.notice { margin: var(--space-s) 0 0; }
</style>

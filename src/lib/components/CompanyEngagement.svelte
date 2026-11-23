<script lang="ts">
	// Company dashboard 2/4 (#565): the 90-day weekly engagement trend (TrendChart) and the five
	// most engaged contacts (engagement score, tier, Lead score, last activity). Active contacts
	// only; data from loadCompanyDashboard (#564).
	import TrendChart from './TrendChart.svelte';
	import TierBadge from './TierBadge.svelte';
	import Avatar from './Avatar.svelte';
	import { relTime } from '$lib/reltime';
	import { formatDateTime } from '$lib/report-view';
	import { ENGAGEMENT_SERIES } from '$lib/company-dashboard';
	import type { CompanyDashboard } from '$lib/server/company-dashboard';

	// `part` (#567): the page puts the trend in its left column and top contacts in the right.
	let { dashboard: d, tz, part = 'both' }: { dashboard: CompanyDashboard; tz: string; part?: 'both' | 'trend' | 'top' } = $props();

	const nameOf = (c: { email: string; name: string | null; first_name: string | null; last_name: string | null }) =>
		c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email;
</script>

<div class="engagement" class:single={part !== 'both'}>
	{#if part !== 'top'}
	<section class="card" aria-labelledby="co-trend-h">
		<h2 id="co-trend-h">Engagement, last 90 days</h2>
		<p class="muted sub">Per week in {tz}. Apple Mail auto-opens and security-scanner clicks aren't counted.</p>
		<TrendChart
			points={d.series}
			series={ENGAGEMENT_SERIES}
			unit="week"
			label="Weekly engagement for this company's contacts"
			empty="No email or site activity from this company's contacts in the last 90 days."
		/>
	</section>
	{/if}

	{#if part !== 'trend'}
	<section class="card" aria-labelledby="co-top-h">
		<h2 id="co-top-h">Top engaged contacts</h2>
		{#if d.topContacts.length === 0}
			<p class="muted">No engagement yet. Contacts appear here once they open, click, reply or visit.</p>
		{:else}
			<ol class="top">
				{#each d.topContacts as c (c.id)}
					<li>
						<a class="who" href="/contacts/{c.id}">
							<Avatar contactId={c.id} name={nameOf(c)} size={24} />
							<span class="name">{nameOf(c)}</span>
						</a>
						<span class="meta">
							<TierBadge tier={c.tier} score={c.score} />
							<span title="Engagement score">{Math.round(c.score)}</span>
							{#if c.lead_score !== null}
								<span class="muted" title={d.leadScoreName ?? 'Lead score'}>{d.leadScoreName ?? 'Lead score'} {c.lead_score.toLocaleString('en-US')}</span>
							{/if}
							<span class="muted" title={c.last_activity_at ? formatDateTime(c.last_activity_at, tz) : undefined}>
								{c.last_activity_at ? relTime(c.last_activity_at) : 'no activity'}
							</span>
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
	{/if}
</div>

<style>
	.engagement {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--card-gap);
		margin-bottom: var(--card-gap);
	}
	.engagement.single {
		grid-template-columns: minmax(0, 1fr);
	}
	@media (max-width: 900px) {
		.engagement {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.engagement > .card {
		margin: 0;
		min-width: 0;
	}
	h2 {
		margin-top: 0;
	}
	.sub {
		margin: calc(-1 * var(--space-xs)) 0 var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	.top {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* Two lines at every width: avatar + name, then the meta under the name. */
	.top li {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-xxs);
		padding: var(--space-xs) 0;
		border-top: 1px solid var(--border);
	}
	.top li:first-child {
		border-top: 0;
	}
	.who {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		min-width: 0;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		padding-left: calc(24px + var(--space-xs)); /* the Avatar size + the .who gap */
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
</style>

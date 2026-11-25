<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Avatar from '$lib/components/Avatar.svelte';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { relTime } from '$lib/reltime';
	import { viewEmailHref } from '$lib/view-email-href';
	import { TIER_LABELS, isTier } from '$lib/engagement-view';
	import TierTrend from '$lib/components/TierTrend.svelte';
	import ScoresOverview from '$lib/components/ScoresOverview.svelte';
	import EngagementHeatmap from '$lib/components/EngagementHeatmap.svelte';
	import { formatValue } from '$lib/pipeline';
	import DeliverabilityAlerts from '$lib/components/DeliverabilityAlerts.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import { formatRate, LEVEL_LABELS, trendDirection } from '$lib/deliverability-alerts';
	import { deltaText, deltaWarn, passText, plural, rateText, resendBadge, unsubWarn } from '$lib/last-campaign';

	let { data, form } = $props();
	const tierLabel = (t: string) => (isTier(t) ? TIER_LABELS[t] : t);
	// Going cold (#116): "new segment…" reveals the name field.
	let coldSegment = $state('');

	// #305: digest trend, "↑ from 1.2%" — up = the rate got worse.
	function trendText(cur: number, prev: number): string {
		const d = trendDirection(cur, prev);
		return d === 'flat' ? `flat vs ${formatRate(prev)} last week` : `${d === 'up' ? 'up' : 'down'} from ${formatRate(prev)} last week`;
	}

	function feedUrl(key: string): string {
		const p = new URLSearchParams(page.url.searchParams.toString());
		if (key === 'all') p.delete('feed');
		else p.set('feed', key);
		const q = p.toString();
		return q ? `?${q}` : '/';
	}
	// One clock per load so every relative time on the page agrees.
	const now = $derived.by(() => {
		void data;
		return new Date();
	});
</script>

<svelte:head><title>Dashboard</title></svelte:head>

<div class="head">
	<h1>Dashboard</h1>
	<div class="actions">
		<a href="/compose"><button>Start a campaign</button></a>
		<a href="/contacts"><button class="secondary">Add contacts</button></a>
		<a href="/automations?new=1"><button class="secondary">New automation</button></a>
	</div>
</div>

<!-- #325: every banner sits in one stack, spaced from the header, each other and the tiles. -->
<div class="banners">
	{#if data.domainAlert.length}
		<!-- #304: a DMARC/SPF/DKIM/Return-Path check went from pass to fail. -->
		<div class="notice err" role="alert">
			{#each data.domainAlert as d (d.domain + d.key)}
				<div><strong><Icon name="alert" size={16} /> {d.text}.</strong> {d.summary}</div>
			{/each}
			<a href="/deliverability#domain-auth">Check domain authentication →</a>
		</div>
	{/if}
	{#if data.authBounces > 0}
		<div class="notice warn">
			<strong><Icon name="alert" size={16} /> {data.authBounces} bounce{data.authBounces === 1 ? '' : 's'} in the last 24 hours cite DMARC or a 5.7.x policy error.</strong>
			<a href="/deliverability#domain-auth">Check domain authentication →</a>
		</div>
	{/if}

	<!-- #305: post-send deliverability alerts (after #304's domain-auth banners). -->
	<DeliverabilityAlerts alerts={data.alerts} thresholds={data.digest.thresholds} />

	{#if data.preflightHolds?.length}
		<!-- #479: scheduled sends held because their pre-send checks failed at the send time. -->
		<div class="notice err" role="alert">
			<strong>{data.preflightHolds.length === 1 ? 'A scheduled send is held' : `${data.preflightHolds.length} scheduled sends are held`}</strong>
			— its pre-send checks failed when it was due. Nothing was sent.
			<ul class="held-list">
				{#each data.preflightHolds as h (h.id)}
					<li><a href="/campaign/{h.id}">{h.subject}</a>: Held: {h.summary}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if data.formSendHolds?.length}
		<!-- #744: admins only; one line per form whose daily send limit held submissions. -->
		<div class="notice warn" role="status">
			<strong>A form reached its daily send limit.</strong> Its submissions are saved but nothing was sent for them.
			<ul class="held-list">
				{#each data.formSendHolds as f (f.form_id)}
					<li><a href="/forms/{f.form_id}?tab=submissions&status=held">{f.name}</a>: {f.held.toLocaleString()} held since {f.first_held_at.slice(0, 10)}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if data.setupAttention > 0}
		<!-- #609: admins only (the load returns 0 for members). -->
		<p class="notice warn" role="status">
			Setup: {data.setupAttention} required {data.setupAttention === 1 ? 'check needs' : 'checks need'} attention.
			<a href="/settings/setup">Open Settings → Setup</a>
		</p>
	{/if}

	{#if data.health.heartbeatStale}
		<div class="notice err">
			<strong><Icon name="alert" size={16} /> Automation heartbeat appears down.</strong>
			{#if data.health.last_tick_at}
				Last tick was {data.health.last_tick_at} UTC ({data.health.tick_age_min} min ago) — expected every minute.
			{:else}
				No tick has ever been recorded, but {data.health.active_automations} automation{data.health.active_automations === 1 ? ' is' : 's are'} active.
			{/if}
			Scheduled sends, automation emails and background jobs are not running. Check the clock: the app's own cron trigger (<code>triggers.crons</code> in wrangler.jsonc, and Settings → Setup), or the heartbeat Worker (cron trigger + CRON_KEY) if you run one.
		</div>
	{:else if data.health.overdue > 0}
		<div class="notice warn">
			<strong><Icon name="alert" size={16} /> {data.health.overdue} enrollment{data.health.overdue === 1 ? '' : 's'} overdue.</strong>
			Steps due over 30 minutes ago haven't run — the heartbeat is ticking
			{#if data.health.last_tick_at}(last {data.health.last_tick_at} UTC){/if}, so check the automations for stuck contacts.
		</div>
	{/if}

	<!-- #536: a broadcast left mid-send, or a scheduled one the tick never picked up. -->
	{#if data.stuck.length > 0}
		<div class="notice warn" role="alert">
			<strong><Icon name="alert" size={16} /> {data.stuck.length} campaign{data.stuck.length === 1 ? '' : 's'} need{data.stuck.length === 1 ? 's' : ''} a look.</strong>
			<ul class="stuck">
				{#each data.stuck as s (s.kind + s.id)}
					<li>
						<a href="/campaign/{s.id}">{s.subject}</a>
						{#if s.kind === 'sending'}
							— still sending since {s.at} UTC ({s.accepted} sent so far); the send was interrupted.
						{:else}
							— scheduled for {s.at} UTC and not sent yet; check the heartbeat.
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<StatGroup label="Overview">
	<StatCell href="/contacts" label="Subscribers" value={data.tiles.subscribers} subTitle="Last 30 days: new subscribed contacts / unsubscribes">
		<span class="up">+{data.tiles.new_subscribed_30d}</span>
		<span class="down">−{data.tiles.unsubscribes_30d}</span>
		<span>30d</span>
	</StatCell>
	<StatCell label="Sent 7d" value={data.tiles.sent_7d} sub="recipients accepted" />
	<StatCell
		label="Opens 7d"
		value={data.tiles.opens_7d}
		sub={data.tiles.open_rate_7d === null ? 'no sends' : `${data.tiles.open_rate_7d}% unique open rate`}
	/>
	<StatCell
		href="/conversations?filter=awaiting"
		label="Awaiting reply"
		value={data.tiles.awaiting_reply}
		sub="conversation{data.tiles.awaiting_reply === 1 ? '' : 's'} where they wrote last"
	/>
	<StatCell
		href="/automations?status=active"
		label="Automations active"
		value={data.tiles.active_automations}
		sub="{data.tiles.active_enrollments} contact{data.tiles.active_enrollments === 1 ? '' : 's'} in flow"
	/>
	<StatCell
		href="/pipeline"
		label="Pipeline"
		value={data.pipeline.open_count}
		subTitle="Open cards' total value; cards that reached a won stage this month"
		sub="{formatValue(data.pipeline.open_value)} open · {data.pipeline.won_month_count} won this month{data.pipeline.won_month_value ? ` (${formatValue(data.pipeline.won_month_value)})` : ''}"
	/>
	{#if data.goingQuiet !== null}
		<StatCell
			href={data.goingQuietHref}
			label="Going quiet"
			value={data.goingQuiet}
			sub="compan{data.goingQuiet === 1 ? 'y' : 'ies'} with hours in 90d, none in 30d"
		/>
	{/if}
</StatGroup>

<!-- Engagement intelligence (#116): tiers now + trend, the day × hour heatmap, going cold. -->
<div class="insights">
	<section class="card">
		<div class="cardhead"><h2>Engagement tiers</h2></div>
		<TierTrend tiers={data.tiers} trend={data.trend} />
		{#if data.scores.length}
			<div class="scores-module">
				<h3>Scores</h3>
				<ScoresOverview scores={data.scores} moveDays={data.scoreMoveDays} />
			</div>
		{/if}
	</section>

	<section class="card">
		<div class="cardhead"><h2>When people engage</h2></div>
		<EngagementHeatmap heat={data.heatmap} />
	</section>

	<section class="card cold">
		<div class="cardhead">
			<h2>Going cold this month</h2>
			<span class="muted count">{data.cold.total}</span>
		</div>
		{#if data.cold.total === 0}
			<p class="muted">Nobody has slipped into a cooler tier in the last 30 days.</p>
		{:else}
			<ul class="items">
				{#each data.cold.contacts as c (c.id)}
					<li class="item">
						<Avatar contactId={c.id} name={c.name ?? c.email} size={20} />
						<span class="what"><a href="/contacts/{c.id}">{c.name || c.email}</a></span>
						<span class="muted when" title="{c.tier_changed_at}">{tierLabel(c.prev_tier)} → {tierLabel(c.tier)}</span>
					</li>
				{/each}
			</ul>
			{#if data.cold.total > data.cold.contacts.length}
				<p class="muted more-note">+ {data.cold.total - data.cold.contacts.length} more</p>
			{/if}
			<div class="cold-actions">
				<form method="POST" action="?/coldToSegment" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<select name="segment_id" bind:value={coldSegment} aria-label="Segment">
						<option value="">New segment…</option>
						{#each data.segments as sg (sg.id)}<option value={String(sg.id)}>{sg.name}</option>{/each}
					</select>
					{#if coldSegment === ''}
						<input name="new_segment" placeholder="Segment name" value="Going cold" aria-label="New segment name" required />
					{/if}
					<button type="submit" class="secondary">Add all to segment</button>
				</form>
				<form method="POST" action="?/coldEnroll" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<select name="automation_id" aria-label="Automation" required disabled={data.automations.length === 0}>
						{#if data.automations.length === 0}
							<option value="">No active automations</option>
						{:else}
							{#each data.automations as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
						{/if}
					</select>
					<button type="submit" class="secondary" disabled={data.automations.length === 0}>Enroll all</button>
				</form>
			</div>
		{/if}
		{#if form?.coldError}<p class="err">{form.coldError}</p>{/if}
		{#if form?.coldOk}
			<p class="ok">
				{form.coldOk}
				{#if form.coldListId}<a href="/lists/{form.coldListId}">View →</a>{/if}
				{#if form.coldAutomationId}<a href="/automations/{form.coldAutomationId}">View →</a>{/if}
			</p>
		{/if}
	</section>
</div>

<div class="grid">
	<!-- #451: how the newest sent broadcast did. A resend is the same campaign row, so every
	     link goes to the primary campaign. Spans the full grid width;
	     hidden until something was sent. -->
	{#if data.last}
		{@const l = data.last}
		{@const badge = resendBadge(l, l.resend_scheduled)}
		{@const openD = deltaText(l.open_delta)}
		{@const clickD = deltaText(l.click_delta)}
		<section class="card last-campaign">
			<div class="cardhead">
				<h2>Last campaign</h2>
				<a class="more" href="/campaign/{l.id}">Full report →</a>
			</div>
			<p class="last-subj">
				<a href="/campaign/{l.id}" title={l.subject}>{l.subject}</a>
				{#if badge}<span class="badge type resent">{badge}</span>{/if}
			</p>
			<p class="muted last-meta">
				Sent <time title="{l.sent_at} UTC">{relTime(l.sent_at, now)}</time> · to {l.audience}{#if l.audience_kind === 'segment'}&nbsp;(segment){/if}
				· {plural(l.recipient_count, 'recipient')}
			</p>
			<StatGroup label="Last campaign stats">
				<StatCell
					href="/campaign/{l.id}?who=sent"
					label="Sent"
					value={l.sent}
					sub={l.errored > 0 ? `${l.errored} failed` : undefined}
				/>
				<StatCell href="/campaign/{l.id}?who=opens" label="Opened" value={rateText(l.open_rate)} tone={deltaWarn(l.open_delta) ? 'warn' : undefined}>
					{plural(l.opens, 'contact')}{#if openD}<br />{openD}{/if}
				</StatCell>
				<StatCell href="/campaign/{l.id}?who=clicks" label="Clicked" value={rateText(l.click_rate)} tone={deltaWarn(l.click_delta) ? 'warn' : undefined}>
					{plural(l.clicks, 'contact')}{#if clickD}<br />{clickD}{/if}
				</StatCell>
				<StatCell
					href="/campaign/{l.id}?who=unsubs"
					label="Unsubscribed"
					value={l.unsubs}
					sub={rateText(l.unsub_rate)}
					tone={unsubWarn(l.unsub_rate) ? 'warn' : undefined}
				/>
				<StatCell
					href="/campaign/{l.id}?who=bounces"
					label="Bounced"
					value={l.bounces + l.spam}
					sub="{l.spam} spam"
					tone={l.spam > 0 ? 'warn' : undefined}
				/>
				<StatCell href="/campaign/{l.id}" label="Replied" value={l.replies} />
			</StatGroup>
			{#if l.passes}
				<ul class="passes muted">
					<li><strong>Original:</strong> {passText(l.passes.original)}</li>
					<li>
						<strong>Resend:</strong> {passText(l.passes.resend)}{#if l.resend_subject && l.resend_subject !== l.subject}&nbsp;· “{l.resend_subject}”{/if}
					</li>
				</ul>
			{/if}
		</section>
	{/if}

	<section class="card feed">
		<div class="cardhead">
			<h2>Activity</h2>
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
						{#each data.feedSizes as n (n)}
							<option value={n} selected={n === data.feedSize}>{n}</option>
						{/each}
					</select>
				</label>
			</form>
		</div>
		<nav class="chips">
			{#each data.feedFilters as f (f.key)}
				<a class="chip" class:on={data.feed === f.key} href={feedUrl(f.key)} data-sveltekit-reset="false">{f.label}</a>
			{/each}
		</nav>
		{#if data.activity.length === 0}
			<p class="muted">Nothing here yet.</p>
		{:else}
			<ActivityFeed items={data.activity} {now} />
		{/if}
	</section>

	<div class="side">
		<!-- #388: top 5 companies by open items in their latest account brief. -->
		{#if data.accounts.length}
			<section class="card">
				<div class="cardhead">
					<h2>Accounts to look at</h2>
					<a class="more" href="/companies">Companies →</a>
				</div>
				<ul class="items">
					{#each data.accounts as a (a.company_id)}
						<li class="item">
							<span class="what">
								<a href="/companies/{a.company_id}#brief">{a.name}</a>
								{#if a.one_liner}<span class="muted detail">{a.one_liner}</span>{/if}
							</span>
							<span class="muted when">{a.open_items} open</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<!-- #305: last 7 days against the 7 before; arrows point at the rate's direction. -->
		<section class="card digest">
			<div class="cardhead">
				<h2>Deliverability this week</h2>
				<a class="more" href="/deliverability">Details →</a>
			</div>
			{#if data.digest.current.sent === 0}
				<p class="muted">Nothing delivered or bounced in the last 7 days.</p>
			{:else}
				{@const d = data.digest}
				<ul class="items">
					<li class="item">
						<span class="what">Sends</span>
						<span class="when"><strong>{d.current.sent}</strong> <span class="muted">({d.previous.sent} last week)</span></span>
					</li>
					<li class="item">
						<span class="what">
							Hard bounces
							<span class="badge lvl-{d.hardLevel}">{LEVEL_LABELS[d.hardLevel]}</span>
						</span>
						<span class="when" title="Warning {formatRate(d.thresholds.hardWarn)}, critical {formatRate(d.thresholds.hardCrit)}">
							<strong>{formatRate(d.current.hardRate)}</strong>
							<span class="trend t-{trendDirection(d.current.hardRate, d.previous.hardRate)}"><Icon name="arrow-up" size={16} /></span>
							<span class="muted">{trendText(d.current.hardRate, d.previous.hardRate)}</span>
						</span>
					</li>
					<li class="item">
						<span class="what">All bounces</span>
						<span class="when"><strong>{formatRate(d.current.bounceRate)}</strong> <span class="muted">({d.current.bounces})</span></span>
					</li>
					<li class="item">
						<span class="what">
							Complaints
							<span class="badge lvl-{d.complaintLevel}">{LEVEL_LABELS[d.complaintLevel]}</span>
						</span>
						<span class="when" title="Warning {formatRate(d.thresholds.complaintWarn)}, critical {formatRate(d.thresholds.complaintCrit)}">
							<strong>{formatRate(d.current.complaintRate)}</strong>
							<span class="trend t-{trendDirection(d.current.complaintRate, d.previous.complaintRate)}"><Icon name="arrow-up" size={16} /></span>
							<span class="muted">{trendText(d.current.complaintRate, d.previous.complaintRate)}</span>
						</span>
					</li>
				</ul>
				<p class="muted more-note">
					Thresholds: hard bounces {formatRate(d.thresholds.hardWarn)} / {formatRate(d.thresholds.hardCrit)},
					complaints {formatRate(d.thresholds.complaintWarn)} / {formatRate(d.thresholds.complaintCrit)} (warning / critical).
				</p>
			{/if}
		</section>

		<section class="card">
			<div class="cardhead">
				<h2>Recent campaigns</h2>
				<a class="more" href="/campaigns">View all →</a>
			</div>
			{#if data.recent.length === 0}
				<p class="muted">Nothing sent yet. <a href="/compose">Start a campaign →</a></p>
			{:else}
				<div class="table-wrap">
					<table class="mini">
						<thead><tr><th>Subject</th><th>Sent</th><th>Open</th><th>Click</th></tr></thead>
						<tbody>
							{#each data.recent as c (c.id)}
								<tr>
									<td class="subj">
										<a href="/campaign/{c.id}" title={c.subject}>{c.subject}</a>
										{#if c.direct}<span class="badge type">direct</span>{/if}
									</td>
									<td>{c.recipient_count}</td>
									<td>{c.open_pct === null ? '—' : `${c.open_pct}%`}</td>
									<td>{c.click_pct === null ? '—' : `${c.click_pct}%`}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section class="card">
			<div class="cardhead"><h2>Upcoming</h2></div>
			{#if data.upcoming.length === 0}
				<p class="muted">Nothing scheduled.</p>
			{:else}
				<ul class="items">
					{#each data.upcoming as u (u.kind + u.id)}
						<li class="item">
							<span class="what">
								<a href="/campaign/{u.id}">{u.subject}</a>
								{#if u.kind === 'resend'}<span class="badge type resent">resend</span>{/if}
							</span>
							<time class="muted when" title="{u.at} UTC">
								<Icon name="schedule" size={16} /> {u.at.slice(0, 16)} UTC{#if u.weekday_only}&nbsp;· weekdays only{/if}
							</time>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="card">
			<div class="cardhead"><h2>Recent unsubscribes</h2></div>
			{#if data.unsubscribes.length === 0}
				<p class="muted">No unsubscribes yet.</p>
			{:else}
				<ul class="items">
					{#each data.unsubscribes as u (u.id)}
						<li class="item unsub">
							<span class="what">
								{#if u.contact_id}<a href="/contacts/{u.contact_id}">{u.email}</a>{:else}<span>{u.email}</span>{/if}
								<span class="muted detail">
									{u.reason || 'no reason given'}{#if u.campaign_id}&nbsp;· <a href={viewEmailHref(u.campaign_id, { contactId: u.contact_id })}>{u.subject ?? 'campaign'}</a>{/if}
								</span>
							</span>
							<time class="muted when" title="{u.created_at} UTC">{relTime(u.created_at, now)}</time>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</div>

<style>
	.held-list {
		margin: var(--space-xs) 0 0;
		padding-left: var(--space-m);
	}
	.stuck {
		margin: var(--space-xs) 0 0;
		padding-left: 1.2em;
	}
	/* #325: one stack for every banner — space-m below the header, space-s between banners
	   (DeliverabilityAlerts' own margin is zeroed so the gap is the only spacing). The tiles'
	   top margin spaces the stack from them; an empty stack takes no room. */
	.banners {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		margin-top: var(--space-m);
	}
	.banners:empty {
		display: none;
	}
	.banners > :global(.notice) {
		margin: 0;
	}
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
	.actions {
		display: flex;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	/* Mobile (#144): title above the actions. */
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			align-items: flex-start;
			gap: var(--space-s);
		}
		.actions button {
			padding: var(--space-xxs) var(--space-s);
		}
	}
	/* Tiles = StatGroup / StatCell (#340; 2-up on phones, #331). The Subscribers sub-line: */
	.up {
		color: var(--success);
	}
	.down {
		color: var(--danger);
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--space-m);
		margin-bottom: var(--space-l);
		align-items: start;
	}
	@media (max-width: 900px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	/* #331: on phones the help button (bottom-left) and the assistant bubble (bottom-right,
	   48px + 16px gap) float over the page — leave room so the last card scrolls clear. */
	@media (max-width: 768px) {
		.grid {
			margin-bottom: calc(48px + var(--space-m) + env(safe-area-inset-bottom, 0px));
		}
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
		min-width: 0;
	}
	.cardhead {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.cardhead h2 {
		margin: 0;
		margin-right: auto;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.scores-module {
		margin-top: var(--space-m);
		padding-top: var(--space-s);
		box-shadow: inset 0 var(--border-s) 0 var(--border-muted);
	}
	.scores-module h3 {
		margin: 0 0 var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.more {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.size {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-bottom: var(--space-s);
	}
	.chip {
		padding: 0 var(--space-s);
		border: 0;
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
	.items {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) 0;
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.item:last-child {
		box-shadow: none;
	}
	.what {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		white-space: nowrap;
		flex-shrink: 0;
	}
	/* Phones: the full verb phrase wraps; the time drops to its own line under the text. */
	@media (max-width: 480px) {
		.item {
			flex-wrap: wrap;
			row-gap: 0;
		}
		.what {
			white-space: normal;
			overflow-wrap: anywhere;
			flex-basis: calc(100% - 28px);
		}
		.when {
			flex-basis: 100%;
			padding-left: var(--space-xl);
		}
		.side .what {
			flex-basis: 100%;
		}
		.side .when {
			padding-left: 0;
			white-space: normal;
		}
	}
	table.mini td,
	table.mini th {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.subj {
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.insights {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: var(--space-m);
		margin-bottom: var(--space-l);
		align-items: start;
	}
	.insights .card {
		min-width: 0;
		overflow-x: auto;
	}
	.count {
		font-weight: var(--weight-ui-heavy);
	}
	.more-note {
		margin: var(--space-xxs) 0 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.cold-actions {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin-top: var(--space-s);
	}
	.cold-actions form {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		align-items: center;
	}
	.cold-actions select,
	.cold-actions input {
		min-width: 0;
		max-width: 12rem;
	}
	.cold .err {
		color: var(--danger);
		margin: var(--space-xs) 0 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.cold .ok {
		margin: var(--space-xs) 0 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.badge.type {
		margin-left: var(--space-xs);
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 35%, var(--border));
	}
	/* #305: Deliverability this week — level badges + trend arrows (up = worse). */
	.digest .badge { margin-left: var(--space-xs); }
	.badge.lvl-ok {
		color: var(--text);
		background: var(--success-transparent);
		box-shadow: inset 0 0 0 var(--border-s) var(--success);
	}
	.badge.lvl-warning {
		color: var(--text);
		background: var(--warning-transparent);
		box-shadow: inset 0 0 0 var(--border-s) var(--warning);
	}
	.badge.lvl-critical {
		color: var(--text);
		background: var(--error-transparent);
		box-shadow: inset 0 0 0 var(--border-s) var(--error);
	}
	.trend { display: inline-flex; vertical-align: middle; }
	.trend.t-down { transform: rotate(180deg); }
	.trend.t-flat { transform: rotate(90deg); }
	/* #451: Last campaign card. */
	.last-campaign {
		grid-column: 1 / -1;
	}
	.last-subj {
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.last-meta {
		margin: var(--space-xxs) 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.passes {
		list-style: none;
		margin: var(--space-s) 0 0;
		padding: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.badge.type.resent {
		color: var(--text);
		background: color-mix(in srgb, var(--warning) 12%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warning) 35%, var(--border));
	}
</style>

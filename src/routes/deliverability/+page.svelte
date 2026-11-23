<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import DeliverabilityAlerts from '$lib/components/DeliverabilityAlerts.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import { page } from '$app/state';
	import { changeText, checkedText } from '$lib/domain-auth-view';
	let { data, form } = $props();
	const isAdmin = $derived(page.data.user?.role === 'admin');
	let coldTag = $state('cold');
	let syncing = $state(false);
	let checking = $state(false);
	let checkingHygiene = $state(false);
	let switching = $state(false);
	// Domain authentication (#304): chip class + label per status.
	const CHIP: Record<string, string> = { pass: 'sent', warn: 'sending', fail: 'failed', unknown: 'draft' };
	const CHIP_LABEL: Record<string, string> = { pass: 'Pass', warn: 'Warn', fail: 'Fail', unknown: 'Unknown' };
	function chipLabel(status: string, informational?: boolean): string {
		if (informational && status === 'warn') return 'Info';
		return CHIP_LABEL[status] ?? status;
	}
	function when(iso: string): string {
		return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
	}
	function reasons(by: Record<string, number>): string {
		return Object.entries(by).map(([r, n]) => `${r} ${n}`).join(', ');
	}
	function pct(n: number): string {
		return `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
	}
</script>

<svelte:head><title>Deliverability</title></svelte:head>

<div class="head"><h1>Deliverability</h1></div>
<p class="muted intro">
	Sender-reputation health and list hygiene. Rates cover the last {data.window} of activity.
	{#if isAdmin}<a href="/settings/deliverability">Alert thresholds →</a>{/if}
</p>

{#if data.domainAlert.length}
	<!-- #304: a check went from pass to fail since the previous run. -->
	<div class="alert" role="alert">
		{#each data.domainAlert as d (d.domain + d.key)}
			<div><strong><Icon name="alert" size={16} /> {d.text}.</strong> {d.summary}</div>
		{/each}
		<a href="#domain-auth">See the fix below →</a>
	</div>
{/if}

<!-- #305: post-send alerts (2h / 24h per broadcast, 7 days per automation). -->
<DeliverabilityAlerts alerts={data.alerts} thresholds={data.thresholds} />
{#if form?.alertError}<p class="err">{form.alertError}</p>{/if}

{#if data.held.length}
	<section class="card held">
		<h2>Held sends <span class="muted">({data.held.length})</span></h2>
		<p class="muted">
			Scheduled broadcasts held after a critical deliverability alert. They are not cancelled: Release puts each
			back on its schedule (a time already past sends on the next tick).
			{#if !isAdmin}Only an admin can release them.{/if}
		</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Campaign</th><th>List</th><th>Scheduled</th><th>Held</th>{#if isAdmin}<th></th>{/if}</tr></thead>
				<tbody>
					{#each data.held as h (h.id)}
						<tr>
							<td><a href="/campaign/{h.id}">{h.subject}</a>{#if h.status !== 'scheduled'} <span class="muted">({h.status})</span>{/if}</td>
							<td class="muted">{h.list_name ?? '—'}</td>
							<td class="muted">{h.scheduled_at ? `${h.scheduled_at} UTC` : '—'}</td>
							<td class="muted">{h.held_at} UTC</td>
							{#if isAdmin}
								<td>
									<form method="POST" action="?/releaseHold" use:enhance>
										<input type="hidden" name="campaign_id" value={h.id} />
										<button type="submit" class="secondary small">Release</button>
									</form>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

{#if data.bounceWarn || data.complaintWarn}
	<div class="alert">
		<strong><Icon name="alert" size={16} /> Reputation risk.</strong>
		{#if data.bounceWarn}Bounce rate is {pct(data.bounceRate)} (healthy is under 5%).{/if}
		{#if data.complaintWarn}Complaint rate is {pct(data.complaintRate)} (healthy is under 0.1%).{/if}
		Clean your list and review where these addresses came from before sending more.
	</div>
{/if}

<StatGroup label="Delivery totals">
	<StatCell label="Delivered" value={data.sent} />
	<StatCell label="Bounces" value={data.bounces} sub="{pct(data.bounceRate)} rate" tone={data.bounceWarn ? 'warn' : undefined} />
	<StatCell label="Complaints" value={data.complaints} sub="{pct(data.complaintRate)} rate" tone={data.complaintWarn ? 'warn' : undefined} />
	<StatCell label="Unsubscribes" value={data.unsubs} />
</StatGroup>

<!-- #363: the cards below stack with the shared card gap (#340), like the dashboard. -->
<div class="stack">
<section class="card" id="domain-auth">
	<h2>Domain authentication</h2>
	<p class="muted">
		DMARC, SPF, DKIM and Return-Path for every domain the app sends as, checked live in DNS
		and against Postmark, plus the broadcast stream's unsubscribe handling. Re-checked once a
		day; a check that goes from pass to fail raises a banner here and on the Dashboard.
	</p>
	<form
		method="POST"
		action="?/checkDomainAuth"
		class="sync-form"
		use:enhance={() => {
			checking = true;
			return async ({ update }) => {
				await update();
				checking = false;
			};
		}}
	>
		<button type="submit" disabled={checking}>{checking ? 'Checking…' : 'Re-check now'}</button>
		<!-- #363: confirm the run inline; the next action's result replaces it. -->
		<span class="checked" role="status">{#if form?.domainChecked && !checking}{checkedText(form.domainChecked)}{/if}</span>
		<span class="muted sync-last">
			{#if data.domainAuth}
				Last checked {when(data.domainAuth.at)} ({data.domainAuth.trigger === 'cron' ? 'daily' : 'manual'})
			{:else}
				Not checked yet. Runs once a day.
			{/if}
		</span>
	</form>

	{#if data.authBounces.length}
		<div class="alert warn bounce-watch">
			<strong><Icon name="alert" size={16} /> {data.authBounces.length} bounce{data.authBounces.length === 1 ? '' : 's'} in the last 24 hours cite DMARC or a 5.7.x policy error.</strong>
			These usually mean an authentication record is broken. Check the domains below.
			<ul>
				{#each data.authBounces as b (b.id)}
					<li>
						{#if b.contact_id}<a href="/contacts/{b.contact_id}">{b.email}</a>{:else}{b.email ?? 'Unknown recipient'}{/if}
						{#if b.campaign_id}· <a href="/campaign/{b.campaign_id}">{b.subject ?? 'campaign'}</a>{/if}
						<span class="muted">· {b.bounce_type ?? 'Bounce'}{b.reason ? ` · ${b.reason}` : ''}</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if data.domainAuth}
		{#if data.domainAuth.domains.length === 0}
			<p class="muted">No sending domain found. Set a From address in Settings.</p>
		{/if}
		{#each data.domainAuth.domains as d (d.domain)}
			<h3 class="domain">{d.domain}</h3>
			<ul class="checks">
				{#each d.checks as c (c.key)}
					<li class="check">
						<span class="badge {CHIP[c.status] ?? 'draft'}">{chipLabel(c.status, c.informational)}</span>
						<div class="check-body">
							<div>
								<strong>{c.label}</strong>
								{#if data.domainChanges[`${d.domain}/${c.key}`]}<span class="changed">{changeText(data.domainChanges[`${d.domain}/${c.key}`])}</span>{/if}
								<span class="muted">{c.summary}</span>
							</div>
							{#if c.fix && c.status !== 'pass'}<div class="fix">{c.fix}</div>{/if}
							{#if c.record && c.status !== 'pass'}
								<dl class="record">
									<dt>Type</dt><dd><code>{c.record.type}</code></dd>
									<dt>Host</dt><dd><code>{c.record.host}</code></dd>
									<dt>Value</dt><dd><code>{c.record.value}</code></dd>
								</dl>
							{/if}
							{#if c.found && c.found.length && c.status !== 'pass'}
								<details class="found">
									<summary class="muted">Found in DNS ({c.found.length})</summary>
									{#each c.found as f, i (i)}<code>{f}</code>{/each}
								</details>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/each}
		{#if data.domainAuth.stream}
			<!-- #373: Postmark must leave unsubscribes to us on the broadcast stream. -->
			{@const s = data.domainAuth.stream}
			{@const c = s.check}
			<h3 class="domain">Postmark stream: {s.stream}</h3>
			<ul class="checks">
				<li class="check">
					<span class="badge {CHIP[c.status] ?? 'draft'}">{chipLabel(c.status)}</span>
					<div class="check-body">
						<div>
							<strong>{c.label}</strong>
							{#if data.domainChanges[`${s.stream}/${c.key}`]}<span class="changed">{changeText(data.domainChanges[`${s.stream}/${c.key}`])}</span>{/if}
							<span class="muted">{c.summary}</span>
						</div>
						{#if c.fix && c.status !== 'pass'}<div class="fix">{c.fix}</div>{/if}
						{#if c.status === 'warn' && isAdmin}
							<form
								method="POST"
								action="?/switchUnsubscribeHandling"
								use:enhance={({ cancel }) => {
									if (!confirm(`Switch unsubscribe handling on the ${s.stream} stream to custom? Postmark stops adding its own unsubscribe link and headers; the app's link and List-Unsubscribe headers become the only unsubscribe path.`)) return cancel();
									switching = true;
									return async ({ update }) => {
										await update();
										switching = false;
									};
								}}
							>
								<button type="submit" class="secondary small" disabled={switching}>{switching ? 'Switching…' : 'Switch to custom'}</button>
							</form>
						{/if}
						{#if form?.unsubSwitchError}<p class="err">{form.unsubSwitchError}</p>{/if}
						{#if form?.unsubSwitched}<p class="ok" role="status">Switched the {form.unsubSwitched} stream to custom unsubscribe handling.</p>{/if}
					</div>
				</li>
			</ul>
		{/if}
	{/if}
</section>

<section class="card">
	<h2>List hygiene — cold contacts</h2>
	<p class="muted">
		Subscribed contacts with no open or click in the selected window. Tag them so a
		re-engagement / sunset automation can win them back (or stop mailing them).
	</p>
	<form method="POST" action="?/tagCold" use:enhance class="cold-form">
		<label>No engagement in
			<select name="months" onchange={(e) => { const u = new URL(location.href); u.searchParams.set('months', (e.target as HTMLSelectElement).value); location.href = u.toString(); }}>
				{#each data.coldOptions as m (m)}<option value={m} selected={m === data.months}>{m} months</option>{/each}
			</select>
		</label>
		<span class="cold-count">→ <strong>{data.coldCount}</strong> contact{data.coldCount === 1 ? '' : 's'}</span>
		<label class="cold-tag">Tag them
			<input name="tag" bind:value={coldTag} maxlength="60" placeholder="cold" />
		</label>
		<button type="submit" disabled={data.coldCount === 0}>Tag {data.coldCount} cold contact{data.coldCount === 1 ? '' : 's'}</button>
	</form>
	{#if form?.coldError}<p class="err">{form.coldError}</p>{/if}
	{#if form?.coldTagged !== undefined}<p class="ok">Tagged {form.coldTagged} contact(s) with “{form.coldTag}”. Build an automation triggered by that tag to re-engage them.</p>{/if}
</section>

<section class="card">
	<h2>Address hygiene</h2>
	<p class="muted">
		Checks every subscribed contact's address: a mail server (MX) for the domain, disposable
		domains, role addresses (info@, sales@…) and likely typos (gmial.com). Bad ones are tagged
		<code>hygiene:invalid</code> — nobody is unsubscribed; use the bulk bar in Contacts to decide.
	</p>
	<form
		method="POST"
		action="?/checkHygiene"
		class="sync-form"
		use:enhance={() => {
			checkingHygiene = true;
			return async ({ update }) => {
				await update();
				checkingHygiene = false;
			};
		}}
	>
		<button type="submit" disabled={checkingHygiene}>{checkingHygiene ? 'Checking…' : 'Check existing contacts'}</button>
		<span class="muted sync-last">
			{#if data.hygieneRun && !data.hygieneRun.done}
				Running since {when(data.hygieneRun.started_at)} · {data.hygiene.remaining} left (continues every minute)
			{:else if data.hygieneRun?.finished_at}
				Last checked {when(data.hygieneRun.finished_at)}
			{:else}
				Not run yet.
			{/if}
		</span>
	</form>
	<p class="hygiene-counts">
		{data.hygiene.checked} checked ·
		<a href="/contacts?hygiene=invalid&status=subscribed">{data.hygiene.invalid} invalid</a> ·
		<a href="/contacts?hygiene=role&status=subscribed">{data.hygiene.role} role</a> ·
		<a href="/contacts?hygiene=typo&status=subscribed">{data.hygiene.typo} typo suggested</a>
	</p>
	{#if data.hygiene.invalid > 0}
		<p class="bounced-links"><a href="/contacts?hygiene=invalid&status=subscribed">Open invalid in Contacts ({data.hygiene.invalid}) →</a></p>
	{/if}
</section>

<section class="card">
	<h2>Suppressed contacts <span class="muted">({data.suppressedTotal})</span></h2>
	<!-- #285: unsubscribe contacts Postmark already suppresses (also runs daily). -->
	<form
		method="POST"
		action="?/syncSuppressions"
		class="sync-form"
		use:enhance={() => {
			syncing = true;
			return async ({ update }) => {
				await update();
				syncing = false;
			};
		}}
	>
		<button type="submit" disabled={syncing}>{syncing ? 'Syncing…' : 'Sync from Postmark'}</button>
		<span class="muted sync-last">
			{#if data.lastSync}
				Last synced {when(data.lastSync.at)} ({data.lastSync.trigger === 'cron' ? 'daily' : data.lastSync.trigger === 'post_send' ? 'after a send' : 'manual'}) ·
				{data.lastSync.unsubscribed} unsubscribed of {data.lastSync.checked} suppressed in Postmark
			{:else}
				Not synced yet. Runs once a day.
			{/if}
		</span>
	</form>
	{#if form?.syncError}<p class="err">{form.syncError}</p>{/if}
	{#if form?.sync}
		<p class="ok" role="status">
			Checked {form.sync.checked} Postmark suppression{form.sync.checked === 1 ? '' : 's'} ·
			{form.sync.matched} matched a contact · {form.sync.unsubscribed} unsubscribed
			{#if form.sync.alreadyUnsubscribed}· {form.sync.alreadyUnsubscribed} already unsubscribed{/if}
			{#if Object.keys(form.sync.byReason).length}({reasons(form.sync.byReason)}){/if}
			{#if form.sync.errors.length}· not read: {form.sync.errors.join('; ')}{/if}
		</p>
	{/if}
	{#if data.bouncedTotal > 0}
		<!-- #279: select them in Contacts and use the bulk bar (Unsubscribe). -->
		<p class="bounced-links">
			<a href="/contacts?bounced=any">Open bounced in Contacts ({data.bouncedTotal}) →</a>
			{#if data.bouncedSubscribed > 0}
				<a href="/contacts?bounced=any&status=subscribed">Bounced but still subscribed ({data.bouncedSubscribed}) →</a>
			{/if}
		</p>
	{/if}
	{#if data.suppressed.length === 0}
		<p class="muted">None — everyone's subscribed.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead><tr><th>Email</th><th>Reason</th></tr></thead>
				<tbody>
					{#each data.suppressed as s (s.id)}
						<tr><td><a href="/contacts/{s.id}">{s.email}</a></td><td class="muted">{s.reason}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.suppressedTotal > data.suppressed.length}<p class="muted more">Showing the latest 100 of {data.suppressedTotal}.</p>{/if}
	{/if}
</section>
</div>

<style>
	.stack { display: flex; flex-direction: column; gap: var(--card-gap); min-width: 0; }
	.held { margin: 0 0 var(--card-gap); }
	.checked:empty { display: none; }
	.checked { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: 600; }
	.changed {
		display: inline-block; padding: 0 var(--space-xs); border-radius: var(--radius); white-space: nowrap;
		font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs);
		box-shadow: 0 0 0 var(--border-s) var(--border);
	}
	.sync-form { display: flex; align-items: center; gap: var(--space-s); flex-wrap: wrap; margin: 0 0 var(--space-s); }
	.sync-last { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.hygiene-counts { margin: 0 0 var(--space-s); }
	.bounced-links {display: flex; flex-wrap: wrap; gap: var(--space-m); margin: 0 0 var(--space-s); }
	.head { display: flex; align-items: center; gap: var(--space-s); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.alert {
		margin: 0 0 var(--space-m); padding: var(--space-s) var(--space-m); font-size: var(--size-s); letter-spacing: var(--letter-spacing-s); line-height: var(--line-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 45%, var(--border));
		background: color-mix(in srgb, var(--danger) 9%, transparent); border-radius: var(--radius);
	}
	h2 { margin-top: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.card p { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.cold-form { display: flex; align-items: center; gap: var(--space-s); flex-wrap: wrap; margin: 0; }
	.cold-form label { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.cold-count { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.cold-tag input { width: 9rem; }
	.err { color: var(--danger); }
	.domain { margin: var(--space-m) 0 var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); }
	.check { display: flex; gap: var(--space-s); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.check .badge { min-width: 4.5rem; text-align: center; flex-shrink: 0; }
	.check-body { min-width: 0; display: flex; flex-direction: column; gap: var(--space-xxs); }
	.record { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-xxs) var(--space-s); margin: 0; }
	.record dt { color: var(--muted); }
	.record dd { margin: 0; min-width: 0; }
	.record code, .found code { overflow-wrap: anywhere; display: block; }
	.bounce-watch ul { margin: var(--space-xs) 0 0; padding-left: var(--space-m); }
	.alert.warn { box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warn) 45%, var(--border)); background: color-mix(in srgb, var(--warn) 9%, transparent); }
	.more { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
</style>

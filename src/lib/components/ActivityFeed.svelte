<script lang="ts">
	// The activity feed rows (#133), shared by the dashboard and the contacts Overview (#423).
	// `extras` (contacts page) adds a tier badge and the company link next to the name;
	// `groups` renders one block per contact (its name once, then its last events).
	import Avatar from '$lib/components/Avatar.svelte';
	import TierBadge from '$lib/components/TierBadge.svelte';
	import { relTime } from '$lib/reltime';
	import { viewEmailHref } from '$lib/view-email-href';
	import { isTier } from '$lib/engagement-view';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons/glyphs';
	import { money } from '$lib/money';
	import type { ActivityExtra, ActivityGroup, ActivityItem } from '$lib/server/activity';

	let {
		items = [],
		groups = null,
		extras = {},
		now
	}: {
		items?: ActivityItem[];
		groups?: ActivityGroup[] | null;
		extras?: Record<number, ActivityExtra>;
		now: Date;
	} = $props();

	// Verb per normalized type; the campaign/automation link follows it.
	const VERBS: Record<string, string> = {
		open: 'opened',
		click: 'clicked a link in',
		bounce: 'bounced on',
		delivery: 'was delivered',
		unsubscribe: 'unsubscribed',
		spam: 'marked as spam',
		reply: 'replied',
		form: 'submitted a form',
		contact: 'was added',
		confirm_sent: 'was sent a confirmation email',
		confirmed: 'confirmed their subscription',
		enrolled: 'entered',
		completed: 'completed',
		visited: 'visited',
		pipeline: 'moved to',
		deliverability: 'Deliverability alert on'
	};

	// #566 company timeline: rows from a connected tool (no contact) show its icon.
	const TOOL_ICONS: Partial<Record<string, IconName>> = { github: 'github', timing: 'timing', invoice: 'billing', payment: 'billing' };

	// Pipeline rows (#207): "moved to Proposal · by automation Nurture".
	function pipelineVerb(a: ActivityItem): string {
		if (a.pipeline_action === 'added') return 'was added to the pipeline at';
		if (a.pipeline_action === 'removed') return 'was removed from the pipeline';
		return 'moved to';
	}

	// Click targets are full URLs — show host + path, keep the whole thing in the tooltip.
	function shortUrl(u: string): string {
		try {
			const x = new URL(u);
			const path = x.pathname.replace(/\/$/, '');
			return x.host + (path && path !== '/' ? path : '');
		} catch {
			return u;
		}
	}
</script>

{#snippet who(a: ActivityItem)}
	{#if a.contact_id}
		<a href="/contacts/{a.contact_id}">{a.name || a.email}</a>
		{@const x = extras[a.contact_id]}
		{#if x}
			{#if isTier(x.tier) && x.tier !== 'new'}<span class="tier"><TierBadge tier={x.tier} score={x.score} /></span>{/if}
			{#if x.company}
				<span class="muted detail co">{#if x.company_id}<a href="/companies/{x.company_id}">{x.company}</a>{:else}{x.company}{/if}</span>
			{/if}
		{/if}
	{:else}
		<span>{a.email ?? 'Someone'}</span>
	{/if}
{/snippet}

{#snippet what(a: ActivityItem)}
	<span class="verb">{a.type === 'gmail' ? (a.direction === 'out' ? 'was emailed' : 'emailed') : a.type === 'visited' && a.site_kind === 'event' ? 'did' : a.type === 'pipeline' ? pipelineVerb(a) : (VERBS[a.type] ?? a.type)}</span>
	{#if a.type === 'gmail'}
		<!-- #566: a synced Gmail message; links to its conversation, else the contact's. The sender
		     (detail) only on outbound rows — inbound, it's the contact named before the verb. -->
		<a href={a.conv_key ? `/conversations/${encodeURIComponent(a.conv_key)}` : `/contacts/${a.contact_id}`} title={a.subject ?? ''}>{a.subject || '(no subject)'}</a>
		<span class="muted detail">· Gmail{#if a.direction === 'out' && a.detail}{' '}· from {a.detail}{/if}</span>
	{:else if a.type === 'pipeline'}
		{#if a.pipeline_action === 'removed'}
			{#if a.pipeline_from}<span class="muted detail">· from {a.pipeline_from}</span>{/if}
		{:else}
			<a href="/pipeline">{a.detail ?? '(deleted stage)'}</a>
		{/if}
		{#if a.actor_kind === 'automation' && a.automation_id}
			<span class="muted detail">· by <a href="/automations/{a.automation_id}">{a.automation_name ?? 'automation'}</a> automation</span>
		{:else if a.actor_kind === 'user' && a.actor_label}
			<span class="muted detail">· by {a.actor_label}</span>
		{:else if a.actor_kind === 'api'}
			<span class="muted detail">· by the API</span>
		{/if}
	{:else if a.type === 'visited'}
		<!-- Site tracking (#153): the path (or «event»), site name muted; the full path on hover. -->
		<span class="path" title={a.site_name ? `${a.detail ?? ''} · ${a.site_name}` : (a.detail ?? '')}>{a.site_kind === 'event' ? `«${a.detail}»` : a.detail}</span>
		{#if a.site_name}<span class="muted detail">· {a.site_name}</span>{/if}
	{:else if a.type === 'enrolled' || a.type === 'completed'}
		{#if a.automation_id}<a href="/automations/{a.automation_id}">{a.automation_name ?? 'automation'}</a>{/if}
	{:else if a.campaign_id}
		<a href={viewEmailHref(a.campaign_id, { contactId: a.contact_id })} title={a.subject ?? ''}>{a.subject ?? 'an email'}</a>
	{/if}
	{#if a.detail && a.type !== 'visited' && a.type !== 'pipeline' && a.type !== 'gmail'}
		{#if a.type === 'click'}
			<span class="muted detail url" title={a.detail}>{shortUrl(a.detail)}</span>
		{:else if a.type === 'reply' && a.conv_key}
			<!-- #566: the company timeline knows the reply's conversation thread. -->
			<span class="muted detail">·</span> <a href="/conversations/{encodeURIComponent(a.conv_key)}" title={a.detail}>{a.detail}</a>
		{:else if a.type === 'form' && a.form_id}
			<!-- #516: a hosted form's submission links to the form. -->
			<span class="muted detail">·</span> <a href="/forms/{a.form_id}" title={a.detail}>{a.detail}</a>
		{:else}
			<span class="muted detail" title={a.detail}>· {a.detail}</span>
		{/if}
	{/if}
{/snippet}

{#snippet row(a: ActivityItem, showWho: boolean)}
	<li class="item t-{a.type}" class:nested={!showWho}>
		{#if showWho}
			{@const icon = TOOL_ICONS[a.type]}
			{#if a.contact_id}
				<Avatar contactId={a.contact_id} name={a.name ?? a.email ?? ''} size={20} />
			{:else if icon}
				<span class="src-icon"><Icon name={icon} size={16} /></span>
			{:else}
				<span class="avatar-blank"></span>
			{/if}
		{/if}
		<span class="what">
			{#if a.type === 'domain_auth'}
				<!-- #304: a domain-auth check went pass → fail. email = the domain. -->
				<a href="/deliverability#domain-auth">{a.detail ?? `Domain authentication broken on ${a.email}`}</a>
			{:else if a.type === 'assistant_setting'}
				<!-- #322 addendum: who turned an assistant permission on or off; #327 code & snippets. -->
				<span>{a.actor_label ?? 'Someone'}</span>
				{#if a.setting === 'allowCode'}
					<span class="verb">set</span>
					<a href="/settings/assistant">assistant code &amp; snippets</a>
					<span class="verb">to {a.detail === 'admins' ? 'admins only' : a.detail === 'everyone' ? 'everyone' : 'off'}</span>
				{:else}
					<span class="verb">turned {a.detail === 'on' ? 'on' : 'off'}</span>
					<a href="/settings/assistant">assistant contact deletion</a>
				{/if}
			{:else if a.type === 'github'}
				<!-- #566 company timeline: a recent GitHub issue (updated_at; closed = when it closed). -->
				<span class="verb">{a.status === 'closed' ? 'Issue closed' : 'Issue updated'}</span>
				{#if a.url}<a href={a.url} target="_blank" rel="noopener noreferrer">{a.detail}</a>{:else}<span>{a.detail}</span>{/if}
				{#if a.ref}<span class="muted detail">· {a.ref}</span>{/if}
			{:else if a.type === 'invoice' || a.type === 'payment'}
				<!-- #566: Zoho Books (billing viewers only — the loader never reads it otherwise). -->
				<span class="verb">{a.type === 'invoice' ? 'Invoice' : 'Payment received'}</span>
				{#if a.url}<a href={a.url} target="_blank" rel="noopener noreferrer">{a.ref}</a>{:else}<span>{a.ref}</span>{/if}
				<span class="muted detail">· {money(a.amount, a.currency)}{#if a.type === 'invoice' && a.status}{' '}· {a.status.replace(/_/g, ' ')}{/if}{#if a.type === 'payment' && a.detail}{' '}· for {a.detail}{/if}</span>
			{:else if a.type === 'timing'}
				<!-- #566: Timing's latest tracked entry. -->
				<span class="verb">Time tracked in Timing</span>
				{#if a.detail}<span title={a.detail}>· {a.detail}</span>{/if}
			{:else}
				{#if showWho}{@render who(a)}{/if}
				{@render what(a)}
			{/if}
		</span>
		<time class="muted when" title="{a.at} UTC">{relTime(a.at, now)}</time>
	</li>
{/snippet}

{#if groups}
	<ul class="items groups">
		{#each groups as g (g.contact_id)}
			<li class="group">
				<div class="group-head">
					<Avatar contactId={g.contact_id} name={g.name ?? g.email ?? ''} size={20} />
					<span class="what">{@render who(g.items[0])}</span>
					{#if g.more}<span class="muted when">+{g.more} more</span>{/if}
				</div>
				<ul class="items">
					{#each g.items as a, i (i)}
						{@render row(a, false)}
					{/each}
				</ul>
			</li>
		{/each}
	</ul>
{:else}
	<ul class="items">
		{#each items as a, i (i)}
			{@render row(a, true)}
		{/each}
	</ul>
{/if}

<style>
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
	.item.nested {
		padding-left: var(--space-xl);
	}
	.group {
		padding: var(--space-xs) 0;
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.group:last-child {
		box-shadow: none;
	}
	.group-head {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-medium);
	}
	.avatar-blank {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--neutral-muted);
		flex-shrink: 0;
	}
	.src-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		color: var(--muted);
	}
	.what {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tier {
		display: inline-flex;
		vertical-align: middle;
		margin: 0 var(--space-xxs);
	}
	.item.t-unsubscribe .what {
		white-space: normal;
	}
	.item.t-unsubscribe .detail {
		display: block;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	/* Click targets: their own line, truncated — the row text never pushes into the time column. */
	.detail.url {
		display: block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.verb {
		color: var(--muted);
	}
	.t-unsubscribe .verb,
	.t-spam .verb,
	.t-bounce .verb {
		color: var(--danger);
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
	}
</style>

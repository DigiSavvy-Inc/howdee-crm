<script lang="ts">
	import { enhance } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { relTime } from '$lib/reltime';
	import { decayText } from '$lib/scoring';

	let { data, form } = $props();

	const eng = $derived(data.engagement);
	const editHref = (id: number) => (data.addForm ? `/settings/scoring/${id}?add_form=${data.addForm.id}` : `/settings/scoring/${id}`);
</script>

<svelte:head><title>Scoring</title></svelte:head>

<Breadcrumbs items={[{ label: 'Settings', href: '/settings' }, { label: 'Scoring' }]} />

<div class="head">
	<h1>Scoring</h1>
	<a class="btnlink" href="/settings/scoring/new">New score →</a>
</div>
<p class="muted intro">
	A score adds up points for what a contact does (opens, clicks, replies, forms, site visits, pipeline moves…) and for
	conditions they match. Each contact's value and band show on their page. Points come from the heartbeat, a few hundred
	rows a minute.
</p>

{#if data.addForm}
	<p class="notice" role="status">
		Adding a rule for the form “{data.addForm.name}”: pick the score it should add points to.
		<a href="/settings/scoring">Cancel</a>
	</p>
{/if}
{#if form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
{#if form?.done}<p class="notice ok" role="status">{form.done}</p>{/if}

<ul class="list">
	<li class="card">
		<div class="title"><strong>Engagement</strong><span class="pill">Built-in</span></div>
		<p class="desc">
			The hot / warm / cool / cold tier on every contact, computed separately from the scores below. Each real open counts
			{eng.wOpen}, an automatic (Apple Mail / prefetch) open {eng.wProxyOpen}, a click {eng.wClick}, a reply {eng.wReply}, a
			page view {eng.wPageview} and a site event {eng.wSiteEvent}. Every point halves after {eng.halfLifeDays} days, and the
			total is squashed onto 0–100.
		</p>
		<p class="desc">
			<strong>Hot</strong> from {eng.tiers.hot}, <strong>Warm</strong> from {eng.tiers.warm}, <strong>Cool</strong> from
			{eng.tiers.cool}, else <strong>Cold</strong>. <strong>New</strong> = nothing sent yet; <strong>Never</strong> = sent 3 or
			more with no real engagement; an unsubscribed contact is always Cold; an override (set by hand, an automation or the
			assistant) wins until it's cleared.
		</p>
		<div class="actions"><a class="btnlink sm" href="/settings#engagement">Tune in Settings → General → Engagement</a></div>
	</li>

	{#each data.scores as s (s.id)}
		<li class="card" class:off={s.status === 'paused'}>
			<div class="main">
				<div class="title">
					<a href={editHref(s.id)}><strong>{s.name}</strong></a>
					<span class="pill" class:on={s.status === 'active'}>{s.status === 'active' ? 'Active' : 'Paused'}</span>
					{#if s.is_default}<span class="pill">Default</span>{/if}
				</div>
				{#if s.description}<p class="desc muted">{s.description}</p>{/if}
				<p class="meta muted">
					{decayText(s.decay_mode, s.half_life_days)} · {s.rule_count} rule{s.rule_count === 1 ? '' : 's'} ·
					{s.nonzero.toLocaleString('en-US')} contact{s.nonzero === 1 ? '' : 's'} with points
					{#if s.dirty}· {s.dirty.toLocaleString('en-US')} waiting to recompute{/if}
					· last engine run {data.lastRun ? relTime(data.lastRun.at) : 'not yet'}
				</p>
			</div>
			<div class="actions">
				<a class="btnlink sm" href={editHref(s.id)}>{data.addForm ? `Add rule here` : `Edit`}</a>
				<form method="POST" action="?/status" use:enhance class="inline">
					<input type="hidden" name="id" value={s.id} />
					<input type="hidden" name="status" value={s.status === 'active' ? 'paused' : 'active'} />
					<button type="submit" class="secondary sm">{s.status === 'active' ? 'Pause' : 'Resume'}</button>
				</form>
				<form
					method="POST"
					action="?/rebuild"
					use:enhance
					class="inline"
					onsubmit={(e) => {
						if (!confirm(`Rebuild "${s.name}"? Its earned points are cleared and replayed from the last 365 days. Manual adjustments stay.`)) e.preventDefault();
					}}
				>
					<input type="hidden" name="id" value={s.id} />
					<button type="submit" class="secondary sm">Rebuild</button>
				</form>
				<form
					method="POST"
					action="?/delete"
					use:enhance
					class="inline"
					onsubmit={(e) => {
						if (!confirm(`Delete the score "${s.name}" and every point it holds? This can't be undone.`)) e.preventDefault();
					}}
				>
					<input type="hidden" name="id" value={s.id} />
					<button type="submit" class="secondary sm danger-text">Delete</button>
				</form>
			</div>
		</li>
	{/each}
</ul>
{#if data.scores.length === 0}<p class="muted">No custom scores yet.</p>{/if}

<style>
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); max-width: 720px; }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	.notice { max-width: 720px; }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); max-width: 720px; }
	.card.off .main { opacity: 0.7; }
	.title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xxs) var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	.pill { font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xs); border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
	.pill.on { color: var(--text); }
	.desc, .meta { margin: var(--space-xxs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-top: var(--space-s); }
	.inline { display: inline-flex; gap: var(--space-xxs); margin: 0; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.danger-text { color: var(--danger); }
	.btnlink { display: inline-block; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); text-decoration: none; }
	.btnlink.sm { font-size: var(--size-xs); line-height: var(--line-xs); }
</style>

<script lang="ts">
	// #434: the trigger drawer's fields for "Visits the site often". Posted as one hidden
	// `trigger_config` JSON (the write layer validates it): pages / visits, the number, the
	// window, the site, an optional path filter and the cooldown.
	import { untrack } from 'svelte';
	import { PATH_OPS, type PathOp } from '$lib/site-trigger';
	import {
		SESSION_GAP_MINUTES,
		SITE_ACTIVITY_MAX_COOLDOWN,
		SITE_ACTIVITY_MAX_DAYS,
		SITE_ACTIVITY_MAX_THRESHOLD,
		type SiteActivityConfig,
		type SiteActivityMeasure
	} from '$lib/site-activity-trigger';

	let {
		config,
		sites
	}: {
		config: SiteActivityConfig;
		sites: { id: number; name: string; enabled?: number | boolean }[];
	} = $props();

	// The drawer mounts this fresh each time it opens, so the saved config is the start state.
	const start = untrack(() => $state.snapshot(config)) as SiteActivityConfig;
	let measure = $state<SiteActivityMeasure>(start.measure);
	let threshold = $state<number>(start.threshold);
	let days = $state<number>(start.days);
	let siteId = $state<number | ''>(start.site_id ?? '');
	let pathOp = $state<PathOp>(start.path_op);
	let path = $state(start.path);
	let cooldown = $state<number>(start.cooldown_hours);

	const json = $derived(
		JSON.stringify({
			measure,
			threshold,
			days,
			site_id: siteId === '' ? null : Number(siteId),
			path_op: pathOp,
			path,
			cooldown_hours: cooldown
		})
	);
</script>

<input type="hidden" name="trigger_config" value={json} />

<fieldset class="field">
	<legend>Count</legend>
	<label class="radio"><input type="radio" bind:group={measure} value="pages" /> Pages viewed</label>
	<label class="radio"><input type="radio" bind:group={measure} value="visits" /> Separate visits</label>
</fieldset>
<p class="hint muted">A visit is a run of pageviews less than {SESSION_GAP_MINUTES} minutes apart.</p>

<div class="sa-row">
	<label class="inline">
		at least
		<input type="number" min="1" max={SITE_ACTIVITY_MAX_THRESHOLD} step="1" bind:value={threshold} aria-label="How many" />
		{measure === 'visits' ? 'visits' : 'pages'}
	</label>
	<label class="inline">
		in the last
		<input type="number" min="1" max={SITE_ACTIVITY_MAX_DAYS} step="1" bind:value={days} aria-label="Days" />
		days
	</label>
</div>

<label class="field">
	<span>Site</span>
	<select bind:value={siteId} aria-label="Tracking site">
		<option value="">Any site</option>
		{#each sites as s (s.id)}
			<option value={s.id}>{s.name}{s.enabled === 0 || s.enabled === false ? ' (disabled)' : ''}</option>
		{/each}
	</select>
</label>

<details class="field" open={!!start.path}>
	<summary>Only pages whose path…</summary>
	<div class="sa-row">
		<select bind:value={pathOp} aria-label="Path match">
			{#each PATH_OPS as o (o.op)}<option value={o.op}>{o.label}</option>{/each}
		</select>
		<input class="sa-path" type="text" bind:value={path} maxlength="300" placeholder="/blog (blank = every page)" aria-label="Page path" />
	</div>
</details>

<label class="inline field-gap">
	cooldown
	<input type="number" min="0" max={SITE_ACTIVITY_MAX_COOLDOWN} step="1" bind:value={cooldown} aria-label="Cooldown (hours)" />
	h
</label>

<p class="hint muted">
	Checked as each page view arrives from the tracking snippet (known contacts only): once a contact's count in the window
	reaches the number, they are enrolled. After that the trigger waits out the cooldown (default one week) before it can
	fire for them again; the re-entry setting below still applies. Site events older than {SITE_ACTIVITY_MAX_DAYS} days are
	deleted, so the window is at most {SITE_ACTIVITY_MAX_DAYS} days.
	{#if !sites.length}No tracking sites yet — add one in Settings → Tracking.{/if}
</p>

<style>
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xxs);
		margin-top: var(--space-s);
	}
	fieldset {
		border: 0;
		padding: 0;
	}
	legend {
		padding: 0;
		margin-bottom: var(--space-xxs);
	}
	.radio,
	.inline {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.inline input[type='number'] {
		width: 6rem;
	}
	.sa-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		margin-top: var(--space-xs);
	}
	.sa-path {
		flex: 1 1 12rem;
		min-width: 0;
	}
	details.field {
		align-items: stretch;
	}
	summary {
		cursor: pointer;
	}
	.field-gap {
		margin-top: var(--space-s);
	}
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import ScoreRuleForm from '$lib/components/ScoreRuleForm.svelte';
	import {
		DECAY_HELP,
		DECAY_LABELS,
		DECAY_MODES,
		SCORE_LIMITS,
		SOURCE_LABELS,
		decayText,
		eventTypeDef,
		parseBands,
		parseFilter,
		pointsText,
		ruleTitle,
		answerRulesText,
		type Band,
		type DecayMode
	} from '$lib/scoring';

	let { data, form } = $props();

	// Settings → Scoring → one score (#466). The score form (name, description, status, decay,
	// bands) on top; rules (add / edit / reorder / delete) below once the score exists.
	const s = $derived(data.score);
	// The form keeps what's typed; it starts from the score as loaded.
	const s0 = untrack(() => data.score);
	let name = $state(s0?.name ?? '');
	let description = $state(s0?.description ?? '');
	let status = $state(s0?.status ?? 'active');
	let decay = $state<DecayMode>(s0?.decay_mode ?? 'expire');
	let halfLife = $state(s0?.half_life_days != null ? String(s0.half_life_days) : '60');
	let bands = $state<{ label: string; min: string }[]>(parseBands(s0?.bands).map((b) => ({ label: b.label, min: String(b.min) })));
	// #621: ?add_form=<id> (from a form's Scoring section) opens a new rule on that form.
	let adding = $state(untrack(() => !!data.addForm));
	let editing = $state<number | null>(null);

	const bandsJson = $derived(
		JSON.stringify(
			bands
				.map((b): Band => ({ label: b.label.trim(), min: Number(b.min) }))
				.filter((b) => b.label || Number.isFinite(b.min))
				.sort((a, b) => b.min - a.min)
		)
	);
	const backlogTotal = $derived(data.backlog ? Object.values(data.backlog).reduce((n, v) => n + v, 0) : 0);

	function filterText(raw: string | null): string {
		const f = parseFilter(raw);
		const parts: string[] = [];
		const nameOf = (list: { id: number; name: string }[], id?: number) => list.find((x) => x.id === id)?.name ?? `#${id}`;
		if (f.campaign_id) parts.push(`campaign “${nameOf(data.pickers.campaigns, f.campaign_id)}”`);
		if (f.automation_id) parts.push(`automation “${nameOf(data.pickers.automations, f.automation_id)}”`);
		if (f.url_contains) parts.push(`URL contains “${f.url_contains}”`);
		if (f.any) parts.push('any bounce');
		if (f.key_id) parts.push(`form “${nameOf(data.pickers.keys, f.key_id)}”`);
		if (f.name) parts.push(`named “${f.name}”`);
		if (f.stage_id) parts.push(`stage “${nameOf(data.pickers.stages, f.stage_id)}”`);
		if (f.list_id) parts.push(`“${nameOf(data.pickers.lists, f.list_id)}”`);
		if (f.form_id) {
			const fp = data.pickers.forms.find((x) => x.id === f.form_id);
			parts.push(`form “${fp?.name ?? `#${f.form_id}`}”`);
			const words = answerRulesText(f.answers, fp?.questions ?? []);
			if (words) parts.push(`when ${words}`);
		}
		return parts.join(' · ');
	}
</script>

<svelte:head><title>{s ? s.name : 'New score'} · Scoring</title></svelte:head>

<Breadcrumbs items={[{ label: 'Settings', href: '/settings' }, { label: 'Scoring', href: '/settings/scoring' }, { label: s ? s.name : 'New score' }]} />

<h1>{s ? s.name : 'New score'}</h1>
<p class="muted intro"><strong>{DECAY_LABELS[decay]}:</strong> {DECAY_HELP[decay]}</p>

{#if form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
{#if form?.done}<p class="notice ok" role="status">{form.done}</p>{/if}

<form method="POST" action="?/save" use:enhance={() => async ({ update }) => update({ reset: false })} class="card score-form">
	<label class="field">
		<span class="muted">Name</span>
		<input type="text" name="name" bind:value={name} maxlength={SCORE_LIMITS.nameMax} required />
	</label>
	<label class="field">
		<span class="muted">Description</span>
		<textarea name="description" bind:value={description} maxlength={SCORE_LIMITS.descriptionMax} rows="2"></textarea>
	</label>
	<div class="row">
		<label class="field small">
			<span class="muted">Status</span>
			<select name="status" bind:value={status}>
				<option value="active">Active</option>
				<option value="paused">Paused</option>
			</select>
		</label>
		<label class="field small">
			<span class="muted">Decay</span>
			<select name="decay_mode" bind:value={decay}>
				{#each DECAY_MODES as m (m)}<option value={m}>{DECAY_LABELS[m]}</option>{/each}
			</select>
		</label>
		{#if decay === 'half_life'}
			<label class="field small">
				<span class="muted">Half-life (days)</span>
				<input type="number" name="half_life_days" bind:value={halfLife} min={SCORE_LIMITS.minHalfLife} max={SCORE_LIMITS.maxHalfLife} required />
			</label>
		{/if}
	</div>

	<fieldset class="bands">
		<legend>Bands <span class="muted">(optional) — a label for each range, e.g. Hot from 50</span></legend>
		{#each bands as b, i (i)}
			<div class="band">
				<input type="text" bind:value={b.label} placeholder="Label" maxlength={SCORE_LIMITS.bandLabelMax} aria-label={`Band ${i + 1} label`} />
				<span class="muted">from</span>
				<input type="number" bind:value={b.min} step="1" aria-label={`Band ${i + 1} minimum`} />
				<button type="button" class="secondary sm" onclick={() => (bands = bands.filter((_, j) => j !== i))}>Remove</button>
			</div>
		{/each}
		{#if bands.length < SCORE_LIMITS.maxBands}
			<button type="button" class="secondary sm" onclick={() => (bands = [...bands, { label: '', min: '0' }])}>Add band</button>
		{/if}
		<input type="hidden" name="bands" value={bandsJson} />
		<p class="muted hint">Bands are sorted highest first; a value below the lowest band has no band.</p>
	</fieldset>

	<button type="submit">{s ? 'Save score' : 'Create score'}</button>
</form>

{#if s}
	<section class="card">
		<div class="rules-head">
			<h2>Rules</h2>
			<span class="muted">{data.rules.length} / {SCORE_LIMITS.maxRules}</span>
		</div>
		{#if form?.ruleError}<p class="notice err" role="alert">{form.ruleError}</p>{/if}
		{#if form?.ruleDone}<p class="notice ok" role="status">{form.ruleDone}</p>{/if}
		{#if data.rules.length === 0}<p class="muted">No rules yet — add one below.</p>{/if}
		<ul class="rules">
			{#each data.rules as r, i (r.id)}
				<li class:off={!r.active}>
					<div class="rule-line">
						<strong class="pts" class:neg={r.points < 0}>{pointsText(r.points)}</strong>
						<span>{ruleTitle(r)}</span>
						<span class="pill">{r.kind === 'event' ? 'Event' : 'Condition'}</span>
						{#if !r.active}<span class="pill">Off</span>{/if}
					</div>
					<p class="muted meta">
						{#if r.kind === 'event'}
							{eventTypeDef(r.event_type)?.label ?? r.event_type}{#if filterText(r.filter)}{' '}· {filterText(r.filter)}{/if}
							· {SOURCE_LABELS[eventTypeDef(r.event_type)?.source ?? ''] ?? ''}
							{#if s.decay_mode === 'expire'}· {r.expires_days ? `expires after ${r.expires_days} days` : 'permanent'}{/if}
							{#if r.max_per_day}· at most {r.max_per_day} a day{/if}
							{#if r.once}· first time only{/if}
						{:else}
							Held while the contact matches; re-checked daily and when saved.
						{/if}
					</p>
					<div class="actions">
						<button type="button" class="secondary sm" onclick={() => (editing = editing === r.id ? null : r.id)}>{editing === r.id ? 'Close' : 'Edit'}</button>
						<form method="POST" action="?/moveRule" use:enhance class="inline">
							<input type="hidden" name="rule_id" value={r.id} />
							<button type="submit" name="dir" value="up" class="secondary sm" disabled={i === 0} aria-label="Move rule up">Up</button>
							<button type="submit" name="dir" value="down" class="secondary sm" disabled={i === data.rules.length - 1} aria-label="Move rule down">Down</button>
						</form>
						<form
							method="POST"
							action="?/deleteRule"
							use:enhance
							class="inline"
							onsubmit={(e) => {
								if (!confirm('Delete this rule and the points it gave?')) e.preventDefault();
							}}
						>
							<input type="hidden" name="rule_id" value={r.id} />
							<button type="submit" class="secondary sm danger-text">Delete</button>
						</form>
					</div>
					{#if editing === r.id}
						<ScoreRuleForm rule={r} decayMode={s.decay_mode} pickers={data.pickers} onsaved={() => (editing = null)} />
					{/if}
				</li>
			{/each}
		</ul>
		{#if data.rules.length < SCORE_LIMITS.maxRules}
			{#if adding}
				<h3>New rule</h3>
				<ScoreRuleForm decayMode={s.decay_mode} pickers={data.pickers} presetForm={data.addForm} onsaved={() => (adding = false)} />
				<button type="button" class="secondary sm" onclick={() => (adding = false)}>Cancel</button>
			{:else}
				<button type="button" class="secondary sm" onclick={() => (adding = true)}>Add rule</button>
			{/if}
		{/if}
	</section>

	<section class="card">
		<h2>Rebuild</h2>
		<p class="muted meta">
			Clears the points this score earned and replays the last 365 days of activity through its current rules
			(manual adjustments stay). {decayText(s.decay_mode, s.half_life_days)}.
		</p>
		{#if backlogTotal > 0 && data.backlog}
			<p class="meta">
				Rows still to read:
				{Object.entries(data.backlog)
					.filter(([, n]) => n > 0)
					.map(([src, n]) => `${SOURCE_LABELS[src] ?? src} ${n.toLocaleString('en-US')}`)
					.join(' · ')}
			</p>
		{:else}
			<p class="muted meta">Up to date — nothing left to read.</p>
		{/if}
		<form
			method="POST"
			action="?/rebuild"
			use:enhance
			onsubmit={(e) => {
				if (!confirm(`Rebuild "${s.name}" from the last 365 days?`)) e.preventDefault();
			}}
		>
			<button type="submit" class="secondary sm">Rebuild</button>
		</form>
	</section>
{/if}

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); }
	h3 { margin: var(--space-s) 0 0; font-size: var(--size-s); line-height: var(--line-s); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	.notice { max-width: 720px; }
	.card { max-width: 720px; margin-bottom: var(--card-gap); }
	.score-form { display: flex; flex-direction: column; gap: var(--space-s); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); }
	.field.small { max-width: 180px; }
	.row { display: flex; flex-wrap: wrap; gap: var(--space-s); }
	.bands { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	.bands legend { padding: 0; font-size: var(--size-s); line-height: var(--line-s); margin-bottom: var(--space-xxs); }
	.band { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; }
	.band input[type='number'] { width: 7em; }
	.hint, .meta { margin: var(--space-xxs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.rules-head { display: flex; align-items: baseline; justify-content: space-between; }
	.rules { list-style: none; margin: var(--space-s) 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); }
	.rules li { border-top: 1px solid var(--border); padding-top: var(--space-s); }
	.rules li.off .rule-line { opacity: 0.7; }
	.rule-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	.pts { min-width: 3.5em; font-variant-numeric: tabular-nums; }
	.pill { font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xs); border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-top: var(--space-xs); }
	.inline { display: inline-flex; gap: var(--space-xxs); margin: 0; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.danger-text { color: var(--danger); }
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		GENERAL_LIMITS,
		KIND_LABELS,
		RULE_KEYS,
		RULE_KIND,
		RULE_LABELS,
		RULE_THRESHOLDS,
		SUGGESTION_KINDS
	} from '$lib/suggestions';

	let { data, form } = $props();
	const cfg = $derived(data.cfg);
	const line = $derived(form && 'modelLine' in form && form.modelLine ? form.modelLine : data.modelLine);

	// #715: a refused save names the allowed range next to the field (problem `path`).
	const problems = $derived(
		new Map(((form && 'problems' in form ? form.problems : null) ?? []).map((p) => [p.path, p.message]))
	);
	const fmt = (n: number) => n.toLocaleString('en-US');
</script>

<svelte:head><title>Suggestions settings</title></svelte:head>

<h1>Suggestions</h1>
<p class="muted intro">
	Suggestions tell the team who to contact and what to send next, in a small panel at the bottom right. Rules find
	them on the heartbeat. Nothing is ever sent, scheduled or enrolled from a suggestion: each next step only opens a
	page with the details filled in.
</p>

<form
	method="POST"
	action="?/save"
	use:enhance={() =>
		async ({ update }) => {
			await update({ reset: false });
		}}
>
	<section class="card">
		<h2>Turn on</h2>
		<label class="check">
			<input type="checkbox" name="enabled" value="1" checked={cfg.enabled} />
			Suggestions on
		</label>
		<p class="muted small">
			Off by default. Turning it off hides the panel for everyone at once and stops the heartbeat work. Each person can
			also hide the panel for themselves in Account.
		</p>
		<fieldset class="row">
			<legend>Who sees suggestions</legend>
			<label class="check"><input type="radio" name="audience" value="admins" checked={cfg.audience === 'admins'} /> Admins only</label>
			<label class="check"><input type="radio" name="audience" value="everyone" checked={cfg.audience === 'everyone'} /> Everyone</label>
			{#if problems.get('audience')}<span class="field-err" role="alert">{problems.get('audience')}</span>{/if}
		</fieldset>
	</section>

	<section class="card">
		<h2>Kinds</h2>
		<p class="muted small">A kind that is off makes no new suggestions, and its open ones are hidden until it is back on.</p>
		<div class="row">
			{#each SUGGESTION_KINDS as k (k)}
				<label class="check"><input type="checkbox" name="kind_{k}" value="1" checked={cfg.kinds[k]} /> {KIND_LABELS[k]}</label>
			{/each}
		</div>
	</section>

	<section class="card">
		<h2>Rules</h2>
		<p class="muted small">
			A change takes effect on the next heartbeat tick: saving asks it to run the rules again. Unsubscribed and archived
			contacts never appear.
		</p>
		<div class="rules">
			{#each RULE_KEYS as r (r)}
				<fieldset class="rule">
					<legend>
						<label class="check">
							<input type="checkbox" name="rule_{r}_on" value="1" checked={cfg.rules[r].on} />
							{RULE_LABELS[r]} <span class="muted small">· {KIND_LABELS[RULE_KIND[r]]}</span>
						</label>
					</legend>
					<div class="thresholds">
						{#each RULE_THRESHOLDS[r] as t (t.key)}
							{@const path = `rules.${r}.${t.key}`}
							<label class="num">
								<span>{t.label}</span>
								<input
									type="number"
									name="rule_{r}_{t.key}"
									min={t.min}
									max={t.max}
									step="1"
									required
									value={cfg.rules[r][t.key]}
									aria-invalid={problems.has(path) ? 'true' : undefined}
								/>
								<span class="muted small">{fmt(t.min)} to {fmt(t.max)} · default {fmt(t.default)}</span>
								{#if problems.get(path)}<span class="field-err" role="alert">{problems.get(path)}</span>{/if}
							</label>
						{/each}
						{#if r === 'hot_engagement'}
							<label class="num">
								<span>Score to watch</span>
								<select name="score_id" value={cfg.score_id === null ? '' : String(cfg.score_id)}>
									<option value="">Lead score (built-in)</option>
									{#each data.scores as s (s.id)}
										<option value={String(s.id)}>{s.name}</option>
									{/each}
								</select>
								{#if problems.get('score_id')}<span class="field-err" role="alert">{problems.get('score_id')}</span>{/if}
							</label>
						{/if}
					</div>
				</fieldset>
			{/each}
		</div>
	</section>

	<section class="card">
		<h2>Limits</h2>
		<div class="thresholds">
			<label class="num">
				<span>Cooldown after Done or Dismiss (days)</span>
				<input
					type="number"
					name="cooldown_days"
					min={GENERAL_LIMITS.cooldown_days.min}
					max={GENERAL_LIMITS.cooldown_days.max}
					step="1"
					required
					value={cfg.cooldown_days}
					aria-invalid={problems.has('cooldown_days') ? 'true' : undefined}
				/>
				<span class="muted small">{GENERAL_LIMITS.cooldown_days.min} to {GENERAL_LIMITS.cooldown_days.max}. New evidence ends it early.</span>
				{#if problems.get('cooldown_days')}<span class="field-err" role="alert">{problems.get('cooldown_days')}</span>{/if}
			</label>
			<label class="num">
				<span>Most new suggestions per day</span>
				<input
					type="number"
					name="daily_cap"
					min={GENERAL_LIMITS.daily_cap.min}
					max={GENERAL_LIMITS.daily_cap.max}
					step="1"
					required
					value={cfg.daily_cap}
					aria-invalid={problems.has('daily_cap') ? 'true' : undefined}
				/>
				<span class="muted small">{GENERAL_LIMITS.daily_cap.min} to {GENERAL_LIMITS.daily_cap.max}. The day resets at midnight UTC; open ones stay.</span>
				{#if problems.get('daily_cap')}<span class="field-err" role="alert">{problems.get('daily_cap')}</span>{/if}
			</label>
		</div>
	</section>

	<section class="card">
		<h2>AI</h2>
		<label class="check">
			<input type="checkbox" name="use_ai" value="1" checked={cfg.use_ai} />
			Use AI to rank and word suggestions
		</label>
		<p class="muted small">
			Off means rules only, even when a key is set. AI also needs assistant Access not Off, a key for the picked model's
			provider and the monthly spend cap not reached.
		</p>
		<p class="small" role="status">Model in use: <strong>{line.model ?? 'Rules only'}</strong>. <span class="muted">{line.text}</span></p>
		<p class="small"><a href="/settings/assistant#feature-models">Pick the model in Settings → Assistant → Model per feature</a></p>
	</section>

	<div class="actions">
		<button type="submit">Save</button>
		{#if form && 'saved' in form && form.saved}<span class="ok" role="status">Saved. The next heartbeat tick runs the rules.</span>{/if}
		{#if problems.size}<span class="field-err" role="alert">Nothing saved. Fix the marked fields.</span>{/if}
	</div>
</form>

<style>
	.intro {
		margin: 0 0 var(--space-m);
	}
	.card {
		margin-bottom: var(--space-m);
	}
	.card h2 {
		margin: 0 0 var(--space-xs);
		font-size: var(--size-m);
		line-height: var(--line-m);
	}
	.small {
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
	}
	legend {
		padding: 0;
		margin-bottom: var(--space-xs);
		font-weight: var(--weight-ui-medium);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s) var(--space-m);
		align-items: center;
	}
	.rules {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
	}
	.rule + .rule {
		padding-top: var(--space-s);
		box-shadow: 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.thresholds {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: var(--space-s) var(--space-m);
	}
	.num {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.num input {
		width: 8rem;
	}
	.field-err {
		color: var(--danger);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
	}
</style>

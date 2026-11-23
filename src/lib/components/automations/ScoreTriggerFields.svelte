<script lang="ts">
	// #467: the trigger drawer's fields for "Score changes". Posted as one hidden
	// `trigger_config` JSON (the write layer validates it): the score, the mode and its
	// threshold or band.
	import { untrack } from 'svelte';
	import {
		SCORE_TRIGGER_MODES,
		SCORE_TRIGGER_MODE_LABELS,
		defaultScoreTriggerConfig,
		type ScoreTriggerConfig,
		type ScoreTriggerMode
	} from '$lib/score-trigger';

	let {
		config,
		scores
	}: {
		/** The saved config, or null for a fresh trigger. */
		config: ScoreTriggerConfig | null;
		scores: { id: number; name: string; bands: string[] }[];
	} = $props();

	// The drawer mounts this fresh each time it opens, so the saved config is the start state.
	const start = untrack(() => $state.snapshot(config) ?? { ...defaultScoreTriggerConfig(), score_id: scores[0]?.id ?? null }) as ScoreTriggerConfig;
	let scoreId = $state<number | ''>(start.score_id ?? '');
	let mode = $state<ScoreTriggerMode>(start.mode);
	let threshold = $state<number | ''>(start.threshold ?? 50);
	let band = $state(start.band ?? '');

	const bands = $derived(scores.find((s) => s.id === scoreId)?.bands ?? []);
	const crossing = $derived(mode === 'crosses_above' || mode === 'crosses_below');
	const json = $derived(
		JSON.stringify({
			score_id: scoreId === '' ? null : Number(scoreId),
			mode,
			threshold: crossing && threshold !== '' ? Number(threshold) : null,
			band: mode === 'enters_band' ? band || null : null
		})
	);
</script>

<input type="hidden" name="trigger_config" value={json} />

{#if !scores.length}
	<p class="notice warn" role="status">There are no scores yet. Add one in Settings → Scoring.</p>
{/if}

<label class="field">
	<span>Score</span>
	<select bind:value={scoreId}>
		<option value="">Choose a score…</option>
		{#each scores as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
	</select>
</label>

<label class="field">
	<span>When the score…</span>
	<select bind:value={mode}>
		{#each SCORE_TRIGGER_MODES as m (m)}<option value={m}>{SCORE_TRIGGER_MODE_LABELS[m]}</option>{/each}
	</select>
</label>

{#if crossing}
	<label class="field">
		<span>{mode === 'crosses_above' ? 'Rises to (or above)' : 'Drops below'}</span>
		<input type="number" step="1" bind:value={threshold} style="width: 8em" />
	</label>
{:else if mode === 'enters_band'}
	<label class="field">
		<span>Band</span>
		<select bind:value={band}>
			<option value="">Choose a band…</option>
			{#each bands as b (b)}<option value={b}>{b}</option>{/each}
		</select>
	</label>
	{#if scoreId !== '' && !bands.length}<p class="hint muted">This score has no bands — add them in Settings → Scoring.</p>{/if}
{/if}

<p class="hint muted">
	Fires once when the score actually moves across the line (checked on the next heartbeat after the score is recomputed),
	not again while it stays there.
</p>

<style>
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xxs);
		margin-top: var(--space-s);
	}
</style>

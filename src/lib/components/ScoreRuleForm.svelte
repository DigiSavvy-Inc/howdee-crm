<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import RuleBuilder from '$lib/components/RuleBuilder.svelte';
	import type { SegmentRules } from '$lib/server/segment-query';
	import {
		EVENT_TYPES,
		FILTER_LABELS,
		SCORE_LIMITS,
		answerOpsFor,
		eventTypeDef,
		parseFilter,
		type AnswerQuestion,
		type DecayMode,
		type RuleFilter
	} from '$lib/scoring';
	import { RULE_OP_LABELS, UNARY_OPS, type FormRuleOp } from '$lib/form-logic';

	// One score rule (#466) — add (rule = null) or edit. Event rules: an event type, the filters
	// that type allows, points, expiry (expire mode only), max per day, once. Condition rules:
	// the segment RuleBuilder; the rule holds its points while the contact matches.
	// #621: "Submitted a CRM form" picks a form and, with one form picked, answer conditions
	// (question, comparison, value). `presetForm` opens a new rule on that form.
	type Picker = { id: number; name: string };
	let {
		rule = null,
		decayMode,
		pickers,
		presetForm = null,
		onsaved
	}: {
		rule?: {
			id: number;
			kind: 'event' | 'condition';
			label: string;
			event_type: string | null;
			filter: string | null;
			rules: string | null;
			points: number;
			expires_days: number | null;
			max_per_day: number | null;
			once: number;
			active: number;
		} | null;
		decayMode: DecayMode;
		pickers: {
			campaigns: Picker[];
			automations: Picker[];
			lists: (Picker & { kind: string })[];
			stages: Picker[];
			keys: Picker[];
			companies: Picker[];
			topics: { id: number; label: string }[];
			tags: string[];
			groups: (Picker & { kind: string })[];
			forms?: (Picker & { questions: AnswerQuestion[] })[];
		};
		presetForm?: number | null;
		onsaved?: () => void;
	} = $props();

	// The form keeps its own state from the rule it opened with.
	const r0 = untrack(() => rule);

	function initialRules(): SegmentRules {
		try {
			const v = r0?.rules ? JSON.parse(r0.rules) : null;
			if (v && Array.isArray(v.rules)) return { match: v.match === 'any' ? 'any' : 'all', rules: v.rules };
		} catch {
			/* fall through */
		}
		return { match: 'all', rules: [] };
	}

	const preset = untrack(() => (r0 ? null : presetForm));
	const f0: RuleFilter = r0 ? parseFilter(r0.filter) : preset ? { form_id: preset } : {};
	let kind = $state<'event' | 'condition'>(r0?.kind ?? 'event');
	let eventType = $state(r0?.event_type ?? (preset ? 'crm_form_submit' : 'email_click'));
	let label = $state(r0?.label ?? '');
	let points = $state(r0 ? String(r0.points) : '');
	let expires = $state(r0?.expires_days != null ? String(r0.expires_days) : '');
	let maxPerDay = $state(r0?.max_per_day != null ? String(r0.max_per_day) : '');
	let once = $state(!!r0?.once);
	let active = $state(r0 ? !!r0.active : true);
	let anyBounce = $state(!!f0.any);
	let filter = $state<Record<string, string>>({
		campaign_id: f0.campaign_id ? String(f0.campaign_id) : '',
		automation_id: f0.automation_id ? String(f0.automation_id) : '',
		url_contains: f0.url_contains ?? '',
		key_id: f0.key_id ? String(f0.key_id) : '',
		name: f0.name ?? '',
		stage_id: f0.stage_id ? String(f0.stage_id) : '',
		pipeline_id: f0.pipeline_id ? String(f0.pipeline_id) : '',
		list_id: f0.list_id ? String(f0.list_id) : '',
		form_id: f0.form_id ? String(f0.form_id) : ''
	});
	let rules = $state<SegmentRules>(initialRules());

	// #621: answer conditions. Values are kept as text (a list for "is one of").
	type AnswerRow = { field: string; op: FormRuleOp; value: string; values: string[] };
	let answerMatch = $state<'all' | 'any'>(f0.answers?.match === 'any' ? 'any' : 'all');
	let answerRows = $state<AnswerRow[]>(
		(f0.answers?.rules ?? []).map((r) => ({
			field: r.field,
			op: r.op,
			value: Array.isArray(r.value) ? '' : String(r.value ?? ''),
			values: Array.isArray(r.value) ? r.value.map(String) : r.op === 'in' ? String(r.value ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []
		}))
	);
	const formPick = $derived((pickers.forms ?? []).find((f) => String(f.id) === filter.form_id) ?? null);
	const questions = $derived(formPick?.questions ?? []);
	const questionOf = (key: string) => questions.find((q) => q.key === key);

	function addAnswerRow() {
		const q = questions[0];
		if (!q) return;
		answerRows = [...answerRows, { field: q.key, op: answerOpsFor(q.type)[0], value: '', values: [] }];
	}
	function setQuestion(i: number, key: string) {
		const q = questionOf(key);
		const ops = answerOpsFor(q?.type ?? '');
		const row = answerRows[i];
		answerRows[i] = { field: key, op: ops.includes(row.op) ? row.op : ops[0], value: '', values: [] };
	}

	const answersValue = $derived(
		formPick && answerRows.length
			? {
					match: answerMatch,
					rules: answerRows.map((r) =>
						UNARY_OPS.includes(r.op)
							? { field: r.field, op: r.op }
							: { field: r.field, op: r.op, value: r.op === 'in' ? r.values : r.value }
					)
				}
			: ''
	);

	const def = $derived(eventTypeDef(eventType));
	const filterJson = $derived(
		JSON.stringify(
			Object.fromEntries(
				(def?.filters ?? [])
					.map((k) => [k, k === 'any' ? anyBounce : k === 'answers' ? answersValue : (filter[k] ?? '')])
					.filter(([, v]) => v !== '' && v !== false)
			)
		)
	);
	const idPrefix = $derived(`rule-${rule?.id ?? 'new'}`);

	const OPTIONS: Record<string, Picker[]> = $derived({
		campaign_id: pickers.campaigns,
		automation_id: pickers.automations,
		key_id: pickers.keys,
		stage_id: pickers.stages,
		list_id: pickers.lists.map((l) => ({ id: l.id, name: `${l.name} (${l.kind})` })),
		form_id: (pickers.forms ?? []).map((f) => ({ id: f.id, name: f.name }))
	});
</script>

<form
	method="POST"
	action="?/saveRule"
	class="rule-form"
	use:enhance={() =>
		async ({ update, result }) => {
			await update({ reset: !rule });
			if (result.type === 'success') onsaved?.();
		}}
>
	{#if rule}<input type="hidden" name="rule_id" value={rule.id} />{/if}
	<input type="hidden" name="kind" value={kind} />

	{#if !rule}
		<fieldset class="kind">
			<legend class="muted">Kind</legend>
			<label><input type="radio" bind:group={kind} value="event" /> Event — points each time something happens</label>
			<label><input type="radio" bind:group={kind} value="condition" /> Condition — points while the contact matches</label>
		</fieldset>
	{/if}

	<label class="field">
		<span class="muted">Label (optional)</span>
		<input type="text" name="label" bind:value={label} maxlength={SCORE_LIMITS.labelMax} placeholder={kind === 'event' ? (def?.label ?? '') : 'Matches a condition'} />
	</label>

	{#if kind === 'event'}
		<label class="field">
			<span class="muted">Event</span>
			<select name="event_type" bind:value={eventType}>
				{#each EVENT_TYPES as e (e.type)}<option value={e.type}>{e.label}</option>{/each}
			</select>
		</label>
		<input type="hidden" name="filter" value={filterJson} />
		{#each def?.filters ?? [] as key (key)}
			{#if key === 'any'}
				<label class="check"><input type="checkbox" bind:checked={anyBounce} /> {FILTER_LABELS.any}</label>
			{:else if key === 'url_contains' || key === 'name'}
				<label class="field">
					<span class="muted">{FILTER_LABELS[key]} (optional)</span>
					<input type="text" bind:value={filter[key]} maxlength={SCORE_LIMITS.filterTextMax} />
				</label>
			{:else if key === 'pipeline_id'}
				<!-- One pipeline today: nothing to pick. -->
			{:else if key === 'answers'}
				{#if formPick}
					<fieldset class="answers">
						<legend class="muted">Answer conditions (optional)</legend>
						{#if answerRows.length > 1}
							<label class="check">
								Match
								<select bind:value={answerMatch} aria-label="Match all or any answer condition">
									<option value="all">all of these</option>
									<option value="any">any of these</option>
								</select>
							</label>
						{/if}
						{#each answerRows as row, i (i)}
							{@const q = questionOf(row.field)}
							<div class="answer-row">
								<select value={row.field} onchange={(e) => setQuestion(i, e.currentTarget.value)} aria-label={`Condition ${i + 1} question`}>
									{#if !q}<option value={row.field}>{row.field} (question removed)</option>{/if}
									{#each questions as qq (qq.key)}<option value={qq.key}>{qq.label}</option>{/each}
								</select>
								<select bind:value={row.op} aria-label={`Condition ${i + 1} comparison`}>
									{#each answerOpsFor(q?.type ?? '') as op (op)}<option value={op}>{RULE_OP_LABELS[op]}</option>{/each}
								</select>
								{#if !UNARY_OPS.includes(row.op)}
									{#if q?.options.length && row.op === 'in'}
										<select multiple bind:value={row.values} aria-label={`Condition ${i + 1} values`}>
											{#each q.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
										</select>
									{:else if q?.options.length}
										<select bind:value={row.value} aria-label={`Condition ${i + 1} value`}>
											<option value="">Pick one</option>
											{#each q.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
										</select>
									{:else if q?.type === 'number' || q?.type === 'rating'}
										<input type="number" bind:value={row.value} step="any" aria-label={`Condition ${i + 1} value`} />
									{:else}
										<input type="text" bind:value={row.value} maxlength="200" aria-label={`Condition ${i + 1} value`} />
									{/if}
								{/if}
								<button type="button" class="secondary sm" onclick={() => (answerRows = answerRows.filter((_, j) => j !== i))}>Remove</button>
							</div>
						{/each}
						{#if answerRows.length < SCORE_LIMITS.maxAnswerRules && questions.length}
							<button type="button" class="secondary sm" onclick={addAnswerRow}>Add answer condition</button>
						{/if}
						{#if !questions.length}<p class="muted hint">This form has no questions yet.</p>{/if}
					</fieldset>
				{:else}
					<p class="muted hint">Pick one form to add conditions on its answers.</p>
				{/if}
			{:else}
				<label class="field">
					<span class="muted">{FILTER_LABELS[key]} (optional)</span>
					<select bind:value={filter[key]}>
						<option value="">Any</option>
						{#each OPTIONS[key] ?? [] as o (o.id)}<option value={String(o.id)}>{o.name}</option>{/each}
					</select>
				</label>
			{/if}
		{/each}
	{:else}
		<div class="cond">
			<RuleBuilder
				bind:rules
				companies={pickers.companies}
				stages={pickers.stages}
				topics={pickers.topics}
				tags={pickers.tags}
				groups={pickers.groups}
				forms={pickers.forms ?? []}
			/>
			<input type="hidden" name="rules" value={JSON.stringify(rules)} />
		</div>
	{/if}

	<div class="row">
		<label class="field small">
			<span class="muted">Points</span>
			<input type="number" name="points" bind:value={points} min={SCORE_LIMITS.minPoints} max={SCORE_LIMITS.maxPoints} step="1" required />
		</label>
		{#if kind === 'event'}
			{#if decayMode === 'expire'}
				<label class="field small">
					<span class="muted">Expire after (days)</span>
					<input type="number" name="expires_days" bind:value={expires} min={SCORE_LIMITS.minExpiryDays} max={SCORE_LIMITS.maxExpiryDays} placeholder="never" />
				</label>
			{/if}
			<label class="field small">
				<span class="muted">Max per day</span>
				<input type="number" name="max_per_day" bind:value={maxPerDay} min="1" max={SCORE_LIMITS.maxPerDay} placeholder="no limit" />
			</label>
			<label class="check"><input type="checkbox" name="once" bind:checked={once} /> Only the first time</label>
		{/if}
		<label class="check"><input type="checkbox" name="active" bind:checked={active} /> Active</label>
	</div>
	<p class="muted hint" id={`${idPrefix}-hint`}>
		Negative points count against the score. {kind === 'condition' ? 'Contacts are re-checked when you save and once a day.' : 'Applies to new activity; Rebuild replays the last 365 days.'}
	</p>
	<button type="submit" class="sm">{rule ? 'Save rule' : 'Add rule'}</button>
</form>

<style>
	.rule-form { display: flex; flex-direction: column; gap: var(--space-xs); margin-top: var(--space-xs); }
	.kind { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); }
	.kind legend { padding: 0; margin-bottom: var(--space-xxs); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); max-width: 420px; }
	.field.small { max-width: 160px; }
	.row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-s); }
	.check { display: inline-flex; align-items: center; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); }
	.answers { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); }
	.answers legend { padding: 0; margin-bottom: var(--space-xxs); }
	.answer-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	.answer-row input { width: 10em; }
	.hint { margin: 0; font-size: var(--size-xs); line-height: var(--line-xs); }
	button.sm { align-self: flex-start; padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
</style>

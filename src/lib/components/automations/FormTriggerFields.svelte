<script lang="ts">
	// #516: the trigger drawer's fields for "Form submitted". Posted as one hidden
	// `trigger_config` JSON (the write layer validates it): the form (or any form) and an
	// optional answer filter — a `FormRuleSet` from `$lib/form-logic`, edited with a minimal rule
	// editor of the same shape (question · comparison · value).
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import { RULE_OPS, RULE_OP_LABELS, UNARY_OPS, type FormRule, type FormRuleOp } from '$lib/form-logic';
	import { FORM_ENROLL_OFF_NOTE, type FormTriggerConfig } from '$lib/form-trigger';

	type PickerForm = { id: number; name: string; status: string; enroll: boolean; questions: { key: string; label: string }[] };

	let { config, forms }: { config: FormTriggerConfig; forms: PickerForm[] } = $props();

	// The drawer mounts this fresh each time it opens, so the saved config is the start state.
	const start = untrack(() => $state.snapshot(config)) as FormTriggerConfig;
	let formId = $state<number | ''>(start.form_id ?? '');
	let match = $state<'all' | 'any'>(start.filter?.match ?? 'all');
	let rules = $state<FormRule[]>(start.filter?.rules.map((r) => ({ ...r, value: Array.isArray(r.value) ? r.value.join(', ') : r.value })) ?? []);

	const chosen = $derived(formId === '' ? null : (forms.find((f) => f.id === formId) ?? null));
	// "Any form": questions by key across every form (the filter reads each form's answers by key).
	const questions = $derived.by(() => {
		if (chosen) return chosen.questions;
		const seen = new Map<string, string>();
		for (const f of forms) for (const q of f.questions) if (!seen.has(q.key)) seen.set(q.key, q.label);
		return [...seen].map(([key, label]) => ({ key, label }));
	});
	const json = $derived(
		JSON.stringify({
			form_id: formId === '' ? null : formId,
			filter: rules.length ? { match, rules: rules.map((r) => (UNARY_OPS.includes(r.op) ? { field: r.field, op: r.op } : r)) } : null
		})
	);
	const formOptions = $derived(forms.map((f) => ({ value: f.id, label: f.status === 'archived' ? `${f.name} (archived)` : f.name })));
	const enrollOff = $derived(chosen ? !chosen.enroll : forms.length > 0 && forms.every((f) => !f.enroll));

	function addRule() {
		rules = [...rules, { field: questions[0]?.key ?? '', op: 'eq', value: '' }];
	}
	function patch(i: number, p: Partial<FormRule>) {
		rules = rules.map((r, j) => (j === i ? { ...r, ...p } : r));
	}
</script>

<input type="hidden" name="trigger_config" value={json} />

<div class="field">
	<span>Form</span>
	<SearchSelect
		bind:value={() => formId, (v) => (formId = v === '' ? '' : Number(v))}
		options={formOptions}
		allowEmpty={{ label: 'Any form' }}
		ariaLabel="Form"
	/>
</div>
{#if !forms.length}<p class="hint muted">No forms yet — create one under Creative → Forms.</p>{/if}
{#if enrollOff}<p class="notice warn" role="status">{FORM_ENROLL_OFF_NOTE}</p>{/if}

<fieldset class="field">
	<legend>Only when the answers match <span class="muted">(optional)</span></legend>
	{#if rules.length > 1}
		<label class="row">
			Match
			<select bind:value={match} aria-label="Match">
				<option value="all">all</option>
				<option value="any">any</option>
			</select>
			of these
		</label>
	{/if}
	{#each rules as r, i (i)}
		<div class="row">
			<select value={r.field} onchange={(e) => patch(i, { field: (e.target as HTMLSelectElement).value })} aria-label="Question">
				{#if !questions.some((q) => q.key === r.field)}<option value={r.field}>{r.field || 'Choose a question…'}</option>{/if}
				{#each questions as q (q.key)}<option value={q.key}>{q.label}</option>{/each}
			</select>
			<select value={r.op} onchange={(e) => patch(i, { op: (e.target as HTMLSelectElement).value as FormRuleOp })} aria-label="Comparison">
				{#each RULE_OPS as op (op)}<option value={op}>{RULE_OP_LABELS[op]}</option>{/each}
			</select>
			{#if !UNARY_OPS.includes(r.op)}
				<input value={String(r.value ?? '')} placeholder={r.op === 'in' ? 'a, b, c' : 'answer'} aria-label="Value" oninput={(e) => patch(i, { value: (e.target as HTMLInputElement).value })} />
			{/if}
			<button type="button" class="x" aria-label="Remove condition" title="Remove condition" onclick={() => (rules = rules.filter((_, j) => j !== i))}>
				<Icon name="close" size={16} />
			</button>
		</div>
	{/each}
	<button type="button" class="secondary sm" onclick={addRule} disabled={!questions.length}><Icon name="add" size={16} /> Add answer condition</button>
</fieldset>

<p class="hint muted">
	Fires after the contact is saved, for forms with “Enrol in automations” on. Anonymous submissions never enrol; someone
	who has to confirm first (double opt-in) enrols when they confirm. The re-entry setting below still applies.
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
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	.x {
		padding: var(--space-xxs) var(--space-xs);
		background: var(--color-none);
		color: var(--error);
		box-shadow: none;
	}
</style>

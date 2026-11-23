<script lang="ts">
	// #514: one rule set (match all / any + rows of field · op · value) in the Logic tab — the
	// RuleBuilder look. The field picker offers the form's own questions (`candidates`, already
	// limited to the ones a rule may read) and, for outcome rules, a "Known contact" group (has
	// tag, in list, a custom field). The op list and the value input follow the picked field:
	// options for a choice question, a number for number / rating, nothing for a unary op.
	import type { FieldOption } from '$lib/custom-fields';
	import type { FormField, SpecProblem } from '$lib/forms';
	import {
		CONTACT_LIST_FIELD,
		CONTACT_META_PREFIX,
		CONTACT_TAG_FIELD,
		MAX_RULES,
		UNARY_OPS,
		opLabel,
		opsForKind,
		ruleFieldKind,
		type FormRule,
		type FormRuleOp,
		type FormRuleSet
	} from '$lib/form-logic';

	let {
		value = $bindable(),
		candidates,
		contact = false,
		tags = [],
		lists = [],
		customFields = [],
		readonly = false,
		problems = [],
		path = '',
		label = 'Conditions',
		onchange
	}: {
		value: FormRuleSet | null;
		/** Called with the new rule set (for callers that don't bind `value`). */
		onchange?: (v: FormRuleSet | null) => void;
		/** Questions a rule here may read. */
		candidates: FormField[];
		/** Offer the "Known contact" fields (outcome rules only). */
		contact?: boolean;
		tags?: string[];
		lists?: { id: number; name: string }[];
		customFields?: FieldOption[];
		readonly?: boolean;
		/** Every save problem; the ones under `path` show here. */
		problems?: SpecProblem[];
		/** e.g. `fields[3].show_when`. */
		path?: string;
		label?: string;
	} = $props();

	const uid = $props.id();
	const rules = $derived(value?.rules ?? []);
	const mine = $derived(path ? problems.filter((p) => p.path === path || p.path.startsWith(`${path}.`)) : []);

	const question = (field: string) => candidates.find((f) => f.key === field) ?? null;
	const kindOf = (field: string) => ruleFieldKind(field, question(field));

	function set(next: FormRule[], match = value?.match ?? 'all') {
		const v: FormRuleSet | null = next.length ? { match, rules: next } : null;
		if (onchange) onchange(v);
		else value = v;
	}
	function firstField(): string {
		return candidates[0]?.key ?? (contact ? CONTACT_TAG_FIELD : '');
	}
	function addRule() {
		const field = firstField();
		if (!field) return;
		const op = opsForKind(kindOf(field))[0];
		set([...rules, UNARY_OPS.includes(op) ? { field, op } : { field, op, value: '' }]);
	}
	function update(i: number, patch: Partial<FormRule>) {
		set(rules.map((r, j) => {
			if (j !== i) return r;
			const next = { ...r, ...patch };
			if (UNARY_OPS.includes(next.op)) delete next.value;
			else if (next.value === undefined) next.value = '';
			return next;
		}));
	}
	function pickField(i: number, field: string) {
		const op = opsForKind(kindOf(field))[0];
		update(i, { field, op, value: UNARY_OPS.includes(op) ? undefined : '' });
	}
	function pickOp(i: number, op: FormRuleOp) {
		const r = rules[i];
		// `in` takes a list; the others one value.
		let v: FormRule['value'] = r.value;
		if (op === 'in' && !Array.isArray(v)) v = v === undefined || v === '' ? [] : [String(v)];
		if (op !== 'in' && Array.isArray(v)) v = v[0] ?? '';
		update(i, { op, value: v });
	}
	function remove(i: number) {
		set(rules.filter((_, j) => j !== i));
	}
	function toggleIn(i: number, opt: string, on: boolean) {
		const cur = Array.isArray(rules[i].value) ? (rules[i].value as string[]) : [];
		update(i, { value: on ? [...cur.filter((x) => x !== opt), opt] : cur.filter((x) => x !== opt) });
	}
	const optionsOf = (field: string) => question(field)?.options ?? [];
	const rowProblems = (i: number) => mine.filter((p) => p.path.startsWith(`${path}.rules[${i}]`)).map((p) => p.message);
</script>

<div class="fre" role="group" aria-label={label}>
	{#if rules.length > 1}
		<label class="match">
			Match
			<select value={value?.match ?? 'all'} disabled={readonly} onchange={(e) => set(rules, e.currentTarget.value === 'any' ? 'any' : 'all')}>
				<option value="all">all of these</option>
				<option value="any">any of these</option>
			</select>
		</label>
	{/if}
	{#each rules as r, i (i)}
		{@const kind = kindOf(r.field)}
		<div class="row">
			<label class="f">
				<span class="sr">Field</span>
				<select value={r.field} disabled={readonly} onchange={(e) => pickField(i, e.currentTarget.value)}>
					{#if !question(r.field) && !r.field.startsWith('contact')}<option value={r.field}>{r.field || 'Pick a question'}</option>{/if}
					{#if candidates.length}
						<optgroup label="Answers">
							{#each candidates as f (f.id)}<option value={f.key}>{f.label || f.key}</option>{/each}
						</optgroup>
					{/if}
					{#if contact}
						<optgroup label="Known contact">
							<option value={CONTACT_TAG_FIELD}>Contact tag</option>
							<option value={CONTACT_LIST_FIELD}>Contact list</option>
							{#each customFields as cf (cf.key)}<option value="{CONTACT_META_PREFIX}{cf.key}">Contact field: {cf.label}</option>{/each}
							{#if r.field.startsWith(CONTACT_META_PREFIX) && !customFields.some((cf) => `${CONTACT_META_PREFIX}${cf.key}` === r.field)}
								<option value={r.field}>Contact field: {r.field.slice(CONTACT_META_PREFIX.length)}</option>
							{/if}
						</optgroup>
					{/if}
				</select>
			</label>
			<label class="o">
				<span class="sr">Comparison</span>
				<select value={r.op} disabled={readonly} onchange={(e) => pickOp(i, e.currentTarget.value as FormRuleOp)}>
					{#each opsForKind(kind) as op (op)}<option value={op}>{opLabel(op, kind)}</option>{/each}
					{#if !opsForKind(kind).includes(r.op)}<option value={r.op}>{opLabel(r.op, kind)}</option>{/if}
				</select>
			</label>
			{#if !UNARY_OPS.includes(r.op)}
				<span class="v">
					{#if (kind === 'choice' || kind === 'multi') && r.op === 'in'}
						<span class="ins" role="group" aria-label="Values">
							{#each optionsOf(r.field) as o (o.value)}
								<label class="tick"><input type="checkbox" disabled={readonly} checked={Array.isArray(r.value) && r.value.includes(o.value)} onchange={(e) => toggleIn(i, o.value, e.currentTarget.checked)} /> {o.label || o.value}</label>
							{/each}
						</span>
					{:else if kind === 'choice' || kind === 'multi'}
						<label><span class="sr">Value</span>
							<select value={String(r.value ?? '')} disabled={readonly} onchange={(e) => update(i, { value: e.currentTarget.value })}>
								<option value="">Choose…</option>
								{#each optionsOf(r.field) as o (o.value)}<option value={o.value}>{o.label || o.value}</option>{/each}
							</select>
						</label>
					{:else if kind === 'list'}
						<label><span class="sr">List</span>
							<select value={String(r.value ?? '')} disabled={readonly} onchange={(e) => update(i, { value: e.currentTarget.value })}>
								<option value="">Choose a list…</option>
								{#each lists as l (l.id)}<option value={String(l.id)}>{l.name}</option>{/each}
							</select>
						</label>
					{:else if kind === 'number'}
						<label><span class="sr">Value</span>
							<input type="number" value={String(r.value ?? '')} disabled={readonly} oninput={(e) => update(i, { value: e.currentTarget.value })} />
						</label>
					{:else}
						<label><span class="sr">Value</span>
							<input
								value={String(r.value ?? '')}
								disabled={readonly}
								maxlength="200"
								list={kind === 'tag' ? `${uid}-tags` : undefined}
								placeholder={kind === 'tag' ? 'Tag name' : 'Value'}
								oninput={(e) => update(i, { value: e.currentTarget.value })}
							/>
						</label>
					{/if}
				</span>
			{/if}
			{#if !readonly}<button type="button" class="secondary small" aria-label="Remove condition {i + 1}" onclick={() => remove(i)}>Remove</button>{/if}
		</div>
		{#each rowProblems(i) as m, k (k)}<p class="err">{m}</p>{/each}
	{/each}
	{#each mine.filter((p) => !/\.rules\[\d+\]/.test(p.path)) as p, k (k)}<p class="err">{p.message}</p>{/each}
	{#if !readonly}
		{#if candidates.length || contact}
			<button type="button" class="secondary small add" onclick={addRule} disabled={rules.length >= MAX_RULES}>{rules.length ? 'Add condition' : 'Add a condition'}</button>
		{:else}
			<p class="muted small">No earlier question to depend on.</p>
		{/if}
	{/if}
	{#if contact}<datalist id="{uid}-tags">{#each tags as t (t)}<option value={t}></option>{/each}</datalist>{/if}
</div>

<style>
	.fre { display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
	.match { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); }
	.row { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: flex-start; }
	.row label { display: flex; }
	.f select { max-width: 24ch; }
	.v { display: flex; flex: 1 1 160px; min-width: 0; }
	.v label, .v input, .v select { flex: 1; min-width: 0; }
	.ins { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-s); font-size: var(--size-s); }
	.tick { align-items: center; gap: var(--space-xxs); }
	.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); }
	.add { align-self: flex-start; }
	.err { color: var(--danger); font-size: var(--size-s); margin: 0; }
	p.small { margin: 0; }
</style>

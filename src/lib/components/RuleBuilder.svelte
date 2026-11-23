<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { SegmentRules, SegmentRule } from '$lib/server/segment-query';
	import { BILLING_HIDDEN_LABEL, groupMetrics, isBillingMetric, opsFor, visibleMetrics, type MetricGroup } from '$lib/company-metrics';
	import { TIERS, TIER_LABELS } from '$lib/engagement-view';
	import { AUTOMATION_RULE_OPS, formAnswerOp, formAnswerRef, isDeletedListRule, ruleKindGroups } from '$lib/condition-rules';
	import { UNARY_OPS as FORM_UNARY_OPS } from '$lib/form-logic';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import { groupOptionsFromLists } from '$lib/search-select';
	import { NO_VALUE, YES_VALUE, type FieldOption } from '$lib/custom-fields';

	// Dynamic-segment rule builder (#66). Parent binds `rules`; serialize to a hidden
	// input for form submit. No value interpolation reaches SQL — the server compiler binds.
	// `companies` feeds the "Company is …" picker (#170); `stages` the pipeline stage picker (#207).
	// `automation` (#221, Condition steps) adds the automation-only kinds — list/segment
	// membership, email address, custom-field text, opened/clicked an email step — and their
	// pickers; `noun` words the match line and the add button ("rule" there). `groups` (#224)
	// feeds the segment builder's "List / group" picker (hand-picked groups, by id).
	// #448: the kind picker is grouped (Subscription, Engagement, Groups, Fields, Company,
	// Pipeline, Contact — `ruleKindGroups`); `topics` feeds the topic preference picker and
	// `tags` (names) turns the tag box into a searchable picker. Id pickers use SearchSelect.
	// #467: `scores` feeds the Scores group (score value / band); without it the group is hidden
	// (score conditions inside a score, reports).
	// #516: `forms` (with their questions) feeds the Forms group — "Submitted form" and, in a
	// Condition step, "Answer to a form question"; without it the group is hidden.
	let {
		rules = $bindable<SegmentRules>({ match: 'all', rules: [] }),
		companies = [],
		stages = [],
		groups = [],
		topics = [],
		tags = null,
		scores = [],
		fields = [],
		forms = null,
		automation = null,
		noun = 'condition',
		metrics = visibleMetrics(false)
	}: {
		rules?: SegmentRules;
		companies?: { id: number; name: string }[];
		stages?: { id: number; name: string }[];
		groups?: { id: number; name: string; kind: string }[];
		topics?: { id: number; label: string }[];
		tags?: string[] | null;
		scores?: { id: number; name: string; bands: string[] }[];
		/** #619: defined custom fields — the custom field rules pick by label (an undefined key can
		 *  still be typed), and a choice / yes-no field offers its values. */
		fields?: FieldOption[];
		forms?: { id: number; name: string; questions: { key: string; label: string; options?: { value: string; label: string }[] }[] }[] | null;
		/** `noStepRules` (#412, entry conditions): leave out the opened / clicked email-step kinds. */
		automation?: { lists: { id: number; name: string; kind: string }[]; emailSteps: { id: number; label: string }[]; noStepRules?: boolean } | null;
		noun?: string;
		/** Company-metric picker. Reports passes a role-filtered list so members are not offered hours;
		 *  other pages pass `visibleMetrics(billing)` (#445). The default leaves the billing group out. */
		metrics?: { key: string; label: string; kind: string; group?: MetricGroup }[];
	} = $props();

	const uid = $props.id();

	const KIND_GROUPS = $derived(
		ruleKindGroups({ automation: !!automation, noStepRules: automation?.noStepRules }).filter(
			(g) => (g.group !== 'Scores' || scores.length > 0) && (g.group !== 'Forms' || forms !== null)
		)
	);

	// Per-field operator menus.
	const OPS: Record<string, { op: string; label: string }[]> = {
		...AUTOMATION_RULE_OPS,
		tag: [{ op: 'has', label: 'contact has' }, { op: 'not', label: 'contact does not have' }],
		field: [
			{ op: 'exists', label: 'exists' },
			{ op: 'missing', label: 'is empty' },
			{ op: 'eq', label: '=' },
			{ op: 'ne', label: '≠' },
			{ op: 'gt', label: '>' },
			{ op: 'gte', label: '≥' },
			{ op: 'lt', label: '<' },
			{ op: 'lte', label: '≤' }
		],
		subscribed: [{ op: 'yes', label: 'is subscribed' }, { op: 'no', label: 'is unsubscribed' }],
		opened: [{ op: 'in', label: 'in the last N days' }, { op: 'not', label: 'NOT in the last N days' }],
		clicked: [{ op: 'in', label: 'in the last N days' }, { op: 'not', label: 'NOT in the last N days' }],
		// #114 engagement
		engagement_tier: [{ op: 'is', label: 'is' }, { op: 'not', label: 'is not' }],
		last_open_within_days: [{ op: 'within', label: 'within the last N days' }, { op: 'not', label: 'NOT within the last N days' }],
		opens_last_90d: [
			{ op: 'gte', label: '≥' },
			{ op: 'gt', label: '>' },
			{ op: 'lte', label: '≤' },
			{ op: 'lt', label: '<' },
			{ op: 'eq', label: '=' }
		],
		never_opened: [{ op: 'yes', label: 'yes (sent ≥ 1, no opens)' }, { op: 'no', label: 'no (has opened)' }],
		// #279 deliverability
		bounced: [
			{ op: 'any', label: 'any bounce' },
			{ op: 'hard', label: 'hard bounce' },
			{ op: 'none', label: 'never bounced' }
		],
		spam_complaint: [{ op: 'yes', label: 'yes' }, { op: 'no', label: 'never' }],
		visited: [{ op: 'in', label: 'path contains' }, { op: 'not', label: 'NOT path contains' }],
		event: [{ op: 'in', label: 'happened' }, { op: 'not', label: 'did NOT happen' }],
		source: [{ op: 'is', label: 'equals' }, { op: 'contains', label: 'contains' }],
		company: [{ op: 'is', label: 'is' }, { op: 'exists', label: 'is set' }],
		company_id: [{ op: 'exists', label: 'is linked' }, { op: 'missing', label: 'is not linked' }, { op: 'is', label: 'is' }],
		// #207: is/not take a stage id; `not` also matches contacts not on the board.
		pipeline_stage: [
			{ op: 'any', label: 'is any stage (on the board)' },
			{ op: 'none', label: 'has no deal (not in the pipeline)' },
			{ op: 'is', label: 'is' },
			{ op: 'not', label: 'is not' }
		],
		created: [{ op: 'within', label: 'within the last N days' }, { op: 'before', label: 'before (YYYY-MM-DD)' }, { op: 'after', label: 'after (YYYY-MM-DD)' }]
	};

	function add() {
		const field = KIND_GROUPS[0]?.kinds[0]?.field ?? 'tag';
		rules = { ...rules, rules: [...rules.rules, { field, op: OPS[field]?.[0]?.op ?? 'has', value: '' }] };
	}
	function removeAt(i: number) {
		rules = { ...rules, rules: rules.rules.filter((_, j) => j !== i) };
	}
	function patch(i: number, p: Partial<SegmentRule>) {
		rules = { ...rules, rules: rules.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) };
	}
	function opsOf(r: SegmentRule): { op: string; label: string }[] {
		return r.field === 'company_metric' ? opsFor(r.value2 ?? '') : (OPS[r.field] ?? []);
	}
	// #516: a form_answer rule's value2 = "<form id>:<answer key>".
	function answerForm(r: SegmentRule): string {
		return String(formAnswerRef(r.value2)?.formId ?? '');
	}
	function answerKey(r: SegmentRule): string {
		return formAnswerRef(r.value2)?.key ?? '';
	}
	function formQuestions(formId: string) {
		return forms?.find((f) => String(f.id) === formId)?.questions ?? [];
	}
	function pickAnswerForm(i: number, formId: string) {
		const q = formQuestions(formId)[0];
		patch(i, { value2: formId && q ? `${formId}:${q.key}` : '', value: '' });
	}
	function pickAnswerKey(i: number, r: SegmentRule, key: string) {
		patch(i, { value2: `${answerForm(r)}:${key}`, value: '' });
	}
	function questionOptions(r: SegmentRule) {
		return formQuestions(answerForm(r)).find((q) => q.key === answerKey(r))?.options ?? [];
	}
	function onFieldChange(i: number, field: string) {
		const value2 =
			field === 'company_metric'
				? (metrics[0]?.key ?? 'hours_30d')
				: field === 'score_value' || field === 'score_band'
					? String(scores[0]?.id ?? '')
					: '';
		patch(i, { field, op: field === 'company_metric' ? opsFor(value2)[0].op : OPS[field][0].op, value: '', value2, invalid: undefined });
	}
	// #445: a billing metric saved by someone who may see billing, viewed by someone who may not —
	// kept as is (read-only), its metric and value not shown.
	function hiddenMetric(r: SegmentRule): boolean {
		return r.field === 'company_metric' && isBillingMetric(r.value2 ?? '') && !metrics.some((m) => m.key === r.value2);
	}
	const metricGroups = $derived(groupMetrics(metrics));
	function onMetricChange(i: number, metric: string) {
		patch(i, { value2: metric, op: opsFor(metric)[0].op });
	}

	// Which inputs a rule needs.
	function needsName(r: SegmentRule) {
		return r.field === 'field' || r.field === 'field_contains';
	}
	// #467: score rules — value2 = the score id; a value rule's `between` stores "lo:hi".
	function scoreBands(r: SegmentRule): string[] {
		return scores.find((s) => String(s.id) === (r.value2 ?? ''))?.bands ?? [];
	}
	function betweenPart(r: SegmentRule, i: 0 | 1): string {
		return (r.value ?? '').split(':')[i] ?? '';
	}
	function setBetween(idx: number, r: SegmentRule, i: 0 | 1, v: string) {
		const parts = [betweenPart(r, 0), betweenPart(r, 1)];
		parts[i] = v;
		patch(idx, { value: parts.join(':') });
	}
	// #619: the defined field a custom-field rule points at, and its fixed values (choice / yes-no).
	const fieldDef = (r: SegmentRule) => fields.find((f) => f.key === (r.value2 ?? ''));
	function fixedValues(r: SegmentRule): { value: string; label: string }[] | null {
		if (r.field !== 'field' || (r.op !== 'eq' && r.op !== 'ne')) return null;
		const d = fieldDef(r);
		if (d?.type === 'choice') return d.options.map((o) => ({ value: o, label: o }));
		if (d?.type === 'yes_no') return [{ value: YES_VALUE, label: 'Yes' }, { value: NO_VALUE, label: 'No' }];
		return null;
	}
	const fieldOptions = $derived(fields.map((f) => ({ value: f.key, label: f.label })));
	/** The defined fields, plus the rule's own key when it has no definition (still shown). */
	function fieldOptionsFor(r: SegmentRule) {
		const k = r.value2 ?? '';
		return !k || fieldDef(r) ? fieldOptions : [...fieldOptions, { value: k, label: `${k} (not defined)` }];
	}
	function needsValue(r: SegmentRule) {
		if (fixedValues(r)) return false; // #619: value picker
		if (r.field === 'subscribed') return false;
		if (r.field === 'score_band') return false; // band picker
		if (r.field === 'score_value' && r.op === 'between') return false; // two inputs
		if (r.field === 'list' || r.field === 'step_opened' || r.field === 'step_clicked' || r.field === 'topic') return false; // pickers
		if (r.field === 'tag' && tags) return false; // tag picker
		if (r.field === 'never_opened' || r.field === 'engagement_tier') return false; // no value / tier picker
		if (r.field === 'bounced' || r.field === 'spam_complaint') return false; // #279: op only
		if (r.field === 'company' && r.op === 'exists') return false;
		if (r.field === 'company_id') return false; // picker (op 'is') or nothing
		if (r.field === 'pipeline_stage') return false; // stage picker (is/not) or nothing
		if (r.field === 'form_submitted') return false; // #516: form picker + window
		if (r.field === 'form_answer') {
			const op = formAnswerOp(r.op);
			return !!op && !FORM_UNARY_OPS.includes(op);
		}

		if (r.field === 'field' && (r.op === 'exists' || r.op === 'missing')) return false;
		return true;
	}
	// visited/event (#153): optional window in days, stored in value2 (blank = any time).
	function needsWindow(r: SegmentRule) {
		return r.field === 'visited' || r.field === 'event';
	}
	function valuePlaceholder(r: SegmentRule) {
		if (r.field === 'opened' || r.field === 'clicked' || r.field === 'created' || r.field === 'last_open_within_days') return 'days';
		if (r.field === 'opens_last_90d') return 'opens';
		if (r.field === 'score_value') return 'points';
		if (r.field === 'company_metric') return opsOf(r)[0]?.op === 'older' ? 'days' : 'number';
		if (r.field === 'tag') return 'tag name';
		if (r.field === 'visited') return 'e.g. /pricing';
		if (r.field === 'event') return 'event name, e.g. booked_call';
		if (r.field === 'source') return 'e.g. ws-form';
		if (r.field === 'company') return 'company name';
		if (r.field === 'email') return 'e.g. @acme.com';
		if (r.field === 'field_contains') return 'text';
		if (r.field === 'form_answer') return r.op === 'in' ? 'a, b, c' : 'answer';
		return 'value';
	}
</script>

<div class="rb">
	<div class="rb-match">
		Match
		<select value={rules.match} onchange={(e) => (rules = { ...rules, match: (e.target as HTMLSelectElement).value === 'any' ? 'any' : 'all' })}>
			<option value="all">all</option>
			<option value="any">any</option>
		</select>
		of these {noun}s:
	</div>

	{#each rules.rules as r, i (i)}
		<div class="rb-row">
			{#if hiddenMetric(r)}
			<span class="rb-hidden" title="Only people who may see billing can view or edit this {noun}.">Company metric: {BILLING_HIDDEN_LABEL}</span>
			{:else}
			<select value={r.field} onchange={(e) => onFieldChange(i, (e.target as HTMLSelectElement).value)}>
				{#each KIND_GROUPS as g (g.group)}
					<optgroup label={g.group}>
						{#each g.kinds as f (f.field)}<option value={f.field}>{f.label}</option>{/each}
					</optgroup>
				{/each}
			</select>
			{#if needsName(r) && fields.length}
				<SearchSelect
					value={r.value2 ?? ''}
					options={fieldOptionsFor(r)}
					placeholder="Choose a field…"
					ariaLabel="Custom field"
					allowCreate
					onpick={(v) => patch(i, { value2: String(v) })}
				/>
			{:else if needsName(r)}
				<input class="rb-name" value={r.value2 ?? ''} placeholder="field name" oninput={(e) => patch(i, { value2: (e.target as HTMLInputElement).value })} />
			{/if}
			{#if r.field === 'company_metric'}
				<select value={r.value2 ?? ''} onchange={(e) => onMetricChange(i, (e.target as HTMLSelectElement).value)} aria-label="Metric">
					{#each metricGroups as g (g.group)}
						<optgroup label={g.label}>{#each g.metrics as m (m.key)}<option value={m.key}>{m.label}</option>{/each}</optgroup>
					{/each}
				</select>
			{/if}
			{#if r.field === 'score_value' || r.field === 'score_band'}
				<select value={r.value2 ?? ''} onchange={(e) => patch(i, { value2: (e.target as HTMLSelectElement).value, ...(r.field === 'score_band' ? { value: '' } : {}) })} aria-label="Score">
					<option value="">Choose a score…</option>
					{#each scores as sc (sc.id)}<option value={String(sc.id)}>{sc.name}</option>{/each}
				</select>
			{/if}
			{#if r.field === 'form_answer'}
				<select value={answerForm(r)} onchange={(e) => pickAnswerForm(i, (e.target as HTMLSelectElement).value)} aria-label="Form">
					<option value="">Choose a form…</option>
					{#each forms ?? [] as f (f.id)}<option value={String(f.id)}>{f.name}</option>{/each}
				</select>
				<select value={answerKey(r)} onchange={(e) => pickAnswerKey(i, r, (e.target as HTMLSelectElement).value)} aria-label="Question">
					<option value="">Choose a question…</option>
					{#each formQuestions(answerForm(r)) as q (q.key)}<option value={q.key}>{q.label}</option>{/each}
				</select>
			{/if}
			<select value={r.op} onchange={(e) => patch(i, { op: (e.target as HTMLSelectElement).value })}>
				{#each opsOf(r) as o (o.op)}<option value={o.op}>{o.label}</option>{/each}
			</select>
			{#if r.field === 'form_submitted'}
				<select value={r.value ?? ''} onchange={(e) => patch(i, { value: (e.target as HTMLSelectElement).value })} aria-label="Form">
					<option value="">any form</option>
					{#each forms ?? [] as f (f.id)}<option value={String(f.id)}>{f.name}</option>{/each}
				</select>
				<span class="rb-in">in last</span>
				<input class="rb-days" type="number" min="1" value={r.value2 ?? ''} placeholder="any" aria-label="Days (blank = any time)" oninput={(e) => patch(i, { value2: (e.target as HTMLInputElement).value })} />
				<span class="rb-in">days</span>
			{/if}
			{#if r.field === 'list'}
				<!-- #228: the group this rule pointed at was deleted; picking another clears the mark. -->
				{#if isDeletedListRule(r)}<span class="rb-deleted" title="The list this rule used was deleted. It is ignored until you pick another list."><Icon name="alert" size={14} /> Deleted list</span>{/if}
				<SearchSelect
					value={isDeletedListRule(r) ? '' : (r.value ?? '')}
					options={groupOptionsFromLists(automation?.lists ?? groups, String)}
					placeholder="Choose a list…"
					ariaLabel="List or segment"
					onpick={(v) => patch(i, { value: String(v), invalid: undefined })}
				/>
			{/if}
			{#if (r.field === 'step_opened' || r.field === 'step_clicked') && automation}
				<select value={r.value ?? ''} onchange={(e) => patch(i, { value: (e.target as HTMLSelectElement).value })} aria-label="Email step">
					<option value="">Choose an email step…</option>
					{#each automation.emailSteps as es (es.id)}<option value={String(es.id)}>{es.label}</option>{/each}
				</select>
			{/if}
			{#if r.field === 'topic'}
				<SearchSelect
					value={r.value ?? ''}
					options={topics.map((t) => ({ value: String(t.id), label: t.label }))}
					placeholder="Choose a topic…"
					ariaLabel="Topic"
					onpick={(v) => patch(i, { value: String(v) })}
				/>
			{/if}
			{#if r.field === 'tag' && tags}
				<SearchSelect
					value={r.value ?? ''}
					options={tags.map((t) => ({ value: t, label: t }))}
					placeholder="Choose a tag…"
					ariaLabel="Tag"
					allowCreate
					onpick={(v) => patch(i, { value: String(v) })}
				/>
			{/if}
			{#if r.field === 'company_id' && r.op === 'is'}
				<SearchSelect
					value={r.value ?? ''}
					options={companies.map((c) => ({ value: String(c.id), label: c.name }))}
					placeholder="Choose a company…"
					ariaLabel="Company"
					onpick={(v) => patch(i, { value: String(v) })}
				/>
			{/if}
			{#if r.field === 'pipeline_stage' && (r.op === 'is' || r.op === 'not')}
				<SearchSelect
					value={r.value ?? ''}
					options={stages.map((st) => ({ value: String(st.id), label: st.name }))}
					placeholder="Choose a stage…"
					ariaLabel="Pipeline stage"
					onpick={(v) => patch(i, { value: String(v) })}
				/>
			{/if}
			{#if r.field === 'engagement_tier'}
				<select value={r.value ?? ''} onchange={(e) => patch(i, { value: (e.target as HTMLSelectElement).value })} aria-label="Tier">
					<option value="">Choose a tier…</option>
					{#each TIERS as t (t)}<option value={t}>{TIER_LABELS[t]}</option>{/each}
				</select>
			{/if}
			{#if r.field === 'score_band'}
				<select value={r.value ?? ''} onchange={(e) => patch(i, { value: (e.target as HTMLSelectElement).value })} aria-label="Band">
					<option value="">Choose a band…</option>
					{#each scoreBands(r) as b (b)}<option value={b}>{b}</option>{/each}
				</select>
			{/if}
			{#if r.field === 'score_value' && r.op === 'between'}
				<input class="rb-days" type="number" value={betweenPart(r, 0)} placeholder="from" aria-label="From" oninput={(e) => setBetween(i, r, 0, (e.target as HTMLInputElement).value)} />
				<span class="rb-in">and</span>
				<input class="rb-days" type="number" value={betweenPart(r, 1)} placeholder="to" aria-label="To" oninput={(e) => setBetween(i, r, 1, (e.target as HTMLInputElement).value)} />
			{/if}
			{#if fixedValues(r)}
				<select value={r.value ?? ''} onchange={(e) => patch(i, { value: (e.target as HTMLSelectElement).value })} aria-label="Value">
					<option value="">Choose…</option>
					{#each fixedValues(r) ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</select>
			{/if}
			{#if needsValue(r)}
				<input
					class="rb-val"
					value={r.value ?? ''}
					placeholder={valuePlaceholder(r)}
					list={r.field === 'form_answer' && questionOptions(r).length ? `${uid}-opts-${i}` : undefined}
					oninput={(e) => patch(i, { value: (e.target as HTMLInputElement).value })}
				/>
				{#if r.field === 'form_answer' && questionOptions(r).length}
					<datalist id="{uid}-opts-{i}">{#each questionOptions(r) as o (o.value)}<option value={o.value}>{o.label}</option>{/each}</datalist>
				{/if}
			{/if}
			{#if needsWindow(r)}
				<span class="rb-in">in last</span>
				<input class="rb-days" type="number" min="1" value={r.value2 ?? ''} placeholder="any" aria-label="Days (blank = any time)" oninput={(e) => patch(i, { value2: (e.target as HTMLInputElement).value })} />
				<span class="rb-in">days</span>
			{/if}
			{/if}
			<button type="button" class="rb-x" title="Remove {noun}" aria-label="Remove {noun}" onclick={() => removeAt(i)}><Icon name="close" size={14} /></button>
		</div>
	{/each}

	<button type="button" class="rb-add" onclick={add}>+ Add {noun}</button>
</div>

<style>
	.rb { display: flex; flex-direction: column; gap: var(--space-xs); }
	.rb-match { font-size: var(--size-s); line-height: var(--line-s); display: flex; align-items: center; gap: var(--space-xs); }
	.rb-row { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; }
	.rb-name, .rb-val { min-width: 8rem; }
	.rb-days { width: 5rem; }
	.rb-hidden { font-size: var(--size-s); line-height: var(--line-s); color: var(--muted); }
	.rb-in { font-size: var(--size-s); line-height: var(--line-s); color: var(--muted); }
	/* Remove = ghost control in the error colour. */
	.rb-x {
		padding: var(--space-xxs) var(--space-xs); background: var(--color-none); color: var(--error);
		box-shadow: none; border-radius: var(--radius-s);
	}
	.rb-x:hover { background: var(--neutral-3-transparent); box-shadow: none; }
	.rb-x:focus-visible { box-shadow: var(--focus-halo); }
	.rb-deleted {
		display: inline-flex; align-items: center; gap: var(--space-xxs); padding: var(--space-xxs) var(--space-xs);
		font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium); color: var(--text); background: var(--warning-transparent);
		box-shadow: inset 0 0 0 var(--border-s) var(--warning); border-radius: var(--radius-full);
	}
	/* Add rule = the theme's outline button. */
	.rb-add {
		align-self: flex-start; padding: var(--space-xxs) var(--space-s); background: var(--color-none);
		color: var(--neutral-10); box-shadow: 0 0 0 var(--border-s) var(--neutral-4); border-radius: var(--radius-s);
	}
	.rb-add:hover { background: var(--neutral-3); box-shadow: 0 0 0 var(--border-s) var(--neutral-4); }
	.rb-add:focus-visible { box-shadow: 0 0 0 var(--border-s) var(--color-1-transparent), var(--focus-halo); }
</style>

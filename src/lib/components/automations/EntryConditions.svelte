<script lang="ts">
	// #412 / #448: the trigger drawer's one Conditions area, for every trigger kind. Two groups:
	// "About this event" (the trigger's own conditions — `event`, e.g. "email is not…", posted by
	// the trigger fields as trigger_config) and "About the contact" (a rule set enroll() checks
	// before enrolling; a manual enroll can tick "ignore contact conditions"). The contact rules
	// are posted as the hidden `entry_rules` JSON ('' = none).
	import { untrack, type Snippet } from 'svelte';
	import RuleBuilder from '$lib/components/RuleBuilder.svelte';
	import type { SegmentRules } from '$lib/server/segment-query';
	import type { ConditionRuleSet } from '$lib/condition-rules';
	import type { CompanyMetricDef } from '$lib/company-metrics';
	import type { FieldOption } from '$lib/custom-fields';

	let {
		initial,
		lists,
		companies = [],
		stages = [],
		metrics = undefined,
		topics = [],
		tags = null,
		scores = [],
		fields = [],
		forms = null,
		event
	}: {
		initial: ConditionRuleSet | null;
		lists: { id: number; name: string; kind: string }[];
		companies?: { id: number; name: string }[];
		stages?: { id: number; name: string }[];
		/** #445: the company-metric picker (`visibleMetrics(billing)`); omitted = no billing group. */
		metrics?: CompanyMetricDef[];
		topics?: { id: number; label: string }[];
		tags?: string[] | null;
		/** #467: the score_value / score_band pickers. */
		scores?: { id: number; name: string; bands: string[] }[];
		/** #619: defined custom fields (pick by label). */
		fields?: FieldOption[];
		/** #516: the "Submitted form" rule's picker. */
		forms?: { id: number; name: string; questions: { key: string; label: string }[] }[] | null;
		event?: Snippet;
	} = $props();

	// The drawer mounts this fresh each time it opens.
	const start = untrack(() => $state.snapshot(initial)) as ConditionRuleSet | null;
	let rules = $state<SegmentRules>((start ?? { match: 'all', rules: [] }) as SegmentRules);
	const json = $derived(rules.rules.length ? JSON.stringify(rules) : '');
</script>

<input type="hidden" name="entry_rules" value={json} />

<fieldset class="conditions">
	<legend>Conditions <span class="muted">(all must hold)</span></legend>
	{#if event}
		<section class="group" aria-labelledby="cond-event-h">
			<h4 id="cond-event-h">About this event</h4>
			{@render event()}
		</section>
	{/if}
	<section class="group" aria-labelledby="cond-contact-h">
		<h4 id="cond-contact-h">About the contact</h4>
		<p class="hint muted">Checked when the trigger fires; a contact who doesn't match isn't enrolled. Manual enrolls can ignore these.</p>
		<RuleBuilder bind:rules noun="condition" {companies} {stages} {metrics} {topics} {tags} {scores} {fields} {forms} automation={{ lists, emailSteps: [], noStepRules: true }} />
	</section>
</fieldset>

<style>
	.conditions {
		border: 0;
		padding: 0;
		margin: var(--space-m) 0 0;
	}
	legend {
		padding: 0;
		margin-bottom: var(--space-xs);
		font-weight: 600;
	}
	.group + .group {
		margin-top: var(--space-s);
	}
	h4 {
		margin: 0 0 var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.hint {
		margin: 0 0 var(--space-xs);
	}
</style>

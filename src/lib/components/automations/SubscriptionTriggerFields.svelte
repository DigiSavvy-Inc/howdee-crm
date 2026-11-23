<script lang="ts">
	// #444: the trigger drawer's fields for "Subscription changes". Posted as one hidden
	// `trigger_config` JSON (the write layer validates it): the events, an optional topic for
	// the topic events and optional unsubscribe sources.
	import { untrack } from 'svelte';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import {
		SUBSCRIPTION_EVENTS,
		SUBSCRIPTION_EVENT_LABELS,
		SUBSCRIPTION_SOURCE_LABELS,
		UNSUBSCRIBE_SOURCES,
		type SubscriptionEvent,
		type SubscriptionSource,
		type SubscriptionTriggerConfig
	} from '$lib/subscription-trigger';

	let {
		config,
		topics
	}: {
		config: SubscriptionTriggerConfig;
		topics: { id: number; name: string }[];
	} = $props();

	// The drawer mounts this fresh each time it opens, so the saved config is the start state.
	const start = untrack(() => $state.snapshot(config)) as SubscriptionTriggerConfig;
	let events = $state<SubscriptionEvent[]>([...start.events]);
	let topicId = $state<number | ''>(start.topic_list_id ?? '');
	let sources = $state<SubscriptionSource[]>([...start.sources]);

	const usesTopic = $derived(events.includes('topic_optout') || events.includes('topic_optin'));
	const json = $derived(
		JSON.stringify({
			events: SUBSCRIPTION_EVENTS.filter((e) => events.includes(e)),
			topic_list_id: usesTopic && topicId !== '' ? Number(topicId) : null,
			sources: events.includes('unsubscribed') ? UNSUBSCRIBE_SOURCES.filter((s) => sources.includes(s)) : []
		})
	);
	const topicOptions = $derived(topics.map((t) => ({ value: t.id, label: t.name })));
</script>

<input type="hidden" name="trigger_config" value={json} />

<fieldset class="field">
	<legend>When a contact…</legend>
	{#each SUBSCRIPTION_EVENTS as ev (ev)}
		<label class="check"><input type="checkbox" bind:group={events} value={ev} /> {SUBSCRIPTION_EVENT_LABELS[ev]}</label>
	{/each}
</fieldset>
{#if !events.length}<p class="notice err" role="alert">Pick at least one change.</p>{/if}

{#if events.includes('unsubscribed')}
	<fieldset class="field">
		<legend>Unsubscribed from <span class="muted">(none ticked = anywhere)</span></legend>
		{#each UNSUBSCRIBE_SOURCES as src (src)}
			<label class="check"><input type="checkbox" bind:group={sources} value={src} /> {SUBSCRIPTION_SOURCE_LABELS[src]}</label>
		{/each}
	</fieldset>
{/if}

{#if usesTopic}
	<div class="field">
		<span>Topic</span>
		<SearchSelect
			bind:value={() => topicId, (v) => (topicId = v === '' ? '' : Number(v))}
			options={topicOptions}
			allowEmpty={{ label: 'Any topic' }}
			ariaLabel="Topic"
		/>
	</div>
{/if}

<p class="hint muted">
	Runs for unsubscribed contacts too, but email steps are skipped for them: reaching one ends their pass. Use tags,
	pipeline moves or other automations here.
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
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}
</style>

<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { canUndo, openLabel, type ActionCard } from '$lib/assistant-actions';

	// One assistant write (#301) in the panel: what changed, a link to the record, and Undo —
	// or, for a bulk change waiting on the user, its scope with Approve / Cancel. The panel
	// does the requests; this only renders and reports clicks.
	let {
		action,
		busy = false,
		error = '',
		onUndo,
		onApprove,
		onCancel
	}: {
		action: ActionCard;
		busy?: boolean;
		error?: string;
		onUndo: (id: number) => void;
		onApprove: (id: number) => void;
		onCancel: (id: number) => void;
	} = $props();

	const STATUS_TEXT: Record<string, string> = {
		pending: 'Waiting for your approval',
		cancelled: 'Cancelled — nothing changed',
		failed: 'Failed',
		undone: 'Undone'
	};
	const one = $derived(action.changes.length === 1 ? action.changes[0] : null);
	const more = $derived(action.scope ? action.scope.count - action.scope.sample.length : 0);
	const show = (v: string | null) => (v === null || v === '' ? '—' : v);
</script>

<div class="aac" class:muted-card={action.status === 'undone' || action.status === 'cancelled'} class:failed={action.status === 'failed'} role="group" aria-label="Assistant change">
	<div class="aac-head">
		<Icon name={action.status === 'failed' ? 'alert' : action.icon} size={16} />
		<span class="aac-summary">{action.summary}</span>
	</div>
	{#if one}
		<div class="aac-change">
			<span class="aac-field">{one.field.replace(/_/g, ' ')}:</span>
			<s class="muted">{show(one.from)}</s>
			<span aria-hidden="true">→</span><span class="sr-only">changed to</span>
			<span>{show(one.to)}</span>
		</div>
	{/if}
	{#if action.status === 'pending' && action.scope}
		{#if action.scope.count > 0}
			<p class="aac-scope">
				{action.scope.count.toLocaleString('en-US')} contact{action.scope.count === 1 ? '' : 's'}{#if action.scope.sample.length}: {action.scope.sample.join(', ')}{#if more > 0} and {more.toLocaleString('en-US')} more{/if}{/if}
			</p>
		{/if}
		<!-- #346: notes without contacts too (an automation's outline before Approve) -->
		{#if action.scope.notes?.length}
			<ul class="aac-notes">{#each action.scope.notes as note}<li>{note}</li>{/each}</ul>
		{/if}
	{/if}
	{#if action.status !== 'pending' && action.notes?.length}
		<ul class="aac-notes">{#each action.notes as note}<li>{note}</li>{/each}</ul>
	{/if}
	{#if action.error}<p class="aac-error">{action.error}</p>{/if}
	{#if error}<p class="aac-error" role="alert">{error}</p>{/if}
	<div class="aac-foot">
		{#if STATUS_TEXT[action.status]}<span class="aac-status muted">{STATUS_TEXT[action.status]}</span>
		{:else if action.noUndo}<span class="aac-status muted">Can’t be undone</span>{/if}
		{#if action.url && action.status !== 'pending' && action.status !== 'cancelled'}
			<a href={action.url} class="aac-link">{openLabel(action)}</a>
		{/if}
		<span class="aac-actions">
			{#if action.status === 'pending'}
				<button type="button" class="secondary" disabled={busy} onclick={() => onCancel(action.id)}>Cancel</button>
				<button type="button" disabled={busy} onclick={() => onApprove(action.id)}>Approve</button>
			{:else if canUndo(action)}
				<button type="button" class="secondary" disabled={busy} onclick={() => onUndo(action.id)}>Undo</button>
			{/if}
		</span>
	</div>
</div>

<style>
	.aac {
		display: flex; flex-direction: column; gap: var(--space-xxs);
		padding: var(--space-xs) var(--space-s); border-radius: var(--radius-s);
		background: var(--surface); box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
		font-size: var(--size-xs); line-height: var(--line-xs);
	}
	.aac.muted-card { background: var(--neutral-2); }
	.aac.failed { box-shadow: 0 0 0 var(--border-s) var(--danger); }
	.aac-head { display: flex; align-items: flex-start; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	.aac-head :global(svg) { flex: none; margin-top: 2px; }
	.aac-summary { font-weight: var(--weight-ui-medium); overflow-wrap: anywhere; }
	.aac-change { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xxs); overflow-wrap: anywhere; }
	.aac-field { color: var(--muted); }
	.aac-scope { margin: 0; overflow-wrap: anywhere; }
	.aac-notes { margin: 0; padding-left: var(--space-m); overflow-wrap: anywhere; }
	.aac-notes li { white-space: pre-wrap; } /* #346: an automation outline is indented with spaces */
	.aac-error { margin: 0; color: var(--danger); }
	.aac-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	.aac-actions { margin-left: auto; display: inline-flex; gap: var(--space-xs); }
	.aac-actions button { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>

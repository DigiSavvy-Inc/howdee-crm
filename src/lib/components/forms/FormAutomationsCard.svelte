<script lang="ts">
	// Form page → Settings tab → Automations (#516): the automations this form starts ("Form
	// submitted" triggers on this form, then those on any form) with their status, and "Create
	// automation" = a new DRAFT with the trigger set to this form (`?/createAutomation`).
	// Activation stays a manual step on the automation page.
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import type { FormAutomationRow } from '$lib/server/form-trigger';

	let { automations, enroll, canCreate = true }: { automations: FormAutomationRow[]; enroll: boolean; canCreate?: boolean } = $props();

	const BADGE: Record<string, string> = { active: 'sent', paused: 'sending', draft: 'draft' };
</script>

<section class="card form-automations" aria-labelledby="form-automations-h">
	<div class="head">
		<h2 id="form-automations-h"><Icon name="automations" size={16} /> Automations</h2>
		{#if canCreate}
			<form method="POST" action="?/createAutomation" use:enhance>
				<button type="submit" class="secondary sm"><Icon name="add" size={16} /> Create automation</button>
			</form>
		{/if}
	</div>
	{#if !enroll}
		<p class="notice warn" role="status">
			“Enrol in automations” is off, so submissions start no automations. Turn it on above to use these.
		</p>
	{/if}
	{#if automations.length}
		<ul>
			{#each automations as a (a.id)}
				<li>
					<a href="/automations/{a.id}">{a.name}</a>
					<span class="badge {BADGE[a.status] ?? 'draft'}">{a.status}</span>
					{#if a.any_form}<span class="muted small">any form</span>{/if}
					{#if a.filtered}<span class="muted small">· answer conditions</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted small">No automation starts from this form yet. “Create automation” makes a draft with the “Form submitted” trigger set to this form.</p>
	{/if}
</section>

<style>
	.form-automations { margin-top: var(--card-gap); }
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); flex-wrap: wrap; }
	h2 { margin: 0; display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); }
	ul { list-style: none; margin: var(--space-s) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	li { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; }
	p { margin: var(--space-s) 0 0; }
	.small { font-size: var(--size-s); line-height: var(--line-s); }
</style>

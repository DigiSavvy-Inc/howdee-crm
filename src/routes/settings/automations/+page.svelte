<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	let { data, form } = $props();

	// #397: the switches start from what is stored; the numbers keep a sensible default.
	let dayOn = $state(untrack(() => data.cap.per_day !== null));
	let weekOn = $state(untrack(() => data.cap.per_week !== null));
</script>

<svelte:head><title>Automation settings</title></svelte:head>

<h1>Automations</h1>
<p class="muted intro">
	Limits that apply to every automation. Broadcasts, 1:1 sends and tests don't count and are never held.
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
		<h2>Frequency cap</h2>
		<p class="muted small">
			Don't send a contact more than this many automation emails. When the next email would go over, the contact
			waits at that email step (the reason shows in the enrollment inspector) until the oldest counted email is old
			enough. Off by default. Emails sent before this setting existed aren't counted.
		</p>
		<div class="caps">
			<label class="check">
				<input type="checkbox" name="per_day_on" value="1" bind:checked={dayOn} />
				At most
				<input name="per_day" type="number" min="1" max={data.max} value={data.cap.per_day ?? 2} disabled={!dayOn} aria-label="Emails per 24 hours" />
				per 24 hours
			</label>
			<label class="check">
				<input type="checkbox" name="per_week_on" value="1" bind:checked={weekOn} />
				At most
				<input name="per_week" type="number" min="1" max={data.max} value={data.cap.per_week ?? 5} disabled={!weekOn} aria-label="Emails per 7 days" />
				per 7 days
			</label>
		</div>
	</section>
	<div class="actions">
		<button type="submit">Save</button>
		{#if form?.saved}<span class="ok" role="status">Saved.</span>{/if}
	</div>
</form>

<style>
	.intro {
		margin: 0 0 var(--space-m);
	}
	.small {
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.caps {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.check {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}
	.check input[type='number'] {
		width: 5rem;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-top: var(--space-s);
	}
</style>

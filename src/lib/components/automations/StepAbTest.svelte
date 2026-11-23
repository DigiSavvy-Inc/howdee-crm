<script lang="ts">
	// #398: subject / content A/B test on an automation email step. Variant A is the step's own
	// email; variant B is a second subject plus an optional preheader and markdown body (blank =
	// same as A). Each pass gets A or B (stable 50/50). Per-variant stats come from the step's
	// sends; the operator picks the winner — B winning becomes the step's email. Lives outside
	// the step drawer's form (its own forms: ?/setVariant, ?/pickWinner).
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { abLeader, type AbStat } from '$lib/automation-ab';

	type AbTest = {
		enabled: boolean;
		subject_a: string;
		subject_b: string;
		preheader_b: string | null;
		body_b: string | null;
		winner: 'a' | 'b' | null;
		decided_at: string | null;
		stats: AbStat[];
	};

	let {
		stepId,
		subject,
		test = null,
		error = null
	}: {
		stepId: number;
		/** The step's saved subject (variant A). */
		subject: string;
		test?: AbTest | null;
		error?: string | null;
	} = $props();

	let editing = $state(false);
	let abSubject = $state('');
	let abPreheader = $state('');
	let abBody = $state('');

	function openEditor() {
		abSubject = test?.enabled ? test.subject_b : '';
		abPreheader = test?.enabled ? (test.preheader_b ?? '') : '';
		abBody = test?.enabled ? (test.body_b ?? '') : '';
		editing = true;
	}

	const leader = $derived(test?.enabled ? abLeader(test.stats) : null);
	const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
	const done: SubmitFunction = () => async ({ result, update }) => {
		await update();
		if (result.type === 'success') editing = false;
	};
</script>

<section class="ab" aria-labelledby="ab-h-{stepId}">
	<h3 id="ab-h-{stepId}">A/B test <span class="muted">(optional)</span></h3>

	{#if test && (test.enabled || test.winner)}
		{#if test.winner && !test.enabled}
			<p class="muted">Variant {test.winner.toUpperCase()} won{test.decided_at ? ` on ${test.decided_at.slice(0, 10)}` : ''}. The step now sends it.</p>
		{:else}
			<p class="muted">Each contact gets A or B (50/50). Pick a winner when you’ve seen enough.</p>
		{/if}
		<table class="ab-stats">
			<thead>
				<tr><th scope="col">Variant</th><th scope="col">Subject</th><th scope="col" class="num">Sent</th><th scope="col" class="num">Opened</th><th scope="col" class="num">Clicked</th></tr>
			</thead>
			<tbody>
				{#each test.stats as st (st.variant)}
					<tr class:lead={leader === st.variant}>
						<th scope="row">{st.variant.toUpperCase()}{#if leader === st.variant}<span class="lead-tag"> leading</span>{/if}</th>
						<td>{st.variant === 'a' ? (test.enabled ? subject : test.subject_a) : test.subject_b}</td>
						<td class="num">{st.sent}</td>
						<td class="num">{pct(st.openRate)}</td>
						<td class="num">{pct(st.clickRate)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="hint muted">Opens include Apple Mail auto-opens; clicks are the better signal.</p>
		{#if test.enabled}
			<div class="actions">
				{#each ['a', 'b'] as w (w)}
					<form
						method="POST"
						action="?/pickWinner"
						use:enhance={done}
						onsubmit={(e) => {
							const msg =
								w === 'b'
									? 'Make variant B the step’s email and end the test? Contacts reaching this step from now on get B.'
									: 'Keep variant A and end the test?';
							if (!confirm(msg)) e.preventDefault();
						}}
					>
						<input type="hidden" name="step_id" value={stepId} />
						<input type="hidden" name="winner" value={w} />
						<button type="submit" class="sm">Pick {w.toUpperCase()} as winner</button>
					</form>
				{/each}
				<button type="button" class="secondary sm" onclick={openEditor}>Edit variant B</button>
				<form method="POST" action="?/setVariant" use:enhance={done}>
					<input type="hidden" name="step_id" value={stepId} />
					<input type="hidden" name="stop" value="1" />
					<button type="submit" class="secondary sm">Stop test</button>
				</form>
			</div>
		{:else}
			<button type="button" class="secondary sm" onclick={openEditor}>Start a new test</button>
		{/if}
	{:else if !editing}
		<p class="muted">Try a second subject (and optionally different content) on half of the contacts.</p>
		<button type="button" class="secondary sm" onclick={openEditor}>Start an A/B test</button>
	{/if}

	{#if editing}
		<form method="POST" action="?/setVariant" use:enhance={done} class="ab-form">
			<input type="hidden" name="step_id" value={stepId} />
			<p class="muted">Variant A: “{subject}” (the step’s saved email).</p>
			<label>Variant B subject <input name="ab_subject" bind:value={abSubject} required maxlength="300" /></label>
			<label>Variant B preview text <span class="muted">(blank = same as A)</span>
				<input name="ab_preheader" bind:value={abPreheader} />
			</label>
			<label>Variant B body, Markdown <span class="muted">(blank = same body as A)</span>
				<textarea name="ab_body_md" rows="6" bind:value={abBody}></textarea>
			</label>
			<div class="actions">
				<button type="submit" class="sm">Save variant B</button>
				<button type="button" class="secondary sm" onclick={() => (editing = false)}>Cancel</button>
			</div>
		</form>
	{/if}
	{#if error}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
	.ab {
		margin-top: var(--space-m);
		padding-top: var(--space-s);
		border-top: var(--border-s) solid var(--border);
	}
	.ab h3 {
		margin: 0 0 var(--space-xs);
	}
	.ab p {
		margin: 0 0 var(--space-xs);
	}
	.ab-stats {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--size-s);
		margin-bottom: var(--space-xs);
	}
	.ab-stats th,
	.ab-stats td {
		text-align: left;
		padding: 4px 6px;
		border-bottom: var(--border-s) solid var(--border);
	}
	.ab-stats .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.lead-tag {
		font-weight: normal;
		font-size: var(--size-s);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		align-items: center;
	}
	.actions form {
		margin: 0;
	}
	.ab-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: var(--space-xs) 0 0;
	}
	.ab-form label {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hint {
		font-size: var(--size-s);
	}
	.err {
		color: var(--danger);
		font-size: var(--size-s);
	}
</style>

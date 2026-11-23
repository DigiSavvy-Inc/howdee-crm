<script lang="ts">
	// #389: "Describe it" — a sentence in, a validated spec into the builder (via `onspec`).
	// Posts ?/describe and handles the result itself, so the page data isn't reloaded and
	// nothing runs until the user clicks Run in the builder.
	import { enhance } from '$app/forms';
	import type { ReportSpec } from '$lib/report-spec';
	import type { NlStatus } from '$lib/server/reports/nl-page';
	import type { NlOutcome } from '$lib/server/reports/nl';

	let {
		status,
		current,
		onspec
	}: { status: NlStatus; current: string; onspec: (spec: ReportSpec, readback: string) => void } = $props();

	let formEl = $state<HTMLFormElement | null>(null);
	let description = $state('');
	let asked = $state('');
	let questions = $state<string[]>([]);
	let answers = $state<string[]>([]);
	let error = $state<string | null>(null);
	let understood = $state<string[]>([]);
	let threadId = $state<number | null>(null);
	let refining = $state(false);
	let busy = $state(false);

	const posted = $derived(
		questions.length
			? `${asked}\n${questions.map((q, i) => `${q} ${answers[i]?.trim() || '(no answer)'}`).join('\n')}`
			: description
	);

	function handle(outcome: NlOutcome) {
		threadId = outcome.threadId ?? threadId;
		error = null;
		understood = [];
		if (outcome.kind === 'spec') {
			questions = [];
			description = '';
			refining = true;
			onspec(outcome.spec, outcome.readback);
		} else if (outcome.kind === 'questions') {
			asked = questions.length ? asked : description;
			questions = outcome.questions;
			answers = outcome.questions.map(() => '');
		} else {
			error = outcome.error;
			understood = outcome.understood;
		}
	}

	function startOver() {
		refining = false;
		threadId = null;
		questions = [];
		description = '';
		error = null;
		understood = [];
	}

	function useExample(text: string) {
		startOver();
		description = text;
		queueMicrotask(() => formEl?.requestSubmit());
	}
</script>

<section class="describe card" aria-labelledby="describe-title">
	<h2 id="describe-title">{refining ? 'Refine this report' : 'Describe it'}</h2>
	{#if !status.available}
		<p class="muted">{status.message}</p>
	{:else}
		<form
			bind:this={formEl}
			method="POST"
			action="?/describe"
			use:enhance={() => {
				busy = true;
				error = null;
				return async ({ result }) => {
					busy = false;
					if (result.type === 'success' && result.data?.describe) handle(result.data.describe as NlOutcome);
					else if (result.type === 'failure') error = String(result.data?.describeError ?? "I couldn't turn that into a report.");
					else if (result.type === 'error') error = "I couldn't turn that into a report.";
				};
			}}
		>
			<input type="hidden" name="description" value={posted} />
			{#if refining}<input type="hidden" name="current_spec" value={current} />{/if}
			{#if threadId}<input type="hidden" name="thread_id" value={String(threadId)} />{/if}
			{#if questions.length}
				<p class="asked">“{asked}”</p>
				{#each questions as question, i (i)}
					<label class="field">{question}
						<input bind:value={answers[i]} maxlength="200" />
					</label>
				{/each}
				<div class="row">
					<button type="submit" disabled={busy}>{busy ? 'Building…' : 'Build report'}</button>
					<button type="button" class="secondary" onclick={() => { questions = []; description = asked; }}>Change the description</button>
				</div>
			{:else}
				<label class="field">
					<span class="sr-only">{refining ? 'What should change?' : 'Describe the report'}</span>
					<textarea
						rows="2"
						maxlength="1000"
						bind:value={description}
						placeholder={refining ? 'Make it last 90 days, add click rate…' : 'Clients who haven’t opened anything in 60 days'}
						onkeydown={(event) => {
							if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								formEl?.requestSubmit();
							}
						}}
					></textarea>
				</label>
				<div class="row">
					<button type="submit" disabled={busy || !description.trim()}>{busy ? 'Building…' : refining ? 'Update report' : 'Build report'}</button>
					{#if refining}<button type="button" class="secondary" onclick={startOver}>Start over</button>{/if}
				</div>
			{/if}
		</form>
		{#if error}
			<div class="err" role="alert">
				<p>{error}</p>
				{#if understood.length}
					<p class="muted">What I did understand:</p>
					<ul>{#each understood as part (part)}<li>{part}</li>{/each}</ul>
				{/if}
			</div>
		{/if}
		{#if !refining && !questions.length}
			<ul class="examples" aria-label="Example reports">
				{#each status.examples as example (example)}
					<li><button type="button" class="chip" disabled={busy} onclick={() => useExample(example)}>{example}</button></li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	.describe {
		margin-top: var(--space-m);
	}
	h2 {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		margin: 0 0 var(--space-xs);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		margin: 0 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.field input,
	.field textarea {
		color: var(--text);
		width: 100%;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.asked {
		margin: 0 0 var(--space-s);
		color: var(--text);
	}
	.muted {
		color: var(--muted);
		margin: 0;
	}
	.err {
		color: var(--error);
		margin-top: var(--space-s);
	}
	.err p {
		margin: 0 0 var(--space-xxs);
	}
	.err ul {
		margin: 0;
		padding-left: var(--space-m);
		color: var(--text);
	}
	.examples {
		list-style: none;
		margin: var(--space-s) 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.chip {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		background: var(--surface-subtle);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: var(--space-xxs) var(--space-s);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>

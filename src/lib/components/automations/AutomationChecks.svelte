<script lang="ts">
	// #398: pre-send checks on every email step (Compose's rules, no audience checks), shown
	// when `activate` stops on a blocking problem (`initial`) or on demand ("Check all
	// emails" → POST /automations/[id]/checks-all). A step's title opens it in the drawer.
	import type { Check } from '$lib/presend-checks';

	type StepReport = {
		step_id: number;
		title: string;
		variant: 'b' | null;
		report: { checks: Check[]; blocks: number; warns: number };
	};
	type Result = { steps: StepReport[]; blocks: number; warns: number };

	let {
		automationId,
		initial = null,
		onopen
	}: {
		automationId: number;
		/** The report `activate` returned when it stopped (only steps with problems). */
		initial?: Result | null;
		onopen?: (stepId: number) => void;
	} = $props();

	let fetched = $state<Result | null>(null);
	let busy = $state<'' | 'checks' | 'links'>('');
	let failed = $state('');
	// A new activation result replaces an earlier manual run.
	$effect(() => {
		void initial;
		fetched = null;
	});
	const result = $derived(fetched ?? initial);

	async function run(links = false) {
		busy = links ? 'links' : 'checks';
		failed = '';
		try {
			const fd = new FormData();
			if (links) fd.set('check_links', '1');
			const res = await fetch(`/automations/${automationId}/checks-all`, { method: 'POST', body: fd });
			if (!res.ok) throw new Error(String(res.status));
			const all = (await res.json()) as Result;
			fetched = {
				...all,
				steps: all.steps.map((s) => ({ ...s, report: { ...s.report, checks: s.report.checks.filter((c) => c.level !== 'pass') } }))
			};
		} catch {
			failed = "Checks couldn't run. Try again.";
		} finally {
			busy = '';
		}
	}

	const problemSteps = $derived(result ? result.steps.filter((s) => s.report.checks.length > 0) : []);
</script>

<section class="auto-checks" aria-labelledby="auto-checks-h">
	<div class="row">
		<h2 id="auto-checks-h">Pre-send checks</h2>
		<button type="button" class="secondary sm" onclick={() => run(false)} disabled={busy !== ''}>
			{busy === 'checks' ? 'Checking…' : 'Check all emails'}
		</button>
		<button type="button" class="secondary sm" onclick={() => run(true)} disabled={busy !== ''}>
			{busy === 'links' ? 'Checking links…' : 'Check links'}
		</button>
		{#if result}
			<span class="summary" role="status">
				{#if result.blocks}<strong class="block">{result.blocks} blocking</strong>{/if}
				{#if result.warns}<span class="warn">{result.warns} warning{result.warns === 1 ? '' : 's'}</span>{/if}
				{#if !result.blocks && !result.warns}<span>All emails pass.</span>{/if}
			</span>
		{/if}
	</div>
	{#if failed}<p class="err" role="alert">{failed}</p>{/if}
	{#if initial && result === initial && initial.blocks}
		<p class="err">
			These emails have blocking problems. Fix them, or click <strong>Activate anyway</strong> to go live as they are.
		</p>
	{/if}
	{#if problemSteps.length}
		<ul class="steps">
			{#each problemSteps as s (`${s.step_id}-${s.variant ?? 'a'}`)}
				<li>
					<button type="button" class="linklike" onclick={() => onopen?.(s.step_id)}>{s.title}</button>
					{#if s.variant === 'b'}<span class="tag">Variant B</span>{/if}
					<ul class="checks">
						{#each s.report.checks as c (c.id)}
							<li class="lvl-{c.level}">
								<span class="lvl">{c.level === 'block' ? 'Block' : 'Warn'}</span>
								{c.title}{#if c.detail}<span class="muted"> — {c.detail}</span>{/if}
								{#if c.items?.length}<span class="muted items">{c.items.join(', ')}</span>{/if}
							</li>
						{/each}
					</ul>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.auto-checks {
		margin: var(--space-s) 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}
	.row h2 {
		margin: 0 var(--space-xs) 0 0;
		font-size: var(--size-m);
	}
	.summary {
		display: inline-flex;
		gap: var(--space-xs);
		font-size: var(--size-s);
	}
	.block {
		color: var(--danger);
	}
	.warn {
		color: var(--warn);
	}
	.steps {
		list-style: none;
		margin: var(--space-xs) 0 0;
		padding: 0;
		display: grid;
		gap: var(--space-xs);
	}
	.checks {
		margin: 2px 0 0;
		padding-left: var(--space-m);
		font-size: var(--size-s);
	}
	.lvl {
		font-weight: var(--weight-ui-heavy);
		margin-right: 4px;
	}
	.lvl-block .lvl {
		color: var(--danger);
	}
	.items {
		display: block;
		overflow-wrap: anywhere;
	}
	.tag {
		font-size: var(--size-s);
		margin-left: var(--space-xs);
		padding: 0 6px;
		border-radius: var(--radius-full);
		border: var(--border-s) solid var(--border);
	}
	.linklike {
		background: none;
		border: 0;
		padding: 0;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		cursor: pointer;
	}
	.err {
		color: var(--danger);
		font-size: var(--size-s);
		margin: var(--space-xs) 0 0;
	}
</style>

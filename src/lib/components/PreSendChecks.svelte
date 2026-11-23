<script lang="ts">
	// #311: the compose pre-send check panel. Runs POST /compose/checks with the current
	// form fields; "Check links" adds the live link check. A block needs the "Send anyway"
	// tick (posted as send_anyway=1 — the send action enforces it server-side too).
	import { CATEGORY_LABELS, type Check, type CheckCategory, type ChecksReport } from '$lib/presend-checks';

	let {
		fields,
		report = $bindable(null),
		sendAnyway = $bindable(false),
		stale = false,
		onran,
		endpoint = '/compose/checks',
		anyway = true,
		emptyText = 'Checks run when you pick a list or switch to Schedule. Nothing is sent until you click Send or Schedule.'
	}: {
		/** The compose fields to check (subject, preheader, body_blocks, template_id, list_id). */
		fields: () => FormData;
		report?: ChecksReport | null;
		sendAnyway?: boolean;
		/** The form changed since the last run. */
		stale?: boolean;
		onran?: () => void;
		/** #396: the automation step drawer posts to its own endpoint (no audience checks). */
		endpoint?: string;
		emptyText?: string;
		/** Offer the "Send anyway" tick on a block (compose only). */
		anyway?: boolean;
	} = $props();

	let busy = $state<'' | 'checks' | 'links'>('');
	let failed = $state('');

	export async function run(links = false) {
		busy = links ? 'links' : 'checks';
		failed = '';
		try {
			const fd = fields();
			if (links) fd.set('check_links', '1');
			const res = await fetch(endpoint, { method: 'POST', body: fd });
			if (!res.ok) throw new Error(String(res.status));
			report = (await res.json()) as ChecksReport;
			if (!report.blocks) sendAnyway = false;
			onran?.();
		} catch {
			failed = "Checks couldn't run. Try again.";
		} finally {
			busy = '';
		}
	}

	const ORDER: CheckCategory[] = ['links', 'images', 'content', 'audience'];
	const LEVEL_RANK = { block: 0, warn: 1, pass: 2 } as const;
	const groups = $derived(
		report
			? ORDER.map((cat) => ({
					cat,
					checks: report!.checks.filter((c) => c.category === cat).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
				})).filter((g) => g.checks.length)
			: []
	);
	const badge = (c: Check) => (c.level === 'block' ? 'failed' : c.level === 'warn' ? 'sending' : 'sent');
	const label = (c: Check) => (c.level === 'block' ? 'Block' : c.level === 'warn' ? 'Warn' : 'Pass');
</script>

<section class="psc" aria-labelledby="psc-title">
	<header class="psc-head">
		<h2 id="psc-title">Pre-send checks</h2>
		{#if report}
			<span class="psc-sum">
				{report.blocks} block{report.blocks === 1 ? '' : 's'} · {report.warns} warning{report.warns === 1 ? '' : 's'} · {report.passes} passed
			</span>
		{/if}
		<span class="psc-actions">
			<button type="button" class="secondary" onclick={() => run(false)} disabled={!!busy}>{busy === 'checks' ? 'Checking…' : 'Run checks'}</button>
			<button type="button" class="secondary" onclick={() => run(true)} disabled={!!busy} title="Visits up to 30 links (5 s each)">
				{busy === 'links' ? 'Checking links…' : 'Check links'}
			</button>
		</span>
	</header>
	{#if failed}<p class="err">{failed}</p>{/if}
	{#if !report}
		<p class="muted psc-empty">{emptyText}</p>
	{:else}
		{#if stale}<p class="muted psc-stale">The email changed since these ran. Run checks again before sending.</p>{/if}
		{#each groups as g (g.cat)}
			<h3>{CATEGORY_LABELS[g.cat]}</h3>
			<ul>
				{#each g.checks as c (c.id)}
					<li class="psc-row">
						<span class="badge {badge(c)}">{label(c)}</span>
						<div class="psc-body">
							<span class="psc-title">{c.title}{#if c.href}&nbsp;<a href={c.href}>{c.href === '/deliverability' ? 'Deliverability' : c.href === '/settings' ? 'Settings' : 'View'}</a>{/if}</span>
							{#if c.detail}<span class="muted psc-detail">{c.detail}</span>{/if}
							{#if c.items?.length}
								<ul class="psc-items">
									{#each c.items as it (it)}<li><code>{it}</code></li>{/each}
								</ul>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/each}
		{#if !report.linksChecked}<p class="muted psc-detail">Links weren't visited. Use Check links to find broken pages.</p>{/if}
		{#if report.blocks && anyway}
			<label class="psc-anyway">
				<input type="checkbox" name="send_anyway" value="1" bind:checked={sendAnyway} />
				Send anyway. I've read the {report.blocks} blocking problem{report.blocks === 1 ? '' : 's'} above.
			</label>
		{/if}
	{/if}
</section>

<style>
	.psc {
		margin-top: var(--space-l);
		padding: var(--space-m);
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--border);
		background: var(--bg);
	}
	.psc-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-s);
	}
	h2 {
		margin: 0;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	h3 {
		margin: var(--space-m) 0 var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.psc-sum {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.psc-actions {
		display: inline-flex;
		gap: var(--space-xs);
		margin-left: auto;
		flex-wrap: wrap;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.psc-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-s);
		padding: var(--space-xs) 0;
	}
	.psc-row .badge {
		flex: 0 0 auto;
		min-width: 3.5rem;
		text-align: center;
	}
	.psc-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		min-width: 0;
	}
	.psc-title {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.psc-detail,
	.psc-empty,
	.psc-stale {
		margin: var(--space-xs) 0 0;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.psc-body .psc-detail {
		margin: 0;
	}
	.psc-items code {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		overflow-wrap: anywhere;
	}
	.psc-anyway {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--space-xs);
		margin-top: var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-medium);
	}
	.err {
		color: var(--danger);
	}
	@media (max-width: 640px) {
		.psc-actions {
			margin-left: 0;
		}
	}
</style>

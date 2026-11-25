<script lang="ts">
	// #311: the compose pre-send check panel. Runs POST /compose/checks with the current
	// form fields; "Check links" adds the live link check (#479: compose runs it on its own,
	// ~3 s after the last edit). A block needs the "Send anyway" tick (posted as
	// send_anyway=1 — the send action enforces it server-side too, admins only).
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
	// #479: "Checked 2 min ago" — refreshed every 30 s.
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	const checkedAgo = $derived.by(() => {
		const at = report?.checkedAt ? Date.parse(report.checkedAt) : NaN;
		if (Number.isNaN(at)) return '';
		const min = Math.floor(Math.max(0, now - at) / 60_000);
		return min < 1 ? 'Checked just now' : `Checked ${min} min ago`;
	});
	type PanelReport = ChecksReport & { canOverride?: boolean; enforcement?: string };
	/** #479: the server says whether this user may override (admins, unless overrides are off). */
	const mayOverride = $derived((report as PanelReport | null)?.canOverride !== false);
	let linksOpen = $state(false);

	let seq = 0;
	export async function run(links = false) {
		const mine = ++seq;
		busy = links ? 'links' : 'checks';
		failed = '';
		try {
			const fd = fields();
			if (links) fd.set('check_links', '1');
			const res = await fetch(endpoint, { method: 'POST', body: fd });
			if (!res.ok) throw new Error(String(res.status));
			const next = (await res.json()) as ChecksReport;
			if (mine !== seq) return; // a newer run started
			report = next;
			now = Date.now();
			if (!report.blocks) sendAnyway = false;
			onran?.();
		} catch {
			if (mine === seq) failed = "Checks couldn't run. Try again.";
		} finally {
			if (mine === seq) busy = '';
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
	/** #479: passing live-link rows fold into one line ("41 links checked, all working"). Links
	 *  that were never checked (a warning) always show. */
	const foldable = (c: Check) => c.id === 'links.live_skipped' && c.level === 'pass' && !!report?.checks.some((x) => x.id === 'links.live');
	/** The http(s) URL an item is about, for its Open button. */
	const itemUrl = (c: Check, it: string, i: number): string | null => {
		const u = c.urls?.[i] ?? it.split(' — ')[0];
		return /^https?:\/\//i.test(u) && it.startsWith(u) ? u : null;
	};
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
			{#if checkedAgo && !busy}<span class="muted psc-ago" aria-live="polite">{checkedAgo}</span>{/if}
			<button type="button" class="secondary" onclick={() => run(false)} disabled={!!busy}>{busy === 'checks' ? 'Checking…' : 'Run checks'}</button>
			<button type="button" class="secondary" onclick={() => run(true)} disabled={!!busy} title="Visits up to 60 links (5 s each, one retry)">
				{busy === 'links' ? 'Checking links…' : report?.linksChecked ? 'Re-check links' : 'Check links'}
			</button>
		</span>
	</header>
	{#if failed}<p class="err">{failed}</p>{/if}
	{#if !report}
		<p class="muted psc-empty">{emptyText}</p>
	{:else}
		{#if stale}<p class="muted psc-stale">The email changed since these ran. They run again in a few seconds.</p>{/if}
		{#each groups as g (g.cat)}
			<h3>{CATEGORY_LABELS[g.cat]}</h3>
			<ul>
				{#each g.checks as c (c.id)}
					{#if !foldable(c) || linksOpen || c.id === 'links.live'}
						<li class="psc-row">
							<span class="badge {badge(c)}">{label(c)}</span>
							<div class="psc-body">
								<span class="psc-title"
									>{c.title}{#if c.href}&nbsp;<a href={c.href}>{c.href === '/deliverability' ? 'Deliverability' : c.href === '/settings' ? 'Settings' : 'View'}</a>{/if}{#if c.id === 'links.live' && g.checks.some(foldable)}&nbsp;<button
											type="button"
											class="linklike"
											aria-expanded={linksOpen}
											onclick={() => (linksOpen = !linksOpen)}>{linksOpen ? 'Hide details' : 'Details'}</button
										>{/if}</span
								>
								{#if c.detail}<span class="muted psc-detail">{c.detail}</span>{/if}
								{#if c.items?.length}
									<ul class="psc-items">
										{#each c.items as it, i (it)}
											{@const u = itemUrl(c, it, i)}
											<li>
												<code>{it}</code>
												{#if u && c.level !== 'pass'}<a class="psc-open" href={u} target="_blank" rel="noopener noreferrer">Open</a>{/if}
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						</li>
					{/if}
				{/each}
			</ul>
		{/each}
		{#if !report.linksChecked}<p class="muted psc-detail">Links weren't visited yet. They're checked on their own; Check links runs it now.</p>{/if}
		{#if report.blocks && anyway}
			{#if mayOverride}
				<label class="psc-anyway">
					<input type="checkbox" name="send_anyway" value="1" bind:checked={sendAnyway} />
					Send anyway. I've read the {report.blocks} blocking problem{report.blocks === 1 ? '' : 's'} above.
				</label>
			{:else}
				<p class="muted psc-detail">Fix the blocking problem{report.blocks === 1 ? '' : 's'} to send. Only an admin can send anyway, when Settings → General → Pre-send checks allows it.</p>
			{/if}
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
	.psc-ago {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		align-self: center;
	}
	.psc-open {
		margin-left: var(--space-xs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	.linklike {
		background: none;
		border: 0;
		padding: 0;
		min-height: 0;
		font: inherit;
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--accent);
		cursor: pointer;
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

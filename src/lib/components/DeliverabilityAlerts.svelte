<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { checkRates, formatRate, type ActiveAlert, type Thresholds } from '$lib/deliverability-alerts';

	// Post-send deliverability alert banner (#305), on the Dashboard and Deliverability. One
	// box per campaign / automation (its newest undismissed warning or critical check). The
	// forms post to /deliverability's actions and come back here (`back`).
	let { alerts, thresholds }: { alerts: ActiveAlert[]; thresholds: Thresholds } = $props();
	const isAdmin = $derived(page.data.user?.role === 'admin');
	const back = $derived(page.url.pathname + page.url.search);

	function checkText(key: string): string {
		if (key === '2h') return '2 hours after sending';
		if (key === '24h') return '24 hours after sending';
		return 'last 7 days';
	}
</script>

{#each alerts as a (a.id)}
	{@const r = checkRates(a)}
	<div class="notice da" class:warn={a.level !== 'critical'} class:err={a.level === 'critical'} role="status">
		<div class="body">
			<p>
				<strong><Icon name="alert" size={16} /> Deliverability {a.level === 'critical' ? 'critical' : 'warning'}:</strong>
				{a.scope === 'campaign' ? 'campaign' : 'automation'}
				<a href={a.href}>{a.title ?? `#${a.ref_id} (deleted)`}</a>
				<span class="muted">({checkText(a.check_key)})</span>
			</p>
			<p>
				Hard bounces <strong>{formatRate(r.hardRate)}</strong>
				<span class="muted">(warning {formatRate(thresholds.hardWarn)}, critical {formatRate(thresholds.hardCrit)})</span> ·
				all bounces {formatRate(r.bounceRate)} ({a.bounces} of {a.sent}) ·
				complaints <strong>{formatRate(r.complaintRate)}</strong>
				<span class="muted">(warning {formatRate(thresholds.complaintWarn)}, critical {formatRate(thresholds.complaintCrit)})</span>
			</p>
			{#if a.reasons.length}
				<p class="muted">Top bounce reasons: {a.reasons.map((x) => `${x.reason} ${x.n}`).join(', ')}</p>
			{/if}
			{#if a.held.length}
				<div class="held">
					<p><strong>Held:</strong> {a.held.length} scheduled send{a.held.length === 1 ? '' : 's'} to the same list, until an admin releases {a.held.length === 1 ? 'it' : 'them'}.</p>
					<ul>
						{#each a.held as h (h.id)}
							<li>
								<a href="/campaign/{h.id}">{h.subject}</a>
								{#if h.scheduled_at}<span class="muted">· {h.scheduled_at} UTC</span>{/if}
								{#if isAdmin}
									<form method="POST" action="/deliverability?/releaseHold" use:enhance class="inline">
										<input type="hidden" name="campaign_id" value={h.id} />
										<input type="hidden" name="back" value={back} />
										<button type="submit" class="secondary small">Release</button>
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			<p class="links">
				<a href={a.bounced_href}>Open bounced contacts →</a>
			</p>
		</div>
		<form method="POST" action="/deliverability?/dismissAlert" use:enhance class="dismiss">
			<input type="hidden" name="id" value={a.id} />
			<input type="hidden" name="back" value={back} />
			<button type="submit" class="secondary small">Dismiss</button>
		</form>
	</div>
{/each}

<style>
	.da {
		display: flex;
		gap: var(--space-m);
		align-items: flex-start;
	}
	.body { flex: 1; min-width: 0; }
	.body p { margin: 0 0 var(--space-xxs); }
	.held ul { margin: 0 0 var(--space-xxs); padding-left: var(--space-m); }
	.held li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	.inline { display: inline; margin: 0; }
	.links { display: flex; flex-wrap: wrap; gap: var(--space-m); }
	.dismiss { margin: 0; flex: none; }
</style>

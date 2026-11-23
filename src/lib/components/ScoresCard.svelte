<script lang="ts">
	import { enhance } from '$app/forms';
	import { relTime } from '$lib/reltime';
	import { SCORE_LIMITS, eventTypeLabel, pointsText, sourceText } from '$lib/scoring';
	import type { ContactScore } from '$lib/server/scoring/contact';

	// Contact page Scores card (#466): one row per active custom score — value, band, last
	// change, the last 20 ledger rows, and (admins) a manual Adjust. Engagement has its own card.
	let {
		scores,
		isAdmin,
		form
	}: {
		scores: ContactScore[];
		isAdmin: boolean;
		form: Record<string, unknown> | null | undefined;
	} = $props();

	function why(h: ContactScore['history'][number]): string {
		if (h.source_type === 'manual') return h.note ? `Adjusted: ${h.note}` : 'Adjusted by hand';
		if (h.rule_label) return h.rule_label;
		if (h.rule_kind === 'event') return eventTypeLabel(h.event_type);
		return sourceText(h.source_type);
	}

	function day(iso: string | null): string {
		return iso ? iso.slice(0, 10) : '';
	}
</script>

<section class="card scores">
	<div class="head">
		<h2>Scores</h2>
		{#if isAdmin}<a class="muted small" href="/settings/scoring">Manage scores</a>{/if}
	</div>
	{#if scores.length === 0}
		<p class="muted note">No active scores.</p>
	{:else}
		<ul>
			{#each scores as s (s.score_id)}
				<li>
					<div class="line">
						<strong class="name" title={s.description}>{s.name}</strong>
						<span class="value">{s.value}</span>
						{#if s.band}<span class="band">{s.band}</span>{/if}
						<span class="muted small">
							{#if s.changed_at}changed {relTime(s.changed_at)}{#if s.prev_value != null}{' '}(was {s.prev_value}){/if}{:else}no points yet{/if}
							{#if s.pending}· updating{/if}
						</span>
					</div>
					{#if s.history.length}
						<details>
							<summary class="small">History</summary>
							<table>
								<thead><tr><th>Points</th><th>Why</th><th>Source</th><th>Earned</th><th>Expires</th></tr></thead>
								<tbody>
									{#each s.history as h (h.id)}
										<tr class:expired={h.expired}>
											<td class="num">{pointsText(h.points)}</td>
											<td>{why(h)}</td>
											<td>
												{#if h.source_type === 'form_submissions' && h.form_id}
													{sourceText(h.source_type)}: <a href={`/forms/${h.form_id}`}>{h.form_name}</a>
												{:else}
													{sourceText(h.source_type)}
												{/if}
											</td>
											<td>{day(h.earned_at)}</td>
											<td>{h.expires_at ? `${h.expired ? 'expired' : 'expires'} ${day(h.expires_at)}` : 'never'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</details>
					{/if}
					{#if isAdmin}
						<details>
							<summary class="small">Adjust</summary>
							<form method="POST" action="?/adjustScore" use:enhance class="adjust">
								<input type="hidden" name="score_id" value={s.score_id} />
								<label>
									<span class="muted">Points (±)</span>
									<input type="number" name="points" min={SCORE_LIMITS.minPoints} max={SCORE_LIMITS.maxPoints} step="1" required style="width: 7em" />
								</label>
								<label>
									<span class="muted">Expires after</span>
									<input type="number" name="expires_days" min={SCORE_LIMITS.minExpiryDays} max={SCORE_LIMITS.maxExpiryDays} placeholder="never" style="width: 7em" />
									<span class="muted">days</span>
								</label>
								<label class="grow">
									<span class="muted">Note</span>
									<input type="text" name="note" maxlength="200" />
								</label>
								<button type="submit" class="btn small">Adjust</button>
							</form>
						</details>
					{/if}
					{#if form?.scoreId === s.score_id && form?.scoreError}<p class="notice err" role="alert">{String(form.scoreError)}</p>{/if}
					{#if form?.scoreId === s.score_id && form?.scoreOk}<p class="notice ok" role="status">Adjusted.</p>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.scores { margin-bottom: var(--space-l); }
	.head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-s); }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	ul { list-style: none; margin: var(--space-s) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); }
	li + li { border-top: 1px solid var(--border); padding-top: var(--space-s); }
	.line { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs); }
	.value { font-variant-numeric: tabular-nums; font-weight: var(--weight-ui-medium); }
	/* A neutral pill: bands are per-score labels, not engagement tiers, so no tier colours. */
	.band {
		display: inline-flex;
		align-items: center;
		padding: var(--space-xxs) var(--space-xs);
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium);
		white-space: nowrap;
		color: var(--text);
		background: var(--neutral-3);
		box-shadow: inset 0 0 0 var(--border-s) var(--border);
	}
	.small, .note { font-size: var(--size-xs); line-height: var(--line-xs); }
	details { margin-top: var(--space-xxs); }
	summary { cursor: pointer; }
	table { width: 100%; border-collapse: collapse; margin-top: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); }
	th, td { text-align: left; padding: var(--space-xxs) var(--space-xs); border-bottom: 1px solid var(--border); }
	td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
	tr.expired td { color: var(--muted); }
	.adjust { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-xs); margin-top: var(--space-xxs); font-size: var(--size-xs); }
	.adjust label { display: flex; align-items: center; gap: var(--space-xxs); }
	.adjust .grow { flex: 1; min-width: 12em; }
	.adjust .grow input { flex: 1; }
</style>

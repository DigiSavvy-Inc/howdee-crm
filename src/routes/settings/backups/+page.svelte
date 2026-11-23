<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	let busy = $state(false);
	let openDate = $state<string | null>(null);

	function size(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
	function when(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
	}
	function seconds(ms: number): string {
		return `${(ms / 1000).toFixed(1)} s`;
	}
	const href = (date: string, file: string) => `/settings/backups/download/${date}/${encodeURIComponent(file)}`;
	const latest = $derived(data.backups[0] ?? null);
</script>

<svelte:head><title>Backups</title></svelte:head>

<h1>Backups</h1>
<p class="muted intro">
	Every night after 03:00 (Settings → Timezone) each table is exported to the R2 bucket as
	gzipped newline-delimited JSON, under <code>backups/&lt;date&gt;/</code>. The newest 14 backups
	and the newest 8 Sunday backups are kept. Secrets are left out — see the manifest's
	<code>excluded</code> list. To restore, see <code>docs/backups.md</code>.
</p>

{#if !data.hasBucket}
	<p class="err">The <code>MEDIA</code> R2 bucket isn't bound to this Worker, so backups can't run.</p>
{:else if data.stale}
	<p class="notice warn stale" role="alert">
		{#if data.lastSuccessAt}
			The last successful backup finished {when(data.lastSuccessAt)} — over 36 hours ago.
		{:else}
			No backup has finished yet.
		{/if}
		{#if data.last && !data.last.ok}Last error: {data.last.error}{/if}
		Check the heartbeat, or run Back up now.
	</p>
{/if}

<section class="card">
	<h2>Last backup</h2>
	{#if data.last?.ok}
		<p>
			<span class="badge sent">Succeeded</span>
			<span class="muted small">{data.last.date} · {data.last.trigger === 'cron' ? 'nightly' : 'manual'} · finished {when(data.last.finished_at)} · {seconds(data.last.duration_ms)}</span>
		</p>
		<p class="small">
			{data.last.total_rows.toLocaleString()} rows · {size(data.last.total_bytes)} compressed{#if data.last.pruned} · {data.last.pruned} old backup{data.last.pruned === 1 ? '' : 's'} pruned{/if}
		</p>
	{:else if data.last}
		<p>
			<span class="badge failed">{data.last.gave_up ? 'Failed' : 'Retrying'}</span>
			<span class="muted small">{data.last.date ?? ''} · {when(data.last.at)}</span>
		</p>
		<p class="err">{data.last.error}</p>
	{:else}
		<p class="muted">No backup has run yet.</p>
	{/if}

	{#if data.run}
		<p class="small">
			<span class="badge sending">Running</span>
			{data.run.date} · {data.run.trigger === 'cron' ? 'nightly' : 'manual'} · {data.run.tablesDone} of {data.run.tablesTotal} tables · the heartbeat continues it every minute.
		</p>
	{/if}

	<form method="POST" action="?/backupNow" use:enhance={() => {
		busy = true;
		return async ({ update }) => {
			await update();
			busy = false;
		};
	}}>
		<button type="submit" disabled={busy || !!data.run || !data.hasBucket}>{busy ? 'Backing up…' : 'Back up now'}</button>
	</form>
	{#if form && 'error' in form}<p class="err">{form.error}</p>{/if}
	{#if form && 'started' in form}
		<p class="small">{form.finished ? 'Backup finished.' : 'Backup started — the heartbeat finishes it over the next minutes.'}</p>
	{/if}

	{#if latest}
		<details class="counts">
			<summary>Row counts ({latest.date})</summary>
			<div class="scroll">
				<table>
					<thead><tr><th>Table</th><th>Rows</th><th>Size</th></tr></thead>
					<tbody>
						{#each Object.entries(latest.tables) as [table, t] (table)}
							<tr><td><code>{table}</code></td><td>{t.rows.toLocaleString()}</td><td>{size(t.bytes)}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{/if}
</section>

<section class="card">
	<h2>Stored backups</h2>
	{#if data.listError}<p class="err">{data.listError}</p>{/if}
	{#if data.backups.length === 0}
		<p class="muted">None yet.</p>
	{:else}
		<div class="scroll">
			<table>
				<thead><tr><th>Date</th><th>Finished</th><th>Rows</th><th>Size</th><th>Schema</th><th>Files</th></tr></thead>
				<tbody>
					{#each data.backups as b (b.date)}
						<tr>
							<td>{b.date}{#if new Date(`${b.date}T12:00:00Z`).getUTCDay() === 0} <span class="muted small">weekly</span>{/if}</td>
							<td>{when(b.finished_at)}</td>
							<td>{b.total_rows.toLocaleString()}</td>
							<td>{size(b.total_bytes)}</td>
							<td><code>{b.schema_version ?? '—'}</code></td>
							<td>
								<a href={href(b.date, 'manifest.json')} download>manifest.json</a>
								·
								<button type="button" class="linkish" aria-expanded={openDate === b.date} onclick={() => (openDate = openDate === b.date ? null : b.date)}>
									{openDate === b.date ? 'Hide tables' : 'Tables'}
								</button>
							</td>
						</tr>
						{#if openDate === b.date}
							<tr>
								<td colspan="6">
									<ul class="files">
										{#each Object.entries(b.tables) as [table, t] (table)}
											{#each t.files as f (f)}
												<li><a href={href(b.date, f)} download>{f}</a> <span class="muted small">{table} · {t.rows.toLocaleString()} rows</span></li>
											{/each}
										{/each}
									</ul>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); }
	section.card p { max-width: 70ch; margin: 0 0 var(--space-s); }
	.stale { max-width: 70ch; }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.counts { margin-top: var(--space-s); }
	.counts summary { cursor: pointer; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.scroll { overflow-x: auto; }
	table { border-collapse: collapse; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); min-width: 100%; }
	th, td { text-align: left; padding: var(--space-xs) var(--space-s); white-space: nowrap; }
	th { color: var(--muted); font-weight: var(--weight-ui-heavy); }
	.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xxs); }
	.linkish { background: none; border: 0; box-shadow: none; padding: 0; min-height: 0; color: inherit; text-decoration: underline; text-decoration-color: var(--accent); cursor: pointer; font: inherit; }
</style>

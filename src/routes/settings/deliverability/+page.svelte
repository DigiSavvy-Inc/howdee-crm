<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatRate, percentInput } from '$lib/deliverability-alerts';
	let { data, form } = $props();

	let busy = $state<string | null>(null);
	const errorFor = (action: string) => (form && 'error' in form && form.action === action ? form.error : null);
	const track = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = null;
		};
	};
	const c = $derived(data.config);
</script>

<svelte:head><title>Deliverability alerts</title></svelte:head>

<h1>Deliverability alerts</h1>
<p class="muted intro">
	Every broadcast is checked 2 hours and 24 hours after it goes out, and every automation once a day over the
	last 7 days. A hard-bounce or complaint rate at or above a threshold shows a banner on the Dashboard and
	Deliverability pages, adds an activity row, and posts to the webhook below when one is set.
</p>

<form method="POST" action="?/save" use:enhance={track('save')}>
	<section class="card">
		<h2>Thresholds</h2>
		<p class="muted small">Percent of the emails sent. Defaults: hard bounces {formatRate(data.defaults.hardWarn)} / {formatRate(data.defaults.hardCrit)}, complaints {formatRate(data.defaults.complaintWarn)} / {formatRate(data.defaults.complaintCrit)}.</p>
		<div class="grid">
			<label class="field"><span>Hard bounces — warning (%)</span>
				<input name="hard_warn" type="number" step="any" min="0" max="100" value={percentInput(c.hardWarn)} required />
			</label>
			<label class="field"><span>Hard bounces — critical (%)</span>
				<input name="hard_crit" type="number" step="any" min="0" max="100" value={percentInput(c.hardCrit)} required />
			</label>
			<label class="field"><span>Complaints — warning (%)</span>
				<input name="complaint_warn" type="number" step="any" min="0" max="100" value={percentInput(c.complaintWarn)} required />
			</label>
			<label class="field"><span>Complaints — critical (%)</span>
				<input name="complaint_crit" type="number" step="any" min="0" max="100" value={percentInput(c.complaintCrit)} required />
			</label>
		</div>
	</section>

	<section class="card">
		<h2>Webhook</h2>
		<p class="muted small">Optional. Posted once per warning or critical check. https only; local and private addresses are refused.</p>
		<div class="row">
			<label class="field grow"><span>URL</span>
				<input name="webhook_url" type="url" value={c.webhookUrl} placeholder="https://hooks.slack.com/services/…" autocomplete="off" spellcheck="false" />
			</label>
			<label class="field"><span>Format</span>
				<select name="webhook_format">
					<option value="json" selected={c.webhookFormat === 'json'}>JSON</option>
					<option value="slack" selected={c.webhookFormat === 'slack'}>Slack (incoming webhook)</option>
				</select>
			</label>
		</div>
	</section>

	<section class="card">
		<h2>Hold on critical</h2>
		<label class="check">
			<input type="checkbox" name="hold_on_critical" value="1" checked={c.holdOnCritical} />
			<span>
				When a broadcast's check is critical, hold the scheduled broadcasts to the same list until an admin clicks
				Release. Held sends are never cancelled. Off by default.
			</span>
		</label>
	</section>

	<div class="row">
		<button type="submit" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
		<button type="submit" class="secondary" formaction="?/reset" formnovalidate disabled={busy !== null}>Reset thresholds</button>
		<button type="submit" class="secondary" formaction="?/testWebhook" formnovalidate disabled={busy !== null || !c.webhookUrl}>Send test alert</button>
	</div>
	{#if errorFor('save')}<p class="err">{errorFor('save')}</p>{/if}
	{#if form && 'saved' in form && form.saved}<p class="ok" role="status">Saved.</p>{/if}
	{#if errorFor('test')}<p class="err">{errorFor('test')}</p>{/if}
	{#if form && form.action === 'test' && !('error' in form)}<p class="ok" role="status">Test alert sent — the webhook answered {form.status}.</p>{/if}
</form>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); }
	section.card p { max-width: 70ch; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--space-s); }
	.row { display: flex; gap: var(--space-xs); align-items: flex-end; flex-wrap: wrap; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.grow { flex: 1; min-width: 16rem; max-width: 36rem; }
	.check { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.ok { margin: var(--space-xs) 0; }
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { SubmitFunction } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { EFFORT_LABELS, formatMicros } from '$lib/ai-models';
	import {
		DIGEST_PRESET,
		DOW_LABELS,
		EMAIL_WORD_CAP,
		REVIEW_TO_KEY,
		FORMAT_LABELS,
		JOB_NAME_MAX,
		JOB_PROMPT_MAX,
		JOB_TEMPLATES,
		PAYLOAD_FORMATS,
		SCHEDULE_KINDS,
		SCHEDULE_LABELS,
		scheduleText,
		type JobTemplate
	} from '$lib/ai-jobs';

	let { data, form } = $props();

	const editing = $derived(data.job);
	const showForm = $derived(!!editing || data.isNew);
	const models = $derived(data.models.filter((m) => data.allowedModels.includes(m.id) || m.id === editing?.model));

	// Form state (prefilled from the job, the defaults, or a starter template).
	let name = $state('');
	let prompt = $state('');
	let model = $state('');
	let effort = $state('');
	let kind = $state<string>('daily');
	let time = $state('08:00');
	let minute = $state('0');
	let dow = $state('1');
	let dom = $state('1');
	let timezone = $state('');
	let webhookUrl = $state('');
	let format = $state<string>('json');
	let enabled = $state(true);
	let useWebhook = $state(true);
	let useEmail = $state(false);
	let emailTo = $state<string[]>([]);
	// #390: by default every admin with an address, and REVIEW_TO.
	const defaultEmailTo = $derived([...data.admins.filter((a) => a.email).map((a) => String(a.id)), REVIEW_TO_KEY]);
	$effect.pre(() => {
		const j = data.job;
		name = j?.name ?? '';
		prompt = j?.prompt ?? '';
		model = j?.model ?? data.defaults.model;
		effort = j?.effort ?? data.defaults.effort;
		kind = j?.schedule_kind ?? 'daily';
		time = j?.schedule_time ?? '08:00';
		minute = String(Number((j?.schedule_time ?? '08:00').slice(3, 5)));
		dow = String(j?.schedule_dow ?? 1);
		dom = String(j?.schedule_dom ?? 1);
		timezone = j?.timezone ?? data.defaults.timezone;
		webhookUrl = j?.webhook_url ?? '';
		format = j?.payload_format ?? 'json';
		enabled = j ? !!j.enabled : true;
		useWebhook = j ? !!j.webhook_url : true;
		useEmail = !!j?.email_to;
		emailTo = j?.email_to ? j.email_to.map(String) : defaultEmailTo;
	});
	const efforts = $derived(data.models.find((m) => m.id === model)?.efforts ?? []);

	function useTemplate(t: JobTemplate) {
		name = t.name;
		prompt = t.prompt;
		kind = t.kind;
		time = t.time;
		if (t.dow !== undefined) dow = String(t.dow);
	}

	const statusClass = (s: string | null) => (s === 'ok' ? 'sent' : s === 'error' ? 'failed' : s === 'skipped' ? 'sending' : 'draft');
	const statusLabel = (s: string | null) => (s === 'ok' ? 'OK' : s === 'error' ? 'Error' : s === 'skipped' ? 'Skipped' : 'Never run');
	const emailLabel = (s: string | null) => (s === 'sent' ? 'email sent' : s === 'partial' ? 'email partly sent' : s === 'failed' ? 'email failed' : '');

	let busy = $state<string | null>(null);
	function busyEnhance(label: string): SubmitFunction {
		return () => {
			busy = label;
			return async ({ update }) => {
				await update({ reset: false });
				busy = null;
			};
		};
	}
</script>

<svelte:head><title>Assistant jobs</title></svelte:head>

<Breadcrumbs
	items={editing || data.isNew
		? [{ label: 'Assistant', href: '/settings/assistant' }, { label: 'Jobs', href: '/settings/assistant/jobs' }, { label: editing?.name ?? 'New job' }]
		: [{ label: 'Assistant', href: '/settings/assistant' }, { label: 'Jobs' }]}
/>

<h1>{editing ? editing.name : data.isNew ? 'New job' : 'Scheduled jobs'}</h1>
<p class="muted intro">
	A job runs a saved prompt on a schedule, unattended, with the assistant's read-only tools, and posts the report to
	a webhook, emails it to admins of this CRM, or both. Jobs never email contacts or change anything. Each run counts
	against its creator's daily spend cap and the app's monthly cap; at a cap the run is skipped without calling the model.
</p>

{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if page.url.searchParams.has('saved') && !form}<p class="ok">Saved.</p>{/if}
{#if page.url.searchParams.has('deleted')}<p class="ok">Job deleted.</p>{/if}

{#if !showForm}
	<section class="card">
		<div class="head">
			<h2>Jobs</h2>
			<div class="actions">
				<form method="POST" action="?/createDigest" use:enhance={busyEnhance('digest')}>
					<button type="submit" class="secondary" disabled={busy !== null}>{busy === 'digest' ? 'Creating…' : `Create ${DIGEST_PRESET.name.toLowerCase()}`}</button>
				</form>
				<a class="btnlink" href="/settings/assistant/jobs?new=1">New job</a>
			</div>
		</div>
		<p class="muted">The weekly digest emails the admins every Monday at 07:00: replies awaiting an answer, last week's campaigns, contacts going cold, stale deals, deliverability and three suggested actions.</p>
		{#if data.jobs.length === 0}
			<p class="muted">No jobs yet. Start from a template: weekly campaign recap, daily hot leads, or a Monday deliverability check.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Name</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>Enabled</th></tr>
					</thead>
					<tbody>
						{#each data.jobs as j (j.id)}
							<tr>
								<td><a href="/settings/assistant/jobs?job={j.id}">{j.name}</a></td>
								<td>{scheduleText({ kind: j.schedule_kind, time: j.schedule_time, dow: j.schedule_dow, dom: j.schedule_dom, timezone: j.timezone })}</td>
								<td>{j.enabled ? (j.next_run_text ?? '—') : '—'}</td>
								<td>
									<span class="badge {statusClass(j.last_status)}">{statusLabel(j.last_status)}</span>
									{#if j.last_run_text}<span class="muted small">{j.last_run_text}</span>{/if}
								</td>
								<td>
									<form method="POST" action="?/toggle" use:enhance>
										<input type="hidden" name="id" value={j.id} />
										<input type="hidden" name="enabled" value={j.enabled ? '0' : '1'} />
										<button type="submit" class="secondary small-btn" aria-label="{j.enabled ? 'Turn off' : 'Turn on'} {j.name}">
											{j.enabled ? 'On' : 'Off'}
										</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{:else}
	{#if editing}
		<section class="card">
			<h2>Run</h2>
			<p class="muted">
				{#if editing.enabled}Next run: {data.jobs.find((j) => j.id === editing.id)?.next_run_text ?? '—'}.{:else}This job is off.{/if}
				Created by {editing.created_by_login ? `@${editing.created_by_login}` : 'a removed user'}.
			</p>
			<div class="actions">
				<form method="POST" action="?/runNow" use:enhance={busyEnhance('run')}>
					<input type="hidden" name="id" value={editing.id} />
					<button type="submit" disabled={busy !== null}>{busy === 'run' ? 'Running… (up to 60 s)' : 'Run now'}</button>
				</form>
				{#if editing.webhook_url}
					<form method="POST" action="?/sendTest" use:enhance={busyEnhance('test')}>
						<input type="hidden" name="id" value={editing.id} />
						<button type="submit" class="secondary" disabled={busy !== null}>{busy === 'test' ? 'Sending…' : 'Send test payload'}</button>
					</form>
				{/if}
				{#if editing.email_to}
					<form method="POST" action="?/testEmail" use:enhance={busyEnhance('email')}>
						<input type="hidden" name="id" value={editing.id} />
						<button type="submit" class="secondary" disabled={busy !== null}>{busy === 'email' ? 'Running… (up to 60 s)' : 'Send me a test now'}</button>
					</form>
				{/if}
			</div>
			{#if editing.email_to}
				<p class="hint muted">Send me a test now runs the job (it counts against the caps) and emails the report to you only{data.admins.find((a) => a.id === data.me)?.email ? '' : ' — add an email address to your user record first'}.</p>
			{/if}
			{#if form?.testResult}
				<p class={form.testResult.error ? 'err' : 'ok'}>
					Test payload: {form.testResult.status !== null ? `HTTP ${form.testResult.status}` : 'not delivered'}{#if form.testResult.error}
						— {form.testResult.error}{/if}
				</p>
			{/if}
			{#if form?.runResult}
				<div class="result">
					<p>
						<span class="badge {statusClass(form.runResult.status)}">{statusLabel(form.runResult.status)}</span>
						{#if form.runResult.webhookStatus !== null}<span class="muted">Webhook HTTP {form.runResult.webhookStatus}</span>{/if}
						{#if form.runResult.emailStatus}<span class="muted">· {emailLabel(form.runResult.emailStatus)}{form.testEmail ? ' (to you)' : ''}</span>{/if}
						<span class="muted">· {formatMicros(form.runResult.costMicros)}</span>
					</p>
					{#if form.runResult.error}<p class="err">{form.runResult.error}</p>{/if}
					{#if form.runResult.output}<pre class="output">{form.runResult.output}</pre>{/if}
				</div>
			{/if}
		</section>
	{/if}

	<form method="POST" action="?/save" class="card jobform" autocomplete="off" use:enhance={busyEnhance('save')}>
		<h2>{editing ? 'Edit job' : 'New job'}</h2>
		{#if editing}<input type="hidden" name="id" value={editing.id} />{/if}
		{#if !editing}
			<div class="templates">
				<span class="muted">Start from a template:</span>
				{#each JOB_TEMPLATES as t (t.key)}
					<button type="button" class="secondary small-btn" onclick={() => useTemplate(t)}>{t.name}</button>
				{/each}
			</div>
		{/if}
		<label>
			Name
			<input name="name" bind:value={name} maxlength={JOB_NAME_MAX} required />
		</label>
		<label>
			Prompt
			<textarea name="prompt" rows="6" bind:value={prompt} maxlength={JOB_PROMPT_MAX} required></textarea>
			<span class="hint muted">Runs unattended: ask for a self-contained report. The job can only read data.</span>
		</label>
		<div class="row">
			<label>
				Model
				<select name="model" bind:value={model}>
					{#each models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
				</select>
			</label>
			<label>
				Effort
				<select name="effort" bind:value={effort} disabled={!efforts.length}>
					{#each efforts as e (e)}<option value={e}>{EFFORT_LABELS[e]}</option>{/each}
				</select>
			</label>
		</div>
		<div class="row">
			<label>
				Repeats
				<select name="schedule_kind" bind:value={kind}>
					{#each SCHEDULE_KINDS as k (k)}<option value={k}>{SCHEDULE_LABELS[k]}</option>{/each}
				</select>
			</label>
			{#if kind === 'weekly'}
				<label>
					On
					<select name="schedule_dow" bind:value={dow}>
						{#each DOW_LABELS as d, i (d)}<option value={String(i)}>{d}</option>{/each}
					</select>
				</label>
			{/if}
			{#if kind === 'monthly'}
				<label>
					Day of the month
					<input name="schedule_dom" type="number" min="1" max="31" bind:value={dom} required />
					<span class="hint muted">29–31 run on the last day of shorter months.</span>
				</label>
			{/if}
			{#if kind === 'hourly'}
				<label>
					Minutes past the hour
					<input name="schedule_minute" type="number" min="0" max="59" bind:value={minute} required />
				</label>
			{:else}
				<label>
					At
					<input name="schedule_time" type="time" bind:value={time} required />
				</label>
				<label>
					Timezone
					<select name="timezone" bind:value={timezone}>
						{#each data.timezones as tz (tz)}<option value={tz}>{tz}</option>{/each}
					</select>
				</label>
			{/if}
		</div>
		{#if kind === 'hourly'}<input type="hidden" name="timezone" value={timezone} />{/if}
		<fieldset>
			<legend>Deliver the report</legend>
			<input type="hidden" name="deliver_webhook" value={useWebhook ? '1' : '0'} />
			<label class="check"><input type="checkbox" bind:checked={useWebhook} /> To a webhook</label>
			<label class="check"><input type="checkbox" name="deliver_email" value="1" bind:checked={useEmail} /> By email to admins</label>
		</fieldset>
		{#if useEmail}
			<fieldset>
				<legend>Email to</legend>
				{#each data.admins as a (a.id)}
					<label class="check">
						<input type="checkbox" name="email_to" value={String(a.id)} bind:group={emailTo} />
						@{a.github_login}{#if a.email}<span class="muted">&nbsp;{a.email}</span>{:else}<span class="muted">&nbsp;(no email on their user record: skipped)</span>{/if}
					</label>
				{/each}
				<label class="check">
					<input type="checkbox" name="email_to" value={REVIEW_TO_KEY} bind:group={emailTo} />
					REVIEW_TO<span class="muted">&nbsp;{data.reviewTo || '(not configured: set REVIEW_TO or Settings → General → Default From)'}</span>
				</label>
				<span class="hint muted">
					Only admins of this CRM can receive a job's report. Sent from REVIEW_FROM (else the Default From) on the transactional stream, without
					tracking; trimmed to about {EMAIL_WORD_CAP.toLocaleString('en-US')} words.
				</span>
			</fieldset>
		{/if}
		{#if useWebhook}
			<label>
				Webhook URL
				<input name="webhook_url" type="url" bind:value={webhookUrl} placeholder="https://hooks.slack.com/services/…" required />
				<span class="hint muted">https only; local and private network addresses are refused.</span>
			</label>
			<div class="row">
				<label>
					Format
					<select name="payload_format" bind:value={format}>
						{#each PAYLOAD_FORMATS as p (p)}<option value={p}>{FORMAT_LABELS[p]}</option>{/each}
					</select>
				</label>
				<label>
					Signing secret <span class="muted">(optional)</span>
					<input
						name="webhook_secret"
						type="password"
						autocomplete="off"
						spellcheck="false"
						placeholder={editing?.has_secret ? `•••• ${editing.webhook_secret_last4 ?? ''} — leave empty to keep` : ''}
						disabled={!data.secretStoreReady}
					/>
					<span class="hint muted">
						{#if data.secretStoreReady}Adds <code>X-DS-Signature: t=&lt;unix&gt;,v1=&lt;HMAC-SHA256 of "t.body"&gt;</code>. Write-only.{:else}Needs
							the MAIL_TOKEN_KEY Worker secret.{/if}
					</span>
				</label>
			</div>
			{#if editing?.has_secret}
				<label class="check"><input type="checkbox" name="clear_secret" value="1" /> Remove the signing secret</label>
			{/if}
		{:else}
			<input type="hidden" name="payload_format" value={format} />
		{/if}
		<label class="check"><input type="checkbox" name="enabled" value="1" bind:checked={enabled} /> Enabled</label>
		<div class="actions">
			<button type="submit" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save job'}</button>
			<a class="btnlink secondary" href="/settings/assistant/jobs">Cancel</a>
		</div>
	</form>

	{#if editing}
		<section class="card">
			<h2>Run history <span class="muted">(last 50)</span></h2>
			{#if data.runs.length === 0}
				<p class="muted">No runs yet.</p>
			{:else}
				<ul class="runs">
					{#each data.runs as r (r.id)}
						<li>
							<details>
								<summary>
									<span class="badge {statusClass(r.status)}">{statusLabel(r.status)}</span>
									{r.started_text}
									<span class="muted">
										· {r.trigger === 'manual' ? 'Run now' : 'scheduled'}{#if r.webhook_status !== null}
											· webhook {r.webhook_status}{/if}{#if r.email_status}
										· {emailLabel(r.email_status)}{/if} · {formatMicros(r.cost_micros)}
									</span>
								</summary>
								{#if r.error}<p class="err">{r.error}</p>{/if}
								{#if r.output_markdown}<pre class="output">{r.output_markdown}</pre>{:else}<p class="muted">No output.</p>{/if}
							</details>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<form
			method="POST"
			action="?/delete"
			class="danger"
			use:enhance={({ cancel }) => {
				if (!confirm(`Delete the job "${editing.name}"? Its run history goes with it.`)) cancel();
			}}
		>
			<input type="hidden" name="id" value={editing.id} />
			<button type="submit" class="secondary">Delete job</button>
		</form>
	{/if}
{/if}

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	h2 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.card { max-width: 820px; margin-bottom: var(--space-m); }
	.card p { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-s); margin-bottom: var(--space-s); }
	.head h2 { margin: 0; }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-bottom: var(--space-s); }
	label.check { flex-direction: row; align-items: baseline; gap: var(--space-xs); }
	label input, label select, label textarea { min-width: 0; max-width: 100%; }
	.row { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: 0 var(--space-m); }
	.hint, .small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.templates { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs); margin-bottom: var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
	.actions form { margin: 0; }
	.err { color: var(--danger); margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.result { margin-top: var(--space-s); }
	.output { white-space: pre-wrap; word-break: break-word; background: var(--surface); padding: var(--space-s); border-radius: var(--radius-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); max-height: 28rem; overflow-y: auto; margin: var(--space-xs) 0 0; }
	table { border-collapse: collapse; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); min-width: 100%; }
	th, td { text-align: left; padding: var(--space-xs) var(--space-s); vertical-align: top; }
	th { color: var(--muted); font-weight: var(--weight-ui-heavy); white-space: nowrap; }
	td form { margin: 0; }
	.small-btn { padding: var(--space-xxs) var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	summary { cursor: pointer; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.danger { margin: 0; }
	fieldset { border: 0; margin: 0 0 var(--space-s); padding: 0; }
	legend { padding: 0; margin-bottom: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-heavy); }
	fieldset label { margin-bottom: var(--space-xxs); }
	.btnlink { display: inline-block; padding: var(--space-xs) var(--space-m); border-radius: var(--radius-s); background: var(--btn-primary-bg); color: var(--btn-primary-text); font-family: var(--font-ui); font-weight: var(--weight-ui-medium); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--tracking-l); }
	.btnlink:hover { background: var(--btn-primary-hover); }
	.btnlink.secondary { background: var(--color-1-transparent); color: var(--neutral-10); }
</style>

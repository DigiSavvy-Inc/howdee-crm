<script lang="ts">
	import { enhance } from '$app/forms';
	import { kbd } from '$lib/platform.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { EFFORT_LABELS, EFFORT_LEVELS, PROVIDER_LABELS, formatMicros } from '$lib/ai-models';
	import { AI_FEATURES, AI_FEATURE_LABELS, TOOL_FEATURES } from '$lib/ai-providers';
	import { toolLabel } from '$lib/assistant-view';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';

	let { data, form } = $props();

	const cfg = $derived(form?.config ?? data.config);
	let defaultModel = $state('');
	$effect.pre(() => {
		defaultModel = cfg.defaultModel;
	});
	// #696: every model the install knows (built-in + OpenAI-compatible), from the load.
	const models = $derived(data.models);
	const modelById = (id: string | null | undefined) => (id ? models.find((m) => m.id === id) : undefined);
	const defaultEfforts = $derived(models.find((m) => m.id === defaultModel)?.efforts ?? []);
	/** Allowed models a feature may use (tool features: only models with tool use). */
	const featureOptions = (f: (typeof AI_FEATURES)[number]) =>
		models.filter((m) => cfg.allowedModels.includes(m.id) && (!TOOL_FEATURES.has(f) || m.tools));
	const monthCapMicros = $derived(cfg.monthlyCapUsd * 1_000_000);

	// #292: Access — Off / Only selected people / Everyone signed in.
	let access = $state<'off' | 'selected' | 'everyone'>('off');
	let userIds = $state<number[]>([]);
	$effect.pre(() => {
		access = cfg.access;
		userIds = [...cfg.allowedUserIds];
	});
	// Choosing "Only selected people" ticks the admin who is saving, so "just me" is one click.
	function chooseSelected() {
		const me = data.user?.id;
		if (me && !userIds.includes(me)) userIds = [...userIds, me];
	}
	function toggleUser(id: number, on: boolean) {
		userIds = on ? [...userIds, id] : userIds.filter((u) => u !== id);
	}

	// #297: the key forms (save / test / remove), one at a time.
	let busy = $state<string | null>(null);
	function keyEnhance(name: string): SubmitFunction {
		return () => {
			busy = name;
			return async ({ update }) => {
				await update();
				busy = null;
			};
		};
	}
</script>

<svelte:head><title>Assistant</title></svelte:head>

<h1>Assistant</h1>
<p class="muted intro">
	The in-app AI assistant (the sparkle button in the header, or {kbd('Mod+J')}). It reads the app's data as the
	signed-in user and can make changes they ask for (with an Undo card, or after they press Approve). It can't
	send, schedule or enroll anyone.
	<a href="/settings/assistant/jobs">Scheduled jobs</a> run a saved prompt on a schedule and post the report to a webhook.
</p>
<p class="intro"><a class="btnlink" href="/settings/assistant/skills">Skills →</a> <span class="muted">Instructions the assistant follows: house style, campaign strategy, deliverability triage and your own.</span></p>

<section class="card status">
	<h2>Status</h2>
	{#if form?.keyError}<p class="err">{form.keyError}</p>{/if}
	{#if form?.keySaved}<p class="ok">Key saved (•••• {form.keySaved}).</p>{/if}
	{#if form?.keyRemoved !== undefined}
		<p class="ok">
			{#if !form.keyRemoved}No in-app key was set.{:else if form.fallback}In-app key removed — now using the
				<code>ANTHROPIC_API_KEY</code> Worker secret.{:else}In-app key removed — no key is set.{/if}
		</p>
	{/if}
	{#if form?.keyTest === 'ok'}<p class="ok">Key works — Anthropic accepted it.</p>{/if}
	{#if form?.keyTestError}<p class="err">Key test failed: {form.keyTestError}</p>{/if}
	<p>
		API key:
		{#if data.key.source === 'app'}
			<strong>set in app</strong>
			<span class="muted">
				(•••• {data.key.last4}{#if data.key.setBy}, set by @{data.key.setBy}{/if}{#if data.key.setAt}{' '}on
					{data.key.setAt.slice(0, 10)}{/if})
			</span>
		{:else if data.key.source === 'worker'}
			<strong>from the <code>ANTHROPIC_API_KEY</code> Worker secret</strong>
		{:else}
			<strong>not set</strong> — paste a key here or set the <code>ANTHROPIC_API_KEY</code> Worker secret. Until
			then the panel says "Assistant isn't set up".
		{/if}
	</p>
	{#if data.key.storedUnusable}
		<p class="muted">
			An in-app key is stored but can't be opened (MAIL_TOKEN_KEY missing or changed) —
			{data.key.workerSecret ? 'using the Worker secret instead.' : 'save it again or remove it.'}
		</p>
	{/if}
	{#if !data.key.storeReady}
		<p class="muted">
			In-app keys need the <code>MAIL_TOKEN_KEY</code> Worker secret. Ask your operator to set it, or use the
			<code>ANTHROPIC_API_KEY</code> secret.
		</p>
	{/if}
	<form method="POST" action="?/setKey" autocomplete="off" class="keyform" use:enhance={keyEnhance('set')}>
		<label>
			{data.key.source === 'app' || data.key.storedUnusable ? 'Replace the in-app key' : 'Paste an Anthropic API key'}
			<input
				type="password"
				name="key"
				autocomplete="off"
				spellcheck="false"
				placeholder="sk-ant-…"
				required
				disabled={!data.key.storeReady}
			/>
			<span class="hint muted">Stored encrypted; only its last 4 characters are ever shown. A key set here wins over the Worker secret.</span>
		</label>
		<div class="actions">
			<button type="submit" disabled={!data.key.storeReady || busy !== null}>{busy === 'set' ? 'Saving…' : 'Save key'}</button>
		</div>
	</form>
	<div class="actions">
		<form method="POST" action="?/testKey" use:enhance={keyEnhance('test')}>
			<button type="submit" class="secondary" disabled={!data.keySet || busy !== null}>{busy === 'test' ? 'Testing…' : 'Test key'}</button>
		</form>
		{#if data.key.source === 'app' || data.key.storedUnusable}
			<form method="POST" action="?/removeKey" use:enhance={keyEnhance('remove')}>
				<button
					type="submit"
					class="secondary"
					disabled={busy !== null}
					title={data.key.workerSecret ? 'Falls back to the Worker secret' : 'No Worker secret is set; the assistant stops working'}
				>
					{busy === 'remove' ? 'Removing…' : 'Remove'}
				</button>
			</form>
		{/if}
	</div>
</section>

<section class="card status">
	<h2>Other providers: OpenAI-compatible</h2>
	<p class="muted">
		Optional. Any endpoint that speaks the OpenAI Chat Completions API with streaming: OpenAI, OpenRouter, Google's or
		Cloudflare Workers AI's OpenAI-compatible URL, or your own server. Claude stays the default; the models you list here
		show up under Models below, where you allow them.
	</p>
	{#if form?.providerError}<p class="err">{form.providerError}</p>{/if}
	{#if data.openaiStoredBaseUrl}
		<p class="err">
			{#if data.openaiStoredBaseUrl.http}The saved base URL uses http and is no longer accepted.{:else}The saved base URL is no longer accepted. {data.openaiStoredBaseUrl.problem}{/if}
			Saved value: <code>{data.openaiStoredBaseUrl.value}</code>. Nothing is sent to it, and no key is used. Change it below
			(https://, or http:// only for localhost, 127.0.0.1 or [::1]), save, then enter the key again.
		</p>
	{/if}
	{#if form?.providerSaved}
		<p class="ok">Provider saved.{#if form.providerKeyCleared} The address changed, so the in-app key was removed: paste the key for the new address.{/if}</p>
	{/if}
	<form method="POST" action="?/saveProvider" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="row">
			<label>
				Base URL
				<input name="base_url" type="url" value={data.openaiStoredBaseUrl?.value ?? cfg.openai.baseUrl} placeholder={data.openaiDefaultBaseUrl} />
				<span class="hint muted">Blank = {data.openaiDefaultBaseUrl}. Requests go to &lt;base URL&gt;/chat/completions.</span>
			</label>
			<label>
				Name <span class="muted">(optional)</span>
				<input name="label" type="text" maxlength="60" value={cfg.openai.label} placeholder="e.g. OpenRouter" />
			</label>
		</div>
		<label>
			Models, one per line
			<textarea name="models" rows="4" spellcheck="false" placeholder="model-name | Label | tools | 1.25 | 10">{data.openaiModelsText}</textarea>
			<span class="hint muted">
				<code>name | label | flags | input $/M | output $/M</code>. Flags: <code>tools</code> (default),
				<code>no-tools</code>, <code>reasoning</code> (offers effort). Leave the prices out and the model is
				unpriced: its calls show as "unpriced" and don't count toward the spend caps.
			</span>
		</label>
		<button type="submit">Save provider</button>
	</form>
	{#if form?.providerKeyError}<p class="err">{form.providerKeyError}</p>{/if}
	{#if form?.providerKeySaved}<p class="ok">Key saved (•••• {form.providerKeySaved}).</p>{/if}
	{#if form?.providerKeyRemoved !== undefined}
		<p class="ok">
			{#if !form.providerKeyRemoved}No in-app key was set.{:else if form.providerFallback}In-app key removed — now using the
				<code>OPENAI_API_KEY</code> Worker secret.{:else}In-app key removed — no key is set.{/if}
		</p>
	{/if}
	{#if form?.providerKeyTest === 'ok'}<p class="ok">Key works — the endpoint accepted it.</p>{/if}
	{#if form?.providerKeyTestError}<p class="err">Key test failed: {form.providerKeyTestError}</p>{/if}
	<p>
		API key:
		{#if data.openaiKey.source === 'app'}
			<strong>set in app</strong>
			<span class="muted">(•••• {data.openaiKey.last4}{#if data.openaiKey.setBy}, set by @{data.openaiKey.setBy}{/if})</span>
		{:else if data.openaiKey.source === 'worker'}
			<strong>from the <code>OPENAI_API_KEY</code> Worker secret</strong>
		{:else}
			<strong>not set</strong>
		{/if}
	</p>
	{#if data.openaiKey.hostMismatch}
		<p class="muted">The in-app key was saved for a different address, so it isn't sent. Paste the key again for {data.openaiKey.host}.</p>
	{:else if data.openaiKey.workerSecretBlocked && data.openaiKey.source === null}
		<p class="muted">
			The <code>OPENAI_API_KEY</code> Worker secret is only sent to {data.openaiKey.pinnedHost}. Paste a key here, or ask your
			operator to set <code>OPENAI_BASE_URL_HOST</code>.
		</p>
	{/if}
	<form method="POST" action="?/setProviderKey" autocomplete="off" class="keyform" use:enhance={keyEnhance('pset')}>
		<input type="hidden" name="base_host" value={data.openaiKey.host ?? ''} />
		<label>
			{data.openaiKey.source === 'app' ? 'Replace the in-app key' : 'Paste the API key'}
			<input type="password" name="key" autocomplete="off" spellcheck="false" required disabled={!data.openaiKey.storeReady} />
			<span class="hint muted">Stored encrypted like the Anthropic key; only its last 4 characters are shown.</span>
		</label>
		<div class="actions">
			<button type="submit" disabled={!data.openaiKey.storeReady || busy !== null}>{busy === 'pset' ? 'Saving…' : 'Save key'}</button>
		</div>
	</form>
	<div class="actions">
		<form method="POST" action="?/testProviderKey" use:enhance={keyEnhance('ptest')}>
			<button type="submit" class="secondary" disabled={(data.openaiKey.source === null && !data.openaiKey.hostMismatch && !data.openaiKey.workerSecretBlocked) || busy !== null}>{busy === 'ptest' ? 'Testing…' : 'Test key'}</button>
		</form>
		{#if data.openaiKey.source === 'app' || data.openaiKey.storedUnusable || data.openaiKey.hostMismatch}
			<form method="POST" action="?/removeProviderKey" use:enhance={keyEnhance('premove')}>
				<button type="submit" class="secondary" disabled={busy !== null}>{busy === 'premove' ? 'Removing…' : 'Remove'}</button>
			</form>
		{/if}
	</div>
</section>

<form method="POST" action="?/setPermissions" use:enhance={() => async ({ update }) => update({ reset: false })} class="card permissions">
	<h2>Permissions</h2>
	{#if form?.permissionsError}<p class="err">{form.permissionsError}</p>{/if}
	{#if form?.permissionsSaved}<p class="ok">{form.permissionsChanged ? 'Saved.' : 'No change.'}</p>{/if}
	<label class="check">
		<input type="checkbox" name="allow_delete" checked={cfg.allowDelete} />
		Allow the assistant to delete contacts
	</label>
	<p class="hint muted">
		Off by default. When off, the assistant has no delete tool and offers Archive instead. When on, every delete
		waits for Approve, is limited to 50 contacts and can't be undone. Changes show in the dashboard activity feed.
	</p>
	<fieldset class="access">
		<legend>Code &amp; snippets</legend>
		<label class="check"><input type="radio" name="allow_code" value="off" checked={cfg.allowCode === 'off'} /> Off</label>
		<label class="check"><input type="radio" name="allow_code" value="admins" checked={cfg.allowCode === 'admins'} /> Admins only</label>
		<label class="check">
			<input type="radio" name="allow_code" value="everyone" checked={cfg.allowCode === 'everyone'} /> Everyone with assistant access
		</label>
	</fieldset>
	<p class="hint muted">
		Off by default. When on for someone, the assistant writes HTML/CSS, tracking and form snippets, Data API
		examples, webhook receivers, regex and formulas on request, with placeholders instead of real keys. It can't run
		code, and writing code never sends, schedules, enrolls or changes data.
	</p>
	<input type="hidden" name="draft_reply_field" value="1" />
	<label class="check">
		<input type="checkbox" name="draft_reply" checked={cfg.draftReply} />
		Draft reply in Conversations
	</label>
	<p class="hint muted">
		On by default, for people with assistant access. Adds a Draft reply button to the Reply box: the assistant
		writes a draft from that thread and that contact's record. The person edits and sends it; the assistant never sends.
	</p>
	<input type="hidden" name="editor_ask_field" value="1" />
	<label class="check">
		<input type="checkbox" name="editor_ask" checked={cfg.editorAsk} />
		Ask AI in the editor
	</label>
	<p class="hint muted">
		On by default, for people with assistant access. Adds Ask AI to the email, template and page editors: select text
		to rewrite, shorten, translate or turn it into a list or button. The selection and the content around it are sent
		to the AI provider. Nothing changes until the person clicks Replace or Insert below.
	</p>
	<button type="submit">Save permissions</button>
</form>

<form method="POST" action="?/save" use:enhance={() => async ({ update }) => update({ reset: false })} class="settings">
	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.saved}<p class="ok">Saved.</p>{/if}

	<section class="card">
		<h2>Access</h2>
		<fieldset class="access">
			<legend>Who can use the assistant</legend>
			<label class="check">
				<input type="radio" name="access" value="off" bind:group={access} />
				Off <span class="muted">(nobody; admins still see the header button)</span>
			</label>
			<label class="check">
				<input type="radio" name="access" value="selected" bind:group={access} onchange={chooseSelected} />
				Only selected people
			</label>
			<label class="check">
				<input type="radio" name="access" value="everyone" bind:group={access} />
				Everyone signed in
			</label>
		</fieldset>
		{#if access === 'selected'}
			<fieldset class="people" aria-describedby={form?.accessError ? 'access-error' : undefined}>
				<legend>People</legend>
				{#each data.users as u (u.id)}
					<label class="check">
						<input
							type="checkbox"
							name="user"
							value={u.id}
							checked={userIds.includes(u.id)}
							onchange={(e) => toggleUser(u.id, e.currentTarget.checked)}
						/>
						{u.name || `@${u.login}`}
						<span class="muted">{u.name ? `@${u.login} · ` : ''}{u.role}{u.id === data.user?.id ? ' · you' : ''}</span>
					</label>
				{/each}
				{#if form?.accessError}<p class="err" id="access-error">{form.accessError}</p>{/if}
			</fieldset>
		{:else}
			{#each userIds as id (id)}<input type="hidden" name="user" value={id} />{/each}
		{/if}
	</section>

	<section class="card">
		<h2>Models</h2>
		<fieldset class="models">
			<legend>Allowed models <span class="muted">(people pick per conversation)</span></legend>
			{#each models as m (m.id)}
				<label class="check">
					<input type="checkbox" name="allowed" value={m.id} checked={cfg.allowedModels.includes(m.id)} />
					{m.label}
					<span class="muted">
						{PROVIDER_LABELS[m.provider]} ·
						{#if m.price}${m.price.input} in · ${m.price.output} out per million tokens{:else}unpriced{/if}{#if !m.tools}
							· no tool use (chat, jobs and Ask AI can't use it){/if}
					</span>
				</label>
			{/each}
		</fieldset>
		<div class="row">
			<label>
				Default model
				<select name="default_model" bind:value={defaultModel}>
					{#each models as m (m.id)}
						<option value={m.id}>{m.label}</option>
					{/each}
				</select>
			</label>
			<label>
				Default effort
				<select name="default_effort" value={cfg.defaultEffort} disabled={!defaultEfforts.length}>
					{#each EFFORT_LEVELS as e (e)}
						<option value={e}>{EFFORT_LABELS[e]}</option>
					{/each}
				</select>
				{#if !defaultEfforts.length}<span class="hint muted">This model has no effort setting.</span>{/if}
			</label>
		</div>
		<input type="hidden" name="feature_models_field" value="1" />
		<fieldset class="models" id="feature-models">
			<legend>Model per feature <span class="muted">(from the allowed models as saved)</span></legend>
			<div class="row">
				{#each AI_FEATURES as f (f)}
					<label>
						{AI_FEATURE_LABELS[f]}
						<select name="feature_{f}" value={cfg.featureModels[f] ?? ''}>
							<option value="">{f === 'resendSubject' ? 'Claude Haiku (built-in)' : 'Default model'}</option>
							{#each featureOptions(f) as m (m.id)}
								<option value={m.id}>{m.label}</option>
							{/each}
						</select>
					</label>
				{/each}
			</div>
			<p class="hint muted">Chat, scheduled jobs and Ask AI call tools, so they only list models with tool use.</p>
		</fieldset>
	</section>

	<section class="card">
		<h2>Spend caps</h2>
		<p class="muted">
			At a cap, new turns are refused with a message until the period resets (UTC). This month so far:
			<strong>{formatMicros(data.monthSpent)}</strong> of ${cfg.monthlyCapUsd.toFixed(2)}{#if data.monthSpent >= monthCapMicros}
				— cap reached{/if}.
		</p>
		<div class="row">
			<label>
				Monthly cap, whole app (USD)
				<input name="monthly_cap" type="number" min="0" step="0.01" value={cfg.monthlyCapUsd} required />
			</label>
			<label>
				Daily cap per user (USD)
				<input name="daily_cap" type="number" min="0" step="0.01" value={cfg.dailyUserCapUsd} required />
			</label>
		</div>
	</section>

	<section class="card">
		<h2>History</h2>
		<label>
			Keep conversations for (days)
			<input name="retention_days" type="number" min="1" max="3650" step="1" value={cfg.retentionDays} required />
			<span class="hint muted">
				Conversations with no new message for this long, and scheduled-job runs older than this, are deleted once a
				day (never this month's, which count toward the spend caps). Records of changes the assistant made are kept
				for a year.
			</span>
		</label>
	</section>

	<button type="submit">Save</button>
</form>

<section class="card usage">
	<h2>Last {data.insights.days} days</h2>
	<StatGroup label="Assistant usage, last {data.insights.days} days">
		<StatCell label="Turns" value={data.insights.turns.toLocaleString()} sub="messages people typed" />
		<StatCell label="Avg cost per turn" value={data.insights.avgTurnMicros === null ? '—' : formatMicros(data.insights.avgTurnMicros)} sub="chat spend ÷ turns" />
		<StatCell label="Good answers" value={data.insights.feedback.up} sub="thumbs up" />
		<StatCell label="Missed answers" value={data.insights.feedback.down} sub="thumbs down" tone={data.insights.feedback.down > 0 ? 'warn' : undefined} />
	</StatGroup>

	<div class="cols">
		<div>
			<h3>Spend by model</h3>
			{#if data.insights.byModel.length === 0}
				<p class="muted">No model calls yet.</p>
			{:else}
				<div class="scroll">
					<table>
						<thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Cost</th></tr></thead>
						<tbody>
							{#each data.insights.byModel as m (m.model)}
								<tr>
									<td>{modelById(m.model)?.label ?? (m.model || 'unknown')}</td>
									<td class="num">{m.calls.toLocaleString()}</td>
									<td class="num">{modelById(m.model) && !modelById(m.model)?.price ? 'unpriced' : formatMicros(m.cost_micros)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="hint muted">Chat model calls plus scheduled-job runs.</p>
			{/if}
		</div>
		<div>
			<h3>Top tools</h3>
			{#if data.insights.topTools.length === 0}
				<p class="muted">No tool calls yet.</p>
			{:else}
				<div class="scroll">
					<table>
						<thead><tr><th>Tool</th><th class="num">Calls</th></tr></thead>
						<tbody>
							{#each data.insights.topTools as t (t.name)}
								<tr><td title={t.name}>{toolLabel(t.name)}</td><td class="num">{t.calls.toLocaleString()}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>

	{#if data.insights.recentDown.length}
		<h3>Recent missed answers</h3>
		<div class="scroll">
			<table>
				<thead><tr><th>When (UTC)</th><th>User</th><th>Conversation</th><th>Model</th></tr></thead>
				<tbody>
					{#each data.insights.recentDown as d (d.message_id)}
						<tr>
							<td>{d.at.slice(0, 16)}</td>
							<td>{d.github_login ? `@${d.github_login}` : '—'}</td>
							<td class="wrap">{d.title || '(untitled)'}</td>
							<td>{modelById(d.model)?.label ?? (d.model || '—')}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<section class="card usage">
	<h2>Usage by user and month</h2>
	{#if data.usage.length === 0}
		<p class="muted">No assistant usage yet.</p>
	{:else}
		<div class="scroll">
			<table>
				<thead>
					<tr><th>Month</th><th>User</th><th>Model calls</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr>
				</thead>
				<tbody>
					{#each data.usage as u (u.month + ':' + u.user_id)}
						<tr>
							<td>{u.month}</td>
							<td>{u.github_login ? `@${u.github_login}` : `user ${u.user_id}`}</td>
							<td>{u.turns.toLocaleString()}</td>
							<td>{u.input_tokens.toLocaleString()}</td>
							<td>{u.output_tokens.toLocaleString()}</td>
							<td>{formatMicros(u.cost_micros)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	.settings { display: flex; flex-direction: column; gap: var(--space-m); margin: 0; max-width: 720px; }
	.settings > button { align-self: flex-start; }
	h2 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.card p { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-bottom: var(--space-s); }
	label:last-child { margin-bottom: 0; }
	label.check { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: var(--space-xxs) var(--space-xs); }
	label input, label select, label textarea { min-width: 0; max-width: 100%; }
	textarea { font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); }
	fieldset.models, fieldset.access, fieldset.people { border: 0; padding: 0; margin: 0 0 var(--space-s); }
	fieldset.people { margin: 0; padding-left: var(--space-m); }
	legend { padding: 0; margin-bottom: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.row { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 0 var(--space-m); }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.err { color: var(--danger); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0; }
	.status { max-width: 720px; margin-bottom: var(--space-m); }
	.permissions { max-width: 720px; margin: 0 0 var(--space-m); }
	.permissions .hint { margin: 0 0 var(--space-s); }
	.keyform { margin: 0 0 var(--space-s); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
	.actions form { margin: 0; }
	.usage { max-width: 720px; margin-top: var(--space-m); }
	.btnlink { font-weight: var(--weight-ui-medium); text-decoration: none; }
	.scroll { overflow-x: auto; }
	table { border-collapse: collapse; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); min-width: 100%; }
	th, td { text-align: left; padding: var(--space-xs) var(--space-s); white-space: nowrap; }
	th { color: var(--muted); font-weight: var(--weight-ui-heavy); }
	h3 { margin: var(--space-m) 0 var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 0 var(--space-m); }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	td.wrap { white-space: normal; min-width: 12em; }
</style>

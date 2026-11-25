<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	let busy = $state(false);
	const submit = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	const activeLabel = $derived(data.providers.find((p) => p.id === data.active)?.label ?? data.active);
	const fromText = $derived(
		data.activeFrom === 'settings' ? 'chosen here' : data.activeFrom === 'env' ? 'from MAIL_PROVIDER' : 'the default'
	);
	const tokenText = $derived(
		data.postmark.token.source === 'app'
			? `Set in the app${data.postmark.token.setBy ? ` by @${data.postmark.token.setBy}` : ''}${data.postmark.token.setAt ? ` on ${data.postmark.token.setAt.slice(0, 10)}` : ''}.`
			: data.postmark.token.source === 'env'
				? 'Using the Worker secret POSTMARK_TOKEN.'
				: data.postmark.token.source === 'unreadable'
					? `Saved in the app${data.postmark.token.setAt ? ` on ${data.postmark.token.setAt.slice(0, 10)}` : ''}, but it can't be read.`
					: 'Not set.'
	);
</script>

<svelte:head><title>Sending</title></svelte:head>

<h1>Sending</h1>
<p class="muted intro">
	The sending provider delivers every email the app sends: broadcasts, automation emails, scheduled sends, 1:1 emails,
	replies, confirmations, invites and password resets. Contacts, lists, suppressions and history stay in the CRM
	whichever provider you pick. Self-hosting details: <code>docs/sending-providers.md</code>.
</p>

<section class="card">
	<h2>Provider</h2>
	<p class="muted small">Active: <strong>{activeLabel}</strong> ({fromText}){data.configured ? '' : ' · not configured yet'}.</p>
	<form method="POST" action="?/setProvider" use:enhance={submit}>
		<fieldset>
			<legend class="sr-only">Sending provider</legend>
			{#each data.providers as p (p.id)}
				<label class="check">
					<input type="radio" name="provider" value={p.id} checked={p.id === data.active} disabled={!p.available} />
					{p.label}{#if !p.available}<span class="muted"> · coming soon</span>{/if}
				</label>
			{/each}
		</fieldset>
		{#if data.sending}<p class="notice warn" role="status">A campaign is sending. The provider can't be switched until it finishes.</p>{/if}
		{#if form && 'providerError' in form && form.providerError}<p class="notice err" role="alert">{form.providerError}</p>{/if}
		{#if form && 'providerSaved' in form && form.providerSaved}<p class="notice ok" role="status">Saved.</p>{/if}
		<div class="actions"><button type="submit" disabled={busy}>Make active</button></div>
	</form>
	{#if data.capabilities.length}
		<h3>What {activeLabel} does here</h3>
		<ul class="caps">
			{#each data.capabilities as line (line)}<li>{line}</li>{/each}
		</ul>
	{/if}
</section>

<section class="card">
	<h2>Open and click tracking</h2>
	<p class="small">
		Tracked by <strong>{data.tracking.effective === 'crm' ? 'the CRM' : activeLabel}</strong>
		({data.tracking.from === 'settings' ? 'chosen here' : data.tracking.from === 'env' ? 'from MAIL_TRACKING' : 'the default'}).
		The CRM adds its own 1x1 image and signed links on this app's address to broadcasts and automation emails; personal 1:1
		emails are never tracked by it. A change only affects mail sent afterwards.
	</p>
	{#if data.tracking.canChoose}
		<form method="POST" action="?/setTracking" use:enhance={submit}>
			<fieldset>
				<legend class="sr-only">Who tracks opens and clicks</legend>
				<label class="check"><input type="radio" name="tracking" value="provider" checked={data.tracking.mode !== 'crm'} /> By the provider</label>
				<label class="check"><input type="radio" name="tracking" value="crm" checked={data.tracking.mode === 'crm'} /> By the CRM</label>
			</fieldset>
			{#if form && 'trackingError' in form && form.trackingError}<p class="notice err" role="alert">{form.trackingError}</p>{/if}
			{#if form && 'trackingSaved' in form && form.trackingSaved}<p class="notice ok" role="status">Saved.</p>{/if}
			<div class="actions"><button type="submit" class="secondary" disabled={busy}>Save tracking</button></div>
		</form>
	{:else}
		<p class="muted small">{activeLabel} can't track opens and clicks, so the CRM always does.</p>
	{/if}
</section>

<section class="card">
	<h2>Postmark credentials</h2>
	<p class="small">Server API token: {tokenText}</p>
	{#if data.postmark.token.error}
		<p class="notice err" role="alert">
			{data.postmark.token.error} Sending is off until then: the Worker secret POSTMARK_TOKEN is not used while a token is saved here.
		</p>
	{/if}
	<form method="POST" action="?/saveToken" use:enhance={submit}>
		<label class="field"
			><span>Server API token <span class="muted">(Postmark → Servers → your server → API Tokens; not the account token)</span></span>
			<input type="password" name="token" autocomplete="off" disabled={!data.keyReady} />
		</label>
		{#if !data.keyReady}
			<p class="muted small">MAIL_TOKEN_KEY is not set, so secrets can't be stored in the app. The Worker secret POSTMARK_TOKEN is used.</p>
		{/if}
		{#if form && 'tokenError' in form && form.tokenError}<p class="notice err" role="alert">{form.tokenError}</p>{/if}
		{#if form && 'tokenSaved' in form && form.tokenSaved}<p class="notice ok" role="status">Token saved.</p>{/if}
		{#if form && 'tokenRemoved' in form}<p class="notice ok" role="status">{form.tokenRemoved ? 'Token cleared.' : 'No token was set in the app.'}</p>{/if}
		<div class="actions">
			<button type="submit" disabled={busy || !data.keyReady}>Save token</button>
			{#if data.postmark.token.source === 'app' || data.postmark.token.source === 'unreadable'}
				<button type="submit" class="secondary" formaction="?/removeToken" disabled={busy}>Clear token</button>
			{/if}
		</div>
	</form>

	<form method="POST" action="?/saveStreams" use:enhance={submit}>
		<div class="row">
			<label class="field"
				><span>Broadcast stream <span class="muted">(blank = {data.postmark.stream.env ? `POSTMARK_STREAM, “${data.postmark.stream.env}”` : 'POSTMARK_STREAM'})</span></span>
				<input name="stream" value={data.postmark.stream.saved} placeholder={data.postmark.stream.env || 'broadcast'} />
			</label>
			<label class="field"
				><span>Transactional stream <span class="muted">(blank = {data.postmark.txStream.env ? `POSTMARK_STREAM_TX, “${data.postmark.txStream.env}”` : 'POSTMARK_STREAM_TX or “outbound”'})</span></span>
				<input name="tx_stream" value={data.postmark.txStream.saved} placeholder={data.postmark.txStream.env || 'outbound'} />
			</label>
		</div>
		{#if form && 'streamsError' in form && form.streamsError}<p class="notice err" role="alert">{form.streamsError}</p>{/if}
		{#if form && 'streamsSaved' in form && form.streamsSaved}<p class="notice ok" role="status">Streams saved.</p>{/if}
		<div class="actions"><button type="submit" class="secondary" disabled={busy}>Save streams</button></div>
	</form>

	<p class="small">
		Webhook key: {data.postmark.webhookKeySet ? 'Using the Worker secret WEBHOOK_KEY.' : 'Not set (the webhook answers 401).'}
		Account token: {data.postmark.accountTokenSet ? 'Using the Worker secret POSTMARK_ACCOUNT_TOKEN.' : 'Not set (optional; DKIM and Return-Path status).'}
	</p>
</section>

<section class="card">
	<h2>Check it works</h2>
	<p class="small">Webhook URL to register on the broadcast stream: <code>{data.webhookUrl}</code></p>
	<p class="small muted">Last event received: {data.lastEventAt ? `${data.lastEventAt} UTC` : 'none yet'}.</p>
	<div class="actions">
		<form method="POST" action="?/test" use:enhance={submit}>
			<button type="submit" class="secondary" disabled={busy || !data.configured}>Test connection</button>
		</form>
		<form method="POST" action="?/sendTest" use:enhance={submit}>
			<button type="submit" class="secondary" disabled={busy || !data.configured}>Send a test to me</button>
		</form>
	</div>
	{#if form && 'testError' in form && form.testError}<p class="notice err" role="alert">{form.testError}</p>{/if}
	{#if form && 'check' in form && form.check}
		<p class="notice {form.check.ok ? 'ok' : 'warn'}" role="status">{form.check.summary}</p>
		<ul class="rows">
			{#each form.check.rows as r (r.id)}
				<li><strong>{r.label}:</strong> {r.state === 'ready' ? 'Ready' : 'Needs attention'}. {r.detail}{#if r.fix}<span class="muted"> {r.fix}</span>{/if}</li>
			{/each}
		</ul>
	{/if}
	{#if form && 'sendError' in form && form.sendError}<p class="notice err" role="alert">{form.sendError}</p>{/if}
	{#if form && 'testSent' in form && form.testSent}
		<p class="notice ok" role="status">Sent to {form.testSent.to}{form.testSent.messageId ? ` · message id ${form.testSent.messageId}` : ''}.</p>
	{/if}
</section>

{#if data.events.length}
	<section class="card">
		<h2>Changes</h2>
		<ul class="rows">
			{#each data.events as ev, i (i)}
				<li>{ev.at.slice(0, 16).replace('T', ' ')} UTC · {ev.login ? `@${ev.login}` : 'someone'} · {ev.change}</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	h3 { margin: var(--space-s) 0 0; font-size: var(--size-s); line-height: var(--line-s); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); display: flex; flex-direction: column; gap: var(--space-s); }
	section.card p { max-width: 70ch; margin: 0; }
	form { display: flex; flex-direction: column; gap: var(--space-s); }
	fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 32rem; flex: 1 1 16rem; }
	.row { display: flex; flex-wrap: wrap; gap: var(--space-s); }
	.check { display: flex; gap: var(--space-xs); align-items: center; font-size: var(--size-s); line-height: var(--line-s); }
	.caps, .rows { margin: 0; padding-left: var(--space-m); font-size: var(--size-s); line-height: var(--line-s); display: flex; flex-direction: column; gap: var(--space-xxs); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-s); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	code { font-size: var(--size-xs); word-break: break-all; }
</style>

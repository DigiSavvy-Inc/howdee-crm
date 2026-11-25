<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	const GROUPS = [
		{ id: 'required', title: 'Required', intro: 'The app needs every one of these to send and track email.' },
		{ id: 'postmark', title: 'Sending provider', intro: 'Set up in the provider itself (Postmark or Resend); tracking and unsubscribes depend on them.' },
		{ id: 'optional', title: 'Optional integrations', intro: 'Each one stays off until you set it up.' }
	] as const;

	const STATE_LABEL = { ready: 'Ready', attention: 'Needs attention', optional: 'Optional, not set' } as const;
	const STATE_CLASS = { ready: 'sent', attention: 'failed', optional: 'draft' } as const;

	// #731: the first-run wizard. Every step links to the next, so any of them can be skipped.
	const wiz = $derived(data.wizard);
	const stepIndex = $derived(wiz ? wiz.steps.findIndex((s) => s.id === wiz.step) : -1);
	const nextHref = $derived(wiz && stepIndex >= 0 && stepIndex < wiz.steps.length - 1 ? `?wizard=${wiz.steps[stepIndex + 1].id}` : '/settings/setup');
	const result = $derived(form && wiz && 'step' in form && form.step === wiz.step ? form : null);
	const errorText = $derived(result && 'error' in result ? (result.error as string) : '');
	const savedText = $derived(result && 'saved' in result ? (result.saved as string) : '');
	const webhook = $derived(
		result && 'webhook' in result
			? (result.webhook as { state: string; created: boolean; present: boolean; elsewhere: string | null; stream: string; streamOk: boolean; streamDetail: string; unsubscribe: { status: string; summary: string } })
			: null
	);
	const webhookLine = $derived(
		!webhook
			? ''
			: webhook.state === 'created'
				? `Created on "${webhook.stream}".`
				: webhook.state === 'present'
					? `Already set up on "${webhook.stream}".`
					: webhook.state === 'updated'
						? `Moved from ${webhook.elsewhere} to this address on "${webhook.stream}".`
						: webhook.state === 'elsewhere'
							? `Points at another address (${webhook.elsewhere}), not this one.`
							: 'Not created.'
	);
	const revealed = $derived(result && 'revealed' in result ? (result.revealed as string) : '');
	const optionalRows = $derived(data.checks.filter((c) => c.group === 'optional' && c.state !== 'ready'));

	const SOURCE_TEXT: Record<string, string> = {
		setting: 'Settings → Domain',
		env: 'PUBLIC_BASE_URL in wrangler.jsonc',
		seen: 'recorded at setup (or chosen here)',
		none: 'nothing set'
	};

	let busy = $state(false);
	const submit = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	// #732: the token field is emptied after a successful Connect (a failed one keeps what was typed).
	const submitSending = () => {
		busy = true;
		return async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: result.type === 'success' });
			busy = false;
		};
	};

	let copied = $state(false);
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<svelte:head><title>Setup</title></svelte:head>

<h1>Setup</h1>
{#if data.first}
	<p class="notice ok" role="status">Your admin account is ready. A few steps get sending working; skip any of them and come back later.</p>
{/if}

{#if wiz}
	<section class="card wizard" aria-labelledby="wizard-title">
		<h2 id="wizard-title">Setup wizard</h2>
		<ol class="steps">
			{#each wiz.steps as s, i (s.id)}
				<li>
					<a href={`?wizard=${s.id}`} aria-current={s.id === wiz.step ? 'step' : undefined} class:current={s.id === wiz.step}>{i + 1}. {s.title}</a>
				</li>
			{/each}
		</ol>

		{#if errorText}<p class="notice err" role="alert">{errorText}</p>{/if}
		{#if savedText}<p class="notice ok" role="status">{savedText}</p>{/if}

		{#if wiz.step === 'address'}
			<h3>Your address</h3>
			{#if wiz.address.source === 'request'}
				<!-- #731: nothing recorded yet. Two plain sentences; the button below records it. -->
				<p class="small">
					{#if wiz.address.currentProblem === 'loopback host'}
						This is a local address (<code>{wiz.address.host}</code>), so nothing is recorded. Open the app at its public
						address to set the one links use.
					{:else if wiz.address.currentProblem}
						This address (<code>{wiz.address.host}</code>) can't be used for links, so nothing is recorded. Open the app at
						its public https address to set one.
					{:else}
						No address is saved yet, so links use the one this page is open on: <code>{wiz.address.host}</code>. Choose
						“Use this address for links” to keep it.
					{/if}
				</p>
				<p class="small">
					Unsubscribe and tracking links, and the built-in clock, use this address. For your own domain, use
					<a href="/settings/domain">Settings → Domain</a>.
				</p>
			{:else}
				<p class="small">
					Links use <code>{wiz.address.host || wiz.address.url || 'no address yet'}</code>
					<span class="muted">(from {SOURCE_TEXT[wiz.address.source] ?? wiz.address.source})</span>. Unsubscribe and tracking
					links, and the built-in clock, use it. For your own domain, use <a href="/settings/domain">Settings → Domain</a>.
				</p>
			{/if}
			{#if wiz.address.previewHint}
				<p class="notice warn" role="status">
					<code>{wiz.address.host}</code> looks like a Cloudflare version-preview address. If it is, open the app at its
					main address and record that one instead.
				</p>
			{/if}
			{#if wiz.address.canUse || wiz.address.canClear}
				<div class="actions">
					{#if wiz.address.canUse}
						<form method="POST" action="?/useAddress" use:enhance={submit}>
							<button type="submit" class="secondary" disabled={busy}>Use this address for links</button>
						</form>
						<span class="muted small">This page: <code>{wiz.address.current}</code></span>
					{/if}
					{#if wiz.address.canClear}
						<form method="POST" action="?/clearAddress" use:enhance={submit}>
							<button type="submit" class="secondary" disabled={busy}>Clear the recorded address</button>
						</form>
					{/if}
				</div>
			{/if}
			<form method="POST" action="?/address" use:enhance={submit}>
				<label class="field">
					<span>Default From address <span class="muted">(on a domain your sending provider has verified)</span></span>
					<input type="email" name="default_from" value={wiz.defaultFrom || wiz.envFrom} placeholder="you@example.com" required />
				</label>
				<div class="actions">
					<button type="submit" disabled={busy}>Save</button>
					<a href={nextHref}>{savedText ? 'Next' : 'Skip'}</a>
				</div>
			</form>
		{:else if wiz.step === 'sending'}
			<h3>Connect sending</h3>
			<p class="small">
				Pick the provider and paste its token. It's stored sealed, the same as in
				<a href="/settings/sending">Settings → Sending</a>, and shows only as set or not set. Saving checks the connection;
				it sends nothing.
			</p>
			<p class="small">
				Token: {wiz.token.source === 'app' ? 'set in the app' : wiz.token.source === 'env' ? 'the Worker secret POSTMARK_TOKEN' : wiz.token.source === 'unreadable' ? "saved, but it can't be read" : 'not set'}.
			</p>
			<form method="POST" action="?/sending" use:enhance={submitSending}>
				<fieldset>
					<legend class="small">Sending provider</legend>
					{#each wiz.providers as p (p.id)}
						<label class="check">
							<input type="radio" name="provider" value={p.id} checked={p.id === wiz.active} disabled={!p.available} />
							{p.label}{#if !p.available}<span class="muted"> · coming soon</span>{/if}
						</label>
					{/each}
				</fieldset>
				<label class="field">
					<span>Server API token <span class="muted">(Postmark → Servers → your server → API Tokens; not the account token)</span></span>
					<input type="password" name="token" autocomplete="off" disabled={!wiz.keyReady} />
				</label>
				{#if !wiz.keyReady}
					<p class="muted small">MAIL_TOKEN_KEY is not set, so the token can't be stored in the app. Set the Worker secret POSTMARK_TOKEN instead.</p>
				{/if}
				<p class="muted small">
					Streams: <code>{wiz.streams.broadcast}</code> (broadcast) and <code>{wiz.streams.transactional}</code> (transactional).
					Other names go in <a href="/settings/sending">Settings → Sending</a>.
				</p>
				<div class="actions">
					<button type="submit" disabled={busy}>{wiz.configured ? 'Save and test' : 'Connect'}</button>
					<a href={nextHref}>{savedText || wiz.configured ? 'Next' : 'Skip'}</a>
				</div>
			</form>
		{:else if wiz.step === 'webhook'}
			<h3>Postmark webhook</h3>
			<p class="small">
				Postmark reports opens, clicks, bounces and unsubscribes to <code>{wiz.webhookUrl}</code>. The button below creates that
				webhook on the broadcast stream (or finds it) and checks how the stream handles unsubscribes. It sends no email.
			</p>
			{#if !wiz.webhookKeySet}
				<p class="notice warn" role="status">WEBHOOK_KEY is not set, so the webhook would answer 401. The deploy sets it on a new install; otherwise run <code>npx wrangler secret put WEBHOOK_KEY</code>.</p>
			{/if}
			<div class="actions">
				<form method="POST" action="?/webhook" use:enhance={submit}>
					<button type="submit" disabled={busy || !wiz.configured || !wiz.webhookKeySet}>Create the webhook</button>
				</form>
				<form method="POST" action="?/revealWebhook" use:enhance={submit}>
					<button type="submit" class="secondary" disabled={busy || !wiz.webhookKeySet}>Show the URL to copy</button>
				</form>
				<a href={nextHref}>{webhook?.present ? 'Next' : 'Skip'}</a>
			</div>
			{#if !wiz.configured}<p class="muted small">Connect sending first (step 2).</p>{/if}
			{#if revealed}
				<label class="field">
					<span>Webhook URL <span class="muted">(contains the key; paste it only into Postmark)</span></span>
					<input readonly value={revealed} />
				</label>
				<div class="actions">
					<button type="button" class="secondary" onclick={() => copy(revealed)}>Copy</button>
					{#if copied}<span class="small" role="status">Copied.</span>{/if}
				</div>
			{/if}
			{#if webhook}
				<ul class="rows small">
					<li><strong>Webhook:</strong> {webhookLine}</li>
					<li><strong>Stream:</strong> {webhook.streamDetail}</li>
					<li><strong>Unsubscribe handling:</strong> {webhook.unsubscribe.summary}</li>
				</ul>
				{#if webhook.state === 'elsewhere'}
					<form method="POST" action="?/updateWebhook" use:enhance={submit}>
						<p class="small">Update moves that webhook to <code>{wiz.webhookUrl}</code> in Postmark. It sends nothing.</p>
						<div class="actions"><button type="submit" class="secondary" disabled={busy}>Update</button></div>
					</form>
				{/if}
				{#if webhook.unsubscribe.status === 'warn'}
					<form method="POST" action="?/switchUnsubscribe" use:enhance={submit}>
						<p class="small">The app's own unsubscribe link and headers should be the only path (Custom). Switching changes the stream setting in Postmark; it sends nothing.</p>
						<div class="actions"><button type="submit" class="secondary" disabled={busy}>Switch to custom</button></div>
					</form>
				{/if}
			{/if}
		{:else if wiz.step === 'test'}
			<h3>Send yourself a test</h3>
			<p class="small">One email to your own address, from the Default From, on the transactional stream. Nothing else is sent.</p>
			<div class="actions">
				<form method="POST" action="?/test" use:enhance={submit}>
					<button type="submit" disabled={busy || !wiz.configured}>Send me a test</button>
				</form>
				<a href={nextHref}>{savedText ? 'Next' : 'Skip'}</a>
			</div>
			{#if !wiz.configured}<p class="muted small">Connect sending first (step 2).</p>{/if}
		{:else}
			<h3>Done</h3>
			<p class="small">
				The checklist below shows anything still missing. Optional parts stay off until you set them up; you can reopen this
				wizard any time from this page.
			</p>
			{#if optionalRows.length}
				<ul class="rows small">
					{#each optionalRows as c (c.id)}
						<li>{#if c.href}<a href={c.href}>{c.label}</a>{:else}{c.label}{/if}: {c.detail}</li>
					{/each}
				</ul>
			{/if}
			<div class="actions"><a href="/settings/setup">Close the wizard</a></div>
		{/if}
	</section>
{:else}
	<p class="small"><a href="?wizard=address">Open the setup wizard</a> to connect sending step by step.</p>
{/if}

<p class="muted intro">
	What this install needs to work, checked each time you open the page. Secrets show only as set or not set.
</p>
{#if data.attention > 0}
	<p class="notice warn" role="alert">{data.attention} {data.attention === 1 ? 'check needs' : 'checks need'} attention.</p>
{:else}
	<p class="notice ok" role="status">Every required and Postmark check is ready.</p>
{/if}

{#each GROUPS as g (g.id)}
	{@const rows = data.checks.filter((c) => c.group === g.id)}
	{#if rows.length}
		<section class="card">
			<h2>{g.title}</h2>
			<p class="muted small">{g.intro}</p>
			<ul class="checks">
				{#each rows as c (c.id)}
					<li id={`check-${c.id}`}>
						<div class="head">
							<strong>{c.label}</strong>
							<span class="badge {STATE_CLASS[c.state]}">{STATE_LABEL[c.state]}</span>
						</div>
						<p class="small">{c.detail}</p>
						{#if c.fix}<p class="small muted">Fix: {c.fix}</p>{/if}
						{#if c.href}<p class="small"><a href={c.href}>Open settings</a></p>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/each}

<style>
	.intro { margin-bottom: var(--space-m); }
	.checks { list-style: none; margin: 0; padding: 0; }
	.checks li { padding: var(--space-s) 0; border-top: 1px solid var(--border, var(--neutral-3)); }
	.checks li:first-child { border-top: 0; }
	.head { display: flex; gap: var(--space-s); align-items: center; justify-content: space-between; flex-wrap: wrap; }
	.checks p { margin: var(--space-3xs, 2px) 0 0; }
	.small { font-size: var(--size-s, 0.875rem); }
	.wizard { margin-bottom: var(--space-m); }
	.steps { list-style: none; margin: 0 0 var(--space-s); padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-xs, 8px) var(--space-m); }
	.steps a { font-size: var(--size-s, 0.875rem); }
	.steps a.current { font-weight: 600; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs, 4px); margin: var(--space-s) 0; }
	.check { display: flex; gap: var(--space-xs, 8px); align-items: center; }
	fieldset { border: 0; margin: 0; padding: 0; }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-s); align-items: center; margin-top: var(--space-s); }
	.rows { margin: var(--space-s) 0 0; padding-left: 1.2em; }
</style>

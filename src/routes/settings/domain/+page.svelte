<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	let busy = $state<string | null>(null);

	const SOURCE_LABEL: Record<string, string> = {
		setting: 'this page',
		env: 'the PUBLIC_BASE_URL var in wrangler.jsonc',
		request: 'the address you opened the app on (nothing else is set)',
		none: 'nothing set'
	};

	const errorFor = (action: string) => (form && 'error' in form && form.action === action ? form.error : null);
	const status = $derived(form && form.action === 'status' && 'status' in form && form.status ? form.status : data.status);
	const attach = $derived(form && form.action === 'attach' && 'attach' in form ? form.attach : null);
	const canRedirect = $derived(!!data.domain && !!status?.ok && status.domain === data.domain);

	function when(iso: string): string {
		const d = new Date(iso);
		return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
	}

	const track = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = null;
		};
	};
</script>

<svelte:head><title>Domain</title></svelte:head>

<h1>Domain</h1>
<p class="muted intro">
	The public address of this app. Unsubscribe links (and the List-Unsubscribe header), hosted
	pages, uploaded image URLs, the tracking snippet and the URLs shown in Settings are all built
	from it. Already-sent emails keep the address they were sent with, so the old one stays live.
</p>

<section class="card">
	<h2>Current address</h2>
	<p class="effective"><code>{data.effective.url || '—'}</code></p>
	<p class="muted small">From {SOURCE_LABEL[data.effective.source]}.{#if data.domain && data.envBase} The wrangler var (<code>{data.envBase}</code>) is used again if you clear this.{/if}</p>

	<form method="POST" action="?/save" use:enhance={track('save')} class="row">
		<label class="field grow">
			<span>Custom domain</span>
			<input
				name="hostname"
				value={form && form.action === 'save' && 'hostname' in form ? form.hostname : (data.domain ?? '')}
				placeholder="crm.example.com"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				required
			/>
		</label>
		<button type="submit" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
	</form>
	<p class="muted small">Just the hostname — no <code>https://</code>, no path.</p>
	{#if errorFor('save')}<p class="err">{errorFor('save')}</p>{/if}
	{#if data.domain}
		<form method="POST" action="?/clear" use:enhance={({ cancel }) => {
			if (!confirm('Clear the custom domain? Links go back to the wrangler var and the redirect turns off.')) cancel();
			return track('clear')();
		}}>
			<button type="submit" class="secondary sm" disabled={busy !== null}>Clear</button>
		</form>
	{/if}
</section>

{#if data.domain}
	<section class="card">
		<h2>Attach to this Worker</h2>
		{#if data.hasToken}
			<p class="muted">Adds <code>{data.domain}</code> as a custom domain of <code>{data.service}</code> through the Cloudflare API (the zone must be on this account).</p>
			<form method="POST" action="?/attach" use:enhance={track('attach')}>
				<button type="submit" class="secondary" disabled={busy !== null}>{busy === 'attach' ? 'Attaching…' : 'Attach to this Worker'}</button>
			</form>
		{:else}
			<ol class="steps">
				<li>In the Cloudflare dashboard open <strong>Workers &amp; Pages</strong> → <strong>{data.service}</strong>.</li>
				<li><strong>Settings</strong> → <strong>Domains &amp; Routes</strong> → <strong>Add</strong> → <strong>Custom domain</strong>.</li>
				<li>Enter <code>{data.domain}</code> and save. DNS and the certificate are created for you, usually within a few minutes.</li>
			</ol>
			<details class="token">
				<summary>One-click attach: set a Cloudflare API token</summary>
				<p class="muted">Create a custom token (My Profile → API Tokens → Create token → Custom) with:</p>
				<ul>
					<li><strong>Account</strong> · Workers Scripts · Edit — this account only</li>
					<li><strong>Zone</strong> · Zone · Read — the domain's zone</li>
					<li><strong>Zone</strong> · DNS · Edit — the domain's zone</li>
					<li><strong>Zone</strong> · Workers Routes · Edit — the domain's zone</li>
				</ul>
				<p class="muted">Then store it on the Worker: <code>npx wrangler secret put CF_API_TOKEN</code>. This page then shows an Attach button instead of these steps.</p>
			</details>
		{/if}
		{#if errorFor('attach')}<p class="err">{errorFor('attach')}</p>{/if}
		{#if attach && attach.mode === 'api'}
			<p class={attach.ok ? 'ok' : 'err'}>{attach.message}</p>
			{#if attach.result}<pre><code>{JSON.stringify(attach.result, null, 2)}</code></pre>{/if}
		{/if}
	</section>

	<section class="card">
		<h2>Check status</h2>
		<p class="muted">Loads <code>https://{data.domain}/login</code> from the Worker.</p>
		<div class="row">
			<form method="POST" action="?/status" use:enhance={track('status')}>
				<button type="submit" class="secondary" disabled={busy !== null}>{busy === 'status' ? 'Checking…' : 'Check status'}</button>
			</form>
			{#if status}
				<span class="badge {status.ok ? 'sent' : 'failed'}">{status.ok ? 'Reachable' : 'Not reachable'}</span>
				<span class="muted small">
					{status.code !== null ? `HTTP ${status.code}` : (status.error ?? 'no response')} · {when(status.checkedAt)}
				</span>
			{:else}
				<span class="muted small">Not checked yet.</span>
			{/if}
		</div>
		{#if errorFor('status')}<p class="err">{errorFor('status')}</p>{/if}
	</section>

	<section class="card">
		<h2>After attaching</h2>
		<ul class="checklist">
			<li><strong>GitHub sign-in:</strong> the GitHub OAuth App's callback must be <code>https://{data.domain}/auth/github/callback</code>, or sign-in on the new address fails. A GitHub OAuth App has one callback URL — make a second app if both addresses need sign-in.</li>
			<li><strong>Webhooks:</strong> Postmark, form webhooks, Luma, the heartbeat and API clients can stay on the old address — those paths answer on every host and are never redirected.</li>
			<li><strong>Unsubscribe:</strong> the List-Unsubscribe URL and the footer link switch to the new address automatically on the next send.</li>
		</ul>
	</section>

	<section class="card">
		<h2>Redirect other hosts to this domain</h2>
		<p class="muted">
			When on, opening the app on any other address (e.g. the workers.dev one) sends the browser
			to <code>https://{data.domain}</code> with the same path. Webhooks, the API, unsubscribe
			one-click, images and tracking keep answering on every address. It can only be turned on
			after a passing status check, so a broken domain can't lock you out.
		</p>
		<form method="POST" action="?/redirect" use:enhance={track('redirect')} class="row">
			<input type="hidden" name="redirect" value={data.redirect ? 'off' : 'on'} />
			<span class="badge {data.redirect ? 'sent' : 'draft'}">{data.redirect ? 'On' : 'Off'}</span>
			<button type="submit" class="secondary sm" disabled={busy !== null || (!data.redirect && !canRedirect)}>
				{data.redirect ? 'Turn off' : 'Turn on'}
			</button>
			{#if !data.redirect && !canRedirect}<span class="muted small">Run Check status first.</span>{/if}
		</form>
		{#if errorFor('redirect')}<p class="err">{errorFor('redirect')}</p>{/if}
	</section>
{/if}

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); }
	section.card p { max-width: 70ch; }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	pre { margin: var(--space-xs) 0; padding: var(--space-xs) var(--space-s); background: var(--surface); border-radius: var(--radius-xs); overflow-x: auto; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	pre code { background: none; padding: 0; }
	.effective code { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.ok { margin: var(--space-xs) 0; }
	.row { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; }
	.row form { margin: 0; }
	form.row { align-items: flex-end; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.grow { flex: 1; min-width: 16rem; max-width: 28rem; }
	.steps, .checklist, .token ul { padding-left: var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.steps li, .checklist li { margin-bottom: var(--space-xxs); }
	.token summary { cursor: pointer; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
</style>

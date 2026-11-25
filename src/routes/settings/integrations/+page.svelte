<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import type { SubmitFunction } from '$app/forms';
	let { data, form } = $props();

	const STATE_LABEL: Record<string, string> = {
		not_configured: 'Not connected',
		untested: 'Token set — not tested yet',
		connected: 'Connected',
		rejected: 'Token set but rejected',
		error: 'Token set — check failed'
	};
	const STATE_BADGE: Record<string, string> = {
		not_configured: 'draft',
		untested: 'draft',
		connected: 'sent',
		rejected: 'failed',
		error: 'sending'
	};

	let busy = $state<string | null>(null);
	// Which card has its "Set token" field open.
	let editing = $state<string | null>(null);

	function summary(detail: string | null): string {
		if (!detail) return '';
		try {
			const d = JSON.parse(detail) as {
				counts?: Record<string, number>;
				errors?: string[];
				error?: string;
				action?: string;
				last4?: string | null;
			};
			if (d.error) return d.error;
			if (d.action) return `token ${d.action}${d.last4 ? ` (•••• ${d.last4})` : ''}`;
			const counts = Object.entries(d.counts ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`);
			const errs = d.errors?.length ? [`${d.errors.length} error${d.errors.length === 1 ? '' : 's'}`] : [];
			return [...counts, ...errs].join(' · ');
		} catch {
			return detail;
		}
	}

	function pretty(detail: string | null): string {
		if (!detail) return '';
		try {
			return JSON.stringify(JSON.parse(detail), null, 2);
		} catch {
			return detail;
		}
	}

	const resultLabel = (ok: number | null) => (ok === 1 ? 'OK' : ok === 0 ? 'Failed' : 'Running');
	const resultBadge = (ok: number | null) => (ok === 1 ? 'sent' : ok === 0 ? 'failed' : 'sending');
	// The action error for one card (test/sync failures carry the provider id).
	const errorFor = (id: string) =>
		form && 'error' in form && 'provider' in form && form.provider === id ? form.error : null;
	const labelFor = (id: string) => data.providers.find((p) => p.provider === id)?.label ?? id;
	const noticeFor = (id: string) => {
		if (!form || !('provider' in form) || form.provider !== id) return null;
		if ('tokenSaved' in form) return 'Token saved and tested.';
		if ('tokenRemoved' in form) {
			return form.fallback ? 'In-app token removed — now using the Worker secret.' : 'In-app token removed — not connected.';
		}
		if ('zohoConnected' in form) {
			if ('orgError' in form && form.orgError) return null;
			return form.orgCount === 1 ? 'Connected — organization picked.' : 'Connected — now pick the organization.';
		}
		if ('zohoDisconnected' in form) return 'Disconnected. Company links and synced rows are kept.';
		if ('orgSaved' in form) return `Organization set to ${form.orgSaved}.`;
		if ('orgCount' in form) return `Found ${form.orgCount} organization${form.orgCount === 1 ? '' : 's'}.`;
		if ('accessSaved' in form) return 'Billing visibility saved.';
		return null;
	};
	const orgErrorFor = (id: string) =>
		form && 'orgError' in form && 'provider' in form && form.provider === id ? form.orgError : null;
	const z = $derived(data.zoho);
	let zohoReconnect = $state(false);
	// Plain (unenhanced-reset) busy wrapper for the Zoho forms.
	const zohoEnhance = (key: string): SubmitFunction => () => {
		busy = key;
		return async ({ formElement, result, update }) => {
			formElement.reset();
			if (result.type === 'success') zohoReconnect = false;
			await update();
			busy = null;
		};
	};

	// Reset the token form on every result, so a typed token never lingers after an error.
	const tokenEnhance = (key: string): SubmitFunction => () => {
		busy = key;
		return async ({ formElement, result, update }) => {
			formElement.reset();
			if (result.type === 'success') editing = null;
			await update();
			busy = null;
		};
	};
</script>

<svelte:head><title>Integrations</title></svelte:head>

{#snippet zohoCard()}
	{@const zp = data.providers.find((x) => x.provider === 'zoho_books')}
	<div class="token">
		{#if z.connected}
			<p class="token-line">
				<span class="tlabel">Client</span>
				<span>•••• {zp?.token.last4}</span>
				<span class="muted">
					· accounts.zoho.{z.dc}{#if zp?.token.setBy}{' '}· connected by @{zp.token.setBy}{/if}{#if zp?.token.setAt}{' '}on {zp.token.setAt.slice(0, 10)}{/if}
				</span>
			</p>
			<p class="token-line">
				<span class="tlabel">Organization</span>
				{#if z.org}<span>{z.org.name}</span>{#if z.org.currency_code}<span class="muted"> · totals in {z.org.currency_code}</span>{/if}
				{:else}<span class="muted">not picked yet — nothing syncs until you pick one</span>{/if}
			</p>
			{#if z.orgs.length > 1 || (!z.org && z.orgs.length)}
				<form class="token-form" method="POST" action="?/zohoOrg" use:enhance={zohoEnhance('zoho:org')}>
					<label class="sr-only" for="zoho-org">Organization</label>
					<select id="zoho-org" name="organization_id" required>
						{#each z.orgs as o (o.id)}
							<option value={o.id} selected={o.id === z.org?.id}>{o.name}{o.currency_code ? ` (${o.currency_code})` : ''}</option>
						{/each}
					</select>
					<button type="submit" class="sm" disabled={busy !== null}>{busy === 'zoho:org' ? 'Saving…' : 'Use'}</button>
				</form>
			{/if}
			<div class="actions">
				<form method="POST" action="?/zohoOrgs" use:enhance={zohoEnhance('zoho:orgs')}>
					<button type="submit" class="secondary sm" disabled={busy !== null}>{busy === 'zoho:orgs' ? 'Loading…' : 'Refresh organizations'}</button>
				</form>
				<button type="button" class="secondary sm" disabled={!data.tokenKeyReady || busy !== null} onclick={() => (zohoReconnect = !zohoReconnect)}>Reconnect</button>
				<form
					method="POST"
					action="?/zohoDisconnect"
					use:enhance={({ cancel }) => {
						if (!confirm('Disconnect Zoho Books? Company links and synced invoices are kept.')) {
							cancel();
							return;
						}
						busy = 'zoho:disconnect';
						return async ({ update }) => {
							await update();
							busy = null;
						};
					}}
				>
					<button type="submit" class="secondary sm" disabled={busy !== null}>{busy === 'zoho:disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
				</form>
			</div>
		{:else}
			<p class="token-line"><span class="tlabel">Connection</span><span class="muted">not connected</span></p>
			{#if zp?.token.storedUnusable}
				<p class="muted small">A Zoho config is stored but can't be opened (MAIL_TOKEN_KEY missing or changed) — connect again.</p>
			{/if}
		{/if}
		{#if (!z.connected || zohoReconnect) && data.tokenKeyReady}
			<form class="zoho-form" method="POST" action="?/zohoConnect" autocomplete="off" use:enhance={zohoEnhance('zoho:connect')}>
				<label>
					<span>Data center</span>
					<select name="dc" required>
						{#each z.dcs as dc (dc)}<option value={dc} selected={dc === (z.dc ?? 'com')}>zoho.{dc}</option>{/each}
					</select>
				</label>
				<label><span>Client ID</span><input name="client_id" required autocomplete="off" spellcheck="false" /></label>
				<label><span>Client secret</span><input type="password" name="client_secret" required autocomplete="off" spellcheck="false" /></label>
				<label><span>Grant code</span><input type="password" name="code" required autocomplete="off" spellcheck="false" /></label>
				<button type="submit" class="sm" disabled={busy !== null}>{busy === 'zoho:connect' ? 'Connecting…' : 'Connect'}</button>
			</form>
		{/if}
		{#if !data.tokenKeyReady}
			<p class="muted small">Set MAIL_TOKEN_KEY to connect Zoho Books.</p>
		{/if}
		<form class="access" method="POST" action="?/zohoAccess" use:enhance={zohoEnhance('zoho:access')}>
			<label class="check">
				<input type="checkbox" name="member_access" value="1" checked={z.memberAccess} />
				Members can see billing (invoices, payments, balances)
			</label>
			<button type="submit" class="secondary sm" disabled={busy !== null}>Save</button>
		</form>
		<p class="muted small">Off: only admins see the company Billing panel. Read-only — nothing is ever written to Zoho.</p>
	</div>
	<details class="howto" open={!z.connected}>
		<summary>{z.connected ? 'Connection help' : 'How to connect'}</summary>
		<ol class="steps">
			<li>Open <a href="https://api-console.zoho.com" target="_blank" rel="noopener noreferrer">api-console.zoho.com</a> (signed in as a Zoho Books admin) → <strong>Add Client</strong> → <strong>Self Client</strong> → Create.</li>
			<li>On the <strong>Client Secret</strong> tab, copy the client ID and client secret.</li>
			<li>On the <strong>Generate Code</strong> tab, paste this scope string exactly:
				<pre><code>{z.scopes}</code></pre>
				pick a time duration (10 minutes is plenty), add a description, Create, and pick your Zoho Books organization.</li>
			<li>Copy the grant code and connect <strong>right away</strong> — grant codes expire in minutes and work once.</li>
			<li><strong>Data center</strong> = the domain you sign in to Zoho on: zoho.com (US), zoho.eu, zoho.in, zoho.com.au, zoho.jp, zoho.ca or zoho.sa. A mismatch fails with "client rejected".</li>
			<li>Then pick the organization. Link companies to Zoho customers from each company's page.</li>
		</ol>
	</details>
{/snippet}

<h1>Integrations</h1>
<p class="muted intro">
	Outside services this app pulls data from. Paste a token here (stored encrypted; only its
	last 4 characters are ever shown) or set it as a <strong>Worker secret</strong> — a token set
	here wins. Each connected service syncs on the heartbeat at most every 6 hours;
	<strong>Sync now</strong> runs one immediately.
</p>

{#if !data.tokenKeyReady}
	<p class="keynote">
		Set <code>MAIL_TOKEN_KEY</code> to enable in-app tokens:
		<code>npx wrangler secret put MAIL_TOKEN_KEY</code> (32 random bytes, base64url). Until then
		tokens can only be Worker secrets.
	</p>
{/if}

{#if form && 'error' in form && !('provider' in form)}<p class="err">{form.error}</p>{/if}

<div class="cards">
	{#each data.providers as p (p.provider)}
		<section class="card provider">
			<div class="phead">
				<h2>{#if p.provider === 'timing' || p.provider === 'github'}<Icon name={p.provider} size={20} />{/if} {p.label}</h2>
				<span class="badge {STATE_BADGE[p.state]}">{STATE_LABEL[p.state]}</span>
			</div>

			{#if p.probe}
				<p class="probe muted">{p.probe.detail} · checked {p.probe.checkedAt.slice(0, 16).replace('T', ' ')} UTC</p>
			{/if}

			{#if errorFor(p.provider)}
				<p class="err">{errorFor(p.provider)}</p>
			{/if}
			{#if noticeFor(p.provider)}
				<p class="ok">{noticeFor(p.provider)}</p>
			{/if}
			{#if orgErrorFor(p.provider)}
				<p class="err">{orgErrorFor(p.provider)}</p>
			{/if}

			{#if p.provider === 'zoho_books'}
				{@render zohoCard()}
			{:else}
			<div class="token">
				<p class="token-line">
					<span class="tlabel">Token</span>
					{#if p.token.source === 'app'}
						<span>•••• {p.token.last4}</span>
						<span class="muted">
							· set{#if p.token.setBy}{' '}by @{p.token.setBy}{/if}{#if p.token.setAt}{' '}on {p.token.setAt.slice(0, 10)}{/if} · from app
						</span>
					{:else if p.token.source === 'worker'}
						<span>•••• {p.token.last4}</span>
						<span class="muted">· from Worker secret</span>
					{:else}
						<span class="muted">not set</span>
					{/if}
				</p>
				{#if p.token.storedUnusable}
					<p class="muted small">
						An in-app token is stored but can't be opened (MAIL_TOKEN_KEY missing or changed) —
						{p.token.workerSecret ? 'using the Worker secret instead.' : 'set it again or remove it.'}
					</p>
				{/if}
				<div class="actions">
					<button
						type="button"
						class="secondary sm"
						disabled={!data.tokenKeyReady || busy !== null}
						title={data.tokenKeyReady ? undefined : 'Set MAIL_TOKEN_KEY to enable in-app tokens'}
						onclick={() => (editing = editing === p.provider ? null : p.provider)}
					>
						{p.token.stored ? 'Replace token' : 'Set token'}
					</button>
					{#if p.token.stored}
						<form method="POST" action="?/removeToken" use:enhance={tokenEnhance(`remove:${p.provider}`)}>
							<input type="hidden" name="provider" value={p.provider} />
							<button
								type="submit"
								class="secondary sm"
								disabled={busy !== null}
								title={p.token.workerSecret ? 'Falls back to the Worker secret' : 'Disconnects — no Worker secret is set'}
							>
								{busy === `remove:${p.provider}` ? 'Removing…' : 'Remove'}
							</button>
						</form>
					{/if}
				</div>
				{#if !data.tokenKeyReady}
					<p class="muted small">Set MAIL_TOKEN_KEY to enable in-app tokens.</p>
				{/if}
				{#if p.token.stored}
					<p class="muted small">
						Remove {p.token.workerSecret ? 'falls back to the Worker secret.' : 'disconnects (no Worker secret is set).'}
					</p>
				{/if}
				{#if editing === p.provider && data.tokenKeyReady}
					<form
						class="token-form"
						method="POST"
						action="?/setToken"
						autocomplete="off"
						use:enhance={tokenEnhance(`set:${p.provider}`)}
					>
						<input type="hidden" name="provider" value={p.provider} />
						<label class="sr-only" for="token-{p.provider}">{p.label} token</label>
						<input
							id="token-{p.provider}"
							type="password"
							name="token"
							autocomplete="off"
							spellcheck="false"
							placeholder="Paste {p.label} token"
							required
						/>
						<button type="submit" class="sm" disabled={busy !== null}>
							{busy === `set:${p.provider}` ? 'Saving…' : 'Save'}
						</button>
					</form>
				{/if}
				{#if p.provider === 'github'}
					<details class="howto">
						<summary>What token do I need?</summary>
						<p class="muted">
							Read-only. The app only reads repos, their issues and issue search.
						</p>
						<p>
							<strong>Recommended:</strong>
							<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">a fine-grained token</a>
						</p>
						<ul>
							<li>
								<strong>Resource owner</strong> must be the account or org that owns the repos (for
								example the org, not your personal account). You can't change it later, and one token
								covers one owner.
							</li>
							<li>Repository access: All repositories, or select the ones you'll attach.</li>
							<li>
								Repository permissions: <strong>Issues: Read-only</strong> (Metadata is added
								automatically). Nothing else.
							</li>
							<li>
								If the org requires approval, an org owner approves it under Org settings → Personal
								access tokens → Pending requests.
							</li>
						</ul>
						<p>
							<strong>Alternative:</strong>
							<a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer">a classic token</a>
							with the <code>repo</code> scope (covers personal and org repos, but is broader than
							needed). If the org uses SAML SSO, click Configure SSO → Authorize on the token.
						</p>
						<p class="muted">A private repo the token can't see comes back as "not found".</p>
					</details>
				{:else if p.provider === 'timing'}
					<details class="howto">
						<summary>What token do I need?</summary>
						<p>
							An API key from the
							<a href="https://web.timingapp.com" target="_blank" rel="noopener noreferrer">Timing web app</a>
							(Account → API Keys → generate a key).
						</p>
						<p class="muted">The key is long. Paste it exactly as copied.</p>
					</details>
				{/if}
			</div>
			{/if}

			{#if p.configured}
				<p class="last">
					Last sync:
					{#if p.lastSync}
						<span class="badge {resultBadge(p.lastSync.ok)}">{resultLabel(p.lastSync.ok)}</span>
						<span class="muted">{p.lastSync.started_at} UTC ({p.lastSync.trigger}){#if summary(p.lastSync.detail)}{' '}· {summary(p.lastSync.detail)}{/if}</span>
					{:else}
						<span class="muted">never</span>
					{/if}
				</p>
				<div class="actions">
					<form
						method="POST"
						action="?/test"
						use:enhance={() => {
							busy = `test:${p.provider}`;
							return async ({ update }) => {
								await update();
								busy = null;
							};
						}}
					>
						<input type="hidden" name="provider" value={p.provider} />
						<button type="submit" class="secondary sm" disabled={busy !== null}>
							{busy === `test:${p.provider}` ? 'Testing…' : 'Test connection'}
						</button>
					</form>
					<form
						method="POST"
						action="?/sync"
						use:enhance={() => {
							busy = `sync:${p.provider}`;
							return async ({ update }) => {
								await update();
								busy = null;
							};
						}}
					>
						<input type="hidden" name="provider" value={p.provider} />
						<button type="submit" class="sm" disabled={busy !== null}>
							{busy === `sync:${p.provider}` ? 'Syncing…' : 'Sync now'}
						</button>
					</form>
				</div>
			{/if}

			{#if p.provider !== 'zoho_books'}
			<details class="howto" open={!p.configured}>
				<summary>{p.configured ? 'Token help' : 'How to connect'}</summary>
				<p class="muted">
					Create a token in {p.tokenHelp}, then paste it with <strong>Set token</strong>. Or keep it
					as a Worker secret (used when no token is set here):
				</p>
				<pre><code>npx wrangler secret put {p.secretName}</code></pre>
				<p class="muted">
					For local dev add <code>{p.secretName}=…</code> to <code>.dev.vars</code>. To drop the
					secret: <code>npx wrangler secret delete {p.secretName}</code>.
				</p>
			</details>
			{/if}
		</section>
	{/each}

	<section class="card provider">
		<div class="phead">
			<h2><Icon name="gmail" size={20} /> Gmail</h2>
		</div>
		<p class="muted">Gmail is connected per mailbox under <a href="/settings/mail">Settings → Mail</a>.</p>
	</section>
</div>

<section class="card">
	<h2>Sync log <span class="muted">(last 20 runs)</span></h2>
	{#if data.syncs.length === 0}
		<p class="muted">No syncs yet.</p>
	{:else}
		<ul class="log">
			{#each data.syncs as s (s.id)}
				<li>
					<details>
						<summary>
							<span class="badge {resultBadge(s.ok)}">{resultLabel(s.ok)}</span>
							<strong>{labelFor(s.provider)}</strong>
							<span class="muted">{s.started_at} UTC · {s.trigger}{#if summary(s.detail)}{' '}· {summary(s.detail)}{/if}</span>
						</summary>
						<pre class="detail">{pretty(s.detail) || 'No detail recorded.'}</pre>
						{#if s.finished_at}<p class="muted hint">Finished {s.finished_at} UTC</p>{/if}
					</details>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.ok { color: var(--success); margin: var(--space-xs) 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.keynote { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-m); padding: var(--space-xs) var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius-xs); max-width: 72ch; }
	.token { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-xs) 0; box-shadow: inset 0 var(--border-s) 0 var(--border), inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.token-line { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); overflow-wrap: anywhere; }
	.tlabel { font-weight: var(--weight-ui-heavy); margin-right: var(--space-xs); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0; }
	.token-form { display: flex; gap: var(--space-xs); margin: 0; }
	.token-form input[type='password'] { flex: 1; min-width: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-m); margin-bottom: var(--space-m); }
	.provider { display: flex; flex-direction: column; gap: var(--space-xs); margin: 0; }
	.provider.disabled { opacity: 0.6; }
	.phead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); flex-wrap: wrap; }
	.probe, .last { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0; overflow-wrap: anywhere; }
	.actions { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
	.actions form { margin: 0; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.howto { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.howto summary { cursor: pointer; color: var(--muted); }
	.howto p { margin: var(--space-xs) 0; }
	.howto ul { margin: var(--space-xs) 0; padding-left: var(--space-m); }
	.howto li { margin: 0 0 var(--space-xxs); }
	.steps { margin: var(--space-xs) 0; padding-left: var(--space-m); display: flex; flex-direction: column; gap: var(--space-xs); }
	.zoho-form { display: flex; flex-direction: column; gap: var(--space-xs); margin: 0; }
	.zoho-form label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.zoho-form button { align-self: flex-start; }
	.access { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; margin: 0; }
	.check { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	pre { margin: var(--space-xs) 0; padding: var(--space-xs) var(--space-s); background: var(--surface); border-radius: var(--radius-xs); overflow-x: auto; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	pre code { background: none; padding: 0; }
	.log { list-style: none; margin: 0; padding: 0; }
	.log li { padding: var(--space-xs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.log li:last-child { box-shadow: none; }
	.log summary { cursor: pointer; display: flex; align-items: baseline; gap: var(--space-xs); flex-wrap: wrap; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.detail { white-space: pre-wrap; overflow-wrap: anywhere; }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0; }
</style>

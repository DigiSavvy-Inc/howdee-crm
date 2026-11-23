<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	let { data, form } = $props();

	const ERRORS: Record<string, string> = {
		admin: 'Only admins can connect a mailbox.',
		taken: 'That mailbox is already connected by another teammate. They (or an admin) can disconnect it first.',
		not_configured: 'Gmail isn’t set up yet — see the steps below.',
		state: 'The Google sign-in expired or didn’t match — try Connect Gmail again.',
		denied: 'Google access wasn’t granted.',
		google: 'Google didn’t return a usable token. Try again; if it repeats, revoke the app at myaccount.google.com → Security → Third-party access and reconnect.'
	};
	const MODE: Record<string, string> = {
		backfill: 'Backfilling the last year',
		relist: 'Re-listing the last 30 days',
		incremental: 'Up to date — new mail syncs every minute'
	};

	const ready = $derived(data.googleConfigured && data.tokenKeyReady);
	let busy = $state<string | null>(null);
	const track = (key: string): SubmitFunction => () => {
		busy = key;
		return async ({ update }) => {
			await update();
			busy = null;
		};
	};
	// #443: what the re-filter removed from stored mail.
	const purgedText = (p: { links: number; messages: number; threads: number } | undefined) =>
		p && (p.links || p.messages || p.threads)
			? `Removed ${p.messages} internal or automated message${p.messages === 1 ? '' : 's'} in ${p.threads} thread${p.threads === 1 ? '' : 's'} (${p.links} contact link${p.links === 1 ? '' : 's'}).`
			: 'Nothing internal or automated left to remove.';
	const confirmDisconnect = (email: string) => (e: Event) => {
		if (!confirm(`Disconnect ${email}? Its synced threads are removed from the app (Gmail itself is untouched).`)) e.preventDefault();
	};
</script>

<svelte:head><title>Mail</title></svelte:head>

<h1>Mail</h1>
<p class="muted intro">
	Connect a Gmail mailbox so your 1:1 email with contacts shows up on their contact page. Read-only
	(<code>gmail.readonly</code>): only messages where a From/To/Cc address outside your internal
	domains is a contact are kept — metadata on sync, bodies when you open a message. Promotions,
	Social, Updates, Forums and automated mail (mailing lists, receipts, no-reply senders, auto-replies)
	are skipped.
</p>
<p class="muted intro">
	Replies you send from Gmail — or from Apple Mail, Outlook or a phone, as long as they go out through
	the connected Google mailbox, including its send-as aliases — join the conversation they answer
	(also when you answer a “via” forward of a contact’s reply) and clear “Awaiting reply”. Each
	teammate connects their own mailbox here; mail sent from a mailbox nobody connected isn’t seen.
	{#if !data.isAdmin}You see the mailbox you connected; admins manage every mailbox.{/if}
</p>

{#if data.error}<p class="err">{ERRORS[data.error] ?? 'Something went wrong connecting Gmail.'}</p>{/if}
{#if data.connected}<p class="ok">Gmail connected — the first backfill runs on the next heartbeat (or press Sync now).</p>{/if}
{#if form && 'error' in form}<p class="err">{form.error}</p>{/if}
{#if form && 'synced' in form && form.synced}
	<p class="ok">
		Synced: {form.synced.scanned} looked at, {form.synced.stored} kept{form.synced.done ? ' — backfill complete' : ''}.
		{purgedText(form.synced.purged)}
	</p>
{/if}
{#if form && 'domainsSaved' in form && form.domainsSaved}
	<p class="ok">
		Internal domains saved{form.domainsSaved.length ? `: ${form.domainsSaved.join(', ')}` : ' (none)'}. {purgedText(form.purged)}
	</p>
{/if}
{#if form && 'inConversations' in form}
	<p class="ok">Gmail threads are {form.inConversations ? 'now shown' : 'no longer shown'} in Conversations.</p>
{/if}
{#if form && 'disconnected' in form}
	<p class="ok">Disconnected{form.revoked ? ' and revoked at Google' : ' (Google revoke failed — remove the app under myaccount.google.com → Security if needed)'}.</p>
{/if}

{#if !data.isAdmin && !data.accounts.length}
	<p class="muted">You haven’t connected a mailbox yet.</p>
{/if}

{#each data.accounts as a (a.id)}
	<section class="card">
		<div class="phead">
			<h2>{a.email}</h2>
			{#if a.paused}
				<span class="badge draft">Paused</span>
			{:else if a.last_error}
				<span class="badge failed">Error</span>
			{:else}
				<span class="badge sent">Connected</span>
			{/if}
		</div>
		<dl class="facts">
			<dt>Status</dt>
			<dd>
				{MODE[a.mode]}{#if a.mode !== 'incremental'} — {a.scanned} message{a.scanned === 1 ? '' : 's'} looked at so far (≤200 per minute){/if}
			</dd>
			<dt>Last sync</dt>
			<dd>{a.last_sync_at ? `${a.last_sync_at} UTC` : 'never'}</dd>
			<dt>Synced</dt>
			<dd>{a.threads} thread{a.threads === 1 ? '' : 's'} · {a.messages} message{a.messages === 1 ? '' : 's'}</dd>
			<dt>Connected</dt>
			<dd>{a.connected_at} UTC{#if a.connected_by} by @{a.connected_by}{/if}</dd>
			{#if a.last_error}
				<dt>Error</dt>
				<dd class="err">{a.last_error}{#if a.backoff_until}{' '}· retrying after {a.backoff_until.slice(0, 16).replace('T', ' ')} UTC{/if}</dd>
			{/if}
		</dl>
		<div class="actions">
			<form method="POST" action="?/sync" use:enhance={track(`sync:${a.id}`)}>
				<input type="hidden" name="account_id" value={a.id} />
				<button type="submit" class="sm" disabled={busy !== null || !ready}>
					{busy === `sync:${a.id}` ? 'Syncing…' : 'Sync now'}
				</button>
			</form>
			<form method="POST" action="?/pause" use:enhance={track(`pause:${a.id}`)}>
				<input type="hidden" name="account_id" value={a.id} />
				<input type="hidden" name="paused" value={a.paused ? '0' : '1'} />
				<button type="submit" class="secondary sm" disabled={busy !== null}>{a.paused ? 'Resume' : 'Pause'}</button>
			</form>
			<form method="POST" action="?/disconnect" use:enhance={track(`disc:${a.id}`)} onsubmit={confirmDisconnect(a.email)}>
				<input type="hidden" name="account_id" value={a.id} />
				<button type="submit" class="secondary sm danger" disabled={busy !== null}>
					{busy === `disc:${a.id}` ? 'Disconnecting…' : 'Disconnect'}
				</button>
			</form>
		</div>
	</section>
{/each}

{#if data.isAdmin}
<section class="card">
	<h2>What counts as a conversation</h2>
	<form method="POST" action="?/internalDomains" class="field" use:enhance={track('domains')}>
		<label for="internal-domains">Internal domains</label>
		<p class="muted small">
			Mail between your own people never makes a conversation: addresses at these domains (comma-separated),
			connected mailboxes and users’ emails are never linked to a contact. Saving also removes what is already
			stored. Default: the domain of each connected mailbox.
		</p>
		<div class="row">
			<input id="internal-domains" name="internal_domains" value={data.internalDomains} placeholder="example.com" autocomplete="off" />
			<button type="submit" class="secondary sm" disabled={busy !== null}>{busy === 'domains' ? 'Saving…' : 'Save'}</button>
		</div>
	</form>
	<form method="POST" action="?/inConversations" class="field" use:enhance={track('conv')}>
		<input type="hidden" name="on" value={data.inConversations ? '0' : '1'} />
		<span class="label">Show Gmail threads in Conversations: <strong>{data.inConversations ? 'On' : 'Off'}</strong></span>
		<p class="muted small">
			Either way, a reply sent from a connected mailbox joins the conversation it answers and clears
			“Awaiting reply”. Off: Conversations lists no thread made only of Gmail mail; it still shows on contact
			pages and feeds account briefs. On: those Gmail threads join the list, with a Gmail tab to see them alone.
		</p>
		<div class="row">
			<button type="submit" class="secondary sm" disabled={busy !== null}>{data.inConversations ? 'Turn off' : 'Turn on'}</button>
		</div>
	</form>
</section>
{/if}

<section class="card">
	<h2>{data.accounts.length ? 'Connect another mailbox' : 'Connect Gmail'}</h2>
	{#if ready}
		<p class="muted">
			You’ll be sent to Google to allow read-only access to your own mailbox, then back here. If the app’s
			Google Audience is <em>External</em> in Testing, an admin adds your address under <em>Test users</em> first.
		</p>
		<form method="GET" action="/auth/google" data-sveltekit-reload>
			<button type="submit">Connect Gmail</button>
		</form>
	{:else}
		<p class="muted">Gmail isn’t set up on this deployment yet. One-time setup:</p>
		<ol class="steps">
			<li>
				<strong>Enable the API</strong> (console.cloud.google.com, in a project such as “Howdee CRM Mail”): APIs &amp;
				Services → Library → <strong>Gmail API</strong> → Enable.
			</li>
			<li>Google Auth Platform → <strong>Branding</strong>: app name “{data.branding.appName}”, support email.</li>
			<li>
				Google Auth Platform → <strong>Audience</strong>: <em>Internal</em> if the Google account is in a Workspace
				organization; otherwise <em>External</em> and add the connecting account under <em>Test users</em> (an External
				app in Testing needs no verification for gmail.readonly).
			</li>
			<li>
				Google Auth Platform → <strong>Data Access</strong> → Add or remove scopes: filter for <em>Gmail API</em> and tick
				<code>https://www.googleapis.com/auth/gmail.readonly</code> (or paste it under <em>Manually add scopes</em>) →
				Update → Save.
			</li>
			<li>
				Google Auth Platform → <strong>Clients</strong>: create an OAuth client → <em>Web application</em>, authorised
				redirect URI <code>{data.redirectUri}</code>, then copy the client ID and secret into the Worker secrets:
				<code>npx wrangler secret put GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>{#if !data.tokenKeyReady}, and
					<code>MAIL_TOKEN_KEY</code> (<code>openssl rand -base64 32</code>){/if}.
			</li>
			<li>Back here: Connect.</li>
		</ol>
		<p class="muted small">
			The app requests the scope itself at connect time; declaring it in Data Access is what the consent screen and any
			later verification check against.
		</p>
		<p class="muted small">
			Missing: {[!data.googleConfigured && 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET', !data.tokenKeyReady && 'MAIL_TOKEN_KEY']
				.filter(Boolean)
				.join(', ')}. For local dev add them to <code>.dev.vars</code>.
		</p>
		<button type="button" disabled title="Finish the setup steps first">Connect Gmail</button>
	{/if}
</section>

<style>
	/* #363: space stacked cards, like Settings → Domain / Backups. */
	section.card { margin-bottom: var(--space-m); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); overflow-wrap: anywhere; }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.ok { color: var(--success); margin: var(--space-xs) 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.card { display: flex; flex-direction: column; gap: var(--space-s); max-width: 720px; }
	.phead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); flex-wrap: wrap; }
	.facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-xxs) var(--space-m); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.facts dt { color: var(--muted); }
	.facts dd { margin: 0; overflow-wrap: anywhere; }
	.actions { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
	.actions form { margin: 0; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	button.danger { color: var(--danger); }
	.steps { margin: 0; padding-left: var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); display: flex; flex-direction: column; gap: var(--space-xxs); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0; }
	.card > form { margin: 0; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); }
	.field label, .field .label { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: 600; }
	.field .label strong { font-weight: 600; }
	.row { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; }
	.row input { flex: 1 1 16rem; min-width: 0; }
</style>

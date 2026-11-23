<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	let { data, form } = $props();

	let newOpen = $state(false);
	let copiedToken = $state(false);
	let copiedBase = $state(false);

	async function copy(text: string, which: 'token' | 'base') {
		try {
			await navigator.clipboard.writeText(text);
			if (which === 'token') copiedToken = true;
			else copiedBase = true;
			setTimeout(() => {
				copiedToken = false;
				copiedBase = false;
			}, 1500);
		} catch {
			/* clipboard blocked — the field is selectable as a fallback */
		}
	}

	// #348: MCP card snippets (the key stays a placeholder — it is never shown again).
	let copiedSnippet = $state('');
	async function copySnippet(which: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedSnippet = which;
			setTimeout(() => (copiedSnippet = ''), 1500);
		} catch {
			/* clipboard blocked — the block is selectable */
		}
	}
	const claudeCodeCmd = $derived(`claude mcp add --transport http dscrm ${data.mcpUrl} --header "Authorization: Bearer <key>"`);
	const jsonConfig = $derived(
		JSON.stringify({ mcpServers: { dscrm: { type: 'http', url: data.mcpUrl, headers: { Authorization: 'Bearer <key>' } } } }, null, 2)
	);
	const desktopConfig = $derived(
		JSON.stringify(
			{ mcpServers: { dscrm: { command: 'npx', args: ['-y', 'mcp-remote', data.mcpUrl, '--header', 'Authorization: Bearer <key>'] } } },
			null,
			2
		)
	);
	const scopeTitle = (s: string) =>
		s === 'read_write' ? 'Read + write' : s === 'campaigns:draft' ? 'Drafts only' : s === 'automations:draft' ? 'Automation drafts only' : 'Read-only';

	const active = $derived(data.keys.filter((k) => !k.revoked_at));
	const revoked = $derived(data.keys.filter((k) => k.revoked_at));
	const scopeLabel = (s: string) => (s === 'read_write' ? 'read + write' : s === 'campaigns:draft' ? 'drafts only' : s === 'automations:draft' ? 'automation drafts only' : 'read-only');
</script>

<svelte:head><title>API keys</title></svelte:head>

<div class="head">
	<h1>API keys</h1>
	<button type="button" onclick={() => (newOpen = true)}>+ New API key</button>
</div>
<p class="muted intro">
	Bearer keys that let your other apps read and write this app's data over the
	<strong>Data API</strong>. Each request sends
	<code>Authorization: Bearer &lt;key&gt;</code>. A key is shown in full
	<strong>once</strong> — only its hash is stored, so copy it now and keep it safe. Issue as
	many as you like, scope each to read-only or read + write, and rotate or revoke any one
	without touching the others.
</p>

<section class="card base">
	<h2>Base URL</h2>
	<div class="urlrow">
		<input class="url" readonly value={data.apiBase} onclick={(e) => (e.target as HTMLInputElement).select()} />
		<button type="button" class="secondary sm" onclick={() => copy(data.apiBase, 'base')}>
			{copiedBase ? 'Copied!' : 'Copy'}
		</button>
	</div>
	<p class="muted hint">e.g. <code>GET {data.apiBase}/contacts</code> · <code>GET {data.apiBase}/events</code></p>
	<p class="muted hint">
		Reports (read keys): <code>GET {data.apiBase}/reports</code> ·
		<code>GET {data.apiBase}/reports/&lbrace;id | builtin:key&rbrace;/run</code> ·
		<code>POST {data.apiBase}/reports/run</code> with a spec. Keys run reports as a member, so hours,
		billing and pipeline value are refused (403).
	</p>
</section>

<section class="card mcp">
	<h2>MCP</h2>
	<p class="muted hint">
		Claude Code, Claude Desktop, Cowork and other MCP clients can use this app directly. Authenticate with an
		API key below; its access decides which tools the client sees. Drafts-only keys get just their draft
		tools, with no reads of contacts or other data. Every write is a draft: no tool sends,
		schedules, activates an automation or enrolls anyone.
	</p>
	<div class="urlrow">
		<input class="url" readonly value={data.mcpUrl} onclick={(e) => (e.target as HTMLInputElement).select()} />
		<button type="button" class="secondary sm" onclick={() => copySnippet('url', data.mcpUrl)}>
			{copiedSnippet === 'url' ? 'Copied!' : 'Copy'}
		</button>
	</div>
	{#each [{ id: 'code', title: 'Claude Code', text: claudeCodeCmd }, { id: 'json', title: 'JSON clients (.mcp.json, Cowork, Cursor)', text: jsonConfig }, { id: 'desktop', title: 'Claude Desktop (claude_desktop_config.json, via mcp-remote)', text: desktopConfig }] as snip (snip.id)}
		<div class="snip">
			<div class="sniphead">
				<h3>{snip.title}</h3>
				<button type="button" class="secondary sm" onclick={() => copySnippet(snip.id, snip.text)}>
					{copiedSnippet === snip.id ? 'Copied!' : 'Copy'}
				</button>
			</div>
			<pre><code>{snip.text}</code></pre>
		</div>
	{/each}
	<p class="muted hint">Replace <code>&lt;key&gt;</code> with a key from below. Up to 60 tool calls per minute per key.</p>
	<h3>Tools by access</h3>
	<dl class="tools">
		{#each data.mcpTools as group (group.scope)}
			<dt>{scopeTitle(group.scope)}</dt>
			<dd>{#each group.tools as name, i (name)}<code>{name}</code>{i < group.tools.length - 1 ? ' ' : ''}{/each}</dd>
		{/each}
	</dl>
</section>

{#if form?.error}<p class="err">{form.error}</p>{/if}

{#if form?.token}
	<section class="card freshkey">
		<h2>New key — copy it now</h2>
		<p class="muted">This is the only time <strong>{form.label}</strong> will be shown in full. Store it securely; you can't view it again.</p>
		<div class="urlrow">
			<input class="url token" readonly value={form.token} onclick={(e) => (e.target as HTMLInputElement).select()} />
			<button type="button" class="sm" onclick={() => copy(form.token, 'token')}>
				{copiedToken ? 'Copied!' : 'Copy'}
			</button>
		</div>
	</section>
{/if}

<Modal title="New API key" bind:open={newOpen}>
	<form
		method="POST"
		action="?/create"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success') newOpen = false;
			}}
		class="new"
	>
		<label class="field">
			<span>Name</span>
			<input name="label" placeholder="e.g. Reporting dashboard" required />
		</label>
		<label class="field">
			<span>Access</span>
			<select name="scope">
				<option value="read">Read-only — GET data</option>
				<option value="read_write">Read + write — full CRUD</option>
				<option value="campaigns:draft">Drafts only — create and edit Compose drafts, nothing else</option>
				<option value="automations:draft">Automation drafts only — create and edit draft automations, never activate</option>
			</select>
		</label>
		<button type="submit">Create key</button>
	</form>
	<p class="muted hint">The key is shown once after creation. Read-only is the safe default for apps that only pull data.</p>
	{#if form?.error}<p class="err">{form.error}</p>{/if}
</Modal>

<section class="card">
	<h2>Active <span class="muted">({active.length})</span></h2>
	{#if active.length === 0}
		<p class="muted">No API keys yet. Create one with the button above.</p>
	{:else}
		<ul class="keylist">
			{#each active as k (k.id)}
				<li class:fresh={form?.createdId === k.id}>
					<div class="krow">
						<strong>{k.label}</strong>
						<span class="badge {k.scope === 'read_write' ? 'sent' : 'draft'}">{scopeLabel(k.scope)}</span>
						<code class="mask">{k.token_prefix}…{k.token_last4}</code>
						<span class="meta muted">
							· {k.request_count} request{k.request_count === 1 ? '' : 's'}
							{#if k.last_used_at}· last {k.last_used_at} UTC{:else}· never used{/if}
						</span>
					</div>
					<div class="actions">
						<form
							method="POST"
							action="?/rotate"
							use:enhance
							class="inline"
							onsubmit={(e) => {
								if (!confirm(`Rotate "${k.label}"? The current key stops working immediately and a new one is shown once.`)) e.preventDefault();
							}}
						>
							<input type="hidden" name="id" value={k.id} />
							<button type="submit" class="secondary sm">Rotate</button>
						</form>
						<form
							method="POST"
							action="?/revoke"
							use:enhance
							class="inline"
							onsubmit={(e) => {
								if (!confirm(`Revoke "${k.label}"? Apps using this key will stop working.`)) e.preventDefault();
							}}
						>
							<input type="hidden" name="id" value={k.id} />
							<button type="submit" class="secondary sm danger-text">Revoke</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if revoked.length > 0}
	<section class="card revoked">
		<h2>Revoked <span class="muted">({revoked.length})</span></h2>
		<ul class="keylist">
			{#each revoked as k (k.id)}
				<li>
					<div class="krow">
						<strong>{k.label}</strong>
						<code class="mask">{k.token_prefix}…{k.token_last4}</code>
						<span class="meta muted">revoked {k.revoked_at} UTC · {k.request_count} lifetime requests</span>
						<form method="POST" action="?/remove" use:enhance class="inline rm">
							<input type="hidden" name="id" value={k.id} />
							<button type="submit" class="iconbtn" title="Delete permanently" aria-label="Delete"><Icon name="close" size={14} /></button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	/* #363: space stacked cards, like Settings → Domain / Backups. */
	section.card { margin-bottom: var(--space-m); }
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); }
	@media (max-width: 640px) {
		.head { flex-direction: column; align-items: flex-start; gap: var(--space-s); }
		.head button { padding: var(--space-xxs) var(--space-s); }
	}
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	.intro code, .hint code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	.err { color: var(--danger); }
	h2 { margin-top: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.base { margin-bottom: var(--space-m); }
	.freshkey { border: 0; box-shadow: 0 0 0 var(--border-s) var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); margin-bottom: var(--space-m); }
	.new { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.new button { align-self: flex-start; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.field > span { color: var(--muted); }
	.keylist { list-style: none; margin: 0; padding: 0; }
	.keylist li { padding: var(--space-s) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.keylist li:last-child { box-shadow: none; padding-bottom: 0; }
	.keylist li.fresh { background: color-mix(in srgb, var(--accent) 8%, transparent); border-radius: var(--radius); padding: var(--space-s); }
	.krow { display: flex; align-items: baseline; gap: var(--space-s); flex-wrap: wrap; }
	.mask { font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xs); border-radius: var(--radius-xs); }
	.meta { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); overflow-wrap: anywhere; }
	.krow strong { overflow-wrap: anywhere; }
	.actions { display: flex; gap: var(--space-xs); margin-top: var(--space-xs); }
	.urlrow { display: flex; gap: var(--space-xs); align-items: center; }
	.url { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); padding: var(--space-xs) var(--space-xs); background: var(--surface); }
	.url.token { font-weight: var(--weight-ui-heavy); }
	.inline { margin: 0; display: inline; }
	.rm { margin-left: auto; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.danger-text { color: var(--danger); }
	.iconbtn { padding: 0 var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--btn-bg); color: var(--danger); box-shadow: 0 0 0 var(--border-s) var(--btn-border); }
	@media (max-width: 768px) { .iconbtn { min-width: 40px; min-height: 40px; } }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: var(--space-xs) 0 0; }
	.revoked { opacity: 0.85; }
	h3 { margin: var(--space-s) 0 var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.snip { margin-top: var(--space-s); }
	.sniphead { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-xs); }
	.sniphead h3 { margin: 0; }
	.snip pre { margin: var(--space-xxs) 0 0; padding: var(--space-xs); background: var(--surface); border-radius: var(--radius-xs); overflow-x: auto; }
	.snip pre code { font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: pre; }
	.tools { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.tools dt { color: var(--muted); }
	.tools dd { margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-xxs); }
	.tools code { background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); }
	@media (max-width: 640px) { .tools { grid-template-columns: 1fr; } }
</style>

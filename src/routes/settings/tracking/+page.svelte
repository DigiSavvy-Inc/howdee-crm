<script lang="ts">
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import { CONSENT_SNIPPET, OPTOUT_SNIPPET, installTag } from '$lib/tracking-snippet';
	let { data, form } = $props();

	let newOpen = $state(false);
	let editing = $state<number | null>(null);
	let installFor = $state<number | null>(null);
	let busy = $state<number | null>(null);
	let copied = $state<string | null>(null);

	async function copy(id: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = id;
			setTimeout(() => (copied = copied === id ? null : copied), 1500);
		} catch {
			/* clipboard blocked — the text is selectable as a fallback */
		}
	}

	const mask = (key: string) => `${key.slice(0, 8)}…${key.slice(-4)}`;
	const originsText = (json: string) => {
		try {
			const list = JSON.parse(json);
			return Array.isArray(list) ? list.join('\n') : '';
		} catch {
			return '';
		}
	};

	/** "3 min ago" for a UTC 'YYYY-MM-DD HH:MM:SS' (or ISO) time. */
	function ago(t: string | null): string {
		if (!t) return 'never';
		const ms = Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
		if (!Number.isFinite(ms)) return t;
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.floor(s / 60)} min ago`;
		if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
		return `${Math.floor(s / 86400)} d ago`;
	}

	const errorFor = (action: string, id?: number) =>
		form && 'error' in form && form.action === action && (id === undefined || ('id' in form && form.id === id))
			? form.error
			: null;
	const status = (id: number) => (form && form.action === 'status' && 'snippet' in form && form.id === id ? form : null);
</script>

<svelte:head><title>Tracking</title></svelte:head>

<div class="head">
	<h1>Site tracking</h1>
	<button type="button" onclick={() => (newOpen = true)}>+ Add site</button>
</div>
<p class="muted intro">
	Record page views and events on your own websites — for <strong>known contacts only</strong>.
	A visitor becomes known when they click a link in one of your emails (or submit a form);
	anonymous visitors are never stored. Add a site, paste its snippet into the site's
	<code>&lt;head&gt;</code>, then use <strong>Check status</strong> to confirm events arrive.
</p>

<Modal title="Add site" bind:open={newOpen}>
	<form
		method="POST"
		action="?/add"
		use:enhance={() =>
			async ({ update, result }) => {
				await update();
				if (result.type === 'success') newOpen = false;
			}}
		class="siteform"
	>
		<label class="field">
			<span>Name</span>
			<input name="name" placeholder="e.g. Example Co" required />
		</label>
		<label class="field">
			<span>Domain</span>
			<input name="domain" placeholder="example.com" required autocomplete="off" />
		</label>
		<label class="field">
			<span>Allowed origins <span class="muted">(optional, one per line)</span></span>
			<textarea name="origins" rows="3" placeholder={'https://example.com\nhttps://www.example.com'}></textarea>
		</label>
		<p class="muted hint">Blank = <code>https://&lt;domain&gt;</code> and <code>https://www.&lt;domain&gt;</code>. Email links to the domain (and its subdomains) get decorated.</p>
		{#if errorFor('add')}<p class="err">{errorFor('add')}</p>{/if}
		<button type="submit">Add site</button>
	</form>
</Modal>

<section class="card">
	<h2>Sites <span class="muted">({data.sites.length})</span></h2>
	{#if errorFor('toggle') || errorFor('rotate')}<p class="err">{errorFor('toggle') ?? errorFor('rotate')}</p>{/if}
	{#if data.sites.length === 0}
		<p class="muted">No sites yet. Add one with the button above.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Site</th>
						<th>Origins</th>
						<th>Key</th>
						<th>Last event</th>
						<th class="num">Events 7d</th>
						<th>Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.sites as s (s.id)}
						<tr class:off={!s.enabled}>
							<td>
								<strong>{s.name}</strong>
								<div class="muted small">{s.domain}</div>
							</td>
							<td class="small origins">{originsText(s.origins) || `https://${s.domain} (+ www)`}</td>
							<td>
								<code title="Public key — it ships in the snippet">{mask(s.site_key)}</code>
								<button type="button" class="link sm" onclick={() => copy(`key:${s.id}`, s.site_key)}>
									{copied === `key:${s.id}` ? 'Copied!' : 'Copy'}
								</button>
							</td>
							<td class="small" title={s.last_event_at ? `${s.last_event_at} UTC` : ''}>{ago(s.last_event_at)}</td>
							<td class="num">{s.events_7d}</td>
							<td>
								<form method="POST" action="?/toggle" use:enhance class="inline">
									<input type="hidden" name="id" value={s.id} />
									<input type="hidden" name="enabled" value={s.enabled ? '0' : '1'} />
									<button type="submit" class="secondary sm" title={s.enabled ? 'Disable — the snippet becomes a no-op' : 'Enable'}>
										{s.enabled ? 'Enabled' : 'Disabled'}
									</button>
								</form>
							</td>
							<td class="actions">
								<button type="button" class="secondary sm" onclick={() => (installFor = installFor === s.id ? null : s.id)}>
									{installFor === s.id ? 'Hide code' : 'Install'}
								</button>
								<button type="button" class="secondary sm" onclick={() => (editing = editing === s.id ? null : s.id)}>
									{editing === s.id ? 'Close' : 'Edit'}
								</button>
								<form
									method="POST"
									action="?/rotate"
									use:enhance={({ cancel }) => {
										if (!confirm(`Rotate the key for ${s.name}? The current snippet stops working until you paste the new one.`)) cancel();
									}}
									class="inline"
								>
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="secondary sm danger-text">Rotate key</button>
								</form>
							</td>
						</tr>
						{#if editing === s.id}
							<tr class="sub">
								<td colspan="7">
									<form
										method="POST"
										action="?/update"
										use:enhance={() =>
											async ({ update, result }) => {
												await update({ reset: false });
												if (result.type === 'success') editing = null;
											}}
										class="siteform inline-edit"
									>
										<input type="hidden" name="id" value={s.id} />
										<label class="field"><span>Name</span><input name="name" value={s.name} required /></label>
										<label class="field"><span>Domain</span><input name="domain" value={s.domain} required autocomplete="off" /></label>
										<label class="field">
											<span>Allowed origins <span class="muted">(one per line; blank = domain + www)</span></span>
											<textarea name="origins" rows="3">{originsText(s.origins)}</textarea>
										</label>
										{#if errorFor('update', s.id)}<p class="err">{errorFor('update', s.id)}</p>{/if}
										<button type="submit" class="sm">Save</button>
									</form>
								</td>
							</tr>
						{/if}
						{#if installFor === s.id}
							{@const tag = installTag(data.baseUrl, s.site_key)}
							<tr class="sub">
								<td colspan="7">
									<div class="install">
										<h3>Install on {s.name}</h3>
										<p class="muted">Paste this into the site's <code>&lt;head&gt;</code>, on every page:</p>
										<div class="codebox">
											<pre><code>{tag}</code></pre>
											<button type="button" class="secondary sm" onclick={() => copy(`tag:${s.id}`, tag)}>
												{copied === `tag:${s.id}` ? 'Copied!' : 'Copy'}
											</button>
										</div>
										<p class="muted">
											<strong>WordPress:</strong> add it with WPCode (Code Snippets → Header &amp; Footer → Header),
											or your theme's “header scripts” setting. Exclude it from JS minify/combine and
											“delay JavaScript” optimisations if your cache plugin has them.
										</p>
										<p class="muted"><strong>Consent (optional):</strong> to hold tracking until a visitor agrees, set this <em>before</em> the tag and flip it to <code>true</code> from your banner. Leaving it unset means allowed.</p>
										<pre><code>{CONSENT_SNIPPET}</code></pre>
										<p class="muted"><strong>Opt-out link</strong> for your privacy page:</p>
										<pre><code>{OPTOUT_SNIPPET}</code></pre>
										<p class="muted"><strong>Custom events:</strong> <code>dsv.track('booked_call', {'{'} plan: 'pro' {'}'})</code>. <strong>Forms:</strong> add <code>site_key={s.site_key}</code> to the form's webhook post; the response carries <code>dsv_id</code> — pass it to <code>dsv.identify(dsv_id)</code> in the form's success JavaScript (WS Form: Actions → Run JavaScript).</p>
									</div>
								</td>
							</tr>
						{/if}
						<tr class="sub statusrow">
							<td colspan="7">
								<form
									method="POST"
									action="?/status"
									use:enhance={() => {
										busy = s.id;
										return async ({ update }) => {
											await update({ reset: false });
											busy = null;
										};
									}}
									class="inline"
								>
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="secondary sm" disabled={busy !== null}>
										{busy === s.id ? 'Checking…' : 'Check status'}
									</button>
								</form>
								{#if status(s.id)}
									{@const st = status(s.id)!}
									<span class="statusline">
										{#if st.snippet === 'error'}
											<span class="badge failed">Snippet not loading</span>
										{:else if st.snippet === 'disabled'}
											<span class="badge draft">Site disabled — snippet is a no-op</span>
										{:else if st.receiving}
											<span class="badge sent">Receiving</span>
											<span class="muted small">{st.recentCount} event{st.recentCount === 1 ? '' : 's'} in the last 10 min</span>
										{:else if !st.lastEventAt}
											<span class="badge sending">Waiting for the first event…</span>
											<span class="muted small">Open the site from a link in an email you sent yourself.</span>
										{:else}
											<span class="badge draft">No events in the last 10 min</span>
											<span class="muted small">last {ago(st.lastEventAt)}</span>
										{/if}
									</span>
								{/if}
								{#if errorFor('status', s.id)}<span class="err">{errorFor('status', s.id)}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<section class="card">
	<h2>Decorate email links</h2>
	<p class="muted">
		When this is on, every link in an email that points at one of the sites above gets a
		short signed <code>dsv=…</code> code added (30-day expiry). When the recipient clicks
		through, the site's snippet swaps it for a visitor id, so their visits are tied to their
		contact record. Links to anything else — unsubscribe, hosted pages, other domains — are
		never changed. Turn it off to stop adding the code to new sends; already-sent emails keep
		their links.
	</p>
	<form method="POST" action="?/setLinks" use:enhance={() => async ({ update }) => update({ reset: false })} class="links">
		<input type="hidden" name="links" value={data.linksEnabled ? 'off' : 'on'} />
		<span class="badge {data.linksEnabled ? 'sent' : 'draft'}">{data.linksEnabled ? 'On' : 'Off'}</span>
		<button type="submit" class="secondary sm">{data.linksEnabled ? 'Turn off' : 'Turn on'}</button>
	</form>
</section>

<style>
	/* #363: space stacked cards, like Settings → Domain / Backups. */
	section.card { margin-bottom: var(--space-m); }
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-m); flex-wrap: wrap; }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	h3 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	pre { margin: var(--space-xs) 0; padding: var(--space-xs) var(--space-s); background: var(--surface); border-radius: var(--radius-xs); overflow-x: auto; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
	pre code { background: none; padding: 0; }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.siteform { display: flex; flex-direction: column; gap: var(--space-s); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.table-wrap { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	th { text-align: left; font-weight: var(--weight-ui-heavy); color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); padding: var(--space-xs) var(--space-xs); }
	td { padding: var(--space-xs); vertical-align: top; box-shadow: inset 0 var(--border-s) 0 var(--border-muted, var(--border)); }
	tr.sub td { border-top: 0; padding-top: 0; }
	tr.off td:not(.actions) { opacity: 0.6; }
	.num { text-align: right; }
	.origins { white-space: pre-line; overflow-wrap: anywhere; max-width: 22ch; }
	.actions { display: flex; gap: var(--space-xxs); flex-wrap: wrap; justify-content: flex-end; }
	form.inline { display: inline; margin: 0; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	button.link { background: none; border: 0; color: var(--link); padding: 0 var(--space-xxs); cursor: pointer; box-shadow: none; text-decoration: underline; text-decoration-color: var(--link-underline); text-decoration-thickness: var(--link-underline-thickness); text-underline-offset: var(--link-underline-offset); }
	button.link:hover { background: none; box-shadow: none; color: var(--link-hover); text-decoration-thickness: var(--link-underline-thickness-hover); }
	.install { background: var(--surface-subtle, var(--surface)); border-radius: var(--radius-s); padding: var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.install p { margin: var(--space-xs) 0 var(--space-xxs); }
	.codebox { display: flex; gap: var(--space-xs); align-items: flex-start; }
	.codebox pre { flex: 1; }
	.statusrow td { padding-bottom: var(--space-s); }
	.statusline { display: inline-flex; gap: var(--space-xs); align-items: baseline; flex-wrap: wrap; margin-left: var(--space-xs); }
	.inline-edit { max-width: 480px; }
	.links { display: flex; gap: var(--space-xs); align-items: center; }
</style>

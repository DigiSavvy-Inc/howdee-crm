<script lang="ts">
	import { applyAction, deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '$app/forms';
	import { untrack } from 'svelte';
	let { data, form } = $props();

	// #495: when the CRM can't reach the public address itself (its fetch of its own Workers
	// route can fall through to the website), Test connection checks the feed from this browser
	// (the public feed allows the CRM origin via CORS) and stores that result.
	let browserChecking = $state(false);
	const testConnection: SubmitFunction = () => async ({ result, update }) => {
		await update();
		if (result.type !== 'success' || result.data?.hostTested !== false || !data.publicHost.host) return;
		browserChecking = true;
		try {
			let ok = false;
			let code: number | null = null;
			try {
				const res = await fetch(`https://${data.publicHost.host}/newsletter/feed.xml?t=${Date.now()}`, { mode: 'cors', cache: 'no-store' });
				code = res.status;
				ok = res.status === 200 && res.headers.get('X-Archive-Source') === 'crm';
			} catch {
				/* blocked, offline or no CORS: a fail with no code */
			}
			const fd = new FormData();
			fd.set('ok', ok ? '1' : '0');
			fd.set('code', code === null ? '' : String(code));
			const res = await fetch('?/recordPublicTest', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const recorded = deserialize(await res.text());
			if (recorded.type === 'failure' || recorded.type === 'error') await applyAction(recorded);
			await invalidateAll();
		} finally {
			browserChecking = false;
		}
	};

	// #481: the switches start from what is stored. "Allow search engines" defaults on.
	let enabled = $state(untrack(() => data.settings.enabled));
	let copied = $state(false);
	// #491: snippets carry the secret only right after it was generated.
	const snippets = $derived(form?.proxySnippets ?? data.publicHost.snippets);
	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(data.publicUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard unavailable — the URL is on screen */
		}
	}
</script>

<svelte:head><title>Newsletter archive settings</title></svelte:head>

<h1>Newsletter archive</h1>
<p class="muted intro">
	A public page listing the newsletters you publish, each shown as a designed web page. Nothing is public until the
	archive is on and you publish an issue (campaign page → <strong>Publish to newsletter archive</strong>, or the checkbox
	in Compose).
</p>

<form
	method="POST"
	action="?/save"
	use:enhance={() =>
		async ({ update }) => {
			await update({ reset: false });
		}}
>
	<section class="card">
		<label class="check">
			<input type="checkbox" name="enabled" value="1" bind:checked={enabled} />
			Turn the newsletter archive on
		</label>
		<p class="url">
			<span class="muted">Public URL:</span>
			<code>{data.publicUrl}</code>
			<button type="button" class="secondary small" onclick={copyUrl}>{copied ? 'Copied' : 'Copy'}</button>
			{#if enabled && data.settings.enabled}<a href={data.publicUrl} target="_blank" rel="noopener">Open</a>{/if}
		</p>
		<p class="muted small">RSS feed: <code>{data.publicUrl}/feed.xml</code></p>
	</section>

	<section class="card">
		<h2>Page</h2>
		<label class="field">
			Title
			<input name="title" maxlength="80" value={data.settings.title} />
		</label>
		<label class="field">
			Intro
			<textarea name="intro" rows="3" maxlength="1000">{data.settings.intro}</textarea>
			<span class="muted small">Shown under the title on the index page. A blank line starts a new paragraph.</span>
		</label>
		<label class="field">
			Subscribe URL
			<input name="subscribe_url" placeholder="https://example.com/newsletter or /p/subscribe" value={data.settings.subscribeUrl} />
			<span class="muted small">Where the “Subscribe” button goes. Leave it empty to hide the subscribe box.</span>
		</label>
		<label class="field">
			Sign-up form
			<select name="signup_form" value={data.settings.signupForm}>
				<option value="">None (use the Subscribe URL)</option>
				{#each data.signupForms as f (f.slug)}
					<option value={f.slug}>{f.name}{f.problem ? ' (can’t be used here)' : ''}</option>
				{/each}
			</select>
			<span class="muted small">
				A published one-page form from <a href="/forms">Forms</a>, without conditional logic. Readers get a Subscribe
				button that opens it in a popup on the archive and every issue, and the page
				<code>{data.publicUrl}/subscribe</code>. It replaces the Subscribe URL while chosen.
			</span>
			{#each data.signupForms.filter((f) => f.problem && f.slug === data.settings.signupForm) as f (f.slug)}
				<span class="err small">{f.problem}</span>
			{/each}
		</label>
		<label class="field">
			Web template
			<select name="template_id" value={data.settings.templateId ?? ''}>
				<option value="">Built-in default</option>
				{#each data.templates as t (t.id)}
					<option value={t.id}>{t.name}</option>
				{/each}
			</select>
			<span class="muted small">
				Make one in <a href="/templates">Templates</a> (type “Web page”). The built-in default uses the logo from
				Settings → Branding and the mailing address from Settings → General.
			</span>
		</label>
		<label class="check">
			<input type="checkbox" name="indexable" value="1" checked={data.settings.indexable} />
			Allow search engines to index the archive
		</label>
	</section>

	<section class="card">
		<h2>Auto-publish</h2>
		<p class="muted small">
			A broadcast sent to any of these lists, segments or topics is published automatically once it's sent. None by
			default.
		</p>
		{#if data.groups.length === 0}
			<p class="muted small">No lists or segments yet.</p>
		{:else}
			<div class="groups">
				{#each data.groups as g (g.id)}
					<label class="check">
						<input type="checkbox" name="auto_group" value={g.id} checked={data.settings.autoGroups.includes(g.id)} />
						{g.name}
					</label>
				{/each}
			</div>
		{/if}
	</section>

	<div class="actions">
		<button type="submit">Save</button>
		{#if form?.saved}<span class="ok" role="status">Saved.</span>{/if}
		{#if form?.error}<span class="err" role="alert">{form.error}</span>{/if}
	</div>
</form>

<section class="card" id="public-address">
	<h2>Public address</h2>
	<p class="muted small">
		Show the archive on your website instead of this CRM, e.g. <code>example.com</code> →
		<code>https://example.com/newsletter</code>. On that address every link, image, the feed and the logo point at
		your website, never at the CRM.
		{#if data.publicHost.routeHosts.length}For {data.publicHost.routeHosts.join(', ')} the Cloudflare route is set up
			automatically on deploy (<code>ARCHIVE_ROUTE_HOSTS</code>); save{:else}Add the host to the Worker's routes and the
			<code>ARCHIVE_ROUTE_HOSTS</code> var, or use a proxy (Other hosts below); then save{/if} the address here and run
		<strong>Test connection</strong>.
	</p>
	<form method="POST" action="?/savePublicHost" use:enhance class="row">
		<label class="field grow">
			Hostname
			<input name="host" placeholder="example.com" value={data.publicHost.host ?? ''} autocomplete="off" />
		</label>
		<button type="submit">Save</button>
		{#if data.publicHost.host}
			<button type="submit" class="secondary" formaction="?/clearPublicHost">Clear</button>
		{/if}
	</form>
	{#if form?.hostError}<p class="notice err" role="alert">{form.hostError}</p>{/if}
	{#if data.publicHost.host}
		<div class="row">
			<span class="small">
				{#if browserChecking}
					<span class="muted">Checking from your browser…</span>
				{:else if !data.publicHost.statusCurrent}
					<span class="muted">Not tested yet.</span>
				{:else if data.publicHost.status?.ok && data.publicHost.status.via === 'browser'}
					<span class="ok">Connected</span> (checked from your browser).
				{:else if data.publicHost.status?.ok}
					<span class="ok">Connected</span> — <code>https://{data.publicHost.host}/newsletter</code> is served by this CRM.
				{:else if data.publicHost.status?.via === 'browser'}
					<span class="err">Not connected.</span> Couldn't verify from this browser either.
					<span class="muted">({data.publicHost.status.code ?? 'no answer'})</span>
				{:else}
					<span class="err">Not connected</span>
					({data.publicHost.status?.code ?? 'no answer'}{data.publicHost.status?.error ? `: ${data.publicHost.status.error}` : ''}).
				{/if}
				{#if !browserChecking && data.publicHost.statusCurrent && data.publicHost.status}
					<span class="muted">Checked {data.publicHost.status.checkedAt.slice(0, 16).replace('T', ' ')} UTC.</span>
				{/if}
			</span>
			<form method="POST" action="?/testPublicHost" use:enhance={testConnection} class="inline">
				<button type="submit" class="secondary small" disabled={browserChecking}>Test connection</button>
			</form>
		</div>
		<form method="POST" action="?/setPublicRedirect" use:enhance class="row">
			<input type="hidden" name="on" value={data.publicHost.redirect ? '0' : '1'} />
			<label class="check">
				<input
					type="checkbox"
					checked={data.publicHost.redirect}
					disabled={!data.publicHost.redirect && !(data.publicHost.statusCurrent && data.publicHost.status?.ok)}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				/>
				Send visitors of <code>{data.publicHost.crmUrl}/newsletter</code> to the public address (301)
			</label>
		</form>
		{#if !data.publicHost.redirect && !(data.publicHost.statusCurrent && data.publicHost.status?.ok)}
			<p class="muted small">The redirect can be turned on once Test connection passes.</p>
		{/if}
	{/if}

	<details class="other-hosts">
		<summary>Other hosts (nginx, Vercel, CloudFront)</summary>
		<p class="muted small">
			If the website isn't on this Cloudflare account, have its server forward <code>/newsletter</code> and
			<code>/newsletter/*</code> to <code>{data.publicHost.crmUrl}</code> with the header
			<code>X-Archive-Proxy-Secret</code>. The secret is shown once; only its fingerprint is stored. Save the public
			address above too.
		</p>
		<p class="small">
			Secret: {data.publicHost.hasSecret || form?.proxySecret ? 'set' : 'none'}
		</p>
		{#if form?.proxySecret}
			<p class="notice ok" role="status">
				Copy it now, it won't be shown again: <code>{form.proxySecret}</code>
			</p>
		{/if}
		<div class="row">
			<form method="POST" action="?/rotateProxySecret" use:enhance class="inline">
				<button type="submit" class="secondary small">{data.publicHost.hasSecret ? 'Rotate secret' : 'Generate secret'}</button>
			</form>
			{#if data.publicHost.hasSecret}
				<form method="POST" action="?/removeProxySecret" use:enhance class="inline">
					<button type="submit" class="secondary small">Remove secret</button>
				</form>
			{/if}
		</div>
		<h3 class="small">nginx</h3>
		<pre><code>{snippets.nginx}</code></pre>
		<h3 class="small">Vercel</h3>
		<pre><code>{snippets.vercel}</code></pre>
		<h3 class="small">CloudFront</h3>
		<pre><code>{snippets.cloudfront}</code></pre>
	</details>
</section>

<section class="card issues">
	<h2>Published issues</h2>
	{#if data.issues.length === 0}
		<p class="muted small">Nothing published yet.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead><tr><th><abbr title="Issue number">№</abbr></th><th>Issue</th><th>Sent</th><th>URL</th><th></th></tr></thead>
				<tbody>
					{#each data.issues as i (i.id)}
						<tr>
							<td><a href="/campaign/{i.id}/archive" title="Edit the issue number">{i.number ?? '—'}</a></td>
							<td><a href="/campaign/{i.id}">{i.subject}</a></td>
							<td class="muted">{i.sent_at ?? ''}</td>
							<td><a href={i.url} target="_blank" rel="noopener">/newsletter/{i.slug}</a></td>
							<td class="right">
								<form method="POST" action="?/remove" use:enhance class="inline">
									<input type="hidden" name="id" value={i.id} />
									<button type="submit" class="secondary small">Remove</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.intro { margin: 0 0 var(--space-m); max-width: 70ch; }
	.card { display: flex; flex-direction: column; gap: var(--space-s); }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.small { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.check { display: flex; align-items: center; gap: var(--space-xs); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); }
	.url { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin: 0; }
	code { overflow-wrap: anywhere; font-size: var(--size-s); }
	.groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-xs) var(--space-m); }
	.actions { display: flex; align-items: center; gap: var(--space-s); margin: var(--space-s) 0 var(--space-l); }
	.err { color: var(--danger); }
	.right { text-align: right; }
	.inline { display: inline; margin: 0; }
	.issues { margin-top: var(--space-m); }
	.row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-xs); margin: 0; }
	.grow { flex: 1 1 240px; }
	.ok { color: var(--success); }
	.other-hosts { display: flex; flex-direction: column; gap: var(--space-xs); }
	.other-hosts h3 { margin: var(--space-xs) 0 0; }
	pre { margin: 0; overflow-x: auto; padding: var(--space-xs); border: 1px solid var(--border); border-radius: var(--radius); }
</style>

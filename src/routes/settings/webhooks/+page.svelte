<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	let { data, form } = $props();

	let newOpen = $state(false);

	function urlFor(token: string): string {
		return `${data.baseUrl}/api/ingest?key=${token}`;
	}

	let copied = $state<number | null>(null);
	let editingKey = $state<number | null>(null);
	async function copy(id: number, token: string) {
		try {
			await navigator.clipboard.writeText(urlFor(token));
			copied = id;
			setTimeout(() => (copied = copied === id ? null : copied), 1500);
		} catch {
			/* clipboard blocked — the field is selectable as a fallback */
		}
	}

	const active = $derived(data.keys.filter((k) => !k.revoked_at));
	const revoked = $derived(data.keys.filter((k) => k.revoked_at));

	function statusClass(s: string): string {
		if (s === 'added' || s === 'updated') return 'sent';
		if (s === 'rejected') return 'failed';
		return 'draft'; // ignored
	}

	let expanded = $state(new Set<number>());
	function toggle(id: number) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}
	function prettyPayload(p: string | null): string {
		if (!p) return '(no payload)';
		try {
			return JSON.stringify(JSON.parse(p), null, 2);
		} catch {
			return p;
		}
	}
</script>

<svelte:head><title>Webhooks</title></svelte:head>

<div class="head">
	<h1>Webhooks</h1>
	<button type="button" onclick={() => (newOpen = true)}>+ New webhook</button>
</div>
<p class="muted intro">
	Create a key for each form or integration that should push contacts into the app. Each one
	gets its own URL you can paste into a form tool (WS Form, etc.) — revoke any without
	affecting the others. POST <code>email</code> (required) plus optional
	<code>name</code>/<code>first_name</code>/<code>last_name</code>, <code>company</code>,
	<code>list</code>, <code>source</code> — as JSON or a normal form post. With <strong>Require confirmation</strong>
	(or <code>confirm: true</code> in the body) a new address gets a double opt-in email first and joins the list and tags only
	after confirming.
</p>

{#if form?.error}<p class="err">{form.error}</p>{/if}

<Modal title="New webhook" bind:open={newOpen}>
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
			<input name="label" placeholder="e.g. WS Form — contact page" required />
		</label>
		<label class="field">
			<span>Add to list <span class="muted">(optional)</span></span>
			<input name="default_list" list="list-options" placeholder="created if new" autocomplete="off" />
			<datalist id="list-options">{#each data.lists as l (l)}<option value={l}></option>{/each}</datalist>
		</label>
		<label class="field">
			<span>Add tags <span class="muted">(optional, comma-separated)</span></span>
			<input name="default_tags" placeholder="e.g. website-lead, hot" autocomplete="off" />
		</label>
		<label class="field">
			<span>Source label <span class="muted">(optional)</span></span>
			<input name="source" placeholder="e.g. ws-form" autocomplete="off" />
		</label>
		<label class="check">
			<input type="checkbox" name="require_confirm" value="1" />
			<span>Require confirmation <span class="muted">(double opt-in: one confirm email first — <a href="/settings/double-optin">set it up</a>)</span></span>
		</label>
		<button type="submit">Create webhook</button>
	</form>
	<p class="muted hint">Contacts arriving through a key get its list + tags — and both fire “added to list/tag” automation triggers. The form can also send its own <code>tags</code> (e.g. from a triage step) — they're merged in.</p>
	{#if form?.error}<p class="err">{form.error}</p>{/if}
</Modal>

<section class="card">
	<h2>Active <span class="muted">({active.length})</span></h2>
	{#if active.length === 0}
		<p class="muted">No webhooks yet. Create one with the button above.</p>
	{:else}
		<ul class="keylist">
			{#each active as k (k.id)}
				<li class:fresh={form?.createdId === k.id}>
					<div class="krow">
						<strong>{k.label}</strong>
						<span class="meta muted">
							{#if k.default_list}→ {k.default_list}{/if}
							{#if k.default_tags} · tags: {k.default_tags}{/if}
							{#if k.source} · source “{k.source}”{/if}
							{#if k.require_confirm} · requires confirmation{/if}
							· {k.request_count} hit{k.request_count === 1 ? '' : 's'}
							{#if k.last_used_at}· last {k.last_used_at} UTC{:else}· never used{/if}
						</span>
					</div>
					<div class="urlrow">
						<input class="url" readonly value={urlFor(k.token)} onclick={(e) => (e.target as HTMLInputElement).select()} />
						<button type="button" class="secondary sm" onclick={() => copy(k.id, k.token)}>
							{copied === k.id ? 'Copied!' : 'Copy'}
						</button>
						<button type="button" class="secondary sm" onclick={() => (editingKey = editingKey === k.id ? null : k.id)}>
							{editingKey === k.id ? 'Close' : 'Edit'}
						</button>
						<form method="POST" action="?/revoke" use:enhance class="inline">
							<input type="hidden" name="id" value={k.id} />
							<button type="submit" class="secondary sm danger-text">Revoke</button>
						</form>
					</div>
					{#if editingKey === k.id}
						<form
							method="POST"
							action="?/update"
							use:enhance={() =>
								async ({ update, result }) => {
									await update({ reset: false });
									if (result.type === 'success') editingKey = null;
								}}
							class="kedit"
						>
							<input type="hidden" name="id" value={k.id} />
							<label class="field">
								<span>Add to list</span>
								<input name="default_list" value={k.default_list ?? ''} list="list-options" autocomplete="off" />
							</label>
							<label class="field">
								<span>Add tags <span class="muted">(comma-separated)</span></span>
								<input name="default_tags" value={k.default_tags ?? ''} placeholder="e.g. website-lead" autocomplete="off" />
							</label>
							<label class="field">
								<span>Source label</span>
								<input name="source" value={k.source ?? ''} autocomplete="off" />
							</label>
							<label class="check">
								<input type="checkbox" name="require_confirm" value="1" checked={!!k.require_confirm} />
								<span>Require confirmation <span class="muted">(double opt-in)</span></span>
							</label>
							<button type="submit" class="sm">Save</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="card">
	<h2>Recent activity <span class="muted">({data.events.length})</span></h2>
	{#if data.events.length === 0}
		<p class="muted">No requests yet. Each form submission that hits a webhook shows up here — added, updated, or why it was rejected.</p>
	{:else}
		<ul class="evlist">
			{#each data.events as ev (ev.id)}
				<li>
					<button type="button" class="ev-head" onclick={() => toggle(ev.id)} aria-expanded={expanded.has(ev.id)}>
						<span class="ev-caret"><Icon name={expanded.has(ev.id) ? 'chevron-down' : 'chevron-right'} size={16} /></span>
						<span class="badge {statusClass(ev.status)}">{ev.status}</span>
						<span class="ev-email">{ev.email ?? '—'}</span>
						{#if ev.detail}<span class="muted ev-detail">{ev.detail}</span>{/if}
						<span class="muted ev-key">{ev.key_label ?? 'env key'}</span>
						<span class="muted ev-when">{ev.created_at} UTC</span>
					</button>
					{#if expanded.has(ev.id)}
						<pre class="ev-payload">{prettyPayload(ev.payload)}</pre>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="muted hint">Click any row to see the raw payload the form sent.</p>
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
						<span class="meta muted">revoked {k.revoked_at} UTC · {k.request_count} lifetime hits</span>
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
	.check { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	/* #363: space stacked cards, like Settings → Domain / Backups. */
	section.card { margin-bottom: var(--space-m); }
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); }
	@media (max-width: 640px) {
		.head { flex-direction: column; align-items: flex-start; gap: var(--space-s); }
		.head button { padding: var(--space-xxs) var(--space-s); }
	}
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 60ch; }
	.intro code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); }
	.err { color: var(--danger); }
	h2 { margin-top: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.new { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.new button { align-self: flex-start; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.field > span { color: var(--muted); }
	.keylist { list-style: none; margin: 0; padding: 0; }
	.keylist li { padding: var(--space-s) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.keylist li:last-child { box-shadow: none; padding-bottom: 0; }
	.keylist li.fresh { background: color-mix(in srgb, var(--accent) 8%, transparent); border-radius: var(--radius); padding: var(--space-s); }
	.krow { display: flex; align-items: baseline; gap: var(--space-s); flex-wrap: wrap; }
	.meta { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); overflow-wrap: anywhere; }
	.krow strong { overflow-wrap: anywhere; }
	.urlrow { display: flex; gap: var(--space-xs); margin-top: var(--space-xs); align-items: center; }
	@media (max-width: 480px) {
		.urlrow { flex-wrap: wrap; }
		.urlrow .url { flex-basis: 100%; }
	}
	.url { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); padding: var(--space-xs) var(--space-xs); background: var(--surface); }
	.inline { margin: 0; display: inline; }
	.kedit { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: var(--space-s); align-items: end; margin: var(--space-s) 0 var(--space-xxs); padding: var(--space-s); background: var(--surface); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); }
	@media (max-width: 700px) { .kedit { grid-template-columns: 1fr; } }
	.rm { margin-left: auto; }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.danger-text { color: var(--danger); }
	.iconbtn { padding: 0 var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--btn-bg); color: var(--danger); box-shadow: 0 0 0 var(--border-s) var(--btn-border); }
	@media (max-width: 768px) { .iconbtn { min-width: 40px; min-height: 40px; } }
	.evlist { list-style: none; margin: 0; padding: 0; }
	.evlist li { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.evlist li:last-child { box-shadow: none; }
	.ev-head {
		display: flex; align-items: baseline; gap: var(--space-s); flex-wrap: wrap;
		width: 100%; text-align: left; padding: var(--space-xs) 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
		background: none; border: 0; box-shadow: none; cursor: pointer; color: inherit;
	}
	.ev-head:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
	.ev-caret { color: var(--muted); display: inline-flex; }
	.ev-email { font-weight: var(--weight-ui-medium); min-width: 0; overflow-wrap: anywhere; }
	.ev-detail { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); min-width: 0; overflow-wrap: anywhere; }
	.ev-key { margin-left: auto; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.ev-when { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; }
	.ev-payload {
		margin: 0 0 var(--space-s) var(--space-xl); padding: var(--space-s) var(--space-s); background: var(--surface);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius);
		font-family: var(--font-mono); font-size: var(--size-xs); letter-spacing: var(--letter-spacing-xs); line-height: var(--line-xs);
		white-space: pre-wrap; word-break: break-word; overflow-x: auto;
	}
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: var(--space-xs) 0 0; }
	.revoked { opacity: 0.85; }
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	let { data, form } = $props();
	let newOpen = $state(false);
	let newKind = $state('builder');
	const KIND_LABEL: Record<string, string> = { html: 'HTML', builder: 'Builder', web: 'Web page' };
</script>

<svelte:head><title>Templates</title></svelte:head>

<div class="head">
	<h1>Templates</h1>
	<span class="head-actions">
		<a class="chrome-link" href="/templates/global">Global header &amp; footer</a>
		<button type="button" onclick={() => (newOpen = true)}>+ New template</button>
	</span>
</div>
<p class="muted intro">
	Reusable email bodies. Start a campaign from one on the Compose page — <strong>Builder</strong>
	templates use drag-and-drop blocks (rendered email-safe); <strong>HTML</strong> templates are
	raw pasted markup sent as-is. Merge tags like <code>{'{{first_name}}'}</code> work in both.
	<strong>Web page</strong> templates design the public newsletter archive (Settings → Newsletter archive).
</p>

<Modal title="New template" bind:open={newOpen}>
	<form method="POST" action="?/create" use:enhance class="newform">
		<label>
			Name
			<!-- svelte-ignore a11y_autofocus -->
			<input name="name" autofocus required maxlength="120" placeholder="e.g. Monthly newsletter" />
		</label>
		<label>
			Type
			<select name="kind" bind:value={newKind}>
				<option value="builder">Builder (blocks)</option>
				<option value="html">Raw HTML</option>
				<option value="web">Web page (newsletter archive)</option>
			</select>
		</label>
		{#if newKind === 'web'}
			<!-- #481: the archive's built-in design, as editable blocks. -->
			<label>
				Start from
				<select name="start">
					<option value="default">Start from default</option>
					<option value="blank">Blank (content area only)</option>
				</select>
			</label>
		{/if}
		<button type="submit">Create & edit</button>
	</form>
	{#if form?.error}<p class="err">{form.error}</p>{/if}
</Modal>

<section class="card">
	{#if data.templates.length === 0}
		<p class="muted">No templates yet. Create one with the button above.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Name</th><th>Type</th><th>Updated</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.templates as t (t.id)}
						<tr>
							<td><a href="/templates/{t.id}">{t.name}</a></td>
							<td><span class="badge {t.kind === 'html' ? 'draft' : t.kind === 'web' ? 'scheduled' : 'sent'}">{KIND_LABEL[t.kind] ?? t.kind}</span></td>
							<td class="muted">{t.updated_at}</td>
							<td class="right">
								<form method="POST" action="?/delete" use:enhance class="inline">
									<input type="hidden" name="id" value={t.id} />
									<button type="submit" class="secondary small">Delete</button>
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
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); }
	.head-actions { display: inline-flex; align-items: center; gap: var(--space-s); }
	.chrome-link { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); padding: var(--space-xs) var(--space-m); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius-s); color: var(--muted); }
	.chrome-link:hover { text-decoration: none; color: var(--text); box-shadow: 0 0 0 var(--border-s) var(--muted); }
	@media (max-width: 640px) {
		.head { flex-direction: column; align-items: flex-start; gap: var(--space-s); }
		.head-actions { flex-wrap: wrap; gap: var(--space-xs); }
		.head-actions button, .chrome-link { padding: var(--space-xxs) var(--space-s); }
	}
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 62ch; }
	.intro code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); }
	.newform { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.newform label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.newform button { align-self: flex-start; }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.right { text-align: right; }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.inline { margin: 0; display: inline; }
</style>

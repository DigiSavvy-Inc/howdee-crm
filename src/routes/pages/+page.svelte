<script lang="ts">
	import { enhance } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	let { data, form } = $props();

	let newOpen = $state(false);
	let slugTouched = $state(false);
	let title = $state('');
	let slug = $state('');

	// Suggest a slug from the title until the user edits it directly.
	function slugify(s: string): string {
		return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
	}
	$effect(() => {
		if (!slugTouched) slug = slugify(title);
	});
</script>

<svelte:head><title>Pages</title></svelte:head>

<div class="head">
	<h1>Pages</h1>
	<button type="button" onclick={() => (newOpen = true)}>+ New page</button>
</div>
<p class="muted intro">
	Simple hosted pages built from blocks — link them from emails (e.g. a “how you got on this
	list” page), the unsubscribe flow, or anywhere. Published pages are public at
	<code>{data.baseUrl}/p/&lt;slug&gt;</code>; drafts 404.
</p>

<Modal title="New page" bind:open={newOpen}>
	<form method="POST" action="?/create" use:enhance class="newform">
		<label>
			Title
			<!-- svelte-ignore a11y_autofocus -->
			<input name="title" bind:value={title} autofocus required maxlength="120" placeholder="e.g. How you got on this list" />
		</label>
		<label>
			Slug <span class="muted">(the URL: /p/…)</span>
			<input name="slug" bind:value={slug} oninput={() => (slugTouched = true)} required maxlength="60" placeholder="how-you-got-on-this-list" />
		</label>
		<button type="submit">Create & edit</button>
	</form>
	{#if form?.error}<p class="err">{form.error}</p>{/if}
</Modal>

<section class="card">
	{#if data.pages.length === 0}
		<p class="muted">No pages yet. Create one with the button above.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Title</th><th>URL</th><th>Status</th><th>Updated</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.pages as p (p.id)}
						<tr>
							<td><a href="/pages/{p.id}">{p.title}</a></td>
							<td class="muted slug">
								{#if p.published}
									<a href="{data.baseUrl}/p/{p.slug}" target="_blank" rel="noopener">/p/{p.slug}</a>
								{:else}
									/p/{p.slug}
								{/if}
							</td>
							<td>
								{#if p.published}<span class="badge sent">Published</span>
								{:else}<span class="badge draft">Draft</span>{/if}
							</td>
							<td class="muted">{p.updated_at}</td>
							<td class="right">
								<form method="POST" action="?/delete" use:enhance class="inline">
									<input type="hidden" name="id" value={p.id} />
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
	@media (max-width: 640px) {
		.head { flex-direction: column; align-items: flex-start; gap: var(--space-s); }
		.head button { padding: var(--space-xxs) var(--space-s); }
	}
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 62ch; }
	.intro code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	.newform { display: flex; flex-direction: column; gap: var(--space-s); margin: 0; }
	.newform label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.newform button { align-self: flex-start; }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.slug { font-family: var(--font-mono); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.right { text-align: right; }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.inline { margin: 0; display: inline; }
</style>

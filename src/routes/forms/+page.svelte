<script lang="ts">
	import { enhance } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	let { data } = $props();
	const statusClass = (s: string) => (s === 'published' ? 'sent' : 'draft');
	const statusLabel = (s: string) => (s === 'published' ? 'Published' : s === 'archived' ? 'Archived' : 'Draft');
</script>

<svelte:head><title>Forms</title></svelte:head>

<Breadcrumbs items={[{ label: 'Creative' }, { label: 'Forms' }]} />

<div class="head">
	<h1>Forms</h1>
	{#if data.isAdmin}<a href="/forms/new"><button type="button">+ New form</button></a>{/if}
</div>
<p class="muted intro">
	Hosted sign-up and feedback forms. A submission creates or updates the contact, fills the
	fields you map, and can add tags, lists and topics. Published forms are public at
	<code>{data.baseUrl}/f/&lt;slug&gt;</code>; drafts 404.
</p>

<nav class="views" aria-label="Form views">
	<a href="/forms" aria-current={data.archived ? undefined : 'page'}>Active</a>
	<a href="/forms?archived=1" aria-current={data.archived ? 'page' : undefined}>Archived</a>
</nav>

<section class="card">
	{#if data.forms.length === 0}
		<p class="muted">{data.archived ? 'No archived forms.' : 'No forms yet.'}{#if data.isAdmin && !data.archived} Create one with “New form”.{/if}</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Name</th><th>URL</th><th>Status</th><th class="num">Submissions</th><th>Last submission</th><th>Updated</th>{#if data.archived && data.isAdmin}<th></th>{/if}</tr>
				</thead>
				<tbody>
					{#each data.forms as f (f.id)}
						<tr>
							<td><a href="/forms/{f.id}">{f.name}</a></td>
							<td class="muted slug">
								{#if f.status === 'published'}
									<a href="{data.baseUrl}/f/{f.slug}" target="_blank" rel="noopener">/f/{f.slug}</a>
								{:else}/f/{f.slug}{/if}
							</td>
							<td><span class="badge {statusClass(f.status)}">{statusLabel(f.status)}</span></td>
							<td class="num"><a href="/forms/{f.id}?tab=submissions">{f.submissions.toLocaleString()}</a></td>
							<td class="muted">{f.last_submission_at ?? '—'}</td>
							<td class="muted">{f.updated_at}</td>
							{#if data.archived && data.isAdmin}
								<td class="right">
									<form method="POST" action="?/restore" use:enhance class="inline">
										<input type="hidden" name="id" value={f.id} />
										<button type="submit" class="secondary small">Restore</button>
									</form>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 62ch; }
	.intro code { font-size: var(--size-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	.views { display: flex; gap: var(--space-m); margin-bottom: var(--space-s); font-size: var(--size-s); line-height: var(--line-s); }
	.views a { color: var(--muted); text-decoration: none; padding-bottom: var(--space-xxs); }
	.views a[aria-current='page'] { color: var(--text); box-shadow: inset 0 calc(-1 * var(--border-l)) 0 var(--btn-primary-bg); }
	.slug { font-family: var(--font-mono); font-size: var(--size-s); }
	.num { text-align: right; }
	.right { text-align: right; }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); }
	.inline { margin: 0; display: inline; }
</style>

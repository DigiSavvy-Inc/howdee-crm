<script lang="ts">
	// Reports (#356): save a contacts / companies report's results as a segment or list,
	// and tag / untag them. Posts the spec the counts were computed from.
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { ReportSpec } from '$lib/report-spec';
	import type { AudienceForm, AudienceLoad } from '$lib/server/reports/audience';

	let {
		audience,
		spec,
		reportName,
		form
	}: { audience: AudienceLoad; spec: ReportSpec; reportName: string; form: AudienceForm | null } = $props();

	const specJson = $derived(JSON.stringify(spec));
	const fmt = (n: number) => n.toLocaleString('en-US');
	const contactsLabel = $derived(`${fmt(audience.total)} contact${audience.total === 1 ? '' : 's'}`);

	let segmentName = $state(untrack(() => reportName.slice(0, 60)));
	let listId = $state('');
	let newList = $state(untrack(() => reportName.slice(0, 60)));
	let tag = $state('');
</script>

<section class="card audience" aria-labelledby="audience-h">
	<h2 id="audience-h">Save contacts as…</h2>
	<p class="count">
		<strong>{contactsLabel}</strong> · {fmt(audience.subscribed)} subscribed
		<span class="muted">
			{spec.entity === 'companies' ? '— every contact of every matching company.' : '— every matching contact, not only the rows shown.'}
		</span>
	</p>
	{#if audience.savedAs.length}
		<p class="saved">
			Saved as:
			{#each audience.savedAs as group, i (group.id)}{i ? ', ' : ''}<a href="/lists/{group.id}">{group.name}</a> <span class="muted">({group.kind === 'segment' ? 'segment' : 'list'})</span>{/each}
		</p>
	{/if}
	{#if form?.audienceSuccess}
		<p class="ok" role="status">
			{form.audienceSuccess}{#if form.audienceHref}{' '}<a href={form.audienceHref}>Open</a>{/if}
		</p>
	{/if}
	{#if form?.audienceError}<p class="err" role="alert">{form.audienceError}</p>{/if}

	<div class="grid">
		<div>
			<h3>Live segment</h3>
			{#if audience.liveBlocker}
				<p class="muted">{audience.liveBlocker}</p>
			{:else}
				<p class="muted">Keeps these filters, so membership updates on its own.</p>
				<form method="POST" action="?/saveSegment" use:enhance>
					<input type="hidden" name="spec" value={specJson} />
					<input type="hidden" name="report_name" value={reportName} />
					<label class="field">Segment name <input name="name" bind:value={segmentName} maxlength="60" required /></label>
					<button type="submit" disabled={!segmentName.trim()}>Save as segment</button>
				</form>
			{/if}
		</div>

		<div>
			<h3>Static list</h3>
			<p class="muted">A snapshot of today's {contactsLabel}. It won't change later.</p>
			<form method="POST" action="?/saveList" use:enhance>
				<input type="hidden" name="spec" value={specJson} />
				<input type="hidden" name="report_name" value={reportName} />
				<label class="field">List
					<select name="list_id" bind:value={listId}>
						<option value="">New list…</option>
						{#each audience.lists as list (list.id)}<option value={String(list.id)}>Add to an existing list: {list.name}</option>{/each}
					</select>
				</label>
				{#if !listId}
					<label class="field">New list name <input name="new_list" bind:value={newList} maxlength="60" required /></label>
				{/if}
				<button type="submit" class="secondary" disabled={audience.overCap || !audience.total || (!listId && !newList.trim())}>
					{listId ? 'Add to list' : 'Save as list'}
				</button>
			</form>
		</div>

		<div>
			<h3>Tags</h3>
			<p class="muted">Add or remove a tag on all {contactsLabel}.</p>
			<form method="POST" action="?/addTag" use:enhance>
				<input type="hidden" name="spec" value={specJson} />
				<label class="field">Tag <input name="tag" bind:value={tag} list="audience-tags" maxlength="60" required /></label>
				<datalist id="audience-tags">{#each audience.tags as name (name)}<option value={name}></option>{/each}</datalist>
				<div class="row">
					<button type="submit" class="secondary" disabled={audience.overCap || !audience.total || !tag.trim()}>Add tag</button>
					<button
						type="submit"
						class="secondary"
						formaction="?/removeTag"
						disabled={audience.overCap || !audience.total || !tag.trim()}
						onclick={(event) => { if (!confirm(`Remove the tag “${tag.trim()}” from ${contactsLabel}?`)) event.preventDefault(); }}
					>Remove tag</button>
				</div>
			</form>
		</div>
	</div>
	{#if audience.overCap}
		<p class="muted">Lists and tags are capped at 20,000 contacts. Narrow the filters to use them.</p>
	{/if}
	<p class="muted note">Nothing here sends, schedules or starts automations. Unsubscribed contacts are included; sends skip them.</p>
</section>

<style>
	.audience {
		min-width: 0;
	}
	h2 {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		margin: 0 0 var(--space-xs);
	}
	h3 {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		margin: 0 0 var(--space-xxs);
	}
	p {
		margin: 0 0 var(--space-xs);
	}
	.muted {
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.ok {
		color: var(--success);
	}
	.err {
		color: var(--error);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-m);
		margin-top: var(--space-s);
	}
	form {
		margin: 0;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		margin: 0 0 var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.field input,
	.field select {
		color: var(--text);
		width: 100%;
	}
	.row {
		display: flex;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	.note {
		margin-top: var(--space-s);
	}
</style>

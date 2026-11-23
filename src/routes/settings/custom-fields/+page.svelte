<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { CUSTOM_FIELD_LIMITS, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, fieldKeyFromLabel, type CustomFieldType } from '$lib/custom-fields';

	let { data, form } = $props();

	// #619: Settings → Custom fields. Contact values stay in contacts.meta; this only names them.
	const active = $derived(data.fields.filter((f) => !f.archived_at));
	const archived = $derived(data.fields.filter((f) => f.archived_at));

	let newLabel = $state('');
	let newKey = $state('');
	let newType = $state<CustomFieldType>('text');
	let editing = $state<number | null>(null);
	let editType = $state<CustomFieldType>('text');

	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
		await update({ reset: false });
	};
</script>

<svelte:head><title>Custom fields</title></svelte:head>

<h1>Custom fields</h1>
<p class="muted intro">
	Extra details kept on each contact (budget, role, project type…). Name them here and give them a type; forms, the
	contact page and segment rules then offer them by label. Values are stored on the contact under the field's key, so
	the API, webhooks and CSV import keep working as before. Archiving a field hides it from pickers and never removes
	contact data.
</p>

{#if form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
{#if form?.ok}<p class="notice ok" role="status">{form.ok}</p>{/if}

<section class="card">
	<h2>Fields</h2>
	{#if active.length === 0}
		<p class="muted small">No custom fields yet.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Label</th><th>Key</th><th>Type</th><th class="num">Contacts</th><th>Forms</th><th><span class="sr">Actions</span></th></tr>
				</thead>
				<tbody>
					{#each active as f, i (f.id)}
						{#if editing === f.id}
							<tr>
								<td colspan="6">
									<form method="POST" action="?/update" class="edit" use:enhance={() => async ({ update, result }) => { await update({ reset: false }); if (result.type === 'success') editing = null; }}>
										<input type="hidden" name="id" value={f.id} />
										<label>Label <input name="label" value={f.label} maxlength={CUSTOM_FIELD_LIMITS.label} required /></label>
										<label>Type
											<select name="type" bind:value={editType} disabled={f.built_in}>
												{#each CUSTOM_FIELD_TYPES as t (t)}<option value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>{/each}
											</select>
										</label>
										{#if f.built_in}<input type="hidden" name="type" value={f.type} />{/if}
										{#if editType === 'choice'}
											<label class="wide">Options <span class="muted">(one per line)</span>
												<textarea name="options" rows="4">{f.options.join('\n')}</textarea>
											</label>
										{/if}
										<div class="row-actions">
											<button type="submit">Save</button>
											<button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
										</div>
									</form>
								</td>
							</tr>
						{:else}
							<tr>
								<td>{f.label}{#if f.built_in} <span class="badge">built in</span>{/if}</td>
								<td><code>{f.key}</code></td>
								<td>{CUSTOM_FIELD_TYPE_LABELS[f.type]}{#if f.type === 'choice'}<span class="muted small"> · {f.options.join(', ')}</span>{/if}</td>
								<td class="num">{f.count.toLocaleString()}</td>
								<td>
									{#each f.forms as fm, j (fm.id)}{j ? ', ' : ''}<a href="/forms/{fm.id}">{fm.name}</a>{:else}<span class="muted">—</span>{/each}
								</td>
								<td class="acts">
									<form method="POST" action="?/move" use:enhance={keep} class="inline">
										<input type="hidden" name="id" value={f.id} />
										<button type="submit" name="dir" value="up" class="icon-btn" aria-label="Move {f.label} up" disabled={i === 0}><Icon name="arrow-up" size={16} /></button>
										<button type="submit" name="dir" value="down" class="icon-btn" aria-label="Move {f.label} down" disabled={i === active.length - 1}><Icon name="arrow-down" size={16} /></button>
									</form>
									<button type="button" class="icon-btn" aria-label="Edit {f.label}" onclick={() => { editing = f.id; editType = f.type; }}><Icon name="edit" size={16} /></button>
									{#if !f.built_in}
										<form method="POST" action="?/archive" use:enhance={keep} class="inline">
											<input type="hidden" name="id" value={f.id} />
											<button type="submit" class="secondary small-btn">Archive</button>
										</form>
									{/if}
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<section class="card">
	<h2>New field</h2>
	<form method="POST" action="?/create" class="edit" use:enhance={() => async ({ update, result }) => { await update({ reset: false }); if (result.type === 'success') { newLabel = ''; newKey = ''; newType = 'text'; } }}>
		<label>Label <input name="label" bind:value={newLabel} maxlength={CUSTOM_FIELD_LIMITS.label} required placeholder="e.g. Monthly budget" /></label>
		<label>Key <span class="muted">(optional)</span>
			<input name="key" bind:value={newKey} maxlength={CUSTOM_FIELD_LIMITS.key} spellcheck="false" placeholder={fieldKeyFromLabel(newLabel) || 'monthly_budget'} />
		</label>
		<label>Type
			<select name="type" bind:value={newType}>
				{#each CUSTOM_FIELD_TYPES as t (t)}<option value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>{/each}
			</select>
		</label>
		{#if newType === 'choice'}
			<label class="wide">Options <span class="muted">(one per line)</span><textarea name="options" rows="4"></textarea></label>
		{/if}
		<div class="row-actions"><button type="submit">Create field</button></div>
	</form>
	<p class="muted small">The key is what the API, webhooks, CSV import and <code>{'{{field:key}}'}</code> merge tags use. It can't change later.</p>
</section>

{#if data.undefinedKeys.length}
	<section class="card">
		<h2>Found on contacts, not defined</h2>
		<p class="muted small">Keys stored on contacts (by a form, webhook, API call or import) that have no definition yet.</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Key</th><th class="num">Contacts</th><th>Forms</th><th><span class="sr">Actions</span></th></tr></thead>
				<tbody>
					{#each data.undefinedKeys as u (u.key)}
						<tr>
							<td><code>{u.key}</code></td>
							<td class="num">{u.count.toLocaleString()}</td>
							<td>{#each u.forms as fm, j (fm.id)}{j ? ', ' : ''}<a href="/forms/{fm.id}">{fm.name}</a>{:else}<span class="muted">—</span>{/each}</td>
							<td class="acts">
								<form method="POST" action="?/define" use:enhance={keep} class="inline">
									<input type="hidden" name="key" value={u.key} />
									<button type="submit" class="secondary small-btn">Define</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

{#if archived.length}
	<section class="card">
		<h2>Archived</h2>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Label</th><th>Key</th><th class="num">Contacts</th><th><span class="sr">Actions</span></th></tr></thead>
				<tbody>
					{#each archived as f (f.id)}
						<tr>
							<td>{f.label}</td>
							<td><code>{f.key}</code></td>
							<td class="num">{f.count.toLocaleString()}</td>
							<td class="acts">
								<form method="POST" action="?/restore" use:enhance={keep} class="inline">
									<input type="hidden" name="id" value={f.id} />
									<button type="submit" class="secondary small-btn">Restore</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.intro { margin: 0 0 var(--space-m); }
	.small { font-size: var(--size-s); line-height: var(--line-s); }
	.table-wrap { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; font-size: var(--size-s); line-height: var(--line-s); }
	th, td { text-align: left; padding: var(--space-xs); vertical-align: middle; }
	th { color: var(--muted); font-weight: var(--weight-ui-medium); }
	tbody tr { box-shadow: inset 0 var(--border-s) 0 var(--border-muted); }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	.acts { white-space: nowrap; text-align: right; }
	.inline { display: inline-flex; gap: var(--space-xxs); margin: 0; }
	.icon-btn { background: none; border: 0; padding: var(--space-xxs); color: var(--muted); cursor: pointer; border-radius: var(--radius-xs); display: inline-flex; min-height: 0; box-shadow: none; }
	.icon-btn:hover:not(:disabled) { color: var(--text); background: var(--surface-subtle); }
	.icon-btn:disabled { opacity: 0.35; cursor: default; }
	.small-btn { padding: var(--space-xxs) var(--space-s); }
	.badge { font-size: var(--size-xs); color: var(--muted); padding: 0 var(--space-xs); border-radius: var(--radius-full); box-shadow: inset 0 0 0 var(--border-s) var(--border); }
	.edit { display: flex; flex-wrap: wrap; gap: var(--space-s); align-items: flex-end; }
	.edit label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); }
	.edit .wide { flex-basis: 100%; }
	.row-actions { display: flex; gap: var(--space-xs); }
	.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { invalidateAll } from '$app/navigation';
	import { STAGE_COLORS, STAGE_KINDS, stageColorVar } from '$lib/pipeline';

	let { data, form } = $props();
	type Stage = (typeof data.stages)[number];

	let stages = $derived([...data.stages]);
	let error = $state<string | null>(null);
	$effect(() => {
		error = form?.error ?? null;
	});
	const KIND_LABEL = { open: 'Open', won: 'Won', lost: 'Lost' } as const;

	// Drag reorder (native HTML5); ↑/↓ buttons are the keyboard/touch path.
	let dragId = $state<number | null>(null);
	function onDragOver(e: DragEvent, over: Stage) {
		if (dragId == null || dragId === over.id) return;
		e.preventDefault();
		const from = stages.findIndex((s) => s.id === dragId);
		const to = stages.findIndex((s) => s.id === over.id);
		const next = [...stages];
		next.splice(to, 0, next.splice(from, 1)[0]!);
		stages = next;
	}
	async function onDrop(e: DragEvent) {
		e.preventDefault();
		dragId = null;
		const fd = new FormData();
		fd.set('order', stages.map((s) => s.id).join(','));
		const res = await fetch('?/reorder', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const result = deserialize(await res.text());
		error = result.type === 'failure' ? String(result.data?.error ?? 'Reorder failed.') : null;
		await invalidateAll();
	}
</script>

<svelte:head><title>Pipeline stages</title></svelte:head>

<Breadcrumbs items={[{ label: 'Pipeline', href: '/pipeline' }, { label: 'Stages' }]} />
<h1>Pipeline stages</h1>
<p class="muted intro">
	Open stages are the board's columns, in this order. Won and Lost stages sit at the end as compact columns.
	Drag a row or use ↑ ↓ to reorder.
</p>

{#if error}<p class="err" role="alert">{error}</p>{/if}
{#if form?.ok && !error}<p class="ok" role="status">{form.ok}</p>{/if}

<section class="card">
	<ol class="stages">
		{#each stages as s, i (s.id)}
			<li
				class="stage"
				class:dragging={dragId === s.id}
				draggable="true"
				ondragstart={(e) => {
					dragId = s.id;
					e.dataTransfer?.setData('text/plain', String(s.id));
				}}
				ondragend={() => (dragId = null)}
				ondragover={(e) => onDragOver(e, s)}
				ondrop={onDrop}
			>
				<span class="handle muted" aria-hidden="true">⋮⋮</span>
				<div class="arrows">
					<form method="POST" action="?/nudge" use:enhance>
						<input type="hidden" name="id" value={s.id} />
						<input type="hidden" name="dir" value="up" />
						<button type="submit" class="icon" disabled={i === 0} aria-label="Move {s.name} up">↑</button>
					</form>
					<form method="POST" action="?/nudge" use:enhance>
						<input type="hidden" name="id" value={s.id} />
						<input type="hidden" name="dir" value="down" />
						<button type="submit" class="icon" disabled={i === stages.length - 1} aria-label="Move {s.name} down">↓</button>
					</form>
				</div>
				<form method="POST" action="?/update" use:enhance={() => async ({ update }) => update({ reset: false })} class="edit">
					<input type="hidden" name="id" value={s.id} />
					<input name="name" value={s.name} maxlength="40" required aria-label="Stage name" class="name" />
					<fieldset class="swatches">
						<legend class="sr-only">Colour for {s.name}</legend>
						{#each STAGE_COLORS as col (col)}
							<label class="swatch" title={col} style="--sw: {stageColorVar(col)}">
								<input type="radio" name="color" value={col} checked={(s.color ?? 'muted') === col} />
								<span class="sr-only">{col}</span>
							</label>
						{/each}
					</fieldset>
					<select name="kind" value={s.kind} aria-label="Kind for {s.name}">
						{#each STAGE_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
					</select>
					<button type="submit" class="secondary small">Save</button>
				</form>
				<form
					method="POST"
					action="?/delete"
					class="del"
					use:enhance={({ cancel }) => {
						if (!confirm(`Delete the “${s.name}” stage?`)) cancel();
						return async ({ update }) => update();
					}}
				>
					<input type="hidden" name="id" value={s.id} />
					<span class="muted cards">{s.cards} card{s.cards === 1 ? '' : 's'}</span>
					{#if s.cards > 0}
						<select name="move_to" required aria-label="Move {s.name}'s cards to">
							<option value="">Move cards to…</option>
							{#each stages.filter((o) => o.id !== s.id) as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
						</select>
					{/if}
					<button type="submit" class="secondary small danger">Delete</button>
				</form>
				{#if form && 'errorId' in form && form.errorId === s.id && form.error}<p class="err row-err">{form.error}</p>{/if}
			</li>
		{/each}
	</ol>
</section>

<section class="card add">
	<h2>Add a stage</h2>
	<form method="POST" action="?/create" use:enhance class="edit">
		<input name="name" maxlength="40" required placeholder="e.g. Discovery call" aria-label="New stage name" class="name" />
		<fieldset class="swatches">
			<legend class="sr-only">Colour</legend>
			{#each STAGE_COLORS as col (col)}
				<label class="swatch" title={col} style="--sw: {stageColorVar(col)}">
					<input type="radio" name="color" value={col} checked={col === 'muted'} />
					<span class="sr-only">{col}</span>
				</label>
			{/each}
		</fieldset>
		<select name="kind" aria-label="Kind">
			{#each STAGE_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
		</select>
		<button type="submit">Add stage</button>
	</form>
</section>

<style>
	h1 { margin: 0 0 var(--space-xs); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: 0 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); }
	.ok { color: var(--success); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.stages { list-style: none; margin: 0; padding: 0; }
	.stage {
		display: flex; align-items: center; gap: var(--space-s); flex-wrap: wrap;
		padding: var(--space-xs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.stage:last-child { box-shadow: none; }
	.stage.dragging { opacity: 0.5; }
	.handle { cursor: grab; letter-spacing: -2px; user-select: none; }
	.arrows { display: inline-flex; gap: var(--space-xxs); }
	.arrows form, .edit, .del { margin: 0; }
	.icon { padding: 0 var(--space-xs); line-height: var(--line-s); font-size: var(--size-s); letter-spacing: var(--letter-spacing-s); }
	.edit { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; flex: 1; min-width: 0; }
	.name { width: 12rem; max-width: 100%; }
	.swatches { display: inline-flex; gap: var(--space-xxs); border: 0; padding: 0; margin: 0; }
	.swatch { position: relative; display: inline-block; width: 18px; height: 18px; border-radius: 50%; background: var(--sw); cursor: pointer; }
	.swatch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
	.swatch:has(input:checked) { outline: 2px solid var(--text); outline-offset: 2px; }
	.swatch:has(input:focus-visible) { box-shadow: 0 0 0 var(--border-l) var(--focus-ring); }
	.del { display: inline-flex; align-items: center; gap: var(--space-xs); margin-left: auto; }
	.cards { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; }
	.danger { color: var(--danger); }
	.row-err { flex-basis: 100%; margin: var(--space-xxs) 0 0; }
	.add { margin-top: var(--space-m); }
	@media (max-width: 768px) {
		.icon { min-width: 40px; min-height: 40px; }
		.swatch { width: 24px; height: 24px; }
		.del { margin-left: 0; }
	}
</style>

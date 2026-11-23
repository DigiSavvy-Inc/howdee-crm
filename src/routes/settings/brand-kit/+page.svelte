<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { normalizeHex } from '$lib/brand';
	let { data, form } = $props();

	// #595: the brand kit — swatches and logos the editors offer as presets.
	const keep = () =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	const resetAfter = () =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update();
		};

	let newHex = $state('#1d4ed8');
	let editing = $state<string | null>(null);
	let editingLogo = $state<string | null>(null);
</script>

<svelte:head><title>Brand kit</title></svelte:head>

<h1>Brand kit</h1>
<p class="muted intro">
	The colours and logos offered as presets in the email, template, page and automation editors and in the colour
	pickers. Changing the kit doesn't touch anything already saved: emails, templates and pages keep the colours and
	logo images they were made with.
</p>

<section class="card" aria-labelledby="kit-colours">
	<h2 id="kit-colours">Colours</h2>
	<p class="muted small">Up to {data.limits.swatches}. The order here is the order in the pickers.</p>
	{#if form?.section === 'swatch' && form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
	{#if data.kit.swatches.length}
		<ul class="rows">
			{#each data.kit.swatches as s, i (s.key)}
				<li class="row">
					<span class="chip" style="background:{s.hex}" aria-hidden="true"></span>
					{#if editing === s.key}
						<form method="POST" action="?/updateSwatch" class="inline" use:enhance={() => async ({ update, result }) => { await update({ reset: false }); if (result.type === 'success') editing = null; }}>
							<input type="hidden" name="key" value={s.key} />
							<label>Name <input name="label" value={s.label} maxlength={data.limits.label} required /></label>
							<label>Hex <input name="hex" value={s.hex} pattern={'#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?'} required size="8" /></label>
							<button type="submit">Save</button>
							<button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
						</form>
					{:else}
						<span class="name">{s.label}</span>
						<code class="muted">{s.hex}</code>
						<span class="tools">
							<form method="POST" action="?/moveSwatch" use:enhance={keep}>
								<input type="hidden" name="key" value={s.key} />
								<button type="submit" name="dir" value="up" class="icon" disabled={i === 0} aria-label="Move {s.label} up"><Icon name="arrow-up" size={16} /></button>
								<button type="submit" name="dir" value="down" class="icon" disabled={i === data.kit.swatches.length - 1} aria-label="Move {s.label} down"><Icon name="arrow-down" size={16} /></button>
							</form>
							<button type="button" class="secondary" onclick={() => (editing = s.key)}>Edit</button>
							<form method="POST" action="?/removeSwatch" use:enhance={keep}>
								<input type="hidden" name="key" value={s.key} />
								<button type="submit" class="secondary" aria-label="Remove {s.label}">Remove</button>
							</form>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">No colours yet.</p>
	{/if}
	{#if data.kit.swatches.length < data.limits.swatches}
		<form method="POST" action="?/addSwatch" class="inline add" use:enhance={resetAfter}>
			<label>Name <input name="label" maxlength={data.limits.label} required placeholder="e.g. Brand blue" /></label>
			<label>Hex <input name="hex" bind:value={newHex} pattern={'#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?'} required size="8" /></label>
			<input type="color" value={normalizeHex(newHex) || '#000000'} oninput={(e) => (newHex = e.currentTarget.value)} aria-label="Pick a colour" />
			<button type="submit">Add colour</button>
		</form>
	{/if}
</section>

<section class="card" aria-labelledby="kit-logos">
	<h2 id="kit-logos">Logos</h2>
	<p class="muted small">
		Offered by an image block's "Brand logo" quick insert. PNG or WebP, up to 512 KB (email clients can't show SVG).
		Mark each for a light or a dark background so it lands on the right one.
	</p>
	{#if form?.section === 'logo' && form?.error}<p class="notice err" role="alert">{form.error}</p>{/if}
	{#if data.kit.logos.length}
		<ul class="rows">
			{#each data.kit.logos as l, i (l.key)}
				<li class="row">
					<span class="logo" class:dark={l.background === 'dark'}><img src={l.src} alt={l.alt || l.label} /></span>
					{#if editingLogo === l.key}
						<form method="POST" action="?/updateLogo" class="inline" use:enhance={() => async ({ update, result }) => { await update({ reset: false }); if (result.type === 'success') editingLogo = null; }}>
							<input type="hidden" name="key" value={l.key} />
							<label>Name <input name="label" value={l.label} maxlength={data.limits.label} required /></label>
							<label>Alt text <input name="alt" value={l.alt} maxlength={data.limits.alt} /></label>
							<label>Made for
								<select name="background" value={l.background}>
									{#each data.backgrounds as b (b.key)}<option value={b.key}>{b.label}</option>{/each}
								</select>
							</label>
							<button type="submit">Save</button>
							<button type="button" class="secondary" onclick={() => (editingLogo = null)}>Cancel</button>
						</form>
					{:else}
						<span class="name">{l.label}<span class="muted small"> · {l.background === 'dark' ? 'dark background' : 'light background'}</span></span>
						<span class="tools">
							<form method="POST" action="?/moveLogo" use:enhance={keep}>
								<input type="hidden" name="key" value={l.key} />
								<button type="submit" name="dir" value="up" class="icon" disabled={i === 0} aria-label="Move {l.label} up"><Icon name="arrow-up" size={16} /></button>
								<button type="submit" name="dir" value="down" class="icon" disabled={i === data.kit.logos.length - 1} aria-label="Move {l.label} down"><Icon name="arrow-down" size={16} /></button>
							</form>
							<button type="button" class="secondary" onclick={() => (editingLogo = l.key)}>Edit</button>
							<form method="POST" action="?/removeLogo" use:enhance={keep}>
								<input type="hidden" name="key" value={l.key} />
								<button type="submit" class="secondary" aria-label="Remove {l.label}">Remove</button>
							</form>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">No logos yet.</p>
	{/if}
	{#if data.kit.logos.length < data.limits.logos}
		<form method="POST" action="?/addLogo" enctype="multipart/form-data" class="inline add" use:enhance={resetAfter}>
			<label>Name <input name="label" maxlength={data.limits.label} required placeholder="e.g. Primary logo" /></label>
			<label>Alt text <input name="alt" maxlength={data.limits.alt} placeholder="Company name" /></label>
			<label>Made for
				<select name="background">
					{#each data.backgrounds as b (b.key)}<option value={b.key}>{b.label}</option>{/each}
				</select>
			</label>
			<label>Image <input type="file" name="file" accept="image/png,image/webp" required /></label>
			<button type="submit">Upload logo</button>
		</form>
	{/if}
</section>

<style>
	.intro {
		margin: 0 0 var(--space-m);
	}
	.small {
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.card + .card {
		margin-top: var(--card-gap, var(--space-m));
	}
	.rows {
		list-style: none;
		margin: 0 0 var(--space-s);
		padding: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-xs) 0;
		border-bottom: 1px solid var(--border);
	}
	.chip {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		flex: none;
	}
	.logo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 6rem;
		height: 2.5rem;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: #ffffff;
		flex: none;
	}
	.logo.dark {
		background: #111111;
	}
	.logo img {
		max-width: 100%;
		max-height: 100%;
	}
	.name {
		flex: 1 1 10rem;
	}
	.tools {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.tools form {
		display: inline-flex;
		gap: 2px;
	}
	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-s);
		min-width: 0;
		max-width: 100%;
	}
	.inline label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--size-s);
		min-width: 0;
		max-width: 100%;
	}
	/* A file input has an intrinsic width; let fields shrink on a phone screen. */
	.inline label input,
	.inline label select {
		min-width: 0;
		max-width: 100%;
	}
	.add {
		margin-top: var(--space-s);
	}
</style>

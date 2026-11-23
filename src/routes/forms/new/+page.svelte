<script lang="ts">
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
</script>

<svelte:head><title>New form</title></svelte:head>

<Breadcrumbs items={[{ label: 'Creative' }, { label: 'Forms', href: '/forms' }, { label: 'New form' }]} />

<section class="card new">
	<h1>New form</h1>
	<p class="muted">It starts as a draft with an Email question. Nothing is public until you publish it.</p>
	<form method="POST">
		<label>
			Name
			<!-- svelte-ignore a11y_autofocus -->
			<input name="name" required maxlength="120" placeholder="e.g. Book a call" autofocus />
		</label>
		<button type="submit">Create & edit</button>
	</form>
</section>

<style>
	.new { max-width: 520px; }
	h1 { margin: 0 0 var(--space-xs); font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	form { display: flex; flex-direction: column; gap: var(--space-s); margin-top: var(--space-m); }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); }
	button { align-self: flex-start; }
</style>

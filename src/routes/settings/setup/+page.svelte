<script lang="ts">
	let { data } = $props();

	const GROUPS = [
		{ id: 'required', title: 'Required', intro: 'The app needs every one of these to send and track email.' },
		{ id: 'postmark', title: 'Postmark', intro: 'Set up in Postmark itself; tracking and unsubscribes depend on them.' },
		{ id: 'optional', title: 'Optional integrations', intro: 'Each one stays off until you set it up.' }
	] as const;

	const STATE_LABEL = { ready: 'Ready', attention: 'Needs attention', optional: 'Optional, not set' } as const;
	const STATE_CLASS = { ready: 'sent', attention: 'failed', optional: 'draft' } as const;
</script>

<svelte:head><title>Setup</title></svelte:head>

<h1>Setup</h1>
{#if data.first}
	<p class="notice ok" role="status">Your admin account is ready. Work through anything below that needs attention.</p>
{/if}
<p class="muted intro">
	What this install needs to work, checked each time you open the page. Secrets show only as set or not set.
</p>
{#if data.attention > 0}
	<p class="notice warn" role="alert">{data.attention} {data.attention === 1 ? 'check needs' : 'checks need'} attention.</p>
{:else}
	<p class="notice ok" role="status">Every required and Postmark check is ready.</p>
{/if}

{#each GROUPS as g (g.id)}
	{@const rows = data.checks.filter((c) => c.group === g.id)}
	{#if rows.length}
		<section class="card">
			<h2>{g.title}</h2>
			<p class="muted small">{g.intro}</p>
			<ul class="checks">
				{#each rows as c (c.id)}
					<li id={`check-${c.id}`}>
						<div class="head">
							<strong>{c.label}</strong>
							<span class="badge {STATE_CLASS[c.state]}">{STATE_LABEL[c.state]}</span>
						</div>
						<p class="small">{c.detail}</p>
						{#if c.fix}<p class="small muted">Fix: {c.fix}</p>{/if}
						{#if c.href}<p class="small"><a href={c.href}>Open settings</a></p>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/each}

<style>
	.intro { margin-bottom: var(--space-m); }
	.checks { list-style: none; margin: 0; padding: 0; }
	.checks li { padding: var(--space-s) 0; border-top: 1px solid var(--border, var(--neutral-3)); }
	.checks li:first-child { border-top: 0; }
	.head { display: flex; gap: var(--space-s); align-items: center; justify-content: space-between; flex-wrap: wrap; }
	.checks p { margin: var(--space-3xs, 2px) 0 0; }
	.small { font-size: var(--size-s, 0.875rem); }
</style>

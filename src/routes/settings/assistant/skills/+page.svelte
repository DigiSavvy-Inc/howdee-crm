<script lang="ts">
	import { enhance } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { ALWAYS_ON_TOKEN_WARN, SKILL_MODE_LABELS, alwaysOnSize, skillTitle } from '$lib/ai-skills';

	let { data, form } = $props();

	const size = $derived(alwaysOnSize(data.skills));
</script>

<svelte:head><title>Assistant skills</title></svelte:head>

<Breadcrumbs items={[{ label: 'Settings', href: '/settings' }, { label: 'Assistant', href: '/settings/assistant' }, { label: 'Skills' }]} />

<div class="head">
	<h1>Skills</h1>
	<a class="btnlink" href="/settings/assistant/skills/new">New skill →</a>
</div>
<p class="muted intro">
	Instructions the assistant follows, written in Markdown. <strong>Always on</strong> skills are part of every
	conversation — use them for house style and how to answer. <strong>On demand</strong> skills are listed to the
	assistant by name and description only; it loads the full text when a question fits. Disabled skills are invisible
	to it. Skills can't widen what the assistant may do: it still only reads.
</p>

{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.done}<p class="ok">{form.done}</p>{/if}

<p class="size" class:warn={size.warn}>
	Always-on skills: about <strong>{size.tokens.toLocaleString('en-US')}</strong> tokens ({size.chars.toLocaleString('en-US')} characters ÷ 4) in every conversation.
	{#if size.warn}
		That's over the ~{ALWAYS_ON_TOKEN_WARN.toLocaleString('en-US')}-token guideline — every turn costs more. Consider moving some to On demand.
	{/if}
</p>

{#if data.skills.length === 0}
	<p class="muted">No skills yet.</p>
{:else}
	<ul class="list">
		{#each data.skills as s, i (s.id)}
			<li class="card" class:off={!s.enabled}>
				<div class="main">
					<div class="title">
						<a href={`/settings/assistant/skills/${s.id}`}><strong>{skillTitle(s.name)}</strong></a>
						<code>{s.name}</code>
						<span class="pill" class:always={s.mode === 'always'}>{SKILL_MODE_LABELS[s.mode]}</span>
						{#if !s.enabled}<span class="pill">Disabled</span>{/if}
					</div>
					<p class="desc muted">{s.description}</p>
					<p class="meta muted">
						Edited {s.updated_at.slice(0, 10)}{#if s.updated_by_login}{' '}by @{s.updated_by_login}{/if} · {s.chars.toLocaleString('en-US')} characters
					</p>
				</div>
				<div class="actions">
					<form method="POST" action="?/toggle" use:enhance class="inline">
						<input type="hidden" name="id" value={s.id} />
						<input type="hidden" name="enabled" value={s.enabled ? '0' : '1'} />
						<label class="switch">
							<input
								type="checkbox"
								checked={s.enabled}
								aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
								onchange={(e) => e.currentTarget.form?.requestSubmit()}
							/>
							Enabled
						</label>
					</form>
					<form method="POST" action="?/move" use:enhance class="inline">
						<input type="hidden" name="id" value={s.id} />
						<button type="submit" name="dir" value="up" class="secondary sm" disabled={i === 0} aria-label={`Move ${s.name} up`}>Up</button>
						<button type="submit" name="dir" value="down" class="secondary sm" disabled={i === data.skills.length - 1} aria-label={`Move ${s.name} down`}>Down</button>
					</form>
					<a class="btnlink sm" href={`/settings/assistant/skills/${s.id}`}>Edit</a>
					<form method="POST" action="?/duplicate" use:enhance class="inline">
						<input type="hidden" name="id" value={s.id} />
						<button type="submit" class="secondary sm">Duplicate</button>
					</form>
					<form
						method="POST"
						action="?/delete"
						use:enhance
						class="inline"
						onsubmit={(e) => {
							if (!confirm(`Delete the skill "${s.name}"? The assistant stops using it. This can't be undone.`)) e.preventDefault();
						}}
					>
						<input type="hidden" name="id" value={s.id} />
						<button type="submit" class="secondary sm danger-text">Delete</button>
					</form>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); max-width: 720px; }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 64ch; }
	.size { max-width: 720px; margin: 0 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.size.warn { border-left: 3px solid var(--warn); padding-left: var(--space-xs); }
	.err { color: var(--danger); margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); }
	.ok { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); max-width: 720px; }
	.card.off .main { opacity: 0.7; }
	.title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xxs) var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	code { font-size: var(--size-xs); line-height: var(--line-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); }
	.pill { font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xs); border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
	.pill.always { color: var(--text); }
	.desc, .meta { margin: var(--space-xxs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-top: var(--space-s); }
	.inline { display: inline-flex; gap: var(--space-xxs); margin: 0; }
	.switch { display: inline-flex; align-items: center; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.danger-text { color: var(--danger); }
	.btnlink { display: inline-block; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); text-decoration: none; }
	.btnlink.sm { font-size: var(--size-xs); line-height: var(--line-xs); }
</style>

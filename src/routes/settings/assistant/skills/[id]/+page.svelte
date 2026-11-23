<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import {
		ALWAYS_ON_TOKEN_WARN,
		SKILL_BODY_MAX,
		SKILL_DESCRIPTION_MAX,
		SKILL_MODE_LABELS,
		SKILL_NAME_MAX,
		alwaysOnSize,
		skillTitle,
		type SkillMode
	} from '$lib/ai-skills';
	import { renderAssistantMarkdown } from '$lib/assistant-markdown';

	let { data, form } = $props();

	let name = $state('');
	let description = $state('');
	let body = $state('');
	let mode = $state<SkillMode>('on_demand');
	let enabled = $state(true);
	$effect.pre(() => {
		// A failed save returns the submitted values, so nothing typed is lost.
		type Src = { name: string; description: string; body: string; mode: string; enabled: boolean } | null;
		const src: Src = (form as { values?: Src } | null)?.values ?? data.skill;
		name = src?.name ?? '';
		description = src?.description ?? '';
		body = src?.body ?? '';
		mode = (src?.mode as SkillMode) ?? 'on_demand';
		enabled = src ? !!src.enabled : true;
	});

	let tab = $state<'write' | 'preview'>('write');
	// #300's safe renderer: raw HTML is escaped, only http(s) / app-path links survive.
	const previewHtml = $derived(tab === 'preview' && body.trim() ? renderAssistantMarkdown(body) : '');
	const isNew = $derived(!data.skill);
	const saved = $derived(!!form?.saved || page.url.searchParams.has('saved'));
	// The always-on total if this form were saved as it stands now.
	const size = $derived(alwaysOnSize([{ mode: 'always', enabled: true, chars: data.otherAlwaysChars }, { mode, enabled, chars: body.length }]));
</script>

<svelte:head><title>{isNew ? 'New skill' : `Skill: ${data.skill?.name}`}</title></svelte:head>

<Breadcrumbs
	items={[
		{ label: 'Settings', href: '/settings' },
		{ label: 'Assistant', href: '/settings/assistant' },
		{ label: 'Skills', href: '/settings/assistant/skills' },
		{ label: isNew ? 'New skill' : skillTitle(data.skill?.name ?? '') }
	]}
/>

<h1>{isNew ? 'New skill' : skillTitle(data.skill?.name ?? '')}</h1>
{#if data.skill}
	<p class="muted meta">
		Last edited {data.skill.updated_at.slice(0, 16)} UTC{#if data.skill.updated_by_login}{' '}by @{data.skill.updated_by_login}{/if}
	</p>
{/if}

{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if saved && !form?.error}<p class="ok">Saved. New conversation turns use this version.</p>{/if}

<form method="POST" action="?/save" use:enhance={() => async ({ update }) => update({ reset: false })} class="editor">
	<label>
		Name
		<input name="name" bind:value={name} maxlength={SKILL_NAME_MAX} required spellcheck="false" autocomplete="off" placeholder="campaign-strategy" />
		<span class="hint muted">Lowercase letters, digits and hyphens. The assistant loads an on-demand skill by this name.</span>
	</label>

	<label>
		Description
		<input name="description" bind:value={description} maxlength={SKILL_DESCRIPTION_MAX} required />
		<span class="hint muted">
			{description.length}/{SKILL_DESCRIPTION_MAX}. The assistant reads this to decide when an on-demand skill is
			relevant — say what it's for and when to use it.
		</span>
	</label>

	<fieldset class="mode">
		<legend>Mode</legend>
		<label class="check">
			<input type="radio" name="mode" value="always" bind:group={mode} />
			{SKILL_MODE_LABELS.always}
			<span class="hint muted">In every conversation. For house style and how to answer; keep it short.</span>
		</label>
		<label class="check">
			<input type="radio" name="mode" value="on_demand" bind:group={mode} />
			{SKILL_MODE_LABELS.on_demand}
			<span class="hint muted">Only the name and description are always visible; the full text is loaded when a question fits.</span>
		</label>
	</fieldset>

	<label class="check">
		<input type="checkbox" name="enabled" bind:checked={enabled} />
		Enabled
		<span class="hint muted">A disabled skill is invisible to the assistant.</span>
	</label>

	<div class="body">
		<div class="tabs" role="tablist" aria-label="Instructions">
			<button type="button" role="tab" class="secondary sm" aria-selected={tab === 'write'} class:on={tab === 'write'} onclick={() => (tab = 'write')}>Write</button>
			<button type="button" role="tab" class="secondary sm" aria-selected={tab === 'preview'} class:on={tab === 'preview'} onclick={() => (tab = 'preview')}>Preview</button>
		</div>
		<label class:hidden={tab !== 'write'}>
			<span>Instructions (Markdown)</span>
			<textarea name="body" bind:value={body} rows="20" maxlength={SKILL_BODY_MAX} spellcheck="true"></textarea>
		</label>
		{#if tab === 'preview'}
			<div class="preview" role="tabpanel" aria-label="Preview">
				<!-- Safe: renderAssistantMarkdown escapes all raw HTML and only emits allowlisted links. -->
				{#if previewHtml}{@html previewHtml}{:else}<span class="muted">Nothing to preview yet.</span>{/if}
			</div>
		{/if}
		<p class="hint muted" class:over={body.length > SKILL_BODY_MAX}>
			{body.length.toLocaleString('en-US')}/{SKILL_BODY_MAX.toLocaleString('en-US')} characters. The preview renders the Markdown the
			way the assistant panel does; the assistant receives the raw text.
		</p>
	</div>

	<p class="size" class:warn={size.warn}>
		With this skill as it stands, always-on skills come to about <strong>{size.tokens.toLocaleString('en-US')}</strong> tokens
		({size.chars.toLocaleString('en-US')} characters ÷ 4) per conversation turn.
		{#if size.warn}Over the ~{ALWAYS_ON_TOKEN_WARN.toLocaleString('en-US')}-token guideline — consider On demand or shorter text.{/if}
	</p>

	<div class="actions">
		<button type="submit">{isNew ? 'Create skill' : 'Save'}</button>
		<a class="btnlink" href="/settings/assistant/skills">Back to skills</a>
	</div>
</form>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.meta { margin: var(--space-xxs) 0 var(--space-m); font-size: var(--size-xs); line-height: var(--line-xs); }
	.err { color: var(--danger); margin: var(--space-s) 0; font-size: var(--size-s); line-height: var(--line-s); }
	.ok { margin: var(--space-s) 0; font-size: var(--size-s); line-height: var(--line-s); }
	.editor { display: flex; flex-direction: column; gap: var(--space-s); max-width: 720px; margin-top: var(--space-m); }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	label.check { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: var(--space-xxs) var(--space-xs); }
	label.hidden { display: none; }
	fieldset.mode { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
	legend { padding: 0; margin-bottom: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.hint.over { color: var(--danger); }
	textarea { font-family: var(--font-mono, monospace); font-size: var(--size-xs); line-height: var(--line-s); min-height: 20rem; resize: vertical; }
	.tabs { display: flex; gap: var(--space-xxs); margin-bottom: var(--space-xs); }
	.tabs .on { background: var(--btn-primary-bg); color: var(--btn-primary-text); }
	.preview { overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: var(--radius-s); padding: var(--space-s); min-height: 20rem; font-size: var(--size-s); line-height: var(--line-s); }
	.preview > :global(:first-child) { margin-top: 0; }
	.preview > :global(:last-child) { margin-bottom: 0; }
	.preview :global(:is(p, ul, ol, blockquote, pre, .md-table)) { margin: 0 0 var(--space-xs); }
	.preview :global(:is(ul, ol)) { padding-left: 1.25em; }
	.preview :global(:is(h3, h4)) { margin: var(--space-s) 0 var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); }
	.preview :global(blockquote) { padding-left: var(--space-s); box-shadow: inset 2px 0 0 var(--neutral-4); color: var(--neutral-8); }
	.preview :global(code) { font-family: var(--font-mono, monospace); font-size: 0.92em; padding: 1px 4px; border-radius: var(--radius-s); background: var(--neutral-3); }
	.preview :global(pre) { padding: var(--space-xs) var(--space-s); border-radius: var(--radius-s); background: var(--neutral-2); overflow-x: auto; }
	.preview :global(pre code) { padding: 0; background: none; white-space: pre; overflow-wrap: normal; }
	.preview :global(.md-table) { max-width: 100%; overflow-x: auto; }
	.preview :global(table) { border-collapse: collapse; font-size: var(--size-xs); line-height: var(--line-xs); }
	.preview :global(:is(th, td)) { padding: var(--space-xxs) var(--space-xs); text-align: left; vertical-align: top; box-shadow: inset 0 -1px 0 var(--neutral-4); }
	.preview :global(.md-right) { text-align: right; }
	.body .hint { margin: var(--space-xxs) 0 0; }
	.size { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.size.warn { border-left: 3px solid var(--warn); padding-left: var(--space-xs); }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-m); }
	button.sm { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.btnlink { display: inline-block; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); text-decoration: none; }
</style>

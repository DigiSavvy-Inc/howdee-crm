<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import ColorField from '$lib/components/ColorField.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { TOPIC_WARNING_TEXT } from '$lib/topics';
	import { convertFileInput } from '$lib/image-convert';
	import {
		CAPTION_MAX,
		HEADING_MAX,
		LINKS_MAX,
		LINK_LABEL_MAX,
		MESSAGE_MAX,
		DEFAULT_HEADING,
		DEFAULT_AFTER_HEADING,
		mediaUrl,
		videoLabel,
		type PageVideo
	} from '$lib/unsubscribe-page';
	let { data, form } = $props();

	const c = $derived(data.config);
	let busy = $state(false);
	let posterConvertError = $state<Record<string, string>>({});
	// svelte-ignore state_referenced_locally
	let accent = $state<string | null>(data.config.accent);
	// svelte-ignore state_referenced_locally
	let kinds = $state({
		'': data.config.video?.kind ?? 'none',
		after_: data.config.afterVideo?.kind ?? 'none'
	} as Record<string, string>);
	const linkRows = $derived(Array.from({ length: LINKS_MAX }, (_, i) => c.links[i] ?? { label: '', url: '' }));

	// #414: Topics panel — local order, reordered by drag or ↑ / ↓, saved with "Save order".
	type TopicItem = (typeof data.topics)[number];
	let topicOrder = $state<TopicItem[]>([]);
	$effect(() => {
		const rows = data.topics;
		untrack(() => (topicOrder = [...rows]));
	});
	const orderChanged = $derived(topicOrder.map((t) => t.id).join(',') !== data.topics.map((t) => t.id).join(','));
	let dragFrom = $state<number | null>(null);
	function moveTopic(from: number, to: number) {
		if (to < 0 || to >= topicOrder.length || from === to) return;
		const next = [...topicOrder];
		const [item] = next.splice(from, 1);
		next.splice(to, 0, item);
		topicOrder = next;
	}
</script>

<svelte:head><title>Unsubscribe page</title></svelte:head>

{#snippet videoFields(prefix: '' | 'after_', video: PageVideo | null, caption: string)}
	<fieldset class="video">
		<legend>Video <span class="muted">(optional)</span></legend>
		<div class="radios">
			{#each [['none', 'None'], ['embed', 'YouTube, Vimeo or Loom link'], ['upload', 'Upload MP4 / WebM']] as [v, l] (v)}
				<label class="check"><input type="radio" name="{prefix}video_kind" value={v} bind:group={kinds[prefix]} /> {l}</label>
			{/each}
		</div>
		{#if kinds[prefix] === 'embed'}
			<label class="field grow"><span>Video link</span>
				<input
					name="{prefix}video_url"
					type="url"
					value={video?.kind === 'embed' ? video.url : ''}
					placeholder="https://www.youtube.com/watch?v=…"
					autocomplete="off"
					spellcheck="false"
					required
				/>
			</label>
			<p class="muted small">Played through youtube-nocookie.com, player.vimeo.com (do-not-track) or loom.com. Other links are refused.</p>
		{:else if kinds[prefix] === 'upload'}
			{#if video?.kind === 'upload'}
				<p class="small">Current: <a href={mediaUrl(video.key)} target="_blank" rel="noopener">{videoLabel(video)}</a>{#if video.posterKey} · <a href={mediaUrl(video.posterKey)} target="_blank" rel="noopener">poster</a>{/if}. Choose a file to replace it.</p>
			{/if}
			<label class="field"><span>Video file (MP4 or WebM, up to 50 MB)</span>
				<input name="{prefix}video_file" type="file" accept="video/mp4,video/webm" disabled={!data.hasMedia} />
			</label>
			<label class="field"><span>Poster frame <span class="muted">(optional — PNG, JPEG, WebP or AVIF (converted to WebP), up to 2 MB)</span></span>
				<input
					name="{prefix}poster_file"
					type="file"
					accept="image/png,image/jpeg,image/webp,image/avif"
					disabled={!data.hasMedia}
					onchange={async (e) => (posterConvertError[prefix] = await convertFileInput(e.currentTarget))}
				/>
			</label>
			{#if posterConvertError[prefix]}<p class="err small">{posterConvertError[prefix]}</p>{/if}
			{#if video?.kind === 'upload' && video.posterKey}
				<label class="check"><input type="checkbox" name="{prefix}remove_poster" value="1" /> Remove the poster frame</label>
			{/if}
			{#if !data.hasMedia}<p class="err small">Media storage (R2 `MEDIA`) isn't configured, so uploads are off.</p>{/if}
			<p class="muted small">Plays only when the subscriber presses play — never automatically.</p>
		{/if}
		{#if kinds[prefix] !== 'none'}
			<label class="field grow"><span>Caption <span class="muted">(optional, also the video's title)</span></span>
				<input name="{prefix}caption" value={caption} maxlength={CAPTION_MAX} />
			</label>
		{:else}
			<input type="hidden" name="{prefix}caption" value={caption} />
		{/if}
	</fieldset>
{/snippet}

<h1>Unsubscribe page</h1>
<p class="muted intro">
	What people see when they click unsubscribe in an email. The email address, the <strong>Unsubscribe from
	everything</strong> button and the topic preferences always show first; your message and video come after them.
	One-click unsubscribes from the inbox (List-Unsubscribe) never see this page.
	<a href="/unsubscribe/preview" target="_blank" rel="noopener">Open preview</a>
</p>

<form
	method="POST"
	action="?/save"
	enctype="multipart/form-data"
	use:enhance={() => {
		busy = true;
		return async ({ update }) => {
			await update({ reset: false });
			busy = false;
		};
	}}
>
	<section class="card">
		<h2>Before unsubscribing</h2>
		<label class="field grow"><span>Heading</span>
			<input name="heading" value={c.heading} maxlength={HEADING_MAX} placeholder={DEFAULT_HEADING} />
		</label>
		<label class="field"><span>Message <span class="muted">(Markdown, up to {MESSAGE_MAX.toLocaleString('en-US')} characters)</span></span>
			<textarea name="intro" rows="4" maxlength={MESSAGE_MAX}>{c.intro}</textarea>
		</label>
		{@render videoFields('', c.video, c.caption)}
		{#if kinds[''] !== 'none' || kinds.after_ !== 'none'}
			<fieldset>
				<legend>Video placement <span class="muted">(before and after)</span></legend>
				<div class="radios">
					<label class="check"><input type="radio" name="placement" value="below" checked={c.placement === 'below'} /> Below the unsubscribe controls</label>
					<label class="check"><input type="radio" name="placement" value="beside" checked={c.placement === 'beside'} /> Beside them on wide screens (below on phones)</label>
				</div>
			</fieldset>
		{:else}
			<input type="hidden" name="placement" value={c.placement} />
		{/if}
	</section>

	<section class="card">
		<h2>After unsubscribing</h2>
		<label class="field grow"><span>Heading</span>
			<input name="after_heading" value={c.afterHeading} maxlength={HEADING_MAX} placeholder={DEFAULT_AFTER_HEADING} />
		</label>
		<label class="field"><span>Message <span class="muted">(Markdown, shown under “… will no longer receive these emails”)</span></span>
			<textarea name="after_message" rows="4" maxlength={MESSAGE_MAX}>{c.afterMessage}</textarea>
		</label>
		{@render videoFields('after_', c.afterVideo, c.afterCaption)}
		<fieldset>
			<legend>Links <span class="muted">(optional — e.g. “Visit our website”, “Follow us on LinkedIn”)</span></legend>
			{#each linkRows as l, i (i)}
				<div class="row">
					<label class="field"><span>Label</span><input name="link_label_{i}" value={l.label} maxlength={LINK_LABEL_MAX} /></label>
					<label class="field grow"><span>URL</span><input name="link_url_{i}" type="url" value={l.url} placeholder="https://" /></label>
				</div>
			{/each}
		</fieldset>
		<label class="check">
			<input type="checkbox" name="resubscribe" value="1" checked={c.resubscribe} />
			<span>
				Show “Changed your mind? Resubscribe”. It uses the same signed link, so only that address can come back.
				Addresses Postmark suppressed for a hard bounce or a spam complaint are refused. Off by default.
			</span>
		</label>
	</section>

	<section class="card">
		<h2>Branding</h2>
		<p class="muted small">The logo comes from Settings → General → Branding.</p>
		<ColorField label="Accent (buttons and links)" value={accent} autoLabel="Brand default" onchange={(hex) => (accent = hex)} />
		<input type="hidden" name="accent" value={accent ?? ''} />
	</section>

	<div class="row">
		<button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
		<a href="/unsubscribe/preview" target="_blank" rel="noopener">Preview</a>
	</div>
	{#if form && 'error' in form && form.error}<p class="err" role="alert">{form.error}</p>{/if}
	{#if form && 'saved' in form && form.saved}<p class="ok" role="status">Saved.</p>{/if}
</form>

<section class="card topics" aria-labelledby="topics-h">
	<h2 id="topics-h">Topics</h2>
	<p class="muted small">
		Lists marked “Show as a subscription topic” (list → Edit details). Subscribers see each topic's public label and
		short description — never the list's name. A topic without a label whose name looks internal is hidden.
		Drag to reorder.
	</p>
	{#if !topicOrder.length}
		<p class="muted small">No topics yet, so the preference page shows only “Unsubscribe from everything”.</p>
	{:else}
		<form
			method="POST"
			action="?/reorderTopics"
			use:enhance={() =>
				async ({ update }) => {
					await update({ reset: false });
				}}
		>
			<input type="hidden" name="order" value={topicOrder.map((t) => t.id).join(',')} />
			<ol class="topic-list">
				{#each topicOrder as t, i (t.id)}
					<li
						draggable="true"
						class:dragging={dragFrom === i}
						ondragstart={(e) => {
							dragFrom = i;
							e.dataTransfer?.setData('text/plain', String(t.id));
						}}
						ondragover={(e) => e.preventDefault()}
						ondrop={(e) => {
							e.preventDefault();
							if (dragFrom !== null) moveTopic(dragFrom, i);
							dragFrom = null;
						}}
						ondragend={() => (dragFrom = null)}
					>
						<span class="grip" aria-hidden="true"><Icon name="drag-handle" size={16} /></span>
						<span class="t-main">
							<strong>{t.label ?? t.name}</strong>{#if t.topic_blurb}<span class="muted"> — {t.topic_blurb}</span>{/if}
							<span class="muted small t-meta">
								{t.members.toLocaleString('en-US')} member{t.members === 1 ? '' : 's'} ·
								<a href="/lists/{t.id}">{t.name}</a>
							</span>
						</span>
						<span class="t-badges">
							{#each t.warnings as w (w)}<span class="badge warnbadge">{TOPIC_WARNING_TEXT[w]}</span>{/each}
						</span>
						<span class="t-move">
							<button type="button" class="secondary" aria-label="Move {t.label ?? t.name} up" disabled={i === 0} onclick={() => moveTopic(i, i - 1)}><Icon name="arrow-up" size={16} /></button>
							<button type="button" class="secondary" aria-label="Move {t.label ?? t.name} down" disabled={i === topicOrder.length - 1} onclick={() => moveTopic(i, i + 1)}><Icon name="arrow-down" size={16} /></button>
						</span>
					</li>
				{/each}
			</ol>
			<div class="row">
				<button type="submit" disabled={!orderChanged}>Save order</button>
				<a href="/unsubscribe/preview" target="_blank" rel="noopener">Preview page</a>
			</div>
			{#if form && 'topicsSaved' in form && form.topicsSaved}<p class="ok" role="status">Order saved.</p>{/if}
		</form>
	{/if}
</section>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); display: flex; flex-direction: column; gap: var(--space-s); }
	section.card p { max-width: 70ch; margin: 0; }
	fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
	legend { padding: 0; margin-bottom: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); }
	.radios { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-m); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.row { display: flex; gap: var(--space-xs); align-items: flex-end; flex-wrap: wrap; }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 48rem; }
	.field textarea { width: 100%; }
	.grow { flex: 1; min-width: 14rem; max-width: 36rem; }
	.check { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	.err { color: var(--danger); margin: var(--space-xs) 0; }
	.ok { margin: var(--space-xs) 0; }
	.topics { margin-top: var(--space-m); }
	.topic-list { list-style: none; padding: 0; margin: 0 0 var(--space-s); display: flex; flex-direction: column; gap: var(--space-xs); }
	.topic-list li {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-xs) var(--space-s);
		border-radius: var(--radius-s);
		box-shadow: inset 0 0 0 var(--border-s) var(--border);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.topic-list li.dragging { opacity: 0.5; }
	.grip { cursor: grab; color: var(--muted); display: inline-flex; }
	.t-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
	.t-meta { margin-top: var(--space-xxs); }
	.t-badges { display: flex; gap: var(--space-xxs); flex-wrap: wrap; }
	.warnbadge { background: var(--warning-transparent); color: var(--text); }
	.t-move { display: flex; gap: var(--space-xxs); }
	.t-move button { padding: var(--space-xxs); display: inline-flex; }
</style>

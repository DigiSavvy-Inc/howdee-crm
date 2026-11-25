<script lang="ts">
	// The public unsubscribe page (#374), shared by /unsubscribe and the admin preview
	// (/unsubscribe/preview). Compliance order, not configurable: logo → heading → the
	// address → "Unsubscribe from everything" → topic preferences → custom text → video.
	// The video sits below the controls, or beside them on wide screens — never above, and it
	// comes after them in the DOM (so in the focus order too).
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import { renderAssistantMarkdown } from '$lib/assistant-markdown';
	import { autoTextColor } from '$lib/brand';
	import { UNSUBSCRIBE_REASONS, videoForState, type UnsubPageConfig, type UnsubState } from '$lib/unsubscribe-page';
	import { topicLayout } from '$lib/topics';
	import UnsubVideo from './UnsubVideo.svelte';

	// #414: a topic shows its public label + blurb only — never the list's name / description.
	type Topic = { id: number; label: string; blurb: string | null; subscribed: boolean };

	let {
		cfg,
		logoSrc,
		appName,
		state,
		email = '',
		token = '',
		topics = [],
		footerTopic = null,
		listOrigin = null,
		subscribed = true,
		canResubscribe = true,
		error = null,
		prefsKept = null,
		stillUnsubscribed = false,
		preview = false
	}: {
		cfg: UnsubPageConfig;
		logoSrc: string;
		appName: string;
		state: UnsubState;
		email?: string;
		token?: string;
		topics?: Topic[];
		/** The email's topic label (never a list / segment / tag name). */
		footerTopic?: string | null;
		/** The audience's consent note ("how you got on this list"). */
		listOrigin?: string | null;
		/** The contact is currently subscribed (false → "Resubscribe me" when allowed). */
		subscribed?: boolean;
		/** #750: this link may resubscribe (false for an old or expired link: no Resubscribe offered). */
		canResubscribe?: boolean;
		error?: string | null;
		prefsKept?: number | null;
		stillUnsubscribed?: boolean;
		/** Admin preview: forms don't submit. */
		preview?: boolean;
	} = $props();

	const reasons = UNSUBSCRIBE_REASONS;

	const md = (text: string) => renderAssistantMarkdown(text);
	const layout = $derived(topicLayout(topics.length));

	const shown = $derived(videoForState(cfg, state));
	const video = $derived(shown.video);
	const caption = $derived(shown.caption);
	const beside = $derived(!!video && cfg.placement === 'beside');
	const accentVars = $derived(
		cfg.accent
			? `--btn-primary-bg:${cfg.accent};--btn-primary-hover:color-mix(in srgb, ${cfg.accent} 88%, #000);` +
					`--btn-primary-active:color-mix(in srgb, ${cfg.accent} 78%, #000);--btn-primary-text:${autoTextColor(cfg.accent)};` +
					`--unsub-accent:${cfg.accent}`
			: ''
	);

	// The real page enhances its forms; the preview's forms never submit.
	function submit(node: HTMLFormElement, fn?: SubmitFunction) {
		if (!preview) return enhance(node, fn);
		const stop = (e: Event) => e.preventDefault();
		node.addEventListener('submit', stop);
		return { destroy: () => node.removeEventListener('submit', stop) };
	}
</script>

<div class="wrap" style={accentVars}>
	<div class="page" class:beside>
		<div class="main">
			<img class="logo" src={logoSrc} alt={appName} height="40" />

			{#if state === 'invalid'}
				<h1>Invalid link</h1>
				<p class="muted">This unsubscribe link is invalid or has expired.</p>
			{:else if state === 'prefsSaved'}
				<h1>Preferences saved</h1>
				<p class="muted">
					Your email preferences for {email} are updated{#if prefsKept === 0} — you're opted out of all topics{/if}. Thanks!
				</p>
				{#if stillUnsubscribed}
					{#if canResubscribe}
						<p class="muted">You're still unsubscribed from all emails, so nothing will be sent until you resubscribe.</p>
					{:else}
						<p class="muted">You're still unsubscribed from all emails, so nothing will be sent. To resubscribe, use the link in a newer email from us.</p>
					{/if}
				{/if}
			{:else if state === 'resubscribed'}
				<h1>You're subscribed again</h1>
				<p class="muted"><strong>{email}</strong> will get our emails again. Thanks for coming back.</p>
			{:else if state === 'after'}
				<h1>{cfg.afterHeading}</h1>
				<p class="muted">{email} will no longer receive these emails. Thanks for the feedback.</p>
				{#if cfg.afterMessage}<div class="md">{@html md(cfg.afterMessage)}</div>{/if}
				{#if cfg.resubscribe && canResubscribe}
					<form method="POST" action="?/resubscribe" use:submit class="resub">
						<input type="hidden" name="token" value={token} />
						<p class="muted">Changed your mind?</p>
						{#if error}<p class="err" role="alert">{error}</p>{/if}
						<button type="submit" class="secondary">Resubscribe</button>
					</form>
				{/if}
				{#if cfg.links.length}
					<ul class="links">
						{#each cfg.links as l (l.url + l.label)}
							<li><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></li>
						{/each}
					</ul>
				{/if}
			{:else}
				<h1>{cfg.heading}</h1>
				<p class="muted">Manage what <strong>{email}</strong> receives.</p>

				<form method="POST" action="?/unsubscribeAll" use:submit class="all">
					<input type="hidden" name="token" value={token} />
					<details>
						<summary>Tell us why <span class="muted">(optional)</span></summary>
						<label>
							Reason
							<select name="reason">
								<option value="">Prefer not to say</option>
								{#each reasons as r (r)}<option value={r}>{r}</option>{/each}
							</select>
						</label>
						<label class="sr-label" for="unsub-detail">Anything else?</label>
						<textarea id="unsub-detail" name="detail" rows="3" placeholder="Optional comment…"></textarea>
					</details>
					{#if error}<p class="err" role="alert">{error}</p>{/if}
					<button type="submit" data-unsub-button>Unsubscribe from everything</button>
				</form>

				<!-- #414: 0 topics → no topics block; 1 → one "Keep receiving" button; 2+ → checkboxes. -->
				{#if layout === 'one'}
					<form method="POST" action="?/preferences" use:submit class="prefs keep-one" data-topic-layout="one">
						<input type="hidden" name="token" value={token} />
						<input type="hidden" name="topic" value={topics[0].id} />
						<p class="prefs-lead">
							Or stay on <strong>{topics[0].label}</strong>{#if topics[0].blurb}<span class="muted t-desc"> — {topics[0].blurb}</span>{/if}
						</p>
						{#if cfg.resubscribe && canResubscribe && !subscribed}
							<label class="topic"><input type="checkbox" name="resubscribe" value="1" /> <span>Resubscribe me</span></label>
						{/if}
						<button type="submit" class="secondary">Keep receiving {topics[0].label}</button>
					</form>
				{:else if layout === 'many'}
					<form method="POST" action="?/preferences" use:submit class="prefs" data-topic-layout="many">
						<input type="hidden" name="token" value={token} />
						<p class="prefs-lead">Or keep just the topics you want:</p>
						{#each topics as t (t.id)}
							<label class="topic">
								<input type="checkbox" name="topic" value={t.id} checked={t.subscribed} />
								<span><strong>{t.label}</strong>{#if t.blurb}<span class="muted t-desc"> — {t.blurb}</span>{/if}</span>
							</label>
						{/each}
						{#if cfg.resubscribe && canResubscribe && !subscribed}
							<label class="topic"><input type="checkbox" name="resubscribe" value="1" /> <span>Resubscribe me</span></label>
						{/if}
						<p class="muted prefs-note">Untick everything to unsubscribe from all emails.</p>
						<button type="submit" class="secondary">Save preferences</button>
					</form>
				{/if}

				{#if footerTopic || listOrigin}
					<p class="muted provenance">
						{#if footerTopic}This email is part of <strong>{footerTopic}</strong>.{/if}
						{#if listOrigin}You're receiving it because: {listOrigin}{/if}
					</p>
				{/if}

				{#if cfg.intro}<div class="md">{@html md(cfg.intro)}</div>{/if}
			{/if}
		</div>

		{#if video}
			<div class="media">
				<UnsubVideo {video} {caption} />
			</div>
		{/if}
	</div>
</div>

<style>
	.wrap {
		min-height: 100dvh;
		display: grid;
		justify-items: center;
		align-content: start;
		padding: var(--space-xl) 16px;
		overflow-x: hidden;
	}
	.page {
		width: 100%;
		max-width: 420px;
		display: flex;
		flex-direction: column;
		gap: var(--space-l);
		overflow-wrap: anywhere;
	}
	.main { min-width: 0; }
	.media { min-width: 0; width: 100%; }
	/* Beside: controls left, video right on wide screens; stacked (controls first) otherwise. */
	@media (min-width: 900px) {
		.page.beside {
			max-width: 1040px;
			display: grid;
			grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
			gap: var(--space-xl);
			align-items: start;
		}
		.page.beside .media { margin-top: calc(40px + var(--space-m)); }
	}
	@media (min-width: 640px) {
		.page:not(.beside) { max-width: 560px; }
	}
	.logo { display: block; height: 40px; width: auto; max-width: 200px; margin: 0 0 var(--space-m); }
	h1 {
		margin: 0 0 var(--space-xs);
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		margin-top: var(--space-m);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	details { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	summary { cursor: pointer; }
	details textarea { margin-top: var(--space-xs); width: 100%; }
	.sr-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	button { align-self: flex-start; }
	.prefs { margin-top: var(--space-l); padding-top: var(--space-m); box-shadow: inset 0 var(--border-s) 0 var(--border); }
	.prefs-lead { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0; }
	.prefs-note { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: 0; }
	details label { margin-top: var(--space-xs); }
	.topic { flex-direction: row; align-items: flex-start; gap: var(--space-xs); }
	.topic input { margin-top: var(--space-xxs); }
	.t-desc { font-weight: var(--weight-ui-regular); }
	.provenance {
		margin-top: var(--space-l);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		padding: var(--space-xs) var(--space-s);
		background: color-mix(in srgb, var(--unsub-accent, var(--accent, #2563eb)) 7%, transparent);
		border-radius: var(--radius-s);
	}
	.md { margin-top: var(--space-l); overflow-wrap: anywhere; }
	.md :global(p) { margin: 0 0 var(--space-s); }
	.md :global(a), .links a { text-decoration-color: var(--unsub-accent, var(--accent)); }
	.md :global(img) { max-width: 100%; }
	.md :global(pre) { overflow-x: auto; }
	.resub { margin-top: var(--space-l); }
	.resub p { margin: 0; }
	.links { list-style: none; padding: 0; margin: var(--space-l) 0 0; display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-m); }
	.err { color: var(--danger); margin: 0; }
</style>

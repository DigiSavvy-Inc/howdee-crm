<script lang="ts">
	// The double opt-in confirm page (#510), shared by /confirm/[token] and the admin preview
	// (/confirm/preview). Same structure as the unsubscribe page (UnsubscribeView): logo →
	// heading → the address → the one action. The GET never confirms — only the button does.
	import { enhance } from '$app/forms';
	import { renderAssistantMarkdown } from '$lib/assistant-markdown';
	import { autoTextColor } from '$lib/brand';
	import type { ConfirmState, DoiConfig } from '$lib/double-optin';

	let {
		cfg,
		logoSrc,
		appName,
		state: view,
		email = '',
		error = null,
		canResend = false,
		accent = null,
		preview = false
	}: {
		cfg: DoiConfig;
		logoSrc: string;
		appName: string;
		state: ConfirmState;
		email?: string;
		error?: string | null;
		canResend?: boolean;
		/** The unsubscribe page's accent colour, so both public pages match. */
		accent?: string | null;
		/** Admin preview: forms don't submit. */
		preview?: boolean;
	} = $props();

	const md = (text: string) => renderAssistantMarkdown(text);
	const accentVars = $derived(
		accent
			? `--btn-primary-bg:${accent};--btn-primary-hover:color-mix(in srgb, ${accent} 88%, #000);` +
					`--btn-primary-active:color-mix(in srgb, ${accent} 78%, #000);--btn-primary-text:${autoTextColor(accent)};` +
					`--unsub-accent:${accent}`
			: ''
	);

	let busy = $state(false);
	function submit(node: HTMLFormElement) {
		if (!preview)
			return enhance(node, () => {
				busy = true;
				return async ({ update }) => {
					await update();
					busy = false;
				};
			});
		const stop = (e: Event) => e.preventDefault();
		node.addEventListener('submit', stop);
		return { destroy: () => node.removeEventListener('submit', stop) };
	}
</script>

<div class="wrap" style={accentVars}>
	<div class="page">
		<img class="logo" src={logoSrc} alt={appName} height="40" />

		{#if view === 'invalid'}
			<h1>Invalid link</h1>
			<p class="muted">This confirmation link is invalid or was replaced by a newer one. Check your inbox for the latest email.</p>
		{:else if view === 'confirmed'}
			<h1>You're in.</h1>
			<p class="muted"><strong>{email}</strong> is confirmed. Thanks!</p>
			{#if cfg.afterMessage}<div class="md">{@html md(cfg.afterMessage)}</div>{/if}
			{#if cfg.redirectUrl}
				<p class="next"><a href={cfg.redirectUrl} rel="noopener noreferrer">Continue</a></p>
			{/if}
		{:else if view === 'already'}
			<h1>Already confirmed</h1>
			<p class="muted">{#if email}<strong>{email}</strong>{:else}This address{/if} is already confirmed. Nothing else to do.</p>
			{#if cfg.redirectUrl}
				<p class="next"><a href={cfg.redirectUrl} rel="noopener noreferrer">Continue</a></p>
			{/if}
		{:else if view === 'resent'}
			<h1>Check your inbox</h1>
			<p class="muted">We sent a new confirmation link. It replaces the old one.</p>
		{:else if view === 'refused'}
			<h1>We couldn't confirm this address</h1>
			<p class="err" role="alert">{error}</p>
		{:else if view === 'expired'}
			<h1>This link has expired</h1>
			<p class="muted">{#if email}The confirmation link for <strong>{email}</strong>{:else}This confirmation link{/if} is no longer valid.</p>
			{#if error}<p class="err" role="alert">{error}</p>{/if}
			{#if canResend}
				<form method="POST" action="?/resend" use:submit>
					<button type="submit" class="secondary" disabled={busy}>Send a new link</button>
				</form>
			{/if}
		{:else}
			<h1>Confirm your subscription</h1>
			<p class="muted">Press the button to confirm that <strong>{email}</strong> wants our emails.</p>
			{#if error}<p class="err" role="alert">{error}</p>{/if}
			<form method="POST" action="?/confirm" use:submit>
				<button type="submit" disabled={busy}>{cfg.button}</button>
			</form>
			<p class="muted small">Didn't sign up? Close this page and you won't hear from us.</p>
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
		overflow-wrap: anywhere;
	}
	@media (min-width: 640px) {
		.page { max-width: 560px; }
	}
	.logo { display: block; height: 40px; width: auto; max-width: 200px; margin: 0 0 var(--space-m); }
	h1 {
		margin: 0 0 var(--space-xs);
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
	}
	form { display: flex; flex-direction: column; gap: var(--space-s); margin-top: var(--space-m); }
	button { align-self: flex-start; }
	.small { margin-top: var(--space-l); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.md { margin-top: var(--space-l); overflow-wrap: anywhere; }
	.md :global(p) { margin: 0 0 var(--space-s); }
	.md :global(a), .next a { text-decoration-color: var(--unsub-accent, var(--accent)); }
	.next { margin-top: var(--space-m); }
	.err { color: var(--danger); margin: var(--space-s) 0 0; }
</style>

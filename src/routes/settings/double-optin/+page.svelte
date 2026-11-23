<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		AFTER_MAX,
		BODY_MAX,
		BUTTON_MAX,
		CONFIRM_URL_TAG,
		DEFAULT_BUTTON,
		DEFAULT_SUBJECT,
		EXPIRY_HOURS,
		RESEND_GAP_MINUTES,
		RESEND_MAX,
		SUBJECT_MAX
	} from '$lib/double-optin';
	let { data, form } = $props();

	const c = $derived(data.config);
	let busy = $state(false);
</script>

<svelte:head><title>Double opt-in</title></svelte:head>

<h1>Double opt-in</h1>
<p class="muted intro">
	Optional. When a sign-up asks for confirmation, the person gets one email with a confirm link and only counts as
	subscribed — and joins the lists and tags the sign-up asked for, and enters automations — after pressing the button on
	that page. Turn it on per form, per webhook key (<a href="/settings/webhooks">Settings → Webhooks</a>, “Require
	confirmation”) or per request (<code>confirm: true</code> on the ingest / upsert API).
	<a href="/confirm/preview" target="_blank" rel="noopener">Open preview</a>
</p>
<p class="muted intro">
	{data.pending.toLocaleString('en-US')} contact{data.pending === 1 ? '' : 's'} waiting to confirm ·
	{data.keysRequiring} webhook key{data.keysRequiring === 1 ? '' : 's'} require{data.keysRequiring === 1 ? 's' : ''} confirmation.
	{#if data.pending}<a href="/contacts?status=pending">Show them</a>{/if}
</p>

<form
	method="POST"
	action="?/save"
	use:enhance={() => {
		busy = true;
		return async ({ update }) => {
			await update({ reset: false });
			busy = false;
		};
	}}
>
	<section class="card">
		<h2>Confirmation email</h2>
		<label class="field grow"><span>Subject</span>
			<input name="subject" value={c.subject} maxlength={SUBJECT_MAX} placeholder={DEFAULT_SUBJECT} />
		</label>
		<label class="field"><span>Body <span class="muted">(Markdown; must contain <code>{CONFIRM_URL_TAG}</code>; <code>{'{{first_name}}'}</code> allowed)</span></span>
			<textarea name="body" rows="9" maxlength={BODY_MAX} required>{c.body}</textarea>
		</label>
		<p class="muted small">Sent from Settings → Default From on the transactional stream, without tracking or an unsubscribe footer. The button below is added under the body.</p>
	</section>

	<section class="card">
		<h2>Confirm page</h2>
		<label class="field grow"><span>Button label</span>
			<input name="button" value={c.button} maxlength={BUTTON_MAX} placeholder={DEFAULT_BUTTON} />
		</label>
		<label class="field"><span>After confirming <span class="muted">(Markdown, shown under “You’re in.”)</span></span>
			<textarea name="afterMessage" rows="3" maxlength={AFTER_MAX}>{c.afterMessage}</textarea>
		</label>
		<label class="field grow"><span>Next link <span class="muted">(optional, e.g. your website)</span></span>
			<input name="redirectUrl" type="url" value={c.redirectUrl} placeholder="https://" />
		</label>
		<fieldset>
			<legend>Link expires after</legend>
			<div class="radios">
				{#each EXPIRY_HOURS as h (h)}
					<label class="check"><input type="radio" name="expiryHours" value={h} checked={c.expiryHours === h} /> {h} hours</label>
				{/each}
			</div>
		</fieldset>
		<p class="muted small">An expired link offers “Send a new link”. A confirmation can be re-sent up to {RESEND_MAX} times, {RESEND_GAP_MINUTES} minutes apart.</p>
	</section>

	{#if form && 'error' in form && form.error}<p class="notice err" role="alert">{form.error}</p>{/if}
	{#if form && 'saved' in form && form.saved}<p class="notice ok" role="status">Saved.</p>{/if}
	<button type="submit" disabled={busy}>Save</button>
</form>

<form method="POST" action="?/test" use:enhance class="test">
	<button type="submit" class="secondary">Send me a test</button>
	<span class="muted small">Sends the saved email to your user record's address, with a link to the preview.</span>
	{#if form && 'testError' in form && form.testError}<p class="notice err" role="alert">{form.testError}</p>{/if}
	{#if form && 'testSent' in form && form.testSent}<p class="notice ok" role="status">Test sent to {form.testSent}.</p>{/if}
</form>

<style>
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	h2 { margin: 0 0 var(--space-s); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 70ch; }
	section.card { margin-bottom: var(--space-m); display: flex; flex-direction: column; gap: var(--space-s); }
	section.card p { max-width: 70ch; margin: 0; }
	fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
	legend { padding: 0; margin-bottom: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); }
	.radios { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-m); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); max-width: 48rem; }
	.field textarea { width: 100%; }
	.grow { flex: 1; min-width: 14rem; max-width: 36rem; }
	.check { display: flex; gap: var(--space-xs); align-items: flex-start; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.test { margin-top: var(--space-l); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-s); }
	.test .notice { flex-basis: 100%; margin: 0; }
</style>

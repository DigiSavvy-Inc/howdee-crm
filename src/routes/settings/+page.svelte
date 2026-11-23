<script lang="ts">
	import { enhance } from '$app/forms';
	import logomark from '$lib/assets/logomark.svg';
	import { APP_NAME_MAX, SHORT_NAME_MAX, DEFAULT_APP_NAME, DEFAULT_SHORT_NAME } from '$lib/branding';
	import { convertFileInput } from '$lib/image-convert';
	let { data, form } = $props();
	let logoConvertError = $state('');
</script>

<svelte:head><title>Settings</title></svelte:head>

<div class="head"><h1>Settings</h1></div>

{#if data.isAdmin}
	<!-- Branding (#188): header, browser tab icon, sign-in page and the installed app. -->
	<section class="card branding">
		<h2>Branding</h2>
		<p class="muted">
			The name and logo in the header, the browser tab, the sign-in page and the installed
			app. Blank = the default.
		</p>
		<form
			method="POST"
			action="?/saveBranding"
			enctype="multipart/form-data"
			use:enhance={() => async ({ update }) => update({ reset: false })}
		>
			<label>
				App name <span class="muted">(up to {APP_NAME_MAX} characters)</span>
				<input
					name="app_name"
					maxlength={APP_NAME_MAX}
					value={data.branding.appName === DEFAULT_APP_NAME ? '' : data.branding.appName}
					placeholder={DEFAULT_APP_NAME}
					autocomplete="off"
				/>
			</label>
			<label>
				Short name <span class="muted">(up to {SHORT_NAME_MAX}; narrow header and the installed app)</span>
				<input
					name="app_short_name"
					maxlength={SHORT_NAME_MAX}
					value={data.branding.shortName === DEFAULT_SHORT_NAME ? '' : data.branding.shortName}
					placeholder={DEFAULT_SHORT_NAME}
					autocomplete="off"
				/>
			</label>
			<div class="logo-row">
				<img class="logo-preview" src={data.branding.logoUrl ?? logomark} alt="Current logo" width="48" height="48" />
				<label>
					Logo <span class="muted">(PNG, SVG, WebP or AVIF — AVIF is converted to WebP — up to 512 KB; {data.branding.logoUrl ? 'uploaded' : 'bundled logo in use'})</span>
					<input
						type="file"
						name="logo"
						accept="image/png,image/svg+xml,image/webp,image/avif"
						onchange={async (e) => (logoConvertError = await convertFileInput(e.currentTarget, { jpegFallback: false }))}
					/>
				</label>
			</div>
			{#if logoConvertError}<p class="err">{logoConvertError}</p>{/if}
			{#if form?.brandingError}<p class="err">{form.brandingError}</p>{/if}
			{#if form?.brandingSaved}<p class="ok">Saved.</p>{/if}
			<div class="btnrow">
				<button type="submit">Save branding</button>
				{#if data.branding.logoUrl}
					<button type="submit" class="secondary" formaction="?/removeLogo" formnovalidate>Remove logo</button>
				{/if}
			</div>
		</form>
	</section>

<form method="POST" action="?/save" use:enhance={() => async ({ update }) => update({ reset: false })} class="settings">
	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.saved}<p class="ok">Saved.</p>{/if}

	<section class="card">
		<h2>Reply forwarding</h2>
		<p class="muted">
			Captured replies (Postmark Inbound) are forwarded to these inboxes — each forward has
			Reply-To set to the original sender, so you can answer directly.
			{#if data.envForwardTo}Leave empty to use the deployed default: <code>{data.envForwardTo}</code>.{/if}
			{#if data.forwardFrom}Forwards come from <code>"Contact name via {data.branding.appName}" &lt;{data.forwardFrom}&gt;</code>
				(<code>INBOUND_FORWARD_FROM</code>, else <code>REVIEW_FROM</code>, else <code>POSTMARK_FROM</code>; it must be on the
				<code>POSTMARK_FROM</code> domain and an approved Postmark sender, or the forward falls back to <code>POSTMARK_FROM</code>).{/if}
		</p>
		{#if !data.replyCapture}
			<p class="notice" role="status">
				Reply capture isn't set up, so there is nothing to forward. Set the <code>POSTMARK_INBOUND_ADDRESS</code> var and
				the <code>INBOUND_KEY</code> secret, then point Postmark's inbound webhook at
				<code>/api/inbound?key=&lt;INBOUND_KEY&gt;</code>.
			</p>
		{/if}
		<label>
			Forward replies to <span class="muted">(comma-separated, up to 10)</span>
			<input
				name="inbound_forward_to"
				value={data.settings.inbound_forward_to ?? ''}
				placeholder={data.envForwardTo || 'you@example.com'}
				autocomplete="off"
			/>
		</label>
		<label class="check">
			<input type="checkbox" name="reply_bcc_operator" value="1" checked={!!data.settings.reply_bcc_operator} />
			BCC me on replies sent from a conversation
			<span class="muted">(to the Default From address, so the thread stays complete in your mailbox)</span>
		</label>
	</section>

	<section class="card">
		<h2>Resend subjects</h2>
		<label class="check">
			<input
				type="checkbox"
				name="ai_resend_subject"
				value="1"
				checked={data.settings.ai_resend_subject === 'on'}
				disabled={!data.aiKeyConfigured}
			/>
			Let Claude suggest resend subjects
			<span class="muted">(adds a “Suggest with Claude” button to resend subjects — you review it before it's saved)</span>
		</label>
		{#if !data.aiKeyConfigured}
			<p class="muted">Needs an Anthropic API key: paste one in <a href="/settings/assistant">Settings → Assistant</a> or set the <code>ANTHROPIC_API_KEY</code> Worker secret.</p>
		{/if}
	</section>

	<section class="card">
		<h2>Approved senders (From addresses)</h2>
		<p class="muted">
			Postmark only delivers mail <strong>from</strong> verified senders — a verified
			<strong>domain</strong> (any address on it works) or an individual sender signature.
			List what's approved in your Postmark account; the app then blocks sends with an
			unapproved From <em>before</em> they bounce. Empty = no enforcement.
		</p>
		<label>
			Approved domains and/or addresses <span class="muted">(comma-separated)</span>
			<input
				name="approved_senders"
				value={data.settings.approved_senders ?? ''}
				placeholder="example.com, someone@example.org"
				autocomplete="off"
			/>
		</label>
		<label>
			Default From <span class="muted">(prefills compose + automation steps; empty = {data.envFrom || 'deployed default'})</span>
			<input
				name="default_from"
				type="email"
				value={data.settings.default_from ?? ''}
				placeholder={data.envFrom}
				autocomplete="off"
			/>
		</label>
		<label>
			Mailing address <span class="muted">(CAN-SPAM: put it in your email footer; the pre-send checks look for it)</span>
			<textarea name="mailing_address" rows="2" maxlength="300" placeholder="123 Main St, Suite 4, Pasadena, CA 91101" value={data.settings.mailing_address ?? ''}></textarea>
		</label>
	</section>

	<section class="card">
		<h2>Timezone</h2>
		<p class="muted">
			Used for "weekdays only" scheduling (automation waits and scheduled campaigns that
			avoid landing on a weekend) and for interpreting times you pick in the Schedule
			pickers. Storage stays UTC.
		</p>
		<label>
			Operator timezone
			{#if data.timezoneOptions.length}
				<select name="timezone" value={data.settings.timezone || data.defaultTimezone}>
					{#each data.timezoneOptions as tz (tz)}
						<option value={tz}>{tz}</option>
					{/each}
				</select>
			{:else}
				<input
					name="timezone"
					value={data.settings.timezone || data.defaultTimezone}
					placeholder={data.defaultTimezone}
					autocomplete="off"
				/>
			{/if}
		</label>
	</section>

	<section class="card">
		<h2>Luma integration</h2>
		<p class="muted">
			Sync event registrants from <strong>Luma</strong>: each guest is added to the newsletter
			list below and tagged with their status (<code>Luma: Going/Pending/Not Going</code>) and
			their registration answers (interests). In Luma (Plus) → event → <em>Webhooks</em>, point
			a guest webhook at this URL and paste its signing secret here.
		</p>
		{#if !data.settings.luma_webhook_secret && !data.lumaSecretFromEnv}
			<p class="notice" role="status">Not set up: until a signing secret is saved, the webhook URL refuses every delivery.</p>
		{/if}
		<label>
			Webhook URL <span class="muted">(set this in Luma)</span>
			<input value={data.lumaWebhookUrl} readonly onclick={(e) => e.currentTarget.select()} />
		</label>
		<label>
			Signing secret <span class="muted">(<code>whsec_…</code>; {data.settings.luma_webhook_secret ? 'set — leave blank to keep' : data.lumaSecretFromEnv ? 'using env LUMA_WEBHOOK_SECRET — leave blank to keep' : 'not set'})</span>
			<input
				name="luma_webhook_secret"
				type="password"
				placeholder={data.settings.luma_webhook_secret || data.lumaSecretFromEnv ? '••••••••••••' : 'whsec_…'}
				autocomplete="off"
			/>
		</label>
		<label>
			Add registrants to list <span class="muted">(newsletter list name; created if missing)</span>
			<input
				name="luma_list"
				value={data.settings.luma_list ?? ''}
				placeholder={data.defaultListName || 'Newsletter'}
				autocomplete="off"
			/>
		</label>
	</section>

	<button type="submit">Save settings</button>
</form>
{:else}
	<!-- #532: members only manage their own navigation layout here. -->
	<p class="muted">The other settings are managed by an admin.</p>
{/if}

<section class="card navlayout">
	<h2>Navigation layout</h2>
	<p class="muted">
		Where the main navigation sits — just for you. Also switchable from the
		Nav button next to the theme toggle.
	</p>
	<form
		method="POST"
		action="?/setNavLayout"
		use:enhance={() => async ({ update }) => update({ reset: false })}
	>
		<fieldset class="navchoices">
			<legend class="sr-only">Navigation layout</legend>
			<label class="choice">
				<input type="radio" name="nav_layout" value="top" checked={(data.me?.navLayout ?? 'top') === 'top'} />
				Top bar
			</label>
			<label class="choice">
				<input type="radio" name="nav_layout" value="left" checked={data.me?.navLayout === 'left'} />
				Left sidebar
			</label>
		</fieldset>
		{#if form?.navError}<p class="err">{form.navError}</p>{/if}
		{#if form?.navLayout}<p class="ok">Saved.</p>{/if}
		<button type="submit" class="secondary">Save layout</button>
	</form>
</section>

{#if data.isAdmin}
<section class="card engagement" id="engagement">
	<h2>Engagement</h2>
	<p class="muted">
		A per-contact engagement profile (open/click/reply history, score, tier) computed from
		existing tracking data. Profiles refresh daily on the heartbeat and within a minute after
		new opens/clicks.
	</p>
	<p class="engagement-line">
		Last full recompute:
		<strong>{data.engagement.computedAt ? new Date(data.engagement.computedAt).toLocaleString() : 'never yet'}</strong>
		· {data.engagement.dirty} contact{data.engagement.dirty === 1 ? '' : 's'} pending
		· tiers:
		{#each Object.entries(data.engagement.tiers) as [tier, n], i}{i > 0 ? ' / ' : ' '}{tier} {n}{/each}
	</p>
	<form
		class="weights"
		method="POST"
		action="?/saveEngagementConfig"
		use:enhance={() => async ({ update }) => update({ reset: false })}
	>
		<p class="muted">
			Score = Σ weight × ½^(age ÷ half-life), squashed to 0–100; tiers are score thresholds.
			Blank = default. Saving re-scores every contact over the next few minutes.
			{#if data.engagementCustom}<strong>Custom values in use.</strong>{/if}
		</p>
		<p class="muted">
			Scanner bursts: that many different links clicked by one recipient within the window (or the
			unsubscribe link plus another link) count as security-scanner fetches, not clicks. Applies to new clicks.
		</p>
		<div class="weight-grid">
			{#each data.engagementFields as f (f.key)}
				<label>
					{f.label}
					<input
						type="number"
						name={f.key}
						min={f.min}
						max={f.max}
						step="any"
						value={data.engagementConfig[f.key]}
						placeholder={String(data.engagementDefaults[f.key])}
					/>
					<span class="muted hint">default {data.engagementDefaults[f.key]}</span>
				</label>
			{/each}
		</div>
		{#if form?.engagementConfigError}<p class="err">{form.engagementConfigError}</p>{/if}
		{#if form?.engagementConfigSaved}<p class="ok">Saved — contacts are being re-scored.</p>{/if}
		<div class="btnrow">
			<button type="submit">Save scoring</button>
			<button type="submit" class="secondary" formaction="?/resetEngagementConfig" formnovalidate>Reset to defaults</button>
		</div>
	</form>
	{#if form?.engagementOk !== undefined}<p class="ok">Recomputed {form.engagementOk} contact{form.engagementOk === 1 ? '' : 's'}.</p>{/if}
	<form
		method="POST"
		action="?/recomputeEngagement"
		use:enhance={() => async ({ update }) => update({ reset: false })}
	>
		<button type="submit" class="secondary">Recompute now</button>
	</form>
</section>

<section class="card linkcard">
	<h2>Data API</h2>
	<p class="muted">
		Issue bearer keys so your other apps can read and write this app's data over the
		<code>/api/v1</code> Data API. Create, scope, rotate, and revoke keys on their own page.
	</p>
	<a class="btnlink" href="/settings/api">Manage API keys →</a>
</section>
{/if}

<style>
	.head { display: flex; align-items: center; gap: var(--space-s); }
	h1 { margin: 0 0 var(--space-s); font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.settings { display: flex; flex-direction: column; gap: var(--space-m); margin: 0; max-width: 720px; }
	.settings > button { align-self: flex-start; }
	h2 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.card p { margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.card code { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: var(--surface); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); overflow-wrap: anywhere; }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-bottom: var(--space-s); }
	label:last-child { margin-bottom: 0; }
	label.check { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: var(--space-xxs) var(--space-xs); }
	.err { color: var(--danger); margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.ok { margin: 0; }
	.linkcard { max-width: 720px; margin-top: var(--space-m); }
	.engagement { max-width: 720px; margin-top: var(--space-m); }
	.navlayout { max-width: 720px; margin-top: var(--space-m); }
	.branding { max-width: 720px; margin-bottom: var(--space-m); }
	.branding form { margin: 0; }
	.logo-row { display: flex; align-items: center; gap: var(--space-s); margin-bottom: var(--space-s); }
	.logo-row label { flex: 1 1 auto; margin: 0; }
	.logo-preview { flex: 0 0 auto; border-radius: 50%; object-fit: contain; background: var(--surface); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); }
	.navchoices { display: flex; gap: var(--space-l); border: 0; padding: 0; margin: 0 0 var(--space-s); }
	.choice { flex-direction: row; align-items: center; gap: var(--space-xs); margin: 0; }
	.choice input { width: auto; margin: 0; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.engagement-line { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); overflow-wrap: anywhere; }
	.weights { margin: 0 0 var(--space-s); }
	.weight-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: var(--space-xxs) var(--space-s); margin-bottom: var(--space-s); }
	.weight-grid label { margin-bottom: var(--space-xxs); }
	.hint { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.btnrow { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
	label input, label select { min-width: 0; max-width: 100%; }
	.btnlink { display: inline-block; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); text-decoration: none; }
</style>

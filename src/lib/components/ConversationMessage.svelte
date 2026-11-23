<script lang="ts">
	// One message in a conversation timeline (#226), as a GitHub comment box: header strip
	// (avatar, author, relative + absolute time, kind badge, open/click badges for our
	// sends), body below. Our sends render through the per-recipient renderer (#127,
	// /campaign/[id]/render) in a content-fit frame; synced Gmail bodies load from
	// /api/mail/messages/[id]/body (#158); replies show their stored text. Bodies load when
	// the box mounts, so a collapsed thread fetches nothing. #380: a reply whose text was
	// converted from HTML gets "View original" — fetched only when opened, rendered in a
	// sandbox="" iframe (no scripts, no same-origin, no forms) with remote images off until
	// "Load images".
	import { onMount } from 'svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { Conversation, ConvMessage } from '$lib/server/conversations';
	import { viewEmailHref } from '$lib/view-email-href';
	import { withBaseTargetBlank } from '$lib/email-preview-html';
	import { gmailThreadUrl } from '$lib/gmail-link';
	import { relTime } from '$lib/reltime';
	import { messageAuthor, messageKindLabel, messageVerb } from '$lib/conversation-view';
	import { displayText, originalSrcdoc } from '$lib/email-text';

	let { m, conv }: { m: ConvMessage; conv: Pick<Conversation, 'contact_id' | 'name' | 'email'> } = $props();

	const ours = $derived(m.dir === 'out');
	const author = $derived(messageAuthor(m, conv));

	// Size the frame to the email instead of a fixed box (a one-liner shouldn't get a page of
	// whitespace). allow-same-origin is safe here: the sandbox has no allow-scripts, so the
	// email can't run code — it only lets us read the document height.
	function fitFrame(e: Event) {
		const f = e.currentTarget as HTMLIFrameElement;
		const doc = f.contentDocument;
		const h = doc ? Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) : 0;
		if (h) f.style.height = `${Math.min(Math.max(h + 16, 96), 1200)}px`;
	}

	let rendered = $state<{ html?: string; error?: string } | null>(null);
	let gmail = $state<{ kind?: 'text' | 'html'; body?: string; error?: string } | null>(null);

	let original = $state<{ open: boolean; images: boolean; html?: string; error?: string } | null>(null);

	async function toggleOriginal() {
		if (original) {
			original.open = !original.open;
			return;
		}
		original = { open: true, images: false };
		try {
			const res = await fetch(`/api/replies/${m.reply_id}/original`);
			if (!res.ok) throw new Error('request failed');
			original.html = ((await res.json()) as { html: string }).html;
		} catch {
			original.error = "Couldn't load the original message.";
		}
	}

	onMount(async () => {
		if (m.source === 'gmail') {
			if (m.mail_message_id == null) return;
			gmail = {};
			try {
				const res = await fetch(`/api/mail/messages/${m.mail_message_id}/body`);
				if (!res.ok) throw new Error('request failed');
				const b = (await res.json()) as { kind: 'text' | 'html'; body: string };
				gmail = { kind: b.kind, body: b.kind === 'html' ? withBaseTargetBlank(b.body) : b.body };
			} catch {
				gmail = { error: "Couldn't load this message from Gmail." };
			}
		} else if (m.dir === 'out' && m.campaign_id != null && m.recipient_id != null) {
			rendered = {};
			try {
				const res = await fetch(`/campaign/${m.campaign_id}/render?as=${m.recipient_id}`);
				if (!res.ok) throw new Error('request failed');
				const body = (await res.json()) as { html: string };
				rendered = { html: withBaseTargetBlank(body.html) };
			} catch {
				rendered = { error: "Couldn't render this email." };
			}
		}
	});
</script>

<article class="msg" class:ours>
	<header class="msg-head">
		{#if !ours && conv.contact_id != null}
			<Avatar contactId={conv.contact_id} name={conv.name || conv.email} size={20} />
		{:else}
			<span class="dir-icon" aria-hidden="true"><Icon name={ours ? 'send' : 'reply'} size={16} /></span>
		{/if}
		<strong class="author">{author}</strong>
		<span class="muted verb">{messageVerb(m)}</span>
		<time class="muted when" datetime={m.at.replace(' ', 'T') + 'Z'} title="{m.at} UTC">{relTime(m.at)}</time>
		<span class="spacer"></span>
		<span class="badge draft">{messageKindLabel(m)}</span>
		{#if m.source !== 'gmail' && ours}
			{#if m.status === 'error'}<span class="badge failed">Send failed</span>{/if}
			{#if m.signals}
				{#if m.signals.opens > 0}
					<span class="badge sent" title="First opened {m.signals.first_open} UTC">Opened{#if m.signals.opens > 1} ×{m.signals.opens}{/if}</span>
				{/if}
				{#if m.signals.clicks > 0}
					<span class="badge sent" title="First clicked {m.signals.first_click} UTC">Clicked{#if m.signals.clicks > 1} ×{m.signals.clicks}{/if}</span>
				{/if}
				{#if m.signals.bounced}<span class="badge failed">Bounced</span>{/if}
				{#if m.signals.spam}<span class="badge failed">Spam</span>{/if}
				{#if m.signals.unsubscribed}<span class="badge failed">Unsubscribed</span>{/if}
			{/if}
		{/if}
	</header>

	<div class="msg-body">
		{#if m.subject}<p class="subject">{m.subject}</p>{/if}
		{#if m.source === 'gmail'}
			{#if gmail?.error}
				<p class="err">{gmail.error}</p>
				{#if m.snippet}<p class="text muted">{m.snippet}</p>{/if}
			{:else if gmail?.kind === 'html'}
				<iframe class="frame gmail" title="Gmail message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc={gmail.body}></iframe>
			{:else if gmail?.kind === 'text'}
				<p class="text">{displayText(gmail.body)}</p>
			{:else if m.snippet}
				<p class="text muted">{m.snippet}</p>
			{/if}
		{:else if ours}
			{#if m.status === 'error' && m.error}<p class="err">{m.error}</p>{/if}
			{#if rendered?.error}
				<p class="err">{rendered.error}</p>
			{:else if rendered?.html}
				<iframe
					class="frame"
					title="Sent email"
					sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
					srcdoc={rendered.html}
					onload={fitFrame}
				></iframe>
			{:else if rendered}
				<p class="muted small">Rendering…</p>
			{/if}
		{:else if m.text}
			<p class="text">{m.text}</p>
		{:else}
			<p class="text muted">(no text captured)</p>
		{/if}
		{#if !ours && m.source !== 'gmail' && m.has_original && m.reply_id != null}
			<div class="original">
				<button type="button" class="linkish" aria-expanded={!!original?.open} onclick={toggleOriginal}>
					{original?.open ? 'Hide original' : 'View original'}
				</button>
				{#if original?.open}
					{#if original.error}
						<p class="err">{original.error}</p>
					{:else if original.html == null}
						<p class="muted small">Loading…</p>
					{:else}
						{#if !original.images}
							<p class="muted small">
								Remote images are blocked.
								<button type="button" class="linkish" onclick={() => original && (original.images = true)}>Load images</button>
							</p>
						{/if}
						<iframe
							class="frame original-frame"
							title="Original message"
							sandbox=""
							srcdoc={originalSrcdoc(original.html, { loadImages: original.images })}
						></iframe>
					{/if}
				{/if}
			</div>
		{/if}
	</div>

	{#if (m.source === 'gmail' && m.gmail_thread_id) || (m.source !== 'gmail' && ours && m.campaign_id != null)}
		<footer class="msg-foot">
			{#if m.source === 'gmail' && m.gmail_thread_id}
				<a href={gmailThreadUrl(m.gmail_thread_id)} target="_blank" rel="noopener noreferrer">Open in Gmail <Icon name="external" size={16} /></a>
			{:else if m.campaign_id != null}
				<a href={viewEmailHref(m.campaign_id, { recipientId: m.recipient_id })}>View email</a>
			{/if}
		</footer>
	{/if}
</article>

<style>
	.msg {
		border: 0; border-radius: var(--radius-m); background: var(--surface); min-width: 0;
		box-shadow: var(--border-shadow-s), var(--shadow-s);
	}
	/* Our messages: edge + head tinted with colour-1 (transparent variant). */
	.msg.ours { box-shadow: 0 0 0 var(--border-s) var(--color-1-transparent), var(--shadow-s); }
	.msg-head {
		display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xxs) var(--space-xs);
		padding: var(--space-xs) var(--space-m);
		background: var(--surface-subtle); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
		border-radius: var(--radius-m) var(--radius-m) 0 0;
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
	}
	.msg.ours .msg-head {
		background: var(--option-badge-background);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--color-1-transparent);
	}
	.dir-icon { display: inline-flex; color: var(--muted); }
	.author { overflow-wrap: anywhere; }
	.when { white-space: nowrap; }
	.spacer { flex: 1; }
	.msg-body { padding: var(--space-xs) var(--space-m) var(--space-m); }
	.subject { margin: 0 0 var(--space-xs); font-weight: var(--weight-ui-heavy); overflow-wrap: anywhere; }
	.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--size-m); line-height: var(--line-m); }
	/* The frame renders the email itself (white email canvas), not app chrome. */
	.frame {
		display: block; width: 100%; height: 160px; border: 0; border-radius: var(--radius-s); background: #fff;
		box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
	}
	.frame.gmail { height: 360px; }
	/* No same-origin in this sandbox, so the frame can't be fitted to the email: fixed height, resizable. */
	.frame.original-frame { height: 480px; resize: vertical; overflow: auto; }
	.original { margin-top: var(--space-xs); display: flex; flex-direction: column; gap: var(--space-xs); }
	.linkish {
		align-self: flex-start; padding: 0; border: 0; background: none; color: var(--text); cursor: pointer;
		font: inherit; font-size: var(--size-s); line-height: var(--line-s);
		text-decoration: underline; text-decoration-color: var(--accent);
	}
	.err { color: var(--error); font-size: var(--size-s); line-height: var(--line-s); margin: 0 0 var(--space-xs); overflow-wrap: anywhere; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); margin: 0; }
	.msg-foot {
		display: flex; justify-content: flex-end; gap: var(--space-m); padding: 0 var(--space-m) var(--space-xs);
		font-size: var(--size-s); line-height: var(--line-s);
	}
	.msg-foot a { display: inline-flex; align-items: center; gap: var(--space-xxs); }
</style>

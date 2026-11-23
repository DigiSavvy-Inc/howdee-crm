<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import ConversationTimeline from '$lib/components/ConversationTimeline.svelte';
	import ReplyComposer from '$lib/components/ReplyComposer.svelte';
	// One conversation (#157) as a collapsible row on the contact page. #226: a button with
	// aria-expanded drives it instead of <details> (whose summary scrolled out of reach and
	// had no visible marker, so an open thread looked impossible to close) — the chevron
	// rotates, a Collapse button closes it from the bottom of a long thread, and Esc anywhere
	// inside collapses it and returns focus to the header. Messages mount (and load their
	// bodies) only while open. "Open" goes to the full thread page.
	import type { Conversation } from '$lib/server/conversations';
	import { gmailThreadUrl } from '$lib/gmail-link';
	import { relTime } from '$lib/reltime';
	import { KIND_LABEL, convState, STATE_LABEL, threadHref, nextOpen } from '$lib/conversation-view';

	let { conv }: { conv: Conversation } = $props();

	let open = $state(false);
	let toggleBtn = $state<HTMLButtonElement>();
	const cstate = $derived(convState(conv));
	const hasGmail = $derived(conv.messages.some((m) => m.source === 'gmail'));
	// A Gmail-only thread can be answered from here only when a Message-ID is known to thread on.
	const canReply = $derived(conv.root_kind !== 'gmail' || conv.messages.some((m) => m.message_id));

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !open) return;
		e.stopPropagation();
		open = nextOpen(open, 'escape');
		toggleBtn?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="conv" class:open id="conv-{conv.key}" onkeydown={onKeydown}>
	<div class="row">
		<button
			type="button"
			class="toggle"
			aria-expanded={open}
			aria-controls="conv-body-{conv.key}"
			bind:this={toggleBtn}
			onclick={() => (open = nextOpen(open, 'toggle'))}
		>
			<span class="chev" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
			<span class="dir" title={conv.last_dir === 'in' ? 'Last message is theirs' : 'Last message is yours'}>
				<Icon name={conv.last_dir === 'in' ? 'reply' : 'send'} size={16} />
			</span>
			<span class="subject" class:bold={conv.awaiting}>{conv.subject}</span>
			<span class="labels">
				<span class="badge draft">{KIND_LABEL[conv.root_kind]}</span>
				{#if hasGmail && conv.root_kind !== 'gmail'}<span class="badge draft">+ Gmail</span>{/if}
				{#if cstate ==='awaiting'}<span class="badge sending">{STATE_LABEL.awaiting}</span>{/if}
			</span>
			<span class="meta muted">
				<span class="n" title="{conv.sent} sent · {conv.replies} replied"><Icon name="conversations" size={16} /> {conv.count}</span>
				<time datetime={conv.last_at.replace(' ', 'T') + 'Z'} title="{conv.last_at} UTC">{relTime(conv.last_at)}</time>
			</span>
		</button>
		<a class="open-link" href={threadHref(conv.key)}>Open</a>
	</div>

	{#if open}
		<div class="body" id="conv-body-{conv.key}">
			<ConversationTimeline {conv} />
			{#if conv.messages.some((m) => m.dir === 'out' && m.source !== 'gmail')}
				<p class="muted small">
					Sent emails are re-rendered with the contact's current data. Links are live — including
					unsubscribe.
				</p>
			{/if}
			{#if !canReply}
				<p class="muted small">
					No Message-ID is known for this Gmail thread, so it can't be answered from here —
					{#if conv.gmail_thread_id}<a href={gmailThreadUrl(conv.gmail_thread_id)} target="_blank" rel="noopener noreferrer">reply in Gmail</a>{:else}reply in Gmail{/if}.
				</p>
			{:else}
				<ReplyComposer {conv} />
			{/if}
			<button type="button" class="secondary collapse" onclick={() => { open = false; toggleBtn?.focus(); }}>
				<Icon name="chevron-up" size={16} /> Collapse
			</button>
		</div>
	{/if}
</div>

<style>
	.conv { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.conv:last-child { box-shadow: none; }
	.row { display: flex; align-items: center; gap: var(--space-xs); min-height: 56px; }
	/* Disclosure trigger (theme accordion/collapsible trigger: no fill, neutral-3 hover). */
	.toggle {
		flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-xs);
		background: var(--color-none); color: var(--text); border: 0; box-shadow: none; border-radius: var(--radius-s);
		font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m);
		font-weight: var(--weight-ui-regular); text-align: left;
	}
	.toggle:hover, .toggle:active { background: var(--neutral-3); box-shadow: none; }
	.toggle:focus-visible { box-shadow: var(--focus-halo); }
	.chev { display: inline-flex; color: var(--muted); transition: transform var(--motion-duration) var(--motion-easing); }
	.conv.open .chev { transform: rotate(90deg); }
	.dir { display: inline-flex; color: var(--muted); }
	.subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.subject.bold { font-weight: var(--weight-ui-heavy); }
	.labels { display: inline-flex; gap: var(--space-xxs); flex: none; }
	.meta {
		display: inline-flex; align-items: center; gap: var(--space-m); white-space: nowrap; flex: none;
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
	}
	.n { display: inline-flex; align-items: center; gap: var(--space-xxs); }
	.open-link { font-size: var(--size-s); line-height: var(--line-s); padding: 0 var(--space-xs); flex: none; }
	.body { padding: var(--space-xs) 0 var(--space-m) var(--space-xl); display: flex; flex-direction: column; gap: var(--space-m); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); margin: 0; }
	.collapse { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--space-xxs); }
	@media (max-width: 640px) {
		.labels { display: none; }
		.body { padding-left: 0; }
	}
</style>

<script lang="ts">
	// Thread page (#226): an issue-style header, the messages as a comment timeline (older
	// ones behind "Show N earlier messages" past 6; indented as a reply tree since #378) and
	// the reply composer at the bottom.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import ConversationTimeline from '$lib/components/ConversationTimeline.svelte';
	import ReplyComposer from '$lib/components/ReplyComposer.svelte';
	import { gmailThreadUrl } from '$lib/gmail-link';
	import { relTime } from '$lib/reltime';
	import { convState, STATE_LABEL, KIND_LABEL, listHref, threadHref } from '$lib/conversation-view';
	import { readOpening } from '$lib/suggestions-panel';

	let { data } = $props();

	const conv = $derived(data.conv);
	const cstate = $derived(convState(conv));
	const ctx = $derived({ filter: data.filter, q: data.q });
	const back = $derived(listHref({ ...ctx, page: data.page }));
	const prevHref = $derived(data.neighbors.prev ? threadHref(data.neighbors.prev.key, ctx) : null);
	const nextHref = $derived(data.neighbors.next ? threadHref(data.neighbors.next.key, ctx) : null);
	const gmailUrl = $derived(conv.gmail_thread_id ? gmailThreadUrl(conv.gmail_thread_id) : null);
	const canReply = $derived(conv.root_kind !== 'gmail' || conv.messages.some((m) => m.message_id));

	// #379: Archive returns to the list (the thread leaves it); Unarchive stays here.
	const here = $derived(page.url.pathname + page.url.search);
	let deleteOpen = $state(false);
	// #714: a suggestion's Reply step (`?reply=1`, optional `&opening=` draft line) opens the box.
	const replyRequested = $derived(page.url.searchParams.get('reply') === '1');
	const replyOpening = $derived(readOpening(page.url.searchParams));
</script>

<svelte:head><title>{conv.subject} · Conversations</title></svelte:head>

<Breadcrumbs items={[{ label: 'Conversations', href: back }, { label: conv.name || conv.email }]} />

<header class="thread-head">
	<div class="title-row">
		<h1>{conv.subject}</h1>
		<div class="actions">
			{#if data.archived}
				<form method="POST" action="/conversations?/unarchive" use:enhance>
					<input type="hidden" name="key" value={conv.key} />
					<input type="hidden" name="return_to" value={here} />
					<button type="submit" class="btn">Unarchive</button>
				</form>
			{:else}
				<form method="POST" action="/conversations?/archive" use:enhance>
					<input type="hidden" name="key" value={conv.key} />
					<input type="hidden" name="return_to" value={back} />
					<button type="submit" class="btn">Archive</button>
				</form>
			{/if}
			{#if data.isAdmin}
				<button type="button" class="btn danger-text" onclick={() => (deleteOpen = true)}>Delete</button>
			{/if}
			{#if conv.contact_id != null}
				<a class="btn wide-only" href="/contacts/{conv.contact_id}">Open contact</a>
			{/if}
			<span class="btn-group wide-only">
				{#if prevHref}<a class="btn" href={prevHref} title={data.neighbors.prev?.subject}>Previous</a>{:else}<span class="btn disabled" aria-disabled="true">Previous</span>{/if}
				{#if nextHref}<a class="btn" href={nextHref} title={data.neighbors.next?.subject}>Next</a>{:else}<span class="btn disabled" aria-disabled="true">Next</span>{/if}
			</span>
			<details class="menu" class:narrow-only={!gmailUrl}>
				<summary class="btn" aria-label="More actions"><Icon name="more" size={16} /></summary>
				<div class="menu-pop" role="menu">
					{#if conv.contact_id != null}<a class="narrow-item" role="menuitem" href="/contacts/{conv.contact_id}">Open contact</a>{/if}
					{#if prevHref}<a class="narrow-item" role="menuitem" href={prevHref}>Previous thread</a>{/if}
					{#if nextHref}<a class="narrow-item" role="menuitem" href={nextHref}>Next thread</a>{/if}
					{#if gmailUrl}<a role="menuitem" href={gmailUrl} target="_blank" rel="noopener noreferrer">Open in Gmail <Icon name="external" size={16} /></a>{/if}
				</div>
			</details>
		</div>
	</div>
	<div class="meta">
		{#if data.archived}<span class="badge draft">Archived</span>{/if}
		<span class="badge state {cstate === 'awaiting' ? 'sending' : cstate === 'replied' ? 'sent' : 'draft'}">
			<Icon name={cstate === 'sent' ? 'send' : 'reply'} size={16} />
			{STATE_LABEL[cstate]}
		</span>
		<span class="muted">
			with {#if conv.contact_id != null}<a href="/contacts/{conv.contact_id}"><strong>{conv.name || conv.email}</strong></a>{:else}<strong>{conv.email}</strong>{/if}
			· {conv.count} message{conv.count === 1 ? '' : 's'}
			· last <time datetime={conv.last_at.replace(' ', 'T') + 'Z'} title="{conv.last_at} UTC">{relTime(conv.last_at)}</time>
			· {KIND_LABEL[conv.root_kind]}
		</span>
		{#if data.neighbors.index >= 0}
			<span class="muted pos">{data.neighbors.index + 1} of {data.neighbors.total}</span>
		{/if}
	</div>
</header>

<ConversationTimeline {conv} collapsible />

{#if conv.messages.some((m) => m.dir === 'out' && m.source !== 'gmail')}
	<p class="muted small">
		Sent emails are re-rendered with the contact's current data. Links are live — including unsubscribe.
	</p>
{/if}

<section class="reply-area" aria-label="Reply">
	{#if !canReply}
		<p class="muted small">
			No Message-ID is known for this Gmail thread, so it can't be answered from here —
			{#if gmailUrl}<a href={gmailUrl} target="_blank" rel="noopener noreferrer">reply in Gmail</a>{:else}reply in Gmail{/if}.
		</p>
	{:else}
		<ReplyComposer {conv} initialBody={replyOpening} autofocus={replyRequested} />
	{/if}
</section>

{#if data.isAdmin}
	<Modal title="Delete this conversation?" bind:open={deleteOpen}>
		<form method="POST" action="/conversations?/delete" use:enhance class="delete-form">
			<input type="hidden" name="key" value={conv.key} />
			<input type="hidden" name="confirm" value="1" />
			<input type="hidden" name="return_to" value={back} />
			<p>
				This permanently deletes <strong>1 conversation</strong>: the replies and the Gmail messages you
				received in it. Your sends (campaign emails and mail you sent from Gmail) stay in history and
				stats — they're only hidden from Conversations.
				Deleted Gmail messages won't come back on the next sync. This can't be undone.
			</p>
			<div class="dialog-actions">
				<button type="button" class="secondary" onclick={() => (deleteOpen = false)}>Cancel</button>
				<button type="submit" class="danger">Delete conversation</button>
			</div>
		</form>
	</Modal>
{/if}

<style>
	.thread-head { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); padding-bottom: var(--space-m); margin-bottom: var(--space-l); }
	.title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-xs) var(--space-m); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); font-weight: var(--weight-ui-regular); overflow-wrap: anywhere; min-width: 0; }
	.actions { display: flex; align-items: center; gap: var(--space-xs); flex: none; }
	.btn {
		display: inline-flex; align-items: center; gap: var(--space-xxs); padding: var(--space-xxs) var(--space-m); font-size: var(--size-s); letter-spacing: var(--letter-spacing-s); line-height: var(--line-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--btn-border); border-radius: var(--radius); background: var(--btn-bg); color: var(--btn-text);
		cursor: pointer; white-space: nowrap;
	}
	.btn:hover { text-decoration: none; background: var(--btn-hover); color: var(--btn-text); }
	.btn.disabled { color: var(--muted); opacity: 0.6; cursor: default; }
	.btn.disabled:hover { background: var(--btn-bg); }
	.actions form { margin: 0; display: inline-flex; }
	.danger-text { color: var(--danger); }
	.delete-form p { margin: 0 0 var(--space-m); }
	.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-xs); }
	.btn-group { display: inline-flex; }
	.btn-group > .btn:first-child { border-radius: var(--radius) 0 0 var(--radius); }
	.btn-group > .btn:last-child { border-radius: 0 var(--radius) var(--radius) 0; margin-left: -1px; }
	.menu { position: relative; }
	.menu summary { list-style: none; padding: var(--space-xxs) var(--space-xs); }
	.menu summary::-webkit-details-marker { display: none; }
	.menu-pop {
		position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 12rem; padding: var(--space-xs) 0;
		background: var(--surface); border: 0; border-radius: var(--radius); box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-medium);
	}
	.menu-pop a { display: flex; align-items: center; gap: var(--space-xxs); padding: var(--space-xxs) var(--space-m); color: var(--text); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.menu-pop a:hover { text-decoration: none; background: var(--surface-subtle); }
	.narrow-item { display: none !important; }
	.meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin-top: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.state { display: inline-flex; align-items: center; gap: var(--space-xxs); padding: var(--space-xxs) var(--space-s); font-size: var(--size-s); letter-spacing: var(--letter-spacing-s); line-height: var(--line-s); }
	.pos { margin-left: auto; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }

	.small { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: var(--space-m) 0 0; }
	.reply-area { margin-top: var(--space-l); }

	@media (min-width: 641px) {
		.narrow-only { display: none; }
	}
	@media (max-width: 640px) {
		.wide-only { display: none; }
		.narrow-item { display: flex !important; }
		h1 { font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
		.pos { margin-left: 0; }
	}
</style>

<script lang="ts">
	// A conversation's messages as a reply tree (#378), shared by the thread page and the
	// contact page's collapsible rows. Each message is indented under the one it answers
	// (`threadTree`: In-Reply-To, else the previous message), with CSS connector lines —
	// a rail per open ancestor column and an elbow into the card — like comment threads.
	// Indent caps at 4 levels (3 at ≤ 600px); a deeper message stays at the cap and says
	// whom it answers. The flat list carries `aria-level`, so the nesting is announced.
	// `collapsible` keeps #226's "Show N earlier messages" split (over the tree order).
	import ConversationMessage from '$lib/components/ConversationMessage.svelte';
	import type { Conversation } from '$lib/server/conversations';
	import { relTime } from '$lib/reltime';
	import { messageAuthor, splitTimeline, threadTree } from '$lib/conversation-view';

	let { conv, collapsible = false }: { conv: Conversation; collapsible?: boolean } = $props();

	const msgKey = (m: Conversation['messages'][number]) =>
		m.source === 'gmail' ? `g${m.mail_message_id}` : m.dir + (m.recipient_id ?? m.reply_id);

	let showAll = $state(false);
	// A different thread (Previous / Next) starts collapsed again.
	$effect(() => {
		void conv.key;
		showAll = false;
	});
	const tree = $derived(threadTree(conv.messages));
	const timeline = $derived(splitTimeline(tree, showAll || !collapsible));
</script>

<ol class="timeline">
	{#if timeline.hidden > 0}
		<li class="earlier">
			<button type="button" class="secondary" onclick={() => (showAll = true)}>
				Show {timeline.hidden} earlier message{timeline.hidden === 1 ? '' : 's'}
			</button>
		</li>
	{/if}
	{#each timeline.shown as it (msgKey(it.m))}
		<li class="node" aria-level={it.level + 1} style="--lvl: {it.level}; --lvl-n: {it.levelNarrow}">
			{#each it.rails as col (col)}<span class="rail wide" style="--col: {col}" aria-hidden="true"></span>{/each}
			{#each it.railsNarrow as col (col)}<span class="rail narrow" style="--col: {col}" aria-hidden="true"></span>{/each}
			{#if it.level > 0}<span class="elbow wide" style="--col: {it.level - 1}" aria-hidden="true"></span>{/if}
			{#if it.levelNarrow > 0}<span class="elbow narrow" style="--col: {it.levelNarrow - 1}" aria-hidden="true"></span>{/if}
			{#if it.parent && it.depth > it.levelNarrow}
				<p class="replying muted" class:narrow={it.depth <= it.level}>
					<span aria-hidden="true">↳</span> replying to {messageAuthor(it.parent, conv)},
					<time datetime={it.parent.at.replace(' ', 'T') + 'Z'} title="{it.parent.at} UTC">{relTime(it.parent.at)}</time>
				</p>
			{/if}
			<ConversationMessage m={it.m} {conv} />
		</li>
	{/each}
</ol>

<style>
	.timeline {
		--indent: var(--space-l);
		--gap: var(--space-m);
		list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--gap);
	}
	.earlier { align-self: flex-start; }
	.node { position: relative; min-width: 0; padding-left: calc(var(--lvl) * var(--indent)); }
	/* Connectors: thin --border lines centred in each indent column. A rail runs the full
	   row (bridging the gap above) for an ancestor whose replies continue below; the elbow
	   drops from the row above into this card's header. */
	.rail, .elbow { position: absolute; left: calc(var(--col) * var(--indent) + var(--indent) / 2); pointer-events: none; }
	.rail { top: calc(-1 * var(--gap)); bottom: 0; border-left: var(--border-s) solid var(--border); }
	.elbow {
		top: calc(-1 * var(--gap)); height: calc(var(--gap) + 18px); width: calc(var(--indent) / 2);
		border-left: var(--border-s) solid var(--border); border-bottom: var(--border-s) solid var(--border);
		border-bottom-left-radius: var(--radius-s);
	}
	.narrow { display: none; }
	.replying {
		margin: 0 0 var(--space-xxs); overflow-wrap: anywhere;
		font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs);
	}

	@media (max-width: 600px) {
		.timeline { --indent: var(--space-s); }
		.node { padding-left: calc(var(--lvl-n) * var(--indent)); }
		.wide { display: none; }
		.rail.narrow, .elbow.narrow { display: block; }
		.replying.narrow { display: block; }
	}
</style>

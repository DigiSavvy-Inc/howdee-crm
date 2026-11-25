<script lang="ts">
	// Conversations tab (#157; GitHub-style list in #226): Underline-nav filters, a Box list
	// with one row per thread, Previous/Next pager. A row opens the thread page. Keyboard:
	// j/k move between rows, Enter opens, / focuses search.
	// #379: a checkbox per row (+ select all on this page, x toggles the focused row,
	// shift-click selects a range) and a sticky bar: Archive / Unarchive · Delete (admin).
	// The checkboxes belong to the bar's form (`form=`), so archive works without JS; the bar
	// shows via CSS :has() whenever a box is checked.
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import Modal from '$lib/components/Modal.svelte';
	import BulkBar from '$lib/components/BulkBar.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { relTime } from '$lib/reltime';
	import { FILTER_TABS, EMPTY_TEXT, KIND_LABEL, listHref, threadHref, moveIndex, rangeSelect } from '$lib/conversation-view';
	import type { ConvFilter } from '$lib/server/conversations';

	let { data, form } = $props();

	const tabHref = (filter: ConvFilter) => listHref({ filter, q: data.q });
	const ctx = $derived({ filter: data.filter, q: data.q, page: data.page });

	const from = $derived(data.total === 0 ? 0 : (data.page - 1) * data.per + 1);
	const to = $derived(Math.min(data.page * data.per, data.total));

	let search = $state<HTMLInputElement>();
	let list = $state<HTMLUListElement>();

	// ── Selection (#379) ──
	const keys = $derived(data.conversations.map((c) => c.key));
	let selected = $state<string[]>([]);
	let anchor = -1;
	// A new page / filter / result keeps only the rows still on screen.
	$effect(() => {
		const onPage = new Set(keys);
		untrack(() => (selected = selected.filter((k) => onPage.has(k))));
		anchor = -1;
	});
	const allOn = $derived(keys.length > 0 && selected.length === keys.length);
	const someOn = $derived(selected.length > 0 && !allOn);
	const archivedTab = $derived(data.filter === 'archived');

	function pick(e: MouseEvent, i: number) {
		const on = (e.currentTarget as HTMLInputElement).checked;
		selected = rangeSelect(keys, selected, i, on, anchor, e.shiftKey);
		anchor = i;
	}
	function toggleAll(e: Event) {
		selected = (e.currentTarget as HTMLInputElement).checked ? [...keys] : [];
		anchor = -1;
	}
	function toggleAt(i: number) {
		selected = rangeSelect(keys, selected, i, !selected.includes(keys[i]), -1, false);
		anchor = i;
	}

	let deleteOpen = $state(false);
	const label = (n: number) => `${n} conversation${n === 1 ? '' : 's'}`;
	const done: SubmitFunction = () => async ({ result, update }) => {
		if (result.type === 'success') {
			selected = [];
			deleteOpen = false;
		}
		await update();
	};

	function onKeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (e.key === '/') {
			e.preventDefault();
			search?.focus();
			return;
		}
		if (e.key !== 'j' && e.key !== 'k' && e.key !== 'x') return;
		const links = Array.from(list?.querySelectorAll<HTMLAnchorElement>('a.row') ?? []);
		if (e.key === 'x') {
			const at = links.indexOf(document.activeElement as HTMLAnchorElement);
			if (at >= 0) {
				e.preventDefault();
				toggleAt(at);
			}
			return;
		}
		const i = moveIndex(links.indexOf(document.activeElement as HTMLAnchorElement), e.key, links.length);
		if (i >= 0) {
			e.preventDefault();
			links[i].focus();
		}
	}
</script>

<!-- #572: capture phase, so `/` focuses this page's search before the layout's `/` (site search) sees it. -->
<svelte:window onkeydowncapture={onKeydown} />
<svelte:head><title>Conversations</title></svelte:head>

<div class="pagehead">
	<h1>Conversations <span class="muted count">{data.counts.all}</span></h1>
	<form method="GET" class="search" role="search">
		{#if data.filter !== 'all'}<input type="hidden" name="filter" value={data.filter} />{/if}
		<span class="search-icon muted" aria-hidden="true"><Icon name="search" size={16} /></span>
		<input
			type="search"
			name="q"
			value={data.q}
			placeholder="Search by contact or subject"
			aria-label="Search conversations"
			aria-keyshortcuts="/"
			bind:this={search}
		/>
	</form>
</div>
<p class="muted intro">
	Your sends and the replies they got, threaded per contact, newest activity first. Broadcast and
	automation emails show up here once someone replies.
</p>

<nav class="underline-nav" aria-label="Filter conversations">
	{#each FILTER_TABS.filter((t) => t.key !== 'gmail' || data.gmail) as t (t.key)}
		<a
			class="tab"
			href={tabHref(t.key)}
			aria-current={data.filter === t.key ? 'page' : undefined}
			data-sveltekit-reset="false"
		>
			{t.label} <span class="counter">{data.counts[t.key]}</span>
		</a>
	{/each}
</nav>

{#if form?.bulkSuccess}
	<p class="notice ok" role="status">{form.bulkSuccess}</p>
{:else if form?.bulkError}
	<p class="notice err" role="alert">{form.bulkError}</p>
{/if}

<div class="conv-page">
<div class="box">
	{#if data.conversations.length > 0}
		<div class="box-head">
			<label class="pick">
				<input
					type="checkbox"
					checked={allOn}
					indeterminate={someOn}
					onchange={toggleAll}
					aria-label="Select all conversations on this page"
				/>
			</label>
			<span class="muted">{selected.length ? `${selected.length} selected` : 'Select all on this page'}</span>
		</div>
	{/if}
	{#if data.conversations.length === 0}
		<div class="blank">
			<span class="blank-icon muted" aria-hidden="true"><Icon name="conversations" size={32} /></span>
			<p class="muted">{data.q ? 'No conversations match your search.' : EMPTY_TEXT[data.filter]}</p>
		</div>
	{:else}
		<ul class="rows" bind:this={list}>
			{#each data.conversations as conv, i (conv.key)}
				<li class="item" class:picked={selected.includes(conv.key)}>
					<label class="pick">
						<input
							type="checkbox"
							name="key"
							value={conv.key}
							form="conv-bulk"
							checked={selected.includes(conv.key)}
							onclick={(e) => pick(e, i)}
							aria-label="Select conversation with {conv.name || conv.email}: {conv.subject}"
						/>
					</label>
					<a class="row" class:unread={conv.awaiting} href={threadHref(conv.key, ctx)}>
						<span class="dir muted" title={conv.last_dir === 'in' ? 'Last message is theirs' : 'Last message is yours'}>
							<Icon name={conv.last_dir === 'in' ? 'reply' : 'send'} size={16} />
						</span>
						{#if conv.contact_id != null}
							<Avatar contactId={conv.contact_id} name={conv.name || conv.email} size={32} />
						{:else}
							<span class="avatar-blank" aria-hidden="true"><Icon name="account" size={20} /></span>
						{/if}
						<span class="main">
							<span class="who">
								<span class="name">{conv.name || conv.email}</span>
								{#if conv.name}<span class="email muted">{conv.email}</span>{/if}
							</span>
							<span class="subject">{conv.subject}</span>
							{#if conv.preview}<span class="preview muted">{conv.preview}</span>{/if}
						</span>
						<span class="side">
							<span class="badge draft">{KIND_LABEL[conv.root_kind]}</span>
							{#if conv.awaiting}<span class="badge sending">Awaiting reply</span>{/if}
							<span class="n muted" title="{conv.count} message{conv.count === 1 ? '' : 's'}">
								<Icon name="conversations" size={16} />{conv.count}
							</span>
							<time class="when muted" datetime={conv.last_at.replace(' ', 'T') + 'Z'} title="{conv.last_at} UTC">{relTime(conv.last_at)}</time>
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if selected.length > 0}
	<BulkBar count="{label(selected.length)} selected" onClear={() => (selected = [])}>
		<form method="POST" id="conv-bulk" action="?/archive" use:enhance={done} class="bulk-group">
			{#if archivedTab}
				<button type="submit" formaction="?/unarchive">Unarchive</button>
			{:else}
				<button type="submit">Archive</button>
			{/if}
			{#if data.isAdmin}
				<button type="button" class="danger" onclick={() => (deleteOpen = true)}>Delete</button>
			{/if}
		</form>
	</BulkBar>
{/if}
</div>

{#if data.isAdmin}
	<Modal title="Delete {label(selected.length)}?" bind:open={deleteOpen}>
		<form method="POST" action="?/delete" use:enhance={done} class="delete-form">
			{#each selected as k (k)}<input type="hidden" name="key" value={k} />{/each}
			<input type="hidden" name="confirm" value="1" />
			<p>
				This permanently deletes <strong>{label(selected.length)}</strong>: the replies and the Gmail
				messages you received in them. Your sends (campaign emails and mail you sent from Gmail) stay in
				history and stats — they're only hidden from Conversations. Deleted Gmail messages won't come
				back on the next sync. This can't be undone.
			</p>
			<div class="dialog-actions">
				<button type="button" class="secondary" onclick={() => (deleteOpen = false)}>Cancel</button>
				<button type="submit" class="danger">Delete {label(selected.length)}</button>
			</div>
		</form>
	</Modal>
{/if}

{#if data.total > 0}
	<nav class="pager" aria-label="Pagination">
		<span class="muted pageinfo">Showing {from}–{to} of {data.total}</span>
		<span class="pager-btns">
			{#if data.page > 1}
				<a class="pg" rel="prev" href={listHref({ ...ctx, page: data.page - 1 })} data-sveltekit-reset="false">Previous</a>
			{:else}
				<span class="pg disabled" aria-disabled="true">Previous</span>
			{/if}
			{#if data.page < data.pageCount}
				<a class="pg" rel="next" href={listHref({ ...ctx, page: data.page + 1 })} data-sveltekit-reset="false">Next</a>
			{:else}
				<span class="pg disabled" aria-disabled="true">Next</span>
			{/if}
		</span>
	</nav>
{/if}
<p class="muted keys">Keyboard: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> opens · <kbd>x</kbd> selects · <kbd>/</kbd> search</p>

<style>
	.pagehead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-xs) var(--space-m); }
	.pagehead h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.count { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-regular); }
	.search { position: relative; display: flex; margin: 0; }
	.search-icon { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); display: inline-flex; pointer-events: none; }
	.search input { min-width: 18rem; padding-left: var(--space-xl); }
	.intro { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }

	.underline-nav { display: flex; gap: var(--space-xs); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); margin-bottom: var(--space-m); overflow-x: auto; }
	.tab {
		display: inline-flex; align-items: center; gap: var(--space-xs); padding: var(--space-xs); white-space: nowrap;
		color: var(--text); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-bottom: -1px;
	}
	.tab:hover { text-decoration: none; color: var(--text); box-shadow: inset 0 calc(-1 * var(--border-l)) 0 var(--border); }
	.tab[aria-current='page'] { font-weight: var(--weight-ui-heavy); box-shadow: inset 0 calc(-1 * var(--border-l)) 0 var(--nav-underline); }
	.counter {
		display: inline-block; min-width: 20px; padding: 0 var(--space-xs); border-radius: var(--radius-full); text-align: center;
		font-size: var(--size-xs);
		letter-spacing: var(--letter-spacing-xs); font-weight: var(--weight-ui-medium); line-height: var(--line-xs); background: var(--neutral-muted); color: var(--text);
	}

	.box { border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
	.rows { list-style: none; margin: 0; padding: 0; }
	.box-head { display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-xs) var(--space-m); background: var(--surface-subtle); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.item { display: flex; align-items: stretch; }
	.item.picked { background: var(--surface-subtle); }
	.pick { display: inline-flex; align-items: center; flex: none; padding-left: var(--space-m); margin: 0; cursor: pointer; }
	.box-head .pick { padding-left: 0; }
	.item .row { flex: 1; min-width: 0; }
	.bulk-group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin: 0; }
	.delete-form p { margin: 0 0 var(--space-m); }
	.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-xs); }
	.rows li + li { box-shadow: inset 0 var(--border-s) 0 var(--border-muted); }
	.row { display: flex; align-items: center; gap: var(--space-xs) var(--space-m); min-height: 64px; padding: var(--space-xs) var(--space-m); color: var(--text); }
	.row:hover, .row:focus-visible { text-decoration: none; color: var(--text); background: var(--surface-subtle); }
	.row:focus-visible { outline-offset: -2px; }
	.dir { display: inline-flex; flex: none; }
	.unread .dir { color: var(--accent); }
	.avatar-blank {
		display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: none;
		border-radius: 50%; background: var(--neutral-muted); color: var(--muted);
	}
	.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.who { display: flex; align-items: baseline; gap: var(--space-xs); min-width: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.name { font-weight: var(--weight-ui-heavy); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; max-width: 60%; }
	.email { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.subject { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
	.unread .subject { font-weight: var(--weight-ui-heavy); color: var(--text); }
	/* #585: the latest message's text (a Gmail one's snippet). */
	.preview { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.side { display: flex; align-items: center; gap: var(--space-xs); flex: none; }
	.n { display: inline-flex; align-items: center; gap: var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.when { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); min-width: 4.5rem; text-align: right; white-space: nowrap; }

	.blank { display: flex; flex-direction: column; align-items: center; gap: var(--space-xs); padding: var(--space-xxl) var(--space-m); text-align: center; }
	.blank p { margin: 0; }

	.pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-xs) var(--space-m); margin-top: var(--space-m); }
	.pager-btns { display: inline-flex; gap: var(--space-xs); }
	.pg { padding: var(--space-xxs) var(--space-m); border: 0; box-shadow: 0 0 0 var(--border-s) var(--btn-border); border-radius: var(--radius); background: var(--btn-bg); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--btn-text); }
	.pg:hover { text-decoration: none; background: var(--btn-hover); color: var(--btn-text); }
	.pg.disabled { color: var(--muted); opacity: 0.6; }
	.pageinfo { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.keys { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); margin: var(--space-m) 0 0; }
	kbd { font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); padding: 0 var(--space-xxs); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius-xs); background: var(--surface-subtle); }

	@media (max-width: 640px) {
		.search, .search input { width: 100%; min-width: 0; }
		.row { gap: var(--space-xs); padding: var(--space-xs); }
		.pick { padding-left: var(--space-xs); }
		.dir, .side .badge.draft, .n { display: none; }
		.side { flex-direction: column; align-items: flex-end; gap: var(--space-xxs); }
		.keys { display: none; }
	}
</style>

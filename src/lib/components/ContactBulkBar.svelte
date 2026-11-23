<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
	import Modal from '$lib/components/Modal.svelte';
	import BulkBar from '$lib/components/BulkBar.svelte';
	import { assistantSelection } from '$lib/assistant.svelte';
	import { SELECTION_MAX } from '$lib/assistant-actions';
	import { TIERS, TIER_LABELS, type TierName } from '$lib/engagement-view';
	import { TIER_OVERRIDE_DAYS_MAX } from '$lib/tier-override';
	import { exclusionTagName } from '$lib/segment-exclusion';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import { bulkTargetOptions, pickableTarget } from '$lib/bulk-targets';
	import type { SearchOption } from '$lib/search-select';

	// Bulk bar for a contacts table (#214) — /contacts and /lists/[id]. Every form posts the
	// checked rows (`contact_ids`) or, after "Select all N matching", `all=1` + the page's
	// filter params; the server re-runs the filter ($lib/server/contact-bulk).
	//
	// Two lines: the count with Unsubscribe / Resubscribe (#571), then one Action picker that
	// shows only the chosen action's fields — the bar used to stack every action's row at once.
	// #688: `dynamic` (a rules segment — listed in "Add to segment" but not pickable), `count`
	// (shown in the searchable pickers) and `archived` (#472, sorted after the live ones).
	type Group = { id: number; name: string; kind: string; dynamic?: boolean | number | null; count?: number | null; archived?: boolean };
	let {
		selected,
		all,
		matched,
		pageFull,
		cap,
		filterParams,
		addTargets,
		lists,
		tags,
		automations,
		groupMeta,
		pageGroups,
		matchGroups,
		current = null,
		archiveMode = null,
		scores = [],
		onSelectAll,
		onClear,
		onDone
	}: {
		selected: number[];
		all: boolean;
		matched: number;
		pageFull: boolean; // every row on this page is checked
		cap: number;
		filterParams: Record<string, string>;
		addTargets: Group[]; // "Add to segment" targets: lists + segments (rules ones shown, not pickable)
		lists: Group[]; // "Add to list" targets (kind list)
		tags: { id: number; name: string }[];
		automations: { id: number; name: string }[];
		groupMeta: Group[]; // every list/segment/tag, to name a checked row's memberships
		pageGroups: Record<number, number[]>; // visible row → group ids it's in
		matchGroups: (Group & { n: number })[]; // groups across all matching rows
		/** The /lists/[id] page's own group. `removable` = stored rows (list, tag, hand-picked
		 *  segment); `dynamic` = a rules segment, which gets "Exclude from this segment" instead. */
		current?: { id: number; name: string; kind: string; removable: boolean; dynamic?: boolean } | null;
		archiveMode?: 'archive' | 'restore' | null; // #280: Archive (active view) / Restore (archived view)
		/** #467: "Adjust score" (admins only — pass [] for members to hide it). */
		scores?: { id: number; name: string }[];
		onSelectAll: () => void;
		onClear: () => void;
		onDone: () => void;
	} = $props();

	// #301: the checked rows are the assistant's page-context selection while the bar is up.
	$effect(() => {
		assistantSelection.ids = selected.slice(0, SELECTION_MAX);
		return () => {
			assistantSelection.ids = [];
		};
	});

	const count = $derived(all ? matched : selected.length);
	const label = (n: number) => `${n.toLocaleString('en-US')} contact${n === 1 ? '' : 's'}`;

	// Groups the selection is in, with how many of it each holds.
	const inGroups = $derived.by((): (Group & { n: number })[] => {
		if (all) return matchGroups;
		const counts = new Map<number, number>();
		for (const id of selected) for (const g of pageGroups[id] ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
		return groupMeta.filter((g) => counts.has(g.id)).map((g) => ({ ...g, n: counts.get(g.id)! }));
	});
	const removeLists = $derived(
		inGroups.filter((g) => g.kind !== 'tag' && (!current || g.id !== current.id))
	);
	const removeTags = $derived(inGroups.filter((g) => g.kind === 'tag'));
	const canRemove = $derived(removeLists.length > 0 || !!current?.removable);
	const canExclude = $derived(!!current?.dynamic);
	const exclusionTag = $derived(current ? exclusionTagName(current.name) : '');

	type Action =
		| 'add_list'
		| 'remove_list'
		| 'add_tag'
		| 'remove_tag'
		| 'add_segment'
		| 'exclude_segment'
		| 'enroll'
		| 'set_tier'
		| 'adjust_score'
		| 'archive'
		| 'restore'
		| 'delete';
	let action = $state<Action | ''>('');
	// A choice the selection no longer supports (its last tagged row unchecked, say) goes back to none.
	$effect(() => {
		if (
			(action === 'remove_list' && !canRemove) ||
			(action === 'remove_tag' && removeTags.length === 0) ||
			(action === 'exclude_segment' && !canExclude) ||
			(action === 'adjust_score' && scores.length === 0) ||
			(action === 'archive' && archiveMode !== 'archive') ||
			(action === 'restore' && archiveMode !== 'restore')
		) {
			action = '';
		}
	});

	let listTarget = $state<number | string>(''); // SearchSelect values (#688); '' = new list
	let newList = $state('');
	let removeTarget = $state<number | string>('');
	let tagName = $state('');
	let removeTagName = $state('');
	let segTarget = $state<number | string>(''); // '' = new segment
	let newSegment = $state('');
	let autoTarget = $state<number | ''>('');
	let tierTarget = $state<string>('hot'); // #460
	let tierDays = $state<number | null>(null);
	let scoreTarget = $state<number | ''>(''); // #467
	let scorePoints = $state<number | null>(null);
	let scoreExpires = $state<number | null>(null);
	let scoreNote = $state('');
	let deleteOpen = $state(false);
	let suppressPm = $state(true); // #279: "Also suppress in Postmark", default on
	let deleteConfirm = $state('');
	$effect(() => {
		if (!deleteOpen) deleteConfirm = '';
	});

	// The page's own group is the default "remove from" target on /lists/[id].
	$effect(() => {
		if (removeTarget === '' && current?.removable) removeTarget = current.id;
	});

	function reset() {
		action = '';
		listTarget = '';
		newList = '';
		removeTarget = current?.removable ? current.id : '';
		tagName = '';
		removeTagName = '';
		segTarget = '';
		newSegment = '';
		autoTarget = '';
		tierTarget = 'hot';
		tierDays = null;
		scoreTarget = '';
		scorePoints = null;
		scoreExpires = null;
		scoreNote = '';
		deleteOpen = false;
		suppressPm = true;
	}

	// Keep the selection when an action fails (the banner says why); clear it on success.
	async function after({
		result,
		update
	}: {
		result: ActionResult;
		update: (o?: { reset?: boolean }) => Promise<void>;
	}) {
		await update({ reset: false });
		if (result.type === 'success') {
			reset();
			onDone();
		}
	}
	const done: SubmitFunction = () => after;
	function confirmed(message: () => string): SubmitFunction {
		return ({ cancel }) => {
			if (!confirm(message())) {
				cancel();
				return;
			}
			return after;
		};
	}
	// #688: one searchable picker for every list / segment target in the bar.
	const segOptions = $derived(bulkTargetOptions(addTargets));
	const listOptions = $derived(bulkTargetOptions(lists));
	const removeOptions = $derived.by((): SearchOption[] => {
		const own: SearchOption[] = current?.removable ? [{ value: current.id, label: `${current.name} (this ${current.kind})` }] : [];
		const others = bulkTargetOptions(
			removeLists.map((g) => ({ ...g, count: g.n, dynamic: false })),
			{ countText: (n) => `${n.toLocaleString('en-US')} selected` }
		);
		return [...own, ...others];
	});
	const segReady = $derived(segTarget === '' || pickableTarget(segOptions, segTarget));
	const removeName = $derived(
		removeTarget === current?.id ? current?.name : (inGroups.find((g) => g.id === removeTarget)?.name ?? '')
	);
</script>

{#snippet selection()}
	{#if all}
		<input type="hidden" name="all" value="1" />
		{#each Object.entries(filterParams) as [k, v] (k)}<input type="hidden" name={k} value={v} />{/each}
	{:else}
		{#each selected as id (id)}<input type="hidden" name="contact_ids" value={id} />{/each}
	{/if}
{/snippet}

<BulkBar count="{count.toLocaleString('en-US')} selected" {onClear} placement="top">
	{#if all}
		<span class="muted">— every contact matching the current filter</span>
		{#if matched > cap}<span class="err">Over the {cap.toLocaleString('en-US')} limit — narrow the filter.</span>{/if}
	{:else if pageFull && matched > selected.length}
		<button type="button" class="linky" onclick={onSelectAll}>Select all {matched.toLocaleString('en-US')} matching this filter</button>
	{/if}
	<!-- #279 actions, on the first line (#571) so they're easy to find (shared helper in
	     $lib/server/contact-bulk). -->
	<div class="bulk-sub">
		<form
			method="POST"
			action="?/bulkUnsubscribe"
			use:enhance={confirmed(
				() =>
					`Unsubscribe ${label(count)}? They stop getting campaigns and automation emails, and their active automations are cancelled.${suppressPm ? ' They are also suppressed in Postmark.' : ''}`
			)}
		>
			{@render selection()}
			<button type="submit" class="secondary">Unsubscribe</button>
			<label class="check"><input type="checkbox" name="suppress" value="1" bind:checked={suppressPm} /> Also suppress in Postmark</label>
		</form>
		<form
			method="POST"
			action="?/bulkResubscribe"
			use:enhance={confirmed(
				() =>
					`Resubscribe ${label(count)}?\n\nOnly resubscribe people who have agreed to get your email. Addresses that hard-bounced or marked you as spam stay suppressed in Postmark, so they still won't be sent to.`
			)}
		>
			{@render selection()}
			<button type="submit" class="secondary">Resubscribe</button>
		</form>
	</div>

	<div class="bulk-row">
		<label class="muted" for="bulk-action">Action</label>
		<select id="bulk-action" bind:value={action}>
			<option value="">Choose an action…</option>
			<optgroup label="Lists">
				<option value="add_list">Add to list</option>
				{#if canRemove}<option value="remove_list">Remove from list</option>{/if}
			</optgroup>
			<optgroup label="Tags">
				<option value="add_tag">Add tag</option>
				{#if removeTags.length}<option value="remove_tag">Remove tag</option>{/if}
			</optgroup>
			<optgroup label="Segments">
				<option value="add_segment">Add to segment</option>
				{#if canExclude}<option value="exclude_segment">Exclude from this segment</option>{/if}
			</optgroup>
			<optgroup label="Automations">
				<option value="enroll">Enroll in automation</option>
			</optgroup>
			<optgroup label="Engagement">
				<option value="set_tier">Set tier</option>
				{#if scores.length}<option value="adjust_score">Adjust score</option>{/if}
			</optgroup>
			<optgroup label="Archive and delete">
				{#if archiveMode === 'archive'}
					<option value="archive">Archive</option>
				{:else if archiveMode === 'restore'}
					<option value="restore">Restore</option>
				{/if}
				<option value="delete">Delete</option>
			</optgroup>
		</select>

		{#if action === 'add_list'}
			<form method="POST" action="?/addToList" use:enhance={done}>
				{@render selection()}
				<SearchSelect
					name="list_id"
					bind:value={listTarget}
					options={listOptions}
					ariaLabel="List"
					allowEmpty={{ label: 'New list…', always: true }}
				/>
				{#if listTarget === ''}
					<input name="new_list" bind:value={newList} placeholder="New list name" maxlength="60" required aria-label="New list name" />
				{/if}
				<button type="submit">Add</button>
			</form>
		{:else if action === 'remove_list'}
			<form
				method="POST"
				action="?/removeFromList"
				use:enhance={confirmed(() => `Remove ${label(count)} from “${removeName}”? Only the membership is removed — the contacts are not deleted.`)}
			>
				{@render selection()}
				<SearchSelect
					name="list_id"
					bind:value={removeTarget}
					options={removeOptions}
					ariaLabel="Remove from list"
					placeholder="Choose a list…"
				/>
				<button type="submit" class="secondary" disabled={!pickableTarget(removeOptions, removeTarget)}>Remove</button>
			</form>
		{:else if action === 'add_tag'}
			<form method="POST" action="?/bulkTag" use:enhance={done}>
				{@render selection()}
				<input name="tag" bind:value={tagName} placeholder="tag name" list="bulk-tag-options" autocomplete="off" maxlength="60" required aria-label="Tag name" />
				<datalist id="bulk-tag-options">
					{#each tags as t (t.id)}<option value={t.name}></option>{/each}
				</datalist>
				<button type="submit">Tag</button>
			</form>
		{:else if action === 'remove_tag'}
			<form
				method="POST"
				action="?/removeTag"
				use:enhance={confirmed(() => `Remove the tag “${removeTagName}” from ${label(count)}?`)}
			>
				{@render selection()}
				<select name="tag" bind:value={removeTagName} required aria-label="Tag to remove">
					<option value="">Choose a tag…</option>
					{#each removeTags as t (t.id)}<option value={t.name}>{t.name} · {t.n.toLocaleString('en-US')}</option>{/each}
				</select>
				<button type="submit" class="secondary">Remove tag</button>
			</form>
		{:else if action === 'add_segment'}
			<form method="POST" action="?/addToSegment" use:enhance={done}>
				{@render selection()}
				<!-- #688: rules segments are listed (so they're findable) but disabled with the
				     reason; the server refuses them too (contact-bulk `editable`). -->
				<SearchSelect
					name="segment_id"
					bind:value={segTarget}
					options={segOptions}
					ariaLabel="Segment"
					allowEmpty={{ label: 'New segment…', always: true }}
				/>
				{#if segTarget === ''}
					<input name="new_segment" bind:value={newSegment} placeholder="New segment name" maxlength="60" required aria-label="New segment name" />
				{/if}
				<button type="submit" disabled={!segReady}>Add</button>
			</form>
		{:else if action === 'exclude_segment'}
			<!-- A dynamic segment has no membership rows to delete: the selection gets the segment's
			     exclusion tag and the segment a "tag is absent" rule (contact-bulk `exclude_segment`). -->
			<form
				method="POST"
				action="?/excludeFromSegment"
				use:enhance={confirmed(
					() =>
						`Exclude ${label(count)} from “${current?.name}”? They get the tag “${exclusionTag}” and this segment skips anyone who has it. Remove the tag from a contact to let them back in.`
				)}
			>
				{@render selection()}
				<button type="submit" class="secondary">Exclude</button>
				<span class="muted">Tags them “{exclusionTag}”; remove the tag to let someone back in.</span>
			</form>
		{:else if action === 'enroll'}
			<form method="POST" action="?/addToAutomation" use:enhance={done}>
				{@render selection()}
				<select name="automation_id" bind:value={autoTarget} required disabled={automations.length === 0} aria-label="Automation">
					{#if automations.length === 0}
						<option value="">No active automations</option>
					{:else}
						<option value="">Choose an automation…</option>
						{#each automations as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
					{/if}
				</select>
				<button type="submit" disabled={automations.length === 0}>Enroll</button>
			</form>
		{:else if action === 'set_tier'}
			<!-- #460: override the engagement tier (or back to automatic) for the selection. -->
			<form
				method="POST"
				action="?/bulkSetTier"
				use:enhance={confirmed(() =>
					tierTarget === 'clear'
						? `Put ${label(count)} back on their automatic engagement tier?`
						: `Set the engagement tier of ${label(count)} to ${TIER_LABELS[tierTarget as TierName]}${tierDays ? ` for ${tierDays} days` : ' until cleared'}? The automatic score keeps computing underneath.`
				)}
			>
				{@render selection()}
				<select name="tier" bind:value={tierTarget} aria-label="Engagement tier">
					{#each TIERS as t (t)}<option value={t}>{TIER_LABELS[t]}</option>{/each}
					<option value="clear">Back to automatic</option>
				</select>
				{#if tierTarget !== 'clear'}
					<input type="number" name="days" bind:value={tierDays} min="1" max={TIER_OVERRIDE_DAYS_MAX} placeholder="until cleared" aria-label="Days (blank = until cleared)" style="width: 8em" />
					<span class="muted">days</span>
				{/if}
				<button type="submit" class="secondary">Set</button>
			</form>
		{:else if action === 'adjust_score'}
			<!-- #467: ± points on one score for the selection (manual ledger rows). -->
			<form
				method="POST"
				action="?/bulkAdjustScore"
				use:enhance={confirmed(
					() =>
						`Adjust ${scores.find((x) => x.id === scoreTarget)?.name ?? 'the score'} by ${scorePoints && scorePoints > 0 ? '+' : ''}${scorePoints ?? 0} for ${label(count)}?`
				)}
			>
				{@render selection()}
				<select name="score_id" bind:value={scoreTarget} aria-label="Score">
					<option value="">Choose a score…</option>
					{#each scores as sc (sc.id)}<option value={sc.id}>{sc.name}</option>{/each}
				</select>
				<input type="number" name="points" bind:value={scorePoints} step="1" placeholder="± points" aria-label="Points (± whole number)" style="width: 7em" />
				<input type="number" name="expires_days" bind:value={scoreExpires} min="1" max="3650" placeholder="never expires" aria-label="Expires after days (blank = never)" style="width: 9em" />
				<input name="note" bind:value={scoreNote} maxlength="200" placeholder="note (optional)" aria-label="Note" />
				<button type="submit" class="secondary" disabled={scoreTarget === '' || !scorePoints}>Adjust</button>
			</form>
		{:else if action === 'archive'}
			<form
				method="POST"
				action="?/archiveContacts"
				use:enhance={confirmed(() => `Archive ${label(count)}? They're hidden from views and never sent to; their history is kept and you can restore them.`)}
			>
				{@render selection()}
				<button type="submit" class="secondary">Archive {label(count)}</button>
			</form>
		{:else if action === 'restore'}
			<form method="POST" action="?/restoreContacts" use:enhance={done}>
				{@render selection()}
				<button type="submit" class="secondary">Restore {label(count)}</button>
			</form>
		{:else if action === 'delete'}
			<button type="button" class="danger" onclick={() => (deleteOpen = true)}>Delete {label(count)}</button>
		{/if}
	</div>
</BulkBar>

<Modal title="Delete {label(count)}?" bind:open={deleteOpen}>
	<form method="POST" action="?/deleteContacts" use:enhance={done} class="delete-form">
		{@render selection()}
		<p>
			This permanently deletes <strong>{label(count)}</strong>{#if all}
				— every contact matching the current filter{/if}{#if current} — everywhere, not just from “{current.name}”{/if},
			along with their campaign and tracking history. Unsubscribe records and replies are kept. This cannot be undone.
		</p>
		{#if all}
			<label>
				Type <code>delete</code> to confirm
				<input name="confirm" bind:value={deleteConfirm} autocomplete="off" />
			</label>
		{/if}
		<div class="delete-actions">
			<button type="button" class="secondary" onclick={() => (deleteOpen = false)}>Cancel</button>
			<button type="submit" class="danger" disabled={all && deleteConfirm.trim().toLowerCase() !== 'delete'}>
				Delete {label(count)}
			</button>
		</div>
	</form>
</Modal>

<style>
	/* #571: Unsubscribe / Resubscribe on the first line; wraps under the count on a phone. */
	.bulk-sub,
	.bulk-sub > form {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
		margin: 0;
	}
	/* Second line of the bar (after the shell's Clear): the Action picker, then the chosen
	   action's fields and button. */
	.bulk-row {
		flex: 1 1 100%;
		order: 1;
	}
	.bulk-row,
	.bulk-row > form {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
		margin: 0;
	}
	/* The Action picker shows its longest label whole; the chosen action's fields stay compact. */
	.bulk-row > form input:not([type='checkbox']),
	.bulk-row > form select {
		max-width: min(14rem, 100%);
	}
	/* A plain inline label at every width: checkbox, 8px, text — never stretched like a field. */
	.check {
		display: inline-flex;
		align-items: center;
		justify-content: flex-start;
		gap: 8px;
		width: auto;
		text-align: left;
	}
	.check input[type='checkbox'] {
		flex: 0 0 auto;
		width: auto;
		max-width: none;
		margin: 0;
	}
	.linky {
		padding: 0;
		border: 0;
		background: none;
		box-shadow: none;
		color: var(--link);
		font-size: var(--size-s);
		line-height: var(--line-s);
		font-weight: var(--weight-ui-medium);
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--link-underline);
		text-decoration-thickness: var(--link-underline-thickness);
		text-underline-offset: var(--link-underline-offset);
	}
	.linky:hover {
		background: none;
		box-shadow: none;
		color: var(--link-hover);
		text-decoration-thickness: var(--link-underline-thickness-hover);
	}
	.err {
		color: var(--error);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	.delete-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}
	.delete-form p {
		margin: 0;
	}
	.delete-form label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		font-weight: var(--weight-ui-medium);
	}
	.delete-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-xs);
	}
	@media (max-width: 480px) {
		.bulk-row input:not([type='checkbox']),
		.bulk-row select {
			flex: 1 1 10rem;
			max-width: 100%;
		}
		/* #688: the picker takes the row, so its results open from the left edge and stay on screen. */
		.bulk-row > form :global(.ss) {
			flex: 1 1 100%;
		}
		.bulk-row > form :global(.ss-btn) {
			width: 100%;
		}
	}
</style>

<script lang="ts">
	// #412: the trigger drawer's fields for "Opens an email" / "Clicks a link in an email".
	// Everything is posted as one hidden `trigger_config` JSON (the write layer validates it):
	// the email (any / a broadcast / an email step), the list, the link (clicks), the "is not"
	// condition rows (`exclude`, ≤ 10), the auto-open and once-per-email switches.
	// #448: the "is not" rows are the "About this event" group of the drawer's one Conditions
	// area (EntryConditions, which `entry` configures).
	import { untrack, type ComponentProps } from 'svelte';
	import { deserialize } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import EmailPicker from './EmailPicker.svelte';
	import EntryConditions from './EntryConditions.svelte';
	import SearchSelect from '$lib/components/SearchSelect.svelte';
	import { groupOptionsFromLists } from '$lib/search-select';
	import {
		LINK_OPS,
		MAX_TRIGGER_EXCLUDES,
		type EmailRef,
		type EngagementTriggerConfig,
		type EngagementTriggerKind,
		type ExcludeEntry,
		type LinkOp
	} from '$lib/engagement-trigger';

	type Names = { campaigns: { id: number; subject: string }[]; steps: { id: number; label: string }[] };
	type Row = { key: number; type: 'email'; ref: EmailRef; label: string } | { key: number; type: 'link'; op: LinkOp; value: string };

	let {
		automationId,
		kind,
		config,
		names,
		lists,
		entry
	}: {
		automationId: number;
		kind: EngagementTriggerKind;
		config: EngagementTriggerConfig;
		names: Names;
		lists: { id: number; name: string; kind: string }[];
		entry: Omit<ComponentProps<typeof EntryConditions>, 'event'>;
	} = $props();

	function nameOf(ref: EmailRef | ExcludeEntry): string {
		if (ref === 'any') return 'Any email';
		if ('campaign_id' in ref) return names.campaigns.find((c) => c.id === ref.campaign_id)?.subject ?? '(deleted email)';
		if ('step_id' in ref) return names.steps.find((s) => s.id === ref.step_id)?.label ?? '(deleted email step)';
		return 'Choose an email…';
	}

	// The drawer mounts this fresh each time it opens, so the saved config is the start state.
	const start = untrack(() => $state.snapshot(config)) as EngagementTriggerConfig;
	let email = $state<EmailRef>(start.email);
	let emailLabel = $state(nameOf(start.email));
	let listId = $state<number | ''>(start.list_id ?? '');
	let linkMode = $state<'any' | 'pattern'>(start.link === 'any' ? 'any' : 'pattern');
	let linkOp = $state<LinkOp>(start.link === 'any' ? 'contains' : start.link.op);
	let linkValue = $state(start.link === 'any' ? '' : start.link.value);
	let ignoreProxy = $state(start.ignore_proxy_opens);
	let oncePerEmail = $state(start.once_per_email);
	let nextKey = 1;
	let rows = $state<Row[]>(
		start.exclude.map((e) =>
			'link' in e ? { key: nextKey++, type: 'link', op: e.link.op, value: e.link.value } : { key: nextKey++, type: 'email', ref: e as EmailRef, label: nameOf(e) }
		)
	);

	const clicks = $derived(kind === 'email_clicked');
	const json = $derived(
		JSON.stringify({
			email,
			list_id: listId === '' ? null : Number(listId),
			link: clicks && linkMode === 'pattern' ? { op: linkOp, value: linkValue } : 'any',
			exclude: rows
				.filter((r) => clicks || r.type === 'email')
				.map((r) => (r.type === 'link' ? { link: { op: r.op, value: r.value } } : r.ref)),
			ignore_proxy_opens: ignoreProxy,
			once_per_email: oncePerEmail
		})
	);

	// "Select link": links seen for the chosen email (its HTML ∪ clicked links), as suggestions.
	let linkOptions = $state<string[]>([]);
	const linkListId = `tl-${Math.random().toString(36).slice(2, 9)}`;
	$effect(() => {
		const ref = email;
		if (!clicks || ref === 'any' || !('campaign_id' in ref || 'step_id' in ref)) {
			linkOptions = [];
			return;
		}
		const fd = new FormData();
		if ('campaign_id' in ref) fd.set('campaign_id', String(ref.campaign_id));
		else fd.set('step_id', String(ref.step_id));
		let stale = false;
		fetch(`/automations/${automationId}?/triggerLinks`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } })
			.then((res) => res.text())
			.then((text) => {
				const r = deserialize(text);
				if (!stale && r.type === 'success') linkOptions = (r.data?.triggerLinkOptions as string[]) ?? [];
			})
			.catch(() => {});
		return () => {
			stale = true;
		};
	});

	function pickEmail(ref: EmailRef, label: string) {
		email = ref;
		emailLabel = label;
	}
	function addRow(type: 'email' | 'link') {
		if (rows.length >= MAX_TRIGGER_EXCLUDES) return;
		rows = [...rows, type === 'link' ? { key: nextKey++, type, op: 'contains', value: '' } : { key: nextKey++, type, ref: 'any', label: 'Choose an email…' }];
	}
	function removeRow(key: number) {
		rows = rows.filter((r) => r.key !== key);
	}
	const NOT_LINK: Record<LinkOp, string> = { contains: 'does not contain', equals: 'does not equal', starts_with: 'does not start with' };
</script>

<input type="hidden" name="trigger_config" value={json} />

<div class="field">
	<span>{clicks ? 'When a contact clicks a link in' : 'When a contact opens'}</span>
	<EmailPicker {automationId} value={email} label={emailLabel} ariaLabel="Email" onpick={pickEmail} />
</div>

<div class="field">
	<span>in list</span>
	<SearchSelect
		bind:value={() => listId, (v) => (listId = v === '' ? '' : Number(v))}
		options={groupOptionsFromLists(lists)}
		allowEmpty={{ label: 'Any list' }}
		ariaLabel="List"
	/>
</div>

{#if clicks}
	<fieldset class="field et-link">
		<legend>Link</legend>
		<label class="radio"><input type="radio" bind:group={linkMode} value="any" /> Any link</label>
		<label class="radio"><input type="radio" bind:group={linkMode} value="pattern" /> A link that…</label>
		{#if linkMode === 'pattern'}
			<div class="et-row">
				<select bind:value={linkOp} aria-label="Link match">
					{#each LINK_OPS as o (o.op)}<option value={o.op}>{o.label}</option>{/each}
				</select>
				<input
					type="text"
					bind:value={linkValue}
					list={linkOptions.length ? linkListId : undefined}
					maxlength="500"
					placeholder={email === 'any' ? '/pricing' : 'Pick a link or type part of one'}
					aria-label="Link"
				/>
				{#if linkOptions.length}
					<datalist id={linkListId}>
						{#each linkOptions as href (href)}<option value={href}></option>{/each}
					</datalist>
				{/if}
			</div>
			<p class="hint muted">
				{email === 'any' ? 'Matched against the clicked link, case-insensitive.' : 'Pick one of the links in that email (or that people clicked), or type a pattern.'}
			</p>
		{/if}
	</fieldset>
{/if}

{#if !clicks}
	<label class="checkbox"><input type="checkbox" bind:checked={ignoreProxy} /> Ignore Apple Mail / proxy auto-opens</label>
{/if}
<label class="checkbox"><input type="checkbox" bind:checked={oncePerEmail} /> Fire at most once per email per contact</label>
<p class="hint muted">
	Checked as each {clicks ? 'click' : 'open'} arrives from Postmark. “In list” means the contact is in that list, segment or tag
	at that moment. A paused automation keeps the contacts for you to enroll when you resume it; a draft ignores them.
</p>

<EntryConditions {...entry}>
	{#snippet event()}
		{#each rows as r (r.key)}
			<div class="et-row">
				{#if r.type === 'email'}
					<span class="et-kw">Email</span>
					<select aria-label="Operator" disabled><option>is not</option></select>
					<EmailPicker
						{automationId}
						value={r.ref}
						label={r.label}
						allowAny={false}
						ariaLabel="Excluded email"
						onpick={(ref, label) => (rows = rows.map((x) => (x.key === r.key ? { ...x, ref, label } : x)))}
					/>
				{:else}
					<span class="et-kw">Link</span>
					<select
						aria-label="Operator"
						value={r.op}
						onchange={(e) => (rows = rows.map((x) => (x.key === r.key ? { ...x, op: (e.currentTarget as HTMLSelectElement).value as LinkOp } : x)))}
					>
						{#each LINK_OPS as o (o.op)}<option value={o.op}>{NOT_LINK[o.op]}</option>{/each}
					</select>
					<input
						type="text"
						value={r.value}
						maxlength="500"
						placeholder="unsubscribe"
						aria-label="Link text"
						oninput={(e) => (rows = rows.map((x) => (x.key === r.key ? { ...x, value: (e.currentTarget as HTMLInputElement).value } : x)))}
					/>
				{/if}
				<button type="button" class="iconbtn" aria-label="Remove condition" onclick={() => removeRow(r.key)}><Icon name="close" size={16} /></button>
			</div>
		{/each}
		{#if rows.length < MAX_TRIGGER_EXCLUDES}
			<div class="et-add">
				<button type="button" class="secondary sm" onclick={() => addRow('email')}><Icon name="add" size={16} /> Add condition: email is not…</button>
				{#if clicks}
					<button type="button" class="secondary sm" onclick={() => addRow('link')}><Icon name="add" size={16} /> Add condition: link does not…</button>
				{/if}
			</div>
		{:else}
			<p class="hint muted">At most {MAX_TRIGGER_EXCLUDES} conditions.</p>
		{/if}
	{/snippet}
</EntryConditions>

<style>
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xxs);
		margin-top: var(--space-s);
	}
	.radio {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.et-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		margin: var(--space-xxs) 0;
	}
	.et-row input[type='text'] {
		flex: 1 1 12rem;
		min-width: 0;
	}
	.et-kw {
		min-width: 3rem;
	}
	.et-add {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-top: var(--space-xxs);
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: var(--space-s) 0 0;
	}
	legend {
		padding: 0;
		margin-bottom: var(--space-xxs);
	}
	.checkbox {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin-top: var(--space-xs);
	}
</style>

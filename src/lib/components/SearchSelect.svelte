<script lang="ts">
	// #431: one generic single-value combobox — type to filter, ↑/↓/Enter/Escape, grouped
	// sections, optional "Any"/"None" row and "Create “…”" row (free text, e.g. tag names).
	// Modelled on EmailPicker (#412) and AudiencePicker (#332); filtering is client-side in
	// $lib/search-select. With `name`, a hidden input posts the value, so forms are unchanged.
	import Icon from '$lib/components/Icon.svelte';
	import { firstEnabled, labelFor, rowEnabled, searchRows, stepEnabled, type SearchOption, type SearchOptionValue, type SearchRow } from '$lib/search-select';

	let {
		name,
		value = $bindable(''),
		options,
		placeholder = 'Choose…',
		ariaLabel,
		allowCreate = false,
		allowEmpty,
		disabled = false,
		maxlength,
		onpick
	}: {
		name?: string;
		value?: SearchOptionValue | '';
		options: SearchOption[];
		placeholder?: string;
		ariaLabel: string;
		allowCreate?: boolean;
		allowEmpty?: { label: string; always?: boolean };
		disabled?: boolean;
		maxlength?: number;
		onpick?: (value: SearchOptionValue | '', label: string) => void;
	} = $props();

	let open = $state(false);
	let q = $state('');
	let active = $state(0);
	let searchEl = $state<HTMLInputElement | undefined>();
	let buttonEl = $state<HTMLButtonElement | undefined>();
	let rootEl = $state<HTMLElement | undefined>();
	const uid = `ss-${Math.random().toString(36).slice(2, 9)}`;
	const listId = `${uid}-list`;

	const rows = $derived(searchRows(options, q, { allowEmpty: allowEmpty ?? null, allowCreate }));
	const shown = $derived(labelFor(options, value) || (value === '' && allowEmpty ? allowEmpty.label : ''));
	const rowId = (i: number) => `${uid}-opt-${i}`;
	const isCurrent = (r: SearchRow) => (r.kind === 'empty' ? value === '' : r.kind === 'option' && String(r.value) === String(value));

	/** Opens the popup with the search box focused (e.g. right after a "+ Label" chip). */
	export function focus() {
		if (!disabled) openPopup();
	}

	function openPopup() {
		open = true;
		q = '';
		const at = rows.flat.findIndex(isCurrent);
		active = at < 0 || !rowEnabled(rows.flat[at]) ? firstEnabled(rows.flat) : at;
		queueMicrotask(() => searchEl?.focus());
	}

	function close(refocus: boolean) {
		open = false;
		if (refocus) queueMicrotask(() => buttonEl?.focus());
	}

	function pick(r: SearchRow) {
		if (!rowEnabled(r)) return; // #688: a disabled row only explains itself
		value = r.value;
		onpick?.(r.value, r.kind === 'create' ? r.value : r.label);
		close(true);
	}

	function onInput() {
		active = firstEnabled(rows.flat);
	}

	function onKey(e: KeyboardEvent) {
		const n = rows.flat.length;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (n) active = stepEnabled(rows.flat, active, 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (n) active = stepEnabled(rows.flat, active, -1);
		} else if (e.key === 'Enter') {
			// Never submit the surrounding form from the search box.
			e.preventDefault();
			const r = rows.flat[active];
			if (r) pick(r);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close(true);
		} else if (e.key === 'Tab') {
			close(false);
		}
	}

	$effect(() => {
		if (!open) return;
		document.getElementById(rowId(active))?.scrollIntoView({ block: 'nearest' });
	});

	// Close on a press outside (not on focusout: Safari doesn't focus a clicked button).
	$effect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => {
			if (rootEl && !rootEl.contains(e.target as Node | null)) open = false;
		};
		document.addEventListener('pointerdown', away);
		return () => document.removeEventListener('pointerdown', away);
	});
</script>

<div class="ss" bind:this={rootEl}>
	{#if name}<input type="hidden" {name} value={value ?? ''} />{/if}
	<button
		type="button"
		class="secondary sm ss-btn"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label="{ariaLabel}: {shown || placeholder}"
		bind:this={buttonEl}
		{disabled}
		onclick={() => (open ? close(false) : openPopup())}
	>
		<span class="ss-label" class:muted={!shown}>{shown || placeholder}</span>
		<Icon name="chevron-down" size={16} />
	</button>
	{#if open}
		<div class="ss-pop">
			<input
				type="text"
				role="combobox"
				aria-label="Search: {ariaLabel}"
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={rowEnabled(rows.flat[active]) ? rowId(active) : undefined}
				autocomplete="off"
				placeholder={allowCreate ? 'Search or type a new name…' : 'Search…'}
				{maxlength}
				bind:this={searchEl}
				bind:value={q}
				oninput={onInput}
				onkeydown={onKey}
			/>
			<ul id={listId} role="listbox" aria-label={ariaLabel}>
				{#each rows.groups as g, gi (gi)}
					{#if g.title}<li role="presentation" class="ss-group">{g.title}</li>{/if}
					{#each g.rows as r (`${r.kind}:${r.value}`)}
						{@const i = rows.flat.indexOf(r)}
						{@const off = !rowEnabled(r)}
						<!-- svelte-ignore a11y_click_events_have_key_events (keys are handled on the combobox input) -->
						<li
							id={rowId(i)}
							role="option"
							aria-selected={isCurrent(r)}
							aria-disabled={off || undefined}
							class="ss-opt"
							class:active={i === active && !off}
							class:ss-off={off}
							class:ss-create={r.kind === 'create'}
							onpointerdown={(e) => e.preventDefault()}
							onpointermove={() => {
								if (!off) active = i;
							}}
							onclick={() => pick(r)}
						>
							<span>{r.label}</span>
							{#if r.kind === 'option' && r.detail}<span class="muted">{r.detail}</span>{/if}
						</li>
					{/each}
				{/each}
				{#if rows.flat.length === 0}
					<li role="presentation" class="muted ss-note">No matches.</li>
				{/if}
			</ul>
		</div>
	{/if}
</div>

<style>
	.ss {
		position: relative;
		display: inline-block;
		max-width: 100%;
	}
	.ss-btn {
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xxs);
		max-width: 100%;
		min-width: 10rem;
	}
	.ss-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 28ch;
	}
	.ss-pop {
		position: absolute;
		z-index: 30;
		top: calc(100% + 4px);
		left: 0;
		width: min(360px, 80vw);
		background: var(--surface);
		border: 1px solid var(--border-default-color);
		border-radius: var(--radius-s);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		padding: var(--space-xs);
	}
	.ss-pop input {
		width: 100%;
		box-sizing: border-box;
		margin-bottom: 4px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 280px;
		overflow-y: auto;
	}
	.ss-group {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 8px 6px 2px;
		color: var(--muted, inherit);
	}
	.ss-opt {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 6px;
		border-radius: var(--radius-xs, 4px);
		cursor: pointer;
	}
	.ss-opt.active,
	.ss-opt[aria-selected='true'] {
		background: var(--neutral-2, rgb(0 0 0 / 0.05));
	}
	.ss-opt.active {
		outline: 1px solid var(--border-default-color);
	}
	/* #688: shown but not pickable; the reason (detail) wraps under the name. */
	.ss-off {
		flex-direction: column;
		gap: 0;
		cursor: not-allowed;
		color: var(--muted, inherit);
	}
	.ss-create {
		font-style: italic;
	}
	.ss-note {
		padding: 6px;
	}
</style>

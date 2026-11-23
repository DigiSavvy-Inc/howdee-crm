<script lang="ts">
	// #412: the engagement trigger's searchable "Select email" dropdown — Any email, then sent /
	// scheduled broadcasts (subject + date), this automation's email steps, other automations'
	// email steps by automation. Options come from the page's `?/triggerEmails` action (≤ 50,
	// typing narrows on the server).
	import { deserialize } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import type { EmailRef } from '$lib/engagement-trigger';

	type Option =
		| { kind: 'campaign'; id: number; label: string; detail: string }
		| { kind: 'step'; id: number; label: string; group: string; own: boolean };

	let {
		automationId,
		value,
		label,
		allowAny = true,
		ariaLabel = 'Email',
		onpick
	}: {
		automationId: number;
		value: EmailRef;
		label: string;
		allowAny?: boolean;
		ariaLabel?: string;
		onpick: (ref: EmailRef, label: string) => void;
	} = $props();

	let open = $state(false);
	let q = $state('');
	let options = $state<Option[]>([]);
	let loading = $state(false);
	let failed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let searchEl = $state<HTMLInputElement | undefined>();
	let rootEl = $state<HTMLElement | undefined>();
	const listId = `ep-${Math.random().toString(36).slice(2, 9)}`;

	async function load() {
		loading = true;
		failed = false;
		try {
			const fd = new FormData();
			fd.set('q', q);
			const res = await fetch(`/automations/${automationId}?/triggerEmails`, {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const r = deserialize(await res.text());
			if (r.type === 'success') options = (r.data?.triggerEmailOptions as Option[]) ?? [];
			else failed = true;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	function toggle() {
		open = !open;
		if (open) {
			load();
			queueMicrotask(() => searchEl?.focus());
		}
	}

	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(load, 250);
	}

	function pick(ref: EmailRef, text: string) {
		onpick(ref, text);
		open = false;
	}

	function isSelected(o: Option): boolean {
		if (value === 'any') return false;
		return o.kind === 'campaign' ? 'campaign_id' in value && value.campaign_id === o.id : 'step_id' in value && value.step_id === o.id;
	}

	const groups = $derived.by(() => {
		const out: { title: string; items: Option[] }[] = [];
		const broadcasts = options.filter((o) => o.kind === 'campaign');
		if (broadcasts.length) out.push({ title: 'Broadcasts', items: broadcasts });
		const own = options.filter((o) => o.kind === 'step' && o.own);
		if (own.length) out.push({ title: 'This automation', items: own });
		const byGroup = new Map<string, Option[]>();
		for (const o of options) if (o.kind === 'step' && !o.own) byGroup.set(o.group, [...(byGroup.get(o.group) ?? []), o]);
		for (const [title, items] of byGroup) out.push({ title, items });
		return out;
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			open = false;
		}
	}

	// Close on a press outside (not on focusout: Safari doesn't focus a clicked button, so the
	// option's click would be lost).
	$effect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => {
			if (rootEl && !rootEl.contains(e.target as Node | null)) open = false;
		};
		document.addEventListener('pointerdown', away);
		return () => document.removeEventListener('pointerdown', away);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ep" bind:this={rootEl} onkeydown={onKey}>
	<button
		type="button"
		class="secondary sm ep-btn"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={listId}
		aria-label="{ariaLabel}: {label}"
		onclick={toggle}
	>
		<span class="ep-label">{label}</span>
		<Icon name="chevron-down" size={16} />
	</button>
	{#if open}
		<div class="ep-pop">
			<input type="search" bind:this={searchEl} bind:value={q} oninput={onSearch} placeholder="Search emails…" aria-label="Search emails" />
			<ul id={listId} role="listbox" aria-label={ariaLabel}>
				{#if allowAny && !q.trim()}
					<li role="presentation">
						<button type="button" role="option" aria-selected={value === 'any'} class="ep-opt" onclick={() => pick('any', 'Any email')}>Any email</button>
					</li>
				{/if}
				{#each groups as g (g.title)}
					<li role="presentation" class="ep-group">{g.title}</li>
					{#each g.items as o (`${o.kind}:${o.id}`)}
						<li role="presentation">
							<button
								type="button"
								role="option"
								aria-selected={isSelected(o)}
								class="ep-opt"
								onclick={() =>
									pick(o.kind === 'campaign' ? { campaign_id: o.id } : { step_id: o.id }, o.kind === 'step' && !o.own ? `${o.group} › ${o.label}` : o.label)}
							>
								<span>{o.label}</span>
								{#if o.kind === 'campaign'}<span class="muted">{o.detail}</span>{/if}
							</button>
						</li>
					{/each}
				{/each}
				{#if loading}
					<li role="presentation" class="muted ep-note">Loading…</li>
				{:else if failed}
					<li role="presentation" class="err ep-note">Couldn’t load emails.</li>
				{:else if groups.length === 0}
					<li role="presentation" class="muted ep-note">No matching emails.</li>
				{/if}
			</ul>
		</div>
	{/if}
</div>

<style>
	.ep {
		position: relative;
		display: inline-block;
		max-width: 100%;
	}
	.ep-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xxs);
		max-width: 100%;
	}
	.ep-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 28ch;
	}
	.ep-pop {
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
	.ep-pop input {
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
	.ep-group {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 8px 6px 2px;
		color: var(--muted, inherit);
	}
	.ep-opt {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		text-align: left;
		background: none;
		border: 0;
		padding: 6px;
		border-radius: var(--radius-xs, 4px);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.ep-opt:hover,
	.ep-opt:focus-visible,
	.ep-opt[aria-selected='true'] {
		background: var(--neutral-2, rgb(0 0 0 / 0.05));
	}
	.ep-note {
		padding: 6px;
	}
</style>

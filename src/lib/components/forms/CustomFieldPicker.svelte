<script lang="ts">
	// #619: "Maps to: Custom field" and the "Set a field" action. A picker of defined custom
	// fields plus "Create new field…": the create row is prefilled from the question (label,
	// key, suggested type and options) and saves through POST /api/custom-fields without leaving
	// the question. A key that has no definition keeps working and shows "not defined yet" with
	// a one-click Define.
	import {
		CUSTOM_FIELD_LIMITS,
		CUSTOM_FIELD_TYPES,
		CUSTOM_FIELD_TYPE_LABELS,
		fieldKeyFromLabel,
		uniqueKey,
		type CustomFieldType,
		type FieldOption
	} from '$lib/custom-fields';

	let {
		value,
		fields,
		label = 'Custom field',
		canCreate = false,
		suggestion = { label: '', type: 'text', options: [] },
		onpick,
		oncreated
	}: {
		value: string;
		fields: FieldOption[];
		label?: string;
		canCreate?: boolean;
		/** What a new field starts as (from the question). */
		suggestion?: { label: string; type: CustomFieldType; options: string[] };
		onpick: (key: string) => void;
		oncreated: (f: FieldOption) => void;
	} = $props();

	const uid = $props.id();
	const CREATE = '__create__';
	const defined = $derived(fields.some((f) => f.key === value));

	let creating = $state(false);
	let cLabel = $state('');
	let cKey = $state('');
	let cKeyTouched = $state(false);
	let cType = $state<CustomFieldType>('text');
	let cOptions = $state('');
	let busy = $state(false);
	let err = $state('');

	function openCreate() {
		cLabel = suggestion.label.trim().slice(0, CUSTOM_FIELD_LIMITS.label);
		cKeyTouched = false;
		cKey = uniqueKey(fieldKeyFromLabel(cLabel), fields.map((f) => f.key));
		cType = suggestion.type;
		cOptions = suggestion.options.join('\n');
		err = '';
		creating = true;
	}

	function onSelect(v: string) {
		if (v === CREATE) openCreate();
		else {
			creating = false;
			onpick(v);
		}
	}

	async function post(body: Record<string, unknown>) {
		busy = true;
		err = '';
		try {
			const res = await fetch('/api/custom-fields', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const out = (await res.json().catch(() => ({}))) as { field?: FieldOption; error?: string };
			if (!res.ok || !out.field) {
				err = out.error ?? 'Couldn’t save the field.';
				return;
			}
			oncreated(out.field);
			onpick(out.field.key);
			creating = false;
		} catch {
			err = 'Couldn’t save the field.';
		} finally {
			busy = false;
		}
	}

	const create = () => post({ label: cLabel, key: cKey, type: cType, options: cOptions.split('\n') });
	const define = () => post({ define: true, key: value, label: suggestion.label, type: suggestion.type, options: suggestion.options });
</script>

<div class="cfp">
	<label class="sub">
		<span>{label}</span>
		<select value={creating ? CREATE : value} onchange={(e) => onSelect(e.currentTarget.value)}>
			{#if !value}<option value="" disabled>Choose a field…</option>{/if}
			{#each fields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
			{#if value && !defined}<option value={value}>{value} (not defined yet)</option>{/if}
			{#if canCreate}<option value={CREATE}>Create new field…</option>{/if}
		</select>
	</label>

	{#if value && !defined && !creating}
		<p class="note">
			<span class="muted">“{value}” is not defined yet.</span>
			{#if canCreate}<button type="button" class="link-btn" disabled={busy} onclick={define}>Define it</button>{/if}
		</p>
	{/if}

	{#if creating}
		<div class="create" role="group" aria-label="New custom field">
			<label class="sub">
				<span>Label</span>
				<input
					value={cLabel}
					maxlength={CUSTOM_FIELD_LIMITS.label}
					oninput={(e) => {
						cLabel = e.currentTarget.value;
						if (!cKeyTouched) cKey = uniqueKey(fieldKeyFromLabel(cLabel), fields.map((f) => f.key));
					}}
				/>
			</label>
			<label class="sub">
				<span>Key</span>
				<input
					value={cKey}
					maxlength={CUSTOM_FIELD_LIMITS.key}
					spellcheck="false"
					oninput={(e) => {
						cKeyTouched = true;
						cKey = e.currentTarget.value;
					}}
				/>
			</label>
			<label class="sub">
				<span>Type</span>
				<select bind:value={cType}>
					{#each CUSTOM_FIELD_TYPES as t (t)}<option value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>{/each}
				</select>
			</label>
			{#if cType === 'choice'}
				<label class="sub wide">
					<span>Options <span class="muted">(one per line)</span></span>
					<textarea id="{uid}-opts" rows="3" bind:value={cOptions}></textarea>
				</label>
			{/if}
			<div class="btns">
				<button type="button" disabled={busy || !cLabel.trim()} onclick={create}>Create field</button>
				<button type="button" class="secondary" disabled={busy} onclick={() => (creating = false)}>Cancel</button>
			</div>
		</div>
	{/if}
	{#if err}<p class="err" role="alert">{err}</p>{/if}
</div>

<style>
	.cfp { display: flex; flex-direction: column; gap: var(--space-xs); flex: 1 1 200px; min-width: 0; }
	.sub { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); }
	.create { display: flex; flex-wrap: wrap; gap: var(--space-s); align-items: flex-end; padding: var(--space-s); border-radius: var(--radius); box-shadow: inset 0 0 0 var(--border-s) var(--border); }
	.create .sub { flex: 1 1 140px; }
	.create .wide { flex-basis: 100%; }
	.btns { display: flex; gap: var(--space-xs); }
	.note { margin: 0; font-size: var(--size-s); line-height: var(--line-s); display: flex; gap: var(--space-xs); flex-wrap: wrap; align-items: center; }
	.link-btn { background: none; border: 0; padding: 0; color: var(--text); cursor: pointer; font-size: var(--size-s); text-decoration: underline; text-decoration-color: var(--accent); box-shadow: none; min-height: 0; }
	.err { margin: 0; color: var(--danger); font-size: var(--size-s); }
</style>

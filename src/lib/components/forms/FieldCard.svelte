<script lang="ts">
	// #509: one question card in the form builder (Google Forms style). At rest it shows the
	// question as people will see it; focused, it becomes editable: label, type, options, help,
	// required, answer key, "Maps to", duplicate / delete / move.
	import { tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CustomFieldPicker from '$lib/components/forms/CustomFieldPicker.svelte';
	import { suggestFieldType, type FieldOption } from '$lib/custom-fields';
	import type { IconName } from '$lib/icons/glyphs';
	import {
		CONTACT_FIELDS,
		CONTACT_FIELD_LABELS,
		FIELD_TYPES,
		TICK_TYPES,
		fieldTypeInfo,
		keyFromLabel,
		ratingOf,
		type FieldMap,
		type FormField,
		type FormFieldType
	} from '$lib/forms';
	import {
		DEFAULT_RATING,
		RATING_LABEL_MAX,
		RATING_SCALES,
		RATING_STYLES,
		RATING_STYLE_LABELS,
		fillsUpTo,
		ratingGlyph,
		scaleAllowed,
		scaleLabel,
		type RatingSettings,
		type RatingStyle
	} from '$lib/form-rating';

	let {
		field = $bindable(),
		index,
		count,
		pageNumber = 0,
		focused = false,
		readonly = false,
		problems = [],
		lists = [],
		topics = [],
		customFields = [],
		canCreateField = false,
		onfieldcreated = () => {},
		onfocus,
		onmove,
		onduplicate,
		ondelete,
		ondragstart,
		ondragend
	}: {
		field: FormField;
		index: number;
		count: number;
		/** Page number this break starts (page breaks only). */
		pageNumber?: number;
		focused?: boolean;
		readonly?: boolean;
		problems?: string[];
		lists?: { id: number; name: string }[];
		topics?: { id: number; label: string }[];
		/** #619: defined custom fields (the "Custom field" picker). */
		customFields?: FieldOption[];
		canCreateField?: boolean;
		onfieldcreated?: (f: FieldOption) => void;
		onfocus: () => void;
		onmove: (dir: -1 | 1) => void;
		onduplicate: () => void;
		ondelete: () => void;
		ondragstart: (e: DragEvent) => void;
		ondragend: () => void;
	} = $props();

	const uid = $props.id();
	const info = $derived(fieldTypeInfo(field.type)!);
	const layout = $derived(field.type === 'heading' || field.type === 'paragraph' || field.type === 'page_break');
	let keyTouched = $state(false);
	$effect.pre(() => {
		// A key that isn't the label's auto key was set by hand.
		if (field.key && field.key !== keyFromLabel(field.label)) keyTouched = true;
	});
	let optionEls: HTMLInputElement[] = $state([]);

	function setLabel(v: string) {
		field.label = v;
		if (info.answer && !keyTouched) field.key = keyFromLabel(v);
	}

	function setType(t: FormFieldType) {
		const next = fieldTypeInfo(t)!;
		field.type = t;
		if (next.options && field.options.length === 0) field.options = [{ value: 'Option 1', label: 'Option 1' }];
		if (!next.options && t !== 'topics') field.options = [];
		if (t === 'topics') field.options = [];
		if (!next.required) field.required = false;
		if (field.map && !mapKinds(t).includes(field.map.to)) field.map = null;
		if (next.answer && !field.key) field.key = keyFromLabel(field.label);
		if (t === 'rating' && !field.rating) field.rating = { ...DEFAULT_RATING };
		if (t !== 'rating' && field.rating) delete field.rating;
	}

	// --- Rating (#589)

	const rating = $derived(ratingOf(field));
	function setRating(patch: Partial<RatingSettings>) {
		const next = { ...rating, ...patch };
		// A style that doesn't offer the current scale falls back to its first one.
		if (!scaleAllowed(next.style, next.min, next.max)) Object.assign(next, RATING_SCALES[next.style][0]);
		field.rating = next;
	}
	/** Sample glyphs for the style picker / rest preview: 5 choices, the first 3 "picked". */
	function sample(style: RatingStyle, n = 5): { html: string; on: boolean; num: number }[] {
		const out = [];
		for (let v = 1; v <= n; v++) {
			const on = fillsUpTo(style) ? v <= 3 : v === 4;
			out.push({ html: ratingGlyph(style, v, 20), on, num: v });
		}
		return out;
	}

	// --- Options

	async function addOption(after = field.options.length - 1) {
		const n = field.options.length + 1;
		const label = `Option ${n}`;
		field.options = [...field.options.slice(0, after + 1), { value: label, label }, ...field.options.slice(after + 1)];
		await tick();
		optionEls[after + 1]?.focus();
		optionEls[after + 1]?.select();
	}
	function setOption(i: number, v: string) {
		field.options[i] = { value: v, label: v };
	}
	async function optionKey(e: KeyboardEvent, i: number) {
		if (e.key === 'Enter') {
			e.preventDefault();
			await addOption(i);
		} else if (e.key === 'Backspace' && field.options[i].label === '' && field.options.length > 1) {
			e.preventDefault();
			field.options = field.options.filter((_, j) => j !== i);
			await tick();
			optionEls[Math.max(0, i - 1)]?.focus();
		}
	}

	// --- Maps to

	type MapKind = FieldMap['to'] | 'none';
	function mapKinds(t: FormFieldType): FieldMap['to'][] {
		const i = fieldTypeInfo(t);
		if (!i?.mapping) return [];
		if (t === 'rating') return ['meta']; // the latest number, for segments / scores / automations
		if (TICK_TYPES.includes(t)) return ['meta', 'tag', 'list', 'topic'];
		if (i.options) return t === 'checkboxes' ? ['meta', 'tag', 'tag_prefix'] : ['contact', 'meta', 'tag', 'tag_prefix'];
		return ['contact', 'meta', 'tag'];
	}
	const MAP_LABELS: Record<FieldMap['to'], string> = {
		contact: 'Contact field',
		meta: 'Custom field',
		tag: 'Tag',
		tag_prefix: 'Tags with a prefix',
		list: 'List',
		topic: 'Topic'
	};
	const kinds = $derived(mapKinds(field.type));
	const mapKind = $derived<MapKind>(field.map?.to ?? 'none');

	function setMapKind(k: MapKind) {
		if (k === 'none') field.map = null;
		else if (k === 'contact') field.map = { to: 'contact', field: field.type === 'email' ? 'email' : 'first_name' };
		else if (k === 'meta') {
			// #619: a defined field with the answer's key, else the answer key (shown as "not defined yet").
			const guess = field.key || keyFromLabel(field.label) || 'answer';
			field.map = { to: 'meta', key: customFields.find((f) => f.key === guess)?.key ?? guess };
		}
		else if (k === 'tag') field.map = TICK_TYPES.includes(field.type) || !info.options ? { to: 'tag', name: '' } : { to: 'tag' };
		else if (k === 'tag_prefix') field.map = { to: 'tag_prefix', prefix: `${field.key || 'answer'}:` };
		else if (k === 'list') field.map = lists[0] ? { to: 'list', list_id: lists[0].id } : null;
		else if (k === 'topic') field.map = topics[0] ? { to: 'topic', list_id: topics[0].id } : null;
	}

	function mapSummary(m: FieldMap | null): string {
		if (!m) return 'Answer only';
		switch (m.to) {
			case 'contact':
				return `Contact: ${CONTACT_FIELD_LABELS[m.field]}`;
			case 'meta':
				return `Custom field: ${customFields.find((f) => f.key === m.key)?.label ?? `${m.key} (not defined yet)`}`;
			case 'tag':
				return m.name ? `Tag: ${m.name}` : 'Tag: the chosen option';
			case 'tag_prefix':
				return `Tags: ${m.prefix}<option>`;
			case 'list':
				return `List: ${lists.find((l) => l.id === m.list_id)?.name ?? `#${m.list_id}`}`;
			case 'topic':
				return `Topic: ${topics.find((t) => t.id === m.list_id)?.label ?? `#${m.list_id}`}`;
		}
	}

	const typeIcon = $derived(info.icon as IconName);
</script>

{#snippet ratingPreview()}
	<!-- Live preview of the chosen style and scale (decorative; the public form is the real thing). -->
	<div class="rt-preview" aria-hidden="true">
		<span class="rt-sample">
			{#each sample(rating.style, rating.max - rating.min + 1) as g, gi (gi)}
				{#if rating.style === 'numbers'}<span class="rt-num-s" class:on={gi === 3}>{rating.min + gi}</span>{:else}<span class="rt-glyph-s" class:on={g.on}>{@html g.html}</span>{/if}
			{/each}
		</span>
		{#if rating.low_label || rating.high_label}<span class="rt-ends-s"><span>{rating.low_label}</span><span>{rating.high_label}</span></span>{/if}
	</div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	class="fcard"
	class:focused
	class:layout
	class:break={field.type === 'page_break'}
	class:bad={problems.length > 0}
	id="field-{field.id}"
	data-field-id={field.id}
	onclick={() => !focused && onfocus()}
	onfocusin={() => !focused && onfocus()}
>
	{#if !readonly}
		<span
			class="handle"
			draggable="true"
			title="Drag to reorder"
			aria-hidden="true"
			{ondragstart}
			{ondragend}
		><Icon name="drag-handle" size={16} /></span>
	{/if}

	{#if field.type === 'page_break'}
		<div class="break-head"><span class="pill">Page {pageNumber}</span></div>
	{/if}

	{#if focused && !readonly}
		<div class="edit">
			<div class="row top">
				{#if field.type === 'paragraph'}
					<label class="grow">
						<span class="sr">Paragraph text (Markdown)</span>
						<textarea rows="3" value={field.label} oninput={(e) => setLabel(e.currentTarget.value)} placeholder="Text shown on the form (Markdown)"></textarea>
					</label>
				{:else}
					<label class="grow">
						<span class="sr">{field.type === 'page_break' ? 'Page title' : field.type === 'heading' ? 'Heading' : 'Question'}</span>
						<input
							class="q-input"
							value={field.label}
							oninput={(e) => setLabel(e.currentTarget.value)}
							placeholder={field.type === 'page_break' ? 'Page title (optional)' : field.type === 'heading' ? 'Heading' : 'Question'}
						/>
					</label>
				{/if}
				<label class="type">
					<span class="sr">Type</span>
					<span class="type-icon"><Icon name={typeIcon} size={16} /></span>
					<select value={field.type} onchange={(e) => setType(e.currentTarget.value as FormFieldType)}>
						{#each FIELD_TYPES as t (t.type)}
							<option value={t.type}>{t.label}</option>
						{/each}
					</select>
				</label>
			</div>

			{#if info.options}
				<ul class="opts">
					{#each field.options as o, i (i)}
						<li>
							<span class="bullet" class:square={field.type === 'checkboxes'} aria-hidden="true">{field.type === 'select' ? `${i + 1}.` : ''}</span>
							<input
								bind:this={optionEls[i]}
								value={o.label}
								oninput={(e) => setOption(i, e.currentTarget.value)}
								onkeydown={(e) => optionKey(e, i)}
								aria-label="Option {i + 1}"
							/>
							{#if field.options.length > 1}
								<button type="button" class="icon-btn" aria-label="Remove option {i + 1}" onclick={() => (field.options = field.options.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>
							{/if}
						</li>
					{/each}
					<li><button type="button" class="link-btn" onclick={() => addOption()}>Add option</button></li>
				</ul>
			{:else if field.type === 'topics'}
				<p class="muted note">The topics offered are chosen in the Settings tab.</p>
			{:else if field.type === 'rating'}
				<fieldset class="rt-styles">
					<legend class="sub-legend">Style</legend>
					<div class="rt-style-row">
						{#each RATING_STYLES as st (st)}
							<label class="rt-style" class:on={rating.style === st}>
								<input type="radio" name="{uid}-rstyle" value={st} checked={rating.style === st} onchange={() => setRating({ style: st })} />
								<span class="rt-sample" aria-hidden="true">
									{#each sample(st, 3) as g (g.num)}
										{#if st === 'numbers'}<span class="rt-num-s" class:on={g.on}>{g.num}</span>{:else}<span class="rt-glyph-s" class:on={g.on}>{@html g.html}</span>{/if}
									{/each}
								</span>
								<span>{RATING_STYLE_LABELS[st]}</span>
							</label>
						{/each}
					</div>
				</fieldset>
				<div class="maps">
					<label class="sub">
						<span>Scale</span>
						<select
							value={`${rating.min}-${rating.max}`}
							disabled={RATING_SCALES[rating.style].length < 2}
							onchange={(e) => {
								const [min, max] = e.currentTarget.value.split('-').map(Number);
								setRating({ min, max });
							}}
						>
							{#each RATING_SCALES[rating.style] as sc (`${sc.min}-${sc.max}`)}
								<option value={`${sc.min}-${sc.max}`}>{scaleLabel(sc)}</option>
							{/each}
						</select>
					</label>
					<label class="sub">
						<span>Low end label <span class="muted">(optional)</span></span>
						<input value={rating.low_label} oninput={(e) => setRating({ low_label: e.currentTarget.value.slice(0, RATING_LABEL_MAX) })} placeholder="Not likely" maxlength={RATING_LABEL_MAX} />
					</label>
					<label class="sub">
						<span>High end label <span class="muted">(optional)</span></span>
						<input value={rating.high_label} oninput={(e) => setRating({ high_label: e.currentTarget.value.slice(0, RATING_LABEL_MAX) })} placeholder="Very likely" maxlength={RATING_LABEL_MAX} />
					</label>
				</div>
				{@render ratingPreview()}
				<p class="muted note">Saved on the contact as a rating they gave you (Ratings card). Map it to a custom field to use the latest number in segments, scores and automations.</p>
			{/if}

			{#if field.type !== 'paragraph' && field.type !== 'heading'}
				<label class="sub">
					<span>{field.type === 'page_break' ? 'Description' : 'Help text'}</span>
					<input bind:value={field.help} placeholder="Optional" maxlength="500" />
				</label>
			{/if}
			{#if ['short_text', 'long_text', 'email', 'phone', 'number', 'url', 'select'].includes(field.type)}
				<label class="sub">
					<span>Placeholder</span>
					<input bind:value={field.placeholder} placeholder="Optional" maxlength="150" />
				</label>
			{/if}
			{#if info.answer}
				<label class="sub">
					<span>Answer key <span class="muted">(prefill <code>?{field.key || 'key'}=</code>, CSV column)</span></span>
					<input
						value={field.key}
						oninput={(e) => {
							keyTouched = true;
							field.key = e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
						}}
						maxlength="40"
						spellcheck="false"
					/>
				</label>
			{/if}

			{#if kinds.length}
				<div class="maps">
					<label class="sub">
						<span>Maps to</span>
						<select value={mapKind} onchange={(e) => setMapKind(e.currentTarget.value as MapKind)}>
							<option value="none">Answer only</option>
							{#each kinds as k (k)}
								<option value={k} disabled={(k === 'list' && !lists.length) || (k === 'topic' && !topics.length)}>{MAP_LABELS[k]}</option>
							{/each}
						</select>
					</label>
					{#if field.map?.to === 'contact'}
						{@const m = field.map}
						<label class="sub">
							<span>Contact field</span>
							<select value={m.field} onchange={(e) => (field.map = { to: 'contact', field: e.currentTarget.value as (typeof CONTACT_FIELDS)[number] })}>
								{#each CONTACT_FIELDS as cf (cf)}
									<option value={cf} disabled={cf === 'email' && field.type !== 'email' && field.type !== 'hidden'}>{CONTACT_FIELD_LABELS[cf]}</option>
								{/each}
							</select>
						</label>
					{:else if field.map?.to === 'meta'}
						{@const m = field.map}
						<CustomFieldPicker
							value={m.key}
							fields={customFields}
							canCreate={canCreateField}
							suggestion={{ label: field.label, ...suggestFieldType(field.type, field.options) }}
							onpick={(key) => (field.map = { to: 'meta', key })}
							oncreated={onfieldcreated}
						/>
					{:else if field.map?.to === 'tag'}
						{@const m = field.map}
						<label class="sub">
							<span>{info.options && !TICK_TYPES.includes(field.type) ? 'Tag name (blank = the chosen option)' : 'Tag name'}</span>
							<input value={m.name ?? ''} oninput={(e) => (field.map = { to: 'tag', name: e.currentTarget.value.slice(0, 60) })} maxlength="60" />
						</label>
					{:else if field.map?.to === 'tag_prefix'}
						{@const m = field.map}
						<label class="sub">
							<span>Prefix</span>
							<input value={m.prefix} oninput={(e) => (field.map = { to: 'tag_prefix', prefix: e.currentTarget.value.slice(0, 60) })} maxlength="60" />
						</label>
					{:else if field.map?.to === 'list'}
						{@const m = field.map}
						<label class="sub">
							<span>Add to list when ticked</span>
							<select value={m.list_id} onchange={(e) => (field.map = { to: 'list', list_id: Number(e.currentTarget.value) })}>
								{#each lists as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
							</select>
						</label>
					{:else if field.map?.to === 'topic'}
						{@const m = field.map}
						<label class="sub">
							<span>Opt in to topic when ticked</span>
							<select value={m.list_id} onchange={(e) => (field.map = { to: 'topic', list_id: Number(e.currentTarget.value) })}>
								{#each topics as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
							</select>
						</label>
					{/if}
				</div>
			{/if}

			{#if problems.length}
				<ul class="problems" role="alert">{#each problems as p, i (i)}<li>{p}</li>{/each}</ul>
			{/if}

			<div class="foot">
				<button type="button" class="icon-btn" aria-label="Move up" title="Move up" disabled={index === 0} onclick={() => onmove(-1)}><Icon name="arrow-up" size={16} /></button>
				<button type="button" class="icon-btn" aria-label="Move down" title="Move down" disabled={index === count - 1} onclick={() => onmove(1)}><Icon name="arrow-down" size={16} /></button>
				<span class="spacer"></span>
				<button type="button" class="icon-btn" aria-label="Duplicate" title="Duplicate" onclick={onduplicate}><Icon name="copy" size={16} /></button>
				<button type="button" class="icon-btn" aria-label="Delete" title="Delete" onclick={ondelete}><Icon name="delete" size={16} /></button>
				{#if info.required}
					<label class="req"><input type="checkbox" bind:checked={field.required} /> Required</label>
				{/if}
			</div>
		</div>
	{:else}
		<!-- At rest: the question as it will look. -->
		<div class="rest">
			{#if field.type === 'page_break'}
				<p class="q">{field.label || 'Untitled page'}</p>
				{#if field.help}<p class="muted help">{field.help}</p>{/if}
			{:else if field.type === 'heading'}
				<p class="q h">{field.label || 'Heading'}</p>
			{:else if field.type === 'paragraph'}
				<p class="para">{field.label || 'Paragraph'}</p>
			{:else}
				<p class="q">
					{field.label || (field.type === 'hidden' ? `Hidden: ${field.key || 'value'}` : 'Untitled question')}{#if field.required}<span class="star" aria-label="required"> *</span>{/if}
				</p>
				{#if field.help}<p class="muted help">{field.help}</p>{/if}
				{#if info.options}
					<ul class="preview-opts">
						{#each field.options.slice(0, 6) as o, i (i)}
							<li><span class="bullet" class:square={field.type === 'checkboxes'} aria-hidden="true">{field.type === 'select' ? `${i + 1}.` : ''}</span>{o.label}</li>
						{/each}
						{#if field.options.length > 6}<li class="muted">+{field.options.length - 6} more</li>{/if}
					</ul>
				{:else if field.type === 'rating'}
					{@render ratingPreview()}
				{:else if field.type !== 'checkbox' && field.type !== 'consent' && field.type !== 'hidden' && field.type !== 'topics'}
					<div class="fake-input">{field.placeholder || info.label}</div>
				{/if}
				<p class="meta">
					<span class="tag-type"><Icon name={typeIcon} size={16} /> {info.label}</span>
					{#if info.mapping}<span class="maps-to">→ {mapSummary(field.map)}</span>{/if}
				</p>
			{/if}
			{#if problems.length}
				<ul class="problems" role="alert">{#each problems as p, i (i)}<li>{p}</li>{/each}</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.fcard {
		position: relative;
		background: var(--surface);
		border-radius: var(--radius-lg);
		box-shadow: var(--border-shadow-s);
		padding: var(--space-m) var(--space-m) var(--space-m) calc(var(--space-m) + 12px);
		cursor: pointer;
		transition: box-shadow 150ms ease;
	}
	/* #590: no accent bars. Hover = a slightly stronger hairline; selected = an accent hairline
	   + a soft lift; a problem = a danger hairline (the problem list says what is wrong). All
	   drawn with box-shadow, so selecting a card never shifts the layout. */
	.fcard:not(.focused):not(.bad):hover { box-shadow: 0 0 0 var(--border-s) var(--neutral-5); }
	.fcard.focused { cursor: default; box-shadow: 0 0 0 var(--border-s) var(--btn-primary-bg), var(--shadow-m); }
	.fcard.bad { box-shadow: 0 0 0 var(--border-s) var(--danger); }
	.fcard.bad.focused { box-shadow: 0 0 0 var(--border-s) var(--danger), var(--shadow-m); }
	@media (prefers-reduced-motion: reduce) { .fcard { transition: none; } }
	.fcard.break { background: var(--surface-subtle); }
	.handle { position: absolute; left: 4px; top: var(--space-m); color: var(--muted); cursor: grab; padding: 2px; }
	.break-head { margin-bottom: var(--space-xs); }
	.pill { display: inline-block; font-size: var(--size-xs); line-height: var(--line-xs); padding: 0 var(--space-xs); border-radius: var(--radius-full); background: var(--btn-primary-bg); color: var(--btn-primary-text); }
	.edit { display: flex; flex-direction: column; gap: var(--space-s); }
	.row { display: flex; gap: var(--space-s); align-items: flex-start; flex-wrap: wrap; }
	.grow { flex: 1 1 260px; min-width: 0; }
	.grow input, .grow textarea { width: 100%; }
	.q-input { font-size: var(--size-m); }
	.type { display: flex; align-items: center; gap: var(--space-xxs); flex: 0 0 auto; }
	.type-icon { color: var(--muted); display: inline-flex; }
	.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.opts, .preview-opts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xxs); }
	.opts li { display: flex; align-items: center; gap: var(--space-xs); }
	.opts input { flex: 1; min-width: 0; }
	.preview-opts li { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); }
	.bullet { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 var(--border-l) var(--border); flex: none; font-size: var(--size-xs); line-height: 14px; text-align: center; }
	.bullet.square { border-radius: 3px; }
	.bullet:not(:empty) { box-shadow: none; width: auto; }
	.link-btn { background: none; border: 0; padding: var(--space-xxs) 0 var(--space-xxs) 22px; color: var(--muted); cursor: pointer; font-size: var(--size-s); text-decoration: underline; text-decoration-color: var(--accent); }
	.sub { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.sub code { font-size: var(--size-xs); }
	.maps { display: flex; flex-wrap: wrap; gap: var(--space-s); }
	.maps .sub { flex: 1 1 200px; }
	.note { margin: 0; font-size: var(--size-s); }
	.foot { display: flex; align-items: center; gap: var(--space-xxs); padding-top: var(--space-s); box-shadow: inset 0 var(--border-s) 0 var(--border-muted); }
	.spacer { flex: 1; }
	.req { display: flex; align-items: center; gap: var(--space-xxs); font-size: var(--size-s); margin-left: var(--space-s); padding-left: var(--space-s); box-shadow: inset var(--border-s) 0 0 var(--border-muted); }
	.icon-btn { background: none; border: 0; padding: var(--space-xxs); color: var(--muted); cursor: pointer; border-radius: var(--radius-xs); display: inline-flex; min-height: 0; }
	.icon-btn:hover:not(:disabled) { color: var(--text); background: var(--surface-subtle); }
	.icon-btn:disabled { opacity: 0.35; cursor: default; }
	.rest .q { margin: 0; font-weight: var(--weight-ui-medium); }
	.rest .q.h { font-size: var(--size-m); }
	.rest .para { margin: 0; color: var(--muted); white-space: pre-wrap; font-size: var(--size-s); }
	.rest .help { margin: var(--space-xxs) 0 0; font-size: var(--size-s); }
	.preview-opts { margin-top: var(--space-xs); }
	.fake-input { margin-top: var(--space-xs); color: var(--muted); font-size: var(--size-s); padding-bottom: var(--space-xxs); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); max-width: 60%; }
	.meta { margin: var(--space-s) 0 0; display: flex; flex-wrap: wrap; gap: var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); color: var(--muted); }
	.tag-type { display: inline-flex; align-items: center; gap: var(--space-xxs); }
	.star { color: var(--danger); }
	/* Rating (#589): style picker + preview. Glyph SVGs come from ratingGlyph (stroke = currentColor). */
	.rt-styles { border: 0; margin: 0; padding: 0; min-width: 0; }
	.sub-legend { padding: 0; margin-bottom: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); }
	.rt-style-row { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
	.rt-style { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xxs); padding: var(--space-xs) var(--space-s); border-radius: var(--radius); box-shadow: inset 0 0 0 var(--border-s) var(--border); font-size: var(--size-s); cursor: pointer; min-height: 44px; position: relative; }
	.rt-style.on { box-shadow: inset 0 0 0 2px var(--btn-primary-bg); }
	.rt-style input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
	.rt-style:has(input:focus-visible) { outline: 2px solid var(--btn-primary-bg); outline-offset: 2px; }
	.rt-preview { margin-top: var(--space-xs); display: inline-flex; flex-direction: column; gap: var(--space-xxs); max-width: 100%; }
	.rt-sample { display: inline-flex; flex-wrap: wrap; gap: 2px; color: var(--muted); }
	.rt-glyph-s { display: inline-flex; }
	.rt-glyph-s :global(svg) { fill: transparent; }
	.rt-glyph-s :global(.rt-eye) { fill: currentColor; stroke: none; }
	.rt-glyph-s :global(.rt-mouth) { fill: none; }
	.rt-glyph-s.on { color: var(--btn-primary-bg); }
	.rt-glyph-s.on :global(svg) { fill: currentColor; }
	.rt-glyph-s.on :global(svg circle:first-child) { fill: transparent; }
	.rt-num-s { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 4px; border-radius: var(--radius-xs); box-shadow: inset 0 0 0 var(--border-s) var(--border); font-size: var(--size-xs); color: var(--text); }
	.rt-num-s.on { background: var(--btn-primary-bg); color: var(--btn-primary-text); box-shadow: none; }
	.rt-ends-s { display: flex; justify-content: space-between; gap: var(--space-s); font-size: var(--size-xs); color: var(--muted); }
	.problems { margin: var(--space-xs) 0 0; padding-left: var(--space-m); color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); }
</style>

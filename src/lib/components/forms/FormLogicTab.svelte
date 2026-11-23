<script lang="ts">
	// #514: the builder's Logic tab. Three sections:
	//   Show a question only when…  each item's `show_when` (rules read questions before it)
	//   Page jumps                  each page's ordered `next` rules → a later page or Submit
	//   After submit                the conditional outcomes (`when` + actions), drag / ↑↓ to
	//                               reorder, all-matches vs first-match; the unconditional one
	//                               stays on the Settings tab
	import Icon from '$lib/components/Icon.svelte';
	import FormRuleEditor from '$lib/components/forms/FormRuleEditor.svelte';
	import CustomFieldPicker from '$lib/components/forms/CustomFieldPicker.svelte';
	import { NO_VALUE, YES_VALUE, type FieldOption } from '$lib/custom-fields';
	import {
		ACTION_LABELS,
		ACTION_TYPES,
		FORM_LIMITS,
		isAnswerType,
		newId,
		pageLabel,
		pagesOf,
		settingsOutcome,
		type FormAction,
		type FormOutcome,
		type FormSpec,
		type PageJump,
		type SpecProblem
	} from '$lib/forms';
	import { JUMP_END } from '$lib/form-logic';

	let {
		spec = $bindable(),
		readonly = false,
		problems = [],
		lists = [],
		topics = [],
		users = [],
		tags = [],
		automations = [],
		customFields = [],
		onfieldcreated = () => {}
	}: {
		spec: FormSpec;
		readonly?: boolean;
		problems?: SpecProblem[];
		lists?: { id: number; name: string }[];
		topics?: { id: number; label: string }[];
		users?: { id: number; login: string; email: string | null }[];
		tags?: string[];
		/** Active automations (enroll_automation). */
		automations?: { id: number; name: string }[];
		customFields?: FieldOption[];
		onfieldcreated?: (f: FieldOption) => void;
	} = $props();

	// --- Show when
	const answerFields = $derived(spec.fields.filter((f) => isAnswerType(f.type)));
	const before = (i: number) => spec.fields.slice(0, i).filter((f) => isAnswerType(f.type) && f.key);

	// --- Page jumps (pages derived from the page breaks; `next` kept by page id)
	const pages = $derived(pagesOf(spec.fields, spec.title, spec.pages));
	const pageStart = $derived.by(() => {
		const starts = [0];
		spec.fields.forEach((f, i) => {
			if (f.type === 'page_break') starts.push(i);
		});
		return starts;
	});
	/** Questions a jump after page `pi` may read: on that page or earlier. */
	function upToPage(pi: number) {
		const end = pageStart[pi + 1] ?? spec.fields.length;
		return spec.fields.slice(0, end).filter((f) => isAnswerType(f.type) && f.key);
	}
	function setJumps(pi: number, next: PageJump[]) {
		const id = pages[pi].id;
		spec.pages = pagesOf(spec.fields, spec.title, spec.pages).map((p) => {
			if (p.id !== id) return p;
			return next.length ? { id: p.id, title: p.title, next } : { id: p.id, title: p.title };
		});
	}
	function addJump(pi: number) {
		const later = pages[pi + 1]?.id ?? JUMP_END;
		setJumps(pi, [...(pages[pi].next ?? []), { when: null, goto: later }]);
	}
	function editJump(pi: number, j: number, patch: Partial<PageJump>) {
		setJumps(pi, (pages[pi].next ?? []).map((x, k) => (k === j ? { ...x, ...patch } : x)));
	}
	function moveJump(pi: number, j: number, dir: -1 | 1) {
		const list = [...(pages[pi].next ?? [])];
		const k = j + dir;
		if (k < 0 || k >= list.length) return;
		[list[j], list[k]] = [list[k], list[j]];
		setJumps(pi, list);
	}

	// --- After submit
	const defaultOutcome = $derived(settingsOutcome(spec));
	const conditional = $derived(spec.outcomes.filter((o) => o !== defaultOutcome && !(o.id === 'default' && o.when === null)));
	function setConditional(next: FormOutcome[]) {
		const head = spec.outcomes.filter((o) => !conditional.includes(o));
		spec.outcomes = [...head, ...next];
	}
	function addOutcome() {
		setConditional([...conditional, { id: newId('o'), when: null, actions: [{ type: 'add_tag', tag: '' }] }]);
	}
	function editOutcome(i: number, patch: Partial<FormOutcome>) {
		setConditional(conditional.map((o, j) => (j === i ? { ...o, ...patch } : o)));
	}
	function moveOutcome(i: number, to: number) {
		if (to < 0 || to >= conditional.length || to === i) return;
		const next = [...conditional];
		const [o] = next.splice(i, 1);
		next.splice(to, 0, o);
		setConditional(next);
	}
	let dragOutcome = $state<number | null>(null);

	function blankAction(type: FormAction['type']): FormAction {
		switch (type) {
			case 'add_tag':
			case 'remove_tag':
				return { type, tag: '' };
			case 'add_to_list':
				return { type, list_id: lists[0]?.id ?? 0 };
			case 'add_topic':
				return { type, list_id: topics[0]?.id ?? 0 };
			case 'set_field':
				return { type, key: customFields[0]?.key ?? '', value: '' };
			case 'set_source':
				return { type, source: 'form' };
			case 'enroll_automation':
				return { type, automation_id: automations[0]?.id ?? 0 };
			case 'notify':
				return { type, user_ids: [] };
			case 'message_md':
				return { type, md: '' };
			case 'redirect':
				return { type, url: 'https://' };
		}
	}
	function setActions(i: number, actions: FormAction[]) {
		editOutcome(i, { actions });
	}
	function editAction(i: number, j: number, a: FormAction) {
		setActions(i, conditional[i].actions.map((x, k) => (k === j ? a : x)));
	}
	const offered = $derived(ACTION_TYPES.filter((t) => t !== 'enroll_automation' || spec.settings.enroll));
	const fieldOf = (key: string) => customFields.find((f) => f.key === key);

	const at = (prefix: string) => problems.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}.`) || p.path.startsWith(`${prefix}[`));
	const outcomeIndex = (o: FormOutcome) => spec.outcomes.indexOf(o);
	const showWhenCount = $derived(spec.fields.filter((f) => f.show_when).length);
</script>

<div class="logic">
	<section class="group" aria-labelledby="lg-show">
		<h3 id="lg-show">Show a question only when…</h3>
		<p class="muted small">A question with conditions appears only when they hold. A condition can read questions that come before it. {showWhenCount ? `${showWhenCount} item${showWhenCount === 1 ? ' has' : 's have'} conditions.` : ''}</p>
		{#each spec.fields as f, i (f.id)}
			{#if f.type !== 'page_break' && i > 0}
				{@const cands = before(i)}
				{#if cands.length || f.show_when}
					<div class="item" class:on={!!f.show_when}>
						<div class="item-head">
							<span class="q">{f.label.trim() || f.key || 'Untitled'}</span>
							{#if !f.show_when}<span class="muted small">Always shown</span>{/if}
						</div>
						<FormRuleEditor
							bind:value={spec.fields[i].show_when}
							candidates={cands}
							{readonly}
							{problems}
							path="fields[{i}].show_when"
							label="Show “{f.label || f.key}” when"
						/>
					</div>
				{/if}
			{/if}
		{/each}
		{#if answerFields.length < 2}<p class="muted small">Add more questions to make one depend on another.</p>{/if}
	</section>

	<section class="group" aria-labelledby="lg-jumps">
		<h3 id="lg-jumps">Page jumps</h3>
		{#if pages.length < 2}
			<p class="muted small">Add a page break on the Questions tab to send people to different pages.</p>
		{:else}
			<p class="muted small">After a page, the first jump whose conditions hold decides where to go. None hold: the next page. A jump only goes forward; skipped pages’ answers are ignored.</p>
			{#each pages as p, pi (p.id)}
				{#if pi < pages.length - 1}
					{@const jumps = p.next ?? []}
					<div class="item" class:on={jumps.length > 0}>
						<div class="item-head"><span class="q">After {pageLabel(pages, p.id)}</span></div>
						{#each jumps as jmp, j (j)}
							<div class="jump">
								<label class="goto">Go to
									<select value={jmp.goto} disabled={readonly} onchange={(e) => editJump(pi, j, { goto: e.currentTarget.value })}>
										{#each pages.slice(pi + 1) as t (t.id)}<option value={t.id}>{pageLabel(pages, t.id)}</option>{/each}
										<option value={JUMP_END}>Submit (end of form)</option>
										{#if jmp.goto !== JUMP_END && !pages.slice(pi + 1).some((t) => t.id === jmp.goto)}<option value={jmp.goto}>(page removed or earlier)</option>{/if}
									</select>
								</label>
								<span class="muted small">when</span>
								{#if !readonly}
									<span class="tools">
										<button type="button" class="secondary small" aria-label="Move jump up" disabled={j === 0} onclick={() => moveJump(pi, j, -1)}><Icon name="arrow-up" size={16} /></button>
										<button type="button" class="secondary small" aria-label="Move jump down" disabled={j === jumps.length - 1} onclick={() => moveJump(pi, j, 1)}><Icon name="arrow-down" size={16} /></button>
										<button type="button" class="secondary small" onclick={() => setJumps(pi, jumps.filter((_, k) => k !== j))}>Remove jump</button>
									</span>
								{/if}
								<FormRuleEditor
									value={jmp.when}
									onchange={(w) => editJump(pi, j, { when: w })}
									candidates={upToPage(pi)}
									{readonly}
									{problems}
									path="pages[{pi}].next[{j}].when"
									label="Jump conditions"
								/>
								{#if !jmp.when}<p class="muted small">No conditions: always taken.</p>{/if}
								{#each at(`pages[${pi}].next[${j}].goto`) as m, k (k)}<p class="err">{m.message}</p>{/each}
							</div>
						{/each}
						{#each problems.filter((x) => x.path === `pages[${pi}].next`) as m, k (k)}<p class="err">{m.message}</p>{/each}
						{#if !readonly}
							<button type="button" class="secondary small add" disabled={jumps.length >= FORM_LIMITS.jumps} onclick={() => addJump(pi)}>Add a jump</button>
						{/if}
						<p class="muted small">Otherwise: {pageLabel(pages, pages[pi + 1].id)}</p>
					</div>
				{/if}
			{/each}
		{/if}
	</section>

	<section class="group" aria-labelledby="lg-after">
		<h3 id="lg-after">After submit</h3>
		<p class="muted small">What every submission does is set on the Settings tab. These rules add more when their conditions hold — they can also read what we already know about the person (their tags, lists and fields) when their email matches a contact. The first matching rule with a message or web address decides what people see.</p>
		<div class="radios" role="radiogroup" aria-label="Which rules run">
			<label class="tick"><input type="radio" name="outcomes_mode" disabled={readonly} checked={spec.settings.outcomes_mode !== 'first'} onchange={() => (spec.settings.outcomes_mode = 'all')} /> Run every rule that matches</label>
			<label class="tick"><input type="radio" name="outcomes_mode" disabled={readonly} checked={spec.settings.outcomes_mode === 'first'} onchange={() => (spec.settings.outcomes_mode = 'first')} /> Run only the first rule that matches</label>
		</div>
		{#each conditional as o, i (o.id)}
			{@const oi = outcomeIndex(o)}
			<div
				class="item on outcome"
				role="listitem"
				draggable={!readonly}
				ondragstart={() => (dragOutcome = i)}
				ondragend={() => (dragOutcome = null)}
				ondragover={(e) => {
					if (dragOutcome !== null) e.preventDefault();
				}}
				ondrop={(e) => {
					e.preventDefault();
					if (dragOutcome !== null) moveOutcome(dragOutcome, i);
					dragOutcome = null;
				}}
			>
				<div class="item-head">
					<span class="q"><Icon name="drag-handle" size={16} /> Rule {i + 1}</span>
					{#if !readonly}
						<span class="tools">
							<button type="button" class="secondary small" aria-label="Move rule {i + 1} up" disabled={i === 0} onclick={() => moveOutcome(i, i - 1)}><Icon name="arrow-up" size={16} /></button>
							<button type="button" class="secondary small" aria-label="Move rule {i + 1} down" disabled={i === conditional.length - 1} onclick={() => moveOutcome(i, i + 1)}><Icon name="arrow-down" size={16} /></button>
							<button type="button" class="secondary small" onclick={() => setConditional(conditional.filter((_, j) => j !== i))}>Delete rule</button>
						</span>
					{/if}
				</div>
				<span class="lbl">When</span>
				<FormRuleEditor
					value={o.when}
					onchange={(w) => editOutcome(i, { when: w })}
					candidates={answerFields}
					contact
					{tags}
					{lists}
					{customFields}
					{readonly}
					{problems}
					path="outcomes[{oi}].when"
					label="Rule {i + 1} conditions"
				/>
				{#if !o.when}<p class="muted small">No conditions: runs on every submission.</p>{/if}
				<span class="lbl">Then</span>
				<div class="actions">
					{#each o.actions as a, j (j)}
						<div class="act">
							<span class="act-type">{ACTION_LABELS[a.type]}</span>
							{#if a.type === 'add_tag' || a.type === 'remove_tag'}
								<label><span class="sr">Tag</span><input value={a.tag} disabled={readonly} maxlength="60" list="lg-tags" placeholder="Tag name" oninput={(e) => editAction(i, j, { type: a.type, tag: e.currentTarget.value })} /></label>
							{:else if a.type === 'add_to_list'}
								<label><span class="sr">List</span>
									<select value={String(a.list_id)} disabled={readonly} onchange={(e) => editAction(i, j, { type: 'add_to_list', list_id: Number(e.currentTarget.value) })}>
										{#each lists as l (l.id)}<option value={String(l.id)}>{l.name}</option>{/each}
									</select>
								</label>
							{:else if a.type === 'add_topic'}
								<label><span class="sr">Topic</span>
									<select value={String(a.list_id)} disabled={readonly} onchange={(e) => editAction(i, j, { type: 'add_topic', list_id: Number(e.currentTarget.value) })}>
										{#each topics as t (t.id)}<option value={String(t.id)}>{t.label}</option>{/each}
									</select>
								</label>
							{:else if a.type === 'set_field'}
								{@const fd = fieldOf(a.key)}
								<CustomFieldPicker value={a.key} fields={customFields} label="Field" canCreate={!readonly} onpick={(key) => editAction(i, j, { ...a, key })} oncreated={onfieldcreated} />
								<label>Value
									{#if fd?.type === 'choice' || fd?.type === 'yes_no'}
										<select value={a.value} disabled={readonly} onchange={(e) => editAction(i, j, { ...a, value: e.currentTarget.value })}>
											<option value="">Choose…</option>
											{#if fd.type === 'yes_no'}<option value={YES_VALUE}>Yes</option><option value={NO_VALUE}>No</option>{:else}{#each fd.options as op (op)}<option value={op}>{op}</option>{/each}{/if}
										</select>
									{:else}
										<input type={fd?.type === 'number' ? 'number' : fd?.type === 'date' ? 'date' : 'text'} value={a.value} disabled={readonly} maxlength={FORM_LIMITS.shortAnswer} oninput={(e) => editAction(i, j, { ...a, value: e.currentTarget.value })} />
									{/if}
								</label>
							{:else if a.type === 'set_source'}
								<label><span class="sr">Source</span><input value={a.source} disabled={readonly} maxlength="60" oninput={(e) => editAction(i, j, { type: 'set_source', source: e.currentTarget.value })} /></label>
							{:else if a.type === 'enroll_automation'}
								{#if spec.settings.enroll}
									<label><span class="sr">Automation</span>
										<select value={String(a.automation_id)} disabled={readonly} onchange={(e) => editAction(i, j, { type: 'enroll_automation', automation_id: Number(e.currentTarget.value) })}>
											{#if !automations.some((x) => x.id === a.automation_id)}<option value={String(a.automation_id)}>{a.automation_id ? `Automation #${a.automation_id} (not active)` : 'Choose…'}</option>{/if}
											{#each automations as au (au.id)}<option value={String(au.id)}>{au.name}</option>{/each}
										</select>
									</label>
								{:else}
									<span class="muted small">Skipped: turn on “Enrol in automations” on the Settings tab.</span>
								{/if}
							{:else if a.type === 'notify'}
								<span class="users" role="group" aria-label="Notify">
									{#each users as u (u.id)}
										<label class="tick"><input type="checkbox" disabled={readonly || !u.email} checked={a.user_ids.includes(u.id)} onchange={(e) => editAction(i, j, { type: 'notify', user_ids: e.currentTarget.checked ? [...a.user_ids.filter((x) => x !== u.id), u.id] : a.user_ids.filter((x) => x !== u.id) })} /> @{u.login}</label>
									{/each}
								</span>
							{:else if a.type === 'message_md'}
								<label class="grow"><span class="sr">Message (Markdown)</span><textarea rows="3" value={a.md} disabled={readonly} maxlength="5000" placeholder="Message (Markdown)" oninput={(e) => editAction(i, j, { type: 'message_md', md: e.currentTarget.value })}></textarea></label>
							{:else if a.type === 'redirect'}
								<label class="grow"><span class="sr">Web address</span><input type="url" value={a.url} disabled={readonly} placeholder="https://example.com/thanks" oninput={(e) => editAction(i, j, { type: 'redirect', url: e.currentTarget.value })} /></label>
							{/if}
							{#if !readonly}<button type="button" class="secondary small" aria-label="Remove action" onclick={() => setActions(i, o.actions.filter((_, k) => k !== j))}>Remove</button>{/if}
						</div>
						{#each at(`outcomes[${oi}].actions[${j}]`) as m, k (k)}<p class="err">{m.message}</p>{/each}
					{/each}
					{#each problems.filter((x) => x.path === `outcomes[${oi}].actions`) as m, k (k)}<p class="err">{m.message}</p>{/each}
					{#if !readonly}
						<label class="add-act">Add an action
							<select value="" disabled={o.actions.length >= FORM_LIMITS.actions} onchange={(e) => {
								const t = e.currentTarget.value as FormAction['type'];
								e.currentTarget.value = '';
								if (t) setActions(i, [...o.actions, blankAction(t)]);
							}}>
								<option value="">Choose…</option>
								{#each offered as t (t)}<option value={t}>{ACTION_LABELS[t]}</option>{/each}
							</select>
						</label>
					{/if}
				</div>
			</div>
		{/each}
		{#each problems.filter((x) => x.path === 'outcomes') as m, k (k)}<p class="err">{m.message}</p>{/each}
		{#if !readonly}
			<button type="button" class="secondary add" disabled={spec.outcomes.length >= FORM_LIMITS.outcomes} onclick={addOutcome}><Icon name="add" size={16} /> Add a rule</button>
		{/if}
		<datalist id="lg-tags">{#each tags as t (t)}<option value={t}></option>{/each}</datalist>
	</section>
</div>

<style>
	.logic { display: flex; flex-direction: column; gap: var(--space-l); max-width: 720px; min-width: 0; }
	.group { display: flex; flex-direction: column; gap: var(--space-s); }
	h3 { margin: 0; font-size: var(--size-s); line-height: var(--line-s); font-weight: var(--weight-ui-medium); }
	.item { background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--border-shadow-s); padding: var(--space-s) var(--space-m); display: flex; flex-direction: column; gap: var(--space-xs); }
	/* #669: no left accent bar (#590). A card with conditions gets the builder's accent hairline instead. */
	.item.on { box-shadow: 0 0 0 var(--border-s) var(--btn-primary-bg); }
	.item-head { display: flex; align-items: center; gap: var(--space-s); justify-content: space-between; flex-wrap: wrap; }
	.q { font-size: var(--size-s); font-weight: var(--weight-ui-medium); display: inline-flex; align-items: center; gap: var(--space-xxs); }
	.tools { display: inline-flex; gap: var(--space-xxs); flex-wrap: wrap; }
	.tools button { display: inline-flex; align-items: center; }
	.jump { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-xs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted); }
	.goto { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); }
	.outcome[draggable='true'] .item-head .q { cursor: grab; }
	.lbl { font-size: var(--size-xs); line-height: var(--line-xs); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
	.actions { display: flex; flex-direction: column; gap: var(--space-xs); }
	.act { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
	.act label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); flex: 1 1 160px; min-width: 0; }
	.act label.tick { flex-direction: row; flex: none; align-items: center; }
	.act-type { font-size: var(--size-s); min-width: 14ch; }
	.grow { flex: 1 1 260px; }
	.users { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-s); }
	.add-act { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); }
	.radios { display: flex; gap: var(--space-m); flex-wrap: wrap; }
	label.tick { display: flex; flex-direction: row; align-items: center; gap: var(--space-xs); font-size: var(--size-s); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); margin: 0; }
	.add { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--space-xxs); }
	.err { color: var(--danger); font-size: var(--size-s); margin: 0; }
	.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

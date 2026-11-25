<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick, untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { ContactsFilter } from '$lib/server/contacts-query';
	import { conditionLabel, encodeCondition, groupMetrics, opsFor, visibleMetrics } from '$lib/company-metrics';
	import { TIERS, TIER_LABELS } from '$lib/engagement-view';
	import { HYGIENE_FILTERS, HYGIENE_FILTER_LABELS } from '$lib/email-hygiene';
	import { FILTER_SECTIONS, fieldMatches, sectionActiveCounts, type FilterSectionKey } from '$lib/contact-filter-sections';

	// The /contacts Filters panel (#94 and later), shared with a dynamic segment's member
	// table on /lists/[id] (#224). Applies by navigating to a clean query string (no empty or
	// default params, page reset); `keep` carries the page's own params (sort/dir/per, and q
	// when the search lives outside the panel). `search` puts the name/email search inside.
	// #583: grouped sections (one open at a time, a count of active filters on each heading), a
	// "Find a filter" box, and a full-width sheet on phones. `toolbar` = status and "In group"
	// live in the page's toolbar (pills + group picker), so the panel leaves them out — the page
	// must carry them in `keep`.
	type Opt = { id: number; name: string };
	let {
		filter,
		filtered,
		groupOptions,
		companyPicker,
		stagePicker,
		topicPicker = [],
		scorePicker = [],
		formPicker = [],
		keep = {},
		clearHref,
		search = false,
		toolbar = false,
		campaignLabel = '',
		billing = false,
		onApply
	}: {
		filter: ContactsFilter;
		filtered: boolean;
		groupOptions: { lists: Opt[]; segments: Opt[]; tags: Opt[]; companies: Opt[] };
		companyPicker: Opt[];
		stagePicker: Opt[];
		topicPicker?: { id: number; label: string }[]; // #448: "Opted out of topic"
		scorePicker?: { id: number; name: string; bands: string[] }[]; // #467: score value / band
		formPicker?: Opt[]; // #516: Submitted form
		keep?: Record<string, string>;
		clearHref: string;
		search?: boolean;
		toolbar?: boolean;
		campaignLabel?: string; // #279: the active campaign-segment filter, kept as a checkbox
		/** #445: the viewer may see billing (`canSeeBilling`) — offers the Billing metric group. */
		billing?: boolean;
		onApply?: () => void;
	} = $props();

	let open = $state(false);
	let el = $state<HTMLDetailsElement | null>(null);
	let summaryEl = $state<HTMLElement | null>(null);
	let findEl = $state<HTMLInputElement | null>(null);
	function onWindowClick(e: MouseEvent) {
		if (open && el && !el.contains(e.target as Node)) open = false;
	}
	function close() {
		open = false;
		summaryEl?.focus();
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) close();
	}

	// Section state: active counts per heading; the first section with an active filter starts open.
	const counts = $derived(sectionActiveCounts(filter, { toolbar }));
	let openSec = $state<FilterSectionKey | null>(
		untrack(() => FILTER_SECTIONS.find((s) => sectionActiveCounts(filter, { toolbar })[s.key] > 0)?.key ?? null)
	);
	function toggleSec(key: FilterSectionKey) {
		openSec = openSec === key ? null : key;
	}
	// "Find a filter": narrows every section to the matching controls (and opens those sections).
	let find = $state('');
	const finding = $derived(find.trim() !== '');
	const m = (field: string) => fieldMatches(field, find);
	const secMatches = (key: FilterSectionKey) => FILTER_SECTIONS.find((s) => s.key === key)!.fields.some((f) => m(f));
	const secShown = (key: FilterSectionKey) => (finding ? secMatches(key) : true);
	const secOpen = (key: FilterSectionKey) => (finding ? secMatches(key) : openSec === key);
	const noMatches = $derived(finding && !FILTER_SECTIONS.some((s) => s.fields.some((f) => fieldMatches(f, find))));

	async function onToggle() {
		if (open) {
			find = '';
			await tick();
			// Desktop: straight into "Find a filter". Phones: no auto-focus (it would pop the keyboard).
			if (window.matchMedia('(min-width: 641px)').matches) findEl?.focus();
		}
	}

	// #170: company metric conditions — kept rows (checkboxes) + one new row, sent as `cm`.
	let cmMetric = $state('');
	let cmOps = $derived(opsFor(cmMetric));
	const metricChips = $derived(filter.metrics.map((mc) => ({ code: encodeCondition(mc), label: conditionLabel(mc, { billing }) })));
	// #445: the billing group only for viewers who may see billing.
	const metricGroups = $derived(groupMetrics(visibleMetrics(billing)));

	// #467: score value (`score=<id>:<op>:<n>[:<n2>]`) — posted as sc_* fields, joined in apply().
	let scId = $state<string>(untrack(() => (filter.score ? String(filter.score.scoreId) : '')));
	let scOp = $state<string>(untrack(() => filter.score?.op ?? 'gte'));
	const SCORE_OPS: [string, string][] = [['gte', '≥'], ['gt', '>'], ['lte', '≤'], ['lt', '<'], ['eq', '='], ['between', 'between']];

	const GROUP_SECTIONS = [
		['lists', 'Lists'],
		['segments', 'Segments'],
		['tags', 'Tags'],
		['companies', 'Companies']
	] as const;

	function apply(e: SubmitEvent) {
		e.preventDefault();
		const fd = new FormData(e.currentTarget as HTMLFormElement);
		const p = new URLSearchParams();
		const cms: string[] = [];
		for (const [k, v] of fd) {
			const s = String(v).trim();
			if (!s) continue;
			if (k === 'cm_keep') {
				cms.push(s);
				continue;
			}
			if (k === 'cm_metric' || k === 'cm_op' || k === 'cm_value') continue;
			if (k === 'sc_id' || k === 'sc_op' || k === 'sc_n' || k === 'sc_n2') continue;
			if (k === 'find') continue;
			if (k === 'status' && s === 'all') continue;
			if (k === 'site' && s === 'all') continue;
			p.set(k, s);
		}
		const newValue = String(fd.get('cm_value') ?? '').trim();
		if (cmMetric && newValue !== '') cms.push(`${cmMetric}:${String(fd.get('cm_op') ?? '')}:${newValue}`);
		if (cms.length) p.set('cm', cms.join(','));
		const scN = String(fd.get('sc_n') ?? '').trim();
		const scN2 = String(fd.get('sc_n2') ?? '').trim();
		if (scId && scN !== '' && (scOp !== 'between' || scN2 !== '')) p.set('score', [scId, scOp, scN, ...(scOp === 'between' ? [scN2] : [])].join(':'));
		for (const [k, v] of Object.entries(keep)) if (v && !p.has(k)) p.set(k, v);
		open = false;
		onApply?.();
		goto(`?${p}`, { reset: false });
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

{#snippet head(key: FilterSectionKey, title: string)}
	<button
		type="button"
		class="sec-head"
		aria-expanded={secOpen(key)}
		aria-controls="cf-sec-{key}"
		onclick={() => toggleSec(key)}
		disabled={finding}
	>
		<Icon name={secOpen(key) ? 'chevron-down' : 'chevron-right'} size={16} />
		<span class="sec-title">{title}</span>
		{#if counts[key]}<span class="sec-count" aria-label="{counts[key]} active">{counts[key]}</span>{/if}
	</button>
{/snippet}

<details class="menu" bind:this={el} bind:open ontoggle={onToggle}>
	<summary class:on={filtered} bind:this={summaryEl}>Filters{#if filtered}<span class="dot"></span>{/if}</summary>
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="sheet-backdrop" onclick={close}></div>
	<form class="filters" method="GET" onsubmit={apply} aria-label="Filters">
		<div class="sheet-head">
			<span class="sheet-title">Filters</span>
			<button type="button" class="sheet-close" aria-label="Close filters" onclick={close}><Icon name="close" size={20} /></button>
		</div>
		{#if search}
			<label class="find">
				Search <span class="muted">name, email or company</span>
				<input name="q" value={filter.q} placeholder="jane, @gmail.com…" />
			</label>
		{/if}
		<label class="find">
			<span class="sr-only">Find a filter</span>
			<input
				type="search"
				name="find"
				bind:this={findEl}
				bind:value={find}
				placeholder="Find a filter"
				autocomplete="off"
				spellcheck="false"
			/>
		</label>
		{#if noMatches}<p class="muted no-match">No filter matches “{find}”.</p>{/if}

		<div class="secs">
			<!-- People -->
			<section class="sec" hidden={!secShown('people')}>
				{@render head('people', 'People')}
				<div class="sec-body" id="cf-sec-people" hidden={!secOpen('people')}>
					{#if !toolbar}
						<label hidden={!m('status')}>
							Status
							<select name="status">
								<!-- #705: outside /contacts (a segment's members) only the active audience is
								     shown, so there is no Unsubscribed choice here. -->
								<option value="" selected={filter.status === 'active' || filter.status === 'all' || filter.status === 'unsubscribed'}>Any (subscribed or pending)</option>
								<option value="subscribed" selected={filter.status === 'subscribed'}>Subscribed</option>
								<option value="pending" selected={filter.status === 'pending'}>Pending confirmation</option>
							</select>
						</label>
						<label hidden={!m('in')}>
							In group
							<select name="in">
								<option value="" selected={!filter.inGroup}>— any —</option>
								{#each GROUP_SECTIONS as [key, title] (key)}
									{#if groupOptions[key].length}
										<optgroup label={title}>
											{#each groupOptions[key] as g (g.id)}
												<option value={g.id} selected={filter.inGroup === g.id}>{g.name}</option>
											{/each}
										</optgroup>
									{/if}
								{/each}
							</select>
						</label>
					{/if}
					<label hidden={!m('notin')}>
						Not in group
						<select name="notin">
							<option value="" selected={!filter.notInGroup}>— any —</option>
							{#each GROUP_SECTIONS as [key, title] (key)}
								{#if groupOptions[key].length}
									<optgroup label={title}>
										{#each groupOptions[key] as g (g.id)}
											<option value={g.id} selected={filter.notInGroup === g.id}>{g.name}</option>
										{/each}
									</optgroup>
								{/if}
							{/each}
						</select>
					</label>
					<label hidden={!m('source')}>
						Source contains
						<input name="source" value={filter.source} placeholder="e.g. .csv, manual" />
					</label>
					<label hidden={!m('added_from')}>
						Added from
						<input type="date" name="added_from" value={filter.addedFrom} />
					</label>
					<label hidden={!m('added_to')}>
						Added to
						<input type="date" name="added_to" value={filter.addedTo} />
					</label>
					<label hidden={!m('created_days')}>
						Created within N days
						<input type="number" name="created_days" min="1" max="3650" value={filter.createdDays ?? ''} placeholder="any time" />
					</label>
					<label hidden={!m('form')}>
						Submitted form
						<select name="form">
							<option value="" selected={!filter.form}>— no filter —</option>
							<option value="any" selected={filter.form === 'any'}>Any form</option>
							{#each formPicker as fo (fo.id)}
								<option value={fo.id} selected={filter.form === fo.id}>{fo.name}</option>
							{/each}
						</select>
					</label>
					<label hidden={!m('form_days')}>
						Submitted in the last N days
						<input type="number" name="form_days" min="1" max="3650" value={filter.formDays ?? ''} placeholder="any time" />
					</label>
					<label hidden={!m('company')}>
						Company contains
						<input name="company" value={filter.company} placeholder="e.g. Acme" />
					</label>
					<label hidden={!m('company_id')}>
						Company is
						<select name="company_id">
							<option value="" selected={!filter.companyId}>— any —</option>
							{#each companyPicker as co (co.id)}
								<option value={co.id} selected={filter.companyId === co.id}>{co.name}</option>
							{/each}
						</select>
					</label>
					<label hidden={!m('has_company')}>
						Has a company
						<select name="has_company">
							<option value="" selected={!filter.hasCompany}>— any —</option>
							<option value="yes" selected={filter.hasCompany === 'yes'}>Yes</option>
							<option value="no" selected={filter.hasCompany === 'no'}>No</option>
						</select>
					</label>
				</div>
			</section>

			<!-- Engagement -->
			<section class="sec" hidden={!secShown('engagement')}>
				{@render head('engagement', 'Engagement')}
				<div class="sec-body" id="cf-sec-engagement" hidden={!secOpen('engagement')}>
					<label hidden={!m('tier')}>
						Engagement tier
						<select name="tier">
							<option value="" selected={!filter.tier}>— any —</option>
							{#each TIERS as t (t)}<option value={t} selected={filter.tier === t}>{TIER_LABELS[t]}</option>{/each}
						</select>
					</label>
					<label hidden={!m('opened_days')}>
						Last opened within N days
						<input type="number" name="opened_days" min="1" max="3650" value={filter.openedDays ?? ''} placeholder="any time" />
					</label>
					{#if scorePicker.length}
						<label class="wide" hidden={!m('score')}>
							Score
							<span class="eng-row">
								<select name="sc_id" bind:value={scId} aria-label="Score">
									<option value="">— any —</option>
									{#each scorePicker as sc (sc.id)}<option value={String(sc.id)}>{sc.name}</option>{/each}
								</select>
								<select name="sc_op" bind:value={scOp} aria-label="Comparison">
									{#each SCORE_OPS as [op, label] (op)}<option value={op}>{label}</option>{/each}
								</select>
								<input type="number" name="sc_n" value={filter.score?.n ?? ''} placeholder="points" aria-label="Points" />
								{#if scOp === 'between'}
									and <input type="number" name="sc_n2" value={filter.score?.n2 ?? ''} placeholder="points" aria-label="Up to points" />
								{/if}
							</span>
						</label>
						<label hidden={!m('band')}>
							Score band
							<select name="band">
								<option value="" selected={!filter.band}>— any —</option>
								{#each scorePicker as sc (sc.id)}
									{#if sc.bands.length}
										<optgroup label={sc.name}>
											{#each sc.bands as b (b)}
												<option value="{sc.id}:{b}" selected={filter.band?.scoreId === sc.id && filter.band?.label.toLowerCase() === b.toLowerCase()}>{b}</option>
											{/each}
										</optgroup>
									{/if}
								{/each}
							</select>
						</label>
					{/if}
					<label class="wide" hidden={!m('opened_n')}>
						Opened at least
						<span class="eng-row">
							<input type="number" name="opened_n" min="1" max="50" value={filter.openedN ?? ''} placeholder="N" aria-label="Opened at least N" />
							of the last
							<input type="number" name="opened_of" min="1" max="50" value={filter.openedOf ?? ''} placeholder="M" aria-label="Of the last M sends" />
							sends
						</span>
					</label>
					<label class="wide check" hidden={!m('never_opened')}>
						<input type="checkbox" name="never_opened" value="1" checked={filter.neverOpened} />
						Never opened <span class="muted">(sent ≥ 1, no opens)</span>
					</label>
				</div>
			</section>

			<!-- Deliverability -->
			<section class="sec" hidden={!secShown('deliverability')}>
				{@render head('deliverability', 'Deliverability')}
				<div class="sec-body" id="cf-sec-deliverability" hidden={!secOpen('deliverability')}>
					<label hidden={!m('bounced')}>
						Bounced
						<select name="bounced">
							<option value="" selected={!filter.bounced}>— any —</option>
							<option value="hard" selected={filter.bounced === 'hard'}>Hard bounce</option>
							<option value="any" selected={filter.bounced === 'any'}>Any bounce</option>
						</select>
					</label>
					<label hidden={!m('hygiene')}>
						Address hygiene
						<select name="hygiene">
							<option value="" selected={!filter.hygiene}>— any —</option>
							{#each HYGIENE_FILTERS as h (h)}
								<option value={h} selected={filter.hygiene === h}>{HYGIENE_FILTER_LABELS[h]}</option>
							{/each}
						</select>
					</label>
					<label class="wide check" hidden={!m('spam')}>
						<input type="checkbox" name="spam" value="1" checked={filter.spam} />
						Marked as spam
					</label>
					{#if topicPicker.length || filter.topicOut}
						<label hidden={!m('topic_out')}>
							Opted out of topic
							<select name="topic_out">
								<option value="" selected={!filter.topicOut}>— any —</option>
								{#each topicPicker as t (t.id)}
									<option value={t.id} selected={filter.topicOut === t.id}>{t.label}</option>
								{/each}
							</select>
						</label>
					{/if}
					{#if filter.campaign}
						<label class="wide check" hidden={!m('campaign')}>
							<input type="checkbox" name="campaign" value={filter.campaign} checked />
							{campaignLabel || `Recipients of campaign #${filter.campaign}`}
							{#if filter.campaignWho}<input type="hidden" name="campaign_who" value={filter.campaignWho} />{/if}
						</label>
					{/if}
				</div>
			</section>

			<!-- Website -->
			<section class="sec" hidden={!secShown('website')}>
				{@render head('website', 'Website')}
				<div class="sec-body" id="cf-sec-website" hidden={!secOpen('website')}>
					<label hidden={!m('visited')}>
						Visited path contains
						<input name="visited" value={filter.visited} placeholder="e.g. /pricing" />
					</label>
					<label hidden={!m('visited_days')}>
						…in the last N days
						<input type="number" name="visited_days" min="1" max="3650" value={filter.visitedDays ?? ''} placeholder="any time" />
					</label>
					<label hidden={!m('site')}>
						Site activity
						<select name="site">
							<option value="all" selected={filter.site === 'all'}>Any</option>
							<option value="any" selected={filter.site === 'any'}>Has site activity</option>
							<option value="none" selected={filter.site === 'none'}>No site activity</option>
						</select>
					</label>
				</div>
			</section>

			<!-- Pipeline and company data -->
			<section class="sec" hidden={!secShown('pipeline')}>
				{@render head('pipeline', 'Pipeline and company data')}
				<div class="sec-body" id="cf-sec-pipeline" hidden={!secOpen('pipeline')}>
					<label hidden={!m('pipeline')}>
						Pipeline stage
						<select name="pipeline">
							<option value="" selected={!filter.pipeline}>— any —</option>
							<option value="any" selected={filter.pipeline === 'any'}>Any stage (on the board)</option>
							<option value="none" selected={filter.pipeline === 'none'}>Not in pipeline</option>
							{#each stagePicker as st (st.id)}
								<option value={st.id} selected={filter.pipeline === st.id}>{st.name}</option>
							{/each}
						</select>
					</label>
					<div class="metric-filter" hidden={!m('metrics')}>
						<span class="mf-title">Company metrics <span class="muted">(all must match; contacts without a company never do)</span></span>
						{#each metricChips as mc (mc.code)}
							<label class="mf-keep"><input type="checkbox" name="cm_keep" value={mc.code} checked /> {mc.label}</label>
						{/each}
						{#if metricChips.length < 5}
							<div class="mf-row">
								<select name="cm_metric" bind:value={cmMetric} aria-label="Company metric">
									<option value="">Add a metric condition…</option>
									{#each metricGroups as g (g.group)}
										<optgroup label={g.label}>{#each g.metrics as cm (cm.key)}<option value={cm.key}>{cm.label}</option>{/each}</optgroup>
									{/each}
								</select>
								{#if cmMetric}
									<select name="cm_op" aria-label="Operator">
										{#each cmOps as o (o.op)}<option value={o.op}>{o.label}</option>{/each}
									</select>
									<input name="cm_value" type="number" step="any" placeholder={cmOps[0]?.op === 'older' ? 'days' : 'value'} aria-label="Value" />
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</section>
		</div>

		<div class="filter-actions">
			<button type="submit">Apply</button>
			{#if filtered}<a class="clear" href={clearHref}>Clear</a>{/if}
		</div>
	</form>
</details>

<style>
	.menu { position: relative; }
	/* Trigger = the theme's outline button; panel = the theme's popover surface. */
	.menu summary {
		list-style: none; cursor: pointer; padding: var(--space-xs) var(--space-m); border: 0;
		border-radius: var(--radius-s); background: var(--btn-bg); user-select: none; white-space: nowrap;
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-medium); color: var(--neutral-10);
		box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
		transition: background-color var(--motion-duration) var(--motion-easing);
	}
	.menu summary::-webkit-details-marker { display: none; }
	.menu summary:hover { background: var(--btn-hover); }
	.menu summary:focus-visible { box-shadow: 0 0 0 var(--border-s) var(--color-1-transparent), var(--focus-halo); }
	.menu summary.on { box-shadow: 0 0 0 var(--border-s) var(--color-1); color: var(--text); }
	.dot {
		display: inline-block; width: 6px; height: 6px; margin-left: var(--space-xxs); border-radius: var(--radius-full);
		background: var(--color-1); vertical-align: middle;
	}
	.sheet-backdrop, .sheet-head { display: none; }
	.filters {
		position: absolute; right: 0; z-index: 20; margin-top: var(--space-xxs); padding: var(--space-m);
		background: var(--surface); color: var(--neutral-10); border: 0; border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
		display: flex; flex-direction: column; gap: var(--space-s); width: min(94vw, 480px);
		max-height: min(80vh, 680px); overflow: auto;
	}
	.filters label {
		display: flex; flex-direction: column; gap: var(--space-xs);
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-medium); color: var(--neutral-10);
	}
	.filters [hidden] { display: none !important; }
	.filters input, .filters select { width: 100%; }
	.no-match { margin: 0; font-size: var(--size-s); line-height: var(--line-s); }
	.secs { display: flex; flex-direction: column; }
	.sec { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.sec:first-child { box-shadow: inset 0 var(--border-s) 0 var(--border), inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.sec-head {
		display: flex; align-items: center; gap: var(--space-xs); width: 100%; padding: var(--space-xs) 0; min-height: 40px;
		background: transparent; border: 0; box-shadow: none; color: var(--text); cursor: pointer; text-align: left;
		font-size: var(--size-s); line-height: var(--line-s); font-weight: var(--weight-ui-medium);
	}
	.sec-head:disabled { cursor: default; opacity: 1; }
	.sec-head:focus-visible { box-shadow: var(--focus-halo); border-radius: var(--radius-s); }
	.sec-title { flex: 1; }
	.sec-count {
		min-width: 1.4rem; padding: 0 var(--space-xs); border-radius: var(--radius-full); text-align: center;
		font-size: var(--size-xs); line-height: var(--line-xs); font-variant-numeric: tabular-nums;
		background: var(--btn-primary-bg); color: var(--btn-primary-text);
	}
	.sec-body {
		display: grid; grid-template-columns: repeat(2, minmax(150px, 1fr)); gap: var(--space-s);
		padding: var(--space-xxs) 0 var(--space-m);
	}
	.filters .wide { grid-column: 1 / -1; }
	.eng-row { display: flex; align-items: center; gap: var(--space-xs); color: var(--text); font-weight: var(--weight-ui-regular); }
	.eng-row input { width: 4.5rem; }
	.filters .check { flex-direction: row; align-items: center; gap: var(--space-xs); color: var(--text); font-weight: var(--weight-ui-regular); }
	.filters .check input { width: auto; }
	.metric-filter {
		grid-column: 1 / -1; display: flex; flex-direction: column; gap: var(--space-xs);
		font-size: var(--size-s); line-height: var(--line-s); color: var(--neutral-10);
	}
	.metric-filter .mf-title { font-weight: var(--weight-ui-medium); }
	.metric-filter .mf-keep { flex-direction: row; align-items: center; gap: var(--space-xs); color: var(--text); font-weight: var(--weight-ui-regular); }
	.metric-filter .mf-keep input { width: auto; }
	.mf-row { display: flex; gap: var(--space-xs); }
	.mf-row select, .mf-row input { width: auto; min-width: 0; flex: 1; }
	.filter-actions { display: flex; align-items: center; gap: var(--space-s); }
	.filter-actions .clear { font-size: var(--size-s); line-height: var(--line-s); }
	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
		clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
	@media (max-width: 640px) {
		/* #583: a full-width bottom sheet, Apply + Clear pinned at the bottom. */
		.menu { position: static; }
		.sheet-backdrop {
			display: block; position: fixed; inset: 0; z-index: 60;
			background: color-mix(in srgb, var(--neutral-12, #000) 40%, transparent);
		}
		.filters {
			position: fixed; left: 0; right: 0; bottom: 0; z-index: 61; width: auto; margin: 0;
			max-height: 88dvh; border-radius: var(--radius-m) var(--radius-m) 0 0; padding-bottom: 0;
		}
		.sheet-head { display: flex; align-items: center; justify-content: space-between; }
		.sheet-title { font-weight: var(--weight-ui-medium); font-size: var(--size-m); line-height: var(--line-m); color: var(--text); }
		.sheet-close {
			display: inline-flex; align-items: center; justify-content: center; min-width: 40px; min-height: 40px; padding: 0;
			background: transparent; border: 0; box-shadow: none; color: var(--muted);
		}
		.find input { font-size: 16px; } /* no iOS focus zoom */
		.sec-body { grid-template-columns: minmax(0, 1fr); }
		.filter-actions {
			position: sticky; bottom: 0; margin: 0 calc(-1 * var(--space-m)); padding: var(--space-s) var(--space-m);
			padding-bottom: max(var(--space-s), env(safe-area-inset-bottom));
			background: var(--surface); box-shadow: inset 0 var(--border-s) 0 var(--border);
		}
		.filter-actions button { flex: 1; min-height: 44px; }
		.filter-actions .clear { padding: var(--space-xs) var(--space-s); }
	}
</style>

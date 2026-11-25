<script lang="ts">
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ReportAudience from '$lib/components/ReportAudience.svelte';
	import ReportDescribe from '$lib/components/ReportDescribe.svelte';
	import ReportResults from '$lib/components/ReportResults.svelte';
	import RuleBuilder from '$lib/components/RuleBuilder.svelte';
	import { metricDef, opsFor } from '$lib/company-metrics';
	import type { BuilderLoad } from '$lib/server/reports/page';
	import type { AudienceForm, AudienceLoad } from '$lib/server/reports/audience';
	import type { NlStatus } from '$lib/server/reports/nl-page';
	import {
		CHART_OPTIONS,
		ENTITY_LABELS,
		ENTITY_ORDER,
		LIMIT_OPTIONS,
		REPORT_FOLDERS,
		TIME_PRESET_OPTIONS,
		columnGroups,
		companyMetricsFor,
		decodeSpec,
		defaultSpec,
		encodeSpec,
		filtersFromBuilder,
		filtersToBuilder,
		folderForEntity,
		groupChoices,
		isReportFolder,
		sameSpec
	} from '$lib/report-view';
	import {
		fieldColumnKey,
		parseReportSpec,
		ReportError,
		type EntityFilter,
		type ReportChart,
		type ReportEntity,
		type ReportSpec,
		type TimePreset
	} from '$lib/report-spec';
	import type { SegmentRules } from '$lib/server/segment-query';

	let {
		data,
		form,
		describe
	}: {
		data: BuilderLoad & { audience?: AudienceLoad | null };
		form: ({ error?: string } & AudienceForm) | null;
		describe?: NlStatus;
	} = $props();

	function clone<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T;
	}

	let draft = $state(clone(data.spec));
	let rules = $state<SegmentRules>(filtersToBuilder(data.spec.filters));
	let name = $state(initialName());
	let description = $state(initialDescription());
	let folder = $state(initialFolder());
	let pinOnSave = $state(data.saved?.pinned === 1);
	let localError = $state<string | null>(null);
	let saveAsOpen = $state(false);
	let saveAsName = $state('');
	let fieldName = $state('');
	let pushed = $state(encodeSpec(data.spec));
	let reportKey = $state(identity());
	let timer: ReturnType<typeof setTimeout> | undefined;
	// #389: a spec from "Describe it" fills the form but waits for Run.
	let nlPending = $state(false);
	let nlReadback = $state<string | null>(null);
	let nlSerialized = $state('');

	function identity(): string {
		if (data.saved) return `saved:${data.saved.id}`;
		if (data.builtIn) return `builtin:${data.builtIn.key}`;
		return 'new';
	}

	function initialName(): string {
		return data.saved?.name ?? data.builtIn?.name ?? data.draft?.name ?? '';
	}

	function initialDescription(): string {
		return data.saved?.description ?? data.builtIn?.description ?? data.draft?.description ?? '';
	}

	function initialFolder(): string {
		if (data.saved?.folder && isReportFolder(data.saved.folder)) return data.saved.folder;
		if (data.builtIn) return data.builtIn.folder;
		if (data.draft?.folder && isReportFolder(data.draft.folder)) return data.draft.folder;
		return folderForEntity(data.spec.entity);
	}

	// #456: built-in params live here so "Custom range" shows its dates before Update.
	function paramState(): Record<string, string> {
		return Object.fromEntries((data.builtIn?.params ?? []).map((param) => [param.key, param.value]));
	}
	let paramValues = $state<Record<string, string>>(paramState());
	let paramsSeen = $state(JSON.stringify(paramState()));
	$effect(() => {
		const incoming = JSON.stringify(paramState());
		if (incoming === paramsSeen) return;
		paramsSeen = incoming;
		paramValues = paramState();
	});

	const readOnly = $derived(data.readOnly);
	const groups = $derived(columnGroups(draft.entity, data.role));
	const metrics = $derived(companyMetricsFor(data.role));
	const groupList = $derived(groupChoices(draft.entity, data.pickers.fieldKeys));
	const serialized = $derived.by(() => {
		try {
			return JSON.stringify(parseReportSpec(draft));
		} catch {
			return '';
		}
	});
	const dirty = $derived.by(() => {
		if (!data.saved) return data.mode === 'new';
		try {
			return !sameSpec(parseReportSpec(draft), data.saved.spec);
		} catch {
			return true;
		}
	});

	$effect(() => {
		const key = identity();
		if (key === reportKey) return;
		reportKey = key;
		draft = clone(data.spec);
		rules = filtersToBuilder(data.spec.filters);
		name = initialName();
		description = initialDescription();
		folder = initialFolder();
		pinOnSave = data.saved?.pinned === 1;
		pushed = encodeSpec(data.spec);
		localError = null;
	});

	$effect(() => {
		const incoming = encodeSpec(data.spec);
		if (incoming === pushed) return;
		pushed = incoming;
		draft = clone(data.spec);
		rules = filtersToBuilder(data.spec.filters);
		localError = null;
	});

	$effect(() => {
		const next = filtersFromBuilder(rules);
		if (JSON.stringify(next) === JSON.stringify(draft.filters)) return;
		draft = { ...draft, filters: next };
		if (!nlPending) schedule();
	});

	onMount(() => {
		if (data.mode === 'new' && !page.url.searchParams.has('spec')) schedule();
	});

	function schedule() {
		if (!browser || readOnly) return;
		nlPending = false;
		clearTimeout(timer);
		timer = setTimeout(() => {
			let parsed: ReportSpec;
			try {
				parsed = parseReportSpec(draft);
			} catch (err) {
				localError = err instanceof ReportError ? err.message : 'This report is incomplete.';
				return;
			}
			localError = null;
			const encoded = encodeSpec(parsed);
			const current = page.url.searchParams.get('spec');
			if (current) {
				try {
					if (sameSpec(decodeSpec(current), parsed)) return;
				} catch {
					/* replace a broken link */
				}
			}
			pushed = encoded;
			const url = new URL(page.url.href);
			url.searchParams.set('spec', JSON.stringify(parsed));
			goto(`${url.pathname}?${url.searchParams}`, { replace: true, reset: false });
		}, 400);
	}

	function applyDescribed(spec: ReportSpec, line: string) {
		clearTimeout(timer);
		draft = clone(spec);
		rules = filtersToBuilder(spec.filters);
		if (!name.trim()) folder = folderForEntity(spec.entity);
		nlReadback = line;
		nlSerialized = JSON.stringify(spec);
		localError = null;
		nlPending = true;
	}

	function patch(next: ReportSpec) {
		draft = next;
		schedule();
	}

	function setEntity(entity: ReportEntity) {
		const previous = folderForEntity(draft.entity);
		const next = defaultSpec(entity);
		draft = next;
		rules = filtersToBuilder(next.filters);
		if (folder === previous) folder = folderForEntity(entity);
		schedule();
	}

	function toggleColumn(key: string) {
		const columns = draft.columns.includes(key) ? draft.columns.filter((item) => item !== key) : [...draft.columns, key];
		if (!columns.length) {
			localError = 'Pick at least one column.';
			return;
		}
		localError = null;
		const next: ReportSpec = { ...draft, columns };
		if (next.sort && next.sort.key !== next.groupBy && !columns.includes(next.sort.key)) delete next.sort;
		patch(next);
	}

	function addField() {
		const key = `field:${fieldName.trim()}`;
		if (!fieldColumnKey(key)) {
			localError = 'Custom field names use letters, numbers, spaces, _ and -.';
			return;
		}
		fieldName = '';
		if (!draft.columns.includes(key)) toggleColumn(key);
	}

	function setGroup(value: string) {
		const next: ReportSpec = { ...draft };
		if (value) next.groupBy = value;
		else delete next.groupBy;
		patch(next);
	}

	function setTime(mode: string) {
		const next: ReportSpec = { ...draft };
		if (mode === 'default') delete next.timeRange;
		else if (mode === 'custom') {
			const to = new Date();
			const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
			next.timeRange = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
		} else next.timeRange = { preset: mode as TimePreset };
		patch(next);
	}

	function setCustomDay(bound: 'from' | 'to', value: string) {
		const range = draft.timeRange && !('preset' in draft.timeRange) ? draft.timeRange : { from: value, to: value };
		patch({ ...draft, timeRange: { ...range, [bound]: value } });
	}

	function entityValue(field: string, op: string): string {
		return draft.entityFilters?.find((filter) => filter.field === field && filter.op === op)?.value ?? '';
	}

	function setEntityFilter(field: string, op: string, value: string, value2?: string) {
		const rest = (draft.entityFilters ?? []).filter((filter) => !(filter.field === field && filter.op === op));
		const entityFilters: EntityFilter[] = value ? [...rest, { field, op, value, ...(value2 ? { value2 } : {}) }] : rest;
		const next: ReportSpec = { ...draft };
		if (entityFilters.length) next.entityFilters = entityFilters;
		else delete next.entityFilters;
		patch(next);
	}

	const companyMetric = $derived((draft.entityFilters ?? []).find((filter) => filter.field !== 'name' && metricDef(filter.field)) ?? null);

	function setCompanyMetric(metric: string, op: string, value: string) {
		const rest = (draft.entityFilters ?? []).filter((filter) => filter.field === 'name' || !metricDef(filter.field));
		const next: ReportSpec = { ...draft };
		if (metric && op && value.trim()) next.entityFilters = [...rest, { field: metric, op, value: value.trim() }];
		else if (rest.length) next.entityFilters = rest;
		else delete next.entityFilters;
		patch(next);
	}

	function setSort(key: string) {
		const dir = draft.sort?.key === key && draft.sort.dir === 'asc' ? 'desc' : draft.sort?.key === key ? 'asc' : 'desc';
		patch({ ...draft, sort: { key, dir } });
	}

	function setSortDir(dir: 'asc' | 'desc') {
		const key = draft.sort?.key ?? draft.groupBy ?? draft.columns[0];
		if (!key) return;
		patch({ ...draft, sort: { key, dir } });
	}

	function setMinSent(raw: string) {
		const next: ReportSpec = { ...draft };
		if (!raw.trim()) delete next.thresholds;
		else next.thresholds = { minSent: Number(raw) };
		patch(next);
	}

	const timeMode = $derived(!draft.timeRange ? 'default' : 'preset' in draft.timeRange ? draft.timeRange.preset : 'custom');
	const customFrom = $derived(draft.timeRange && !('preset' in draft.timeRange) ? draft.timeRange.from.slice(0, 10) : '');
	const customTo = $derived(draft.timeRange && !('preset' in draft.timeRange) ? draft.timeRange.to.slice(0, 10) : '');
	const sortKeys = $derived([...(draft.groupBy ? [draft.groupBy] : []), ...draft.columns.filter((key) => key !== draft.groupBy)]);
	const shownError = $derived(localError ?? (form?.error ? null : data.error));
	const title = $derived(data.builtIn?.name ?? data.saved?.name ?? 'New report');
	const showReadback = $derived(!!nlReadback && serialized === nlSerialized);
	// #456: a built-in's own range param replaces the panel's Time range control.
	const builtInRange = $derived(!!data.builtIn?.params.some((param) => param.key === 'range'));
	const csvHref = $derived(data.builtIn ? `/reports/b/${data.builtIn.key}.csv${data.builtIn.query ? `?${data.builtIn.query}` : ''}` : null);
</script>

<svelte:head><title>{title}</title></svelte:head>

<Breadcrumbs items={[{ label: 'Reports', href: '/reports' }, { label: title }]} />

<div class="page">
	<div class="head">
		<h1>{title}</h1>
		<div class="actions">
			{#if !readOnly}
				<form method="POST" action="?/save" use:enhance>
					<input type="hidden" name="spec" value={serialized} />
					<input type="hidden" name="name" value={name} />
					<input type="hidden" name="description" value={description} />
					<input type="hidden" name="folder" value={folder} />
					{#if pinOnSave}<input type="hidden" name="pinned" value="1" />{/if}
					<button type="submit" disabled={!serialized || !name.trim()}>Save</button>
				</form>
				<button type="button" class="secondary" disabled={!serialized} onclick={() => { saveAsName = name ? `Copy of ${name}` : ''; saveAsOpen = true; }}>Save as…</button>
			{/if}
			{#if data.saved}
				<form method="POST" action="?/duplicate" use:enhance>
					<button type="submit" class="secondary">Duplicate</button>
				</form>
				<form method="POST" action="?/pin" use:enhance>
					<input type="hidden" name="pinned" value={data.saved.pinned ? '0' : '1'} />
					<button type="submit" class="secondary">{data.saved.pinned ? 'Unpin' : 'Pin to Reports home'}</button>
				</form>
				<a href="/reports/{data.saved.id}.csv"><button type="button" class="secondary">Export CSV</button></a>
				<form method="POST" action="?/delete" use:enhance onsubmit={(event) => { if (!confirm('Delete this report?')) event.preventDefault(); }}>
					<button type="submit" class="danger">Delete</button>
				</form>
			{:else if data.builtIn}
				{#if data.builtIn.duplicable}
					<form method="POST" action="?/duplicate" use:enhance>
						{#each data.builtIn.params as param (param.key)}<input type="hidden" name="p_{param.key}" value={param.value} />{/each}
						<button type="submit">Duplicate to customize</button>
					</form>
				{/if}
				{#if !data.builtIn.pinned || !data.builtIn.pinnedHere}
					<form method="POST" action="?/pin" use:enhance>
						{#each data.builtIn.params as param (param.key)}<input type="hidden" name="p_{param.key}" value={param.value} />{/each}
						<input type="hidden" name="pinned" value="1" />
						<button type="submit" class="secondary">{data.builtIn.pinned ? 'Pin these settings' : 'Pin to Reports home'}</button>
					</form>
				{/if}
				{#if data.builtIn.pinned}
					<form method="POST" action="?/pin" use:enhance>
						{#each data.builtIn.params as param (param.key)}<input type="hidden" name="p_{param.key}" value={param.value} />{/each}
						<input type="hidden" name="pinned" value="0" />
						<button type="submit" class="secondary">Unpin</button>
					</form>
				{/if}
				<a href={csvHref}><button type="button" class="secondary">Export CSV</button></a>
			{/if}
		</div>
	</div>
	{#if dirty && data.saved}<p class="dirty">Unsaved changes</p>{/if}
	{#if data.builtIn}<p class="desc">{data.builtIn.description}</p>{/if}
	{#if data.builtIn?.readback}<p class="readback">{data.builtIn.readback}</p>{/if}
	{#if form?.error}<p class="err" role="alert">{form.error}</p>{/if}
	{#if describe && !readOnly}<ReportDescribe status={describe} current={serialized} onspec={applyDescribed} />{/if}

	{#if data.builtIn?.params.length}
		<form class="params card" method="GET" aria-label="Report settings">
			{#each data.builtIn.params as param (param.key)}
				{#if !param.when || paramValues[param.when.key] === param.when.value}
				<label class="field">{param.label}
					{#if param.kind === 'select'}
						<select name="p_{param.key}" bind:value={paramValues[param.key]}>
							{#each param.options ?? [] as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
						</select>
					{:else if param.kind === 'number'}
						<span class="param-num">
							<input type="number" name="p_{param.key}" value={param.value} min={param.min} max={param.max} step="1" />
							{#if param.suffix}<span>{param.suffix}</span>{/if}
						</span>
					{:else if param.kind === 'date'}
						<input type="date" name="p_{param.key}" bind:value={paramValues[param.key]} />
					{:else if param.kind === 'score'}
						<select name="p_{param.key}" value={param.value || data.pickers.scores[0]?.slug || ''}>
							{#each data.pickers.scores as score (score.slug)}<option value={score.slug}>{score.name}</option>{/each}
							{#if !data.pickers.scores.length}<option value="">No active score</option>{/if}
						</select>
					{:else if param.kind === 'field'}
						<input name="p_{param.key}" value={param.value} list="report-field-keys" placeholder="Field name" />
						<datalist id="report-field-keys">
							{#each data.pickers.fieldKeys as key (key)}<option value={key}></option>{/each}
						</datalist>
					{:else}
						<input name="p_{param.key}" value={param.value} maxlength="300" />
					{/if}
					{#if param.help}<span class="def">{param.help}</span>{/if}
				</label>
				{/if}
			{/each}
			<button type="submit" class="secondary">Update</button>
		</form>
	{/if}

	{#snippet settings()}
			<fieldset disabled={readOnly}>
				{#if !data.builtIn}
				<label class="field">Name <input name="report-name" bind:value={name} maxlength="120" required /></label>
				<label class="field">Description <textarea rows="2" bind:value={description} maxlength="2000"></textarea></label>
				<label class="field">Folder
					<select bind:value={folder}>
						{#each REPORT_FOLDERS as item (item)}<option value={item}>{item}</option>{/each}
					</select>
				</label>
				{/if}

				<label class="field">What are you reporting on?
					<select value={draft.entity} onchange={(event) => setEntity((event.target as HTMLSelectElement).value as ReportEntity)}>
						{#each ENTITY_ORDER as entity (entity)}<option value={entity}>{ENTITY_LABELS[entity]}</option>{/each}
					</select>
				</label>

				{#if !builtInRange}
				<label class="field">Time range
					<select value={timeMode} onchange={(event) => setTime((event.target as HTMLSelectElement).value)}>
						<option value="default">Default</option>
						{#each TIME_PRESET_OPTIONS as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
						<option value="custom">Custom range</option>
					</select>
				</label>
				{#if timeMode === 'custom'}
					<div class="split">
						<label class="field">From <input type="date" value={customFrom} onchange={(event) => setCustomDay('from', (event.target as HTMLInputElement).value)} /></label>
						<label class="field">To <input type="date" value={customTo} onchange={(event) => setCustomDay('to', (event.target as HTMLInputElement).value)} /></label>
					</div>
				{/if}
				{/if}

				<h2>Filters</h2>
				<RuleBuilder bind:rules {metrics} companies={data.pickers.companies} stages={data.pickers.stages} groups={data.pickers.groups} noun="filter" />

				{#if draft.entity === 'campaigns'}
					<label class="field">Status
						<select value={entityValue('status', 'is')} onchange={(event) => setEntityFilter('status', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Any</option>
							{#each ['draft', 'sending', 'sent', 'failed', 'scheduled', 'canceled'] as status (status)}<option value={status}>{status}</option>{/each}
						</select>
					</label>
					<label class="field">Kind
						<select value={entityValue('kind', 'is')} onchange={(event) => setEntityFilter('kind', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Any</option>
							<option value="campaign">Campaign</option>
							<option value="automation">Automation</option>
							<option value="direct">Direct</option>
						</select>
					</label>
					<label class="field">Audience
						<select value={entityValue('audience', 'is')} onchange={(event) => setEntityFilter('audience', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Any</option>
							{#each data.pickers.lists as list (list.id)}<option value={String(list.id)}>{list.name}</option>{/each}
						</select>
					</label>
					<div class="split">
						<label class="field">Sent after <input type="date" value={entityValue('sent_at', 'after').slice(0, 10)} onchange={(event) => setEntityFilter('sent_at', 'after', (event.target as HTMLInputElement).value)} /></label>
						<label class="field">Sent before <input type="date" value={entityValue('sent_at', 'before').slice(0, 10)} onchange={(event) => setEntityFilter('sent_at', 'before', (event.target as HTMLInputElement).value)} /></label>
					</div>
				{:else if draft.entity === 'companies'}
					<label class="field">Name contains <input value={entityValue('name', 'contains')} oninput={(event) => setEntityFilter('name', 'contains', (event.target as HTMLInputElement).value)} /></label>
					<div class="split metric">
						<label class="field">Metric
							<select value={companyMetric?.field ?? ''} onchange={(event) => setCompanyMetric((event.target as HTMLSelectElement).value, companyMetric?.op ?? 'gt', companyMetric?.value ?? '')}>
								<option value="">None</option>
								{#each metrics as metric (metric.key)}<option value={metric.key}>{metric.label}</option>{/each}
							</select>
						</label>
						{#if companyMetric}
							<label class="field">Op
								<select value={companyMetric.op} onchange={(event) => setCompanyMetric(companyMetric.field, (event.target as HTMLSelectElement).value, companyMetric.value ?? '')}>
									{#each opsFor(companyMetric.field) as op (op.op)}<option value={op.op}>{op.label}</option>{/each}
								</select>
							</label>
							<label class="field">Value <input value={companyMetric.value ?? ''} oninput={(event) => setCompanyMetric(companyMetric.field, companyMetric.op, (event.target as HTMLInputElement).value)} /></label>
						{/if}
					</div>
				{:else if draft.entity === 'pipeline'}
					<label class="field">Stage
						<select value={entityValue('stage', 'is')} onchange={(event) => setEntityFilter('stage', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Any</option>
							{#each data.pickers.stages as stage (stage.id)}<option value={String(stage.id)}>{stage.name}</option>{/each}
						</select>
					</label>
					<label class="field">Stage kind
						<select value={entityValue('kind', 'is')} onchange={(event) => setEntityFilter('kind', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Any</option>
							<option value="open">Open</option>
							<option value="won">Won</option>
							<option value="lost">Lost</option>
						</select>
					</label>
				{:else if draft.entity === 'site_pages'}
					<label class="field">Path contains <input value={entityValue('path', 'contains')} oninput={(event) => setEntityFilter('path', 'contains', (event.target as HTMLInputElement).value)} /></label>
					<label class="field">Country <input value={entityValue('country', 'is')} oninput={(event) => setEntityFilter('country', 'is', (event.target as HTMLInputElement).value)} /></label>
					<label class="field">Site
						<select value={entityValue('site', 'is')} onchange={(event) => setEntityFilter('site', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Any</option>
							{#each data.pickers.sites as site (site.id)}<option value={String(site.id)}>{site.name}</option>{/each}
						</select>
					</label>
				{:else if draft.entity === 'segments'}
					<label class="field">Kind
						<select value={entityValue('kind', 'is')} onchange={(event) => setEntityFilter('kind', 'is', (event.target as HTMLSelectElement).value)}>
							<option value="">Lists and segments</option>
							<option value="list">Lists</option>
							<option value="segment">Segments</option>
							<option value="tag">Tags</option>
							<option value="company">Companies</option>
						</select>
					</label>
				{/if}

				<h2>Columns</h2>
				{#each groups as group, index (group.label)}
					<details open={index === 0}>
						<summary>{group.label}</summary>
						<ul class="cols">
							{#each group.columns as column (column.key)}
								<li>
									<label class="col">
										<input type="checkbox" checked={draft.columns.includes(column.key)} onchange={() => toggleColumn(column.key)} />
										<span>
											<span class="col-name">{column.label}</span>
											<span class="def">{column.definition}</span>
										</span>
									</label>
								</li>
							{/each}
						</ul>
					</details>
				{/each}
				{#if draft.entity === 'contacts'}
					<div class="add-field">
						<label class="field">Custom field <input bind:value={fieldName} placeholder="Field name" /></label>
						<button type="button" class="secondary" onclick={addField}>Add column</button>
					</div>
				{/if}

				<h2>Layout</h2>
				<label class="field">Group by
					<select value={draft.groupBy ?? ''} onchange={(event) => setGroup((event.target as HTMLSelectElement).value)}>
						<option value="">None</option>
						{#each groupList as choice (choice.value)}<option value={choice.value}>{choice.label}</option>{/each}
					</select>
				</label>
				<div class="split">
					<label class="field">Sort
						<select value={draft.sort?.key ?? ''} onchange={(event) => { const key = (event.target as HTMLSelectElement).value; if (key) patch({ ...draft, sort: { key, dir: draft.sort?.dir ?? 'desc' } }); }}>
							<option value="">Default</option>
							{#each sortKeys as key (key)}<option value={key}>{groupList.find((choice) => choice.value === key)?.label ?? groups.flatMap((group) => group.columns).find((column) => column.key === key)?.label ?? key}</option>{/each}
						</select>
					</label>
					<label class="field">Direction
						<select value={draft.sort?.dir ?? 'desc'} onchange={(event) => setSortDir((event.target as HTMLSelectElement).value as 'asc' | 'desc')}>
							<option value="asc">Ascending</option>
							<option value="desc">Descending</option>
						</select>
					</label>
				</div>
				{#if draft.entity === 'contacts'}
					<label class="field">At least this many sends
						<input type="number" min="0" step="1" value={draft.thresholds?.minSent ?? ''} oninput={(event) => setMinSent((event.target as HTMLInputElement).value)} />
					</label>
				{/if}
				<label class="field">Chart
					<select value={draft.chart ?? 'table'} onchange={(event) => patch({ ...draft, chart: (event.target as HTMLSelectElement).value as ReportChart })}>
						{#each CHART_OPTIONS as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
					</select>
				</label>
				<label class="field">Rows
					<select value={String(draft.limit)} onchange={(event) => patch({ ...draft, limit: Number((event.target as HTMLSelectElement).value) })}>
						{#each LIMIT_OPTIONS as limit (limit)}<option value={String(limit)}>{limit}</option>{/each}
						{#if !LIMIT_OPTIONS.includes(draft.limit as 25 | 50 | 100 | 250 | 500)}<option value={String(draft.limit)}>{draft.limit}</option>{/if}
					</select>
				</label>
				{#if !readOnly}
					<label class="pin"><input type="checkbox" bind:checked={pinOnSave} /> Pin to Reports home</label>
				{/if}
			</fieldset>
	{/snippet}

	<div class="builder" class:single={!!data.builtIn}>
		{#if !data.builtIn}
		<form class="panel card" onsubmit={(event) => event.preventDefault()}>
			{@render settings()}
		</form>
		{/if}

		<section class="results card">
			<h2>Results</h2>
			{#if showReadback}<p class="readback">{nlReadback}</p>{/if}
			{#if nlPending}
				<p class="pending">The builder is filled in from your description. Check it, then run it. Nothing is saved until you click Save.</p>
				<button type="button" onclick={() => schedule()}>Run</button>
			{:else}
				<ReportResults spec={draft} result={data.result} error={shownError} tz={data.tz} onSort={readOnly ? undefined : setSort} />
			{/if}
		</section>
		{#if data.builtIn && !data.builtIn.custom}
			<!-- #456: collapsed on built-ins; the params above are the controls. -->
			<details class="card used">
				<summary>Settings this report uses</summary>
				<form class="panel" onsubmit={(event) => event.preventDefault()}>
					{@render settings()}
				</form>
			</details>
		{/if}
		{#if data.audience}
			<div class="audience-slot">
				<ReportAudience audience={data.audience} spec={data.spec} reportName={name || title} {form} />
			</div>
		{/if}
	</div>
</div>

{#if saveAsOpen}
	<Modal bind:open={saveAsOpen} title="Save as">
		<form method="POST" action="?/saveAs" use:enhance>
			<label class="field">Name <input name="name" bind:value={saveAsName} maxlength="120" required /></label>
			<input type="hidden" name="spec" value={serialized} />
			<input type="hidden" name="description" value={description} />
			<input type="hidden" name="folder" value={folder} />
			<button type="submit" disabled={!serialized || !saveAsName.trim()}>Save</button>
		</form>
	</Modal>
{/if}

<style>
	.page {
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-m);
		flex-wrap: wrap;
	}
	h1 {
		margin: 0;
	}
	h2 {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		margin: var(--space-m) 0 var(--space-xs);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		align-items: center;
	}
	.actions form,
	.actions a {
		margin: 0;
	}
	.actions a:hover {
		text-decoration: none;
	}
	.dirty {
		margin: var(--space-xs) 0 0;
		color: var(--muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.err {
		color: var(--error);
		margin: var(--space-xs) 0 0;
	}
	.desc {
		margin: var(--space-xs) 0 0;
		color: var(--muted);
	}
	.params {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		align-items: flex-end;
		margin-top: var(--space-m);
	}
	.params .field {
		margin: 0;
		min-width: 10rem;
	}
	.param-num {
		display: flex;
		align-items: center;
		gap: var(--space-xxs);
	}
	.param-num input {
		max-width: 7rem;
	}
	.builder.single {
		grid-template-columns: minmax(0, 1fr);
	}
	.builder.single .audience-slot {
		grid-column: 1;
	}
	.used summary {
		cursor: pointer;
		font-weight: var(--weight-ui-medium);
	}
	.used .panel {
		margin-top: var(--space-s);
		max-width: 40rem;
	}
	.builder {
		display: grid;
		grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
		gap: var(--space-m);
		align-items: start;
		margin-top: var(--space-m);
		min-width: 0;
	}
	.panel,
	.results {
		min-width: 0;
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		margin: 0 0 var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.field input,
	.field select,
	.field textarea {
		color: var(--text);
		width: 100%;
	}
	.split {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-s);
	}
	.metric {
		grid-template-columns: 1.4fr 0.6fr 0.8fr;
	}
	.cols {
		list-style: none;
		margin: var(--space-xs) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.col {
		display: flex;
		gap: var(--space-xs);
		align-items: flex-start;
	}
	.col-name {
		display: block;
		color: var(--text);
	}
	.def {
		display: block;
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	details {
		margin: 0 0 var(--space-xs);
	}
	summary {
		cursor: pointer;
		font-weight: var(--weight-ui-medium);
		color: var(--text);
	}
	.add-field {
		display: flex;
		gap: var(--space-xs);
		align-items: flex-end;
	}
	.add-field .field {
		flex: 1;
	}
	.pin {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin-top: var(--space-s);
	}
	.results {
		overflow: hidden;
	}
	.audience-slot {
		grid-column: 2;
		min-width: 0;
	}
	.readback {
		margin: 0 0 var(--space-s);
		font-weight: var(--weight-ui-medium);
	}
	.pending {
		margin: 0 0 var(--space-s);
		color: var(--muted);
	}
	@media (max-width: 800px) {
		.builder {
			grid-template-columns: minmax(0, 1fr);
		}
		.audience-slot {
			grid-column: 1;
		}
		.head {
			flex-direction: column;
			align-items: flex-start;
		}
		.split,
		.metric {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>

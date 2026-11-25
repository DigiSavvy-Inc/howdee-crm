<script lang="ts">
	// #509: the form builder — Google Forms shaped. Header (name, status, Preview, Publish, ⋯),
	// tabs (Questions · Logic (#514) · Style · Settings · Submissions; phase 3 adds Share & embed to
	// TABS), one Save for everything (sticky bar when dirty, Cmd+S / Ctrl+S).
	import { onMount } from 'svelte';
	import { kbd } from '$lib/platform.svelte';
	import { page } from '$app/state';
	import { beforeNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { deserialize, enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import logomark from '$lib/assets/logomark.svg';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import FieldCard from '$lib/components/forms/FieldCard.svelte';
	import FormStyleTab from '$lib/components/forms/FormStyleTab.svelte';
	import FormSettingsTab from '$lib/components/forms/FormSettingsTab.svelte';
	import FormLogicTab from '$lib/components/forms/FormLogicTab.svelte';
	import { formPath, ruleSetText } from '$lib/form-logic';
	import FormShareTab from '$lib/components/forms/FormShareTab.svelte';
	import FormAutomationsCard from '$lib/components/forms/FormAutomationsCard.svelte';
	import FormScoringCard from '$lib/components/forms/FormScoringCard.svelte';
	import FormRenderer from '$lib/components/FormRenderer.svelte';
	import { DEFAULT_BRANDING } from '$lib/branding';
	import {
		answerText,
		blankField,
		fieldTypeInfo,
		isAnswerType,
		newId,
		normalizeFormSpec,
		pageLabel,
		settingsOutcome,
		slugify,
		type Answers,
		type FormField,
		type FormFieldType,
		type FormSpec,
		type SpecProblem
	} from '$lib/forms';

	let { data } = $props();

	const branding = $derived(data.branding ?? DEFAULT_BRANDING);
	const logoSrc = $derived(branding.logoUrl ?? logomark);
	const readonly = $derived(!data.isAdmin);

	type Tab = 'questions' | 'logic' | 'style' | 'settings' | 'share' | 'submissions';
	const TABS: { key: Tab; label: string }[] = [
		{ key: 'questions', label: 'Questions' },
		{ key: 'logic', label: 'Logic' },
		{ key: 'style', label: 'Style' },
		{ key: 'settings', label: 'Settings' },
		{ key: 'share', label: 'Share & embed' },
		{ key: 'submissions', label: 'Submissions' }
	];
	const initialTab = page.url.searchParams.get('tab');
	let tab = $state<Tab>(TABS.some((t) => t.key === initialTab) ? (initialTab as Tab) : 'questions');
	function setTab(t: Tab) {
		tab = t;
		const u = new URL(page.url.href);
		u.searchParams.set('tab', t);
		replaceState(u, {});
	}

	// --- Editable state (seeded once; saved with one Save)
	// svelte-ignore state_referenced_locally
	let name = $state(data.form.name);
	// svelte-ignore state_referenced_locally
	let slug = $state(data.form.slug);
	// svelte-ignore state_referenced_locally
	let slugAuto = $state(data.form.status === 'draft' && data.form.slug === slugify(data.form.name));
	// svelte-ignore state_referenced_locally
	let spec = $state<FormSpec>(structuredClone(data.form.spec));
	const snapshot = () => JSON.stringify({ name, slug, spec });
	let saved = $state(snapshot());
	const dirty = $derived(snapshot() !== saved);

	// #619: defined custom fields for the pickers; a field created from a question is added here
	// (it is saved at once, independently of the form's Save).
	// svelte-ignore state_referenced_locally
	let customFields = $state([...data.customFields]);
	function fieldCreated(f: (typeof customFields)[number]) {
		if (!customFields.some((x) => x.key === f.key)) customFields = [...customFields, f];
	}

	$effect(() => {
		if (slugAuto) slug = slugify(name) || slug;
	});

	let focusedId = $state<string | null>(null);
	let problems = $state<SpecProblem[]>([]);
	let problemFieldIds = $state<string[]>([]); // field id per fields[i] at save time
	let saving = $state(false);
	let status = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let previewOpen = $state(false);
	let menuOpen = $state(false);

	const problemsByField = $derived.by(() => {
		const out: Record<string, string[]> = {};
		for (const p of problems) {
			const m = /^fields\[(\d+)\]/.exec(p.path);
			if (!m) continue;
			const id = problemFieldIds[Number(m[1])];
			if (id) (out[id] ??= []).push(p.message);
		}
		return out;
	});
	const otherProblems = $derived.by(() => {
		const out: Record<string, string[]> = {};
		// #514: the Settings tab shows its own (unconditional) outcome's problems; the Logic tab
		// reads the conditional outcomes' and the page jumps' from `problems` itself.
		const defaultIdx = spec.outcomes.indexOf(settingsOutcome(spec));
		for (const p of problems) {
			if (/^fields\[\d+\]/.test(p.path) || p.path.startsWith('pages[')) continue;
			const own = p.path === 'outcomes' || (defaultIdx >= 0 && (p.path === `outcomes[${defaultIdx}]` || p.path.startsWith(`outcomes[${defaultIdx}].`)));
			if (p.path.startsWith('outcomes') && !own) continue;
			const key = p.path.startsWith('outcomes') ? 'outcomes' : p.path;
			(out[key] ??= []).push(p.message);
		}
		return out;
	});

	async function post(action: string, body: Record<string, string> = {}) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(body)) fd.append(k, v);
		const res = await fetch(`?/${action}`, { method: 'POST', body: fd, headers: { accept: 'application/json', 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	async function save(): Promise<boolean> {
		if (readonly || saving) return false;
		saving = true;
		status = null;
		const sent = snapshot();
		const ids = spec.fields.map((f) => f.id);
		try {
			const r = await post('save', { name, slug, spec: JSON.stringify(spec) });
			if (r.type === 'success') {
				saved = sent;
				problems = [];
				status = { kind: 'ok', text: data.form.status === 'published' ? 'Saved. The live form is updated.' : 'Saved.' };
				await invalidateAll();
				return true;
			}
			if (r.type === 'failure') {
				const d = r.data as { error?: string; problems?: SpecProblem[] } | undefined;
				problems = d?.problems ?? [];
				problemFieldIds = ids;
				status = { kind: 'err', text: d?.error ?? 'Couldn’t save.' };
				const first = problems.find((p) => p.path.startsWith('fields['));
				if (first && tab === 'questions') {
					const id = ids[Number(/\[(\d+)\]/.exec(first.path)?.[1])];
					if (id) {
						focusedId = id;
						document.getElementById(`field-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
					}
				}
				return false;
			}
			status = { kind: 'err', text: 'Couldn’t save.' };
			return false;
		} catch {
			status = { kind: 'err', text: 'Couldn’t save. Check your connection.' };
			return false;
		} finally {
			saving = false;
		}
	}

	async function publish() {
		if (dirty && !(await save())) return;
		const r = await post('publish');
		if (r.type === 'failure') {
			const d = r.data as { error?: string; problems?: SpecProblem[] } | undefined;
			problems = d?.problems ?? [];
			problemFieldIds = spec.fields.map((f) => f.id);
			status = { kind: 'err', text: d?.error ?? 'Couldn’t publish.' };
			return;
		}
		status = { kind: 'ok', text: `Published at /f/${slug}.` };
		await invalidateAll();
	}

	async function simple(action: 'unpublish' | 'archive' | 'restore') {
		menuOpen = false;
		if (action === 'archive' && !confirm('Archive this form? Its page stops working; submissions are kept.')) return;
		await post(action);
		status = { kind: 'ok', text: action === 'unpublish' ? 'Unpublished. The page now 404s.' : action === 'archive' ? 'Archived.' : 'Restored as a draft.' };
		await invalidateAll();
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			save();
		}
		if (e.key === 'Escape') {
			previewOpen = false;
			menuOpen = false;
		}
	}

	beforeNavigate((nav) => {
		if (dirty && !readonly && nav.type !== 'leave' && !confirm('You have unsaved changes. Leave without saving?')) nav.cancel();
	});
	onMount(() => {
		const h = (e: BeforeUnloadEvent) => {
			if (dirty && !readonly) e.preventDefault();
		};
		window.addEventListener('beforeunload', h);
		return () => window.removeEventListener('beforeunload', h);
	});

	// --- Questions

	function insertAfterFocused(f: FormField) {
		const i = spec.fields.findIndex((x) => x.id === focusedId);
		const at = i < 0 ? spec.fields.length : i + 1;
		spec.fields = [...spec.fields.slice(0, at), f, ...spec.fields.slice(at)];
		focusedId = f.id;
		requestAnimationFrame(() => {
			const el = document.getElementById(`field-${f.id}`);
			el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			el?.querySelector<HTMLElement>('input, textarea')?.focus();
		});
	}
	function add(type: FormFieldType) {
		const f = blankField(type, type === 'short_text' ? '' : '');
		if (fieldTypeInfo(type)?.answer) f.key = '';
		insertAfterFocused(f);
	}
	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= spec.fields.length) return;
		const next = [...spec.fields];
		[next[i], next[j]] = [next[j], next[i]];
		spec.fields = next;
	}
	function duplicate(i: number) {
		const src = spec.fields[i];
		const copy: FormField = { ...structuredClone($state.snapshot(src)), id: newId() };
		if (isAnswerType(copy.type)) {
			let k = `${src.key}_copy`.slice(0, 40);
			let n = 2;
			while (spec.fields.some((f) => f.key === k)) k = `${src.key}_${n++}`.slice(0, 40);
			copy.key = k;
		}
		if (copy.map?.to === 'contact' || copy.map?.to === 'meta') copy.map = null;
		spec.fields = [...spec.fields.slice(0, i + 1), copy, ...spec.fields.slice(i + 1)];
		focusedId = copy.id;
	}
	function remove(i: number) {
		const f = spec.fields[i];
		if (f.map?.to === 'contact' && f.map.field === 'email' && !confirm('This question identifies the contact. Delete it anyway?')) return;
		spec.fields = spec.fields.filter((_, j) => j !== i);
		focusedId = spec.fields[Math.max(0, i - 1)]?.id ?? 'title';
	}

	let dragIdx = $state<number | null>(null);
	let overIdx = $state<number | null>(null);
	function drop(i: number) {
		if (dragIdx === null || dragIdx === i) return;
		const next = [...spec.fields];
		const [f] = next.splice(dragIdx, 1);
		next.splice(i, 0, f);
		spec.fields = next;
		dragIdx = null;
		overIdx = null;
	}
	function pageNumberOf(i: number): number {
		return spec.fields.slice(0, i + 1).filter((f) => f.type === 'page_break').length + 1;
	}

	// --- Submissions
	const answerFields = $derived(data.form.spec.fields.filter((f) => isAnswerType(f.type)));
	const firstThree = $derived(answerFields.filter((f) => !(f.map?.to === 'contact' && f.map.field === 'email')).slice(0, 3));
	const pages = $derived(Math.max(1, Math.ceil(data.submissionTotal / data.pageSize)));
	function subQuery(extra: Record<string, string | number | null>) {
		const u = new URLSearchParams();
		u.set('tab', 'submissions');
		const f = data.filter;
		const base: Record<string, string | number | null> = { status: f.status === 'ok' ? null : f.status ?? null, from: f.from ?? null, to: f.to ?? null, q: f.q ?? null };
		for (const [k, v] of Object.entries({ ...base, ...extra })) if (v !== null && v !== '') u.set(k, String(v));
		return `?${u}`;
	}
	const csvHref = $derived(`/forms/${data.form.id}/submissions.csv${subQuery({}).replace(/tab=submissions&?/, '')}`);
	// #744: the held submissions' bulk actions (Release all runs at most 10 per click).
	type HeldNote = { released: number; failed: number; remaining: number; discarded: number | null; stopped?: boolean };
	let heldNote = $state<HeldNote | null>(null);
	let heldBusy = $state(false);
	function heldNoteText(n: HeldNote): string {
		if (n.discarded !== null) return `Discarded ${n.discarded.toLocaleString()} held ${n.discarded === 1 ? 'submission' : 'submissions'}.`;
		const parts = [`Released ${n.released.toLocaleString()}.`];
		if (n.failed) parts.push(`${n.failed.toLocaleString()} didn’t finish and ${n.failed === 1 ? 'is' : 'are'} still held.`);
		if (n.stopped) parts.push('Some could not be released, so it stopped early. Try again in a minute.');
		else if (n.remaining) parts.push(`${n.remaining.toLocaleString()} still held: press the button again to release the next ones.`);
		return parts.join(' ');
	}
	// #744: what a held row says about its past releases (from its detail).
	function heldInfo(detail: string | null): string[] {
		const out: string[] = [];
		for (const part of (detail ?? '').split('; ')) {
			if (part === 'confirmation email sent') out.push('A confirmation email was already sent.');
			else if (part.startsWith('release failed:')) out.push(`Last release failed: ${part.slice('release failed:'.length).trim()}.`);
		}
		return out;
	}
	let heldError = $state<string | null>(null);
	const failText = (r: { type: string; data?: Record<string, unknown> }) =>
		r.type === 'failure' ? String(r.data?.error ?? 'That didn’t work.') : r.type === 'error' ? 'That didn’t work. Try again.' : null;
	const releaseOneEnhance: SubmitFunction = () => {
		heldError = null;
		return async ({ result, update }) => {
			heldError = failText(result);
			await update();
		};
	};
	const releaseAllEnhance: SubmitFunction = ({ cancel }) => {
		if (!confirm('Release the held submissions? Up to 10 run now: contacts are written and confirmation or follow-up emails can go out.')) {
			cancel();
			return;
		}
		heldBusy = true;
		heldError = null;
		return async ({ result, update }) => {
			heldBusy = false;
			heldError = failText(result);
			if (result.type === 'success' && result.data) {
				const d = result.data;
				heldNote = { released: Number(d.released) || 0, failed: Number(d.failed) || 0, remaining: Number(d.remaining) || 0, discarded: null, stopped: d.stopped === true };
			}
			await update();
		};
	};
	const discardEnhance: SubmitFunction = ({ cancel }) => {
		if (!confirm('Discard every held submission of this form? They are deleted and nothing is sent for them. This can’t be undone.')) {
			cancel();
			return;
		}
		heldBusy = true;
		heldError = null;
		return async ({ result, update }) => {
			heldBusy = false;
			heldError = failText(result);
			if (result.type === 'success' && result.data) heldNote = { released: 0, failed: 0, remaining: 0, discarded: Number(result.data.discarded) || 0 };
			await update();
		};
	};
	const statusText: Record<string, string> = { added: 'New contact', updated: 'Updated', anonymous: 'Anonymous', spam: 'Spam', rejected: 'Rejected' };
	const statusLabel = $derived(data.form.status === 'published' ? 'Published' : data.form.status === 'archived' ? 'Archived' : 'Draft');
	const previewSpec = $derived(normalizeFormSpec($state.snapshot(spec)));

	// #514: the preview's "Why hidden?" hint — what logic hides for the answers typed in it.
	let previewAnswers = $state<Answers>({});
	const whyHidden = $derived.by(() => {
		const ps = previewSpec;
		const path = formPath(ps, previewAnswers);
		const shown = new Set(path.fields.map((f) => f.id));
		const label = (key: string) => {
			const f = ps.fields.find((x) => x.key === key);
			return f ? `“${f.label || f.key}”` : key;
		};
		const out: { id: string; name: string; why: string }[] = [];
		let page = 0;
		for (const f of ps.fields) {
			if (f.type === 'page_break') page++;
			if (shown.has(f.id) || f.type === 'page_break' || f.type === 'hidden') continue;
			const name = f.label.trim() || f.key || 'Untitled';
			const why = !path.pages.includes(page)
				? `${pageLabel(ps.pages, ps.pages[page]?.id ?? '')} is skipped by a page jump.`
				: `Shown only when ${ruleSetText(f.show_when, label)}.`;
			out.push({ id: f.id, name, why });
		}
		return out;
	});
</script>

<svelte:window {onkeydown} onclick={() => (menuOpen = false)} />
<svelte:head><title>{name} · Forms</title></svelte:head>

<Breadcrumbs items={[{ label: 'Creative' }, { label: 'Forms', href: '/forms' }, { label: data.form.name }]} />

<header class="ed-head">
	<label class="name">
		<span class="sr">Form name</span>
		<input bind:value={name} maxlength="120" disabled={readonly} />
	</label>
	<span class="badge {data.form.status === 'published' ? 'sent' : 'draft'}">{statusLabel}</span>
	{#if data.form.status === 'published'}
		<a class="live" href="{data.baseUrl}/f/{data.form.slug}" target="_blank" rel="noopener">/f/{data.form.slug} <Icon name="external" size={16} /></a>
	{/if}
	<span class="grow"></span>
	<button type="button" class="secondary" onclick={() => (previewOpen = true)}><Icon name="eye" size={16} /> Preview</button>
	{#if !readonly}
		{#if data.form.status === 'published'}
			<button type="button" class="secondary" onclick={() => simple('unpublish')}>Unpublish</button>
		{:else if data.form.status === 'draft'}
			<button type="button" onclick={publish}>Publish</button>
		{/if}
		<div class="menu-wrap">
			<button type="button" class="secondary icon" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}><Icon name="more" size={16} /></button>
			{#if menuOpen}
				<div class="menu" role="menu">
					<form method="POST" action="?/duplicate" use:enhance><button type="submit" role="menuitem" class="mi">Duplicate</button></form>
					{#if data.form.status === 'archived'}
						<button type="button" role="menuitem" class="mi" onclick={() => simple('restore')}>Restore</button>
					{:else}
						<button type="button" role="menuitem" class="mi" onclick={() => simple('archive')}>Archive</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</header>

{#if status}<p class="notice {status.kind}" role={status.kind === 'err' ? 'alert' : 'status'}>{status.text}</p>{/if}
{#if readonly}<p class="muted small">Only admins can change forms. You can look and read submissions.</p>{/if}

<div class="tabs" role="tablist" aria-label="Form builder">
	{#each TABS as t (t.key)}
		<button type="button" role="tab" class="tab" aria-selected={tab === t.key} onclick={() => setTab(t.key)}>
			{t.label}{#if t.key === 'submissions'}<span class="count">{data.submissionTotal.toLocaleString()}</span>{/if}
		</button>
	{/each}
</div>

{#if tab === 'questions'}
	<div class="doc">
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="title-card" class:focused={focusedId === 'title'} onclick={() => (focusedId = 'title')} onfocusin={() => (focusedId = 'title')}>
			{#if focusedId === 'title' && !readonly}
				<label><span class="sr">Title</span><input class="t-input" bind:value={spec.title} maxlength="200" placeholder="Form title" /></label>
				<label><span class="sr">Intro (Markdown)</span><textarea rows="3" bind:value={spec.intro_md} placeholder="Intro (optional, Markdown)" maxlength="5000"></textarea></label>
			{:else}
				<h2>{spec.title || 'Untitled form'}</h2>
				{#if spec.intro_md}<p class="muted intro">{spec.intro_md}</p>{/if}
			{/if}
			{#each [...(otherProblems.title ?? []), ...(otherProblems.intro_md ?? []), ...(otherProblems.fields ?? [])] as m, i (i)}<p class="err">{m}</p>{/each}
		</div>

		{#each spec.fields as f, i (f.id)}
			<div
				class="slot"
				class:over={overIdx === i && dragIdx !== null && dragIdx !== i}
				role="listitem"
				ondragover={(e) => {
					if (dragIdx === null) return;
					e.preventDefault();
					overIdx = i;
				}}
				ondrop={(e) => {
					e.preventDefault();
					drop(i);
				}}
			>
				<FieldCard
					bind:field={spec.fields[i]}
					index={i}
					count={spec.fields.length}
					pageNumber={pageNumberOf(i)}
					focused={focusedId === f.id}
					{readonly}
					problems={problemsByField[f.id] ?? []}
					lists={data.lists}
					topics={data.topics}
					{customFields}
					canCreateField={!readonly}
					onfieldcreated={fieldCreated}
					onfocus={() => (focusedId = f.id)}
					onmove={(d) => move(i, d)}
					onduplicate={() => duplicate(i)}
					ondelete={() => remove(i)}
					ondragstart={(e) => {
						dragIdx = i;
						e.dataTransfer?.setData('text/plain', f.id);
					}}
					ondragend={() => {
						dragIdx = null;
						overIdx = null;
					}}
				/>
				{#if focusedId === f.id && !readonly}
					<div class="rail" role="toolbar" aria-label="Add">
						<button type="button" title="Add question" aria-label="Add question" onclick={() => add('short_text')}><Icon name="add" size={16} /></button>
						<button type="button" title="Add rating" aria-label="Add rating" onclick={() => add('rating')}><Icon name="branding" size={16} /></button>
						<button type="button" title="Add heading" aria-label="Add heading" onclick={() => add('heading')}><Icon name="heading" size={16} /></button>
						<button type="button" title="Add paragraph" aria-label="Add paragraph" onclick={() => add('paragraph')}><Icon name="text" size={16} /></button>
						<button type="button" title="Add page break" aria-label="Add page break" onclick={() => add('page_break')}><Icon name="divider" size={16} /></button>
					</div>
				{/if}
			</div>
		{/each}

		{#if !readonly}
			<div class="add-row">
				<button type="button" class="secondary" onclick={() => { focusedId = spec.fields.at(-1)?.id ?? null; add('short_text'); }}><Icon name="add" size={16} /> Add question</button>
				<button type="button" class="secondary" onclick={() => { focusedId = spec.fields.at(-1)?.id ?? null; add('rating'); }}>Rating</button>
				<button type="button" class="secondary" onclick={() => { focusedId = spec.fields.at(-1)?.id ?? null; add('heading'); }}>Heading</button>
				<button type="button" class="secondary" onclick={() => { focusedId = spec.fields.at(-1)?.id ?? null; add('paragraph'); }}>Paragraph</button>
				<button type="button" class="secondary" onclick={() => { focusedId = spec.fields.at(-1)?.id ?? null; add('page_break'); }}>Page break</button>
			</div>
		{/if}
	</div>
{:else if tab === 'logic'}
	<FormLogicTab
		bind:spec
		{readonly}
		{problems}
		lists={data.lists}
		topics={data.topics}
		users={data.users}
		tags={data.tags}
		automations={data.activeAutomations}
		{customFields}
		onfieldcreated={fieldCreated}
	/>
{:else if tab === 'style'}
	<FormStyleTab bind:spec {readonly} {logoSrc} appName={branding.appName} />
{:else if tab === 'settings'}
	<FormSettingsTab
		bind:spec
		bind:slug
		bind:slugAuto
		{name}
		baseUrl={data.baseUrl}
		{readonly}
		lists={data.lists}
		topics={data.topics}
		users={data.users}
		webhookSecret={data.webhookSecret}
		{customFields}
		onfieldcreated={fieldCreated}
		problems={otherProblems}
	/>
	<!-- #516: the automations this form starts + "Create automation" (a draft). -->
	<FormAutomationsCard automations={data.automations} enroll={spec.settings.enroll} />
	{#if data.isAdmin}<FormScoringCard formId={data.form.id} rules={data.scoreRules} />{/if}
{:else if tab === 'share'}
	<!-- #515: allowed origins (saved with Save) + embed / link / merge tag / raw HTML snippets. -->
	<FormShareTab
		bind:spec
		slug={data.form.slug}
		name={data.form.name}
		baseUrl={data.baseUrl}
		published={data.form.status === 'published'}
		{readonly}
		problems={otherProblems['settings.allowed_origins'] ?? []}
	/>
{:else}
	<section class="subs">
		<form method="GET" class="filters">
			<input type="hidden" name="tab" value="submissions" />
			<label>Show
				<select name="status" value={data.filter.status === 'ok' ? '' : data.filter.status}>
					<option value="">Submissions</option>
					<option value="hidden">Spam & rejected</option>
					<option value="held">Held (daily send limit)</option>
				</select>
			</label>
			<label>From <input type="date" name="from" value={data.filter.from ?? ''} /></label>
			<label>To <input type="date" name="to" value={data.filter.to ?? ''} /></label>
			<label class="q">Search <input type="search" name="q" value={data.filter.q ?? ''} placeholder="Email or answer" /></label>
			<button type="submit" class="secondary">Filter</button>
			<span class="grow"></span>
			<a class="export-btn" href={csvHref} download><Icon name="export" size={16} /> Export CSV</a>
		</form>
		{#if data.heldCount > 0}
			<div class="notice warn held-note" role="status">
				<span>{data.heldCount.toLocaleString()} held: this form reached its daily send limit ({spec.settings.daily_send_cap.toLocaleString()}). Nothing has been sent for {data.heldCount === 1 ? 'it' : 'them'}, unless a row says a confirmation email was sent.</span>
				{#if data.filter.status !== 'held'}<a href={subQuery({ status: 'held', page: null })}>Review held</a>{/if}
				{#if data.isAdmin}
					<form method="POST" action="?/releaseHeld" use:enhance={releaseAllEnhance}>
						<button type="submit" class="secondary small" disabled={heldBusy}>{heldNote && heldNote.remaining > 0 ? 'Release the next ones' : 'Release all'}</button>
					</form>
					<form method="POST" action="?/discardHeld" use:enhance={discardEnhance}>
						<button type="submit" class="secondary small" disabled={heldBusy}>Discard all held</button>
					</form>
				{/if}
			</div>
		{/if}
		{#if heldNote}<p class="small {heldNote.failed ? 'err' : 'muted'}" role="status">{heldNoteText(heldNote)}</p>{/if}
		{#if heldError}<p class="err" role="alert">{heldError}</p>{/if}
		<p class="muted small">{data.submissionTotal.toLocaleString()} {data.filter.status === 'hidden' ? 'spam / rejected' : data.filter.status === 'held' ? 'held' : 'submissions'}{data.submissionTotal > 5000 ? ' · the CSV holds the newest 5,000' : ''}. Kept {spec.settings.retention_days} days.</p>
		{#if data.submissions.length === 0}
			<p class="muted">Nothing here yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Date (UTC)</th>
							<th>Contact</th>
							{#each firstThree as f (f.id)}<th>{f.label || f.key}</th>{/each}
							<th>Status</th>
							{#if data.isAdmin}<th></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each data.submissions as s (s.id)}
							<tr>
								<td class="nowrap">{s.created_at}</td>
								<td>
									{#if s.contact_id}<a href="/contacts/{s.contact_id}">{s.contact_name ?? s.email}</a>
									{:else}<span class="muted">{s.email ?? '—'}</span>{/if}
								</td>
								{#each firstThree as f (f.id)}<td class="ans">{answerText(s.answers[f.key], f) || '—'}</td>{/each}
								<td>
									{#if s.held}<span class="badge sending" title={s.detail ?? ''}>Held</span>
										{#each heldInfo(s.detail) as line, i (i)}<div class="muted small">{line}</div>{/each}
									{:else}<span class="badge {s.status === 'spam' || s.status === 'rejected' ? 'failed' : 'draft'}" title={s.detail ?? ''}>{statusText[s.status] ?? s.status}</span>{/if}
								</td>
								{#if data.isAdmin}
									<td class="right">
										{#if s.held}
											<form method="POST" action="?/releaseSubmission" use:enhance={releaseOneEnhance}>
												<input type="hidden" name="submission_id" value={s.id} />
												<button type="submit" class="secondary small" aria-label="Release submission {s.id}">Release</button>
											</form>
										{/if}
										<form method="POST" action="?/deleteSubmission" use:enhance={({ cancel }) => { if (!confirm('Delete this submission?')) cancel(); }}>
											<input type="hidden" name="submission_id" value={s.id} />
											<button type="submit" class="secondary small" aria-label="Delete submission {s.id}">Delete</button>
										</form>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if pages > 1}
				<nav class="pager" aria-label="Pages">
					{#if data.filter.page > 1}<a href={subQuery({ page: data.filter.page - 1 })}>Previous</a>{/if}
					<span class="muted">Page {data.filter.page} of {pages}</span>
					{#if data.filter.page < pages}<a href={subQuery({ page: data.filter.page + 1 })}>Next</a>{/if}
				</nav>
			{/if}
		{/if}
	</section>
{/if}

{#if dirty && !readonly}
	<div class="savebar" role="region" aria-label="Unsaved changes">
		<span>Unsaved changes{#if problems.length} · {problems.length} problem{problems.length === 1 ? '' : 's'}{/if}</span>
		<span class="muted small">{kbd('Mod+S')}</span>
		<button type="button" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
	</div>
{/if}

{#if previewOpen}
	<div class="preview-overlay" role="dialog" aria-modal="true" aria-label="Preview">
		<div class="preview-bar">
			<span>Preview{dirty ? ' (unsaved changes)' : ''} · submitting is off</span>
			<button type="button" class="secondary" onclick={() => (previewOpen = false)}><Icon name="close" size={16} /> Close</button>
		</div>
		<div class="preview-body">
			<FormRenderer spec={previewSpec} style={previewSpec.style} preview {logoSrc} appName={branding.appName} onanswers={(a) => (previewAnswers = a)} />
		</div>
		{#if whyHidden.length}
			<details class="why-hidden">
				<summary>Why hidden? {whyHidden.length} item{whyHidden.length === 1 ? '' : 's'} hidden by logic</summary>
				<ul>
					{#each whyHidden as h (h.id)}<li><strong>{h.name}</strong>: {h.why}</li>{/each}
				</ul>
			</details>
		{/if}
	</div>
{/if}

<style>
	.ed-head { display: flex; align-items: center; gap: var(--space-s); flex-wrap: wrap; margin-bottom: var(--space-s); }
	.name input { font-size: var(--size-l); line-height: var(--line-l); font-weight: var(--weight-ui-medium); border-color: transparent; background: transparent; padding-left: var(--space-xxs); min-width: 0; width: min(28ch, 70vw); }
	.name input:hover:not(:disabled), .name input:focus { border-color: var(--border); background: var(--surface); }
	.live { font-family: var(--font-mono); font-size: var(--size-s); display: inline-flex; align-items: center; gap: var(--space-xxs); }
	.grow { flex: 1; }
	.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.icon { padding-left: var(--space-xs); padding-right: var(--space-xs); }
	.menu-wrap { position: relative; }
	.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; background: var(--surface); box-shadow: var(--border-shadow-s), 0 8px 24px rgb(0 0 0 / 0.12); border-radius: var(--radius); padding: var(--space-xxs); min-width: 160px; display: flex; flex-direction: column; }
	.menu form { margin: 0; }
	.mi { width: 100%; text-align: left; background: none; border: 0; color: var(--text); padding: var(--space-xs) var(--space-s); border-radius: var(--radius-xs); cursor: pointer; font-size: var(--size-s); }
	.mi:hover { background: var(--surface-subtle); }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); }
	.tabs { display: flex; gap: var(--space-m); margin: var(--space-s) 0 var(--space-l); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted); overflow-x: auto; }
	.tab { background: none; border: 0; border-radius: 0; padding: var(--space-xs) 0; color: var(--muted); font-size: var(--size-s); cursor: pointer; min-height: 0; display: inline-flex; align-items: center; gap: var(--space-xxs); }
	.tab[aria-selected='true'] { color: var(--text); box-shadow: inset 0 calc(-1 * var(--border-l)) 0 var(--btn-primary-bg); }
	.count { font-size: var(--size-xs); line-height: var(--line-xs); color: var(--muted); background: var(--surface-subtle); box-shadow: var(--border-shadow-s); border-radius: var(--radius-full); padding: 0 var(--space-xs); font-variant-numeric: tabular-nums; }
	.doc { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-s); padding-bottom: 96px; }
	.title-card { background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--border-shadow-s); padding: var(--space-m); display: flex; flex-direction: column; gap: var(--space-s); cursor: pointer; transition: box-shadow 150ms ease; }
	.title-card:not(.focused):hover { box-shadow: 0 0 0 var(--border-s) var(--neutral-5); }
	.title-card.focused { cursor: default; box-shadow: 0 0 0 var(--border-s) var(--btn-primary-bg), var(--shadow-m); }
	@media (prefers-reduced-motion: reduce) { .title-card { transition: none; } }
	.title-card label { display: flex; }
	.title-card input, .title-card textarea { width: 100%; }
	.t-input { font-size: var(--size-l); }
	.title-card h2 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); }
	.intro { margin: 0; white-space: pre-wrap; font-size: var(--size-s); }
	.err { color: var(--danger); margin: 0; font-size: var(--size-s); }
	.slot { position: relative; }
	.slot.over::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; height: 3px; border-radius: 2px; background: var(--btn-primary-bg); }
	.rail { display: flex; gap: var(--space-xxs); margin-top: var(--space-xs); justify-content: flex-end; }
	@media (min-width: 1100px) {
		.rail { position: absolute; left: calc(100% + var(--space-s)); top: 0; flex-direction: column; margin: 0; background: var(--surface); box-shadow: var(--border-shadow-s); border-radius: var(--radius); padding: var(--space-xxs); }
	}
	.rail button { background: var(--surface); color: var(--text); border: 0; box-shadow: var(--border-shadow-s); padding: var(--space-xs); min-height: 0; border-radius: var(--radius-xs); display: inline-flex; }
	@media (min-width: 1100px) { .rail button { box-shadow: none; } }
	.rail button:hover { background: var(--surface-subtle); }
	.add-row { display: flex; gap: var(--space-xs); flex-wrap: wrap; justify-content: center; margin-top: var(--space-s); }
	.subs { display: flex; flex-direction: column; gap: var(--space-s); }
	.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-s); }
	.filters label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); }
	.filters .q { flex: 1 1 200px; }
	.export-btn { display: inline-flex; align-items: center; gap: var(--space-xxs); font-size: var(--size-s); }
	.nowrap { white-space: nowrap; }
	.ans { max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.right { text-align: right; }
	.right form { margin: 0; display: inline-block; }
	.held-note { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); }
	.held-note form { margin: 0; }
	.pager { display: flex; gap: var(--space-m); align-items: center; font-size: var(--size-s); }
	.savebar { position: sticky; bottom: var(--space-s); margin: var(--space-l) auto 0; max-width: 720px; display: flex; align-items: center; gap: var(--space-s); background: var(--surface); box-shadow: var(--border-shadow-s), 0 8px 24px rgb(0 0 0 / 0.12); border-radius: var(--radius-lg); padding: var(--space-xs) var(--space-xs) var(--space-xs) var(--space-m); z-index: 15; font-size: var(--size-s); }
	.savebar button { margin-left: auto; }
	.preview-overlay { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; background: var(--bg); }
	.preview-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); padding: var(--space-xs) var(--space-m); background: var(--surface); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted); font-size: var(--size-s); }
	.preview-body { flex: 1; overflow: auto; }
	.why-hidden { background: var(--surface); box-shadow: inset 0 var(--border-s) 0 var(--border-muted); padding: var(--space-xs) var(--space-m); font-size: var(--size-s); max-height: 30vh; overflow: auto; }
	.why-hidden summary { cursor: pointer; }
	.why-hidden ul { margin: var(--space-xs) 0 0; padding-left: var(--space-m); }
</style>

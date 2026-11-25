<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { enhance } from '$app/forms';
	import { viewEmailHref } from '$lib/view-email-href';
	import ConversationThread from '$lib/components/ConversationThread.svelte';
	import CompanyPicker from '$lib/components/CompanyPicker.svelte';
	import TimingStats from '$lib/components/TimingStats.svelte';
	import { relTime } from '$lib/reltime';
	import TierBadge from '$lib/components/TierBadge.svelte';
	import ScoresCard from '$lib/components/ScoresCard.svelte';
	import RatingsCard from '$lib/components/RatingsCard.svelte';
	import FormsCard from '$lib/components/forms/FormsCard.svelte';
	import EngagementSparkline from '$lib/components/EngagementSparkline.svelte';
	import { TIERS, TIER_LABELS, bestTimeText } from '$lib/engagement-view';
	import { TIER_OVERRIDE_DAYS_MAX, tierSourceText, untilDate } from '$lib/tier-override';
	import StagePill from '$lib/components/StagePill.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import { daysSince, formatValue, historyByText, historyMoveText } from '$lib/pipeline';
	import { completedReasonText, timelineText } from '$lib/automation-flow';
	import SubscriptionControl from '$lib/components/SubscriptionControl.svelte';
	import { NO_VALUE, YES_VALUE, displayValue, labelFromKey, type FieldOption } from '$lib/custom-fields';
	let { data, form } = $props();
	// Engagement card (#114).
	const eng = $derived(data.engagement);
	// #460: the "Set tier…" form starts on the current tier.
	let tierChoice = $state<string>('hot');
	$effect(() => {
		tierChoice = data.engagement.tier;
	});
	const bestTime = $derived(bestTimeText(eng.best_hour_utc, eng.best_dow, eng.tz_offset_guess, eng.tz_confidence));
	const c = $derived(data.contact);
	const name = $derived(c.name || [c.first_name, c.last_name].filter(Boolean).join(' '));
	// #507: the badge tooltip — the latest unsubscribes row (reason + detail, date).
	const subTitle = $derived.by(() => {
		const u = data.unsubs[0];
		if (c.subscribed || !u) return undefined;
		const why = [u.reason, u.detail ? `(${u.detail})` : ''].filter(Boolean).join(' ');
		return `Unsubscribed ${u.created_at.slice(0, 10)}${why ? ` · ${why}` : ''}`;
	});

	let editingDetails = $state(false);
	let editingField = $state<string | null>(null);
	let addingField = $state(false);
	// #619: the "+ Add field" pick — a defined field's key, '' = a new free-form key.
	let addKey = $state('');
	const addField = $derived(data.addableFields.find((f) => f.key === addKey));

	// Avatar (#105) — cache-bust after a manual refresh with a bumped nonce query param.
	let avatarNonce = $state(0);
	async function refreshAvatar() {
		await fetch(`/api/avatar/${c.id}?refresh=1`);
		avatarNonce += 1;
	}

	function pct(n: number, d: number): string {
		if (!d) return '—';
		return `${Math.round((n / d) * 100)}%`;
	}
	function actVerb(kind: string): string {
		return ({ open: 'Opened', click: 'Clicked', bounce: 'Bounced', spam: 'Marked spam', unsubscribe: 'Unsubscribed', delivery: 'Delivered', reply: 'Replied', added: 'Added', snapshot_approved: 'Approved snapshot', visited: 'Visited', site_event: 'Did', pipeline: 'Pipeline', scanner_click: 'Link scanned by security software', unsubscribe_click: 'Viewed the unsubscribe page' } as Record<string, string>)[kind] ?? kind;
	}
	type Enrollment = (typeof data.enrollments)[number];
	function stepSummary(e: Enrollment): string {
		if (!e.step_type) return 'finishing';
		if (e.step_type === 'email') return e.step_subject || '(email)';
		if (e.step_type === 'tag') {
			return `${e.step_tag_action === 'remove' ? 'remove' : 'add'} tag "${e.step_tag_name ?? ''}"`;
		}
		return e.step_type; // branch / gate / end
	}
	function actClass(kind: string): string {
		if (kind === 'open' || kind === 'click' || kind === 'reply' || kind === 'snapshot_approved' || kind === 'site_event') return 'good';
		if (kind === 'bounce' || kind === 'spam' || kind === 'unsubscribe') return 'bad';
		return 'neutral';
	}

	// Email history pager (#107) — mirrors /contacts's (#94) pager, but this page has no
	// other query params to carry along (just ?hpage=).
	const historyFrom = $derived(data.historyTotal === 0 ? 0 : (data.historyPage - 1) * data.historyPer + 1);
	const historyTo = $derived(Math.min(data.historyPage * data.historyPer, data.historyTotal));

	// Pipeline card (#206).
	const pc = $derived(data.pipeline.card);
	// History wording (incl. a stage deletion's from = to "Moved to …" row) is shared with the
	// Activity timeline and the dashboard feed (#207) — see $lib/pipeline.
	const pipelineEnhance = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => update({ reset: false });
</script>

<svelte:head><title>{c.email}</title></svelte:head>

<Breadcrumbs items={[{ label: 'Contacts', href: '/contacts' }, { label: name || c.email }]} />

{#if c.archived_at}
	<!-- #280: archived — hidden from views and never sent to; history kept. -->
	<p class="archived-banner" role="status">
		<Icon name="alert" size={16} />
		Archived on {c.archived_at.slice(0, 10)}. This contact is hidden from lists and never sent to. Restore to bring them back.
	</p>
{/if}

<div class="contact-header">
	<img
		class="contact-avatar"
		src="/api/avatar/{c.id}?t={avatarNonce}"
		alt=""
		width="64"
		height="64"
		loading="lazy"
		decoding="async"
	/>
	<div class="contact-header-main">
		<div class="head">
			<h1>{name || c.email}</h1>
			<!-- #507 control; #510 adds its Pending confirmation state (double opt-in). -->
			<SubscriptionControl
				subscribed={!!c.subscribed}
				email={c.email}
				title={subTitle}
				error={form?.subError ?? null}
				note={form?.subNote ?? null}
				pending={!!c.confirm_pending}
				confirmation={data.confirmation}
				confirmError={form?.confirmError ?? null}
				confirmOk={form?.confirmOk ?? null}
			/>
			<a class="email-btn" href="/compose?to={encodeURIComponent(c.email)}&direct=1">Email this person</a>
			<button class="secondary edit-btn" onclick={() => (editingDetails = !editingDetails)}>
				{editingDetails ? 'Close' : 'Edit'}
			</button>
			<!-- #571: the badge's Unsubscribe / Resubscribe step as a plain button (hidden while pending). -->
			<SubscriptionControl variant="button" subscribed={!!c.subscribed} email={c.email} pending={!!c.confirm_pending} />
			<form
				method="POST"
				action="?/setArchived"
				class="archive-form"
				use:enhance={({ cancel }) => {
					if (!c.archived_at && !confirm('Archive this contact? They’re hidden from views and never sent to. Their history is kept and you can restore them.')) cancel();
					return async ({ update }) => update({ reset: false });
				}}
			>
				<input type="hidden" name="archive" value={c.archived_at ? '0' : '1'} />
				<button type="submit" class="secondary">{c.archived_at ? 'Restore' : 'Archive'}</button>
			</form>
		</div>
		<p class="muted meta">
			{#if name}{c.email} · {/if}
			{#if c.company}{#if c.company_id}<a href="/companies/{c.company_id}"><strong>{c.company}</strong></a>{:else if data.companyGroupId}<a href="/lists/{data.companyGroupId}"><strong>{c.company}</strong></a>{:else}<strong>{c.company}</strong>{/if} · {/if}
			{#if c.source}from <strong>{c.source}</strong> · {/if}
			added {c.created_at} UTC
		</p>
		{#if data.companyGithub}
			{@const g = data.companyGithub}
			<p class="muted gh-line">
				<a href="/companies/{c.company_id}#integrations">GitHub</a>:
				Open issues {g.issues_open ?? 0} · closed 30d {g.issues_closed_30d ?? 0}{#if g.last_issue_at}
				· last activity {relTime(g.last_issue_at)}{/if}
			</p>
		{/if}
		<button type="button" class="link-btn" onclick={refreshAvatar}>Refresh avatar</button>
	</div>
</div>

{#if data.companyCard}
	<!-- Company card (#168): hidden when the contact has no linked company. -->
	<section class="card company-card">
		<h2>Company · <a href="/companies/{data.companyCard.id}">{data.companyCard.name}</a></h2>
		{#if data.companyCard.timing?.project_id}
			<p class="muted company-proj">Timing · {data.companyCard.timing.project_name ?? data.companyCard.timing.project_id}</p>
			<TimingStats timing={data.companyCard.timing} />
		{:else}
			<p class="muted company-proj">No Timing project attached.</p>
		{/if}
	</section>
{/if}

{#if editingDetails}
	<form
		method="POST"
		action="?/updateDetails"
		use:enhance={() =>
			async ({ update, result }) => {
				await update({ reset: false });
				if (result.type === 'success') editingDetails = false;
			}}
		class="card detail-edit"
	>
		<div class="de-row">
			<label class="field"><span>Email</span><input name="email" type="email" value={c.email} required /></label>
			<label class="field"><span>Company / Org{#if c.company_id}{' '}· <a href="/companies/{c.company_id}">view company</a>{/if}</span><CompanyPicker name="company" value={c.company ?? ''} /></label>
		</div>
		<div class="de-row">
			<label class="field"><span>Full name</span><input name="name" value={c.name ?? ''} placeholder="optional" /></label>
			<label class="field"><span>First name</span><input name="first_name" value={c.first_name ?? ''} placeholder="optional" /></label>
			<label class="field"><span>Last name</span><input name="last_name" value={c.last_name ?? ''} placeholder="optional" /></label>
		</div>
		{#if form?.detailError}<p class="de-error">{form.detailError}</p>{/if}
		<div class="de-actions">
			<button type="submit">Save details</button>
			<button type="button" class="secondary" onclick={() => (editingDetails = false)}>Cancel</button>
		</div>
	</form>
{/if}

{#if data.memberships.length > 0}
	<p class="chips">
		{#each data.memberships as m (m.id)}
			<span class="chip" class:seg={m.kind === 'segment'} class:archived={!!m.archived_at}
				>{m.name}{#if m.archived_at} <span class="archived-pill">archived</span>{/if}</span
			>
		{/each}
	</p>
{/if}

<div class="tags-row">
	{#each data.tags as t (t.id)}
		<span class="tag">
			{t.name}
			<form method="POST" action="?/removeTag" use:enhance class="tag-x-form">
				<input type="hidden" name="tag_id" value={t.id} />
				<button type="submit" class="tag-x" title="Remove tag" aria-label="Remove tag {t.name}"><Icon name="close" size={14} /></button>
			</form>
		</span>
	{/each}
	<form method="POST" action="?/addTag" use:enhance class="tag-add">
		<input name="tag" placeholder="+ add tag" list="tag-options" aria-label="Add a tag" autocomplete="off" />
		<datalist id="tag-options">
			{#each data.tagOptions as opt (opt)}<option value={opt}></option>{/each}
		</datalist>
	</form>
</div>
{#if form?.tagError}<p class="tag-error">{form.tagError}</p>{/if}

<section class="card formdata">
	<h2>Custom fields</h2>
	{#if data.formData.length === 0 && data.definedFields.length === 0}
		<p class="muted fd-empty">
			Nothing here yet. Fields sent by a form or webhook (e.g. project type, budget) show up
			automatically — or add your own.
		</p>
	{/if}
	<!-- #619: defined fields this contact has a value for (Settings → Custom fields order), typed inputs. -->
	{#each data.definedFields as f (f.key)}
		{#if editingField === `def:${f.key}`}
			<form
				method="POST"
				action="?/setField"
				use:enhance={() =>
					async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') editingField = null;
					}}
				class="fd-editrow"
			>
				<input type="hidden" name="field_name" value={f.key} />
				<input type="hidden" name="typed" value="1" />
				<label class="fd-name" for="fd-{f.key}">{f.label}</label>
				{@render typedInput(f, f.value, `fd-${f.key}`, false)}
				<button type="submit" class="secondary fd-btn">Save</button>
				<button type="button" class="secondary fd-btn" onclick={() => (editingField = null)}>Cancel</button>
			</form>
		{:else}
			<div class="fd-row">
				<span class="fd-name">{f.label}{#if f.archived} <span class="fd-arch">(archived)</span>{/if}</span>
				<span class="fd-val">{displayValue(f.type, f.value)}</span>
				<span class="fd-actions">
					<button type="button" class="fd-act" title="Edit {f.label}" aria-label="Edit {f.label}" onclick={() => (editingField = `def:${f.key}`)}><Icon name="edit" size={14} /></button>
					<form method="POST" action="?/removeField" use:enhance class="inlineform">
						<input type="hidden" name="field_name" value={f.key} />
						<button type="submit" class="fd-act fd-del" title="Remove {f.label}" aria-label="Remove {f.label}"><Icon name="close" size={14} /></button>
					</form>
				</span>
			</div>
		{/if}
	{/each}
	{#each data.formData as [k, v] (k)}
		{#if editingField === k}
			<form
				method="POST"
				action="?/setField"
				use:enhance={() =>
					async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') editingField = null;
					}}
				class="fd-editrow"
			>
				<input type="hidden" name="field_name" value={k} />
				<span class="fd-name">{labelFromKey(k)}</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input class="fd-input" name="field_value" value={v} autofocus />
				<button type="submit" class="secondary fd-btn">Save</button>
				<button type="button" class="secondary fd-btn" onclick={() => (editingField = null)}>Cancel</button>
			</form>
		{:else}
			<div class="fd-row">
				<span class="fd-name">{labelFromKey(k)}</span>
				<span class="fd-val">{v}</span>
				<span class="fd-actions">
					<button type="button" class="fd-act" title="Edit {k}" aria-label="Edit {k}" onclick={() => (editingField = k)}><Icon name="edit" size={14} /></button>
					<form method="POST" action="?/removeField" use:enhance class="inlineform">
						<input type="hidden" name="field_name" value={k} />
						<button type="submit" class="fd-act fd-del" title="Remove {k}" aria-label="Remove {k}"><Icon name="close" size={14} /></button>
					</form>
				</span>
			</div>
		{/if}
	{/each}

	{#if addingField}
		<form
			method="POST"
			action="?/setField"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') addingField = false;
				}}
			class="fd-editrow fd-addrow"
		>
			<!-- #619: a defined field without a value here (picked by label, typed input), or a new key. -->
			{#if data.addableFields.length}
				<!-- svelte-ignore a11y_autofocus -->
				<select class="fd-input fd-addpick" aria-label="Field" bind:value={addKey} autofocus>
					<option value="">New field (type a name)…</option>
					<optgroup label="Defined fields">
						{#each data.addableFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
					</optgroup>
				</select>
			{/if}
			{#if addField}
				<input type="hidden" name="field_name" value={addField.key} />
				<input type="hidden" name="typed" value="1" />
				<label class="fd-name" for="fd-add">{addField.label}</label>
				{#key addField.key}{@render typedInput(addField, '', 'fd-add', true)}{/key}
			{:else}
				<!-- svelte-ignore a11y_autofocus -->
				<input class="fd-input fd-keyin" name="field_name" placeholder="Field name — e.g. budget" autocomplete="off" autofocus={!data.addableFields.length} required />
				<input class="fd-input" name="field_value" placeholder="Value — e.g. $5k/mo" autocomplete="off" />
			{/if}
			<button type="submit" class="secondary fd-btn">Add</button>
			<button type="button" class="secondary fd-btn" onclick={() => (addingField = false)}>Cancel</button>
		</form>
	{:else}
		<button
			type="button"
			class="fd-addlink"
			onclick={() => {
				addKey = '';
				addingField = true;
			}}>+ Add field</button
		>
	{/if}
	{#if form?.fieldError}<p class="fd-error">{form.fieldError}</p>{/if}
</section>

<!-- #619: the value input for a defined field's type. `required` on the add row: an empty pick adds nothing. -->
{#snippet typedInput(f: FieldOption, value: string, id: string, required: boolean)}
	{#if f.type === 'yes_no'}
		<select {id} class="fd-input" name="field_value" value={value === YES_VALUE || value === NO_VALUE ? value : ''} {required}>
			<option value="">—</option><option value={YES_VALUE}>Yes</option><option value={NO_VALUE}>No</option>
		</select>
	{:else if f.type === 'choice'}
		<select {id} class="fd-input" name="field_value" {value} {required}>
			<option value="">—</option>
			{#each f.options as o (o)}<option value={o}>{o}</option>{/each}
			{#if value && !f.options.includes(value)}<option {value}>{value}</option>{/if}
		</select>
	{:else}
		<!-- svelte-ignore a11y_autofocus -->
		<input {id} class="fd-input" name="field_value" {value} {required} autofocus={!required} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step={f.type === 'number' ? 'any' : undefined} />
	{/if}
{/snippet}

<StatGroup label="Email summary">
	<StatCell label="Emails sent" value={data.summary.sent} />
	<StatCell label="Opened" value={data.summary.opened} sub="{pct(data.summary.opened, data.summary.sent)} of sent" />
	<StatCell label="Clicked" value={data.summary.clicked} sub="{pct(data.summary.clicked, data.summary.sent)} of sent" />
</StatGroup>

<section class="card automations">
	<h2>Automations</h2>

	<form
		method="POST"
		action="?/enrollInAutomation"
		class="enroll-inline"
		use:enhance={() =>
			async ({ update }) => {
				await update({ reset: false });
			}}
	>
		<select name="automation_id" required disabled={data.activeAutomations.length === 0}>
			{#if data.activeAutomations.length === 0}
				<option value="">No active automations</option>
			{:else}
				<option value="">Enroll in automation…</option>
				{#each data.activeAutomations as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
			{/if}
		</select>
		<button type="submit" disabled={data.activeAutomations.length === 0}>Enroll</button>
	</form>

	{#if form?.enrollError}<p class="err">{form.enrollError}</p>{/if}
	{#if form?.enrollSuccess}
		{#if form.enrollEnrolled > 0}
			<p class="ok">Enrolled into <a href="/automations/{form.enrollId}">{form.enrollName}</a>.</p>
		{:else if form.enrollReason === 'archived'}
			<p class="muted">Not enrolled. This contact is archived.</p>
		{:else if form.enrollReason === 'unsubscribed'}
			<p class="muted">Not enrolled. This contact is unsubscribed. Resubscribe them first with the Resubscribe button at the top of this page.</p>
		{:else if form.enrollReason === 'active'}
			<div class="enroll-blocked">
				<p class="muted">Not enrolled. They are already going through <a href="/automations/{form.enrollId}">{form.enrollName}</a>.</p>
				<form
					method="POST"
					action="?/enrollInAutomation"
					use:enhance={() =>
						async ({ update }) => {
							await update({ reset: false });
						}}
				>
					<input type="hidden" name="automation_id" value={form.enrollId} />
					<input type="hidden" name="force" value="1" />
					<input type="hidden" name="restart" value="1" />
					<button type="submit" title="End their current run and start a new one at the first step">Restart from the first step</button>
				</form>
			</div>
		{:else if form.enrollReason === 'once'}
			<div class="enroll-blocked">
				<p class="muted">
					Not enrolled. They already went through <a href="/automations/{form.enrollId}">{form.enrollName}</a>, and it only takes each contact once.
				</p>
				<form
					method="POST"
					action="?/enrollInAutomation"
					use:enhance={() =>
						async ({ update }) => {
							await update({ reset: false });
						}}
				>
					<input type="hidden" name="automation_id" value={form.enrollId} />
					<input type="hidden" name="force" value="1" />
					<button type="submit" title="Start a new run even though this automation takes each contact once">Enroll again</button>
				</form>
			</div>
		{:else if form.enrollReason === 'conditions'}
			<div class="enroll-blocked">
				<p class="muted">Not enrolled. They don't match the contact conditions on <a href="/automations/{form.enrollId}">{form.enrollName}</a>.</p>
				<form
					method="POST"
					action="?/enrollInAutomation"
					use:enhance={() =>
						async ({ update }) => {
							await update({ reset: false });
						}}
				>
					<input type="hidden" name="automation_id" value={form.enrollId} />
					<input type="hidden" name="force" value="1" />
					<input type="hidden" name="ignore_entry" value="1" />
					<button type="submit" title="Ignore contact conditions for this enroll">Enroll anyway</button>
				</form>
			</div>
		{:else}
			<p class="muted">Not enrolled in <a href="/automations/{form.enrollId}">{form.enrollName}</a>.</p>
		{/if}
	{/if}

	{#if data.enrollments.length > 0}
		<ul class="auto-list">
			{#each data.enrollments as e (e.id)}
				<li>
					<div class="auto-head">
						<a class="auto-name" href="/automations/{e.automation_id}">{e.automation_name}</a>
						{#if e.status === 'active'}<span class="badge sent">Active</span>
						{:else if e.status === 'completed'}<span class="badge sent">Completed</span>
						{:else if e.status === 'cancelled'}<span class="badge draft">Cancelled</span>
						{:else}<span class="badge failed">Failed</span>{/if}
					</div>
					{#if e.status === 'active'}
						<p class="auto-detail muted">
							at: {stepSummary(e)}{#if e.next_run_at}{' '}· next run {e.next_run_at} UTC{/if}
						</p>
					{:else}
						<p class="auto-detail muted">
							went through {e.enrolled_at} → {e.ended_at ?? e.enrolled_at} UTC{#if e.completed_reason}{' '}· {completedReasonText(e.completed_reason)}{/if}
						</p>
						{#if e.status === 'failed' && e.last_error}
							<p class="auto-err muted">{e.last_error}</p>
						{/if}
					{/if}
					{#if data.enrollmentTimeline[e.id]?.length}
						<!-- #397: the pass's full path, with timestamps. -->
						<details class="auto-path">
							<summary class="muted">Path ({data.enrollmentTimeline[e.id].length} events)</summary>
							<ol>
								{#each data.enrollmentTimeline[e.id] as ev, i (i)}
									{@const title = ev.step_id !== null ? (data.timelineStepTitles[ev.step_id] ?? '(deleted step)') : null}
									<li>
										<span class="muted">{ev.at} UTC</span>
										{timelineText(ev, ev.kind === 'enrolled' || ev.kind === 'reached' ? title : null)}
										{#if ev.kind !== 'enrolled' && ev.kind !== 'reached' && title}<span class="muted">· {title}</span>{/if}
									</li>
								{/each}
							</ol>
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">Not in any automation yet.</p>
	{/if}
</section>

<!-- #714: a suggestion's "Open deal" links to #pipeline. -->
<section class="card pipeline" id="pipeline">
	<h2>Pipeline</h2>
	{#if pc}
		<div class="pl-head">
			<StagePill name={pc.stage_name} color={pc.stage_color} />
			<span>{formatValue(pc.value)}</span>
			{#if pc.owner_login}<span class="muted">· @{pc.owner_login}</span>{/if}
			<span class="muted" title="{pc.entered_stage_at} UTC">· entered {daysSince(pc.entered_stage_at)} day{daysSince(pc.entered_stage_at) === 1 ? '' : 's'} ago</span>
		</div>
		{#if pc.note}<p class="pl-note">{pc.note}</p>{/if}
		<div class="pl-actions">
			<form method="POST" action="?/pipelineMove" use:enhance={pipelineEnhance} class="enroll-inline">
				<select name="stage_id" required aria-label="Move to stage">
					<option value="">Move to…</option>
					{#each data.pipelineStages.filter((s) => s.id !== pc.stage_id) as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
				</select>
				<button type="submit" class="secondary">Move</button>
			</form>
			{#if pc.stage_kind !== 'won'}
				<form method="POST" action="?/pipelineMark" use:enhance={pipelineEnhance}>
					<input type="hidden" name="kind" value="won" /><button type="submit" class="secondary">Mark won</button>
				</form>
			{/if}
			{#if pc.stage_kind !== 'lost'}
				<form method="POST" action="?/pipelineMark" use:enhance={pipelineEnhance}>
					<input type="hidden" name="kind" value="lost" /><button type="submit" class="secondary">Mark lost</button>
				</form>
			{/if}
			<form method="POST" action="?/pipelineRemove" use:enhance={pipelineEnhance}>
				<button type="submit" class="secondary pl-remove">Remove</button>
			</form>
		</div>
	{:else}
		<form method="POST" action="?/pipelineAdd" use:enhance={pipelineEnhance} class="enroll-inline">
			<select name="stage_id" required aria-label="Stage">
				{#each data.pipelineStages as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
			</select>
			<input name="value" inputmode="numeric" placeholder="Value (optional)" aria-label="Value" class="pl-value" autocomplete="off" />
			<button type="submit">Add to pipeline</button>
		</form>
	{/if}
	{#if form?.pipelineError}<p class="err">{form.pipelineError}</p>{/if}
	{#if data.pipeline.history.length > 0}
		<ul class="pl-history">
			{#each data.pipeline.history as h (h.id)}
				<li>
					<span title={h.note ?? undefined}>{historyMoveText(h)}</span>
					<span class="muted">{historyByText(h)} · <span title="{h.created_at} UTC">{relTime(h.created_at)}</span></span>
				</li>
			{/each}
		</ul>
	{/if}
	<p class="pl-link"><a href="/pipeline">Open the pipeline →</a></p>
</section>

{#if data.unsubs.length > 0}
	<section class="card danger-soft unsub">
		<h2>Unsubscribed</h2>
		{#each data.unsubs as u (u.created_at)}
			<p class="muted">
				<strong>{u.reason || 'No reason given'}</strong>
				{#if u.detail} — {u.detail}{/if}
				· {u.created_at} UTC
			</p>
		{/each}
	</section>
{/if}

<section class="card engagement">
	<!-- Engagement (#114): the contact_engagement rollup (#113) + 12 months of opens/clicks. -->
	<div class="eng-head">
		<h2>Engagement</h2>
		<TierBadge tier={eng.tier} score={eng.score} />
		<span class="eng-score"><strong>{eng.score}</strong><span class="muted"> / 100</span></span>
	</div>
	{#if eng.sent_count === 0 && eng.open_count === 0}
		<p class="muted eng-note">Nothing sent to this contact yet.</p>
	{:else}
		<dl class="eng-stats">
			<div><dt>Sent</dt><dd>{eng.sent_count}</dd></div>
			<div><dt>Opens</dt><dd>{eng.open_count}{#if eng.open_rate != null}{' '}<span class="muted">· {Math.round(eng.open_rate * 100)}% of sends</span>{/if}</dd></div>
			<div><dt>Clicks</dt><dd>{eng.click_count}{#if eng.click_rate != null}{' '}<span class="muted">· {Math.round(eng.click_rate * 100)}% of sends</span>{/if}</dd></div>
			<div><dt>Replies</dt><dd>{eng.reply_count}</dd></div>
			<div><dt>Last activity</dt><dd>{eng.last_activity_at ? relTime(eng.last_activity_at) : '—'}</dd></div>
			{#if eng.proxy_open_share != null}
				<div title="Opens that look automatic (Apple Mail Privacy Protection or a similar prefetcher) — they count less toward the score.">
					<dt>Auto-opens</dt><dd>{Math.round(eng.proxy_open_share * 100)}% <span class="muted">of opens</span></dd>
				</div>
			{/if}
		</dl>
		{#if bestTime}
			<p class="eng-best">
				{bestTime.text[0].toUpperCase() + bestTime.text.slice(1)}
				<span class="muted">· {bestTime.zone === 'local' ? 'their time, guessed from location' : 'UTC'} · {bestTime.confidence} confidence</span>
			</p>
		{/if}
		{#if eng.top_client || eng.top_platform || eng.top_country}
			<p class="muted eng-top">
				{[
					eng.top_client && `Client: ${eng.top_client}`,
					eng.top_platform && `Platform: ${eng.top_platform}`,
					eng.top_country && `Country: ${eng.top_country}`
				]
					.filter(Boolean)
					.join(' · ')}
			</p>
		{/if}
		<EngagementSparkline points={eng.monthly} />
	{/if}
	<!-- #460: tier override — set by hand, an automation, the bulk bar, the assistant or the API. -->
	{#if eng.tier_override}
		<p class="eng-override">
			{TIER_LABELS[eng.tier_override]} set by {tierSourceText(eng.tier_override_source, data.tierSourceName)}
			{eng.tier_override_until ? `until ${untilDate(eng.tier_override_until)}` : 'until cleared'}
			<span class="muted">· automatic: {TIER_LABELS[eng.tier_auto]}</span>
		</p>
	{/if}
	<details class="eng-set">
		<summary>Set tier…</summary>
		<form method="POST" action="?/setTier" use:enhance class="eng-set-form">
			<label>
				<span class="muted">Tier</span>
				<select name="tier" bind:value={tierChoice}>
					{#each TIERS as t (t)}<option value={t}>{TIER_LABELS[t]}</option>{/each}
				</select>
			</label>
			<label>
				<span class="muted">For</span>
				<input type="number" name="days" min="1" max={TIER_OVERRIDE_DAYS_MAX} placeholder="until cleared" style="width: 8em" />
				<span class="muted">days</span>
			</label>
			<button type="submit" class="btn small">Set tier</button>
		</form>
		<p class="muted eng-note">Tiers are automatic; an override wins until it's cleared or its days run out. The automatic score keeps computing underneath.</p>
	</details>
	{#if eng.tier_override}
		<form method="POST" action="?/setTier" use:enhance class="inlineform">
			<input type="hidden" name="tier" value="clear" />
			<button type="submit" class="btn small">Back to automatic</button>
		</form>
	{/if}
	{#if form?.tierError}<p class="notice err" role="alert">{form.tierError}</p>{/if}
	{#if eng.stale}
		<p class="muted eng-note">Updating — the profile refreshes on the next heartbeat ticks.</p>
	{/if}
</section>

<!-- Scores (#466): custom scores from Settings → Scoring. -->
<ScoresCard scores={data.scores} isAdmin={data.isAdmin} {form} />

<!-- Ratings (#589): what they rated us through a form's Rating question; hidden when none. -->
{#if data.ratings.length}<RatingsCard ratings={data.ratings} />{/if}
{#if data.formSubmissions.length}<FormsCard submissions={data.formSubmissions} email={data.contact.email} />{/if}

<section class="card site-activity">
	<!-- Site activity (#153): from site_events; only known contacts are ever tracked. -->
	<div class="sa-head">
		<h2>Site activity</h2>
		<form method="POST" action="?/setTrackingOptout" use:enhance class="inlineform">
			<input type="hidden" name="optout" value={c.tracking_optout ? '0' : '1'} />
			<button type="submit" class="secondary sa-toggle">{c.tracking_optout ? 'Resume tracking' : 'Stop tracking'}</button>
		</form>
	</div>
	{#if c.tracking_optout}
		<p class="muted sa-note">Tracking is off for this contact — new site visits aren't recorded.</p>
	{/if}
	{#if form?.trackingError}<p class="err">{form.trackingError}</p>{/if}
	{#if data.siteActivity.lastSeen}
		<dl class="sa-stats">
			<div><dt>Last seen</dt><dd>{data.siteActivity.lastSeen} UTC</dd></div>
			<div><dt>Pageviews 30 d</dt><dd>{data.siteActivity.pageviews30d}</dd></div>
			{#if data.siteActivity.firstTouch}
				<div>
					<dt>First touch</dt>
					<dd>
						{Object.entries(data.siteActivity.firstTouch.utm).map(([k, v]) => `${k}: ${v}`).join(' · ')}
						<span class="muted">({data.siteActivity.firstTouch.at} UTC)</span>
					</dd>
				</div>
			{/if}
		</dl>
		{#if data.siteActivity.topPaths.length > 0}
			<h3 class="sa-sub">Top pages</h3>
			<ol class="sa-paths">
				{#each data.siteActivity.topPaths as p (p.path)}
					<li><span class="sa-path">{p.path}</span><span class="muted">{p.n}</span></li>
				{/each}
			</ol>
		{/if}
	{:else}
		<p class="muted sa-note">No site visits recorded yet.</p>
	{/if}
</section>

{#if data.activity.length > 0}
	<section class="card activity">
		<h2>Activity</h2>
		<ul class="act-list">
			{#each data.activity as a, i (i)}
				<li class:scanned={a.kind === 'scanner_click'}>
					<span class="act-dot {actClass(a.kind)}" aria-hidden="true"></span>
					<span class="act-main">
						<span class="act-verb">{actVerb(a.kind)}</span>
						{#if a.url}<a class="act-url" href={a.url} target="_blank" rel="noopener">{a.url}</a>
						{:else if a.campaign_id}<a href={viewEmailHref(a.campaign_id, { contactId: c.id })}>{a.label}</a>
						{:else if a.label}<span class="muted">{a.label}</span>{/if}
					</span>
					<span class="act-when muted">{a.at} UTC</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="card">
	<h2>Conversations</h2>
	{#if data.conversations.length === 0}
		<p class="muted">No emails sent to or received from this contact yet.</p>
	{:else}
		{#each data.conversations as conv (conv.key)}
			<ConversationThread {conv} />
		{/each}

		{#if data.historyTotal > 20}
			<nav class="pager">
				{#if data.historyPage > 1}
					<a class="pg" href="?hpage={data.historyPage - 1}" data-sveltekit-reset="false">← Prev</a>
				{:else}
					<span class="pg disabled">← Prev</span>
				{/if}
				<span class="muted pageinfo">Showing {historyFrom}–{historyTo} of {data.historyTotal}</span>
				{#if data.historyPage < data.historyPageCount}
					<a class="pg" href="?hpage={data.historyPage + 1}" data-sveltekit-reset="false">Next →</a>
				{:else}
					<span class="pg disabled">Next →</span>
				{/if}
			</nav>
		{/if}
	{/if}
</section>

<style>
	.contact-header { display: flex; gap: var(--space-m); align-items: flex-start; }
	.contact-avatar { border-radius: 50%; object-fit: cover; background: var(--surface-subtle); flex-shrink: 0; }
	.contact-header-main { flex: 1; min-width: 0; }
	.link-btn {
		background: none; border: none; padding: 0; font: inherit; color: var(--link);
		text-decoration: underline; text-decoration-color: var(--link-underline); text-decoration-thickness: var(--link-underline-thickness); text-underline-offset: var(--link-underline-offset); cursor: pointer; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none;
	}
	.link-btn:hover { background: none; box-shadow: none; color: var(--link-hover); text-decoration-thickness: var(--link-underline-thickness-hover); }
	/* #571: wraps so the subscription result note (or a long name) gets its own line, not a mid-word squeeze. */
	.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); }
	h1 { margin: 0; font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); word-break: break-word; }
	.email-btn {
		margin-left: auto;
		padding: var(--space-xs) var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		border-radius: var(--radius-s);
		color: var(--text);
		white-space: nowrap;
	}
	.email-btn:hover { text-decoration: none; background: color-mix(in srgb, var(--accent) 10%, transparent); }
	.edit-btn { padding: var(--space-xs) var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	@media (max-width: 640px) {
		.head { flex-wrap: wrap; gap: var(--space-s); }
		h1 { flex: 1 1 100%; }
		.email-btn { margin-left: 0; }
		.email-btn, .edit-btn { padding: var(--space-xxs) var(--space-s); }
	}
	.company-card { margin-bottom: var(--space-l); }
	.company-card h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.company-proj { margin: var(--space-xxs) 0 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.meta { margin: var(--space-xs) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); overflow-wrap: anywhere; }
	.gh-line { margin: calc(-1 * var(--space-s)) 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.detail-edit { display: flex; flex-direction: column; gap: var(--space-s); margin-bottom: var(--space-l); }
	.de-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--space-s); }
	.field { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.field > span { color: var(--muted); }
	.de-error { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0; }
	.de-actions { display: flex; gap: var(--space-xs); }
	.chips { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin: 0 0 var(--space-l); }
	.chip {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs); padding: var(--space-xxs) var(--space-xs); border-radius: var(--radius-full);
		background: var(--surface); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
	}
	.chip.seg { background: color-mix(in srgb, var(--accent) 12%, transparent); }
	/* #472: a membership in an archived list / segment stays visible, muted. */
	.chip.archived { color: var(--muted); }
	.archived-pill { margin-left: var(--space-xxs); padding: 0 var(--space-xxs); border-radius: var(--radius-xs); box-shadow: 0 0 0 var(--border-s) var(--border); font-size: var(--size-xs); }
	.tags-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin: 0 0 var(--space-l); }
	.tag {
		display: inline-flex; align-items: center; gap: var(--space-xxs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs); padding: var(--space-xxs) var(--space-xxs) var(--space-xxs) var(--space-xs); border-radius: var(--radius-full);
		background: var(--color-2-transparent);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--color-2);
		color: var(--text);
	}
	.tag-x-form { margin: 0; display: inline-flex; }
	.tag-x {
		padding: 0; width: 16px; height: 16px; line-height: 1; border: none; border-radius: var(--radius-full);
		background: transparent; color: var(--muted); box-shadow: none; font-size: var(--size-m); letter-spacing: var(--letter-spacing-m);
	}
	.tag-x:hover { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
	@media (max-width: 768px) {
		/* 40px hit area without growing the chip */
		.tag-x { min-width: 40px; min-height: 40px; margin: calc(-1 * var(--space-s)) calc(-1 * var(--space-s)) calc(-1 * var(--space-s)) calc(-1 * var(--space-xxs)); }
		.fd-act { min-width: 40px; min-height: 40px; }
	}
	.tag-add { margin: 0; }
	.tag-add input {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs); padding: var(--space-xxs) var(--space-xs); width: 8.5rem; border-radius: var(--radius-full);
		border: var(--border-s) dashed var(--border); box-shadow: none; background: transparent;
	}
	.tag-add input:focus { border-style: solid; }
	.tag-error { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: calc(-1 * var(--space-s)) 0 var(--space-m); }
	.formdata { margin-bottom: var(--space-l); }
	.fd-empty { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-xxs); }
	.fd-row {
		display: grid; grid-template-columns: 10rem 1fr auto; gap: var(--space-s); align-items: baseline;
		padding: var(--space-xs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
	}
	.fd-row:last-of-type { box-shadow: none; }
	.fd-name { color: var(--muted); word-break: break-word; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.fd-val { white-space: pre-wrap; word-break: break-word; min-width: 0; }
	.fd-actions { display: inline-flex; gap: var(--space-xxs); opacity: 0; transition: opacity var(--motion-duration) var(--motion-easing); }
	.fd-row:hover .fd-actions, .fd-row:focus-within .fd-actions { opacity: 1; }
	.fd-act {
		padding: 0 var(--space-xs); font-size: var(--size-xs); letter-spacing: var(--letter-spacing-xs); line-height: var(--line-xs); background: transparent;
		color: var(--muted); border: 0; border-radius: var(--radius-xs); box-shadow: none;
	}
	.fd-act:hover { background: var(--surface); box-shadow: 0 0 0 var(--border-s) var(--border); color: var(--text); }
	.fd-del:hover { color: var(--danger); box-shadow: 0 0 0 var(--border-s) var(--danger); }
	.inlineform { margin: 0; display: inline; }
	.fd-editrow {
		display: grid; grid-template-columns: 10rem 1fr auto auto; gap: var(--space-xs); align-items: center;
		padding: var(--space-xxs) 0; margin: 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
	}
	.fd-editrow:last-of-type { box-shadow: none; }
	.fd-addrow { grid-template-columns: 12rem 1fr auto auto; box-shadow: none; margin-top: var(--space-xs); }
	.fd-addpick { grid-column: 1 / -1; }
	.fd-arch { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.fd-input { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); padding: var(--space-xxs) var(--space-xs); width: 100%; }
	.fd-btn { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; white-space: nowrap; }
	.fd-addlink {
		margin-top: var(--space-xs); padding: var(--space-xxs) var(--space-xs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); background: transparent;
		border: var(--border-s) dashed var(--border); border-radius: var(--radius-full); color: var(--muted); box-shadow: none;
	}
	.fd-addlink:hover { color: var(--text); border-color: var(--muted); border-style: solid; }
	.fd-error { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	@media (max-width: 560px) {
		.fd-row, .fd-editrow, .fd-addrow { grid-template-columns: 1fr; gap: var(--space-xxs); }
		.fd-actions { opacity: 1; }
	}
	h2 { margin-top: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.automations { margin-bottom: var(--space-l); }
	.pipeline { margin-bottom: var(--space-l); }
	.pl-head { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-bottom: var(--space-s); }
	.pl-note { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); white-space: pre-wrap; margin: 0 0 var(--space-s); }
	.pl-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
	.pl-actions form { margin: 0; }
	.pl-actions .enroll-inline { margin: 0; }
	.pl-remove { color: var(--danger); }
	.pl-value { width: 9rem; }
	.pl-history { list-style: none; margin: var(--space-s) 0 0; padding: 0; }
	.pl-history li { display: flex; justify-content: space-between; gap: var(--space-s); flex-wrap: wrap; padding: var(--space-xs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.pl-history li:last-child { box-shadow: none; }
	.pl-link { margin: var(--space-s) 0 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); }
	.ok { color: var(--success); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); }
	.enroll-inline { display: flex; gap: var(--space-xs); margin: 0 0 var(--space-s); }
	.enroll-inline select { flex: 1; min-width: 0; }
	.enroll-blocked { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin: 0 0 var(--space-s); }
	.enroll-blocked p, .enroll-blocked form { margin: 0; }
	.auto-list { list-style: none; margin: 0; padding: 0; }
	.auto-list li { padding: var(--space-s) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.auto-list li:last-child { box-shadow: none; padding-bottom: 0; }
	.auto-head { display: flex; align-items: baseline; gap: var(--space-xs); flex-wrap: wrap; }
	.auto-name { font-weight: var(--weight-ui-heavy); }
	.auto-detail { margin: var(--space-xxs) 0 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.auto-err { margin: var(--space-xxs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); overflow-wrap: anywhere; }
	.auto-path { margin: var(--space-xxs) 0 0; font-size: var(--size-xs); line-height: var(--line-xs); }
	.auto-path summary { cursor: pointer; }
	.auto-path ol { margin: var(--space-xxs) 0 0; padding-left: var(--space-m); }
	.unsub { margin-bottom: var(--space-l); }
	.activity { margin-bottom: var(--space-l); }
	.engagement { margin-bottom: var(--space-l); }
	.eng-head { display: flex; align-items: center; gap: var(--space-s); margin-bottom: var(--space-xs); }
	.eng-head h2 { margin: 0; }
	.eng-score { margin-left: auto; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.eng-score strong { font-size: var(--size-l); line-height: var(--line-l); letter-spacing: var(--letter-spacing-l); }
	.eng-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: var(--space-xs) var(--space-m); margin: 0 0 var(--space-s); }
	.eng-stats dt { color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.eng-stats dd { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.eng-best { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-xxs); }
	.eng-top { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-s); overflow-wrap: anywhere; }
	.eng-override { font-size: var(--size-s); line-height: var(--line-s); margin: var(--space-xs) 0 0; }
	.eng-set { margin-top: var(--space-xs); font-size: var(--size-s); }
	.eng-set-form { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: end; margin-top: var(--space-xs); }
	.eng-set-form label { display: flex; gap: var(--space-xxs); align-items: center; }
	.eng-note {font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.site-activity { margin-bottom: var(--space-l); }
	.sa-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-s); margin-bottom: var(--space-xs); }
	.sa-head h2 { margin: 0; }
	.sa-toggle { padding: 0 var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.sa-note { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: 0 0 var(--space-xs); }
	.sa-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--space-xs) var(--space-m); margin: 0 0 var(--space-s); }
	.sa-stats dt { color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.sa-stats dd { margin: 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); overflow-wrap: anywhere; }
	.sa-sub { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--muted); font-weight: var(--weight-ui-heavy); margin: 0 0 var(--space-xxs); }
	.sa-paths { list-style: none; margin: 0; padding: 0; }
	.sa-paths li { display: flex; justify-content: space-between; gap: var(--space-s); padding: var(--space-xxs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.sa-paths li:last-child { box-shadow: none; }
	.sa-path { overflow-wrap: anywhere; min-width: 0; }
	.act-list { list-style: none; margin: 0; padding: 0; }
	.act-list li { display: flex; align-items: baseline; gap: var(--space-s); padding: var(--space-xs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.act-list li:last-child { box-shadow: none; }
	.act-dot { width: 8px; height: 8px; border-radius: var(--radius-full); flex-shrink: 0; align-self: center; background: var(--muted); }
	.act-dot.good { background: var(--success); }
	.act-dot.bad { background: var(--danger); }
	.act-main { flex: 1; min-width: 0; display: flex; gap: var(--space-xs); align-items: baseline; flex-wrap: wrap; }
	.act-verb { font-weight: var(--weight-ui-heavy); }
	/* #518: a security scanner's link fetch — shown, but not as engagement. */
	.act-list li.scanned, .act-list li.scanned a { color: var(--muted); }
	.act-list li.scanned .act-verb { font-weight: var(--weight-ui-regular); }
	.act-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 22rem; min-width: 0; }
	@media (max-width: 640px) { .act-url { max-width: 100%; } }
	.act-when { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); white-space: nowrap; }
	/* Pager (mirrors /contacts) */
	.pager { display: flex; align-items: center; justify-content: center; gap: var(--space-m); margin-top: var(--space-m); flex-wrap: wrap; }
	.pg { padding: var(--space-xs) var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--link); }
	.pg:hover { text-decoration: none; background: var(--neutral-muted); }
	.pg.disabled { color: var(--muted); opacity: 0.6; pointer-events: none; }
	.pageinfo { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.archive-form {
		display: inline;
		margin: 0;
	}
	.archived-banner {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0 0 var(--space-m);
		padding: var(--space-xs) var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		color: var(--text);
		background: color-mix(in srgb, var(--warn) 12%, transparent);
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--warn) 35%, var(--border));
		border-radius: var(--radius);
	}
	.archived-banner :global(svg) {
		color: var(--warn);
		flex: none;
	}
</style>

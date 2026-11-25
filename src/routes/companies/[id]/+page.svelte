<script lang="ts">
	import SortCaret from '$lib/components/SortCaret.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { enhance } from '$app/forms';
	import Avatar from '$lib/components/Avatar.svelte';
	import { timeAgo } from '$lib/timing-format';
	import { relTime } from '$lib/reltime';
	import CompanyPanels from '$lib/components/CompanyPanels.svelte';
	import AccountBrief from '$lib/components/AccountBrief.svelte';
	import { money } from '$lib/money';
	import CompanyGlance from '$lib/components/CompanyGlance.svelte';
	import CompanyEngagement from '$lib/components/CompanyEngagement.svelte';
	import CompanyTimeline from '$lib/components/CompanyTimeline.svelte';
	import { formatDateTime } from '$lib/report-view';
	let { data, form } = $props();
	const co = $derived(data.company);
	// GitHub repos (#169).
	const gh = $derived(data.github);
	let ghSyncing = $state(false);

	// Inline edit (#166): one header field at a time; Esc / Cancel closes without saving.
	type Field = 'name' | 'domain' | 'website' | 'notes';
	let editing = $state<Field | null>(null);
	const saveEnhance = () =>
		async ({ update, result }: { update: (o?: { reset?: boolean }) => Promise<void>; result: { type: string } }) => {
			await update({ reset: false });
			if (result.type === 'success') editing = null;
		};

	function urlWith(overrides: Record<string, string | number | null>): string {
		const p = new URLSearchParams();
		if (data.per !== 50) p.set('per', String(data.per));
		if (data.sort !== 'created_at') p.set('sort', data.sort);
		if (data.dir !== 'desc') p.set('dir', data.dir);
		if (data.page > 1) p.set('page', String(data.page));
		for (const [k, v] of Object.entries(overrides)) {
			if (v === null || v === '') p.delete(k);
			else p.set(k, String(v));
		}
		if (p.get('page') === '1') p.delete('page');
		if (p.get('per') === '50') p.delete('per');
		if (p.get('sort') === 'created_at') p.delete('sort');
		if (p.get('dir') === 'desc') p.delete('dir');
		return `?${p}`;
	}
	function sortUrl(col: string): string {
		const dir = data.sort === col && data.dir === 'desc' ? 'asc' : 'desc';
		return urlWith({ sort: col, dir, page: null });
	}
	function arrow(col: string): 'asc' | 'desc' | null {
		if (data.sort !== col) return null;
		return data.dir === 'desc' ? 'desc' : 'asc';
	}
	const from = $derived(co.contact_count === 0 ? 0 : (data.page - 1) * data.per + 1);
	const to = $derived(Math.min(data.page * data.per, co.contact_count));
	const displayName = (c: { name: string | null; first_name: string | null; last_name: string | null }) =>
		c.name || [c.first_name, c.last_name].filter(Boolean).join(' ');

	// Timing (#168): project picker (list from the session-gated API, 10-min server cache,
	// filtered client-side by path), Detach, Sync now (this company only).
	const tm = $derived(data.timing);
	type Project = { id: string; title: string; path: string };
	let picking = $state(false);
	let syncing = $state(false);
	let projects = $state<Project[] | null>(null);
	let projectsError = $state('');
	let projectQ = $state('');
	const filteredProjects = $derived.by(() => {
		const q = projectQ.trim().toLowerCase();
		const list = projects ?? [];
		return (q ? list.filter((p) => p.path.toLowerCase().includes(q)) : list).slice(0, 50);
	});
	async function openPicker() {
		picking = true;
		if (projects) return;
		projectsError = '';
		try {
			const res = await fetch('/api/integrations/timing/projects');
			const body = (await res.json()) as { projects?: Project[]; error?: string };
			if (!res.ok || !body.projects) projectsError = body.error ?? 'Could not load Timing projects.';
			else projects = body.projects;
		} catch {
			projectsError = 'Could not load Timing projects.';
		}
	}

	// Billing (#353, Zoho Books): null when this user can't see money data.
	const bill = $derived(data.billing);
	let zohoSyncing = $state(false);
	type ZohoCustomer = { id: string; name: string; company_name: string | null; domain: string | null };
	let zohoQ = $state('');
	let zohoResults = $state<ZohoCustomer[] | null>(null);
	let zohoTotal = $state(0);
	let zohoSearchError = $state('');
	let zohoSearching = $state(false);
	async function searchZoho(e: SubmitEvent) {
		e.preventDefault();
		const q = zohoQ.trim();
		if (q.length < 2) return;
		zohoSearching = true;
		zohoSearchError = '';
		try {
			const res = await fetch(`/api/integrations/zoho/customers?q=${encodeURIComponent(q)}`);
			const body = (await res.json()) as { customers?: ZohoCustomer[]; total?: number; error?: string };
			if (!res.ok || !body.customers) zohoSearchError = body.error ?? 'Could not search Zoho customers.';
			else {
				zohoResults = body.customers;
				zohoTotal = body.total ?? body.customers.length;
			}
		} catch {
			zohoSearchError = 'Could not search Zoho customers.';
		} finally {
			zohoSearching = false;
		}
	}
	const INVOICE_BADGE: Record<string, string> = {
		paid: 'sent',
		overdue: 'failed',
		partially_paid: 'sending',
		sent: 'sending',
		draft: 'draft',
		void: 'draft'
	};
	const statusLabel = (s: string | null) => (s ?? 'unknown').replace(/_/g, ' ');
	const linkEnhance = () => async ({ update, result }: { update: () => Promise<void>; result: { type: string } }) => {
		await update();
		if (result.type === 'success') zohoResults = null;
	};
	const unlinkEnhance = (name: string) => ({ cancel }: { cancel: () => void }) => {
		if (!confirm(`Unlink ${name}? Its synced invoices and payments are removed from the CRM (nothing changes in Zoho).`)) cancel();
	};
	const zohoSyncEnhance = () => {
		zohoSyncing = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			zohoSyncing = false;
		};
	};
</script>

<svelte:head><title>{co.name} · Companies</title></svelte:head>

<Breadcrumbs items={[{ label: 'Companies', href: '/companies' }, { label: co.name }]} />

<section class="card header">
	{#if editing === 'name'}
		<form method="POST" action="?/update" use:enhance={saveEnhance} class="inline">
			<!-- svelte-ignore a11y_autofocus -->
			<input name="name" value={co.name} required maxlength="200" autofocus aria-label="Company name"
				onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
			<button type="submit">Save</button>
			<button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
		</form>
	{:else}
		<div class="title-row">
			<h1>{co.name}</h1>
			<button type="button" class="link-btn" onclick={() => (editing = 'name')}>Rename</button>
			<form
				method="POST"
				action="?/delete"
				class="del"
				use:enhance={({ cancel }) => {
					const n = co.contact_count;
					if (!confirm(`Delete “${co.name}”? ${n ? `Its ${n} contact${n === 1 ? '' : 's'} keep their company text but are unlinked.` : ''}`)) cancel();
				}}
			>
				<button type="submit" class="secondary small">Delete company</button>
			</form>
		</div>
	{/if}

	<dl class="facts">
		<dt>Domain</dt>
		<dd>
			{#if editing === 'domain'}
				<form method="POST" action="?/update" use:enhance={saveEnhance} class="inline">
					<!-- svelte-ignore a11y_autofocus -->
					<input name="domain" value={co.domain ?? ''} maxlength="253" placeholder="acme.com" autofocus aria-label="Domain"
						onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
					<button type="submit">Save</button>
					<button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
				</form>
			{:else}
				{#if co.domain}{co.domain}{:else}<span class="muted">—</span>{/if}
				<button type="button" class="link-btn" onclick={() => (editing = 'domain')}>Edit</button>
			{/if}
		</dd>
		<dt>Website</dt>
		<dd>
			{#if editing === 'website'}
				<form method="POST" action="?/update" use:enhance={saveEnhance} class="inline">
					<!-- svelte-ignore a11y_autofocus -->
					<input name="website" value={co.website ?? ''} maxlength="500" placeholder="https://acme.com" autofocus aria-label="Website"
						onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
					<button type="submit">Save</button>
					<button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
				</form>
			{:else}
				{#if co.website}<a href={co.website} target="_blank" rel="noopener noreferrer">{co.website}</a>{:else}<span class="muted">—</span>{/if}
				<button type="button" class="link-btn" onclick={() => (editing = 'website')}>Edit</button>
			{/if}
		</dd>
		<dt>Last activity</dt>
		<dd>{#if co.last_activity_at}{formatDateTime(co.last_activity_at, data.tz)} <span class="muted">({relTime(co.last_activity_at)})</span>{:else}<span class="muted">—</span>{/if}</dd>
	</dl>
	{#if form?.error && editing !== 'notes'}<p class="err">{form.error}</p>{/if}
</section>

<CompanyGlance dashboard={data.dashboard} companyId={co.id} tz={data.tz} />

<!-- #567: trend + timeline on the left; brief, top contacts and the panels on the right. -->
<div class="dash">
	<div class="col">
		<CompanyEngagement dashboard={data.dashboard} tz={data.tz} part="trend" />
		<CompanyTimeline timeline={data.timeline} />
	</div>
	<div class="col">
		<AccountBrief
			brief={data.brief}
			canGenerate={data.briefCanGenerate}
			unavailable={data.briefUnavailable}
			error={form && 'briefError' in form ? (form.briefError as string) : null}
			notice={form && 'briefOk' in form && form.briefOk === 'unchanged' ? 'Nothing changed since the last brief, so it was kept.' : null}
		/>
		<CompanyEngagement dashboard={data.dashboard} tz={data.tz} part="top" />
		<CompanyPanels
			dashboard={data.dashboard}
			conversations={data.conversations}
			timing={tm}
			hoursWeekly={data.hoursWeekly}
			github={gh.metrics}
			billing={bill}
			tz={data.tz}
		/>
	</div>
</div>

<section class="card" id="contacts">
	<h2>Contacts <span class="muted">{co.contact_count}</span></h2>
	{#if data.contacts.length === 0}
		<p class="muted">No contacts linked yet. Set a contact's Company to “{co.name}” to link them.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th><a class="sort" href={sortUrl('email')} data-sveltekit-reset="false">Email<SortCaret dir={arrow('email')} /></a></th>
						<th><a class="sort" href={sortUrl('name')} data-sveltekit-reset="false">Name<SortCaret dir={arrow('name')} /></a></th>
						<th><a class="sort" href={sortUrl('subscribed')} data-sveltekit-reset="false">Status<SortCaret dir={arrow('subscribed')} /></a></th>
						<th><a class="sort" href={sortUrl('source')} data-sveltekit-reset="false">Source<SortCaret dir={arrow('source')} /></a></th>
						<th><a class="sort" href={sortUrl('created_at')} data-sveltekit-reset="false">Added<SortCaret dir={arrow('created_at')} /></a></th>
					</tr>
				</thead>
				<tbody>
					{#each data.contacts as c (c.id)}
						<tr>
							<td><a href="/contacts/{c.id}">{c.email}</a></td>
							<td>
								<span class="name-cell">
									<Avatar contactId={c.id} name={displayName(c)} size={24} />
									<span>{displayName(c)}</span>
								</span>
							</td>
							<td>
								{#if c.subscribed}<span class="badge sent">Subscribed</span>
								{:else}<span class="badge failed">Unsubscribed</span>{/if}
							</td>
							<td class="muted">{c.source ?? ''}</td>
							<td class="muted">{c.created_at.slice(0, 10)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.pageCount > 1 || co.contact_count > 25}
			<nav class="pager">
				{#if data.page > 1}<a class="pg" href={urlWith({ page: data.page - 1 })} data-sveltekit-reset="false">← Prev</a>
				{:else}<span class="pg disabled">← Prev</span>{/if}
				<span class="muted pageinfo">Showing {from}–{to} of {co.contact_count}</span>
				{#if data.page < data.pageCount}<a class="pg" href={urlWith({ page: data.page + 1 })} data-sveltekit-reset="false">Next →</a>
				{:else}<span class="pg disabled">Next →</span>{/if}
				<span class="per">
					<span class="muted">Per page:</span>
					{#each data.perOptions as opt (opt)}
						{#if opt === data.per}<span class="per-opt active">{opt}</span>
						{:else}<a class="per-opt" href={urlWith({ per: opt, page: 1 })} data-sveltekit-reset="false">{opt}</a>{/if}
					{/each}
				</span>
			</nav>
		{/if}
		<p class="muted more"><a href="/contacts?company_id={co.id}">Open in Contacts</a> for filters and bulk actions.</p>
	{/if}
</section>

<!-- #567: notes collapsed by default. -->
<details class="card notes-card" id="notes">
	<summary><h2>Notes</h2>{#if !co.notes}<span class="muted small-text">none</span>{/if}</summary>
	{#if editing === 'notes'}
		<form method="POST" action="?/update" use:enhance={saveEnhance} class="inline notes-form">
			<!-- svelte-ignore a11y_autofocus -->
			<textarea name="notes" rows="4" maxlength="5000" autofocus aria-label="Notes"
				onkeydown={(e) => e.key === 'Escape' && (editing = null)}>{co.notes ?? ''}</textarea>
			<span class="row">
				<button type="submit">Save</button>
				<button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
			</span>
		</form>
		{#if form?.error}<p class="err">{form.error}</p>{/if}
	{:else}
		{#if co.notes}<p class="notes">{co.notes}</p>{:else}<p class="muted small-text">No notes yet.</p>{/if}
		<button type="button" class="secondary small" onclick={() => (editing = 'notes')}>Edit notes</button>
	{/if}
</details>

<!-- #567: every Timing, GitHub and Zoho Books control in one card; the panels above only read. -->
<section class="card" id="integrations">
	<h2>Manage integrations</h2>
	<div class="integration">
		<h3><Icon name="timing" size={16} /> Timing</h3>
		{#if !data.timingConfigured}
			<p class="muted">Not connected — add a Timing token in Settings → Integrations.</p>
		{:else if tm?.project_id && !picking}
			<p class="proj">
				<strong>{tm.project_name ?? tm.project_id}</strong>
				<button type="button" class="link-btn" onclick={openPicker}>Change</button>
			</p>
			<div class="tm-actions">
				<form method="POST" action="?/syncTiming" use:enhance={() => { syncing = true; return async ({ update }) => { await update(); syncing = false; }; }}>
					<button type="submit" class="secondary small" disabled={syncing}>{syncing ? 'Syncing…' : 'Sync now'}</button>
				</form>
				<form method="POST" action="?/detachTiming" use:enhance={({ cancel }) => { if (!confirm('Detach this Timing project? Its numbers are cleared.')) cancel(); }}>
					<button type="submit" class="secondary small">Detach</button>
				</form>
				<span class="muted synced">Last synced: {tm.timing_synced_at ? timeAgo(tm.timing_synced_at) : 'never'}</span>
			</div>
		{:else if !picking}
			<p class="muted">No Timing project attached.</p>
			<button type="button" class="secondary small" onclick={openPicker}>Attach a Timing project</button>
		{/if}

		{#if data.timingConfigured && picking}
			<div class="picker">
				<!-- svelte-ignore a11y_autofocus -->
				<input type="search" bind:value={projectQ} placeholder="Search Timing projects…" aria-label="Search Timing projects" autofocus
					onkeydown={(e) => e.key === 'Escape' && (picking = false)} />
				{#if projectsError}<p class="err">{projectsError}</p>
				{:else if projects === null}<p class="muted">Loading projects…</p>
				{:else}
					<ul class="proj-list">
						{#each filteredProjects as p (p.id)}
							<li>
								<form method="POST" action="?/attachTiming" use:enhance={() => async ({ update, result }) => { await update(); if (result.type === 'success') picking = false; }}>
									<input type="hidden" name="project_id" value={p.id} />
									<input type="hidden" name="project_name" value={p.path} />
									<button type="submit" class="proj-btn" class:current={p.id === tm?.project_id}>{p.path}</button>
								</form>
							</li>
						{:else}
							<li class="muted">No projects match.</li>
						{/each}
					</ul>
				{/if}
				<button type="button" class="secondary small" onclick={() => (picking = false)}>Cancel</button>
			</div>
		{/if}
		{#if form?.timingError}<p class="err">{form.timingError}</p>{/if}
	</div>
	<div class="integration">
		<div class="int-head">
			<h3><Icon name="github" size={16} /> GitHub</h3>
			{#if gh.repos.length}
				<form
					method="POST"
					action="?/syncGithub"
					use:enhance={() => {
						ghSyncing = true;
						return async ({ update }) => {
							await update({ reset: false });
							ghSyncing = false;
						};
					}}
				>
					<button type="submit" class="secondary small" disabled={ghSyncing || !gh.configured}>
						{ghSyncing ? 'Syncing…' : 'Sync now'}
					</button>
				</form>
			{/if}
		</div>
		{#if !gh.configured}
			<p class="muted small-text">GitHub isn't connected — add a token in Settings → Integrations.</p>
		{/if}

		{#if gh.repos.length}
			<ul class="repos">
				{#each gh.repos as r (r.id)}
					<li>
						<a href="https://github.com/{r.owner}/{r.repo}" target="_blank" rel="noopener noreferrer">{r.owner}/{r.repo}</a>
						<span class="muted">
							{#if r.last_synced_at}
								{r.issues_open ?? 0} open · {r.issues_closed ?? 0} closed · +{r.issues_opened_30d ?? 0} / −{r.issues_closed_30d ?? 0} in 30d
							{:else}not synced yet{/if}
						</span>
						{#if r.last_error}<span class="err-inline">Last sync failed: {r.last_error}</span>{/if}
						<form
							method="POST"
							action="?/removeRepo"
							class="rm"
							use:enhance={({ cancel }) => {
								if (!confirm(`Remove ${r.owner}/${r.repo} from ${co.name}?`)) cancel();
							}}
						>
							<input type="hidden" name="repo_id" value={r.id} />
							<button type="submit" class="link-btn">Remove</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}

		<form method="POST" action="?/addRepo" use:enhance class="inline add-repo">
			<input name="repo" required maxlength="300" placeholder="owner/repo or https://github.com/owner/repo"
				aria-label="GitHub repository" autocomplete="off" spellcheck="false" />
			<button type="submit" class="secondary" disabled={!gh.configured}>Add repo</button>
		</form>
		{#if form?.repoError}<p class="err">{form.repoError}</p>{/if}
		{#if form?.syncErrors?.length}<p class="err">{form.syncErrors.join(' · ')}</p>{/if}
	</div>

{#if bill}
	<div class="integration" id="manage-billing">
		<div class="int-head">
			<h3><Icon name="billing" size={16} /> Zoho Books</h3>
			{#if bill.links.length && bill.configured}
				<form method="POST" action="?/syncZoho" use:enhance={zohoSyncEnhance}>
					<button type="submit" class="secondary small" disabled={zohoSyncing}>{zohoSyncing ? 'Syncing…' : 'Sync now'}</button>
				</form>
			{/if}
		</div>
		{#if !bill.configured}
			<p class="muted small-text">Zoho Books isn't connected — an admin connects it in Settings → Integrations.</p>
		{/if}

		{#if bill.links.length}
			{#if bill.metrics}
				{@const m = bill.metrics}
				<p class="muted synced">
					Totals (in the Billing panel) count {m.billing_currency ?? 'the organization currency'} only; amounts in other currencies are listed, not added.
					Synced {m.zoho_synced_at ? relTime(m.zoho_synced_at) : 'never'}.
				</p>
			{:else}
				<p class="muted small-text">Not synced yet.</p>
			{/if}

			<h4>Linked Zoho customers</h4>
			<ul class="repos">
				{#each bill.links as l (l.id)}
					<li>
						<strong>{l.contact_name}</strong>
						<span class="muted">{l.last_synced_at ? `synced ${relTime(l.last_synced_at)}` : 'not synced yet'}</span>
						{#if l.last_error}<span class="err-inline">Last sync failed: {l.last_error}</span>{/if}
						<form method="POST" action="?/unlinkZoho" class="rm" use:enhance={unlinkEnhance(l.contact_name)}>
							<input type="hidden" name="link_id" value={l.id} />
							<button type="submit" class="link-btn">Unlink</button>
						</form>
					</li>
				{/each}
			</ul>

			{#if bill.invoices.length}
				<details class="tables">
				<summary>Recent invoices <span class="muted">{bill.invoices.length}</span></summary>
				<div class="table-wrap">
					<table>
						<thead><tr><th>Number</th><th>Date</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr></thead>
						<tbody>
							{#each bill.invoices as i (i.invoice_id)}
								<tr>
									<td>{#if i.zoho_url}<a href={i.zoho_url} target="_blank" rel="noopener noreferrer">{i.invoice_number ?? i.invoice_id}</a>{:else}{i.invoice_number ?? i.invoice_id}{/if}</td>
									<td>{i.date ?? '—'}</td>
									<td>{i.due_date ?? '—'}</td>
									<td class="num">{money(i.total, i.currency_code)}</td>
									<td class="num">{money(i.balance, i.currency_code)}</td>
									<td><span class="badge {INVOICE_BADGE[i.status ?? ''] ?? 'draft'}">{statusLabel(i.status)}</span></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				</details>
			{/if}
			{#if bill.payments.length}
				<details class="tables">
				<summary>Recent payments <span class="muted">{bill.payments.length}</span></summary>
				<div class="table-wrap">
					<table>
						<thead><tr><th>Number</th><th>Date</th><th class="num">Amount</th><th>Invoices</th><th>Mode</th></tr></thead>
						<tbody>
							{#each bill.payments as p (p.payment_id)}
								<tr>
									<td>{p.payment_number ?? p.payment_id}</td>
									<td>{p.date ?? '—'}</td>
									<td class="num">{money(p.amount, p.currency_code)}</td>
									<td class="muted">{p.invoice_numbers ?? ''}</td>
									<td class="muted">{p.payment_mode ?? ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				</details>
			{/if}
		{:else}
			<p class="muted small-text">Not linked to a Zoho Books customer.</p>
		{/if}

		{#if bill.configured}
			{#if bill.suggestions.length}
				<h4>Link?</h4>
				<ul class="repos">
					{#each bill.suggestions as sg (sg.id)}
						<li>
							<strong>{sg.name}</strong>
							<span class="muted">{sg.reason === 'domain' ? `email domain ${sg.domain}` : 'same name'}{sg.company_name && sg.company_name !== sg.name ? ` · ${sg.company_name}` : ''}</span>
							<form method="POST" action="?/linkZoho" class="rm" use:enhance>
								<input type="hidden" name="zoho_contact_id" value={sg.id} />
								<input type="hidden" name="contact_name" value={sg.name} />
								<button type="submit" class="secondary small">Link</button>
							</form>
						</li>
					{/each}
				</ul>
			{:else if !bill.customersCachedAt && !bill.links.length}
				<p class="muted small-text">Suggestions appear after the first Zoho Books sync.</p>
			{/if}
			<form class="inline add-repo" onsubmit={searchZoho}>
				<input type="search" bind:value={zohoQ} placeholder="Search by name, company or email domain" aria-label="Search Zoho customers" minlength="2" autocomplete="off" />
				<button type="submit" class="secondary" disabled={zohoSearching}>{zohoSearching ? 'Searching…' : 'Search'}</button>
			</form>
			{#if zohoSearchError}<p class="err">{zohoSearchError}</p>{/if}
			{#if zohoResults}
				<ul class="repos">
					{#each zohoResults as c (c.id)}
						<li>
							<strong>{c.name}</strong>
							{#if c.company_name && c.company_name !== c.name}<span class="muted">{c.company_name}</span>{/if}
							<form method="POST" action="?/linkZoho" class="rm" use:enhance={linkEnhance}>
								<input type="hidden" name="zoho_contact_id" value={c.id} />
								<input type="hidden" name="contact_name" value={c.name} />
								<button type="submit" class="secondary small">Link</button>
							</form>
						</li>
					{:else}
						<li class="muted">No customers match.</li>
					{/each}
				</ul>
				{#if zohoTotal > zohoResults.length}
					<p class="muted small-text">Showing {zohoResults.length} of {zohoTotal} — refine your search.</p>
				{/if}
			{/if}
		{/if}
		{#if form?.zohoNote}<p class="muted small-text" role="status">{form.zohoNote}</p>{/if}
		{#if form?.zohoError}<p class="err">{form.zohoError}</p>{/if}
	</div>
{/if}
</section>

<style>
	section, .notes-card { margin-bottom: var(--space-l); }
	/* #567: two columns (trend + timeline | brief, top contacts, panels), one below 900px. */
	.dash {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--card-gap);
		align-items: start;
		margin-bottom: var(--space-l);
	}
	.col { display: flex; flex-direction: column; gap: var(--card-gap); min-width: 0; }
	.col > :global(*) { margin-top: 0; margin-bottom: 0; }
	@media (max-width: 900px) {
		.dash { grid-template-columns: minmax(0, 1fr); }
	}
	.notes-card summary { display: flex; align-items: baseline; gap: var(--space-s); cursor: pointer; }
	.notes-card summary h2 { display: inline; margin: 0; }
	.notes-card[open] summary { margin-bottom: var(--space-s); }
	.notes { white-space: pre-wrap; margin: 0 0 var(--space-s); }
	.tables { margin-top: var(--space-s); }
	.tables summary { cursor: pointer; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-heavy); }
	.tables[open] summary { margin-bottom: var(--space-xs); }
	h2 { margin-top: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.title-row { display: flex; align-items: baseline; gap: var(--space-s); flex-wrap: wrap; }
	.title-row h1 { margin: 0; }
	.del { margin: 0 0 0 auto; }
	.facts { display: grid; grid-template-columns: 8rem 1fr; gap: var(--space-xs) var(--space-m); margin: var(--space-m) 0 0; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.facts dt { color: var(--muted); }
	.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
	.inline { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; margin: 0; }
	.inline input { flex: 1 1 14rem; min-width: 0; }
	.notes-form { flex-direction: column; align-items: stretch; }
	.notes-form textarea { width: 100%; }
	.row { display: flex; gap: var(--space-xs); }
	.link-btn {
		background: none; border: none; box-shadow: none; padding: 0 var(--space-xxs); color: var(--link);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs); cursor: pointer; text-decoration: underline; text-decoration-color: var(--link-underline); text-decoration-thickness: var(--link-underline-thickness); text-underline-offset: var(--link-underline-offset);
	}
	.link-btn:hover { background: none; box-shadow: none; color: var(--link-hover); text-decoration-thickness: var(--link-underline-thickness-hover); }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.err { color: var(--danger); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-xs) 0 0; }
	.name-cell { display: inline-flex; align-items: center; gap: var(--space-xs); }
	a.sort { color: inherit; text-decoration: none; white-space: nowrap; }
	a.sort:hover { color: var(--link-hover); }
	.more { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin: var(--space-s) 0 0; }
	.pager { display: flex; align-items: center; justify-content: center; gap: var(--space-m); margin-top: var(--space-m); flex-wrap: wrap; }
	.pg { padding: var(--space-xs) var(--space-s); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--link); }
	.pg:hover { text-decoration: none; background: var(--neutral-muted); }
	.pg.disabled { color: var(--muted); opacity: 0.6; pointer-events: none; }
	.pageinfo { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.per { display: inline-flex; align-items: center; gap: var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.per-opt {
		min-width: 1.9rem; text-align: center; padding: var(--space-xxs) var(--space-xs); border: 0; box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius); color: var(--link);
	}
	.per-opt:hover { text-decoration: none; background: var(--neutral-muted); }
	.per-opt.active { background: var(--neutral-muted); color: var(--text); font-weight: var(--weight-ui-heavy); }
	h3 { margin: 0 0 var(--space-xs); font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.proj { margin: 0; }
	.tm-actions { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; margin-top: var(--space-s); }
	.tm-actions form { margin: 0; }
	.synced { font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.picker { display: flex; flex-direction: column; gap: var(--space-xs); max-width: 32rem; }
	.picker > .small { align-self: flex-start; }
	.proj-list { list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow-y: auto; border: 0; box-shadow: 0 0 0 var(--border-s) var(--border); border-radius: var(--radius); }
	.proj-list li { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.proj-list li:last-child { box-shadow: none; }
	.proj-list li.muted { padding: var(--space-xs) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.proj-list form { margin: 0; }
	.proj-btn {
		width: 100%; text-align: left; background: none; border: none; box-shadow: none; border-radius: 0;
		padding: var(--space-xs) var(--space-s); color: var(--text); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); cursor: pointer;
	}
	.proj-btn:hover, .proj-btn:focus-visible { background: var(--neutral-muted); }
	.proj-btn.current { font-weight: var(--weight-ui-heavy); }
	.int-head h3 { margin: 0; }
	.integration + .integration { margin-top: var(--space-l); padding-top: var(--space-m); box-shadow: inset 0 var(--border-s) 0 var(--border); }
	h4 { margin: var(--space-m) 0 var(--space-xs); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); color: var(--muted); font-weight: var(--weight-ui-heavy); }
	.int-head { display: flex; align-items: center; gap: var(--space-s); margin-bottom: var(--space-xs); }
	.int-head form { margin: 0; }
	.small-text { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.repos { list-style: none; padding: 0; margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.repos li {
		display: flex; align-items: baseline; gap: var(--space-xs); flex-wrap: wrap;
		padding: var(--space-xxs) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.repos li:last-child { box-shadow: none; }
	.rm { margin: 0 0 0 auto; }
	.err-inline { color: var(--danger); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.add-repo input { max-width: 26rem; }
	.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
	@media (max-width: 640px) {
		.facts { grid-template-columns: 1fr; gap: var(--space-xxs); }
		.facts dd { margin-bottom: var(--space-xs); }
		.del { margin-left: 0; }
		.link-btn { min-height: 40px; }
	}
</style>

<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Modal from '$lib/components/Modal.svelte';
	import EngagementBar from '$lib/components/EngagementBar.svelte';
	import StatGroup from '$lib/components/StatGroup.svelte';
	import StatCell from '$lib/components/StatCell.svelte';
	import SuggestSubjectButton from '$lib/components/SuggestSubjectButton.svelte';
	import { withBaseTargetBlank } from '$lib/email-preview-html';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { assistantDraftUpdate } from '$lib/assistant.svelte';
	import { viewEmailHref } from '$lib/view-email-href';
	import { relTime } from '$lib/reltime';
	import { ACTIVITY_FILTERS, ACTIVITY_SIZES, activityBadge, activityQuery, nextActivitySize } from '$lib/campaign-activity';
	import { cohortRate, liftPoints, liftText } from '$lib/engagement-view';
	import { onMount, untrack } from 'svelte';
	let { data, form } = $props();
	// #119: one-time query-param flags set by the redirect right after scheduling/resend —
	// show "(moved to Monday — weekdays only)" without persisting anything extra.
	const schedMoved = $derived(page.url.searchParams.get('sched_moved') === '1');
	const resendMoved = $derived(page.url.searchParams.get('resend_moved') === '1');
	const c = $derived(data.campaign as Record<string, any>);
	const s = $derived(data.stats as Record<string, number>);
	// #118: who this send went to — list / automation / a sample of recipients / none.
	// See $lib/server/audience.ts for the Audience shape (not imported here — server-only).
	const audience = $derived(data.audience as any);

	// #529: Activity panel.
	const act = $derived(data.activity);
	const activityMore = $derived(nextActivitySize(act.size));
	const activityEmptyNoun = $derived(ACTIVITY_FILTERS.find((f) => f.key === act.filter)?.empty ?? 'events');
	// One clock per load so every relative time in the panel agrees.
	const activityNow = $derived.by(() => {
		void data;
		return new Date();
	});

	// #309: the assistant changed this draft — the summary has no local edits, so reload it.
	let draftUpdateSeen = untrack(() => assistantDraftUpdate.n);
	$effect(() => {
		const n = assistantDraftUpdate.n;
		if (n === draftUpdateSeen) return;
		draftUpdateSeen = n;
		if (untrack(() => c.status === 'draft' && assistantDraftUpdate.campaignId === c.id)) invalidateAll();
	});

	let dialog = $state<HTMLDialogElement | null>(null);

	// "View email" dialog (#127): renders through the exact send-time pipeline for a given
	// recipient (or the template as authored). #155: who comes from ?as= / ?as_contact=
	// (deep links); "Change" opens a recipient search instead of a first-100 <select>.
	type Viewing = { id: number; email: string; name: string | null } | null;
	type Match = { id: number; email: string; name: string | null };
	const previewRecipientTotal = $derived(data.previewRecipientTotal as number);

	// Seeded once from the server render; picks from the search drive later updates.
	let viewing = $state<Viewing>(untrack(() => data.preview.recipient));
	let previewNotice = $state<string | null>(untrack(() => data.previewNotice));
	let previewSubject = $state<string>(untrack(() => data.preview.subject));
	let previewHtml = $state<string>(untrack(() => data.preview.html));
	let previewLoading = $state(false);
	let previewError = $state<string | null>(null);

	let searchOpen = $state(false);
	let searchQ = $state('');
	let searchResults = $state<Match[]>([]);
	let searching = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);
	let searchSeq = 0;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	async function viewAs(recipientId: number | null) {
		searchOpen = false;
		previewLoading = true;
		previewError = null;
		const as = recipientId === null ? 'template' : String(recipientId);
		try {
			const res = await fetch(`/campaign/${c.id}/render?as=${encodeURIComponent(as)}`);
			if (!res.ok) throw new Error('request failed');
			const body = (await res.json()) as { subject: string; html: string; recipient: Viewing };
			previewSubject = body.subject;
			previewHtml = withBaseTargetBlank(body.html);
			viewing = body.recipient;
			previewNotice = null;
			// Shareable: the URL now says who this is, and #email reopens the dialog.
			const url = new URL(page.url);
			url.searchParams.delete('as_contact');
			url.searchParams.set('as', as);
			url.hash = 'email';
			replaceState(url, page.state);
		} catch {
			previewError = "Couldn't load this recipient's email. Try again.";
		} finally {
			previewLoading = false;
		}
	}

	// In-page "view" links (activity / drill-down rows): same deep link as from elsewhere,
	// but re-rendered in place rather than a reload. Modifier-clicks keep the real href.
	function openAs(e: MouseEvent, recipientId: number) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		dialog?.showModal();
		viewAs(recipientId);
	}

	function openSearch() {
		searchOpen = true;
		searchQ = '';
		searchResults = [];
		queueMicrotask(() => searchInput?.focus());
	}

	function onSearchInput(q: string) {
		searchQ = q;
		clearTimeout(searchTimer);
		if (q.trim().length < 2) {
			searchResults = [];
			searching = false;
			return;
		}
		searching = true;
		searchTimer = setTimeout(async () => {
			const seq = ++searchSeq;
			try {
				const res = await fetch(`/campaign/${c.id}/recipients?q=${encodeURIComponent(q.trim())}`);
				const body = res.ok ? ((await res.json()) as { results: Match[] }) : { results: [] };
				if (seq === searchSeq) searchResults = body.results;
			} catch {
				if (seq === searchSeq) searchResults = [];
			} finally {
				if (seq === searchSeq) searching = false;
			}
		}, 200);
	}

	function onSearchKeydown(e: KeyboardEvent) {
		// Esc closes the search, not the whole dialog.
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			searchOpen = false;
		}
	}

	function onDialogClose() {
		searchOpen = false;
		// Drop #email so a reload doesn't reopen the dialog; ?as= stays (next open = same person).
		if (page.url.hash === '#email') {
			const url = new URL(page.url);
			url.hash = '';
			replaceState(url, page.state);
		}
	}

	// #155 deep link: /campaign/<id>?as=…#email arrives already rendered server-side; open it.
	onMount(() => {
		if (location.hash === '#email') dialog?.showModal();
	});

	// "Resend to non-openers" (#81, scheduling added #83).
	let resendOpen = $state(false);
	let resendSubject = $state(c.subject as string);
	let resendSubmitting = $state(false);
	let resendWhen = $state<'now' | '24h' | '3d' | 'custom'>('now');
	let resendAtLocal = $state('');
	// #119: opt-in "weekdays only" on the resend timing.
	let resendWeekdayOnly = $state(false);
	// #246: the modal is rescheduling the pending resend (Edit on its banner).
	let resendEditing = $state(false);

	function openResend() {
		resendEditing = false;
		resendSubject = c.subject;
		resendWhen = 'now';
		resendAtLocal = '';
		resendWeekdayOnly = false;
		resendOpen = true;
	}

	function editResend() {
		resendEditing = true;
		resendSubject = c.resend_subject || c.subject;
		resendWhen = 'custom';
		resendAtLocal = data.resendSchedule?.input ?? '';
		resendWeekdayOnly = !!c.weekday_only;
		resendOpen = true;
	}

	// #240: Delete draft confirm.
	let deleteDraftOpen = $state(false);

	function minLocal(minMinutesFromNow = 15): string {
		const d = new Date(Date.now() + minMinutesFromNow * 60_000);
		d.setSeconds(0, 0);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// #115: best-time cohorts (null for an ordinary campaign).
	const bt = $derived(data.bestTime);
	const waiting = $derived(bt ? bt.best.queued + bt.default.queued : 0);
	const openLift = $derived(
		bt ? liftPoints(cohortRate(bt.best.opened, bt.best.sent), cohortRate(bt.default.opened, bt.default.sent)) : null
	);
	const clickLift = $derived(
		bt ? liftPoints(cohortRate(bt.best.clicked, bt.best.sent), cohortRate(bt.default.clicked, bt.default.sent)) : null
	);

	function pct(n: number, d: number): string {
		if (!d) return '—';
		return `${Math.round((n / d) * 100)}%`;
	}

	const WHO_LABELS: Record<string, string> = {
		sent: 'Sent',
		opens: 'Who opened',
		clicks: 'Who clicked',
		unsubs: 'Who unsubscribed',
		bounces: 'Bounces / spam',
		clicked: 'Clicked',
		opened: 'Opened, no click',
		none: 'No interaction'
	};
</script>

<svelte:head><title>{c.subject}</title></svelte:head>

<Breadcrumbs items={[{ label: 'Campaigns', href: '/campaigns' }, { label: c.subject || `Campaign #${c.id}` }]} />

<div class="head">
	<h1>{c.subject}</h1>
	<span class="badge {c.status}">{c.status}</span>
	<button class="view-btn" onclick={() => dialog?.showModal()}>View email</button>
	{#if c.status === 'sent' && data.nonOpeners > 0 && c.resend_status !== 'pending'}
		<button class="secondary view-btn" onclick={openResend}>
			Resend to non-openers ({data.nonOpeners})
		</button>
	{/if}
</div>
<p class="muted meta">
	{#if audience.kind === 'list' && audience.include}
		To {@render groupLinks(audience.include)}{#if audience.exclude?.length}, excluding {@render groupLinks(audience.exclude)}{/if}
	{:else if audience.kind === 'list'}
		To <strong><a href="/lists/{audience.listId}">{audience.name}</a></strong>
	{:else if audience.kind === 'automation'}
		via automation <strong><a href="/automations/{audience.automationId}">{audience.name}</a></strong>
	{:else if audience.kind === 'recipients'}
		To <strong>{#each audience.sample as row, i (row.id ?? row.email)}{#if i > 0}{', '}{/if}{#if row.contact_id}<a href="/contacts/{row.contact_id}">{row.email}</a>{:else}{row.email}{/if}{/each}{#if audience.total > audience.sample.length}{' '}+{audience.total - audience.sample.length} more{/if}</strong>
	{:else}
		To <strong>—</strong>
	{/if}
	· from {c.from_email}
	{#if c.sent_at}· sent {c.sent_at} UTC{/if}
</p>
{#if c.resent_at}
	<p class="muted meta resend-note">
		Resent{#if c.resend_subject}{' '}as “{c.resend_subject}”{/if} to {c.resend_recipients ?? 0} non-openers on {c.resent_at} UTC
	</p>
{/if}

{#if data.archive.eligible && data.user?.role === 'admin'}
	<!-- #481: Publish to / Remove from the public newsletter archive (admins, sent broadcasts). -->
	<div class="archive-row">
		{#if data.archive.published}
			<span class="muted">In the newsletter archive{#if data.archive.url}: <a href={data.archive.url} target="_blank" rel="noopener">{data.archive.url}</a>{/if}{#if !data.archive.enabled} (the archive is off: <a href="/settings/newsletter">turn it on</a>){/if}</span>
			<form method="POST" action="?/archiveRemove" use:enhance class="inline">
				<button type="submit" class="secondary small">Remove from newsletter archive</button>
			</form>
		{:else}
			<form method="POST" action="?/archivePublish" use:enhance class="inline">
				<button type="submit" class="secondary small">Publish to newsletter archive</button>
			</form>
		{/if}
		<!-- #483: a web-only version (title, teaser, body); the sent email never changes. -->
		{#if data.archive.edited}<span class="badge type" title="The archive page uses a web-only version">edited for web</span>{/if}
		<a href="/campaign/{c.id}/archive">Edit archive version</a>
	</div>
{/if}

{#if c.resend_status === 'pending'}
	<div class="sched-banner">
		<div class="sched-text">
			<p>
				<strong><Icon name="schedule" size={16} /> Auto-resend scheduled</strong> — resends to non-openers {data.resendSchedule ? data.resendSchedule.text : `at ${c.resend_at} UTC`}
				{#if resendMoved}<strong>(moved to Monday — weekdays only)</strong>{/if}
			</p>
			{#if c.resend_subject}<p class="sched-note">As “{c.resend_subject}”</p>{/if}
		</div>
		<span class="sched-actions">
			{#if c.status === 'sent'}
				<button type="button" class="secondary small" onclick={editResend}>Edit</button>
			{/if}
			<form method="POST" action="?/cancelResend" use:enhance class="inline">
				<button type="submit" class="secondary small danger-text">Cancel</button>
			</form>
		</span>
	</div>
{/if}

{#if c.error}<p class="err">{c.error}</p>{/if}
{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.partlySent && c.status !== 'canceled'}
	<form method="POST" action="?/duplicate" use:enhance class="inline">
		<button type="submit" class="secondary small">Duplicate as new draft</button>
	</form>
{/if}

<Modal title={resendEditing ? 'Edit scheduled resend' : 'Resend to non-openers'} bind:open={resendOpen}>
	<p class="muted resend-explainer">
		Sends this email again to the {data.nonOpeners} recipients who haven't opened it — tracked on this same campaign. Consider tweaking the subject line.
	</p>
	{#if resendEditing}
		<p class="muted resend-replace-note">
			Currently scheduled for {data.resendSchedule ? data.resendSchedule.text : `${c.resend_at} UTC`}. Times are in the operator timezone.
		</p>
	{/if}
	<form
		method="POST"
		action="?/resend"
		use:enhance={() => {
			resendSubmitting = true;
			return async ({ update }) => {
				await update();
				resendSubmitting = false;
			};
		}}
	>
		{#if resendEditing}<input type="hidden" name="edit" value="1" />{/if}
		<label class="resend-label">
			Subject
			<input type="text" name="subject" bind:value={resendSubject} maxlength="500" required />
		</label>
		{#if data.aiSubject}
			<div class="resend-suggest">
				<SuggestSubjectButton subject={() => resendSubject || c.subject} onpick={(s) => (resendSubject = s)} />
			</div>
		{/if}

		<div class="when-toggle" role="radiogroup" aria-label="When to resend">
			<label class="when-opt">
				<input type="radio" name="resend_when" value="now" checked={resendWhen === 'now'} onchange={() => (resendWhen = 'now')} />
				Now
			</label>
			<label class="when-opt">
				<input type="radio" name="resend_when" value="24h" checked={resendWhen === '24h'} onchange={() => (resendWhen = '24h')} />
				In 24 hours
			</label>
			<label class="when-opt">
				<input type="radio" name="resend_when" value="3d" checked={resendWhen === '3d'} onchange={() => (resendWhen = '3d')} />
				In 3 days
			</label>
			<label class="when-opt">
				<input type="radio" name="resend_when" value="custom" checked={resendWhen === 'custom'} onchange={() => (resendWhen = 'custom')} />
				Pick a date &amp; time
			</label>
		</div>
		{#if resendWhen === 'custom'}
			<input type="datetime-local" name="resend_at" bind:value={resendAtLocal} min={minLocal(15)} class="resend-at-input" />
		{/if}
		{#if resendWhen !== 'now'}
			<label class="when-opt">
				<input type="checkbox" name="weekday_only" value="1" bind:checked={resendWeekdayOnly} />
				Weekdays only
			</label>
			{#if resendWeekdayOnly}
				<p class="muted resend-explainer">If this would land on a weekend, it'll resend Monday at the same time instead.</p>
			{/if}
		{/if}

		{#if form?.error}<p class="err">{form.error}</p>{/if}
		<button type="submit" disabled={resendSubmitting}>
			{#if resendSubmitting}
				{resendWhen === 'now' ? 'Sending…' : 'Scheduling…'}
			{:else if resendWhen === 'now'}
				Resend to {data.nonOpeners} contacts
			{:else if resendEditing}
				Save resend
			{:else}
				Schedule resend
			{/if}
		</button>
	</form>
</Modal>

{#if c.status === 'scheduled'}
	<div class="sched-banner">
		<div class="sched-text">
			<p>
				<strong><Icon name="schedule" size={16} /> Scheduled</strong> — sends {c.scheduled_at} UTC
				{#if schedMoved}<strong>(moved to Monday — weekdays only)</strong>{/if}
				{#if form?.sendingSoon}<strong>Pulled forward — sending on the next tick.</strong>{/if}
				{#if form?.released}<strong>Released — back on its schedule.</strong>{/if}
			</p>
			{#if form?.recheckPassed}<p class="sched-note"><strong>Checks passed — it sends on the next heartbeat.</strong></p>{/if}
			{#if form?.recheckFailed}<p class="sched-note"><strong>Still failing: {form.recheckFailed}.</strong> It stays held.</p>{/if}
			{#if form?.sentAnyway}<p class="sched-note"><strong>Released to send anyway — it goes out on the next heartbeat.</strong></p>{/if}
			{#if c.held_at && c.held_reason === 'preflight'}
				<!-- #479: held by its pre-send checks at the send time; never cancelled, never sent with the problem. -->
				<p class="sched-note">
					<strong><Icon name="pause" size={16} /> Held: {data.preflight?.summary ?? 'failed pre-send checks'}</strong> since {c.held_at} UTC. The links failed
					when the send was due and kept failing. It won't send until it passes a re-check{data.preflight?.canOverride ? ' or you send it anyway' : ''}.
				</p>
				{#if data.preflight}
					<ul class="held-checks">
						{#each data.preflight.report.checks.filter((x) => x.level === 'block') as chk (chk.id)}
							<li>
								<strong>{chk.title}</strong>{#if chk.detail}&nbsp;<span class="muted">{chk.detail}</span>{/if}
								{#if chk.items?.length}
									<ul>
										{#each chk.items as it, i (it)}
											<li>
												<code>{it}</code>
												{#if chk.urls?.[i]}<a href={chk.urls[i]} target="_blank" rel="noopener noreferrer">Open</a>{/if}
											</li>
										{/each}
									</ul>
								{/if}
							</li>
						{/each}
					</ul>
					{#if data.preflight.checkedAt}<p class="sched-note muted">Last checked {data.preflight.checkedAt} UTC.</p>{/if}
				{/if}
			{:else if c.held_at}
				<!-- #305: held by a critical deliverability alert; never cancelled. -->
				<p class="sched-note">
					<strong><Icon name="pause" size={16} /> Held</strong> since {c.held_at} UTC after a critical
					<a href="/deliverability">deliverability alert</a> on this list. It won't send until an admin releases it.
				</p>
			{:else if c.preflight_retry_until}
				<!-- #479: the send time came and a link failed; the tick keeps trying. -->
				<p class="sched-note">
					<strong>Waiting on links:</strong> a pre-send check failed at the send time ({data.preflight?.summary ?? 'see the checks'}). It's re-checked
					every minute until {c.preflight_retry_until} UTC, then held.
				</p>
			{/if}
			<p class="sched-note">
				{#if c.best_time}Each contact then gets it at their best time within 24 hours. {/if}Fires on the next heartbeat, within ~1 min. Links are checked again then.
			</p>
		</div>
		<span class="sched-actions">
			<form method="POST" action="?/editScheduled" use:enhance class="inline">
				<button type="submit" class="secondary small">Edit</button>
			</form>
			{#if c.held_at && c.held_reason === 'preflight'}
				<form method="POST" action="?/recheckHold" use:enhance class="inline">
					<button type="submit" class="secondary small">Re-check now</button>
				</form>
				{#if data.preflight?.canOverride}
					<form method="POST" action="?/sendAnywayHold" use:enhance class="inline">
						<button type="submit" class="secondary small" onclick={(e) => { if (!confirm('Send it with the failing checks? This is logged with your name.')) e.preventDefault(); }}>Send anyway</button>
					</form>
				{/if}
			{:else if c.held_at}
				{#if page.data.user?.role === 'admin'}
					<form method="POST" action="?/releaseHold" use:enhance class="inline">
						<button type="submit" class="secondary small">Release</button>
					</form>
				{/if}
			{:else}
				<form method="POST" action="?/sendNow" use:enhance class="inline">
					<button type="submit" class="secondary small">Send now</button>
				</form>
			{/if}
			<form method="POST" action="?/cancelSchedule" use:enhance class="inline">
				<button type="submit" class="secondary small danger-text">Cancel schedule</button>
			</form>
		</span>
	</div>
{/if}

{#if c.status === 'canceled'}
	<!-- #313: a canceled campaign that never sent reopens as a draft; Duplicate copies it. -->
	<div class="sched-banner">
		<div class="sched-text">
			<p><strong>Canceled</strong> — this campaign was canceled before sending.</p>
			{#if c.scheduled_at}<p class="sched-note">It was scheduled for {c.scheduled_at} UTC. Pick a new time in the editor.</p>{/if}
		</div>
		<span class="sched-actions">
			<form method="POST" action="?/editScheduled" use:enhance class="inline">
				<button type="submit" class="small">Edit & reschedule</button>
			</form>
			<form method="POST" action="?/duplicate" use:enhance class="inline">
				<button type="submit" class="secondary small">Duplicate</button>
			</form>
		</span>
	</div>
{/if}

{#if c.status === 'sending' && bt && waiting > 0}
	<div class="sched-banner">
		<div class="sched-text">
			<p>
				<strong><Icon name="best-time" size={16} /> Sending at each contact's best time</strong> — {bt.best.sent + bt.default.sent} sent, {waiting} still waiting
			</p>
			<p class="sched-note">The last ones go out within 24 hours of {c.sent_at} UTC.</p>
		</div>
	</div>
{/if}

<!-- Click backdrop (the dialog element itself) to close; ESC closes natively. -->
<dialog
	bind:this={dialog}
	class="email-modal"
	onclick={(e) => { if (e.target === dialog) dialog?.close(); }}
	onclose={onDialogClose}
>
	<div class="modal-head">
		<div class="modal-title">
			<strong>{previewSubject}</strong>
			<span class="muted">from {c.from_email}</span>
		</div>
		<div class="viewing-as">
			<span class="muted">Viewing as</span>
			<span class="as-who">
				{#if viewing}
					<strong>{viewing.name ?? viewing.email}</strong>{#if viewing.name}{' '}<span class="muted">&lt;{viewing.email}&gt;</span>{/if}
				{:else}
					<strong>Template (as authored)</strong>
				{/if}
			</span>
			{#if previewRecipientTotal > 0}
				<button class="secondary small" disabled={previewLoading} aria-expanded={searchOpen} onclick={() => (searchOpen ? (searchOpen = false) : openSearch())}>Change</button>
			{/if}
			{#if previewLoading}<span class="muted small">Loading…</span>{/if}
		</div>
		<button class="secondary small" onclick={() => dialog?.close()}>Close</button>
	</div>
	{#if searchOpen}
		<div class="as-search">
			<input
				bind:this={searchInput}
				type="search"
				placeholder="Search {previewRecipientTotal} recipient{previewRecipientTotal === 1 ? '' : 's'} by email or name…"
				aria-label="Search recipients"
				value={searchQ}
				oninput={(e) => onSearchInput(e.currentTarget.value)}
				onkeydown={onSearchKeydown}
			/>
			<ul class="as-results">
				<li><button type="button" class:current={viewing === null} onclick={() => viewAs(null)}>Template (as authored)</button></li>
				{#each searchResults as r (r.id)}
					<li>
						<button type="button" class:current={viewing?.email === r.email} onclick={() => viewAs(r.id)}>
							{#if r.name}{r.name} <span class="muted">&lt;{r.email}&gt;</span>{:else}{r.email}{/if}
						</button>
					</li>
				{/each}
			</ul>
			{#if searchQ.trim().length < 2}
				<p class="muted small">Type 2+ characters of an email or name.</p>
			{:else if searching}
				<p class="muted small">Searching…</p>
			{:else if searchResults.length === 0}
				<p class="muted small">No recipients match “{searchQ.trim()}”.</p>
			{/if}
		</div>
	{/if}
	{#if previewNotice}<p class="muted small preview-note">{previewNotice}</p>{/if}
	<p class="muted small preview-note">
		Rendered with the contact's current data — per-recipient bodies aren't stored. Links open their
		real destinations in a new tab, including the unsubscribe link — clicking it really unsubscribes
		that contact.
	</p>
	{#if previewError}<p class="err preview-note">{previewError}</p>{/if}
	<iframe
		class="email-frame"
		title="Sent email preview"
		sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
		srcdoc={previewHtml}
	></iframe>
</dialog>

{#if c.status === 'draft'}
	<!-- #240: a draft has no stats yet — show what's saved and the way forward. -->
	<section class="card draft-card">
		<h2>Draft</h2>
		<dl class="draft-summary">
			<dt>Subject</dt>
			<dd>{c.subject}</dd>
			<dt>From</dt>
			<dd>{#if c.from_email}{c.from_email}{:else}<span class="muted">Not set</span>{/if}</dd>
			<dt>Audience</dt>
			<dd>
				{#if audience.kind === 'list' && audience.include}
					{@render groupLinks(audience.include)}{#if audience.exclude?.length}, excluding {@render groupLinks(audience.exclude)}{/if}
				{:else if c.list_id && c.list_name}<a href="/lists/{c.list_id}">{c.list_name}</a>{:else}<span class="muted">No audience yet</span>{/if}
			</dd>
			{#if c.scheduled_at}
				<dt>Scheduled time</dt>
				<dd>{c.scheduled_at} UTC <span class="muted">(saved — schedule it from the editor)</span></dd>
			{/if}
		</dl>
		<div class="draft-actions">
			<a class="btn" href="/compose?draft={c.id}">Edit draft</a>
			<button type="button" class="secondary danger-text" onclick={() => (deleteDraftOpen = true)}>Delete draft</button>
		</div>
	</section>

	<Modal title="Delete this draft?" bind:open={deleteDraftOpen}>
		<p class="draft-confirm">“{c.subject}” will be deleted. This can't be undone.</p>
		<form method="POST" action="?/deleteDraft" use:enhance class="draft-actions">
			<button type="submit" class="danger">Delete draft</button>
			<button type="button" class="secondary" onclick={() => (deleteDraftOpen = false)}>Keep it</button>
		</form>
	</Modal>
{:else}
<StatGroup label="Campaign stats">
	<StatCell label="Sent" value={s.sent ?? 0} active={data.who === 'sent'} href={data.who === 'sent' ? '?' : '?who=sent'} />
	<StatCell
		label="Opens"
		value={s.unique_opens ?? 0}
		sub="{pct(s.unique_opens ?? 0, s.sent ?? 0)} of sent"
		active={data.who === 'opens'}
		href={data.who === 'opens' ? '?' : '?who=opens'}
	/>
	<StatCell
		label="Clicks"
		value={s.unique_clicks ?? 0}
		sub="{pct(s.unique_clicks ?? 0, s.sent ?? 0)} of sent"
		active={data.who === 'clicks'}
		href={data.who === 'clicks' ? '?' : '?who=clicks'}
	/>
	<StatCell label="Unsubscribes" value={s.unsubs ?? 0} active={data.who === 'unsubs'} href={data.who === 'unsubs' ? '?' : '?who=unsubs'} />
	<StatCell
		label="Bounces / spam"
		value={(s.bounces ?? 0) + (s.spam ?? 0)}
		active={data.who === 'bounces'}
		href={data.who === 'bounces' ? '?' : '?who=bounces'}
	/>
</StatGroup>

<!-- #246: the tiles above stay combined; this splits them by pass once a resend went out. -->
{#if data.passes}
	{@const p = data.passes}
	<section class="card passes-card">
		<h2>Original · Resend</h2>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Pass</th><th>Sent</th><th>Unique opens</th><th>Unique clicks</th><th>Open rate</th></tr>
				</thead>
				<tbody>
					<tr>
						<td>Original <span class="muted">“{c.subject}”</span></td>
						<td>{p.original.sent}</td>
						<td>{p.original.opens}</td>
						<td>{p.original.clicks}</td>
						<td>{pct(p.original.opens, p.original.sent)}</td>
					</tr>
					<tr>
						<td>Resend <span class="muted">“{c.resend_subject || c.subject}”</span></td>
						<td>{p.resend.sent}</td>
						<td>{p.resend.opens}</td>
						<td>{p.resend.clicks}</td>
						<td>{pct(p.resend.opens, p.resend.sent)}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
{/if}

<!-- #161: hidden until something was actually sent. -->
{#if data.engagement.sent > 0}
	<section class="card engagement-card">
		<h2>Engagement</h2>
		<EngagementBar
			breakdown={data.engagement}
			collecting={c.status === 'sending'}
			whoHref={(key) => (data.who === key ? '?' : `?who=${key}`)}
		/>
	</section>
{/if}

<!-- #115: best-time cohort vs the default cohort. -->
{#if bt && bt.best.sent + bt.default.sent > 0}
	<section class="card lift-card">
		<h2>Best-time lift</h2>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Cohort</th><th>Sent</th><th>Opened</th><th>Clicked</th></tr>
				</thead>
				<tbody>
					<tr>
						<td>Best time <span class="muted">(their usual hour)</span></td>
						<td>{bt.best.sent}{#if bt.best.queued > 0} <span class="muted">+{bt.best.queued} waiting</span>{/if}</td>
						<td>{bt.best.opened} <span class="muted">({pct(bt.best.opened, bt.best.sent)})</span></td>
						<td>{bt.best.clicked} <span class="muted">({pct(bt.best.clicked, bt.best.sent)})</span></td>
					</tr>
					<tr>
						<td>Default <span class="muted">(no usual hour yet)</span></td>
						<td>{bt.default.sent}{#if bt.default.queued > 0} <span class="muted">+{bt.default.queued} waiting</span>{/if}</td>
						<td>{bt.default.opened} <span class="muted">({pct(bt.default.opened, bt.default.sent)})</span></td>
						<td>{bt.default.clicked} <span class="muted">({pct(bt.default.clicked, bt.default.sent)})</span></td>
					</tr>
					<tr class="lift-row">
						<td>Lift</td>
						<td></td>
						<td>{liftText(openLift)}</td>
						<td>{liftText(clickLift)}</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="muted small">
			Best-time contacts are people who already open and click, so part of this gap is who they are,
			not when they got it.
		</p>
	</section>
{/if}

{#if data.who}
	<section class="card who-card">
		<div class="who-head">
			<h2>{WHO_LABELS[data.who]} ({data.whoRows.length})</h2>
			{#if data.whoContacts && data.whoContacts.n > 0}
				<!-- #279: the same people as contacts, ready for the bulk bar. -->
				<a class="open-contacts" href={data.whoContacts.href}>Open in Contacts ({data.whoContacts.n.toLocaleString('en-US')}) →</a>
			{/if}
			<a class="muted close" href="?"><Icon name="close" size={14} /> close</a>
		</div>
		{#if data.whoRows.length === 0}
			<p class="muted">Nobody yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead><tr><th>Contact</th><th>Detail</th><th>When (UTC)</th></tr></thead>
					<tbody>
						{#each data.whoRows as row (row.email + row.when)}
							<tr>
								<td>
									{#if row.contact_id}<a href="/contacts/{row.contact_id}">{row.email}</a>{:else}{row.email}{/if}
									{#if row.recipient_id}<a class="muted view-as" href={viewEmailHref(c.id, { recipientId: row.recipient_id })} onclick={(e) => openAs(e, row.recipient_id!)}>view email</a>{/if}
								</td>
								<td class="muted">{row.extra ?? ''}</td>
								<td class="muted">{row.when}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<div class="cols">
	<section class="card">
		<h2>Why people unsubscribed</h2>
		{#if data.reasons.length === 0}
			<p class="muted">No unsubscribes yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead><tr><th>Reason</th><th>Count</th></tr></thead>
					<tbody>
						{#each data.reasons as r (r.reason)}
							<tr><td>{r.reason}</td><td>{r.count}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="card">
		<!-- #529: short, filterable Activity panel; filter + size live in ?activity= / ?rows=. -->
		<div class="activity-head">
			<h2>Activity</h2>
			<form method="GET" data-sveltekit-noscroll data-sveltekit-keepfocus>
				{#each [...page.url.searchParams] as [k, v], i (i)}
					{#if k !== 'rows'}<input type="hidden" name={k} value={v} />{/if}
				{/each}
				<label class="muted size">
					Show
					<select name="rows" onchange={(ev) => ev.currentTarget.form?.requestSubmit()}>
						{#each ACTIVITY_SIZES as n (n)}
							<option value={n} selected={n === act.size}>{n}</option>
						{/each}
					</select>
				</label>
				<noscript><button type="submit">Apply</button></noscript>
			</form>
		</div>
		<nav class="chips" aria-label="Filter activity">
			{#each ACTIVITY_FILTERS as f (f.key)}
				<a
					class="chip"
					class:on={act.filter === f.key}
					aria-current={act.filter === f.key ? 'true' : undefined}
					href={activityQuery(page.url.searchParams, { activity: f.key })}
					data-sveltekit-noscroll>{f.label} <span class="chip-n">{act.counts[f.key]}</span></a
				>
			{/each}
		</nav>
		{#if act.counts.all === 0}
			<p class="muted">No tracking events yet. Opens and clicks arrive via Postmark webhooks.</p>
		{:else if act.rows.length === 0}
			<p class="muted">No {activityEmptyNoun} yet.</p>
		{:else}
			<ul class="activity-list">
				{#each act.rows as e (e.id)}
					<li>
						<span class="badge {activityBadge(e.type)}">{e.label}</span>
						<span class="activity-who">
							{#if e.contact_id}<a href="/contacts/{e.contact_id}">{e.who}</a>{:else}{e.who}{/if}
							{#if e.recipient_id}<a class="muted view-as" href={viewEmailHref(c.id, { recipientId: e.recipient_id })} onclick={(ev) => openAs(ev, e.recipient_id!)}>view email</a>{/if}
						</span>
						<time class="muted activity-when" datetime={e.recorded_at.replace(' ', 'T') + 'Z'} title="{e.recorded_at} UTC">{relTime(e.recorded_at, activityNow)}</time>
					</li>
				{/each}
			</ul>
			{#if act.hasMore && activityMore !== null}
				<a class="more-link" href={activityQuery(page.url.searchParams, { rows: activityMore })} data-sveltekit-noscroll>Show more</a>
			{/if}
		{/if}
	</section>
</div>
{/if}

{#if data.links.length > 0 || data.scannerFetches > 0}
	<section class="card tail-card">
		<h2>Link clicks</h2>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Link</th><th>Unique</th><th>Total</th></tr></thead>
				<tbody>
					{#each data.links as l (l.url)}
						<tr>
							<td class="linkcell">{#if l.unsubscribe}{l.url}{:else}<a href={l.url} target="_blank" rel="noopener">{l.url}</a>{/if}</td>
							<td>{l.unique_clicks} <span class="muted">({pct(l.unique_clicks, s.sent ?? 0)})</span></td>
							<td class="muted">{l.total_clicks}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.scannerFetches > 0}
			<p class="muted small">
				{data.scannerFetches} link {data.scannerFetches === 1 ? 'fetch' : 'fetches'} by security scanners hidden
			</p>
		{/if}
	</section>
{/if}

{#if data.replies.length > 0}
	<section class="card tail-card">
		<h2>Replies ({data.replies.length})</h2>
		<ul class="reply-list">
			{#each data.replies as r (r.id)}
				<li>
					<div class="reply-head">
						<span class="reply-from">{#if r.contact_id}<a href="/contacts/{r.contact_id}">{r.from_email}</a>{:else}{r.from_email}{/if}</span>
						<span class="muted when">{r.received_at} UTC</span>
					</div>
					{#if r.subject}<div class="reply-subject">{r.subject}</div>{/if}
					{#if r.text}<p class="reply-text">{r.text}</p>{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if data.errors.length > 0}
	<section class="card tail-card">
		<h2>Delivery errors ({data.errors.length})</h2>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Email</th><th>Error</th></tr></thead>
				<tbody>
					{#each data.errors as e (e.email)}
						<tr><td>{e.email}</td><td class="muted">{e.error}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<!-- #332: "Customers + Newsletter", each group linked. -->
{#snippet groupLinks(groups: { id: number; name: string }[])}
	<strong>{#each groups as g, i (g.id)}{#if i > 0}{' + '}{/if}<a href="/lists/{g.id}">{g.name}</a>{/each}</strong>
{/snippet}

<style>
	.sched-banner {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-m);
		margin: 0 0 var(--space-m); padding: var(--space-s) var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--accent) 40%, var(--border));
		background: color-mix(in srgb, var(--accent) 7%, transparent);
		border-radius: var(--radius);
	}
	.sched-text { min-width: 0; }
	.sched-text p { margin: 0; }
	.sched-note { color: var(--muted); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.sched-actions { display: inline-flex; gap: var(--space-xs); flex-shrink: 0; }
	.held-checks { margin: var(--space-xs) 0 0; padding-left: var(--space-m); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.held-checks ul { padding-left: var(--space-m); }
	.held-checks code { overflow-wrap: anywhere; }
	.held-checks a { margin-left: var(--space-xs); }
	@media (max-width: 768px) {
		.sched-banner { flex-wrap: wrap; }
	}
	.inline { margin: 0; display: inline; }
	.small { padding: var(--space-xxs) var(--space-s); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); box-shadow: none; }
	.danger-text { color: var(--danger); }
	.linkcell { max-width: 30rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	@media (max-width: 640px) {
		.linkcell { max-width: 14rem; }
	}
	.draft-card { margin-bottom: var(--space-l); }
	.draft-summary {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-xs) var(--space-m);
		margin: 0 0 var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.draft-summary dt { color: var(--muted); }
	.draft-summary dd { margin: 0; overflow-wrap: anywhere; }
	.draft-actions { display: flex; align-items: center; gap: var(--space-s); flex-wrap: wrap; margin: 0; }
	.draft-confirm { margin-top: 0; }
	.btn {
		display: inline-block;
		padding: var(--space-xs) var(--space-m);
		border-radius: var(--radius-s);
		background: var(--btn-primary-bg);
		color: var(--btn-primary-text);
		font-family: var(--font-ui);
		font-weight: var(--weight-ui-medium);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
	}
	.btn:hover { background: var(--btn-primary-hover); box-shadow: var(--shadow-s); }
	@media (max-width: 640px) {
		.draft-summary { grid-template-columns: minmax(0, 1fr); gap: 0; }
		.draft-summary dd { margin-bottom: var(--space-xs); }
	}
	.reply-list { list-style: none; margin: 0; padding: 0; }
	.reply-list li { padding: var(--space-s) 0; box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border); }
	.reply-list li:last-child { box-shadow: none; padding-bottom: 0; }
	.reply-head { display: flex; justify-content: space-between; gap: var(--space-m); align-items: baseline; flex-wrap: wrap; }
	.reply-from { font-weight: var(--weight-ui-heavy); overflow-wrap: anywhere; }
	.reply-subject { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); margin-top: var(--space-xxs); }
	.reply-text { margin: var(--space-xs) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	.when { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); white-space: nowrap; }
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-s);
	}
	h1 {
		margin: 0;
		font-size: var(--size-l);
		line-height: var(--line-l);
		letter-spacing: var(--letter-spacing-l);
	}
	.meta {
		margin: var(--space-xs) 0 var(--space-l);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		overflow-wrap: anywhere;
	}
	.who-card,
	.engagement-card,
	.lift-card,
	.passes-card,
	.tail-card /* #363: Link clicks, Replies, Delivery errors */ {
		margin-bottom: var(--space-l);
	}
	.lift-row td {
		font-weight: var(--weight-ui-heavy);
	}
	.who-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-m);
	}
	.who-head .open-contacts {
		margin-left: auto;
	}
	.who-head h2 {
		margin: 0;
	}
	.close {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		white-space: nowrap;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-l);
		margin-bottom: var(--space-l);
	}
	section {
		margin-bottom: 0;
	}
	h2 {
		margin-top: 0;
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	.err {
		color: var(--danger);
	}
	.view-btn {
		padding: var(--space-xs) var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.view-btn:first-of-type {
		margin-left: auto;
	}
	/* Mobile (#144): title on its own line, badge + actions wrap under it. */
	@media (max-width: 640px) {
		.head {
			flex-wrap: wrap;
			gap: var(--space-s);
		}
		h1 {
			flex-basis: 100%;
			overflow-wrap: anywhere;
		}
		.view-btn {
			padding: var(--space-xxs) var(--space-s);
		}
		.view-btn:first-of-type {
			margin-left: 0;
		}
	}
	.resend-note {
		margin-top: calc(-1 * var(--space-s));
	}
	.archive-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-s); margin: 0 0 var(--space-m); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.archive-row a { overflow-wrap: anywhere; }
	.resend-explainer {
		margin-top: 0;
	}
	.resend-suggest { margin: calc(-1 * var(--space-xs)) 0 var(--space-s); }
	.resend-label {
		display: block;
		margin-bottom: var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.resend-label input {
		display: block;
		width: 100%;
		margin-top: var(--space-xxs);
	}
	.resend-replace-note {
		margin-top: calc(-1 * var(--space-xs));
	}
	.when-toggle {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		align-items: center;
		margin-bottom: var(--space-s);
	}
	.when-opt {
		display: inline-flex;
		gap: var(--space-xxs);
		align-items: center;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		white-space: nowrap;
	}
	.resend-at-input {
		display: block;
		margin: 0 0 var(--space-s);
	}
	.email-modal {
		width: min(720px, 94vw);
		max-height: 90vh;
		padding: 0;
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--surface);
	}
	.email-modal::backdrop {
		background: var(--backdrop);
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-m);
		padding: var(--space-s) var(--space-m);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.modal-title {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-width: 0;
	}
	.modal-title strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.modal-title .muted {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.viewing-as {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-shrink: 0;
	}
	.viewing-as {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		min-width: 0;
	}
	.as-who {
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.as-search {
		padding: var(--space-s) var(--space-m);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.as-search input {
		width: 100%;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.as-search p {
		margin: var(--space-xs) 0 0;
	}
	.as-results {
		list-style: none;
		margin: var(--space-xs) 0 0;
		padding: 0;
		max-height: 16rem;
		overflow-y: auto;
	}
	.as-results button {
		display: block;
		width: 100%;
		text-align: left;
		padding: var(--space-xs) var(--space-xs);
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: inherit;
		box-shadow: none;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-regular);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.as-results button:hover,
	.as-results button.current {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.view-as {
		margin-left: var(--space-xs);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		white-space: nowrap;
	}
	/* #529: Activity panel — chips + size picker match the dashboard feed. */
	.activity-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.activity-head h2 {
		margin: 0;
	}
	.size {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-bottom: var(--space-s);
	}
	.chip {
		padding: 0 var(--space-s);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-full);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--muted);
	}
	.chip:hover {
		text-decoration: none;
		color: var(--text);
		background: var(--neutral-muted);
	}
	.chip.on {
		color: var(--text);
		box-shadow: 0 0 0 var(--border-s) var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.chip-n {
		font-variant-numeric: tabular-nums;
	}
	.activity-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.activity-list li {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) 0;
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border-muted);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.activity-list li:last-child {
		box-shadow: none;
	}
	.activity-who {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.activity-when {
		white-space: nowrap;
	}
	.more-link {
		display: inline-block;
		margin-top: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.preview-note {
		padding: 0 var(--space-m);
		margin: var(--space-xs) 0 0;
	}
	.email-frame {
		display: block;
		width: 100%;
		height: 70vh;
		border: 0;
		background: #fff;
	}
	@media (max-width: 640px) {
		.modal-head {
			flex-wrap: wrap;
			gap: var(--space-xs) var(--space-m);
		}
		.modal-title {
			flex: 1;
		}
		.viewing-as {
			order: 3;
			flex: 1 1 100%;
			min-width: 0;
		}
		.as-who {
			flex: 1;
			max-width: none;
		}
		.email-frame {
			height: 60vh;
		}
	}
	@media (max-width: 900px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>

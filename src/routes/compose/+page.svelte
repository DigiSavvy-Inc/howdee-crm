<script lang="ts">
	import { enhance } from '$app/forms';
	import { noImplicitSubmit } from '$lib/no-implicit-submit';
	import { untrack } from 'svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { page } from '$app/state';
	import BlockEditor from '@digisavvy/block-editor';
	import { uploadMedia } from '$lib/editor-host';
	import { editorActions, editorSlashActions } from '$lib/editor-host';
	import { editorLogos, editorSwatches } from '$lib/brand-kit';
	import SuggestSubjectButton from '$lib/components/SuggestSubjectButton.svelte';
	import PreSendChecks from '$lib/components/PreSendChecks.svelte';
	import AudiencePicker from '$lib/components/AudiencePicker.svelte';
	import type { ChecksReport } from '$lib/presend-checks';
	import { parseBlocks, type Block } from '$lib/blocks';
	import { markdownToBlocks } from '$lib/blocks-markdown';
	import { assistantDraftUpdate } from '$lib/assistant.svelte';
	import { sendButtonLabel } from '$lib/send-button-label';

	let { data, form } = $props();

	let mode = $state<'campaign' | 'direct'>(
		form?.mode === 'direct' ? 'direct' : ((data.initialMode as 'campaign' | 'direct') ?? 'campaign')
	);
	// #240: a draft (?draft=<id>) seeds every field it stored; a failed submit's values win.
	const draft = untrack(() => data.draft);
	let subject = $state(form?.values?.subject ?? draft?.subject ?? '');
	let from = $state(form?.values?.from ?? (draft?.from || data.defaultFrom));
	// #250: the visual editor's blocks. A failed submit's posted blocks win, then the
	// draft's stored blocks; an old markdown body converts here (nothing is saved until
	// Save / Send).
	function initialBlocks(): Block[] {
		const posted = form?.values?.body_blocks;
		if (posted) return parseBlocks(posted);
		if (draft?.body_blocks) return draft.body_blocks;
		return markdownToBlocks(form?.values?.body_md ?? draft?.body_md ?? '');
	}
	let bodyBlocks = $state<Block[]>(untrack(initialBlocks));

	// Desktop / Mobile preview: the server renders it with the real send path.
	async function renderPreview(blocks: Block[]): Promise<string> {
		const fd = new FormData();
		fd.set('body_blocks', JSON.stringify(blocks));
		fd.set('preheader', preheader);
		fd.set('direct', mode === 'direct' ? '1' : '');
		if (mode === 'campaign' && templateId) fd.set('template_id', String(templateId));
		const res = await fetch('/compose/preview', { method: 'POST', body: fd });
		if (!res.ok) throw new Error('preview failed');
		return res.text();
	}
	let templateId = $state<number | ''>(untrack(() => draft?.template_id ?? ''));
	let tagOnOpen = $state(untrack(() => draft?.tag_on_open ?? ''));
	let tagOnClick = $state(untrack(() => draft?.tag_on_click ?? ''));
	// Scheduling (#35): the picker is the operator's local time; we submit UTC ISO.
	function toLocalInput(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	let sendWhen = $state<'now' | 'later'>(untrack(() => (draft?.schedule_at ? 'later' : 'now')));
	let schedLocal = $state(untrack(() => (draft?.schedule_at ? toLocalInput(draft.schedule_at) : '')));
	const schedUtcIso = $derived(
		sendWhen === 'later' && schedLocal ? new Date(schedLocal).toISOString() : ''
	);
	const schedPast = $derived(!!schedUtcIso && Date.parse(schedUtcIso) < Date.now());
	// #119: "weekdays only" — applies to BOTH the scheduled send time and the auto-resend
	// timing below (one checkbox, same form submission). untrack() reads the initial
	// value only (no new `state_referenced_locally` warning — this is a one-time seed,
	// not meant to stay in sync with `form` afterward, same as the sibling $state fields).
	let weekdayOnly = $state(untrack(() => form?.values?.weekday_only ?? draft?.weekday_only ?? false));
	// #115: queue each recipient at their best hour within 24h of the scheduled time.
	let bestTime = $state(untrack(() => form?.values?.best_time ?? draft?.best_time ?? false));
	let archiveAfterSend = $state(untrack(() => draft?.archive_after_send ?? false)); // #481
	// #339: the picker reads the browser's clock, so name its zone (client-only, after hydration).
	let localTz = $state('');
	$effect(() => {
		localTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	});
	function minLocal(minMinutesFromNow = 5): string {
		const d = new Date(Date.now() + minMinutesFromNow * 60_000);
		d.setSeconds(0, 0);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// Auto-resend to non-openers (#82): '' (off) | '24h' | '3d' | 'custom'.
	let resendDelay = $state<'' | '24h' | '3d' | 'custom'>(
		untrack(() => (form?.values?.resend_delay ?? draft?.resend_delay ?? '') as '' | '24h' | '3d' | 'custom')
	);
	let resendAtLocal = $state(form?.values?.resend_at ?? draft?.resend_at ?? '');
	let resendSubject = $state(form?.values?.resend_subject ?? draft?.resend_subject ?? '');
	const selectedTemplate = $derived(data.templates.find((t: { id: number }) => t.id === templateId));
	let preheader = $state(form?.values?.preheader ?? draft?.preheader ?? '');
	// #332: included lists / segments (union) and excluded ones. A failed submit's values win.
	let includeIds = $state<number[]>(
		untrack(() => form?.values?.include_ids ?? draft?.include_ids ?? (draft?.list_id ? [draft.list_id] : []))
	);
	let excludeIds = $state<number[]>(untrack(() => form?.values?.exclude_ids ?? draft?.exclude_ids ?? []));
	// #414: the topic this email belongs to — '' automatic (the first included group when it is
	// a topic), '0' none, else a topic list id. Its opt-outs are left out of the send.
	let topicChoice = $state<string>(
		untrack(() => (form?.values && 'topic_id' in form.values ? String(form.values.topic_id ?? '') : (draft?.topic_id ?? '')))
	);
	const autoTopic = $derived(data.topics.find((t: { id: number }) => t.id === includeIds[0]) ?? null);
	const effectiveTopic = $derived(
		topicChoice === '' ? autoTopic : topicChoice === '0' ? null : (data.topics.find((t: { id: number }) => String(t.id) === topicChoice) ?? null)
	);
	let directTo = $state(form?.values?.direct_to ?? data.initialTo ?? '');
	let testTo = $state(data.defaultFrom || ''); // #596: the default From, else empty
	let sending = $state(false);
	let testing = $state(false);
	let savingDraft = $state(false);
	const draftSaved = $derived(page.url.searchParams.get('saved') === '1');
	// #309: the assistant changed this draft — offer a reload (the editor holds local edits,
	// so it never reloads by itself).
	const draftUpdateSeen = untrack(() => assistantDraftUpdate.n);
	const draftUpdatedByAssistant = $derived(
		!!data.draft && assistantDraftUpdate.n > draftUpdateSeen && assistantDraftUpdate.campaignId === data.draft.id
	);

	const directValid = $derived(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(directTo.trim()));

	// --- 1:1 "To" typeahead: search existing contacts as you type ---
	type Suggestion = {
		id: number;
		email: string;
		name: string | null;
		first_name: string | null;
		last_name: string | null;
		subscribed: number;
	};
	let suggestions = $state<Suggestion[]>([]);
	let showSug = $state(false);
	let activeIdx = $state(-1);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressSearch = false; // skip the input event fired right after a programmatic pick

	function sugName(s: Suggestion): string {
		return s.name || [s.first_name, s.last_name].filter(Boolean).join(' ');
	}

	function onDirectInput() {
		if (suppressSearch) {
			suppressSearch = false;
			return;
		}
		const q = directTo.trim();
		clearTimeout(searchTimer);
		if (q.length < 1) {
			suggestions = [];
			showSug = false;
			activeIdx = -1;
			return;
		}
		searchTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`);
				if (!res.ok) {
					suggestions = [];
					showSug = false;
					return;
				}
				suggestions = await res.json();
				showSug = suggestions.length > 0;
				activeIdx = -1;
			} catch {
				suggestions = [];
				showSug = false;
			}
		}, 150);
	}

	function pickSuggestion(s: Suggestion) {
		suppressSearch = true;
		directTo = s.email;
		suggestions = [];
		showSug = false;
		activeIdx = -1;
	}

	function onDirectKeydown(e: KeyboardEvent) {
		if (!showSug || suggestions.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIdx = (activeIdx + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIdx = (activeIdx - 1 + suggestions.length) % suggestions.length;
		} else if (e.key === 'Enter' && activeIdx >= 0) {
			e.preventDefault();
			pickSuggestion(suggestions[activeIdx]);
		} else if (e.key === 'Escape') {
			showSug = false;
			activeIdx = -1;
		}
	}

	const allGroups = $derived([...data.lists, ...data.segments]);
	function audienceFields(fd: FormData) {
		for (const id of includeIds) fd.append('include_id', String(id));
		for (const id of excludeIds) fd.append('exclude_id', String(id));
		fd.set('topic_id', topicChoice);
	}
	// #332: live count = union of the included groups − excluded − unsubscribed / archived,
	// from the server (the send's own resolver). One group, no exclusions and no topic
	// opt-outs to subtract (#414): its own count.
	const audienceSig = $derived(JSON.stringify([includeIds, excludeIds, topicChoice]));
	const localCount = $derived(
		includeIds.length === 1 && !excludeIds.length && !effectiveTopic
			? (allGroups.find((g) => g.id === includeIds[0])?.recipients ?? 0)
			: null
	);
	let remoteCount = $state<{ sig: string; n: number } | null>(null);
	$effect(() => {
		const sig = audienceSig;
		if (!includeIds.length || localCount !== null) return;
		const t = setTimeout(async () => {
			const fd = new FormData();
			audienceFields(fd);
			try {
				const res = await fetch('/compose/audience', { method: 'POST', body: fd });
				if (res.ok) remoteCount = { sig, n: ((await res.json()) as { count: number }).count };
			} catch {
				// keep the last count; the send action resolves the audience again anyway
			}
		}, 250);
		return () => clearTimeout(t);
	});
	const countLoading = $derived(!!includeIds.length && localCount === null && remoteCount?.sig !== audienceSig);
	const recipientCount = $derived(
		!includeIds.length ? 0 : (localCount ?? (remoteCount?.sig === audienceSig ? remoteCount.n : 0))
	);

	// #338: the submit button says what will happen (Send now / Schedule for <date>).
	const sendBtn = $derived(
		sendButtonLabel({
			mode,
			sendWhen,
			scheduledAt: sendWhen === 'later' && schedLocal ? new Date(schedLocal) : null,
			count: recipientCount,
			weekdayOnly,
			bestTime,
			busy: sending
		})
	);

	// #311: pre-send checks. A failed send's server-side report wins on load.
	let checksPanel = $state<ReturnType<typeof PreSendChecks>>();
	let checksReport = $state<ChecksReport | null>(null);
	let sendAnyway = $state(false);
	let checksBlocked = $state(false);
	$effect(() => {
		const c = form && 'checks' in form ? (form.checks as ChecksReport | undefined) : undefined;
		if (c) untrack(() => (checksReport = c));
	});
	function checkFields(): FormData {
		const fd = new FormData();
		fd.set('subject', subject);
		fd.set('preheader', preheader);
		fd.set('body_blocks', JSON.stringify(bodyBlocks));
		if (templateId) fd.set('template_id', String(templateId));
		audienceFields(fd);
		return fd;
	}
	const checkSig = $derived(JSON.stringify([subject, preheader, bodyBlocks, templateId, includeIds, excludeIds, topicChoice]));
	let ranSig = $state('');
	// Runs on its own when the send / schedule step changes: a list is picked, or Schedule chosen.
	$effect(() => {
		if (mode !== 'campaign' || !includeIds.length) return;
		void audienceSig;
		void sendWhen;
		void templateId;
		const t = setTimeout(() => untrack(() => checksPanel?.run(false)), 400);
		return () => clearTimeout(t);
	});
</script>

<svelte:head><title>Compose</title></svelte:head>

<Breadcrumbs items={[{ label: 'Campaigns', href: '/campaigns' }, { label: data.draft ? `Draft #${data.draft.id}` : 'Compose' }]} />

<h1>Compose email</h1>

{#if draftUpdatedByAssistant}
	<p class="assistant-update" role="status">
		Draft updated by assistant.
		<button type="button" class="secondary" onclick={() => location.reload()}>Reload</button>
	</p>
{/if}
{#if draftSaved && !form}<p class="ok">Draft saved.</p>{/if}
{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.testError}<p class="err">{form.testError}</p>{/if}
{#if form?.testSuccess}<p class="ok">Test sent to {form.testTo}. Check your inbox.</p>{/if}

<form
	use:noImplicitSubmit
	method="POST"
	action={mode === 'direct' ? '?/direct' : '?/send'}
	use:enhance={({ action, cancel }) => {
		if (action.search === '?/saveDraft') {
			savingDraft = true;
			return async ({ update }) => {
				await update({ reset: false });
				savingDraft = false;
			};
		}
		if (action.search === '?/test') {
			testing = true;
			return async ({ update }) => {
				await update({ reset: false });
				testing = false;
			};
		}
		// #311: a blocking check needs the "Send anyway" tick (the server checks again).
		if (mode === 'campaign' && checksReport?.blocks && !sendAnyway) {
			checksBlocked = true;
			document.getElementById('psc-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			cancel();
			return;
		}
		checksBlocked = false;
		const prompt =
			mode === 'direct'
				? `Send “${subject}” directly to ${directTo}? (no unsubscribe link)`
				: sendWhen === 'later' && schedLocal
					? `Schedule “${subject}” for ${new Date(schedLocal).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} to ${recipientCount} contact(s)?`
					: `Send “${subject}” to ${recipientCount} subscribed contact(s)?`;
		if (!confirm(prompt)) {
			cancel();
			return;
		}
		sending = true;
		return async ({ update }) => {
			await update({ reset: false });
			sending = false;
		};
	}}
>
	<input type="hidden" name="direct" value={mode === 'direct' ? '1' : ''} />
	{#if data.draft}<input type="hidden" name="draft_id" value={data.draft.id} />{/if}

	<div class="mode-toggle" role="radiogroup" aria-label="Send mode">
		<button
			type="button"
			class="mode-opt"
			class:active={mode === 'campaign'}
			aria-pressed={mode === 'campaign'}
			onclick={() => (mode = 'campaign')}
		>
			Campaign <span class="mode-sub">list / segment · with unsubscribe</span>
		</button>
		<button
			type="button"
			class="mode-opt"
			class:active={mode === 'direct'}
			aria-pressed={mode === 'direct'}
			onclick={() => (mode = 'direct')}
		>
			Direct (1:1) <span class="mode-sub">one person · no unsubscribe</span>
		</button>
	</div>
	{#if data.draft}<p class="muted draft-note">Editing draft #{data.draft.id}. Sending or scheduling uses this draft; nothing goes out until you do.</p>{/if}

	<div class="fields">
		<label>
			Subject
			<input name="subject" bind:value={subject} placeholder="Your subject line" required />
		</label>
		<label>
			From
			<input name="from" bind:value={from} type="email" placeholder="you@example.com" required />
		</label>
		{#if mode === 'campaign'}
			<div class="audience full">
				<AudiencePicker
					name="include_id"
					label="Send to (lists and segments)"
					lists={data.lists}
					segments={data.segments}
					bind:selected={includeIds}
					hidden={excludeIds}
					placeholder={includeIds.length ? 'Add another…' : 'Choose a list or segment…'}
				/>
				<details class="exclude" open={excludeIds.length > 0}>
					<summary>Don't send to <span class="muted">(optional)</span></summary>
					<AudiencePicker
						name="exclude_id"
						label="Exclude anyone in"
						lists={data.lists}
						segments={data.segments}
						bind:selected={excludeIds}
						hidden={includeIds}
						placeholder="Add a list or segment to leave out…"
					/>
				</details>
				{#if data.topics.length}
					<label class="topic-pick">
						This email belongs to topic
						<select name="topic_id" bind:value={topicChoice}>
							<option value="">Automatic{autoTopic ? ` (${autoTopic.label})` : ' (none)'}</option>
							<option value="0">No topic</option>
							{#each data.topics as t (t.id)}<option value={String(t.id)}>{t.label}</option>{/each}
						</select>
						<span class="muted">Contacts who opted out of this topic on the preference page are skipped.</span>
					</label>
				{:else}
					<input type="hidden" name="topic_id" value={topicChoice} />
				{/if}
				<p class="muted audience-count" aria-live="polite">
					{#if !includeIds.length}
						Pick one or more. Everyone in any of them gets one email.
					{:else if countLoading}
						Counting recipients…
					{:else}
						{recipientCount} subscribed contact{recipientCount === 1 ? '' : 's'}{includeIds.length > 1 || excludeIds.length ? ', each emailed once' : ''}.
					{/if}
				</p>
			</div>
		{:else}
			<label class="typeahead">
				<span class="cap">To <span class="muted">(one person)</span></span>
				<input
					name="direct_to"
					bind:value={directTo}
					type="email"
					placeholder="Start typing a name or email…"
					autocomplete="off"
					role="combobox"
					aria-expanded={showSug}
					aria-autocomplete="list"
					oninput={onDirectInput}
					onkeydown={onDirectKeydown}
					onblur={() => setTimeout(() => (showSug = false), 120)}
					required
				/>
				{#if showSug}
					<ul class="suggestions" role="listbox">
						{#each suggestions as s, i (s.id)}
							<li>
								<button
									type="button"
									class="sug"
									class:active={i === activeIdx}
									role="option"
									aria-selected={i === activeIdx}
									onmousedown={(e) => {
										e.preventDefault();
										pickSuggestion(s);
									}}
								>
									<span class="sug-email">{s.email}</span>
									{#if sugName(s)}<span class="sug-name muted">{sugName(s)}</span>{/if}
									{#if !s.subscribed}<span class="sug-unsub">unsubscribed</span>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</label>
		{/if}
		<label class="full">
			<span class="cap">Preview text <span class="muted">(optional — inbox preheader, shown after the subject)</span></span>
			<input name="preheader" bind:value={preheader} placeholder="One line recipients see before opening" />
		</label>
	</div>

	{#if mode === 'campaign' && data.templates.length > 0}
		<label class="tpl-row">
			<span class="cap">Start from</span>
			<select name="template_id" bind:value={templateId}>
				<option value="">Blank — write below</option>
				{#each data.templates as t (t.id)}
					<option value={t.id}>{t.name} ({t.kind === 'html' ? 'HTML' : 'builder'})</option>
				{/each}
			</select>
			{#if templateId}
				<a class="muted tpl-edit" href="/templates/{templateId}" target="_blank" rel="noopener">Edit template ↗</a>
			{/if}
		</label>
	{/if}

	{#if mode === 'campaign' && templateId && selectedTemplate?.kind === 'html'}
		<p class="muted tpl-note">
			This raw-HTML template is sent as-is — subject, preview text, and audience come from
			this form; merge tags in the HTML fill per recipient. Edit the markup in the template.
		</p>
	{:else}
		{#if mode === 'campaign' && templateId}
			<p class="muted tpl-note">
				Write your campaign content below — it lands in the template's <strong>content
				area</strong> (the template provides the header/footer chrome). Merge tags work.
			</p>
		{/if}
		<BlockEditor upload={uploadMedia} brandLogos={editorLogos(data.brandKit)} swatches={editorSwatches(data.brandKit)} bind:blocks={bodyBlocks} mergeTags={data.mergeTags} preview={renderPreview} selectionActions={editorActions('email', data.editorAsk)} slashActions={editorSlashActions('email', data.editorAsk, () => subject)} />
	{/if}

	{#if mode === 'campaign'}
		<details class="engage engage-first" open={!!(tagOnOpen || tagOnClick)}>
			<summary>Tag on engagement <span class="muted">(optional — fires automations)</span></summary>
			<div class="engage-row">
				<input name="tag_on_open" bind:value={tagOnOpen} placeholder="Tag when opened — e.g. opened-launch" maxlength="60" autocomplete="off" />
				<input name="tag_on_click" bind:value={tagOnClick} placeholder="Tag when clicked — e.g. clicked-launch" maxlength="60" autocomplete="off" />
			</div>
			<p class="muted engage-hint">Recipients who open/click get the tag — an automation triggered by that tag enrolls them automatically.</p>
		</details>

		<details class="engage" open={resendDelay !== ''}>
			<summary>Auto-resend to non-openers <span class="muted">(optional — resends to whoever hasn't opened yet)</span></summary>
			<div class="engage-row">
				<select name="resend_delay" bind:value={resendDelay}>
					<option value="">Off</option>
					<option value="24h">24 hours after send</option>
					<option value="3d">3 days after send</option>
					<option value="custom">Custom time…</option>
				</select>
				{#if resendDelay === 'custom'}
					<input type="datetime-local" name="resend_at" bind:value={resendAtLocal} min={minLocal(60)} />
				{/if}
				{#if resendDelay}
					<input name="resend_subject" bind:value={resendSubject} placeholder="Same subject" maxlength="500" />
					{#if data.aiSubject}
						<SuggestSubjectButton subject={() => resendSubject || subject} onpick={(s) => (resendSubject = s)} />
					{/if}
				{/if}
			</div>
			<p class="muted engage-hint">
				Automatically resends this exact email — tracked on the same campaign — to recipients who
				haven't opened it by then.
			</p>
		</details>
	{/if}

	<div class="test-row">
		<label class="test-to">
			Send a test to
			<input name="test_to" type="email" bind:value={testTo} placeholder="you@example.com" />
		</label>
		<button type="submit" formaction="?/test" formnovalidate class="secondary" disabled={testing}>
			{testing ? 'Sending test…' : 'Send test'}
		</button>
	</div>

	{#if mode === 'campaign'}
		<PreSendChecks
			bind:this={checksPanel}
			bind:report={checksReport}
			bind:sendAnyway
			fields={checkFields}
			stale={!!checksReport && !!ranSig && ranSig !== checkSig}
			onran={() => (ranSig = checkSig)}
		/>
		{#if checksBlocked && checksReport?.blocks && !sendAnyway}
			<p class="err">Fix the blocking checks above, or tick “Send anyway”.</p>
		{/if}
	{/if}

	{#if mode === 'campaign'}
		<fieldset class="delivery">
			<legend>Delivery</legend>
			<div class="mode-toggle when-toggle" role="radiogroup" aria-label="When to send">
				<button
					type="button"
					class="mode-opt"
					class:active={sendWhen === 'now'}
					aria-pressed={sendWhen === 'now'}
					onclick={() => (sendWhen = 'now')}
				>
					Send now
				</button>
				<button
					type="button"
					class="mode-opt"
					class:active={sendWhen === 'later'}
					aria-pressed={sendWhen === 'later'}
					onclick={() => (sendWhen = 'later')}
				>
					Schedule
				</button>
			</div>
			<input type="hidden" name="when" value={sendWhen} />
			{#if sendWhen === 'later'}
				<label class="sched-at">
					<span class="cap">Send at <span class="muted">(your time{localTz ? `, ${localTz}` : ''})</span></span>
					<input type="datetime-local" bind:value={schedLocal} min={minLocal()} />
				</label>
				{#if schedPast}
					<!-- #313: a reopened draft keeps its old time; the server refuses a past one, nothing auto-sends. -->
					<p class="err opt-hint">That time has passed. Pick a new time, or choose Send now.</p>
				{/if}
				<div class="opts">
					<div class="opt">
						<label class="check">
							<input type="checkbox" name="weekday_only" value="1" bind:checked={weekdayOnly} />
							Weekdays only
						</label>
						{#if weekdayOnly}<p class="muted opt-hint">Moves a weekend time to Monday.</p>{/if}
					</div>
					<div class="opt">
						<label class="check">
							<input type="checkbox" name="best_time" value="1" bind:checked={bestTime} />
							Send at each contact's best time
						</label>
						{#if bestTime}
							<p class="muted opt-hint">
								Each contact gets it at the hour they usually open, within 24 hours of the time above. Contacts
								without enough opens and clicks to tell get it at the time above.
							</p>
						{/if}
					</div>
				</div>
			{/if}
			{#if data.user?.role === 'admin'}
				<!-- #481: publish to the public newsletter archive once it's sent (incl. scheduled sends). -->
				<label class="check archive-opt">
					<input type="checkbox" name="archive_after_send" value="1" bind:checked={archiveAfterSend} />
					Publish to newsletter archive after sending
				</label>
			{/if}
			<input type="hidden" name="schedule_at" value={schedUtcIso} />
		</fieldset>
	{/if}

	<div class="send-row">
		{#if mode === 'direct'}
			<button type="submit" disabled={sending || !directValid}>
				{sendBtn.label}
			</button>
			<span class="muted hint">
				Personal 1:1 via the transactional stream — no unsubscribe link. Use for genuine
				one-to-one mail, not bulk.
			</span>
		{:else}
			<button
				type="submit"
				class="send-btn"
				disabled={sending || countLoading || !recipientCount || sendBtn.needsTime}
				aria-describedby={sendBtn.needsTime ? 'pick-time-hint' : undefined}
			>
				{sendBtn.label}
			</button>
			<button type="submit" formaction="?/saveDraft" formnovalidate class="secondary" disabled={savingDraft || !subject.trim()}>
				{savingDraft ? 'Saving…' : 'Save draft'}
			</button>
			{#if sendBtn.needsTime}
				<span class="muted hint" id="pick-time-hint">Pick a date and time above to schedule.</span>
			{/if}
			<span class="muted hint">Recipients get your signature and the client's native unsubscribe option.</span>
		{/if}
	</div>
</form>

<style>
	.mode-toggle {
		display: inline-flex;
		gap: var(--space-xxs);
		padding: var(--space-xxs);
		margin-bottom: var(--space-m);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		background: var(--bg);
	}
	.mode-opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		padding: var(--space-xs) var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-heavy);
		color: var(--muted);
		background: transparent;
		border: none;
		border-radius: var(--radius-xs);
	}
	.mode-opt:hover {
		filter: none;
		color: var(--text, inherit);
	}
	.mode-opt.active {
		background: var(--surface);
		color: var(--text);
		box-shadow: var(--shadow-s);
	}
	.mode-sub {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-regular);
		text-transform: none;
		letter-spacing: 0;
		opacity: 0.85;
	}
	@media (max-width: 640px) {
		.mode-toggle {
			display: flex;
		}
		.mode-opt {
			flex: 1 1 0;
			min-width: 0;
			text-align: left;
		}
	}
	.fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-m);
		margin-bottom: var(--space-m);
	}
	.fields label:first-child {
		grid-column: 1 / -1;
	}
	.fields label.full,
	.fields .full {
		grid-column: 1 / -1;
	}
	.audience {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.topic-pick {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.exclude summary {
		cursor: pointer;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.exclude[open] summary {
		margin-bottom: var(--space-xs);
	}
	.audience-count {
		margin: 0 0 var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	/* Keep a label's caption (text + its muted hint) on one line above the input. */
	.cap {
		display: block;
		white-space: nowrap;
	}
	@media (max-width: 640px) {
		.cap {
			white-space: normal;
		}
	}
	.typeahead {
		position: relative;
	}
	.suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 20;
		margin: var(--space-xxs) 0 0;
		padding: var(--space-xxs);
		list-style: none;
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 var(--border-s) var(--border), var(--shadow-m);
		max-height: 260px;
		overflow: auto;
	}
	.sug {
		display: flex;
		align-items: baseline;
		gap: var(--space-xs);
		width: 100%;
		text-align: left;
		padding: var(--space-xs) var(--space-xs);
		background: transparent;
		border: none;
		border-radius: var(--radius-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: inherit;
	}
	.sug:hover,
	.sug.active {
		background: var(--bg);
		filter: none;
	}
	.sug-email {
		font-weight: var(--weight-ui-heavy);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.sug-name {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.sug-unsub {
		margin-left: auto;
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		color: var(--danger);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) color-mix(in srgb, var(--danger) 40%, var(--border));
		border-radius: var(--radius-full);
		padding: 0 var(--space-xs);
		white-space: nowrap;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	input,
	select {
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
	}
	/* #339: Delivery card — when to send, right above the send button. */
	.delivery {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-s);
		min-width: 0;
		margin: var(--space-l) 0 0;
		padding: var(--space-m);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		background: var(--bg);
	}
	.delivery legend {
		float: left;
		width: 100%;
		padding: 0;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		font-weight: var(--weight-ui-heavy);
	}
	.delivery .when-toggle {
		margin: 0;
	}
	.sched-at {
		max-width: 100%;
	}
	.sched-at input {
		max-width: 100%;
	}
	.opts {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	label.check {
		flex-direction: row;
		align-items: center;
		gap: var(--space-xs);
		color: var(--text);
	}
	.archive-opt { margin-top: var(--space-s); }
	.opt-hint {
		margin: var(--space-xxs) 0 0 calc(1em + var(--space-xs));
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.err.opt-hint {
		margin-left: 0;
	}
	.engage-first {
		margin-top: var(--space-m);
	}
	.engage { margin: 0 0 var(--space-s); border: var(--border-s) dashed var(--border); border-radius: var(--radius); padding: var(--space-xs) var(--space-s); }
	.engage summary { cursor: pointer; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); font-weight: var(--weight-ui-medium); }
	.engage-row { display: flex; gap: var(--space-s); margin-top: var(--space-xs); flex-wrap: wrap; }
	.engage-row input { flex: 1; min-width: 14rem; font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.engage-hint { margin: var(--space-xs) 0 var(--space-xxs); font-size: var(--size-xs); line-height: var(--line-xs); letter-spacing: var(--letter-spacing-xs); }
	.tpl-row { display: flex; align-items: center; gap: var(--space-s); margin: 0 0 var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	.tpl-row select { min-width: 18rem; }
	.tpl-edit { font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s); }
	@media (max-width: 640px) {
		.tpl-row { flex-wrap: wrap; }
		.tpl-row select { min-width: 0; flex: 1 1 100%; }
		.engage-row input { min-width: 0; flex-basis: 100%; }
		.engage-row select { max-width: 100%; }
	}
	.tpl-note {
		margin: 0 0 var(--space-s); padding: var(--space-s) var(--space-s); font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--letter-spacing-s);
		background: var(--surface); border: var(--border-s) dashed var(--border); border-radius: var(--radius);
	}
	.test-row {
		display: flex;
		align-items: flex-end;
		gap: var(--space-s);
		margin-top: var(--space-l);
		padding: var(--space-m);
		border: 0;
		box-shadow: 0 0 0 var(--border-s) var(--border);
		border-radius: var(--radius-s);
		background: var(--bg);
	}
	.test-to {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--muted);
	}
	.test-to input {
		min-width: 240px;
	}
	.send-row {
		display: flex;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-l);
	}
	.send-btn {
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		text-align: center;
	}
	.hint {
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.ok {
		color: var(--success);
	}
	.assistant-update {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
	}
	.draft-note {
		margin: calc(-1 * var(--space-xs)) 0 var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
	}
	.err {
		color: var(--danger);
	}
	@media (max-width: 768px) {
		.fields {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 640px) {
		.test-row,
		.send-row {
			flex-wrap: wrap;
		}
		.test-to {
			flex: 1 1 100%;
			min-width: 0;
		}
		.test-to input {
			min-width: 0;
		}
	}
</style>

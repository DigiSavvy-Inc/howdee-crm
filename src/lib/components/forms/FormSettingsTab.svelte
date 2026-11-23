<script lang="ts">
	// #509: the builder's Settings tab. Address, button, what happens after submit (the
	// unconditional "default" outcome: message / redirect, lists, tags, source), topics,
	// enrolment, anonymous, double opt-in, notifications, retention, indexing.
	import {
		FORM_LIMITS,
		blankField,
		settingsOutcome,
		slugify,
		withSettingsOutcome,
		type FormAction,
		type FormSpec
	} from '$lib/forms';
	import CustomFieldPicker from '$lib/components/forms/CustomFieldPicker.svelte';
	import { NO_VALUE, YES_VALUE, type FieldOption } from '$lib/custom-fields';

	let {
		spec = $bindable(),
		slug = $bindable(),
		slugAuto = $bindable(),
		name,
		baseUrl,
		readonly = false,
		lists = [],
		topics = [],
		users = [],
		webhookSecret = null,
		customFields = [],
		onfieldcreated = () => {},
		problems = {}
	}: {
		spec: FormSpec;
		slug: string;
		slugAuto: boolean;
		name: string;
		baseUrl: string;
		readonly?: boolean;
		lists?: { id: number; name: string }[];
		topics?: { id: number; label: string }[];
		users?: { id: number; login: string; email: string | null }[];
		/** #620: the webhook signing key (admins only; null otherwise). */
		webhookSecret?: string | null;
		/** #619: defined custom fields for "Set a field". */
		customFields?: FieldOption[];
		onfieldcreated?: (f: FieldOption) => void;
		/** Problems by path prefix (`slug`, `settings.*`, `outcomes`). */
		problems?: Record<string, string[]>;
	} = $props();

	const actions = $derived(settingsOutcome(spec).actions);
	const redirectUrl = $derived(actions.find((a) => a.type === 'redirect')?.url ?? null);
	const message = $derived(actions.find((a): a is Extract<FormAction, { type: 'message_md' }> => a.type === 'message_md')?.md ?? '');
	const listIds = $derived(new Set(actions.filter((a) => a.type === 'add_to_list').map((a) => (a as { list_id: number }).list_id)));
	const tagsText = $derived(actions.filter((a) => a.type === 'add_tag').map((a) => (a as { tag: string }).tag).join(', '));
	const source = $derived(actions.find((a) => a.type === 'set_source')?.source ?? '');
	let afterMode = $state<'message' | 'redirect'>('message');
	$effect.pre(() => {
		afterMode = redirectUrl !== null ? 'redirect' : 'message';
	});

	function edit(fn: (a: FormAction[]) => FormAction[]) {
		spec = withSettingsOutcome(spec, fn([...actions]));
	}
	function setAfter(mode: 'message' | 'redirect') {
		afterMode = mode;
		edit((a) => {
			const rest = a.filter((x) => x.type !== 'message_md' && x.type !== 'redirect');
			return mode === 'redirect' ? [...rest, { type: 'redirect', url: redirectUrl ?? 'https://' }] : [...rest, { type: 'message_md', md: message || 'Thanks! We got your answers.' }];
		});
	}
	function setMessage(md: string) {
		edit((a) => [...a.filter((x) => x.type !== 'message_md' && x.type !== 'redirect'), { type: 'message_md', md }]);
	}
	function setRedirect(url: string) {
		edit((a) => [...a.filter((x) => x.type !== 'message_md' && x.type !== 'redirect'), { type: 'redirect', url }]);
	}
	function toggleList(id: number, on: boolean) {
		edit((a) => (on ? [...a.filter((x) => !(x.type === 'add_to_list' && x.list_id === id)), { type: 'add_to_list', list_id: id }] : a.filter((x) => !(x.type === 'add_to_list' && x.list_id === id))));
	}
	function setTags(text: string) {
		const tags = [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20);
		edit((a) => [...a.filter((x) => x.type !== 'add_tag'), ...tags.map((tag) => ({ type: 'add_tag' as const, tag }))]);
	}
	function setSource(v: string) {
		const s = v.trim().slice(0, FORM_LIMITS.source);
		edit((a) => [...a.filter((x) => x.type !== 'set_source'), ...(s ? [{ type: 'set_source' as const, source: s }] : [])]);
	}

	// #619: "Set a field" actions (a fixed value on every submission), same picker as a question's.
	type SetField = Extract<FormAction, { type: 'set_field' }>;
	const setFields = $derived(actions.filter((a): a is SetField => a.type === 'set_field'));
	function editSetFields(fn: (s: SetField[]) => SetField[]) {
		edit((a) => {
			const rest = a.filter((x) => x.type !== 'set_field');
			return [...rest, ...fn(setFields.map((x) => ({ ...x })))];
		});
	}
	function addSetField() {
		const first = customFields.find((f) => !setFields.some((s) => s.key === f.key));
		editSetFields((s) => [...s, { type: 'set_field', key: first?.key ?? '', value: '' }]);
	}
	const fieldOf = (key: string) => customFields.find((f) => f.key === key);

	const topicsField = $derived(spec.fields.find((f) => f.type === 'topics'));
	function toggleTopic(id: number, label: string, on: boolean) {
		if (!topicsField) return;
		const opts = topicsField.options.filter((o) => o.value !== String(id));
		topicsField.options = on ? [...opts, { value: String(id), label }] : opts;
	}
	function addTopicsQuestion() {
		const f = blankField('topics', 'What would you like to hear about?');
		f.key = 'topics';
		f.options = topics.slice(0, 5).map((t) => ({ value: String(t.id), label: t.label }));
		spec.fields = [...spec.fields, f];
	}
	function toggleNotify(id: number, on: boolean) {
		const cur = spec.settings.notify_user_ids.filter((x) => x !== id);
		spec.settings.notify_user_ids = on ? [...cur, id] : cur;
	}
	const p = (k: string) => problems[k] ?? [];
</script>

<fieldset class="settings" disabled={readonly}>
	<section class="group">
		<h3>Address</h3>
		<label>
			Slug
			<span class="slug-row"><span class="muted">{baseUrl}/f/</span><input
					value={slug}
					oninput={(e) => {
						slugAuto = false;
						slug = slugify(e.currentTarget.value.replace(/[^a-zA-Z0-9-]+/g, '-'), FORM_LIMITS.slug + 5).slice(0, FORM_LIMITS.slug);
					}}
					maxlength="60"
					spellcheck="false"
				/></span>
		</label>
		{#if slugAuto}<p class="muted small">Follows the form name (“{name}”) until you edit it.</p>{/if}
		{#each p('slug') as m, i (i)}<p class="err">{m}</p>{/each}
		<label>
			Submit button
			<input bind:value={spec.settings.submit_label} maxlength="40" />
		</label>
		{#each p('settings.submit_label') as m, i (i)}<p class="err">{m}</p>{/each}
	</section>

	<section class="group">
		<h3>After submit</h3>
		<div class="radios" role="radiogroup" aria-label="After submit">
			<label class="tick"><input type="radio" name="after" checked={afterMode === 'message'} onchange={() => setAfter('message')} /> Show a message</label>
			<label class="tick"><input type="radio" name="after" checked={afterMode === 'redirect'} onchange={() => setAfter('redirect')} /> Go to a web address</label>
		</div>
		{#if afterMode === 'message'}
			<label>Message <span class="muted">(Markdown)</span>
				<textarea rows="4" value={message} oninput={(e) => setMessage(e.currentTarget.value)} maxlength="5000"></textarea>
			</label>
		{:else}
			<label>Address
				<input type="url" value={redirectUrl ?? ''} oninput={(e) => setRedirect(e.currentTarget.value)} placeholder="https://example.com/thanks" />
			</label>
		{/if}
		{#each p('outcomes') as m, i (i)}<p class="err">{m}</p>{/each}
	</section>

	<section class="group">
		<h3>Add to</h3>
		<p class="muted small">Every submission with an email address gets these.</p>
		{#if lists.length}
			<div class="checks" role="group" aria-label="Lists">
				{#each lists as l (l.id)}
					<label class="tick"><input type="checkbox" checked={listIds.has(l.id)} onchange={(e) => toggleList(l.id, e.currentTarget.checked)} /> {l.name}</label>
				{/each}
			</div>
		{:else}
			<p class="muted small">No lists yet.</p>
		{/if}
		<label>Tags <span class="muted">(comma-separated)</span>
			<input value={tagsText} onchange={(e) => setTags(e.currentTarget.value)} placeholder="e.g. lead, webinar-2026" />
		</label>
		<label>Source <span class="muted">(stamped on new contacts)</span>
			<input value={source} onchange={(e) => setSource(e.currentTarget.value)} placeholder="form" maxlength="60" />
		</label>
		<div class="setfields">
			<span class="lbl">Set fields <span class="muted">(the same value on every submission)</span></span>
			{#each setFields as sf, i (i)}
				{@const fd = fieldOf(sf.key)}
				<div class="sf-row">
					<CustomFieldPicker
						value={sf.key}
						fields={customFields}
						label="Field"
						canCreate={!readonly}
						suggestion={{ label: '', type: 'text', options: [] }}
						onpick={(key) => editSetFields((s) => s.map((x, j) => (j === i ? { ...x, key } : x)))}
						oncreated={onfieldcreated}
					/>
					<label class="sf-val">Value
						{#if fd?.type === 'choice' || fd?.type === 'yes_no'}
							<select value={sf.value} onchange={(e) => editSetFields((s) => s.map((x, j) => (j === i ? { ...x, value: e.currentTarget.value } : x)))}>
								<option value="">Choose…</option>
								{#if fd.type === 'yes_no'}<option value={YES_VALUE}>Yes</option><option value={NO_VALUE}>No</option>{:else}{#each fd.options as o (o)}<option value={o}>{o}</option>{/each}{/if}
							</select>
						{:else}
							<input
								type={fd?.type === 'number' ? 'number' : fd?.type === 'date' ? 'date' : 'text'}
								value={sf.value}
								maxlength={FORM_LIMITS.shortAnswer}
								onchange={(e) => editSetFields((s) => s.map((x, j) => (j === i ? { ...x, value: e.currentTarget.value } : x)))}
							/>
						{/if}
					</label>
					<button type="button" class="secondary" aria-label="Remove this field" onclick={() => editSetFields((s) => s.filter((_, j) => j !== i))}>Remove</button>
				</div>
			{/each}
			<!-- Set fields share the outcome's action cap with lists, tags, source and the message (validateFormSpec). -->
			<button type="button" class="secondary" onclick={addSetField} disabled={actions.length >= FORM_LIMITS.actions}>Set a field</button>
		</div>
		<label class="tick"><input type="checkbox" bind:checked={spec.settings.enroll} /> Enrol in automations (list adds start list-triggered automations; submissions start “Form submitted” automations)</label>
		<p class="muted small">Tags always start tag-triggered automations, as everywhere else.</p>
	</section>

	<section class="group">
		<h3>Subscription topics</h3>
		{#if topicsField}
			<p class="muted small">Topics the “{topicsField.label || 'topics'}” question offers:</p>
			{#if topics.length}
				<div class="checks" role="group" aria-label="Topics offered">
					{#each topics as t (t.id)}
						<label class="tick"><input type="checkbox" checked={topicsField.options.some((o) => o.value === String(t.id))} onchange={(e) => toggleTopic(t.id, t.label, e.currentTarget.checked)} /> {t.label}</label>
					{/each}
				</div>
			{:else}
				<p class="muted small">No topics yet. Mark a list as a topic on its page.</p>
			{/if}
		{:else}
			<p class="muted small">Add a Subscription topics question to let people pick topics.</p>
			<button type="button" class="secondary" onclick={addTopicsQuestion} disabled={!topics.length}>Add a topics question</button>
		{/if}
	</section>

	<section class="group">
		<h3>Who can submit</h3>
		<label class="tick"><input type="checkbox" bind:checked={spec.settings.allow_anonymous} /> Allow anonymous submissions (no email needed; no contact is created)</label>
		<label class="tick"><input type="checkbox" bind:checked={spec.settings.double_optin} /> Double opt-in</label>
		{#if spec.settings.double_optin}<p class="muted small">New and unsubscribed addresses get a confirm email first; lists, tags, topics and fields apply only after they confirm. The email is set in <a href="/settings/double-optin">Settings → Double opt-in</a>.</p>{/if}
	</section>

	<section class="group">
		<h3>Notify</h3>
		{#if users.length}
			<p class="muted small">Email these people on every submission.</p>
			<div class="checks" role="group" aria-label="Notify">
				{#each users as u (u.id)}
					<label class="tick">
						<input type="checkbox" disabled={!u.email} checked={spec.settings.notify_user_ids.includes(u.id)} onchange={(e) => toggleNotify(u.id, e.currentTarget.checked)} />
						@{u.login} {#if u.email}<span class="muted">{u.email}</span>{:else}<span class="muted">(no email on file)</span>{/if}
					</label>
				{/each}
			</div>
		{:else}
			<p class="muted small">No one to notify.</p>
		{/if}
		{#each p('settings.notify_user_ids') as m, i (i)}<p class="err">{m}</p>{/each}
		<label>Webhook URL
			<input type="url" inputmode="url" placeholder="https://example.com/hooks/form" maxlength="2000" bind:value={spec.settings.notify_webhook} aria-describedby="form-webhook-help" />
		</label>
		<p id="form-webhook-help" class="muted small">Optional. Every accepted submission is POSTed here as JSON (form, contact_id, email, answers, submitted_at, page_url), signed with an <code>X-DSV-Signature</code> header. https only; a failed delivery is noted on the submission.</p>
		{#if webhookSecret && spec.settings.notify_webhook}
			<p class="muted small">Signing key: <code class="secret">{webhookSecret}</code> — verify <code>v1</code> = HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code> with this key.</p>
		{/if}
		{#each p('settings.notify_webhook') as m, i (i)}<p class="err">{m}</p>{/each}
	</section>

	<section class="group">
		<h3>Privacy</h3>
		<label>Keep submissions for (days)
			<input type="number" min="1" max="3650" bind:value={spec.settings.retention_days} />
		</label>
		{#each p('settings.retention_days') as m, i (i)}<p class="err">{m}</p>{/each}
		<label class="tick"><input type="checkbox" bind:checked={spec.settings.noindex} /> Hide from search engines (noindex)</label>
	</section>
</fieldset>

<style>
	.settings { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-l); max-width: 640px; min-width: 0; }
	.group { display: flex; flex-direction: column; gap: var(--space-s); }
	h3 { margin: 0; font-size: var(--size-s); line-height: var(--line-s); font-weight: var(--weight-ui-medium); }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); }
	label.tick { flex-direction: row; align-items: center; gap: var(--space-xs); }
	.slug-row { display: flex; align-items: center; gap: var(--space-xxs); flex-wrap: wrap; font-family: var(--font-mono); }
	.slug-row input { flex: 1 1 160px; min-width: 0; }
	.checks { display: flex; flex-direction: column; gap: var(--space-xxs); max-height: 220px; overflow: auto; }
	.radios { display: flex; gap: var(--space-m); flex-wrap: wrap; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); margin: 0; }
	.secret { word-break: break-all; }
	.err { color: var(--danger); font-size: var(--size-s); margin: 0; }
	button { align-self: flex-start; }
	.setfields { display: flex; flex-direction: column; gap: var(--space-xs); }
	.lbl { font-size: var(--size-s); line-height: var(--line-s); }
	.sf-row { display: flex; flex-wrap: wrap; gap: var(--space-s); align-items: flex-end; }
	.sf-val { flex: 1 1 160px; }
</style>

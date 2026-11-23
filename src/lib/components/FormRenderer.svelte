<script lang="ts">
	// Forms (#509): renders a form spec + style — the public page (/f/<slug>) and the builder's
	// preview. Its root carries the style as CSS variables and sets its own font, colours and
	// sizes, so it inherits nothing from the page around it. Structure follows the unsubscribe
	// page (logo → h1 → text → controls), so the "Feedback page" preset looks like it.
	//
	// Works without JS: every page is rendered and the form posts natively. With JS: one page
	// at a time (Back / Next), questions hidden by `show_when` disappear as you answer, and the
	// submit is a fetch that swaps in the thank-you message (or follows the redirect).
	import { onMount } from 'svelte';
	import { renderAssistantMarkdown } from '$lib/assistant-markdown';
	import {
		coerceAnswers,
		fieldsByPage,
		isAnswerType,
		ratingOf,
		styleVars,
		type Answers,
		type FormField,
		type FormSpec,
		type FormStyle,
		type RawAnswers
	} from '$lib/forms';
	import { formPath } from '$lib/form-logic';
	import { RATING_CSS, ratingGroupHtml } from '$lib/form-rating';

	let {
		spec,
		style,
		prefill = {},
		action = '',
		embedded = false,
		preview = false,
		logoSrc = '',
		appName = '',
		error = null,
		onanswers,
		hiddenFields = {},
		lockedKey = null,
		onredirect = null
	}: {
		/** #514: the builder preview's answers, for its "Why hidden?" hint. */
		onanswers?: (answers: Answers) => void;
		spec: FormSpec;
		style: FormStyle;
		/** Initial values by answer key (`?email=` / `?<key>=`), plus `utm_*`. */
		prefill?: Record<string, string | string[]>;
		action?: string;
		embedded?: boolean;
		/** Builder preview: never submits. */
		preview?: boolean;
		logoSrc?: string;
		appName?: string;
		/** A message from a failed native post (`?error=`). */
		error?: string | null;
		/** #515: extra hidden inputs posted with the answers (`_page_url`, `_ref`, `_c`). */
		hiddenFields?: Record<string, string>;
		/** #515: an answer key filled from a signed link and not shown (the email question). */
		lockedKey?: string | null;
		/** #515: embedded — hand a redirect outcome to the host page instead of navigating the frame. */
		onredirect?: ((url: string) => void) | null;
	} = $props();

	const HONEYPOT = '_hp_url';
	const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

	let js = $state(false);
	let formEl = $state<HTMLFormElement | null>(null);
	let pageIdx = $state(0);
	let raw = $state<RawAnswers>({});
	let sending = $state(false);
	let done = $state<{ html: string } | null>(null);
	let errors = $state<Record<string, string>>({});
	let formError = $state<string | null>(null);
	let referrer = $state('');

	const pages = $derived(fieldsByPage(spec.fields));
	const loose = $derived(coerceAnswers({ fields: spec.fields.map((f) => ({ ...f, required: false })) }, raw).answers);
	// #514: the page-jump chain for the current answers. Pages off it are skipped: their inputs
	// are disabled (never posted, never block the submit) and Back / Next walk the chain.
	const path = $derived(formPath(spec, loose));
	const shownIds = $derived(new Set(path.fields.map((f) => f.id)));
	const chain = $derived(path.pages);
	const pos = $derived.by(() => {
		const at = chain.indexOf(pageIdx);
		if (at >= 0) return at;
		let best = 0;
		chain.forEach((p, i) => {
			if (p <= pageIdx) best = i;
		});
		return best;
	});
	const md = (t: string) => renderAssistantMarkdown(t);
	const uid = $derived(`dsf-${spec.fields[0]?.id ?? 'x'}`);
	// Rating questions (#589) are drawn by the shared ratingGroupHtml; their CSS (RATING_CSS) is
	// the plain renderer's too, so it's injected as one style element rather than copied here.
	const hasRating = $derived(spec.fields.some((f) => f.type === 'rating'));
	// Split so the component parser never sees a style tag inside the script.
	const RATING_STYLE_TAG = '<' + 'style>' + RATING_CSS + '</' + 'style>';

	function initial(f: FormField): string[] {
		const v = prefill[f.key];
		return Array.isArray(v) ? v : v === undefined ? [] : [v];
	}
	function first(f: FormField) {
		return initial(f)[0] ?? '';
	}

	function readForm() {
		if (!formEl) return;
		const fd = new FormData(formEl);
		const next: RawAnswers = {};
		for (const f of spec.fields) {
			if (!isAnswerType(f.type)) continue;
			const all = fd.getAll(f.key).map(String);
			next[f.key] = all.length > 1 || f.type === 'checkboxes' || f.type === 'topics' ? all : all[0];
		}
		raw = next;
		if (onanswers) onanswers(coerceAnswers({ fields: spec.fields.map((f) => ({ ...f, required: false })) }, next).answers);
	}

	onMount(() => {
		js = true;
		referrer = document.referrer.slice(0, 500);
		readForm();
	});

	function pageValid(): boolean {
		if (!formEl) return true;
		const scope = formEl.querySelector<HTMLElement>(`[data-page="${pageIdx}"]`);
		if (!scope) return true;
		for (const node of scope.querySelectorAll('input, select, textarea')) {
			const el = node as HTMLInputElement;
			if (el.closest('[hidden]')) continue;
			if (!el.checkValidity()) {
				el.reportValidity();
				return false;
			}
		}
		return true;
	}

	function next() {
		if (!pageValid()) return;
		const to = chain[pos + 1];
		if (to !== undefined) pageIdx = to;
		formEl?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}
	function back() {
		if (pos > 0) pageIdx = chain[pos - 1];
	}

	async function onsubmit(e: SubmitEvent) {
		if (preview) {
			e.preventDefault();
			return;
		}
		if (!js || !formEl) return; // native post
		e.preventDefault();
		if (pos < chain.length - 1) {
			next();
			return;
		}
		if (!pageValid()) return;
		sending = true;
		errors = {};
		formError = null;
		try {
			const res = await fetch(action, { method: 'POST', body: new FormData(formEl), headers: { accept: 'application/json' } });
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				redirect?: string;
				message_html?: string;
				errors?: Record<string, string>;
				error?: string;
			};
			if (body.ok) {
				if (body.redirect) {
					if (onredirect) onredirect(body.redirect);
					else window.location.href = body.redirect;
					return;
				}
				done = { html: body.message_html ?? '' };
			} else {
				errors = body.errors ?? {};
				formError = body.error ?? 'Something went wrong. Please try again.';
				// Jump to the first page with an error.
				const firstKey = Object.keys(errors)[0];
				if (firstKey) {
					const idx = pages.findIndex((p) => p.some((f) => f.key === firstKey));
					if (idx >= 0) pageIdx = idx;
				}
			}
		} catch {
			formError = 'Couldn’t send. Check your connection and try again.';
		} finally {
			sending = false;
		}
	}

	const isLast = $derived(pos >= chain.length - 1);
</script>

<div class="dsf" class:embedded class:framed={embedded && !preview} class:cards={style.cards} style={styleVars(style)}>
	{#if hasRating}{@html RATING_STYLE_TAG}{/if}
	<div class="dsf-page">
		{#if style.logo && logoSrc}
			<img class="dsf-logo" src={logoSrc} alt={appName} height="40" />
		{/if}

		{#if done}
			<div class="dsf-done" role="status">
				<div class="dsf-md">{@html done.html}</div>
			</div>
		{:else}
			<form
				bind:this={formEl}
				method="POST"
				action={preview ? undefined : action}
				oninput={readForm}
				onchange={readForm}
				{onsubmit}
				novalidate={false}
			>
				{#each pages as page, pi (pi)}
					<div class="dsf-section" data-page={pi} hidden={js && pi !== pageIdx}>
						{#if pi === 0}
							<header class="dsf-head" class:dsf-card={style.cards}>
								<h1>{spec.title}</h1>
								{#if spec.intro_md.trim()}<div class="dsf-md dsf-intro">{@html md(spec.intro_md)}</div>{/if}
							</header>
						{/if}
						{#each page as f (f.id)}
							{@const hiddenByLogic = js && (!shownIds.has(f.id) || !chain.includes(pi))}
							{#if f.type === 'page_break'}
								<div class="dsf-break" class:dsf-card={style.cards}>
									{#if !js}<hr />{/if}
									{#if f.label.trim()}<h2>{f.label}</h2>{/if}
									{#if f.help.trim()}<p class="dsf-help">{f.help}</p>{/if}
								</div>
							{:else if f.type === 'heading'}
								<h2 class="dsf-h" hidden={hiddenByLogic}>{f.label}</h2>
							{:else if f.type === 'paragraph'}
								<div class="dsf-md" hidden={hiddenByLogic}>{@html md(f.label)}</div>
							{:else if f.type === 'hidden' || (lockedKey && f.key === lockedKey)}
								<input type="hidden" name={f.key} value={first(f)} disabled={hiddenByLogic} />
							{:else}
								{@const id = `${uid}-${f.id}`}
								{@const err = errors[f.key]}
								{@const req = f.required && !f.show_when}
								<div class="dsf-q" class:dsf-card={style.cards} class:has-err={!!err} hidden={hiddenByLogic} data-key={f.key}>
									{#if f.type === 'checkbox' || f.type === 'consent'}
										<label class="dsf-tick">
											<input type="checkbox" name={f.key} value="on" checked={['on', '1', 'true', 'yes'].includes(first(f).toLowerCase())} required={req} disabled={hiddenByLogic} aria-describedby={f.help ? `${id}-h` : undefined} />
											<span>{f.label}{#if f.required}<span class="dsf-req" aria-hidden="true"> *</span>{/if}</span>
										</label>
									{:else if f.type === 'rating'}
										<!-- #589: the shared, script-free radio group (same markup as the plain renderer). -->
										{@html ratingGroupHtml(ratingOf(f), {
											name: f.key,
											legend: f.label,
											legendSuffix: f.required ? '<span class="dsf-req" aria-hidden="true"> *</span>' : '',
											required: req,
											disabled: hiddenByLogic,
											checked: /^\d+$/.test(first(f)) ? Number(first(f)) : null,
											describedBy: f.help ? `${id}-h` : undefined
										})}
									{:else if f.type === 'radio' || f.type === 'checkboxes' || f.type === 'topics'}
										<fieldset aria-describedby={f.help ? `${id}-h` : undefined}>
											<legend>{f.label}{#if f.required}<span class="dsf-req" aria-hidden="true"> *</span>{/if}</legend>
											{#each f.options as o, oi (o.value + oi)}
												<label class="dsf-tick">
													<input
														type={f.type === 'radio' ? 'radio' : 'checkbox'}
														name={f.key}
														value={o.value}
														checked={initial(f).includes(o.value)}
														required={req && f.type === 'radio'}
														disabled={hiddenByLogic}
													/>
													<span>{o.label || o.value}</span>
												</label>
											{/each}
										</fieldset>
									{:else}
										<label for={id}>{f.label}{#if f.required}<span class="dsf-req" aria-hidden="true"> *</span>{/if}</label>
										{#if f.type === 'long_text'}
											<textarea {id} name={f.key} rows="4" placeholder={f.placeholder} required={req} disabled={hiddenByLogic} maxlength="5000" aria-describedby={f.help ? `${id}-h` : undefined}>{first(f)}</textarea>
										{:else if f.type === 'select'}
											<select {id} name={f.key} required={req} disabled={hiddenByLogic} aria-describedby={f.help ? `${id}-h` : undefined}>
												<option value="">{f.placeholder || 'Choose…'}</option>
												{#each f.options as o, oi (o.value + oi)}
													<option value={o.value} selected={first(f) === o.value}>{o.label || o.value}</option>
												{/each}
											</select>
										{:else}
											<input
												{id}
												name={f.key}
												type={f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : f.type === 'date' ? 'date' : f.type === 'phone' ? 'tel' : 'text'}
												inputmode={f.type === 'url' ? 'url' : undefined}
												autocomplete={f.map?.to === 'contact' ? (f.map.field === 'email' ? 'email' : f.map.field === 'first_name' ? 'given-name' : f.map.field === 'last_name' ? 'family-name' : f.map.field === 'name' ? 'name' : f.map.field === 'company' ? 'organization' : f.map.field === 'phone' ? 'tel' : undefined) : undefined}
												placeholder={f.placeholder}
												value={first(f)}
												required={req}
												disabled={hiddenByLogic}
												maxlength={f.type === 'url' ? 2000 : 500}
												aria-describedby={f.help ? `${id}-h` : undefined}
												aria-invalid={err ? 'true' : undefined}
											/>
										{/if}
									{/if}
									{#if f.help.trim()}<p class="dsf-help" id="{id}-h">{f.help}</p>{/if}
									{#if err}<p class="dsf-err" role="alert">{err}</p>{/if}
								</div>
							{/if}
						{/each}
					</div>
				{/each}

				<!-- Off-screen honeypot: people never see or fill it. -->
				<div class="dsf-hp" aria-hidden="true">
					<label>Website <input type="text" name={HONEYPOT} tabindex="-1" autocomplete="off" value="" /></label>
				</div>
				{#each UTM as k (k)}
					{#if typeof prefill[k] === 'string' && prefill[k]}<input type="hidden" name="_{k}" value={prefill[k]} />{/if}
				{/each}
				{#if referrer && !hiddenFields._ref}<input type="hidden" name="_ref" value={referrer} />{/if}
				{#each Object.entries(hiddenFields) as [k, v] (k)}
					{#if v}<input type="hidden" name={k} value={v} />{/if}
				{/each}

				{#if formError || error}<p class="dsf-err dsf-form-err" role="alert">{formError ?? error}</p>{/if}

				<div class="dsf-actions">
					{#if js && pageIdx > 0}
						<button type="button" class="dsf-secondary" onclick={back}>Back</button>
					{/if}
					{#if js && !isLast}
						<button type="button" class="dsf-primary" onclick={next}>Next</button>
					{:else}
						<button type="submit" class="dsf-primary" disabled={sending}>{sending ? 'Sending…' : spec.settings.submit_label}</button>
					{/if}
					{#if js && chain.length > 1}
						<span class="dsf-progress">Page {pos + 1} of {chain.length}</span>
					{/if}
				</div>
			</form>
		{/if}
	</div>
</div>

<style>
	.dsf {
		box-sizing: border-box;
		background: var(--f-bg);
		color: var(--f-text);
		font-family: var(--f-font);
		font-size: 16px;
		line-height: 1.5;
		letter-spacing: normal;
		text-align: left;
		padding: 40px 16px;
		min-height: 100%;
		overflow-wrap: anywhere;
	}
	/* #515: embedded in another site's page — the host shows through, no outer padding (a few px
	   so focus outlines aren't clipped by the frame). */
	.dsf.embedded { padding: 16px; min-height: 0; }
	.dsf.framed { padding: 4px; background: transparent; }
	.dsf :global(*), .dsf :global(*::before), .dsf :global(*::after) { box-sizing: border-box; }
	.dsf-page { width: 100%; max-width: var(--f-width); margin: 0 auto; }
	.dsf-logo { display: block; height: 40px; width: auto; max-width: 200px; margin: 0 0 16px; }
	h1 { margin: 0 0 4px; font-size: 26px; line-height: 1.25; font-weight: 650; color: var(--f-text); }
	h2 { margin: 0 0 4px; font-size: 19px; line-height: 1.3; font-weight: 620; color: var(--f-text); }
	.dsf-h { margin-top: 24px; }
	form { display: flex; flex-direction: column; gap: 0; margin: 0; }
	.dsf-section { display: flex; flex-direction: column; gap: 20px; }
	.dsf-section[hidden], .dsf-q[hidden], .dsf-h[hidden], .dsf-md[hidden] { display: none; }
	.dsf-head { margin-bottom: 4px; }
	.dsf-intro { color: var(--f-muted); }
	.dsf-md :global(p) { margin: 0 0 10px; }
	.dsf-md :global(p:last-child) { margin-bottom: 0; }
	.dsf-md :global(a) { color: inherit; text-decoration-color: var(--f-accent); }
	.dsf-md :global(img) { max-width: 100%; }
	.dsf-break { margin-top: 12px; }
	.dsf-break hr { border: 0; border-top: 1px solid var(--f-border); margin: 8px 0 20px; }
	.dsf-q { display: flex; flex-direction: column; gap: 6px; }
	.dsf-card { background: var(--f-surface); border: 1px solid var(--f-border); border-radius: var(--f-radius); padding: 20px; }
	.dsf-q > label, legend { font-size: 15px; font-weight: 560; color: var(--f-text); }
	fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
	legend { padding: 0; margin-bottom: 6px; }
	.dsf-req, .dsf :global(.rt .dsf-req) { color: var(--f-accent); }
	.dsf :global(.rt legend) { padding: 0; margin-bottom: 6px; font-size: 15px; font-weight: 560; color: var(--f-text); }
	input:not([type='checkbox']):not([type='radio']), select, textarea {
		font: inherit;
		color: var(--f-text);
		background: var(--f-surface);
		border: 1px solid var(--f-border);
		border-radius: var(--f-radius);
		padding: 9px 12px;
		width: 100%;
		min-height: 42px;
	}
	textarea { resize: vertical; }
	input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
		outline: 2px solid var(--f-accent);
		outline-offset: 2px;
	}
	.has-err input, .has-err select, .has-err textarea { border-color: #b34846; }
	.dsf-tick { display: flex; align-items: flex-start; gap: 10px; font-size: 15px; font-weight: 400; cursor: pointer; }
	.dsf-tick input { margin: 4px 0 0; width: 16px; height: 16px; accent-color: var(--f-accent); flex: none; }
	.dsf-help { margin: 0; font-size: 13px; line-height: 1.45; color: var(--f-muted); }
	.dsf-err { margin: 0; font-size: 13px; color: #b34846; }
	.dsf.cards .dsf-err { color: #d4605d; }
	.dsf-form-err { margin-top: 16px; }
	.dsf-hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
	.dsf-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
	button {
		font: inherit;
		font-size: 15px;
		font-weight: 560;
		border-radius: var(--f-radius);
		padding: 10px 18px;
		cursor: pointer;
		min-height: 42px;
	}
	.dsf-primary { background: var(--f-accent); color: var(--f-on-accent); border: 1px solid var(--f-accent); }
	.dsf-primary:hover { filter: brightness(0.92); }
	.dsf-primary:disabled { opacity: 0.7; cursor: progress; }
	.dsf-secondary { background: transparent; color: var(--f-text); border: 1px solid var(--f-border); }
	.dsf-progress { font-size: 13px; color: var(--f-muted); margin-left: auto; }
	.dsf-done { padding: 8px 0; }
</style>

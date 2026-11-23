<script lang="ts">
	// #515: the builder's Share & embed tab. Allowed origins (saved with the form's one Save),
	// "Where it works", and copy-paste snippets: script embed, plain iframe, direct link, the
	// campaign merge tag {{form:<slug>}}, and a raw HTML form.
	import type { FormSpec } from '$lib/forms';
	import {
		IFRAME_DEFAULT_HEIGHT,
		cleanOriginLine,
		formTag,
		iframeSnippet,
		originProblem,
		rawHtmlSnippet,
		scriptSnippet,
		whereItWorks
	} from '$lib/form-embed';

	let {
		spec = $bindable(),
		slug,
		name,
		baseUrl,
		published,
		readonly = false,
		problems = []
	}: {
		spec: FormSpec;
		/** The saved slug (the live address). */
		slug: string;
		name: string;
		baseUrl: string;
		published: boolean;
		readonly?: boolean;
		problems?: string[];
	} = $props();

	const base = $derived(baseUrl.replace(/\/+$/, ''));
	let height = $state(IFRAME_DEFAULT_HEIGHT);
	let copied = $state<string | null>(null);

	async function copy(id: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = id;
			setTimeout(() => (copied = copied === id ? null : copied), 1500);
		} catch {
			/* clipboard blocked — the text is selectable as a fallback */
		}
	}

	// Edited as text, one origin per line; each line is tidied to its origin as it's typed.
	// svelte-ignore state_referenced_locally
	let originsText = $state(spec.settings.allowed_origins.join('\n'));
	function setOrigins(text: string) {
		originsText = text;
		const list = text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
			.map(cleanOriginLine);
		spec = { ...spec, settings: { ...spec.settings, allowed_origins: list } };
	}
	const lineProblems = $derived(spec.settings.allowed_origins.map(originProblem).filter((p): p is string => !!p));

	const snippets = $derived([
		{ id: 'script', title: 'Script embed', hint: 'Paste where the form should appear. It sizes itself to its content and passes the page’s utm_* through. Prefill with data-email or data-<answer key> on the div.', text: scriptSnippet(base, slug) },
		{ id: 'iframe', title: 'Plain iframe', hint: 'Fixed height; no script needed on your page.', text: iframeSnippet(base, slug, spec.title || name, height) },
		{ id: 'link', title: 'Direct link', hint: 'The hosted form page.', text: `${base}/f/${slug}` },
		{ id: 'tag', title: 'Prefilled link for campaigns', hint: 'Use this merge tag as a link or button address in an email. Each recipient gets a link with their email filled in and hidden, so the answer is credited to them. The prefill lasts 30 days.', text: formTag(slug) },
		{ id: 'html', title: 'Raw HTML', hint: 'A plain form that posts straight to the CRM. Conditional logic and pages don’t run in this mode, and the site must be in the allowed origins (when any are set).', text: rawHtmlSnippet(base, slug, spec) }
	]);
</script>

<section class="share">
	{#if !published}
		<p class="notice warn" role="status">This form isn’t published yet. The links and embeds below work once it is.</p>
	{/if}

	<div class="card">
		<h2>Allowed origins</h2>
		<p class="muted small">The sites this form may be embedded on and submitted from, one per line (<code>https://example.com</code>). This CRM is always allowed. Saved with <strong>Save</strong>. A change applies to new submissions and the embedded page at once; sites using the script embed pick it up within a minute, once their cached copy of the script runs out.</p>
		<textarea
			rows="4"
			aria-label="Allowed origins, one per line"
			placeholder="https://example.com"
			value={originsText}
			disabled={readonly}
			oninput={(e) => setOrigins((e.currentTarget as HTMLTextAreaElement).value)}
		></textarea>
		{#each [...lineProblems, ...problems.filter((p) => !lineProblems.includes(p))] as p, i (i)}
			<p class="err small" role="alert">{p}</p>
		{/each}
		<p class="where"><strong>Where it works:</strong> {whereItWorks(spec.settings.allowed_origins)}</p>
	</div>

	{#each snippets as s (s.id)}
		<div class="card">
			<div class="head">
				<h2>{s.title}</h2>
				<button type="button" class="secondary sm" onclick={() => copy(s.id, s.text)}>{copied === s.id ? 'Copied!' : 'Copy'}</button>
			</div>
			<p class="muted small">{s.hint}</p>
			{#if s.id === 'iframe'}
				<label class="small">Height (px) <input type="number" min="100" max="5000" step="10" bind:value={height} /></label>
			{/if}
			<pre><code>{s.text}</code></pre>
		</div>
	{/each}
</section>

<style>
	.share { display: flex; flex-direction: column; gap: var(--card-gap, 16px); }
	.card { padding: var(--card-pad, 16px); }
	h2 { margin: 0 0 4px; font-size: 1rem; }
	.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	textarea { width: 100%; font-family: var(--font-mono, monospace); margin-top: 8px; }
	pre { margin: 8px 0 0; padding: 10px 12px; background: var(--code-bg, var(--bg-subtle, rgba(127, 127, 127, 0.08))); border-radius: var(--radius); overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: 13px; }
	.where { margin: 8px 0 0; }
	.err { color: var(--danger); margin: 6px 0 0; }
	label input { width: 100px; margin-left: 6px; }
	.small { font-size: 0.875rem; }
</style>

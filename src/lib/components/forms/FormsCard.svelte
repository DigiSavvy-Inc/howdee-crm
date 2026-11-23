<script lang="ts">
	// Contact page Forms card (#516): the contact's form submissions, newest first — form name,
	// date, a status chip, the answers behind a disclosure and a link to the form's Submissions
	// tab searched for this contact's address. The page hides the card when there are none.
	import type { ContactSubmission } from '$lib/server/form-reads';

	let { submissions, email }: { submissions: ContactSubmission[]; email: string } = $props();

	const STATUS: Record<string, { label: string; cls: string }> = {
		added: { label: 'New contact', cls: 'sent' },
		updated: { label: 'Updated', cls: 'draft' },
		anonymous: { label: 'Anonymous', cls: 'draft' },
		spam: { label: 'Spam', cls: 'failed' },
		rejected: { label: 'Rejected', cls: 'failed' }
	};
	const day = (iso: string) => iso.slice(0, 10);
	const subsHref = (formId: number) => `/forms/${formId}?tab=submissions&q=${encodeURIComponent(email)}`;
</script>

<section class="card forms-card" id="forms">
	<h2>Forms</h2>
	<ul>
		{#each submissions as s (s.id)}
			<li>
				<div class="line">
					<a href="/forms/{s.form_id}">{s.form_name}</a>
					<span class="badge {STATUS[s.status]?.cls ?? 'draft'}">{STATUS[s.status]?.label ?? s.status}</span>
					<time class="muted small" datetime={s.created_at.replace(' ', 'T') + 'Z'}>{day(s.created_at)}</time>
				</div>
				{#if s.answers.length}
					<details>
						<summary class="small">{s.answers.length} answer{s.answers.length === 1 ? '' : 's'}</summary>
						<dl>
							{#each s.answers as a, i (i)}
								<dt>{a.label}</dt>
								<dd>{a.text || '—'}</dd>
							{/each}
						</dl>
					</details>
				{/if}
				<p class="small"><a href={subsHref(s.form_id)}>Their submissions to this form</a></p>
			</li>
		{/each}
	</ul>
</section>

<style>
	.forms-card { margin-bottom: var(--space-l); }
	h2 { margin: 0; font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--letter-spacing-m); }
	ul { list-style: none; margin: var(--space-s) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-s); }
	li + li { border-top: 1px solid var(--border); padding-top: var(--space-s); }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
	details { margin-top: var(--space-xxs); }
	summary { cursor: pointer; }
	dl { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: var(--space-xxs) var(--space-s); margin: var(--space-xs) 0 0; }
	dt { color: var(--muted); font-size: var(--size-s); line-height: var(--line-s); }
	dd { margin: 0; font-size: var(--size-s); line-height: var(--line-s); overflow-wrap: anywhere; white-space: pre-wrap; }
	p { margin: var(--space-xxs) 0 0; }
	.small { font-size: var(--size-s); line-height: var(--line-s); }
</style>

<script lang="ts">
	// #398: "Simulate a contact" — pick a contact (the session-gated /api/contacts/search
	// typeahead) and see the path they would take through this automation today: branch
	// decisions against live data, waits as durations. POST /automations/[id]/simulate is
	// read-only — nothing is enrolled, sent or recorded.
	type Hit = { id: number; email: string; name: string | null; subscribed: number };
	type SimStep = { step_id: number; title: string; type: string; depth: number; wait: string | null; at: string; decision: string | null; note: string | null };
	type SimResult = { contact: { id: number; email: string; name: string | null }; notes: string[]; path: SimStep[]; end: string };

	let { automationId, onopen }: { automationId: number; onopen?: (stepId: number) => void } = $props();

	let q = $state('');
	let hits = $state<Hit[]>([]);
	let busy = $state(false);
	let failed = $state('');
	let result = $state<SimResult | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function search() {
		clearTimeout(timer);
		const term = q.trim();
		if (term.length < 2) {
			hits = [];
			return;
		}
		timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(term)}`);
				hits = res.ok ? ((await res.json()) as Hit[]) : [];
			} catch {
				hits = [];
			}
		}, 200);
	}

	async function simulate(h: Hit) {
		hits = [];
		q = h.email;
		busy = true;
		failed = '';
		try {
			const fd = new FormData();
			fd.set('contact_id', String(h.id));
			const res = await fetch(`/automations/${automationId}/simulate`, { method: 'POST', body: fd });
			if (!res.ok) throw new Error(String(res.status));
			result = (await res.json()) as SimResult;
		} catch {
			failed = "Couldn't simulate this contact. Try again.";
		} finally {
			busy = false;
		}
	}
</script>

<section class="card sim" aria-labelledby="sim-h">
	<h2 id="sim-h">Simulate a contact</h2>
	<p class="muted intro">See the path someone would take if they were enrolled today. Nothing is sent or recorded.</p>
	<div class="picker">
		<input
			type="search"
			bind:value={q}
			oninput={search}
			placeholder="Search a contact by email or name"
			aria-label="Contact to simulate"
			autocomplete="off"
		/>
		{#if hits.length}
			<ul class="hits" role="listbox" aria-label="Matching contacts">
				{#each hits as h (h.id)}
					<li>
						<button type="button" role="option" aria-selected="false" onclick={() => simulate(h)}>
							{h.name ? `${h.name} · ` : ''}{h.email}{#if !h.subscribed}<span class="muted"> (unsubscribed)</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	{#if busy}<p class="muted" role="status">Simulating…</p>{/if}
	{#if failed}<p class="err" role="alert">{failed}</p>{/if}
	{#if result && !busy}
		<div class="out" role="status">
			<p><strong>{result.contact.name ?? result.contact.email}</strong>{#if result.contact.name}<span class="muted"> · {result.contact.email}</span>{/if}</p>
			{#each result.notes as n (n)}<p class="warn">{n}</p>{/each}
			{#if result.path.length}
				<ol class="path">
					{#each result.path as s, i (i)}
						<li style="margin-left: calc({Math.min(s.depth, 4)} * var(--space-m))">
							<span class="when muted">{s.at}{s.wait ? ` · ${s.wait}` : ''}</span>
							<button type="button" class="linklike" onclick={() => onopen?.(s.step_id)}>{s.title}</button>
							{#if s.decision}<span class="decision">→ {s.decision}</span>{/if}
							{#if s.note}<span class="note muted">{s.note}</span>{/if}
						</li>
					{/each}
				</ol>
			{/if}
			<p class="end">{result.end}</p>
		</div>
	{/if}
</section>

<style>
	.sim h2 {
		margin: 0;
	}
	.intro {
		margin: var(--space-xs) 0;
	}
	.picker {
		position: relative;
		max-width: 28rem;
	}
	.picker input {
		width: 100%;
	}
	.hits {
		position: absolute;
		z-index: 5;
		left: 0;
		right: 0;
		list-style: none;
		margin: 2px 0 0;
		padding: 4px 0;
		background: var(--surface);
		border: var(--border-s) solid var(--border);
		border-radius: var(--radius-s);
	}
	.hits button {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: 0;
		padding: 4px var(--space-xs);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.hits button:hover,
	.hits button:focus-visible {
		background: var(--surface-subtle);
	}
	.out p {
		margin: var(--space-xs) 0;
	}
	.warn {
		color: var(--warn);
	}
	.path {
		margin: var(--space-xs) 0;
		padding-left: var(--space-m);
		display: grid;
		gap: 4px;
	}
	.when {
		display: block;
		font-size: var(--size-s);
	}
	.decision {
		margin-left: 4px;
		font-weight: var(--weight-ui-heavy);
	}
	.note {
		display: block;
		font-size: var(--size-s);
	}
	.linklike {
		background: none;
		border: 0;
		padding: 0;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		cursor: pointer;
	}
	.end {
		font-weight: var(--weight-ui-heavy);
	}
	.err {
		color: var(--danger);
	}
</style>

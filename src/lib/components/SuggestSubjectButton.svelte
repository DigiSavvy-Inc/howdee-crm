<script lang="ts">
	// "Suggest with Claude" for a resend subject (#246). Fills the field through `onpick`;
	// the person still reviews and saves it. A failure keeps the current text.
	let { subject, onpick }: { subject: () => string; onpick: (s: string) => void } = $props();

	let busy = $state(false);
	let failed = $state(false);

	async function suggest() {
		const current = subject().trim();
		if (!current || busy) return;
		busy = true;
		failed = false;
		try {
			const res = await fetch('/api/ai/resend-subject', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ subject: current })
			});
			const body = res.ok ? ((await res.json()) as { subject?: string }) : null;
			if (body?.subject) onpick(body.subject);
			else failed = true;
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

<span class="suggest">
	<button type="button" class="secondary suggest-btn" disabled={busy} onclick={suggest}>
		{busy ? 'Suggesting…' : 'Suggest with Claude'}
	</button>
	{#if failed}<span class="suggest-err" role="status">Couldn't get a suggestion</span>{/if}
</span>

<style>
	.suggest { display: inline-flex; align-items: center; gap: var(--space-s); flex-wrap: wrap; }
	.suggest-btn {
		padding: var(--space-xxs) var(--space-s);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
	}
	.suggest-err { color: var(--danger); font-size: var(--size-xs); line-height: var(--line-xs); }
</style>

<script lang="ts">
	// #104: first-run product tour. A see-through overlay + a spotlight cutout over the
	// current step's target (via data-tour selectors added in +layout.svelte), with a card
	// that walks through the app. Auto-opens once per user (DB flag + localStorage belt &
	// suspenders); replayable from HelpPanel's "Take the tour" button via the shared
	// `tour` state in `$lib/tour.svelte.ts`.
	import { onMount, tick } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { tour, closeTour, startTour } from '$lib/tour.svelte';
	import { STEPS } from '$lib/tour-steps';
	import { DEFAULT_APP_NAME } from '$lib/branding';

	let { tourSeen, isAdmin, appName = DEFAULT_APP_NAME }: { tourSeen: boolean; isAdmin: boolean; appName?: string } = $props();

	let cardEl = $state<HTMLElement | null>(null);
	let centered = $state(true);
	let spot = $state<{ top: number; left: number; width: number; height: number } | null>(null);
	let cardPos = $state<{ top: number; left: number } | null>(null);

	const reducedMotion = browser && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const transitionMs = reducedMotion ? 0 : 120;

	const currentStep = $derived(STEPS[tour.step] ?? STEPS[0]);
	// #188: the welcome step names the app as configured in Settings → Branding.
	const title = $derived(currentStep.id === 'welcome' ? `Welcome to ${appName}` : currentStep.title);
	const isLast = $derived(tour.step === STEPS.length - 1);
	const body = $derived.by(() => {
		const step = currentStep;
		if (step.id === 'settings' && isAdmin) {
			return `${step.body} You're an admin — Settings → Users controls who can sign in.`;
		}
		return step.body;
	});

	function clamp(v: number, min: number, max: number): number {
		return Math.min(Math.max(v, min), Math.max(min, max));
	}

	function positionFor(
		rect: DOMRect,
		placement: 'top' | 'bottom' | 'right' | undefined,
		cardW: number,
		cardH: number,
		vw: number,
		vh: number
	): { top: number; left: number } {
		const margin = 12;
		if (placement === 'right' && rect.right + margin + cardW <= vw - margin) {
			return { top: clamp(rect.top, margin, vh - cardH - margin), left: rect.right + margin };
		}
		const spaceBelow = vh - rect.bottom;
		const spaceAbove = rect.top;
		const wantsTop = placement === 'top';
		const goAbove = wantsTop
			? spaceAbove >= cardH + margin || spaceAbove > spaceBelow
			: spaceBelow < cardH + margin && spaceAbove > spaceBelow;
		const top = goAbove ? rect.top - cardH - margin : rect.bottom + margin;
		return {
			top: clamp(top, margin, vh - cardH - margin),
			left: clamp(rect.left, margin, vw - cardW - margin)
		};
	}

	async function updatePosition(doScrollIntoView: boolean) {
		if (!tour.open || !browser) return;
		const step = currentStep;
		let el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
		// #144: on phones the nav sits in the closed drawer — point at the hamburger instead.
		if (el?.closest('#app-drawer') && getComputedStyle(el).visibility === 'hidden') {
			el = document.querySelector<HTMLElement>('[data-tour="menu"]');
		}
		const rect = el?.getBoundingClientRect() ?? null;
		if (!el || !rect || (rect.width === 0 && rect.height === 0)) {
			centered = true;
			spot = null;
			cardPos = null;
			await tick();
			cardEl?.focus();
			return;
		}
		if (doScrollIntoView) el.scrollIntoView({ block: 'nearest' });
		const pad = 6;
		centered = false;
		spot = {
			top: rect.top - pad,
			left: rect.left - pad,
			width: rect.width + pad * 2,
			height: rect.height + pad * 2
		};
		await tick();
		if (cardEl) {
			const cw = cardEl.offsetWidth || 360;
			const ch = cardEl.offsetHeight || 160;
			// #134: in the sidebar layout the nav targets sit on the left edge — put the card beside them.
			const inSidebar =
				document.documentElement.getAttribute('data-nav') === 'left' &&
				!!el.closest('#app-nav') &&
				!window.matchMedia('(max-width: 768px)').matches;
			cardPos = positionFor(
				rect,
				inSidebar ? 'right' : step.placement,
				cw,
				ch,
				window.innerWidth,
				window.innerHeight
			);
		}
		cardEl?.focus();
	}

	$effect(() => {
		if (tour.open) {
			void tour.step;
			void updatePosition(true);
		} else {
			centered = true;
			spot = null;
			cardPos = null;
		}
	});

	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (!tourSeen) {
			let seenLocal = false;
			try {
				seenLocal = !!localStorage.getItem('tour:v1');
			} catch {
				// localStorage unavailable (private mode, etc.) — fall back to auto-opening.
			}
			if (!seenLocal) {
				timer = setTimeout(() => startTour(), 600);
			}
		}
		const onResize = () => updatePosition(false);
		const onScroll = () => updatePosition(false);
		window.addEventListener('resize', onResize);
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			if (timer) clearTimeout(timer);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('scroll', onScroll);
		};
	});

	function dismiss() {
		closeTour();
		try {
			localStorage.setItem('tour:v1', '1');
		} catch {
			// best-effort only
		}
		fetch('/api/tour/dismiss', { method: 'POST' }).catch(() => {});
	}

	function finishWithImport() {
		dismiss();
		goto('/contacts');
	}

	function next() {
		if (tour.step < STEPS.length - 1) tour.step += 1;
		else dismiss();
	}

	function back() {
		if (tour.step > 0) tour.step -= 1;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!tour.open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			dismiss();
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			next();
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			back();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if tour.open}
	<div
		class="tour-overlay"
		class:dim={!spot}
		role="presentation"
		aria-hidden="true"
		transition:fade={{ duration: transitionMs }}
	></div>
	{#if spot}
		<div
			class="tour-spot"
			style={`top:${spot.top}px;left:${spot.left}px;width:${spot.width}px;height:${spot.height}px;`}
			transition:fade={{ duration: transitionMs }}
		></div>
	{/if}
	<div
		class="tour-card"
		class:centered
		style={centered ? '' : `top:${cardPos?.top ?? 0}px;left:${cardPos?.left ?? 0}px;`}
		role="dialog"
		aria-modal="true"
		aria-labelledby="tour-title"
		tabindex="-1"
		bind:this={cardEl}
		transition:fly={{ y: 6, duration: transitionMs }}
	>
		<button type="button" class="tour-x" aria-label="Close tour" onclick={dismiss}>&times;</button>
		<h2 id="tour-title" class="tour-title">{title}</h2>
		<p class="tour-body">{body}</p>
		<div class="tour-footer">
			<span class="tour-count">{tour.step + 1} of {STEPS.length}</span>
			<div class="tour-actions">
				{#if tour.step > 0}
					<button type="button" class="secondary" onclick={back}>Back</button>
				{/if}
				<button type="button" class="tour-skip" onclick={dismiss}>Skip tour</button>
				{#if isLast}
					<button type="button" class="secondary" onclick={dismiss}>Finish</button>
					<button type="button" onclick={finishWithImport}>Import your contacts</button>
				{:else}
					<button type="button" onclick={next}>Next</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.tour-overlay {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: transparent;
	}
	.tour-overlay.dim {
		background: var(--backdrop);
	}
	.tour-spot {
		position: fixed;
		z-index: 71;
		pointer-events: none;
		border-radius: var(--radius-s);
		box-shadow: 0 0 0 9999px var(--backdrop);
		transition:
			top var(--motion-large-duration) var(--motion-large-easing),
			left var(--motion-large-duration) var(--motion-large-easing),
			width var(--motion-large-duration) var(--motion-large-easing),
			height var(--motion-large-duration) var(--motion-large-easing);
	}
	.tour-card {
		position: fixed;
		z-index: 72;
		width: min(360px, calc(100vw - 2rem));
		max-width: 360px;
		background: var(--surface);
		color: var(--neutral-10);
		border: 0;
		border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-l);
		padding: var(--space-l);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		transition:
			top var(--motion-large-duration) var(--motion-large-easing),
			left var(--motion-large-duration) var(--motion-large-easing);
	}
	.tour-card.centered {
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
	}
	.tour-card:focus {
		outline: none;
	}
	.tour-x {
		position: absolute;
		top: var(--space-xs);
		right: var(--space-xs);
		width: 26px;
		height: 26px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-s);
		background: var(--color-none);
		border: none;
		box-shadow: none;
		color: var(--neutral-7);
		font-size: var(--size-l);
		line-height: 1;
	}
	.tour-x:hover {
		background: var(--neutral-3-transparent);
		box-shadow: none;
		color: var(--neutral-10);
	}
	.tour-x:focus-visible {
		box-shadow: var(--focus-halo);
	}
	.tour-title {
		margin: 0 var(--space-l) var(--space-xs) 0;
		font-family: var(--font-ui);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--tracking-m);
		font-weight: var(--weight-ui-medium);
	}
	.tour-body {
		margin: 0;
		color: var(--neutral-7);
	}
	.tour-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s);
		margin-top: var(--space-m);
	}
	.tour-count {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		color: var(--muted);
		white-space: nowrap;
	}
	.tour-actions {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.tour-skip {
		background: var(--color-none);
		border: none;
		box-shadow: none;
		color: var(--neutral-7);
		padding: var(--space-xs);
		text-decoration: underline;
		text-underline-offset: var(--link-underline-offset);
	}
	.tour-skip:hover {
		background: var(--color-none);
		box-shadow: none;
		color: var(--neutral-10);
	}

	@media (prefers-reduced-motion: reduce) {
		.tour-spot,
		.tour-card {
			transition: none;
		}
	}
</style>

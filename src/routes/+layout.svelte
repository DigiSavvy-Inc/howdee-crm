<script lang="ts">
	// #558: the block editor's default tokens + base control styles, once for the app;
	// app.css comes after and its :root tokens win.
	import '@digisavvy/block-editor/styles.css';
	import '../app.css';
	import logomark from '$lib/assets/logomark.svg';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import HelpPanel from '$lib/components/HelpPanel.svelte';
	import AssistantPanel from '$lib/components/AssistantPanel.svelte';
	import AssistantFab from '$lib/components/AssistantFab.svelte';
	import SearchPalette from '$lib/components/SearchPalette.svelte';
	import AskAiPopover from '$lib/components/AskAiPopover.svelte';
	import { isSearchShortcut, isTypingTarget } from '$lib/site-search';
	import { detectMac } from '$lib/shortcuts';
	import { initPlatform, kbd } from '$lib/platform.svelte';
	import { assistant, toggleAssistant } from '$lib/assistant.svelte';
	import Tour from '$lib/components/Tour.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons/glyphs';
	import { onMount, tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate, afterNavigate, invalidate } from '$app/navigation';
	import { pwa, initPwa, promptInstall } from '$lib/pwa.svelte';
	import { DEFAULT_NAV_LAYOUT, NAV_STORAGE_KEY, type NavLayout } from '$lib/nav-layout';
	import { startTour } from '$lib/tour.svelte';
	import { nextMenuIndex } from '$lib/user-menu';
	import { BRAND_HREF, DEFAULT_BRANDING, brandLinkLabel } from '$lib/branding';

	let { children, data } = $props();

	// Nav icons (#209: the shared glyph set) — only shown in the left (sidebar) layout (#134)
	// and the phone drawer (#144).
	// `sub` (#166): a child of the item above it — indented in the sidebar/drawer.
	type NavItem = { href: string; label: string; icon: IconName; sub?: boolean };

	const nav: NavItem[] = [
		{ href: '/', label: 'Dashboard', icon: 'dashboard' },
		{ href: '/campaigns', label: 'Campaigns', icon: 'campaigns' },
		{ href: '/contacts', label: 'Contacts', icon: 'contacts' },
		{ href: '/companies', label: 'Companies', icon: 'companies', sub: true },
		{ href: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
		{ href: '/automations', label: 'Automations', icon: 'automations' },
		{ href: '/conversations', label: 'Conversations', icon: 'conversations' },
		{ href: '/deliverability', label: 'Deliverability', icon: 'deliverability' },
		{ href: '/reports', label: 'Reports', icon: 'reports' }
	];
	// Creative groups the content-building surfaces (#nav cleanup).
	const creative: NavItem[] = [
		{ href: '/templates', label: 'Email templates', icon: 'templates' },
		{ href: '/templates/global', label: 'Global header & footer', icon: 'header-footer' },
		{ href: '/pages', label: 'Pages', icon: 'pages' },
		{ href: '/forms', label: 'Forms', icon: 'forms' }
	];
	let creativeOpen = $state(false);
	// #270: the sticky top bar's height, so sticky page UI (the editor's Design panel) can
	// sit just under it. The left-nav layout zeroes it in CSS (its header is a side column).
	let headerH = $state(0);
	const creativeActive = $derived(
		page.url.pathname.startsWith('/templates') ||
			page.url.pathname.startsWith('/pages') ||
			page.url.pathname.startsWith('/forms')
	);

	function active(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		// Campaigns (#132) also covers the composer (New campaign) and per-campaign pages.
		if (href === '/campaigns') return /^\/(campaigns|compose|campaign\/)/.test(page.url.pathname);
		return page.url.pathname.startsWith(href);
	}

	// Theme (#573): one light / dark switch. With no stored choice the app follows the device
	// (the CSS media query) and the switch shows whichever theme is in effect; flipping it
	// stores 'light' / 'dark' in localStorage. "Match device theme" in the account menu clears it.
	// An inline script in app.html applies the saved choice before paint (no flash).
	type StoredTheme = 'light' | 'dark' | null;
	let storedTheme = $state<StoredTheme>(null);
	if (browser) {
		const saved = localStorage.getItem('theme');
		storedTheme = saved === 'light' || saved === 'dark' ? saved : null;
	}
	const deviceDark = new MediaQuery('prefers-color-scheme: dark');
	const isDark = $derived(storedTheme ? storedTheme === 'dark' : deviceDark.current);
	function onWindowClick() {
		creativeOpen = false;
		if (userMenuOpen) {
			// Back to the chip — unless the outside click focused something else.
			const a = document.activeElement;
			userMenuOpen = false;
			if (!a || a === document.body || userMenuEl?.contains(a)) userChipEl?.focus();
		}
	}
	// #477: site-wide search. Cmd+K on a Mac, Ctrl+K elsewhere, or `/` outside a text field.
	let searchOpen = $state(false);
	// #572: the handler reads the platform now; hints follow `platform.mac` (set on mount).
	const isMac = detectMac();
	const searchHint = $derived(kbd('Mod+K'));
	function onWindowKey(e: KeyboardEvent) {
		if (data.authed && !bare) {
			if (isSearchShortcut(e, isMac)) {
				// Never let the browser's own Ctrl+K (address-bar search) fire.
				e.preventDefault();
				searchOpen = !searchOpen;
				return;
			}
			// A page that claims `/` itself (Conversations) handles it first and prevents default.
			if (e.key === '/' && !e.defaultPrevented && !searchOpen && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
				e.preventDefault();
				searchOpen = true;
				return;
			}
		}
		// #287: Cmd+J (Mac) / Ctrl+J opens / closes the assistant from anywhere. Either modifier
		// works everywhere; preventDefault keeps Windows browsers' Ctrl+J (downloads) from firing.
		// #292: does nothing for someone without access (the server decides showAssistant).
		if (data.authed && data.showAssistant && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
			e.preventDefault();
			toggleAssistant();
			return;
		}
		if (userMenuOpen && e.key === 'Escape') {
			e.preventDefault();
			closeUserMenu();
			return;
		}
		if (drawerOpen && isDrawerViewport()) {
			if (e.key === 'Escape') {
				e.preventDefault();
				closeDrawer();
				return;
			}
			if (e.key === 'Tab') trapFocus(e);
		}
		if (e.key === 'Escape') creativeOpen = false;
	}

	function setTheme(t: StoredTheme) {
		storedTheme = t;
		if (!browser) return;
		try {
			if (t) localStorage.setItem('theme', t);
			else localStorage.removeItem('theme');
		} catch {
			// storage unavailable: the choice still applies for this page
		}
		if (t) document.documentElement.setAttribute('data-theme', t);
		else document.documentElement.removeAttribute('data-theme');
	}
	function flipTheme() {
		setTheme(isDark ? 'light' : 'dark');
	}

	// Nav layout (#134): 'top' (header + tab bar) or 'left' (sidebar), per user. One <nav>
	// markup, two CSS layouts keyed on <html data-nav> — stamped server-side for signed-in
	// pages (hooks.server.ts) and mirrored to localStorage for app.html's pre-paint script.
	// Writable derived: follows the saved preference, but the toggle can set it optimistically.
	let navLayout = $derived<NavLayout>(data.user?.navLayout ?? DEFAULT_NAV_LAYOUT);
	function applyNav(l: NavLayout) {
		navLayout = l;
		if (!browser) return;
		document.documentElement.setAttribute('data-nav', l);
		try {
			localStorage.setItem(NAV_STORAGE_KEY, l);
		} catch {
			// best-effort mirror only
		}
	}
	// The saved preference is the source of truth (also picks up a Settings-page save).
	$effect(() => {
		if (data.user) applyNav(data.user.navLayout);
	});
	async function toggleNav() {
		const next: NavLayout = navLayout === 'left' ? 'top' : 'left';
		applyNav(next);
		drawerOpen = false;
		const body = new FormData();
		body.set('nav_layout', next);
		try {
			await fetch('/settings?/setNavLayout', {
				method: 'POST',
				body,
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
			});
		} catch {
			// offline etc. — the reload below restores whatever is actually saved
		}
		await invalidate('app:user');
	}

	// ≤ 768px, either layout (#144): the nav becomes an off-canvas drawer behind a hamburger.
	let drawerOpen = $state(false);
	let drawerEl = $state<HTMLElement | null>(null);
	let hamburgerEl = $state<HTMLButtonElement | null>(null);
	const narrow = new MediaQuery('max-width: 768px');
	// The drawer renders the sidebar's nav (Creative as an expanded group).
	const sidebarNav = $derived(navLayout === 'left' || narrow.current);
	const isDrawerViewport = () => browser && window.matchMedia('(max-width: 768px)').matches;
	function focusables(): HTMLElement[] {
		if (!drawerEl) return [];
		return [...drawerEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter(
			(el) => el.offsetParent !== null
		);
	}
	async function openDrawer() {
		drawerOpen = true;
		await tick();
		focusables()[0]?.focus();
	}
	function closeDrawer() {
		drawerOpen = false;
		hamburgerEl?.focus();
	}
	// Keep Tab / Shift+Tab cycling inside the open drawer.
	function trapFocus(e: KeyboardEvent) {
		const els = focusables();
		if (!els.length) return;
		const first = els[0];
		const last = els[els.length - 1];
		const inside = !!drawerEl?.contains(document.activeElement);
		if (e.shiftKey && (!inside || document.activeElement === first)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (!inside || document.activeElement === last)) {
			e.preventDefault();
			first.focus();
		}
	}
	afterNavigate(() => {
		drawerOpen = false;
	});

	onMount(initPwa);
	onMount(initPlatform);
	// Offline, a client-side navigation would fail fetching its data and show an error page;
	// make it a full page load instead so the service worker serves the offline page (#135).
	beforeNavigate(({ to, type, cancel }) => {
		if (navigator.onLine || !to?.url || type === 'leave' || type === 'form') return;
		cancel();
		location.href = to.url.href;
	});

	// User menu (#141): Settings · Take the tour · Install app · Sign out, under the user chip.
	// At ≤ 768px the chip stays in the top bar and the menu also carries the theme/nav toggles.
	let userMenuOpen = $state(false);
	let userChipEl = $state<HTMLButtonElement | null>(null);
	let userMenuEl = $state<HTMLElement | null>(null);
	const menuItems = () => [...(userMenuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
	async function openUserMenu(focus: 'first' | 'last' = 'first') {
		userMenuOpen = true;
		await tick();
		const items = menuItems();
		(focus === 'first' ? items[0] : items[items.length - 1])?.focus();
	}
	function closeUserMenu() {
		userMenuOpen = false;
		userChipEl?.focus();
	}
	function onChipKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			openUserMenu(e.key === 'ArrowDown' ? 'first' : 'last');
		}
	}
	function onMenuKey(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			userMenuOpen = false;
			return;
		}
		const items = menuItems();
		const next = nextMenuIndex(items.indexOf(document.activeElement as HTMLElement), e.key, items.length);
		if (next === null) return;
		e.preventDefault();
		items[next].focus();
	}

	// Branding (#188): Settings → General → Branding; defaults = the bundled look.
	const branding = $derived(data.branding ?? DEFAULT_BRANDING);
	const logoSrc = $derived(branding.logoUrl ?? logomark);
	// #374: the public unsubscribe page (and its admin preview) renders bare, even signed in.
	// #509: so does a public form (/f/<slug>, its thanks page).
	// #510: the double opt-in /confirm page (and its preview) too.
	const bare = $derived(
		page.url.pathname === '/unsubscribe' ||
			page.url.pathname.startsWith('/unsubscribe/') ||
			page.url.pathname.startsWith('/f/') ||
			page.url.pathname.startsWith('/confirm/')
	);

	const userInitial = $derived((data.user?.name || data.user?.github_login || '?').trim().charAt(0).toUpperCase());
</script>

{#snippet icon(name: IconName, size: 16 | 20 = 16)}
	<span class="nav-icon"><Icon {name} {size} /></span>
{/snippet}

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<svelte:head>
	<link rel="icon" href={logoSrc} />
	<meta name="apple-mobile-web-app-title" content={branding.shortName} />
</svelte:head>

{#if data.authed && !bare}
	<div class="shell" class:drawer-open={drawerOpen} style:--header-bar-h="{headerH}px">
		{#snippet toggles()}
			<!-- #573: one switch; a native button, so Space and Enter flip it. -->
			<button
				type="button"
				class="theme-switch"
				role="switch"
				aria-checked={isDark}
				aria-label="Dark theme"
				title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
				onclick={flipTheme}
			>
				<span class="theme-switch-icon sun"><Icon name="theme-light" size={16} /></span>
				<span class="theme-switch-icon moon"><Icon name="theme-dark" size={16} /></span>
				<span class="theme-switch-knob" aria-hidden="true"></span>
			</button>
			<button
				type="button"
				class="theme-btn nav-toggle"
				aria-pressed={navLayout === 'left'}
				title="Nav: top / left (now {navLayout})"
				onclick={toggleNav}
			>
				<Icon name={navLayout === 'left' ? 'nav-left' : 'nav-top'} size={16} />
				<span class="sr-only">Nav: top / left — sidebar navigation</span>
			</button>
		{/snippet}
		<header id="app-nav" bind:clientHeight={headerH}>
			<div class="topbar">
				<div class="topbar-inner">
					<button
						type="button"
						class="hamburger"
						data-tour="menu"
						bind:this={hamburgerEl}
						aria-label="Open navigation"
						aria-controls="app-drawer"
						aria-expanded={drawerOpen}
						onclick={openDrawer}
					>{@render icon('menu', 20)}</button>
					<a class="brand" href={BRAND_HREF} aria-label={brandLinkLabel(branding.appName)}>
						<img class="brand-logo" src={logoSrc} alt="" width="24" height="24" />
						<span class="brand-name">{branding.appName}</span>
						<span class="brand-short" aria-hidden="true">{branding.shortName}</span>
					</a>
					<div class="actions">
						<button
							type="button"
							class="assistant-btn search-btn"
							title="Search ({searchHint}, or /)"
							aria-haspopup="dialog"
							aria-expanded={searchOpen}
							onclick={(e) => {
								e.stopPropagation();
								searchOpen = true;
							}}
						><Icon name="search" size={20} label="Search" /></button>
						{#if data.showAssistant}
							<button
								type="button"
								class="assistant-btn"
								title="Assistant ({kbd('Mod+J')})"
								aria-pressed={assistant.open}
								onclick={toggleAssistant}
							><Icon name="sparkle" size={20} label="Assistant" /></button>
						{/if}
						<div class="toggles">{@render toggles()}</div>
						{#if data.user}
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div class="usermenu" onclick={(e) => e.stopPropagation()}>
								<button
									type="button"
									class="whoami"
									data-tour="user"
									bind:this={userChipEl}
									title="Account, settings & sign out"
									aria-haspopup="menu"
									aria-expanded={userMenuOpen}
									aria-controls="user-menu"
									onclick={() => (userMenuOpen ? (userMenuOpen = false) : openUserMenu())}
									onkeydown={onChipKey}
								>
									{#if data.user.avatar_url}
										<img class="whoami-avatar" src={data.user.avatar_url} alt="" width="24" height="24" />
									{:else}
										<span class="whoami-avatar whoami-fallback">{userInitial}</span>
									{/if}
									<span class="whoami-login">@{data.user.github_login}</span>
								</button>
								{#if userMenuOpen}
									<div class="usermenu-pop">
										<div class="usermenu-head">
											<strong>@{data.user.github_login}</strong>
											<span class="usermenu-role">{data.user.role}</span>
										</div>
										<!-- Phones (#144): the top-bar toggles live here. -->
										<div class="usermenu-toggles">{@render toggles()}</div>
										<!-- svelte-ignore a11y_interactive_supports_focus -->
										<div
											id="user-menu"
											role="menu"
											aria-label="Account"
											bind:this={userMenuEl}
											onkeydown={onMenuKey}
										>
											<a role="menuitem" href="/account" onclick={() => (userMenuOpen = false)}>Account</a>
											<a role="menuitem" href="/settings" onclick={() => (userMenuOpen = false)}>Settings</a>
											<button
												type="button"
												role="menuitem"
												onclick={() => {
													userMenuOpen = false;
													drawerOpen = false;
													startTour();
												}}
											>Take the tour</button>
											<button
												type="button"
												role="menuitem"
												title={storedTheme ? 'Follow the light / dark setting of this device' : 'Already following this device'}
												onclick={() => {
													setTheme(null);
													closeUserMenu();
												}}
											>Match device theme</button>
											{#if pwa.canInstall}
												<button
													type="button"
													role="menuitem"
													onclick={() => {
														userMenuOpen = false;
														promptInstall();
													}}
												>Install app</button>
											{/if}
											<div class="usermenu-sep" role="separator"></div>
											<form method="POST" action="/logout" class="logout" role="none">
												<button type="submit" role="menuitem">Sign out</button>
											</form>
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
			{#if drawerOpen}
				<!-- Esc closes the drawer from the keyboard; the backdrop is a pointer convenience. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="backdrop" aria-hidden="true" onclick={closeDrawer}></div>
			{/if}
			<div class="subnav" id="app-drawer" bind:this={drawerEl}>
				<div class="subnav-inner">
					<!-- Phone drawer (#188): the same logo → dashboard link heads the drawer. -->
					<a
						class="brand drawer-brand"
						href={BRAND_HREF}
						aria-label={brandLinkLabel(branding.appName)}
						onclick={() => (drawerOpen = false)}
					>
						<img class="brand-logo" src={logoSrc} alt="" width="24" height="24" />
						<span>{branding.appName}</span>
					</a>
					<nav aria-label="Primary">
						{#each nav as item (item.href)}
							<a href={item.href} data-tour={'nav-' + item.href} class:active={active(item.href)} class:sub={item.sub} title={item.label}>{@render icon(item.icon)}<span class="label">{item.label}</span></a>
						{/each}
						<span class="navdrop" role="presentation">
							{#if sidebarNav}
								<!-- Sidebar: Creative is an always-expanded group heading, not a dropdown. -->
								<span class="navdrop-btn navgroup" data-tour="creative" class:active={creativeActive}>{@render icon('creative')}<span class="label">Creative</span></span>
							{:else}
								<button
									type="button"
									class="navdrop-btn"
									data-tour="creative"
									class:active={creativeActive}
									aria-haspopup="true"
									aria-expanded={creativeOpen}
									title="Creative"
									onclick={(e) => {
										e.stopPropagation();
										creativeOpen = !creativeOpen;
									}}
								>{@render icon('creative')}<span class="label">Creative</span> <Icon name="chevron-down" size={16} /></button>
							{/if}
							{#if creativeOpen || sidebarNav}
								<span class="navdrop-menu">
									{#each creative as item (item.href)}
										<a
											href={item.href}
											title={item.label}
											class:active={page.url.pathname === item.href || (item.href !== '/templates/global' && page.url.pathname.startsWith(item.href) && !page.url.pathname.startsWith('/templates/global'))}
											onclick={() => (creativeOpen = false)}
										>{@render icon(item.icon)}<span class="label">{item.label}</span></a>
									{/each}
								</span>
							{/if}
						</span>
						<a href="/settings" class="drawer-only" class:active={page.url.pathname.startsWith('/settings')} title="Settings">{@render icon('settings')}<span class="label">Settings</span></a>
					</nav>
				</div>
			</div>
		</header>
		<main class:wide={page.data.wideLayout === true}>
			{@render children()}
		</main>
	</div>
	<HelpPanel />
	<SearchPalette bind:open={searchOpen} isAdmin={data.user?.role === 'admin'} />
	{#if data.showAssistant}<AssistantPanel /><AssistantFab />{/if}
	<!-- #679: Ask AI in the editors' selection bubble (setting on + assistant access). -->
	{#if data.editorAsk}<AskAiPopover />{/if}
	<Tour tourSeen={data.user?.tourSeen ?? true} isAdmin={data.user?.role === 'admin'} appName={branding.appName} />
{:else}
	{@render children()}
{/if}

{#if pwa.updateReady}
	<div class="update-toast" role="status">
		Update available
		<button type="button" class="secondary" onclick={() => location.reload()}>Reload</button>
	</div>
{/if}

<style>
	/* App shell in the Untitled theme: header bar + navigation-menu links, the account menu as
	   the theme's menu, theme buttons as a toggle group, the phone drawer as the theme's drawer
	   and the update notice as its toast. Edges are shadows over zero-width borders. */
	header {
		position: sticky;
		top: 0;
		z-index: 10;
	}
	.topbar {
		background: var(--header-bg);
		color: var(--header-fg);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	.topbar-inner,
	.subnav-inner {
		width: 100%;
		max-width: 1000px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		padding: var(--space-xs) var(--space-l);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: var(--font-brand);
		font-weight: var(--weight-brand-heavy);
		font-size: var(--size-m);
		line-height: var(--line-m);
		letter-spacing: var(--letter-spacing-m);
		color: var(--header-fg);
		text-decoration: none;
	}
	.brand:hover {
		text-decoration: none;
		color: var(--header-fg-muted);
	}
	.brand-logo {
		display: block;
		border-radius: var(--radius-full);
		object-fit: contain;
	}
	.actions {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: var(--space-s);
	}
	.toggles {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	/* #573: the light / dark switch — a track with a sun and a moon; the knob slides under the
	   icon of the theme in effect, which is drawn in the stronger colour. */
	.theme-switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		flex: none;
		width: 52px;
		height: 28px;
		padding: 0 6px;
		background: var(--neutral-3);
		color: var(--header-fg);
		border: 0;
		border-radius: 999px;
		box-shadow: inset 0 0 0 var(--border-s) var(--neutral-4);
		cursor: pointer;
	}
	.theme-switch:hover {
		background: var(--neutral-4);
	}
	.theme-switch:focus-visible {
		box-shadow: var(--focus-halo);
	}
	.theme-switch-icon {
		position: relative;
		z-index: 1;
		display: inline-flex;
		color: var(--header-fg-muted);
	}
	.theme-switch-icon :global(svg) {
		display: block;
	}
	.theme-switch[aria-checked='false'] .sun,
	.theme-switch[aria-checked='true'] .moon {
		color: var(--header-fg);
	}
	.theme-switch-knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--surface);
		box-shadow: var(--border-shadow-s);
		transition: transform 150ms ease;
	}
	/* Light: the knob sits on the left under the sun; dark: it slides right under the moon. */
	.theme-switch[aria-checked='true'] .theme-switch-knob {
		transform: translateX(24px);
	}
	@media (prefers-reduced-motion: reduce) {
		.theme-switch-knob {
			transition: none;
		}
	}
	/* #287: the assistant's sparkle button, styled like the header toggles. */
	.assistant-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		min-height: 32px;
		padding: var(--space-xxs);
		background: var(--color-none);
		color: var(--header-fg-muted);
		border: 0;
		border-radius: var(--radius-s);
		box-shadow: none;
	}
	:global(html[data-nav='left']) .assistant-btn {
		align-self: flex-start;
	}
	.assistant-btn:hover,
	.assistant-btn[aria-pressed='true'] {
		background: var(--neutral-3);
		color: var(--header-fg);
		box-shadow: none;
	}
	.theme-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-xxs) var(--space-xs);
		background: var(--color-none);
		color: var(--header-fg-muted);
		border: 0;
		border-radius: var(--radius-s);
		box-shadow: none;
	}
	.theme-btn:hover {
		background: var(--neutral-3);
		color: var(--header-fg);
		box-shadow: none;
	}
	.theme-btn:focus-visible {
		box-shadow: var(--focus-halo);
	}
	.theme-btn :global(svg) {
		display: block;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.whoami {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		color: var(--header-fg);
	}
	/* Account chip: a ghost control. */
	button.whoami {
		padding: var(--space-xxs) var(--space-xs) var(--space-xxs) var(--space-xxs);
		background: var(--color-none);
		border: 0;
		border-radius: var(--radius-full);
		box-shadow: none;
		font-weight: var(--weight-ui-regular);
	}
	button.whoami:hover,
	button.whoami[aria-expanded='true'] {
		background: var(--neutral-3);
		box-shadow: none;
	}
	button.whoami:focus-visible {
		box-shadow: var(--focus-halo);
	}
	/* User menu (#141): anchored under the chip (top layout), above it (sidebar). */
	.usermenu {
		position: relative;
		display: inline-flex;
	}
	.usermenu-pop {
		position: absolute;
		top: calc(100% + var(--space-xs));
		right: 0;
		z-index: 30;
		min-width: 13rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		background: var(--surface);
		color: var(--neutral-10);
		border: 0;
		border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
		padding: var(--space-xxs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		animation: pop-in var(--motion-duration) var(--motion-easing);
	}
	@keyframes pop-in {
		from {
			opacity: 0;
			transform: scale(var(--motion-popup-scale));
		}
	}
	.usermenu-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-xs) var(--space-s);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
	}
	.usermenu-head strong {
		font-weight: var(--weight-ui-medium);
	}
	.usermenu-role {
		color: var(--muted);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
	}
	[role='menu'] {
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
	}
	.logout {
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	/* Menu options: highlighted = neutral-3. */
	[role='menuitem'] {
		display: block;
		width: 100%;
		text-align: left;
		padding: var(--space-xs);
		background: var(--color-none);
		color: var(--neutral-10);
		border: 0;
		border-radius: var(--radius-xs);
		box-shadow: none;
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-regular);
	}
	[role='menuitem']:hover,
	[role='menuitem']:focus-visible {
		text-decoration: none;
		color: var(--neutral-10);
		background: var(--neutral-3);
		box-shadow: none;
	}
	[role='menuitem']:focus-visible {
		outline-offset: 0;
	}
	.usermenu-sep {
		height: var(--border-s);
		margin: 0;
		background: var(--neutral-4);
	}
	.whoami-avatar {
		display: block;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-full);
		object-fit: cover;
	}
	/* Avatar fallback: neutral-3 disc, neutral-8 medium initial. */
	.whoami-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--neutral-3);
		color: var(--neutral-8);
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		font-weight: var(--weight-ui-medium);
	}
	/* Top layout: the nav row under the bar. */
	.subnav {
		background: var(--header-bg);
		box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--border);
	}
	nav {
		display: flex;
		gap: var(--space-xxs);
	}
	/* Navigation-menu links: hover neutral-3, current = the active navigation fill. */
	nav a,
	.navdrop-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		color: var(--header-fg);
		font-family: var(--font-ui);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-regular);
		padding: var(--space-xs) var(--space-s);
		border-radius: var(--radius-s);
		transition: background-color var(--motion-duration) var(--motion-easing);
	}
	nav a:hover {
		text-decoration: none;
		color: var(--header-fg);
		background: var(--neutral-3);
	}
	nav a.active {
		font-weight: var(--weight-ui-medium);
		color: var(--navigation-active-foreground);
		background: var(--navigation-active-background);
	}
	.navdrop {
		position: relative;
		display: inline-flex;
	}
	.navdrop-btn {
		background: var(--color-none);
		border: 0;
		box-shadow: none;
		cursor: pointer;
	}
	.navdrop-btn:hover {
		background: var(--neutral-3);
		box-shadow: none;
	}
	.navdrop-btn:focus-visible {
		box-shadow: var(--focus-halo);
	}
	.navdrop-btn.active {
		font-weight: var(--weight-ui-medium);
		color: var(--navigation-active-foreground);
		background: var(--navigation-active-background);
	}
	/* Navigation-menu popover. */
	.navdrop-menu {
		position: absolute;
		top: calc(100% + var(--space-xxs));
		left: 0;
		z-index: 30;
		min-width: 13rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-xxs);
		background: var(--surface);
		border: 0;
		border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
		padding: var(--space-xs);
		animation: pop-in var(--motion-duration) var(--motion-easing);
	}
	.navdrop-menu a {
		display: flex;
	}
	/* Update notice: the theme's toast (large motion), action = secondary button. */
	.update-toast {
		position: fixed;
		right: var(--space-m);
		bottom: var(--space-m);
		z-index: 70;
		display: flex;
		align-items: center;
		gap: var(--space-s);
		padding: var(--space-s) var(--space-s) var(--space-s) var(--space-m);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-medium);
		background: var(--surface);
		color: var(--neutral-10);
		border: 0;
		border-radius: var(--radius-m);
		box-shadow: var(--border-shadow-s), var(--shadow-m);
		animation: toast-in var(--motion-large-duration) var(--motion-large-easing);
	}
	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(var(--space-s));
		}
	}
	main {
		max-width: 1000px;
		margin: 0 auto;
		padding: var(--space-xl) var(--space-l) var(--space-xxl);
	}
	/* #270: pages that host the visual editor opt in (load returns wideLayout: true) so the
	   email canvas and the Design panel fit side by side. Other pages keep 1000px. */
	main.wide {
		max-width: 1320px;
	}
	.shell {
		--header-h: var(--header-bar-h, 64px);
	}
	/* Icons only show in the sidebar; the rest only in the phone layout (≤ 768px). */
	.nav-icon,
	.hamburger,
	.brand-short,
	.drawer-brand,
	.usermenu-toggles,
	.drawer-only,
	.backdrop {
		display: none;
	}
	.nav-icon {
		flex: 0 0 auto;
	}
	.nav-icon :global(svg) {
		display: block;
	}

	/* ── Left (sidebar) layout, #134 ──────────────────────────────────────────────
	   Same markup as the top layout: the topbar/subnav wrappers dissolve
	   (display: contents) so brand · nav · actions stack as one fixed column. */
	@media (min-width: 769px) {
		:global(html[data-nav='left']) .shell {
			padding-left: 220px;
			--header-h: 0px;
		}
		:global(html[data-nav='left']) header {
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			width: 220px;
			display: flex;
			flex-direction: column;
			background: var(--header-bg);
			color: var(--header-fg);
			box-shadow: inset calc(-1 * var(--border-s)) 0 0 var(--border);
			z-index: 40;
		}
		:global(html[data-nav='left']) .topbar,
		:global(html[data-nav='left']) .topbar-inner,
		:global(html[data-nav='left']) .subnav,
		:global(html[data-nav='left']) .subnav-inner {
			display: contents;
		}
		:global(html[data-nav='left']) header .brand {
			order: 0;
			padding: var(--space-m) var(--space-m) var(--space-xs);
		}
		:global(html[data-nav='left']) nav {
			order: 1;
			flex: 1 1 auto;
			min-height: 0;
			overflow-y: auto;
			flex-direction: column;
			gap: var(--space-xxs);
			padding: var(--space-xs);
		}
		:global(html[data-nav='left']) .nav-icon {
			display: block;
		}
		:global(html[data-nav='left']) nav a,
		:global(html[data-nav='left']) .navdrop-btn {
			display: flex;
		}
		:global(html[data-nav='left']) nav a.sub {
			margin-left: var(--space-s);
		}
		:global(html[data-nav='left']) .navdrop {
			display: flex;
			flex-direction: column;
			gap: var(--space-xxs);
		}
		/* Creative: a group label, not a control. */
		:global(html[data-nav='left']) .navgroup {
			margin-top: var(--space-xs);
			color: var(--header-fg-muted);
			font-size: var(--size-xs);
			line-height: var(--line-xs);
			letter-spacing: var(--letter-spacing-xs);
			font-weight: var(--weight-ui-medium);
			background: var(--color-none);
			cursor: default;
		}
		:global(html[data-nav='left']) .navgroup.active {
			color: var(--header-fg);
			background: var(--color-none);
		}
		:global(html[data-nav='left']) .navdrop-menu {
			position: static;
			min-width: 0;
			gap: var(--space-xxs);
			padding: 0 0 var(--space-xs) var(--space-s);
			background: none;
			border: none;
			box-shadow: none;
			animation: none;
		}
		:global(html[data-nav='left']) .actions {
			order: 2;
			margin: 0;
			flex-direction: column;
			align-items: stretch;
			gap: var(--space-s);
			padding: var(--space-s) var(--space-m) var(--space-m);
			box-shadow: inset 0 var(--border-s) 0 var(--border);
		}
		:global(html[data-nav='left']) .usermenu-pop {
			top: auto;
			bottom: calc(100% + var(--space-xs));
			left: 0;
			right: auto;
		}
	}
	/* ≤ 1024px: collapse the sidebar to icons (labels stay for screen readers). */
	@media (max-width: 1024px) and (min-width: 769px) {
		:global(html[data-nav='left']) .shell {
			padding-left: 64px;
		}
		:global(html[data-nav='left']) header {
			width: 64px;
		}
		:global(html[data-nav='left']) header .brand {
			justify-content: center;
			padding: var(--space-m) 0 var(--space-xs);
		}
		:global(html[data-nav='left']) .brand-name,
		:global(html[data-nav='left']) nav .label,
		:global(html[data-nav='left']) .whoami-login {
			position: absolute;
			width: 1px;
			height: 1px;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
		}
		:global(html[data-nav='left']) nav {
			padding: var(--space-xs);
		}
		:global(html[data-nav='left']) nav a,
		:global(html[data-nav='left']) .navdrop-btn {
			justify-content: center;
			padding: var(--space-xs) 0;
		}
		:global(html[data-nav='left']) nav a.sub {
			margin-left: 0;
		}
		:global(html[data-nav='left']) .navdrop-menu {
			padding: 0;
		}
		:global(html[data-nav='left']) .actions {
			align-items: center;
			padding: var(--space-xs) var(--space-xxs) var(--space-s);
		}
		:global(html[data-nav='left']) .toggles {
			flex-direction: column;
		}
		:global(html[data-nav='left']) button.whoami {
			padding: var(--space-xxs);
		}
	}

	/* Top layout, 769–1024px (#272): the full tab row needs ~950px, so tighten the items, and
	   at ≤ 960px collapse the top-level tabs to icons (like the sidebar above; labels stay for
	   screen readers, `title` gives the tooltip). The Creative menu keeps its labels. */
	@media (max-width: 1024px) and (min-width: 769px) {
		:global(html:not([data-nav='left'])) nav {
			gap: 0;
		}
		:global(html:not([data-nav='left'])) nav > a,
		:global(html:not([data-nav='left'])) .navdrop-btn {
			padding: var(--space-xs);
		}
	}
	@media (max-width: 960px) and (min-width: 769px) {
		:global(html:not([data-nav='left'])) nav {
			gap: var(--space-xxs);
		}
		:global(html:not([data-nav='left'])) nav > a .nav-icon,
		:global(html:not([data-nav='left'])) .navdrop-btn .nav-icon {
			display: block;
		}
		:global(html:not([data-nav='left'])) nav > a .label,
		:global(html:not([data-nav='left'])) .navdrop-btn .label {
			position: absolute;
			width: 1px;
			height: 1px;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
		}
		:global(html:not([data-nav='left'])) nav > a,
		:global(html:not([data-nav='left'])) .navdrop-btn {
			padding: var(--space-xs) var(--space-s);
		}
	}

	/* ≤ 768px, either layout (#144): one-line top bar (hamburger · brand · avatar chip), the
	   theme/nav toggles move into the user menu, and the nav is an off-canvas drawer. */
	@media (max-width: 768px) {
		header {
			z-index: 30;
		}
		.drawer-open header {
			z-index: 45;
		}
		.topbar-inner {
			gap: var(--space-xs);
			padding: var(--space-xxs) var(--space-s);
		}
		/* Hamburger: the theme's outline control at a 40px touch target. */
		.hamburger {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex: 0 0 auto;
			width: 40px;
			height: 40px;
			padding: 0;
			background: var(--color-none);
			color: var(--header-fg);
			box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
		}
		.hamburger:hover {
			background: var(--neutral-3-transparent);
			box-shadow: 0 0 0 var(--border-s) var(--neutral-4);
		}
		.hamburger:focus-visible {
			box-shadow: 0 0 0 var(--border-s) var(--color-1-transparent), var(--focus-halo);
		}
		.hamburger .nav-icon {
			display: block;
		}
		.brand {
			min-width: 0;
			white-space: nowrap;
		}
		.brand-name,
		.actions > .toggles {
			display: none;
		}
		.brand-short {
			display: inline;
		}
		.actions {
			gap: var(--space-xs);
		}
		button.whoami {
			min-height: 40px;
			padding: var(--space-xxs) var(--space-xs) var(--space-xxs) var(--space-xs);
		}
		.usermenu-toggles {
			display: flex;
			align-items: center;
			gap: var(--space-xs);
			padding: var(--space-xxs) var(--space-xxs) var(--space-xs);
			box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
		}
		.usermenu-toggles .theme-btn {
			min-width: 40px;
			min-height: 40px;
			color: var(--muted);
		}
		.usermenu-toggles .theme-btn:hover {
			color: var(--text);
		}
		[role='menuitem'] {
			min-height: 40px;
		}
		/* The drawer: the sub-nav slides in from the left over a backdrop. */
		.subnav {
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			z-index: 2;
			width: min(260px, 85vw);
			overflow-y: auto;
			background: var(--surface);
			color: var(--header-fg);
			box-shadow: var(--border-shadow-s);
			transform: translateX(-100%);
			visibility: hidden;
			transition:
				transform var(--motion-large-duration) var(--motion-large-easing),
				visibility var(--motion-large-duration);
		}
		.drawer-open .subnav {
			transform: none;
			visibility: visible;
			box-shadow: var(--border-shadow-s), var(--shadow-l);
		}
		.subnav-inner {
			display: block;
			padding: var(--space-s) var(--space-xs);
		}
		.backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 1;
			background: var(--backdrop);
		}
		nav {
			flex-direction: column;
			gap: var(--space-xxs);
		}
		.nav-icon {
			display: block;
		}
		nav a,
		.navdrop-btn {
			display: flex;
			min-height: 40px;
		}
		nav a.sub {
			margin-left: var(--space-s);
		}
		.navdrop {
			display: flex;
			flex-direction: column;
			gap: var(--space-xxs);
		}
		.navgroup {
			margin-top: var(--space-xs);
			color: var(--header-fg-muted);
			font-size: var(--size-xs);
			line-height: var(--line-xs);
			letter-spacing: var(--letter-spacing-xs);
			font-weight: var(--weight-ui-medium);
			background: var(--color-none);
			cursor: default;
		}
		.navgroup.active {
			color: var(--header-fg);
			background: var(--color-none);
		}
		.navdrop-menu {
			position: static;
			min-width: 0;
			gap: var(--space-xxs);
			padding: 0 0 var(--space-xs) var(--space-s);
			background: none;
			border: none;
			box-shadow: none;
			animation: none;
		}
		.drawer-brand {
			display: flex;
			padding: var(--space-xxs) var(--space-s) var(--space-s);
			margin-bottom: var(--space-xs);
			box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
		}
		.drawer-only {
			display: flex;
			margin-top: var(--space-xs);
			box-shadow: inset 0 var(--border-s) 0 var(--neutral-4);
			border-radius: 0;
			padding-top: var(--space-s);
		}
	}
	@media (max-width: 480px) {
		.whoami-login {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		header,
		.subnav {
			transition: none !important;
		}
	}

	/* #523: the block editor's Write mode stamps <html data-write-mode> (and clears it on
	   exit / unmount). The header + nav go (top bar and sidebar alike), sticky bars stick to
	   the top edge (--header-h: 0), and an editor page may grow wider. Kept last so it wins
	   over the #134 sidebar rules of the same specificity. */
	:global(html[data-write-mode]) #app-nav {
		display: none;
	}
	:global(html[data-write-mode]) .shell {
		--header-h: 0px;
		padding-left: 0;
	}
	:global(html[data-write-mode]) main.wide {
		max-width: 1600px;
	}
	:global(html[data-write-mode]) main,
	:global(html[data-write-mode-exit]) .shell {
		animation: write-mode-fade 150ms var(--motion-easing, ease-out);
	}
	@keyframes write-mode-fade {
		from {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(html[data-write-mode]) main,
		:global(html[data-write-mode-exit]) .shell {
			animation: none;
		}
	}
</style>

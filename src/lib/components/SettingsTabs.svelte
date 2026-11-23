<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons/glyphs';

	// Settings shell (#136): a ~200px left section list on ≥900px (current item as a soft
	// filled pill) beside the page content; below 900px the list becomes a horizontal
	// scrollable row above it. Rendered by src/routes/settings/+layout.svelte.
	let {
		current,
		isAdmin,
		snapshots = false,
		children
	}: {
		current: 'general' | 'setup' | 'users' | 'api' | 'webhooks' | 'integrations' | 'mail' | 'tracking' | 'snapshots' | 'assistant' | 'domain' | 'deliverability' | 'unsubscribe' | 'double-optin' | 'signature' | 'backups' | 'automations' | 'scoring' | 'newsletter' | 'brand-kit' | 'custom-fields';
		isAdmin: boolean;
		/** #604: the Snapshots tab shows only while SNAPSHOT_MODE is qa / live. */
		snapshots?: boolean;
		children: Snippet;
	} = $props();

	const all: { id: string; label: string; href: string; icon: IconName; admin?: boolean }[] = [
		{ id: 'general', label: 'General', href: '/settings', icon: 'general' },
		{ id: 'setup', label: 'Setup', href: '/settings/setup', icon: 'activate', admin: true }, // #609
		{ id: 'users', label: 'Users', href: '/settings/users', icon: 'users', admin: true },
		{ id: 'api', label: 'API', href: '/settings/api', icon: 'api-key', admin: true },
		{ id: 'webhooks', label: 'Webhooks', href: '/settings/webhooks', icon: 'webhooks', admin: true },
		{ id: 'integrations', label: 'Integrations', href: '/settings/integrations', icon: 'integrations', admin: true },
		{ id: 'mail', label: 'Mail', href: '/settings/mail', icon: 'mail' }, // #585: each teammate connects their own mailbox
		{ id: 'tracking', label: 'Tracking', href: '/settings/tracking', icon: 'tracking', admin: true },
		{ id: 'snapshots', label: 'Snapshots', href: '/settings/snapshots', icon: 'schedule', admin: true },
		{ id: 'assistant', label: 'Assistant', href: '/settings/assistant', icon: 'sparkle', admin: true },
		{ id: 'brand-kit', label: 'Brand kit', href: '/settings/brand-kit', icon: 'palette', admin: true }, // #595
		{ id: 'domain', label: 'Domain', href: '/settings/domain', icon: 'link', admin: true },
		{ id: 'deliverability', label: 'Deliverability', href: '/settings/deliverability', icon: 'deliverability', admin: true },
		{ id: 'unsubscribe', label: 'Unsubscribe page', href: '/settings/unsubscribe', icon: 'pages', admin: true },
		{ id: 'double-optin', label: 'Double opt-in', href: '/settings/double-optin', icon: 'mail', admin: true }, // #510
		{ id: 'signature', label: 'Signature', href: '/settings/signature', icon: 'mail', admin: true }, // #594
		{ id: 'newsletter', label: 'Newsletter archive', href: '/settings/newsletter', icon: 'pages', admin: true }, // #481
		{ id: 'custom-fields', label: 'Custom fields', href: '/settings/custom-fields', icon: 'forms', admin: true }, // #619
		{ id: 'automations', label: 'Automations', href: '/settings/automations', icon: 'automations', admin: true },
		{ id: 'scoring', label: 'Scoring', href: '/settings/scoring', icon: 'reports', admin: true },
		{ id: 'backups', label: 'Backups', href: '/settings/backups', icon: 'export', admin: true }
	];
	const items = $derived(all.filter((i) => (!i.admin || isAdmin) && (i.id !== 'snapshots' || snapshots)));
</script>

<div class="shell">
	<nav class="sections" aria-label="Settings sections">
		<div class="eyebrow">Settings</div>
		<ul>
			{#each items as item (item.id)}
				<li>
					<a
						href={item.href}
						class:current={current === item.id}
						aria-current={current === item.id ? 'page' : undefined}><Icon name={item.icon} size={16} />{item.label}</a
					>
				</li>
			{/each}
		</ul>
	</nav>
	<div class="content">
		{@render children()}
	</div>
</div>

<style>
	.shell { display: flex; flex-direction: column; gap: var(--space-m); min-width: 0; max-width: 100%; }
	.content { min-width: 0; flex: 1; }
	.eyebrow {
		font-size: var(--size-xs);
		line-height: var(--line-xs);
		letter-spacing: var(--letter-spacing-xs);
		font-weight: var(--weight-ui-medium);
		color: var(--neutral-7);
		margin: 0 0 var(--space-xs);
		padding: 0 var(--space-s);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: var(--space-xxs);
		overflow-x: auto;
		scrollbar-width: thin;
	}
	li { flex: none; }
	/* The theme's navigation-menu link: hover neutral-3, current = active navigation fill. */
	a {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-s);
		border-radius: var(--radius-s);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--tracking-l);
		font-weight: var(--weight-ui-regular);
		color: var(--neutral-10);
		text-decoration: none;
		white-space: nowrap;
		transition: background-color var(--motion-duration) var(--motion-easing);
	}
	a:hover { background: var(--neutral-3); color: var(--neutral-10); text-decoration: none; }
	a.current {
		background: var(--navigation-active-background);
		color: var(--navigation-active-foreground);
		font-weight: var(--weight-ui-medium);
	}
	a:focus-visible { box-shadow: var(--focus-halo); }

	/* Below 900px the eyebrow would sit awkwardly above a one-line row — hide it. */
	@media (max-width: 899px) {
		.eyebrow { display: none; }
		.sections {
			box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
			padding-bottom: var(--space-xs);
			min-width: 0;
			max-width: 100%;
		}
	}
	@media (min-width: 900px) {
		.shell { flex-direction: row; align-items: flex-start; gap: var(--space-xl); }
		.sections { flex: 0 0 200px; position: sticky; top: var(--space-m); }
		ul { flex-direction: column; overflow: visible; }
	}
</style>

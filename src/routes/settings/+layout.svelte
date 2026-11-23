<script lang="ts">
	import { page } from '$app/state';
	import SettingsTabs from '$lib/components/SettingsTabs.svelte';

	let { children, data } = $props();

	// The section is the first segment after /settings (none = General).
	const current = $derived.by(() => {
		const seg = page.url.pathname.split('/')[2];
		return seg === 'setup' || seg === 'users' || seg === 'api' || seg === 'webhooks' || seg === 'integrations' || seg === 'mail' || seg === 'tracking' || seg === 'snapshots' || seg === 'assistant' || seg === 'domain' || seg === 'deliverability' || seg === 'unsubscribe' || seg === 'double-optin' || seg === 'signature' || seg === 'backups' || seg === 'automations' || seg === 'scoring' || seg === 'newsletter' || seg === 'brand-kit' || seg === 'custom-fields'
			? seg
			: 'general';
	});
</script>

<SettingsTabs {current} isAdmin={data.user?.role === 'admin'} snapshots={data.snapshotsEnabled}>
	{@render children()}
</SettingsTabs>

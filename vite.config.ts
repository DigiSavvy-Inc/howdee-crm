import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { latestMigration } from './scripts/latest-migration.mjs';

export default defineConfig({
	plugins: [
		// #741: SvelteKit 3 reads its configuration here; svelte.config.js is no longer supported
		// (it is an error for the file to exist).
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter(),
			// SvelteKit 3 no longer generates `$lib`. Keep it as an alias so the existing imports work
			// unchanged (the option is deprecated in favour of `#lib` subpath imports; a later change
			// can migrate).
			alias: { $lib: 'src/lib' },
			// Built-in origin CSRF is disabled here and re-enforced in hooks.server.ts, so the machine
			// webhook endpoints (e.g. /api/ingest) can accept cross-origin form posts while the app's
			// own forms stay protected. `trustedOrigins: ['*']` is SvelteKit 3's replacement for
			// `checkOrigin: false`: with '*' the built-in check is compiled out entirely.
			csrf: { trustedOrigins: ['*'] },
			// Kit 3 polls for a new version hourly by default (kit 2 didn't poll). The PWA's service
			// worker already announces new deploys (src/lib/pwa.svelte.ts), so keep polling off.
			version: { pollInterval: 0 }
		})
	],
	// #609: Settings → Setup compares the database's newest applied migration with this.
	define: { __LATEST_MIGRATION__: JSON.stringify(latestMigration()) }
});

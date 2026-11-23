import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
	},
	// Built-in origin CSRF is disabled here and re-enforced in hooks.server.ts, so the
	// machine webhook endpoints (e.g. /api/ingest) can accept cross-origin form posts
	// while the app's own forms stay protected.
	kit: { adapter: adapter(), csrf: { checkOrigin: false } }
};

export default config;

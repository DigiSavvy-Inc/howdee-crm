import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { latestMigration } from './scripts/latest-migration.mjs';

export default defineConfig({
	plugins: [sveltekit()],
	// #609: Settings → Setup compares the database's newest applied migration with this.
	define: { __LATEST_MIGRATION__: JSON.stringify(latestMigration()) }
});

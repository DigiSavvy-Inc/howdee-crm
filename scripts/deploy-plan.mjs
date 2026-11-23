/**
 * Production deploy order. The npm script `deploy` runs this via scripts/deploy.mjs.
 * Migrations go out before the Worker. A non-zero exit stops the later steps.
 */

/**
 * @param {string} databaseName D1 `database_name` for the `DB` binding in wrangler.jsonc
 * @returns {string[][]}
 */
export function deployPlan(databaseName) {
	if (!databaseName) throw new Error('D1 database name is required');
	return [
		['wrangler', 'd1', 'migrations', 'apply', databaseName, '--remote'],
		['npm', 'run', 'build'],
		['wrangler', 'deploy']
	];
}

/**
 * @param {string} databaseName
 * @param {(step: string[]) => number} run
 * @returns {number} exit code of the first failing step, or 0
 */
export function runDeploy(databaseName, run) {
	for (const step of deployPlan(databaseName)) {
		const code = run(step);
		if (code !== 0) return code;
	}
	return 0;
}

/**
 * Read the `database_name` next to the D1 binding `DB`.
 * @param {string} wranglerConfig contents of wrangler.jsonc
 * @returns {string}
 */
export function databaseNameFromWranglerConfig(wranglerConfig) {
	const bindingAt = wranglerConfig.search(/"binding"\s*:\s*"DB"/);
	if (bindingAt < 0) {
		throw new Error('wrangler config has no D1 binding "DB"');
	}
	const window = wranglerConfig.slice(Math.max(0, bindingAt - 400), bindingAt + 400);
	const name = window.match(/"database_name"\s*:\s*"([^"]+)"/);
	if (!name || !name[1]) {
		throw new Error('D1 binding "DB" has no database_name');
	}
	return name[1];
}

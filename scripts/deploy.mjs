import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { databaseNameFromWranglerConfig, runDeploy } from './deploy-plan.mjs';
import { resolveWranglerBin } from './wrangler-bin.mjs';

const require = createRequire(import.meta.url);
const wranglerBin = resolveWranglerBin(require);

/**
 * Apply remote D1 migrations, then build, then deploy the Worker.
 * Stops if migrations fail. The migration step is `--remote`, so run this against production
 * only after the change has been reviewed.
 */
function main() {
	const configUrl = new URL('../wrangler.jsonc', import.meta.url);
	const databaseName = databaseNameFromWranglerConfig(readFileSync(configUrl, 'utf8'));
	const code = runDeploy(databaseName, (step) => {
		const [command, ...args] = step;
		// Use this install's wrangler, not whatever `wrangler` happens to be on PATH.
		const result =
			command === 'wrangler'
				? spawnSync(process.execPath, [wranglerBin, ...args], { stdio: 'inherit' })
				: spawnSync(command, args, { stdio: 'inherit' });
		if (result.error) {
			console.error(result.error.message);
			return 1;
		}
		return result.status ?? 1;
	});
	process.exit(code);
}

const invokedDirectly =
	process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

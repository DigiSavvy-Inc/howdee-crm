import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { databaseNameFromWranglerConfig, deployPlan, runDeploy } from '../scripts/deploy-plan.mjs';
import { wranglerBinFromPackage } from '../scripts/wrangler-bin.mjs';

const WRANGLER_DB = `{
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "postmark-marketing",
			"database_id": "00000000-0000-0000-0000-000000000000",
			"migrations_dir": "migrations"
		}
	]
}`;

describe('deploy plan', () => {
	it('npm run deploy is the script that runs this plan', () => {
		expect(pkg.scripts.deploy).toBe('node scripts/deploy.mjs');
	});

	it('reads the DB binding database name from wrangler config', () => {
		expect(databaseNameFromWranglerConfig(WRANGLER_DB)).toBe('postmark-marketing');
		expect(() => databaseNameFromWranglerConfig('{"d1_databases":[]}')).toThrow(/binding "DB"/);
	});

	it('runs migrations before the build and the worker deploy', () => {
		const calls: string[] = [];
		const code = runDeploy('postmark-marketing', (step) => {
			calls.push(step.join(' '));
			return 0;
		});
		expect(code).toBe(0);
		expect(calls).toEqual([
			'wrangler d1 migrations apply postmark-marketing --remote',
			'npm run build',
			'wrangler deploy'
		]);
		const plan = deployPlan('postmark-marketing');
		const migrateAt = plan.findIndex((step) => step.includes('migrations'));
		const deployAt = plan.findIndex((step) => step[0] === 'wrangler' && step[1] === 'deploy');
		expect(migrateAt).toBeGreaterThanOrEqual(0);
		expect(deployAt).toBeGreaterThan(migrateAt);
	});

	it('does not build or deploy when the migration step fails', () => {
		const calls: string[] = [];
		const code = runDeploy('postmark-marketing', (step) => {
			calls.push(step.join(' '));
			return step.includes('migrations') ? 2 : 0;
		});
		expect(code).toBe(2);
		expect(calls).toEqual(['wrangler d1 migrations apply postmark-marketing --remote']);
	});
});

describe('wrangler bin lookup', () => {
	const dir = '/repo/node_modules/wrangler';

	it('uses the wrangler key when bin is an object', () => {
		const wranglerPkg = {
			bin: { 'cf-wrangler': './bin/cf-wrangler.js', wrangler: './bin/wrangler.js', wrangler2: './bin/wrangler.js' }
		};
		expect(wranglerBinFromPackage(wranglerPkg, dir)).toBe('/repo/node_modules/wrangler/bin/wrangler.js');
	});

	it('uses bin directly when it is a string', () => {
		expect(wranglerBinFromPackage({ bin: 'bin/wrangler.js' }, `${dir}/`)).toBe(
			'/repo/node_modules/wrangler/bin/wrangler.js'
		);
	});

	it('throws when there is no wrangler bin', () => {
		expect(() => wranglerBinFromPackage({}, dir)).toThrow(/no "wrangler" bin/);
		expect(() => wranglerBinFromPackage({ bin: { other: './x.js' } }, dir)).toThrow(/no "wrangler" bin/);
	});

	it('rejects a bin that leaves the package', () => {
		expect(() => wranglerBinFromPackage({ bin: { wrangler: '../evil.js' } }, dir)).toThrow(/inside the package/);
		expect(() => wranglerBinFromPackage({ bin: './bin/../../evil.js' }, dir)).toThrow(/inside the package/);
		expect(() => wranglerBinFromPackage({ bin: '/usr/bin/wrangler' }, dir)).toThrow(/inside the package/);
	});
});

describe('scripts never resolve the hidden wrangler path (#671)', () => {
	const files = import.meta.glob('../scripts/**/*.mjs', {
		query: '?raw',
		import: 'default',
		eager: true
	}) as Record<string, string>;

	it('scans the scripts folder', () => {
		expect(Object.keys(files).length).toBeGreaterThan(3);
	});

	it('no script contains wrangler/bin/wrangler.js', () => {
		const needle = ['wrangler', 'bin', 'wrangler.js'].join('/');
		const offenders = Object.entries(files)
			.filter(([, src]) => src.includes(needle))
			.map(([name]) => name);
		expect(offenders).toEqual([]);
	});
});

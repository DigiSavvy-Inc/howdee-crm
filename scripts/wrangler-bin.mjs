/**
 * Find this install's wrangler entry script. wrangler's `exports` map hides
 * `./bin/wrangler.js`, so read the `bin` field from its package.json instead.
 * No node imports here: the unit test runs inside the Workers runtime.
 */

/**
 * @param {{ bin?: string | Record<string, string> }} pkg parsed wrangler package.json
 * @param {string} pkgDir directory that holds that package.json
 * @returns {string} absolute path of the wrangler entry script
 */
export function wranglerBinFromPackage(pkg, pkgDir) {
	const bin = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.wrangler;
	if (typeof bin !== 'string' || bin.trim() === '') {
		throw new Error('wrangler package.json has no "wrangler" bin entry');
	}
	if (bin.startsWith('/') || /^[A-Za-z]:/.test(bin) || bin.split(/[\\/]/).includes('..')) {
		throw new Error(`wrangler bin path must stay inside the package: ${bin}`);
	}
	const relative = bin.replace(/^\.\//, '');
	return `${pkgDir.replace(/[\\/]+$/, '')}/${relative}`;
}

/**
 * @param {{ (id: string): any, resolve(id: string): string }} require a require made by `createRequire`
 * @returns {string} absolute path of the wrangler entry script
 */
export function resolveWranglerBin(require) {
	const pkgPath = require.resolve('wrangler/package.json');
	const pkgDir = pkgPath.slice(0, Math.max(pkgPath.lastIndexOf('/'), pkgPath.lastIndexOf('\\')));
	return wranglerBinFromPackage(require(pkgPath), pkgDir);
}

/**
 * `npm run deploy` (scripts/deploy.mjs runs this). Pure: every command, file and random byte goes
 * through the context, so tests drive it with a fake runner. No node imports (the unit test runs
 * in workerd). Spec: docs/easy-install.md → "What the deploy does" (#730).
 *
 * Two modes, picked from local files and flags before any network call:
 *
 * - **classic** — an existing install (wrangler.jsonc has a real D1 database_id, no unfinished
 *   install, no flag). Exactly the pre-#730 deploy: `wrangler d1 migrations apply <database_name>
 *   --remote`, `npm run build`, `wrangler deploy`, interactive, nothing listed, created, written or
 *   generated.
 * - **install** — a new install (config just written from the template, no or all-zero database_id,
 *   a pending-install marker, or `--setup` / `--new-setup-token`). Order: database → bucket →
 *   migrations → build → upload (with any missing secrets) → setup link → address. A failing step
 *   stops the run; a failed migration uploads nothing. A secret value is never logged: generated
 *   secrets reach wrangler only through the temporary secrets file the context creates and deletes
 *   (`wrangler deploy --secrets-file`). The one value ever printed is a SETUP_TOKEN this run
 *   generated, inside the one-time setup link's URL fragment.
 */

import {
	configFromTemplate,
	isPlaceholderDatabaseId,
	needsPublicUrl,
	readConfig,
	readDatabaseBinding,
	setDatabaseId,
	setVar
} from './install-config.mjs';

export const CONFIG_FILE = 'wrangler.jsonc';
export const TEMPLATE_FILE = 'wrangler.example.jsonc';
/** Pending-install marker: git-ignored (.wrangler), holds step and resource names only, never a secret. */
export const MARKER_FILE = '.wrangler/howdee-install.json';

/** Command-line flags (`npm run deploy -- --setup`). */
export const FLAGS = Object.freeze({
	'--setup': 'setup',
	'--adopt-database': 'adoptDatabase',
	'--new-setup-token': 'newSetupToken'
});

/**
 * Secrets the deploy generates when missing. `encoding` is how the random bytes are written.
 * SETUP_TOKEN is separate: only while no user exists, and never in CI (it would land in a build log).
 */
export const GENERATED_SECRETS = Object.freeze([
	{ name: 'SESSION_SECRET', bytes: 32, encoding: 'base64url' },
	{ name: 'WEBHOOK_KEY', bytes: 32, encoding: 'hex' },
	{ name: 'CRON_KEY', bytes: 32, encoding: 'hex' },
	{ name: 'INGEST_KEY', bytes: 32, encoding: 'hex' },
	{ name: 'MAIL_TOKEN_KEY', bytes: 32, encoding: 'base64url' }
]);
export const SETUP_TOKEN = Object.freeze({ name: 'SETUP_TOKEN', bytes: 24, encoding: 'base64url' });

/** Cloudflare API token permission each command needs, for the one-line refusal message. */
const PERMISSIONS = [
	{ prefix: ['wrangler', 'd1'], permission: 'Account · D1 · Edit' },
	{ prefix: ['wrangler', 'r2'], permission: 'Account · Workers R2 Storage · Edit' },
	{ prefix: ['wrangler', 'secret'], permission: 'Account · Workers Scripts · Edit' },
	{ prefix: ['wrangler', 'deploy'], permission: 'Account · Workers Scripts · Edit' }
];

const NEW_TOKEN_HINT = '`npm run deploy -- --new-setup-token`';
/**
 * #747: /setup refuses a SETUP_TOKEN shorter than this (after trimming); keep in step with
 * SETUP_TOKEN_MIN_LENGTH in src/lib/server/setup.ts. A generated token (24 bytes, base64url) is 32.
 */
export const SETUP_TOKEN_MIN_LENGTH = 20;
const SETUP_TOKEN_MIN_TEXT = `at least ${SETUP_TOKEN_MIN_LENGTH} characters`;

/**
 * @typedef {{ code: number, stdout?: string, stderr?: string }} RunResult
 * @typedef {{
 *   run(step: string[], opts?: { capture?: boolean }): RunResult,
 *   exists(file: string): boolean,
 *   read(file: string): string,
 *   write(file: string, text: string): void,
 *   remove(file: string): void,
 *   randomBytes(n: number): Uint8Array,
 *   withSecretsFile<T>(secrets: Record<string, string>, fn: (path: string) => T): T,
 *   log(line: string): void,
 *   argv?: string[],
 *   ci?: boolean,
 *   workersBuilds?: boolean
 * }} DeployContext
 * @typedef {{ setup: boolean, adoptDatabase: boolean, newSetupToken: boolean }} DeployFlags
 * @typedef {{ database?: string, bucket?: string, createdDatabase?: string, createdBucket?: string, steps?: string[] }} Marker
 */

// ---------------------------------------------------------------------------------------------
// Classic mode: the pre-#730 deploy, unchanged.

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
 * Read the `database_name` next to the D1 binding `DB` (the pre-#730 lookup, kept as is).
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

// ---------------------------------------------------------------------------------------------
// Pure helpers.

/**
 * @param {string[] | undefined} argv
 * @returns {{ flags: DeployFlags, error: string | null }}
 */
export function parseArgs(argv) {
	/** @type {DeployFlags} */
	const flags = { setup: false, adoptDatabase: false, newSetupToken: false };
	for (const arg of argv ?? []) {
		const key = /** @type {keyof DeployFlags | undefined} */ (FLAGS[/** @type {keyof typeof FLAGS} */ (arg)]);
		if (!key) return { flags, error: `Unknown option "${arg}". Options: ${Object.keys(FLAGS).join(', ')}.` };
		flags[key] = true;
	}
	return { flags, error: null };
}

/**
 * Pick the mode from local facts only.
 * @param {{ configExisted: boolean, databaseId: string | null, markerExists: boolean, flags: DeployFlags }} facts
 * @returns {{ mode: 'classic' | 'install', reason: string }}
 */
export function chooseMode(facts) {
	if (!facts.configExisted) return { mode: 'install', reason: `${CONFIG_FILE} was just written from ${TEMPLATE_FILE}` };
	if (facts.flags.setup) return { mode: 'install', reason: '--setup was passed' };
	if (facts.flags.newSetupToken) return { mode: 'install', reason: '--new-setup-token was passed' };
	if (facts.markerExists) return { mode: 'install', reason: `an earlier install run didn't finish (${MARKER_FILE})` };
	if (isPlaceholderDatabaseId(facts.databaseId)) return { mode: 'install', reason: `${CONFIG_FILE} has no D1 database_id` };
	return { mode: 'classic', reason: `${CONFIG_FILE} has a D1 database_id` };
}

/** @param {string | undefined} s */
export function stripAnsi(s) {
	// eslint-disable-next-line no-control-regex
	return (s ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

/** @param {Uint8Array} bytes */
export function toHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {Uint8Array} bytes */
export function toBase64url(bytes) {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {{ bytes: number, encoding: string }} spec
 * @param {(n: number) => Uint8Array} randomBytes
 */
export function generateValue(spec, randomBytes) {
	const bytes = randomBytes(spec.bytes);
	if (!(bytes instanceof Uint8Array) || bytes.length !== spec.bytes) throw new Error('random source returned the wrong length');
	return spec.encoding === 'hex' ? toHex(bytes) : toBase64url(bytes);
}

/**
 * Parse JSON from a command's stdout, skipping any text before the first `[` or `{`.
 * @param {string | undefined} out
 */
export function parseJsonOutput(out) {
	const text = stripAnsi(out).trim();
	try {
		return JSON.parse(text);
	} catch {
		const start = text.search(/[[{]/);
		if (start < 0) return null;
		const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

/**
 * `wrangler d1 list --json` → [{ uuid, name }].
 * @param {string | undefined} out
 * @returns {{ uuid: string, name: string }[] | null}
 */
export function parseDatabases(out) {
	const json = parseJsonOutput(out);
	if (!Array.isArray(json)) return null;
	return json
		.filter((d) => d && typeof d.name === 'string')
		.map((d) => ({ uuid: String(d.uuid ?? d.id ?? ''), name: d.name }));
}

/**
 * The id in `wrangler d1 create` output (it prints a config snippet with `"database_id": "<uuid>"`).
 * @param {string | undefined} out
 */
export function parseCreatedDatabaseId(out) {
	const m = stripAnsi(out).match(/database_id"?\s*[:=]\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
	return m ? m[1] : null;
}

/**
 * `wrangler r2 bucket list` (text only, no JSON option: `name: <bucket>` lines) → names. It is a
 * single page from the API.
 * @param {string | undefined} out
 */
export function parseBuckets(out) {
	return [...stripAnsi(out).matchAll(/^[ \t]*name:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
}

/**
 * `wrangler secret list --format json` → names (values are never listed by wrangler).
 * @param {string | undefined} out
 * @returns {string[] | null}
 */
export function parseSecretNames(out) {
	const json = parseJsonOutput(out);
	if (!Array.isArray(json)) return null;
	return json.filter((s) => s && typeof s.name === 'string').map((s) => s.name);
}

/**
 * `wrangler d1 execute … --json` of `SELECT COUNT(*) AS n FROM users` → the count, or null.
 * @param {string | undefined} out
 */
export function parseUserCount(out) {
	const json = parseJsonOutput(out);
	const first = Array.isArray(json) ? json[0] : json;
	const n = first?.results?.[0]?.n;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * The first workers.dev address in `wrangler deploy` output.
 * @param {string | undefined} out
 */
export function parseWorkerUrl(out) {
	const m = stripAnsi(out).match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i);
	return m ? m[0] : null;
}

/** @param {string} s */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * wrangler's own message for `secret list` on a Worker that doesn't exist yet:
 * `Worker "<name>" not found.` (optionally ` (env: <env>)` before "not found").
 * @param {RunResult} result
 * @param {string} workerName
 */
export function isWorkerNotFound(result, workerName) {
	return new RegExp(`Worker "${escapeRe(workerName)}"(?: \\(env: [^)]*\\))? not found\\.`).test(output(result));
}

/**
 * What to do about the `DB` database in install mode.
 * @param {{ name: string, id: string | null }} db from wrangler.jsonc
 * @param {{ uuid: string, name: string }[]} existing on the account
 * @param {{ workersBuilds?: boolean, adoptDatabase?: boolean, createdByThisInstall?: boolean }} [opts]
 * @returns {{ action: 'keep' } | { action: 'adopt', id: string, why: string } | { action: 'create' } | { action: 'stop', message: string }}
 */
export function planDatabase(db, existing, opts = {}) {
	if (!isPlaceholderDatabaseId(db.id)) {
		if (existing.some((d) => d.uuid === db.id)) return { action: 'keep' };
		// Never create a replacement and never overwrite a real id.
		return {
			action: 'stop',
			message: `Database "${db.name}" in ${CONFIG_FILE}: this database id is not on the logged-in Cloudflare account; check \`wrangler whoami\` or CLOUDFLARE_ACCOUNT_ID.`
		};
	}
	const byName = existing.find((d) => d.name === db.name);
	if (!byName) return { action: 'create' };
	if (opts.createdByThisInstall) return { action: 'adopt', id: byName.uuid, why: 'created by an earlier run of this install' };
	// Workers Builds provisions the database from the config before the deploy command runs. A
	// same-named database is adopted here because a button install has no other way to find its own
	// database on a later build; telling its own from another install's is tracked separately.
	if (opts.workersBuilds) return { action: 'adopt', id: byName.uuid, why: 'provisioned by Workers Builds' };
	if (opts.adoptDatabase) return { action: 'adopt', id: byName.uuid, why: '--adopt-database' };
	return {
		action: 'stop',
		message: `A database named "${db.name}" already exists on this account and this install didn't create it. Change database_name in ${CONFIG_FILE}, or run \`npm run deploy -- --adopt-database\` to use that database.`
	};
}

/**
 * The secrets to generate: every GENERATED_SECRETS name that isn't set, plus SETUP_TOKEN while no
 * user exists (not in CI). Existing values are never read. The one replacement: `newSetupToken`
 * replaces SETUP_TOKEN (only that name, only with no user, never in CI).
 * @param {string[]} setNames
 * @param {{ users: number | null, ci?: boolean, newSetupToken?: boolean }} state
 * @param {(n: number) => Uint8Array} randomBytes
 * @returns {{ secrets: Record<string, string>, setupToken: string | null }}
 */
export function planSecrets(setNames, state, randomBytes) {
	const have = new Set(setNames);
	/** @type {Record<string, string>} */
	const secrets = {};
	for (const spec of GENERATED_SECRETS) {
		if (!have.has(spec.name)) secrets[spec.name] = generateValue(spec, randomBytes);
	}
	let setupToken = null;
	if (state.users === 0 && !state.ci && (state.newSetupToken || !have.has(SETUP_TOKEN.name))) {
		setupToken = generateValue(SETUP_TOKEN, randomBytes);
		secrets[SETUP_TOKEN.name] = setupToken;
	}
	return { secrets, setupToken };
}

/** @param {string[]} step */
function stepText(step) {
	return step.join(' ');
}

/** @param {RunResult} r */
function output(r) {
	return stripAnsi(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
}

/**
 * Wrangler can't pick an account without a terminal. Its message lists the accounts; we don't.
 * @param {RunResult} result
 */
export function multiAccountLine(result) {
	if (!/More than one account available/i.test(output(result))) return null;
	return 'This Cloudflare login can reach more than one account and wrangler can\'t ask which one here. Set CLOUDFLARE_ACCOUNT_ID to the account to install into and run npm run deploy again (account_id in wrangler.jsonc alone is not enough: `wrangler r2 bucket list` doesn\'t read it).';
}

/**
 * One clear line when Cloudflare refused a command for lack of a login or permission, else null.
 * Only an API refusal counts (authentication error / code 10000, or a 403 from the API), never a
 * local file error such as EACCES.
 * @param {string[]} step
 * @param {RunResult} result
 */
export function refusalLine(step, result) {
	const out = output(result);
	if (/not logged in|not authenticated|CLOUDFLARE_API_TOKEN environment variable/i.test(out)) {
		return `"${stepText(step)}" needs a Cloudflare login: run \`npx wrangler login\`, or set CLOUDFLARE_API_TOKEN.`;
	}
	const apiRefusal =
		/Authentication error|\[code: 1000[01]\]/i.test(out) ||
		(/A request to the Cloudflare API/i.test(out) && /\b403\b|Forbidden|Unauthorized|not authorized/i.test(out));
	if (!apiRefusal) return null;
	const rule = PERMISSIONS.find((p) => p.prefix.every((part, i) => step[i] === part));
	const permission = rule ? rule.permission : 'the right';
	return `Cloudflare refused "${stepText(step)}": the API token needs the "${permission}" permission.`;
}

/**
 * Report a failed step and return its exit code (at least 1).
 * @param {DeployContext} ctx
 * @param {string[]} step
 * @param {RunResult} result
 */
function fail(ctx, step, result) {
	const line = multiAccountLine(result) ?? refusalLine(step, result);
	if (line) {
		ctx.log(line);
	} else {
		const detail = stripAnsi(result.stderr || result.stdout || '').trim();
		if (detail) ctx.log(detail);
		ctx.log(`"${stepText(step)}" failed. Nothing after it ran.`);
	}
	return result.code || 1;
}

/**
 * A captured wrangler command (the runner disables colour); ANSI is stripped as well.
 * @param {DeployContext} ctx
 * @param {string[]} step
 * @returns {RunResult}
 */
function capture(ctx, step) {
	const r = ctx.run(step, { capture: true });
	return { code: r.code, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
}

/** @param {DeployContext} ctx @param {RunResult} r */
function echo(ctx, r) {
	for (const part of [r.stdout, r.stderr]) {
		const text = (part ?? '').trim();
		if (text) ctx.log(text);
	}
}

/** @param {DeployContext} ctx @returns {Marker} */
function readMarker(ctx) {
	if (!ctx.exists(MARKER_FILE)) return {};
	try {
		const m = JSON.parse(ctx.read(MARKER_FILE));
		return m && typeof m === 'object' ? m : {};
	} catch {
		return {};
	}
}

/** @param {DeployContext} ctx @param {Marker} marker */
function writeMarker(ctx, marker) {
	ctx.write(MARKER_FILE, `${JSON.stringify(marker, null, '\t')}\n`);
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {DeployContext} ctx
 * @returns {number} exit code
 */
export function runDeploy(ctx) {
	const { flags, error } = parseArgs(ctx.argv);
	if (error) {
		ctx.log(error);
		return 1;
	}

	// Local only, before any network call: config and marker decide the mode.
	const configExisted = ctx.exists(CONFIG_FILE);
	if (!configExisted) {
		if (!ctx.exists(TEMPLATE_FILE)) {
			ctx.log(`No ${CONFIG_FILE} and no ${TEMPLATE_FILE} to write it from.`);
			return 1;
		}
		ctx.write(CONFIG_FILE, configFromTemplate(ctx.read(TEMPLATE_FILE)));
		ctx.log(`Wrote ${CONFIG_FILE} from ${TEMPLATE_FILE}.`);
	}
	const text = ctx.read(CONFIG_FILE);
	const { mode, reason } = chooseMode({
		configExisted,
		databaseId: readDatabaseBinding(text).id,
		markerExists: ctx.exists(MARKER_FILE),
		flags
	});

	if (mode === 'classic') {
		ctx.log(`Deploy mode: classic (${reason}). Migrations, build, upload; nothing else is checked or changed.`);
		let databaseName;
		try {
			databaseName = databaseNameFromWranglerConfig(text);
		} catch (e) {
			ctx.log(e instanceof Error ? e.message : String(e));
			return 1;
		}
		for (const step of deployPlan(databaseName)) {
			const code = ctx.run(step).code;
			if (code !== 0) return code;
		}
		return 0;
	}

	ctx.log(`Deploy mode: install (${reason}).`);
	return runInstall(ctx, text, flags, configExisted);
}

/**
 * @param {DeployContext} ctx
 * @param {string} text contents of wrangler.jsonc
 * @param {DeployFlags} flags
 * @param {boolean} configExisted
 */
function runInstall(ctx, text, flags, configExisted) {
	let cfg;
	try {
		cfg = readConfig(text);
	} catch (e) {
		ctx.log(e instanceof Error ? e.message : String(e));
		return 1;
	}
	if (flags.newSetupToken && ctx.ci) {
		ctx.log('--new-setup-token prints a token, so it doesn\'t run in CI. Run it from a terminal.');
		return 1;
	}

	// The marker is for a first install that stops half way. `--setup` / `--new-setup-token` on an
	// install that already has its database id leave none behind, so the next plain run is classic.
	const markerExisted = ctx.exists(MARKER_FILE);
	const tracked = !configExisted || isPlaceholderDatabaseId(cfg.database.id) || markerExisted;
	const previous = readMarker(ctx);
	/** @type {Marker} */
	const marker = {
		database: cfg.database.name,
		bucket: cfg.bucket,
		createdDatabase: previous.createdDatabase,
		createdBucket: previous.createdBucket,
		steps: []
	};
	const save = () => {
		if (tracked) writeMarker(ctx, marker);
	};
	save();
	/** @param {string} name */
	const done = (name) => {
		marker.steps = [...(marker.steps ?? []), name];
		save();
	};

	// 1. Database.
	const listDb = ['wrangler', 'd1', 'list', '--json'];
	let r = capture(ctx, listDb);
	if (r.code !== 0) return fail(ctx, listDb, r);
	const databases = parseDatabases(r.stdout);
	if (!databases) {
		ctx.log(`Couldn't read the database list from "${stepText(listDb)}".`);
		return 1;
	}
	const dbPlan = planDatabase(cfg.database, databases, {
		workersBuilds: ctx.workersBuilds,
		adoptDatabase: flags.adoptDatabase,
		createdByThisInstall: previous.createdDatabase === cfg.database.name
	});
	if (dbPlan.action === 'stop') {
		ctx.log(dbPlan.message);
		return 1;
	}

	// 2. Bucket: checked before anything is created, so a new install never takes over a bucket
	// someone else made (no id ties a bucket to this install, as one does a database).
	const listR2 = ['wrangler', 'r2', 'bucket', 'list'];
	r = capture(ctx, listR2);
	if (r.code !== 0) return fail(ctx, listR2, r);
	const bucketExists = parseBuckets(r.stdout).includes(cfg.bucket);
	if (bucketExists && dbPlan.action === 'create' && previous.createdBucket !== cfg.bucket) {
		ctx.log(`A bucket named "${cfg.bucket}" already exists on this account. Change bucket_name in ${CONFIG_FILE} and run npm run deploy again.`);
		return 1;
	}

	let text2 = text;
	if (dbPlan.action === 'keep') {
		ctx.log(`Database ${cfg.database.name} found.`);
	} else {
		let id = dbPlan.action === 'adopt' ? dbPlan.id : null;
		if (dbPlan.action === 'create') {
			const create = ['wrangler', 'd1', 'create', cfg.database.name];
			r = capture(ctx, create);
			if (r.code !== 0) return fail(ctx, create, r);
			marker.createdDatabase = cfg.database.name;
			save();
			id = parseCreatedDatabaseId(r.stdout);
			if (!id) {
				r = capture(ctx, listDb);
				if (r.code !== 0) return fail(ctx, listDb, r);
				id = parseDatabases(r.stdout)?.find((d) => d.name === cfg.database.name)?.uuid ?? null;
			}
			if (!id) {
				ctx.log(`Created database ${cfg.database.name}, but couldn't find its id. Run npm run deploy again.`);
				return 1;
			}
			ctx.log(`Created database ${cfg.database.name}.`);
		} else {
			ctx.log(`Database ${cfg.database.name} found (${dbPlan.why}).`);
		}
		text2 = setDatabaseId(text2, /** @type {string} */ (id));
		ctx.write(CONFIG_FILE, text2);
		ctx.log(`Wrote its id to ${CONFIG_FILE}.`);
	}
	done('database');

	if (bucketExists) {
		ctx.log(`Bucket ${cfg.bucket} found.`);
	} else {
		const create = ['wrangler', 'r2', 'bucket', 'create', cfg.bucket];
		r = capture(ctx, create);
		if (r.code !== 0) {
			if (!multiAccountLine(r) && !refusalLine(create, r) && /already exists|10004/i.test(output(r))) {
				ctx.log(
					`Couldn't create bucket "${cfg.bucket}": the name is taken or wasn't in the bucket list. Pick another bucket_name in ${CONFIG_FILE} and run npm run deploy again.`
				);
				return r.code || 1;
			}
			return fail(ctx, create, r);
		}
		marker.createdBucket = cfg.bucket;
		ctx.log(`Created bucket ${cfg.bucket}.`);
	}
	done('bucket');

	// 3. Migrations. A failure stops here: nothing is uploaded.
	const migrate = ['wrangler', 'd1', 'migrations', 'apply', cfg.database.name, '--remote'];
	r = ctx.run(migrate);
	if (r.code !== 0) return fail(ctx, migrate, r);
	done('migrations');

	// Users decide the setup link. Unknown (query failed) = no SETUP_TOKEN is generated.
	const countUsers = ['wrangler', 'd1', 'execute', cfg.database.name, '--remote', '--json', '--command', 'SELECT COUNT(*) AS n FROM users'];
	r = capture(ctx, countUsers);
	const users = r.code === 0 ? parseUserCount(r.stdout) : null;

	// Names of the secrets already set (never values). Only wrangler's "Worker … not found" means
	// a Worker that doesn't exist yet (none set); any other failure stops.
	const listSecrets = ['wrangler', 'secret', 'list', '--format', 'json'];
	r = capture(ctx, listSecrets);
	/** @type {string[] | null} */
	let setNames;
	let workerIsNew = false;
	if (r.code === 0) setNames = parseSecretNames(r.stdout);
	else if (!multiAccountLine(r) && !refusalLine(listSecrets, r) && isWorkerNotFound(r, cfg.name)) {
		setNames = [];
		workerIsNew = true;
	} else return fail(ctx, listSecrets, r);
	if (!setNames) {
		ctx.log(`Couldn't read the secret names from "${stepText(listSecrets)}".`);
		return 1;
	}

	if (flags.newSetupToken && users !== 0) {
		ctx.log(
			users === null
				? "Couldn't read the number of users, so no new setup token was made. Nothing was built or uploaded."
				: 'An admin already exists, so --new-setup-token made nothing. Sign in instead. Nothing was built or uploaded.'
		);
		return 1;
	}
	const { secrets, setupToken } = planSecrets(setNames, { users, ci: ctx.ci, newSetupToken: flags.newSetupToken }, ctx.randomBytes);
	const newNames = Object.keys(secrets);

	// 4. Build.
	const build = ['npm', 'run', 'build'];
	r = ctx.run(build);
	if (r.code !== 0) return fail(ctx, build, r);
	done('build');

	// 5. Upload, with the missing secrets in the same version (no window without SESSION_SECRET).
	const upload = newNames.length
		? ctx.withSecretsFile(secrets, (path) => {
				const step = ['wrangler', 'deploy', '--secrets-file', path];
				return capture(ctx, step);
			})
		: capture(ctx, ['wrangler', 'deploy']);
	if (upload.code !== 0) return fail(ctx, ['wrangler', 'deploy'], upload);

	// From here on the Worker is live with the new secrets. The setup link goes out first, before
	// anything that could fail, so a generated SETUP_TOKEN can never be lost.
	const workerUrl = parseWorkerUrl(upload.stdout);
	const configured = needsPublicUrl(cfg.publicBaseUrl) ? null : cfg.publicBaseUrl.replace(/\/+$/, '');
	let base = configured ?? workerUrl;
	echo(ctx, upload);
	if (setupToken) ctx.log(`Open ${base ?? "your Worker's workers.dev address"}/setup#token=${setupToken} to create the first admin.`);

	let finished = true;
	try {
		done('upload');
		ctx.log(newNames.length ? `Set ${newNames.length} secret${newNames.length === 1 ? '' : 's'}: ${newNames.join(', ')}.` : 'Secrets: nothing to set.');

		// 6. A new install has no public address yet: use the workers.dev one, then upload again so
		// the Worker gets the var (no build needed). A failure here only warns.
		if (!configured && workerUrl) {
			text2 = setVar(text2, 'PUBLIC_BASE_URL', workerUrl);
			ctx.write(CONFIG_FILE, text2);
			ctx.log(`Set PUBLIC_BASE_URL to ${workerUrl} in ${CONFIG_FILE}.`);
			const again = ['wrangler', 'deploy'];
			const r2 = capture(ctx, again);
			if (r2.code !== 0) {
				finished = false;
				fail(ctx, again, r2);
				ctx.log('Warning: the app is live, but the upload with its address failed. Run npm run deploy again to finish.');
			} else {
				echo(ctx, r2);
				ctx.log('Uploaded again with the address.');
				done('address');
			}
		} else if (!configured) {
			ctx.log(`Couldn't find the workers.dev address in the upload output; set PUBLIC_BASE_URL in ${CONFIG_FILE} yourself.`);
		}
	} catch (e) {
		finished = false;
		base = configured ?? workerUrl;
		ctx.log(`Warning: the app is live, but a step after the upload failed (${e instanceof Error ? e.message : String(e)}). Run npm run deploy again to finish.`);
	}

	// 7. Closing line.
	const where = base ?? "your Worker's workers.dev address";
	const looksFresh = !configExisted || dbPlan.action === 'create' || workerIsNew;
	if (setupToken) {
		ctx.log(`Done. Open the setup link above to create the first admin. It's shown only once; to get a fresh one, run ${NEW_TOKEN_HINT}.`);
	} else if (users === 0 && setNames.includes(SETUP_TOKEN.name)) {
		ctx.log(
			`No admin exists yet. Open ${where}/setup and either use the phrase you chose for SETUP_TOKEN (${SETUP_TOKEN_MIN_TEXT}), or run ${NEW_TOKEN_HINT} to get a fresh setup link.`
		);
	} else if (users === 0 && ctx.workersBuilds) {
		// The button path: the phrase typed on the Deploy page is meant to be SETUP_TOKEN, but the
		// secret list may not show it yet. Never print a value here.
		ctx.log(
			`No admin exists yet. Open ${where}/setup: the phrase you typed on the Deploy page is the setup token, and /setup asks for it. It needs ${SETUP_TOKEN_MIN_TEXT}. If /setup says the token is not set or too short, set a secret named SETUP_TOKEN on this Worker in the Cloudflare dashboard (Workers & Pages, the Worker, Settings), then open /setup again.`
		);
	} else if (users === 0) {
		ctx.log(`No admin exists and SETUP_TOKEN isn't set. Set it with \`npx wrangler secret put SETUP_TOKEN\` (${SETUP_TOKEN_MIN_TEXT}), then open ${where}/setup.`);
	} else if (users === null && looksFresh) {
		ctx.log(
			`Couldn't read the number of users. Open ${where}/setup to create the first admin; if it asks for a setup token you don't have, set one with \`npx wrangler secret put SETUP_TOKEN\` (${SETUP_TOKEN_MIN_TEXT}).`
		);
	} else {
		ctx.log(`Done. The app is at ${where}.`);
	}

	if (finished && tracked) {
		try {
			ctx.remove(MARKER_FILE);
		} catch {
			// a leftover marker only means the next run uses install mode again
		}
	}
	return 0;
}

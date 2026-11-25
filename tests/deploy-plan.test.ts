import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { wranglerBinFromPackage } from '../scripts/wrangler-bin.mjs';
import template from '../wrangler.example.jsonc?raw';
import {
	GENERATED_SECRETS,
	MARKER_FILE,
	chooseMode,
	deployPlan,
	isWorkerNotFound,
	multiAccountLine,
	parseArgs,
	parseBuckets,
	parseCreatedDatabaseId,
	parseDatabases,
	parseSecretNames,
	parseUserCount,
	parseWorkerUrl,
	planDatabase,
	planSecrets,
	refusalLine,
	runDeploy,
	stripAnsi,
	toBase64url,
	toHex
} from '../scripts/deploy-plan.mjs';
import {
	DEFAULT_NAMES,
	configFromTemplate,
	isPlaceholderDatabaseId,
	needsPublicUrl,
	readConfig,
	readDatabaseBinding,
	setDatabaseId,
	setVar,
	stripJsonc
} from '../scripts/install-config.mjs';

const DB_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = '99999999-2222-3333-4444-555555555555';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

/** An install that already deployed: real id, its own names, its own public URL. */
const EXISTING = `{
	// an existing install's config
	"name": "my-crm",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-db",
			"database_id": "${DB_ID}",
			"migrations_dir": "migrations"
		}
	],
	"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-media" }],
	"vars": {
		"PUBLIC_BASE_URL": "https://crm.example.com/x",
		"WORKER_NAME": "my-crm"
	}
}`;

/** The shipped config after a finished first install (id and address written). */
const INSTALLED = setVar(setDatabaseId(configFromTemplate(template), DB_ID), 'PUBLIC_BASE_URL', 'https://howdee-crm.someone.workers.dev');

const ALL_SECRETS = [...GENERATED_SECRETS.map((s) => s.name), 'SETUP_TOKEN', 'POSTMARK_TOKEN'];

type Result = { code: number; stdout?: string; stderr?: string };
type Answer = Result | ((step: string[]) => Result);

/** Fake runner and files. `answers` maps a step's text (or its leading words) to a result; default = success. */
function fakeContext(opts: {
	files?: Record<string, string>;
	answers?: Record<string, Answer>;
	ci?: boolean;
	workersBuilds?: boolean;
	argv?: string[];
	write?: (f: string, t: string) => void;
}) {
	const files: Record<string, string> = { 'wrangler.example.jsonc': template, ...(opts.files ?? {}) };
	const answers = opts.answers ?? {};
	const calls: string[] = [];
	const captured: boolean[] = [];
	const logs: string[] = [];
	const secretFiles: Record<string, string>[] = [];
	let removed = 0;
	let counter = 0;
	const ctx = {
		ci: opts.ci,
		workersBuilds: opts.workersBuilds,
		argv: opts.argv,
		run(step: string[], runOpts?: { capture?: boolean }): Result {
			const text = step.join(' ');
			calls.push(text);
			captured.push(Boolean(runOpts?.capture));
			const key = Object.keys(answers)
				.filter((k) => text === k || text.startsWith(`${k} `))
				.sort((a, b) => b.length - a.length)[0];
			const a = key ? answers[key] : undefined;
			if (!a) return { code: 0, stdout: '' };
			return typeof a === 'function' ? a(step) : a;
		},
		exists: (f: string) => f in files,
		read: (f: string) => files[f],
		write: (f: string, t: string) => {
			opts.write?.(f, t);
			files[f] = t;
		},
		remove: (f: string) => {
			delete files[f];
		},
		randomBytes: (n: number) => {
			counter++;
			return new Uint8Array(n).fill(counter);
		},
		withSecretsFile<T>(secrets: Record<string, string>, fn: (p: string) => T): T {
			secretFiles.push({ ...secrets });
			try {
				return fn('/tmp/fake/secrets.json');
			} finally {
				removed++;
			}
		},
		log: (l: string) => {
			logs.push(l);
		}
	};
	return { ctx, files, calls, captured, logs, secretFiles, removed: () => removed };
}

const json = (v: unknown): Result => ({ code: 0, stdout: JSON.stringify(v) });
const secretList = (names: string[]) => json(names.map((name) => ({ name, type: 'secret_text' })));
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const lines = (...l: string[]) => l.join(NL);
const notFound = (worker: string): Result => ({
	code: 1,
	stderr: lines(`✘ [ERROR] Worker "${worker}" not found.`, '', 'If this is a new Worker, run `wrangler deploy` first to create it.')
});
const createdDb = (name: string, id: string): Result => ({
	code: 0,
	stdout: lines(
		`✅ Successfully created DB '${name}'`,
		'Created your new D1 database.',
		'',
		'{',
		'  "d1_databases": [',
		'    {',
		'      "binding": "DB",',
		`      "database_name": "${name}",`,
		`      "database_id": "${id}"`,
		'    }',
		'  ]',
		'}'
	)
});
const MULTI = {
	code: 1,
	stderr: lines(
		'✘ [ERROR] More than one account available but unable to select one in non-interactive mode.',
		'Please set the appropriate account ID in your wrangler.jsonc file or assign it to the `CLOUDFLARE_ACCOUNT_ID` environment variable.',
		'Available accounts are (`<name>`: `<account_id>`):',
		'  `Example One`: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`',
		'  `Example Two`: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`'
	)
};

/** A first install: nothing on the account yet, the Worker doesn't exist. */
const FRESH_ANSWERS: Record<string, Answer> = {
	'wrangler d1 list --json': json([]),
	'wrangler d1 create': createdDb('howdee-crm', DB_ID),
	'wrangler r2 bucket list': { code: 0, stdout: 'Listing buckets...' },
	'wrangler d1 execute': json([{ results: [{ n: 0 }] }]),
	'wrangler secret list': notFound('howdee-crm'),
	'wrangler deploy': {
		code: 0,
		stdout: lines('Uploaded howdee-crm', 'Deployed howdee-crm triggers', '  https://howdee-crm.someone.workers.dev')
	}
};

describe('deploy mode (#730)', () => {
	it('npm run deploy is the script that runs this plan', () => {
		expect(pkg.scripts.deploy).toBe('node scripts/deploy.mjs');
	});

	it('an existing install runs exactly the pre-#730 commands, interactive, and nothing else', () => {
		const t = fakeContext({ files: { 'wrangler.jsonc': EXISTING } });
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.calls).toEqual(['wrangler d1 migrations apply my-db --remote', 'npm run build', 'wrangler deploy']);
		expect(t.calls).toEqual(deployPlan('my-db').map((s) => s.join(' ')));
		expect(t.captured).toEqual([false, false, false]);
		expect(Object.keys(t.files).sort()).toEqual(['wrangler.example.jsonc', 'wrangler.jsonc']);
		expect(t.files['wrangler.jsonc']).toBe(EXISTING);
		expect(t.secretFiles).toEqual([]);
		expect(t.logs).toEqual([
			'Deploy mode: classic (wrangler.jsonc has a D1 database_id). Migrations, build, upload; nothing else is checked or changed.'
		]);
	});

	it('classic mode stops at the first failing step with its exit code', () => {
		const t = fakeContext({ files: { 'wrangler.jsonc': EXISTING }, answers: { 'wrangler d1 migrations apply': { code: 2 } } });
		expect(runDeploy(t.ctx)).toBe(2);
		expect(t.calls).toEqual(['wrangler d1 migrations apply my-db --remote']);
	});

	it('a finished first install deploys classic from then on', () => {
		const t = fakeContext({ files: { 'wrangler.jsonc': INSTALLED } });
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.calls).toEqual(['wrangler d1 migrations apply howdee-crm --remote', 'npm run build', 'wrangler deploy']);
	});

	it('picks install mode for a written config, a missing or all-zero id, a marker, --setup or --new-setup-token', () => {
		const flags = parseArgs([]).flags;
		const base = { configExisted: true, databaseId: DB_ID, markerExists: false, flags };
		expect(chooseMode(base).mode).toBe('classic');
		expect(chooseMode({ ...base, configExisted: false }).mode).toBe('install');
		expect(chooseMode({ ...base, databaseId: null }).mode).toBe('install');
		expect(chooseMode({ ...base, databaseId: ZERO_ID }).mode).toBe('install');
		expect(chooseMode({ ...base, markerExists: true }).mode).toBe('install');
		expect(chooseMode({ ...base, flags: parseArgs(['--setup']).flags }).mode).toBe('install');
		expect(chooseMode({ ...base, flags: parseArgs(['--new-setup-token']).flags }).mode).toBe('install');
		expect(chooseMode({ ...base, flags: parseArgs(['--adopt-database']).flags }).mode).toBe('classic');
	});

	it('an unknown option stops before anything runs', () => {
		const t = fakeContext({ files: { 'wrangler.jsonc': EXISTING }, argv: ['--force'] });
		expect(runDeploy(t.ctx)).toBe(1);
		expect(t.calls).toEqual([]);
		expect(t.logs[0]).toMatch(/Unknown option "--force"/);
	});

	it('a pending-install marker resumes in install mode even though the id is in the config', () => {
		const marker = JSON.stringify({ database: 'howdee-crm', bucket: 'howdee-crm-media', createdDatabase: 'howdee-crm', steps: ['database'] });
		const t = fakeContext({
			files: { 'wrangler.jsonc': INSTALLED, [MARKER_FILE]: marker },
			answers: {
				'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'howdee-crm' }]),
				'wrangler r2 bucket list': { code: 0, stdout: 'name: howdee-crm-media' },
				'wrangler d1 execute': json([{ results: [{ n: 0 }] }]),
				'wrangler secret list': notFound('howdee-crm')
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.logs[0]).toMatch(/^Deploy mode: install \(an earlier install run didn't finish/);
		expect(t.calls[0]).toBe('wrangler d1 list --json');
		expect(t.calls).toContain('wrangler d1 migrations apply howdee-crm --remote');
		expect(t.secretFiles).toHaveLength(1);
		// Finished: the marker is gone, so the next run is classic.
		expect(MARKER_FILE in t.files).toBe(false);
	});

	it('--setup on an existing install runs install mode but leaves no marker and changes no id', () => {
		const t = fakeContext({
			argv: ['--setup'],
			files: { 'wrangler.jsonc': EXISTING },
			answers: {
				'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'my-db' }]),
				'wrangler r2 bucket list': { code: 0, stdout: lines('name:           my-media', 'creation_date:  2026-01-01') },
				'wrangler d1 execute': json([{ results: [{ n: 2 }] }]),
				'wrangler secret list': secretList(ALL_SECRETS)
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.logs[0]).toBe('Deploy mode: install (--setup was passed).');
		expect(t.files['wrangler.jsonc']).toBe(EXISTING);
		expect(MARKER_FILE in t.files).toBe(false);
		expect(t.calls.some((c) => c.includes(' create '))).toBe(false);
		expect(t.calls.filter((c) => c.startsWith('wrangler deploy'))).toEqual(['wrangler deploy']);
		expect(t.logs).toContain('Secrets: nothing to set.');
		expect(t.logs.at(-1)).toBe('Done. The app is at https://crm.example.com/x.');
	});
});

describe('install mode (#730)', () => {
	it('a fresh terminal install: writes the config, creates database and bucket, sets secrets, prints the link first', () => {
		const t = fakeContext({ answers: FRESH_ANSWERS });
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.logs[0]).toBe('Wrote wrangler.jsonc from wrangler.example.jsonc.');
		expect(t.logs[1]).toBe('Deploy mode: install (wrangler.jsonc was just written from wrangler.example.jsonc).');
		expect(t.calls).toContain('wrangler d1 create howdee-crm');
		expect(t.calls).toContain('wrangler r2 bucket create howdee-crm-media');
		// The id came from the create output: the list ran once.
		expect(t.calls.filter((c) => c === 'wrangler d1 list --json')).toHaveLength(1);
		expect(readConfig(t.files['wrangler.jsonc'])).toEqual({
			name: 'howdee-crm',
			database: { name: 'howdee-crm', id: DB_ID },
			bucket: 'howdee-crm-media',
			publicBaseUrl: 'https://howdee-crm.someone.workers.dev'
		});
		expect(t.calls.filter((c) => c.startsWith('wrangler deploy'))).toEqual([
			'wrangler deploy --secrets-file /tmp/fake/secrets.json',
			'wrangler deploy'
		]);
		expect(t.removed()).toBe(1);
		const sent = t.secretFiles[0];
		expect(Object.keys(sent).sort()).toEqual([...GENERATED_SECRETS.map((s) => s.name), 'SETUP_TOKEN'].sort());
		const link = `Open https://howdee-crm.someone.workers.dev/setup#token=${sent.SETUP_TOKEN} to create the first admin.`;
		// The link is out before the address step and the second upload.
		expect(t.logs.indexOf(link)).toBeGreaterThan(-1);
		expect(t.logs.indexOf(link)).toBeLessThan(t.logs.findIndex((l) => l.startsWith('Set PUBLIC_BASE_URL')));
		expect(t.logs.at(-1)).toMatch(/^Done\. Open the setup link above.*npm run deploy -- --new-setup-token/);
		// Only the setup link carries a value; nothing else is ever logged or passed on a command line.
		const allLogs = t.logs.join(NL);
		const allCalls = t.calls.join(NL);
		for (const [name, value] of Object.entries(sent)) {
			expect(allCalls).not.toContain(value);
			if (name !== 'SETUP_TOKEN') expect(allLogs).not.toContain(value);
		}
		expect(t.logs).toContain('Created database howdee-crm.');
		expect(t.logs).toContain('Created bucket howdee-crm-media.');
		expect(t.logs).toContain(`Set 6 secrets: ${Object.keys(sent).join(', ')}.`);
		expect(MARKER_FILE in t.files).toBe(false);
	});

	it('every captured wrangler command is captured; migrations and build stay interactive', () => {
		const t = fakeContext({ answers: FRESH_ANSWERS });
		runDeploy(t.ctx);
		t.calls.forEach((c, i) => {
			const interactive = c.startsWith('wrangler d1 migrations apply') || c === 'npm run build';
			expect(t.captured[i]).toBe(!interactive);
		});
	});

	it('falls back to the list when the create output has no id', () => {
		let listed = 0;
		const t = fakeContext({
			answers: {
				...FRESH_ANSWERS,
				'wrangler d1 list --json': () => (listed++ === 0 ? json([]) : json([{ uuid: DB_ID, name: 'howdee-crm' }])),
				'wrangler d1 create': { code: 0, stdout: 'Created your new D1 database.' }
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(listed).toBe(2);
		expect(readConfig(t.files['wrangler.jsonc']).database.id).toBe(DB_ID);
	});

	it('a failed migration builds and uploads nothing and keeps the marker', () => {
		const t = fakeContext({ answers: { ...FRESH_ANSWERS, 'wrangler d1 migrations apply': { code: 2 } } });
		expect(runDeploy(t.ctx)).toBe(2);
		expect(t.calls.at(-1)).toBe('wrangler d1 migrations apply howdee-crm --remote');
		expect(t.calls.some((c) => c === 'npm run build' || c.startsWith('wrangler deploy'))).toBe(false);
		expect(t.secretFiles).toEqual([]);
		const marker = JSON.parse(t.files[MARKER_FILE]);
		expect(marker).toEqual({
			database: 'howdee-crm',
			bucket: 'howdee-crm-media',
			createdDatabase: 'howdee-crm',
			createdBucket: 'howdee-crm-media',
			steps: ['database', 'bucket']
		});
		expect(t.files[MARKER_FILE]).not.toMatch(/token|secret/i);
	});

	it('the setup link survives a failed address upload: it warns, keeps the marker, exits 0', () => {
		let uploads = 0;
		const t = fakeContext({
			answers: {
				...FRESH_ANSWERS,
				'wrangler deploy': () =>
					uploads++ === 0
						? { code: 0, stdout: '  https://howdee-crm.someone.workers.dev' }
						: { code: 1, stderr: 'upload failed' }
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		const token = t.secretFiles[0].SETUP_TOKEN;
		expect(t.logs.some((l) => l.includes(`/setup#token=${token}`))).toBe(true);
		expect(t.logs.some((l) => l.startsWith('Warning: the app is live'))).toBe(true);
		expect(MARKER_FILE in t.files).toBe(true);
	});

	it('an exception after the upload never hides the setup link', () => {
		const t = fakeContext({
			answers: FRESH_ANSWERS,
			write: (f, text) => {
				if (f === 'wrangler.jsonc' && text.includes('https://howdee-crm.someone.workers.dev')) throw new Error('disk full');
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		const token = t.secretFiles[0].SETUP_TOKEN;
		const linkAt = t.logs.findIndex((l) => l.includes(`/setup#token=${token}`));
		expect(linkAt).toBeGreaterThan(-1);
		expect(t.logs.findIndex((l) => l.includes('disk full'))).toBeGreaterThan(linkAt);
		expect(MARKER_FILE in t.files).toBe(true);
	});

	it('a second run of that install creates nothing and says both ways to the setup page', () => {
		const t = fakeContext({
			argv: ['--setup'],
			files: { 'wrangler.jsonc': INSTALLED },
			answers: {
				'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'howdee-crm' }]),
				'wrangler r2 bucket list': { code: 0, stdout: 'name: howdee-crm-media' },
				'wrangler d1 execute': json([{ results: [{ n: 0 }] }]),
				'wrangler secret list': secretList(ALL_SECRETS)
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.files['wrangler.jsonc']).toBe(INSTALLED);
		expect(t.calls.some((c) => c.includes(' create '))).toBe(false);
		expect(t.secretFiles).toEqual([]);
		expect(t.logs.at(-1)).toBe(
			'No admin exists yet. Open https://howdee-crm.someone.workers.dev/setup and either use the phrase you chose for SETUP_TOKEN, or run `npm run deploy -- --new-setup-token` to get a fresh setup link.'
		);
	});

	it('--new-setup-token replaces SETUP_TOKEN while no user exists and prints the link', () => {
		const t = fakeContext({
			argv: ['--new-setup-token'],
			files: { 'wrangler.jsonc': INSTALLED },
			answers: {
				'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'howdee-crm' }]),
				'wrangler r2 bucket list': { code: 0, stdout: 'name: howdee-crm-media' },
				'wrangler d1 execute': json([{ results: [{ n: 0 }] }]),
				'wrangler secret list': secretList(ALL_SECRETS)
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(t.secretFiles).toHaveLength(1);
		expect(Object.keys(t.secretFiles[0])).toEqual(['SETUP_TOKEN']);
		expect(t.logs).toContain(`Open https://howdee-crm.someone.workers.dev/setup#token=${t.secretFiles[0].SETUP_TOKEN} to create the first admin.`);
		expect(MARKER_FILE in t.files).toBe(false);
	});

	it('--new-setup-token refuses once a user exists, when users are unknown, and in CI', () => {
		const answers = {
			'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'howdee-crm' }]),
			'wrangler r2 bucket list': { code: 0, stdout: 'name: howdee-crm-media' },
			'wrangler secret list': secretList(ALL_SECRETS)
		};
		const withUser = fakeContext({ argv: ['--new-setup-token'], files: { 'wrangler.jsonc': INSTALLED }, answers: { ...answers, 'wrangler d1 execute': json([{ results: [{ n: 1 }] }]) } });
		expect(runDeploy(withUser.ctx)).toBe(1);
		expect(withUser.logs.at(-1)).toMatch(/An admin already exists/);
		expect(withUser.calls.some((c) => c === 'npm run build' || c.startsWith('wrangler deploy'))).toBe(false);
		expect(withUser.secretFiles).toEqual([]);

		const unknown = fakeContext({ argv: ['--new-setup-token'], files: { 'wrangler.jsonc': INSTALLED }, answers: { ...answers, 'wrangler d1 execute': { code: 1, stderr: 'x' } } });
		expect(runDeploy(unknown.ctx)).toBe(1);
		expect(unknown.secretFiles).toEqual([]);

		const ci = fakeContext({ ci: true, argv: ['--new-setup-token'], files: { 'wrangler.jsonc': INSTALLED }, answers });
		expect(runDeploy(ci.ctx)).toBe(1);
		expect(ci.calls).toEqual([]);
	});

	it("a user count that can't be read on a fresh install says to open /setup", () => {
		const t = fakeContext({ answers: { ...FRESH_ANSWERS, 'wrangler d1 execute': { code: 1, stderr: 'boom' } } });
		expect(runDeploy(t.ctx)).toBe(0);
		expect(Object.keys(t.secretFiles[0])).not.toContain('SETUP_TOKEN');
		expect(t.logs.at(-1)).toMatch(/^Couldn't read the number of users\. Open https:\/\/howdee-crm\.someone\.workers\.dev\/setup/);
	});

	it('never generates SETUP_TOKEN once a user exists, when users are unknown, or in CI', () => {
		const zeros = (n: number) => new Uint8Array(n);
		expect(planSecrets([], { users: 1 }, zeros).setupToken).toBeNull();
		expect(planSecrets([], { users: null }, zeros).setupToken).toBeNull();
		expect(planSecrets([], { users: 0, ci: true }, zeros).setupToken).toBeNull();
		expect(planSecrets(['SETUP_TOKEN'], { users: 0 }, zeros).setupToken).toBeNull();
		expect(planSecrets([], { users: 0 }, zeros).setupToken).not.toBeNull();
		// The one replacement: SETUP_TOKEN with --new-setup-token, only with no user and not in CI.
		expect(planSecrets(['SETUP_TOKEN'], { users: 0, newSetupToken: true }, zeros).setupToken).not.toBeNull();
		expect(planSecrets(['SETUP_TOKEN'], { users: 1, newSetupToken: true }, zeros).setupToken).toBeNull();
		expect(planSecrets(['SETUP_TOKEN'], { users: 0, ci: true, newSetupToken: true }, zeros).setupToken).toBeNull();
		expect(Object.keys(planSecrets(ALL_SECRETS, { users: 0, newSetupToken: true }, zeros).secrets)).toEqual(['SETUP_TOKEN']);
	});

	it('never replaces a secret that is set', () => {
		const { secrets } = planSecrets(['SESSION_SECRET', 'MAIL_TOKEN_KEY'], { users: 3 }, (n) => new Uint8Array(n).fill(7));
		expect(Object.keys(secrets)).toEqual(['WEBHOOK_KEY', 'CRON_KEY', 'INGEST_KEY']);
		expect(secrets.WEBHOOK_KEY).toBe('07'.repeat(32));
	});

	it('secret values have the documented encodings and lengths', () => {
		let i = 0;
		const { secrets } = planSecrets([], { users: 0 }, (n) => new Uint8Array(n).map(() => (i++ * 37) & 255));
		expect(secrets.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(secrets.MAIL_TOKEN_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(secrets.SETUP_TOKEN).toMatch(/^[A-Za-z0-9_-]{32}$/);
		for (const k of ['WEBHOOK_KEY', 'CRON_KEY', 'INGEST_KEY']) expect(secrets[k]).toMatch(/^[0-9a-f]{64}$/);
		expect(new Set(Object.values(secrets)).size).toBe(Object.keys(secrets).length);
		expect(toHex(new Uint8Array([0, 255]))).toBe('00ff');
		expect(toBase64url(new Uint8Array([251, 255]))).toBe('-_8');
	});

	it('in CI with no users and no SETUP_TOKEN, says how to set it instead of printing a token', () => {
		const t = fakeContext({
			ci: true,
			argv: ['--setup'],
			files: { 'wrangler.jsonc': EXISTING },
			answers: {
				'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'my-db' }]),
				'wrangler r2 bucket list': { code: 0, stdout: 'name: my-media' },
				'wrangler d1 execute': json([{ results: [{ n: 0 }] }]),
				'wrangler secret list': secretList(['SESSION_SECRET'])
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(Object.keys(t.secretFiles[0])).not.toContain('SETUP_TOKEN');
		expect(t.logs.at(-1)).toBe(
			"No admin exists and SETUP_TOKEN isn't set. Set it with `npx wrangler secret put SETUP_TOKEN`, then open https://crm.example.com/x/setup."
		);
	});

	it('in Workers Builds with no users and no SETUP_TOKEN, points at the Deploy page phrase and the dashboard', () => {
		const t = fakeContext({
			ci: true,
			workersBuilds: true,
			argv: ['--setup'],
			files: { 'wrangler.jsonc': EXISTING },
			answers: {
				'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'my-db' }]),
				'wrangler r2 bucket list': { code: 0, stdout: 'name: my-media' },
				'wrangler d1 execute': json([{ results: [{ n: 0 }] }]),
				'wrangler secret list': secretList(['SESSION_SECRET'])
			}
		});
		expect(runDeploy(t.ctx)).toBe(0);
		expect(Object.keys(t.secretFiles[0])).not.toContain('SETUP_TOKEN');
		expect(t.logs.at(-1)).toBe(
			'No admin exists yet. Open https://crm.example.com/x/setup: the phrase you typed on the Deploy page is the setup token, and /setup asks for it. If /setup says the token is not set, add a secret named SETUP_TOKEN to this Worker in the Cloudflare dashboard (Workers & Pages, the Worker, Settings), then open /setup again.'
		);
		expect(t.logs.join(NL)).not.toContain('wrangler secret put');
	});
});

describe('install mode stops (#730)', () => {
	it('a real database id that is not on the account stops; nothing is created or overwritten', () => {
		const config = setDatabaseId(configFromTemplate(template), DB_ID);
		const t = fakeContext({
			argv: ['--setup'],
			files: { 'wrangler.jsonc': config },
			answers: { 'wrangler d1 list --json': json([{ uuid: OTHER_ID, name: 'howdee-crm' }]) }
		});
		expect(runDeploy(t.ctx)).toBe(1);
		expect(t.logs.at(-1)).toBe(
			'Database "howdee-crm" in wrangler.jsonc: this database id is not on the logged-in Cloudflare account; check `wrangler whoami` or CLOUDFLARE_ACCOUNT_ID.'
		);
		expect(t.calls).toEqual(['wrangler d1 list --json']);
		expect(t.files['wrangler.jsonc']).toBe(config);
	});

	it('the database plan: keep, create, adopt only in Workers Builds / with the flag / when this install made it, else stop', () => {
		const other = { uuid: OTHER_ID, name: 'howdee-crm' };
		expect(planDatabase({ name: 'howdee-crm', id: DB_ID }, [{ uuid: DB_ID, name: 'howdee-crm' }])).toEqual({ action: 'keep' });
		expect(planDatabase({ name: 'howdee-crm', id: null }, [])).toEqual({ action: 'create' });
		expect(planDatabase({ name: 'howdee-crm', id: ZERO_ID }, [])).toEqual({ action: 'create' });
		expect(planDatabase({ name: 'howdee-crm', id: null }, [other]).action).toBe('stop');
		expect(planDatabase({ name: 'howdee-crm', id: null }, [other], { workersBuilds: true })).toMatchObject({ action: 'adopt', id: OTHER_ID });
		expect(planDatabase({ name: 'howdee-crm', id: null }, [other], { adoptDatabase: true })).toMatchObject({ action: 'adopt', id: OTHER_ID });
		expect(planDatabase({ name: 'howdee-crm', id: null }, [other], { createdByThisInstall: true })).toMatchObject({ action: 'adopt', id: OTHER_ID });
		// A real id that isn't on the account: never a replacement, whatever the names say.
		expect(planDatabase({ name: 'howdee-crm', id: DB_ID }, [other]).action).toBe('stop');
		expect(planDatabase({ name: 'howdee-crm', id: DB_ID }, []).action).toBe('stop');
		expect(planDatabase({ name: 'howdee-crm', id: DB_ID }, [], { workersBuilds: true, adoptDatabase: true }).action).toBe('stop');
	});

	it('outside Workers Builds (a bare CI=1 too) a same-named database stops and names the flag', () => {
		for (const ci of [false, true]) {
			const t = fakeContext({ ci, answers: { 'wrangler d1 list --json': json([{ uuid: DB_ID, name: 'howdee-crm' }]) } });
			expect(runDeploy(t.ctx)).toBe(1);
			expect(t.logs.at(-1)).toMatch(/A database named "howdee-crm" already exists.*--adopt-database/);
			expect(t.calls).toEqual(['wrangler d1 list --json']);
		}
	});

	it('in Workers Builds, or with --adopt-database, the same-named database is used and its id written', () => {
		for (const opts of [{ ci: true, workersBuilds: true }, { argv: ['--adopt-database'] }]) {
			const t = fakeContext({
				...opts,
				answers: {
					'wrangler d1 list --json': json([{ uuid: OTHER_ID, name: 'howdee-crm' }]),
					'wrangler r2 bucket list': { code: 0, stdout: 'name: howdee-crm-media' },
					'wrangler secret list': secretList(ALL_SECRETS)
				}
			});
			expect(runDeploy(t.ctx)).toBe(0);
			expect(t.calls.some((c) => c.includes(' create '))).toBe(false);
			expect(readConfig(t.files['wrangler.jsonc']).database.id).toBe(OTHER_ID);
		}
	});

	it('a new install never takes over a bucket that already exists, and creates nothing', () => {
		const t = fakeContext({
			answers: {
				'wrangler d1 list --json': json([]),
				'wrangler r2 bucket list': { code: 0, stdout: `${ESC}[2mname:${ESC}[0m howdee-crm-media` }
			}
		});
		expect(runDeploy(t.ctx)).toBe(1);
		expect(t.logs.at(-1)).toMatch(/A bucket named "howdee-crm-media" already exists.*Change bucket_name/);
		expect(t.calls).toEqual(['wrangler d1 list --json', 'wrangler r2 bucket list']);
	});

	it('a bucket create that says "already exists" stops; it is never taken as found', () => {
		const t = fakeContext({
			answers: {
				...FRESH_ANSWERS,
				'wrangler r2 bucket create': { code: 1, stderr: 'The bucket you tried to create already exists, and you own it. [code: 10004]' }
			}
		});
		expect(runDeploy(t.ctx)).toBe(1);
		expect(t.logs.at(-1)).toMatch(/Couldn't create bucket "howdee-crm-media": the name is taken or wasn't in the bucket list\. Pick another bucket_name/);
		expect(t.calls).not.toContain('wrangler d1 migrations apply howdee-crm --remote');
		expect(t.logs).not.toContain('Bucket howdee-crm-media found.');
	});

	it('more than one account: one line naming CLOUDFLARE_ACCOUNT_ID, and no account is listed', () => {
		const t = fakeContext({ answers: { 'wrangler d1 list --json': MULTI } });
		expect(runDeploy(t.ctx)).toBe(1);
		expect(t.logs.at(-1)).toMatch(/more than one account.*CLOUDFLARE_ACCOUNT_ID/);
		const all = t.logs.join(NL);
		expect(all).not.toMatch(/Example One|aaaaaaaa|bbbbbbbb/);
		expect(multiAccountLine({ code: 1, stderr: 'boom' })).toBeNull();
	});

	it('stops with one line naming the permission when the Cloudflare API refuses a command', () => {
		const refused = { code: 1, stderr: 'A request to the Cloudflare API (/accounts/x/d1/database) failed. Authentication error [code: 10000]' };
		const t = fakeContext({ ci: true, answers: { 'wrangler d1 list --json': refused } });
		expect(runDeploy(t.ctx)).toBe(1);
		expect(t.logs.at(-1)).toBe('Cloudflare refused "wrangler d1 list --json": the API token needs the "Account · D1 · Edit" permission.');
		expect(t.calls).toEqual(['wrangler d1 list --json']);

		expect(refusalLine(['wrangler', 'r2', 'bucket', 'list'], refused)).toMatch(/Workers R2 Storage · Edit/);
		expect(refusalLine(['wrangler', 'secret', 'list'], refused)).toMatch(/Workers Scripts · Edit/);
		expect(refusalLine(['wrangler', 'deploy'], refused)).toMatch(/Workers Scripts · Edit/);
		expect(refusalLine(['wrangler', 'deploy'], { code: 1, stderr: 'A request to the Cloudflare API (/x) failed. 403 Forbidden' })).toMatch(/Workers Scripts/);
		expect(refusalLine(['wrangler', 'deploy'], { code: 1, stderr: 'You are not logged in.' })).toMatch(/wrangler login/);
		expect(refusalLine(['wrangler', 'deploy'], { code: 1, stderr: 'Build failed' })).toBeNull();
		// A local file error is not a Cloudflare permission refusal.
		expect(refusalLine(['wrangler', 'deploy'], { code: 1, stderr: "EACCES: permission denied, open '/x/.wrangler/tmp'" })).toBeNull();
		expect(refusalLine(['wrangler', 'deploy'], { code: 1, stderr: 'Error: permission denied' })).toBeNull();
	});

	it('secret list: only wrangler\'s "Worker … not found" means a new Worker; anything else stops', () => {
		expect(isWorkerNotFound(notFound('howdee-crm'), 'howdee-crm')).toBe(true);
		expect(isWorkerNotFound({ code: 1, stderr: 'Worker "howdee-crm" (env: prod) not found.' }, 'howdee-crm')).toBe(true);
		expect(isWorkerNotFound(notFound('other'), 'howdee-crm')).toBe(false);
		expect(isWorkerNotFound({ code: 1, stderr: 'Route not found' }, 'howdee-crm')).toBe(false);
		expect(isWorkerNotFound({ code: 1, stderr: 'This Worker does not exist on your account. [code: 10007]' }, 'howdee-crm')).toBe(false);

		for (const stderr of ['Internal server error', 'Authentication error [code: 10000]: Worker "howdee-crm" not found.', 'Worker "other" not found.']) {
			const t = fakeContext({ answers: { ...FRESH_ANSWERS, 'wrangler secret list': { code: 1, stderr } } });
			expect(runDeploy(t.ctx)).toBe(1);
			expect(t.calls).not.toContain('npm run build');
			expect(t.secretFiles).toEqual([]);
		}
	});

	it('never overwrites an existing wrangler.jsonc', () => {
		const t = fakeContext({ argv: ['--setup'], files: { 'wrangler.jsonc': EXISTING }, answers: { 'wrangler d1 list --json': { code: 1, stderr: 'x' } } });
		runDeploy(t.ctx);
		expect(t.files['wrangler.jsonc']).toBe(EXISTING);
		expect(t.logs.some((l) => l.startsWith('Wrote wrangler.jsonc'))).toBe(false);
	});
});

describe('wrangler output parsing (#730)', () => {
	it('reads databases, buckets, secret names, the user count and the Worker URL', () => {
		expect(parseDatabases('[{"uuid":"a","name":"x","created_at":"2026"}]')).toEqual([{ uuid: 'a', name: 'x' }]);
		expect(parseDatabases('not json')).toBeNull();
		expect(parseBuckets(lines('Listing buckets...', 'name:           a-b', 'creation_date:  2026', '', 'name: c'))).toEqual(['a-b', 'c']);
		expect(parseSecretNames('[{"name":"A","type":"secret_text"}]')).toEqual(['A']);
		expect(parseUserCount('[{"results":[{"n":0}],"success":true}]')).toBe(0);
		expect(parseUserCount('[{"results":[]}]')).toBeNull();
		expect(parseWorkerUrl(lines('Deployed x', '  https://x.sub-1.workers.dev', '  schedule: * * * * *'))).toBe(
			'https://x.sub-1.workers.dev'
		);
		expect(parseWorkerUrl('no url')).toBeNull();
		expect(parseCreatedDatabaseId(createdDb('x', DB_ID).stdout)).toBe(DB_ID);
		expect(parseCreatedDatabaseId('Created your new D1 database.')).toBeNull();
	});

	it('strips ANSI colour before parsing', () => {
		expect(stripAnsi(`${ESC}[32mok${ESC}[0m`)).toBe('ok');
		expect(parseBuckets(`${ESC}[2mname:${ESC}[22m           ${ESC}[1ma-b${ESC}[0m`)).toEqual(['a-b']);
		expect(parseWorkerUrl(`${ESC}[36mhttps://x.sub.workers.dev${ESC}[39m`)).toBe('https://x.sub.workers.dev');
		expect(parseSecretNames(`${ESC}[2m[{"name":"A"}]${ESC}[0m`)).toEqual(['A']);
	});
});

describe('config from the template (#730)', () => {
	it('has default names, no database id, no public URL, and parses as JSONC', () => {
		const text = configFromTemplate(template);
		expect(readConfig(text)).toEqual({
			name: DEFAULT_NAMES.worker,
			database: { name: DEFAULT_NAMES.database, id: null },
			bucket: DEFAULT_NAMES.bucket,
			publicBaseUrl: ''
		});
		expect(text).not.toMatch(/your-crm-worker|your-database-name|your-media-bucket|Copy to wrangler\.jsonc/);
		const parsed = JSON.parse(stripJsonc(text));
		const original = JSON.parse(stripJsonc(template));
		// No database_id key in the parsed value (the file's comments may mention the word).
		const db = parsed.d1_databases.find((d: { binding: string }) => d.binding === 'DB');
		expect(db.database_id ?? '').toBe('');
		expect(readDatabaseBinding(text)).toEqual({ name: DEFAULT_NAMES.database, id: null });
		expect(parsed.vars.WORKER_NAME).toBe(DEFAULT_NAMES.worker);
		expect(parsed.triggers).toEqual(original.triggers);
		expect(Object.keys(parsed.vars)).toEqual(Object.keys(original.vars));
		expect(Object.keys(parsed)).toEqual(Object.keys(original));
	});

	it('writes and replaces the database id and vars', () => {
		const withId = setDatabaseId(configFromTemplate(template), DB_ID);
		expect(readConfig(withId).database.id).toBe(DB_ID);
		expect(readConfig(setDatabaseId(withId, OTHER_ID)).database.id).toBe(OTHER_ID);
		expect(readConfig(setVar(withId, 'PUBLIC_BASE_URL', 'https://a.workers.dev')).publicBaseUrl).toBe('https://a.workers.dev');
		expect(setDatabaseId(EXISTING, DB_ID)).toBe(EXISTING);
	});

	it('setVar adds a missing key (and a missing "vars" block) instead of throwing', () => {
		const noKey = EXISTING.replace(/\n\t\t"PUBLIC_BASE_URL": "[^"]*",/, '');
		expect(readConfig(noKey).publicBaseUrl).toBe('');
		const added = setVar(noKey, 'PUBLIC_BASE_URL', 'https://a.workers.dev');
		expect(readConfig(added).publicBaseUrl).toBe('https://a.workers.dev');
		expect(JSON.parse(stripJsonc(added)).vars.WORKER_NAME).toBe('my-crm');

		const emptyVars = EXISTING.replace(/"vars": \{[\s\S]*?\}/, '"vars": {}');
		expect(readConfig(setVar(emptyVars, 'PUBLIC_BASE_URL', 'https://b.workers.dev')).publicBaseUrl).toBe('https://b.workers.dev');

		const noVars = EXISTING.replace(/,\n\t"vars": \{[\s\S]*?\}/, '');
		expect(JSON.parse(stripJsonc(noVars)).vars).toBeUndefined();
		const withVars = setVar(noVars, 'PUBLIC_BASE_URL', 'https://c.workers.dev');
		expect(readConfig(withVars).publicBaseUrl).toBe('https://c.workers.dev');
		expect(readConfig(withVars).name).toBe('my-crm');
	});

	it('knows placeholders: only missing, empty or all-zero ids', () => {
		expect(isPlaceholderDatabaseId(null)).toBe(true);
		expect(isPlaceholderDatabaseId('')).toBe(true);
		expect(isPlaceholderDatabaseId(ZERO_ID)).toBe(true);
		expect(isPlaceholderDatabaseId(DB_ID)).toBe(false);
		expect(isPlaceholderDatabaseId('your-database-id')).toBe(false);
		expect(needsPublicUrl('')).toBe(true);
		expect(needsPublicUrl('https://crm.example.com/')).toBe(true);
		expect(needsPublicUrl('https://crm.example.com/x')).toBe(false);
	});

	it('reads the DB binding leniently for the mode check', () => {
		expect(readDatabaseBinding(EXISTING)).toEqual({ name: 'my-db', id: DB_ID });
		expect(readDatabaseBinding('{ "d1_databases": [{ "binding": "DB", "database_name": "x" }] }')).toEqual({ name: 'x', id: null });
		// Not valid JSONC: the old text search still finds it.
		expect(readDatabaseBinding(`{ "binding": "DB", "database_name": "x", "database_id": "${DB_ID}" ,, }`)).toEqual({ name: 'x', id: DB_ID });
	});

	it('strips comments but keeps strings with slashes', () => {
		expect(JSON.parse(stripJsonc('{ // c\n "a": "http://x//y", /* b */ "c": [1,], }'))).toEqual({ a: 'http://x//y', c: [1] });
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

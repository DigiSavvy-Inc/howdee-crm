// #610: the README and the self-hosting guide are written for someone installing the app for
// the first time. They name no host, address or account of ours, no internal process, and they
// stay in step with the config templates: every required secret and every app var has a mention.
import { describe, it, expect } from 'vitest';
import readme from '../README.md?raw';
import guide from '../docs/self-hosting.md?raw';
import heartbeatReadme from '../heartbeat/README.md?raw';
import devVarsReference from '../.dev.vars.reference?raw';
import exampleApp from '../wrangler.example.jsonc?raw';

const docs: [string, string][] = [
	['README.md', readme],
	['docs/self-hosting.md', guide],
	['heartbeat/README.md', heartbeatReadme]
];

/** Account and database ids, and the old seeded login. */
const FORBIDDEN: [string, RegExp][] = [
	['a Cloudflare account id or D1 id', /\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/],
	['the old seeded login', /seeded admin/]
];

/** Names in .dev.vars.reference whose comment starts "# Required". */
function requiredSecrets(src: string): string[] {
	const out: string[] = [];
	let required = false;
	for (const line of src.split('\n')) {
		if (line.startsWith('# Required')) required = true;
		else if (line.startsWith('#')) {
			if (!/^# [A-Z_]+=/.test(line)) continue;
		} else {
			const m = /^([A-Z_]+)=/.exec(line);
			if (m && required) out.push(m[1]);
			if (m || line.trim() === '') required = false;
		}
	}
	return out;
}

/** The var names under "vars" in the app template. */
function templateVars(src: string): string[] {
	const vars = src.slice(src.indexOf('"vars"'));
	return [...vars.matchAll(/^\s*"([A-Z_]+)":/gm)].map((m) => m[1]);
}

describe('README and self-hosting guide (#610)', () => {
	it('name nothing of ours', () => {
		for (const [name, text] of docs) {
			for (const [what, re] of FORBIDDEN) {
				const hit = re.exec(text);
				expect(hit, `${name} mentions ${what}: "${hit?.[0]}"`).toBeNull();
			}
		}
	});

	it('the README points at the guide, the licence and the deploy command', () => {
		expect(readme).toContain('](docs/self-hosting.md)');
		expect(readme).toContain('[LICENSE](LICENSE)');
		expect(readme).toContain('npm run deploy');
		expect(readme).not.toMatch(/SEO[ ]Snapshot/i);
	});

	it('the guide covers every required secret and every app var', () => {
		const required = requiredSecrets(devVarsReference);
		expect(required).toEqual(expect.arrayContaining(['SESSION_SECRET', 'POSTMARK_TOKEN', 'WEBHOOK_KEY', 'INGEST_KEY']));
		// #729: CRON_KEY is optional now (only the separate heartbeat Worker needs it).
		expect(required).not.toContain('CRON_KEY');
		const names = (text: string) => new Set([...text.matchAll(/\b[A-Z][A-Z_]{3,}\b/g)].map((m) => m[0]));
		const named = names(guide);
		for (const name of required) expect(named.has(name), `guide should name ${name}`).toBe(true);
		for (const name of templateVars(exampleApp)) expect(named.has(name), `guide should name ${name}`).toBe(true);
	});

	// #728: the short install comes first, then first-run pages, Postmark and upgrading; the manual
	// steps (resources, config, secrets, deploy, heartbeat) are the "Install by hand" section at the end.
	it('the guide walks the install in order: install, first admin, Postmark, upgrading, then by hand', () => {
		const order = ['npm run deploy', '/setup', '/api/webhook?key=<WEBHOOK_KEY>', 'Unsubscribe handling', 'git pull', 'Install by hand', 'wrangler d1 create', 'cp wrangler.example.jsonc wrangler.jsonc', 'wrangler secret put SESSION_SECRET', 'npm run deploy', 'cd heartbeat'];
		let last = -1;
		for (const step of order) {
			const at = guide.indexOf(step, last + 1);
			expect(at, `guide should contain "${step}"`).toBeGreaterThan(last);
			last = at;
		}
		expect(guide).toContain('Include raw email content');
		expect(guide).toContain('time-travel restore');
	});
});

// Pure helpers for scripts/dscrm.mjs (#348): argument parsing, the request each command
// makes, and table output. No Node imports, so the tests can load it inside workerd.

export const USAGE = `dscrm — the CRM Data API from the shell

Usage: dscrm <resource> <command> [args] [--table] [--limit N]

  automations list [--status active|paused|draft] [--label L]
  automations get <id>
  automations create <spec.json>          create a DRAFT from an AutomationSpec
  automations update <id> <spec.json>     replace a draft's whole flow (PUT …/spec)
  automations duplicate <id>              copy into a new draft
  contacts search <q>
  campaigns list [--status draft|scheduled|sending|sent]
  campaigns draft <file.md> [--subject S] create a Compose draft (subject = --subject,
                                          else the file's first "# " heading)
  forms list [--status draft|published|archived]
  forms submissions <id> [--since DATE] [--limit N] [--offset N]
                                          accepted submissions, newest first (≤ 200 a page)

Environment: DSCRM_URL (app origin, e.g. https://crm.example.com) and DSCRM_KEY (a Data
API key; drafts need automations:draft / campaigns:draft or read_write).
Output is JSON; --table prints a table. Errors exit 1 with the API's message.
Nothing here sends, schedules, activates or enrolls.`;

const VALUE_FLAGS = new Set(['status', 'label', 'subject', 'limit', 'since', 'offset']);
const BOOL_FLAGS = new Set(['table', 'help']);

/**
 * argv (without node + script) → `{ positional, flags }`. `--x=v` and `--x v` both work;
 * `-h` = `--help`. Throws on an unknown flag or a missing value.
 * @param {string[]} argv
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
 */
export function parseArgs(argv) {
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, string | boolean>} */
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h') {
			flags.help = true;
			continue;
		}
		if (!a.startsWith('--')) {
			positional.push(a);
			continue;
		}
		const eq = a.indexOf('=');
		const name = a.slice(2, eq === -1 ? undefined : eq);
		if (BOOL_FLAGS.has(name)) {
			if (eq !== -1) throw new Error(`--${name} takes no value.`);
			flags[name] = true;
		} else if (VALUE_FLAGS.has(name)) {
			const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
			if (value === undefined || value === '') throw new Error(`--${name} needs a value.`);
			flags[name] = value;
		} else {
			throw new Error(`Unknown option --${name}. See --help.`);
		}
	}
	return { positional, flags };
}

/**
 * @typedef {{ method: string, path: string, body?: unknown, readFile?: string, markdown?: boolean }} Plan
 * `readFile` = a file the CLI must read first: JSON for a spec (becomes the body), markdown
 * for a campaign draft (`markdown: true`; see draftBody).
 */

const positiveId = (/** @type {string | undefined} */ v, /** @type {string} */ what) => {
	if (!v || !/^\d+$/.test(v) || Number(v) <= 0) throw new Error(`${what} must be a positive id.`);
	return Number(v);
};

/** @param {Record<string, string | boolean>} flags @param {string[]} keys */
function query(flags, keys) {
	const q = new URLSearchParams();
	for (const k of keys) if (typeof flags[k] === 'string') q.set(k, /** @type {string} */ (flags[k]));
	const s = q.toString();
	return s ? `?${s}` : '';
}

/**
 * The request a command makes. Throws a usage error for an unknown command or bad args.
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} flags
 * @returns {Plan}
 */
export function planRequest(positional, flags) {
	const [resource, command, a, b] = positional;
	const need = (/** @type {string | undefined} */ v, /** @type {string} */ what) => {
		if (!v) throw new Error(`Missing ${what}. See --help.`);
		return v;
	};
	if (resource === 'automations') {
		switch (command) {
			case 'list':
				return { method: 'GET', path: `/api/v1/automations${query(flags, ['status', 'label'])}` };
			case 'get':
				return { method: 'GET', path: `/api/v1/automations/${positiveId(a, 'id')}` };
			case 'create':
				return { method: 'POST', path: '/api/v1/automations', readFile: need(a, '<spec.json>') };
			case 'update':
				return { method: 'PUT', path: `/api/v1/automations/${positiveId(a, 'id')}/spec`, readFile: need(b, '<spec.json>') };
			case 'duplicate':
				return { method: 'POST', path: `/api/v1/automations/${positiveId(a, 'id')}/duplicate` };
		}
	} else if (resource === 'contacts') {
		if (command === 'search') {
			const q = new URLSearchParams({ q: need(positional.slice(2).join(' ').trim() || undefined, '<q>') });
			if (typeof flags.limit === 'string') q.set('limit', flags.limit);
			return { method: 'GET', path: `/api/v1/contacts?${q}` };
		}
	} else if (resource === 'campaigns') {
		if (command === 'list') return { method: 'GET', path: `/api/v1/campaigns${query(flags, ['status', 'limit'])}` };
		if (command === 'draft') return { method: 'POST', path: '/api/v1/campaigns', readFile: need(a, '<file.md>'), markdown: true };
	} else if (resource === 'forms') {
		// #620: read-only.
		if (command === 'list') return { method: 'GET', path: `/api/v1/forms${query(flags, ['status', 'limit', 'offset'])}` };
		if (command === 'submissions') {
			return { method: 'GET', path: `/api/v1/forms/${positiveId(a, 'id')}/submissions${query(flags, ['since', 'limit', 'offset'])}` };
		}
	}
	throw new Error(`Unknown command: ${positional.join(' ') || '(none)'}. See --help.`);
}

/**
 * A campaign draft body from a markdown file: subject = `subjectFlag`, else the first
 * `# ` heading (removed from the body).
 * @param {string} markdown @param {string | undefined} subjectFlag
 */
export function draftBody(markdown, subjectFlag) {
	if (subjectFlag) return { subject: subjectFlag, body: markdown };
	const m = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown);
	if (!m) throw new Error('No subject: pass --subject or start the file with a "# " heading.');
	const body = (markdown.slice(0, m.index) + markdown.slice(m.index + m[0].length)).replace(/^\s*\n/, '');
	return { subject: m[1], body };
}

/** @param {unknown} v */
function cell(v) {
	if (v === null || v === undefined) return '';
	if (typeof v === 'object') return Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v);
	return String(v);
}

/**
 * A plain-text table of an API `data` value (an array of rows, or one record as key/value).
 * @param {unknown} data
 */
export function formatTable(data) {
	/** @type {string[]} */
	let cols;
	/** @type {string[][]} */
	let rows;
	if (Array.isArray(data)) {
		if (!data.length) return '(no rows)';
		cols = [...new Set(data.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))].filter(
			(c) => !data.some((r) => r && typeof r === 'object' && r[c] && typeof r[c] === 'object' && !Array.isArray(r[c]))
		);
		rows = data.map((r) => cols.map((c) => cell(r?.[c])));
	} else if (data && typeof data === 'object') {
		cols = ['field', 'value'];
		rows = Object.entries(data).map(([k, v]) => [k, cell(v)]);
	} else {
		return cell(data);
	}
	const clip = (/** @type {string} */ s) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
	rows = rows.map((r) => r.map(clip));
	const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
	const line = (/** @type {string[]} */ r) => r.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
	return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/**
 * The message for a failed response body (`{ error, problems? }`).
 * @param {number} status @param {unknown} body
 */
export function errorMessage(status, body) {
	const b = /** @type {{ error?: unknown, problems?: { path?: string, message?: string }[] } | null} */ (
		body && typeof body === 'object' ? body : null
	);
	let msg = typeof b?.error === 'string' ? b.error : `HTTP ${status}`;
	if (Array.isArray(b?.problems)) msg += b.problems.map((p) => `\n  ${p.path ?? ''}: ${p.message ?? ''}`).join('');
	return `Error ${status}: ${msg}`;
}

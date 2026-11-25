/**
 * #730: read and write wrangler.jsonc as text, so the comments survive. Pure (no node imports):
 * scripts/deploy.mjs and the public export use it, and the unit tests run it in workerd.
 *
 * `configFromTemplate` turns wrangler.example.jsonc into a ready-to-use wrangler.jsonc: default
 * names, no database id (`npm run deploy` creates the database and writes the id), no public URL
 * (the deploy fills in the Worker's workers.dev address).
 */

/** Names a new install gets. A database name already used on the account stops the deploy unless adopted (see deploy-plan.mjs). */
export const DEFAULT_NAMES = Object.freeze({
	worker: 'howdee-crm',
	database: 'howdee-crm',
	bucket: 'howdee-crm-media'
});

/** The template's stand-in public URL. */
export const TEMPLATE_PUBLIC_URL = 'https://crm.example.com';

const HEADER = [
	'\t// Written from wrangler.example.jsonc (#730). `npm run deploy` creates the D1 database and the R2',
	'\t// bucket named below when they are missing, writes the database id here, and fills in',
	'\t// PUBLIC_BASE_URL with the Worker\'s workers.dev address. Edit the names before the first deploy',
	'\t// if you want others. This file holds no secrets.'
].join('\n');

/** @param {string} s */
function quote(s) {
	return JSON.stringify(s);
}

/**
 * Remove comments and trailing commas so JSON.parse can read a JSONC file. Strings are kept as is.
 * @param {string} text
 */
export function stripJsonc(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * @typedef {{
 *   name: string,
 *   database: { name: string, id: string | null },
 *   bucket: string,
 *   publicBaseUrl: string
 * }} InstallConfig
 */

/**
 * The parts of wrangler.jsonc the deploy needs: Worker name, the `DB` database, the `MEDIA` bucket
 * and the PUBLIC_BASE_URL var.
 * @param {string} text
 * @returns {InstallConfig}
 */
export function readConfig(text) {
	/** @type {any} */
	let cfg;
	try {
		cfg = JSON.parse(stripJsonc(text));
	} catch (e) {
		throw new Error(`wrangler.jsonc isn't valid JSONC: ${e instanceof Error ? e.message : e}`);
	}
	const db = (cfg.d1_databases ?? []).find((/** @type {any} */ d) => d?.binding === 'DB');
	if (!db) throw new Error('wrangler.jsonc has no D1 binding "DB"');
	if (typeof db.database_name !== 'string' || !db.database_name) throw new Error('D1 binding "DB" has no database_name');
	const media = (cfg.r2_buckets ?? []).find((/** @type {any} */ b) => b?.binding === 'MEDIA');
	if (!media || typeof media.bucket_name !== 'string' || !media.bucket_name) {
		throw new Error('wrangler.jsonc has no R2 binding "MEDIA" with a bucket_name');
	}
	if (typeof cfg.name !== 'string' || !cfg.name) throw new Error('wrangler.jsonc has no Worker "name"');
	const id = typeof db.database_id === 'string' && db.database_id.trim() ? db.database_id.trim() : null;
	return {
		name: cfg.name,
		database: { name: db.database_name, id },
		bucket: media.bucket_name,
		publicBaseUrl: typeof cfg.vars?.PUBLIC_BASE_URL === 'string' ? cfg.vars.PUBLIC_BASE_URL : ''
	};
}

/**
 * True only for a missing or empty id or the template's all-zero UUID. Anything else counts as a
 * real id: the deploy never replaces it and never creates a database in its place.
 * @param {string | null | undefined} id
 */
export function isPlaceholderDatabaseId(id) {
	const v = (id ?? '').trim();
	return v === '' || /^[0-]+$/.test(v);
}

/**
 * True when PUBLIC_BASE_URL is empty or still the template's stand-in, so the deploy may fill it in.
 * @param {string} url
 */
export function needsPublicUrl(url) {
	const u = (url ?? '').trim().replace(/\/+$/, '');
	return u === '' || u === TEMPLATE_PUBLIC_URL;
}

/**
 * The text range of the object that holds `"binding": "<binding>"`.
 * @param {string} text
 * @param {string} binding
 */
function bindingBlock(text, binding) {
	const at = text.search(new RegExp(`"binding"\\s*:\\s*${quote(binding).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
	if (at < 0) return null;
	const start = text.lastIndexOf('{', at);
	const end = text.indexOf('}', at);
	if (start < 0 || end < 0) return null;
	return { start, end };
}

/**
 * Replace the string value of `"key": "…"` inside [start, end).
 * @param {string} text
 * @param {string} key
 * @param {string} value
 * @param {{ start: number, end: number }} [range]
 */
function setString(text, key, value, range = { start: 0, end: text.length }) {
	const part = text.slice(range.start, range.end);
	const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
	if (!re.test(part)) return null;
	return text.slice(0, range.start) + part.replace(re, (_, head) => `${head}${quote(value)}`) + text.slice(range.end);
}

/**
 * Write the D1 id into the `DB` binding (replacing a placeholder, or adding the key after
 * database_name).
 * @param {string} text
 * @param {string} id
 */
export function setDatabaseId(text, id) {
	const block = bindingBlock(text, 'DB');
	if (!block) throw new Error('wrangler.jsonc has no D1 binding "DB"');
	const replaced = setString(text, 'database_id', id, block);
	if (replaced !== null) return replaced;
	const part = text.slice(block.start, block.end);
	const m = part.match(/([ \t]*)"database_name"\s*:\s*"(?:[^"\\]|\\.)*"(\s*,)?/);
	if (!m || m.index === undefined) throw new Error('D1 binding "DB" has no database_name');
	const insertAt = block.start + m.index + m[0].length;
	const indent = m[1];
	const line = m[2] ? `\n${indent}"database_id": ${quote(id)},` : `,\n${indent}"database_id": ${quote(id)}`;
	return text.slice(0, insertAt) + line + text.slice(insertAt);
}

/**
 * Index of the first `ch` that is code (not inside a string or a comment), or -1.
 * @param {string} text
 * @param {string} ch
 */
function firstCodeIndex(text, ch) {
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === ch) return i;
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			i++;
		}
	}
	return -1;
}

/**
 * Set a string var under "vars": replace its value, or add the key when it's missing (and the
 * "vars" block too, when there is none). Never throws for a missing key.
 * @param {string} text
 * @param {string} key
 * @param {string} value
 */
export function setVar(text, key, value) {
	const varsMatch = text.match(/"vars"\s*:\s*\{/);
	if (varsMatch && varsMatch.index !== undefined) {
		const varsAt = varsMatch.index;
		const out = setString(text, key, value, { start: varsAt, end: text.length });
		if (out !== null) return out;
		const openEnd = varsAt + varsMatch[0].length;
		const rest = text.slice(openEnd);
		const empty = rest.match(/^\s*\}/);
		if (empty) return `${text.slice(0, openEnd)} ${quote(key)}: ${quote(value)} ${rest.slice(empty[0].length - 1)}`;
		return `${text.slice(0, openEnd)}\n\t\t${quote(key)}: ${quote(value)},${rest}`;
	}
	// No "vars" at all: add it as the first top-level key (the object always has "name" after it).
	const open = firstCodeIndex(text, '{');
	if (open < 0) throw new Error('wrangler.jsonc has no top-level object');
	return `${text.slice(0, open + 1)}\n\t"vars": { ${quote(key)}: ${quote(value)} },${text.slice(open + 1)}`;
}

/**
 * The `DB` binding's database_name and database_id, read leniently (JSONC first, then the same
 * text search the deploy used before #730). Used to pick the deploy mode before any network call.
 * @param {string} text
 * @returns {{ name: string | null, id: string | null }}
 */
export function readDatabaseBinding(text) {
	try {
		const cfg = JSON.parse(stripJsonc(text));
		const db = (cfg?.d1_databases ?? []).find((/** @type {any} */ d) => d?.binding === 'DB');
		if (db) {
			return {
				name: typeof db.database_name === 'string' && db.database_name ? db.database_name : null,
				id: typeof db.database_id === 'string' && db.database_id.trim() ? db.database_id.trim() : null
			};
		}
	} catch {
		// fall through to the text search
	}
	const bindingAt = text.search(/"binding"\s*:\s*"DB"/);
	if (bindingAt < 0) return { name: null, id: null };
	const window = text.slice(Math.max(0, bindingAt - 400), bindingAt + 400);
	return {
		name: window.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1] ?? null,
		id: window.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1]?.trim() || null
	};
}

/**
 * A ready-to-use wrangler.jsonc from wrangler.example.jsonc.
 * @param {string} template contents of wrangler.example.jsonc
 * @param {{ worker: string, database: string, bucket: string }} [names]
 */
export function configFromTemplate(template, names = DEFAULT_NAMES) {
	let text = template.replace(/^\{\r?\n(?:[ \t]*\/\/[^\n]*\n)+/, `{\n${HEADER}\n`);
	// The Worker name is the first "name" key in the file (top level).
	text = text.replace(/("name"\s*:\s*)"(?:[^"\\]|\\.)*"/, (_, head) => `${head}${quote(names.worker)}`);
	const db = bindingBlock(text, 'DB');
	if (!db) throw new Error('template has no D1 binding "DB"');
	const withName = setString(text, 'database_name', names.database, db);
	if (withName === null) throw new Error('template D1 binding has no database_name');
	text = withName;
	// No id: the deploy creates the database and writes it.
	text = text.replace(/\n[ \t]*"database_id"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?[ \t]*(?=\n)/, '');
	text = text.replace(
		/\/\/ Create with `npx wrangler d1 create <name>` and paste the name and id it prints\./,
		'// `npm run deploy` creates this database and writes its database_id here.'
	);
	const media = bindingBlock(text, 'MEDIA');
	if (!media) throw new Error('template has no R2 binding "MEDIA"');
	const withBucket = setString(text, 'bucket_name', names.bucket, media);
	if (withBucket === null) throw new Error('template R2 binding has no bucket_name');
	text = withBucket.replace(
		/Create with\s*\n([ \t]*)\/\/ `npx wrangler r2 bucket create <name>`\./,
		'`npm run deploy`\n$1// creates the bucket when it is missing.'
	);
	text = setVar(text, 'WORKER_NAME', names.worker);
	text = setVar(text, 'PUBLIC_BASE_URL', '');
	return text;
}

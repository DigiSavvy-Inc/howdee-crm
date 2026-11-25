// Forms (#508, phase 1 = #509): storage. CRUD for `forms`, the submissions log, the CSV
// export and the nightly prune. No SvelteKit imports, so the submit path, the routes and
// later phases (API, assistant) share it.
import {
	answerText,
	emptyForm,
	FORM_LIMITS,
	isAnswerType,
	normalizeFormSpec,
	slugify,
	SLUG_RE,
	validateFormSpec,
	type Answers,
	type FormSpec,
	type SpecProblem
} from '$lib/forms';
import { csvCell } from '$lib/report-view';
import { pruneRateLimits } from './rate-limit';
import { b64urlEncode, hmac, timingSafeEqual, b64urlDecode } from './token';
import { containsSql } from './sql-match';

export type FormStatus = 'draft' | 'published' | 'archived';

export type FormRow = {
	id: number;
	name: string;
	slug: string;
	status: FormStatus;
	spec: FormSpec;
	version: number;
	retention_days: number;
	created_at: string;
	updated_at: string;
	published_at: string | null;
	archived_at: string | null;
};

type RawFormRow = Omit<FormRow, 'spec'> & { spec: string };

const COLS = 'id, name, slug, status, spec, version, retention_days, created_at, updated_at, published_at, archived_at';
const parse = (r: RawFormRow): FormRow => ({ ...r, spec: normalizeFormSpec(r.spec) });

/** By id (a number or a numeric string) or by slug. */
export async function getForm(db: D1Database, idOrSlug: number | string): Promise<FormRow | null> {
	const asId = typeof idOrSlug === 'number' ? idOrSlug : /^\d+$/.test(idOrSlug) ? Number(idOrSlug) : null;
	const row = asId
		? await db.prepare(`SELECT ${COLS} FROM forms WHERE id = ?`).bind(asId).first<RawFormRow>()
		: await db.prepare(`SELECT ${COLS} FROM forms WHERE slug = ?`).bind(String(idOrSlug).toLowerCase()).first<RawFormRow>();
	return row ? parse(row) : null;
}

export type FormListRow = {
	id: number;
	name: string;
	slug: string;
	status: FormStatus;
	version: number;
	updated_at: string;
	published_at: string | null;
	submissions: number;
	last_submission_at: string | null;
};

/** Every form (archived only with `archived: true`), newest edit first, with counts. */
export async function listForms(db: D1Database, opts: { archived?: boolean } = {}): Promise<FormListRow[]> {
	const where = opts.archived ? "f.status = 'archived'" : "f.status != 'archived'";
	// #744: a held submission (daily send limit) isn't counted until it is released.
	const run = (notHeld: string) =>
		db
			.prepare(
				`SELECT f.id, f.name, f.slug, f.status, f.version, f.updated_at, f.published_at,
				        (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id AND s.status IN ('added', 'updated', 'anonymous')${notHeld}) AS submissions,
				        (SELECT MAX(created_at) FROM form_submissions s WHERE s.form_id = f.id AND s.status IN ('added', 'updated', 'anonymous')${notHeld}) AS last_submission_at
				 FROM forms f WHERE ${where} ORDER BY f.updated_at DESC, f.id DESC`
			)
			.all<FormListRow>();
	try {
		return (await run(` AND NOT ${heldSql('s.')}`)).results;
	} catch (e) {
		// Before migration 0139 there is no `held_at` and so no held row.
		if (!isPreMigrationHeldError(e)) throw e;
		return (await run('')).results;
	}
}

/**
 * #744: true only for SQLite's missing-column error on a column migration 0139 adds to
 * `form_submissions` (`held_at`, `released_at`, `released_by`): "no such column: …" on a read or
 * an update, "table … has no column named …" on an insert. Any other failure, including another
 * missing column, stays a failure. Same shape as `isPreMigrationKeyError` in webhook-keys.ts.
 */
export function isPreMigrationHeldError(err: unknown): boolean {
	const pattern = /(?:no such column:\s*(?:[\w"]+\.)?|has no column named\s+)"?(?:held_at|released_at|released_by)\b/i;
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current != null && !seen.has(current)) {
		if (typeof current === 'string') return pattern.test(current);
		if (typeof current !== 'object') return false;
		seen.add(current);
		const message = current instanceof Error ? current.message : '';
		if (pattern.test(message)) return true;
		if (!(current instanceof Error)) return false;
		current = current.cause;
	}
	return false;
}

/** #744: a held submission's `detail` starts with this. */
export const HELD_DETAIL = 'held: daily send limit reached';

/** #744: how old a release's claim must be before a row it left in the held shape counts as stranded. */
export const RELEASE_STALE_MINUTES = 10;

/** The held shape a release leaves behind when it claimed the row and could not put it back. */
function strandedShape(a: string): string {
	return `${a}released_at IS NOT NULL AND ${a}contact_id IS NULL AND IFNULL(${a}status, '') = 'anonymous' AND substr(IFNULL(${a}detail, ''), 1, ${HELD_DETAIL.length}) = '${HELD_DETAIL}'`;
}

/**
 * #744: SQL that is true for a held submission (`a` = the table alias with its dot, or ''). Held =
 * `held_at` set, or a row a release claimed (`held_at` cleared, `released_at` set) and could not put
 * back: it still has the held shape (status `anonymous`, no contact, `detail` starting with
 * `HELD_DETAIL`). A release that finishes always rewrites `detail` to start with "released", so a
 * released row never matches. Every term is NULL-safe, so `NOT (…)` is safe too. A release still
 * running matches as well (it is not an ordinary submission until it finishes).
 */
export function heldSql(a = ''): string {
	return `(${a}held_at IS NOT NULL OR (${strandedShape(a)}))`;
}

/**
 * #744: the held rows a release may claim: `heldSql`, except that a row in the held shape whose
 * claim is newer than `RELEASE_STALE_MINUTES` is left alone (a release may still be running on it).
 */
export function releasableHeldSql(a = ''): string {
	return `(${a}held_at IS NOT NULL OR (${strandedShape(a)} AND ${a}released_at < datetime('now', '-${RELEASE_STALE_MINUTES} minutes')))`;
}

/** `base`, else `base-2`, `base-3`… — the first slug no other form uses. */
export async function freeFormSlug(db: D1Database, base: string, exceptId?: number): Promise<string> {
	const root = slugify(base) || 'form';
	for (let n = 1; n < 500; n++) {
		const suffix = n === 1 ? '' : `-${n}`;
		const candidate = `${root.slice(0, FORM_LIMITS.slug - suffix.length).replace(/-+$/, '')}${suffix}`;
		const taken = await db
			.prepare('SELECT id FROM forms WHERE slug = ? AND id != ?')
			.bind(candidate, exceptId ?? 0)
			.first<{ id: number }>();
		if (!taken) return candidate;
	}
	return `${root.slice(0, 40)}-${Date.now().toString(36)}`;
}

/** A new draft from `emptyForm()`. */
export async function createForm(db: D1Database, name: string, userId: number | null): Promise<number> {
	const clean = name.trim().slice(0, FORM_LIMITS.name) || 'Untitled form';
	const slug = await freeFormSlug(db, clean);
	const spec = emptyForm(clean);
	const row = await db
		.prepare('INSERT INTO forms (name, slug, spec, retention_days, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(clean, slug, JSON.stringify(spec), spec.settings.retention_days, userId, userId)
		.first<{ id: number }>();
	return row!.id;
}

export type SaveResult = { ok: true; form: FormRow } | { ok: false; status: number; error: string; problems: SpecProblem[] };

function checkNameSlug(name: string, slug: string): SpecProblem[] {
	const out: SpecProblem[] = [];
	if (!name.trim()) out.push({ path: 'name', message: 'Give the form a name.' });
	if (name.length > FORM_LIMITS.name) out.push({ path: 'name', message: `Name is over ${FORM_LIMITS.name} characters.` });
	if (!SLUG_RE.test(slug) || slug.length > FORM_LIMITS.slug) {
		out.push({ path: 'slug', message: 'The address must be lowercase letters and numbers with hyphens (e.g. book-a-call).' });
	}
	return out;
}

/**
 * Save name, slug and spec. The spec must pass `validateFormSpec` and the slug must be free.
 * Saving a published form makes it live at once and bumps `version` (the page's cache key).
 */
export async function saveForm(
	db: D1Database,
	id: number,
	input: { name: string; slug: string; spec: unknown },
	userId: number | null
): Promise<SaveResult> {
	const form = await getForm(db, id);
	if (!form) return { ok: false, status: 404, error: 'Form not found.', problems: [] };
	const name = input.name.trim();
	const slug = input.slug.trim().toLowerCase();
	const spec = normalizeFormSpec(input.spec);
	const problems = [...checkNameSlug(name, slug), ...validateFormSpec(spec)];
	if (!problems.some((p) => p.path === 'slug')) {
		const taken = await db.prepare('SELECT id FROM forms WHERE slug = ? AND id != ?').bind(slug, id).first<{ id: number }>();
		if (taken) problems.push({ path: 'slug', message: `Another form already uses /f/${slug}.` });
	}
	if (problems.length) return { ok: false, status: 400, error: problems[0].message, problems };

	const bump = form.status === 'published' ? 1 : 0;
	await db
		.prepare(
			`UPDATE forms SET name = ?, slug = ?, spec = ?, retention_days = ?, version = version + ?,
			        updated_by = ?, updated_at = datetime('now') WHERE id = ?`
		)
		.bind(name, slug, JSON.stringify(spec), spec.settings.retention_days, bump, userId, id)
		.run();
	return { ok: true, form: (await getForm(db, id))! };
}

/** Draft / archived → published. Refused while the stored spec doesn't validate. */
export async function publishForm(db: D1Database, id: number, userId: number | null): Promise<SaveResult> {
	const form = await getForm(db, id);
	if (!form) return { ok: false, status: 404, error: 'Form not found.', problems: [] };
	const problems = validateFormSpec(form.spec);
	if (problems.length) return { ok: false, status: 400, error: `Fix this before publishing: ${problems[0].message}`, problems };
	await db
		.prepare(
			`UPDATE forms SET status = 'published', version = version + 1, published_at = datetime('now'), archived_at = NULL,
			        updated_by = ?, updated_at = datetime('now') WHERE id = ?`
		)
		.bind(userId, id)
		.run();
	return { ok: true, form: (await getForm(db, id))! };
}

/** Published → draft (the public page 404s; submissions are kept). */
export async function unpublishForm(db: D1Database, id: number, userId: number | null): Promise<boolean> {
	const res = await db
		.prepare(`UPDATE forms SET status = 'draft', updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'published'`)
		.bind(userId, id)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Any → archived (hidden from the list, page 404s, submissions kept). */
export async function archiveForm(db: D1Database, id: number, userId: number | null): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE forms SET status = 'archived', archived_at = datetime('now'), updated_by = ?, updated_at = datetime('now')
			 WHERE id = ? AND status != 'archived'`
		)
		.bind(userId, id)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Archived → draft. */
export async function restoreForm(db: D1Database, id: number, userId: number | null): Promise<boolean> {
	const res = await db
		.prepare(`UPDATE forms SET status = 'draft', archived_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'archived'`)
		.bind(userId, id)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** A new draft "<name> (copy)" with the same spec and a free slug. */
export async function duplicateForm(db: D1Database, id: number, userId: number | null): Promise<number | null> {
	const form = await getForm(db, id);
	if (!form) return null;
	const name = `${form.name} (copy)`.slice(0, FORM_LIMITS.name);
	const slug = await freeFormSlug(db, `${form.slug}-copy`);
	const row = await db
		.prepare('INSERT INTO forms (name, slug, spec, retention_days, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(name, slug, JSON.stringify(form.spec), form.retention_days, userId, userId)
		.first<{ id: number }>();
	return row?.id ?? null;
}

// ---------------------------------------------------------------------------------------
// Submissions

export type SubmissionStatus = 'added' | 'updated' | 'anonymous' | 'spam' | 'rejected';
export const OK_STATUSES: SubmissionStatus[] = ['added', 'updated', 'anonymous'];

export type NewSubmission = {
	form_id: number;
	form_version: number | null;
	contact_id: number | null;
	email: string | null;
	status: SubmissionStatus;
	detail?: string | null;
	answers: Answers;
	utm?: Record<string, string> | null;
	referrer?: string | null;
	/** #515: the host page of an embedded form (`?page_url=`). */
	page_url?: string | null;
	ip_hash?: string | null;
	user_agent?: string | null;
	/** #514: ids of the outcomes that fired. */
	outcomes?: string[] | null;
	/** #744: over the form's daily send cap: stored with `held_at` until an admin releases it. */
	held?: boolean;
};

/**
 * Store one submission row. #744: before migration 0139 (no `held_at` column) the row is stored
 * without it; the daily send cap is off there (`heldColumnsReady`), so nothing asks to hold one.
 */
export async function recordSubmission(db: D1Database, s: NewSubmission): Promise<number> {
	const utm = s.utm && Object.keys(s.utm).length ? JSON.stringify(s.utm) : null;
	const values = [
		s.form_id,
		s.form_version,
		s.contact_id,
		s.email,
		s.status,
		s.detail ? String(s.detail).slice(0, 300) : null,
		JSON.stringify(s.answers ?? {}),
		utm,
		s.referrer ? String(s.referrer).slice(0, 500) : null,
		s.page_url ? String(s.page_url).slice(0, 500) : null,
		s.ip_hash ?? null,
		s.user_agent ? String(s.user_agent).slice(0, 300) : null,
		s.outcomes ? JSON.stringify(s.outcomes.slice(0, 50)) : null
	];
	const cols = 'form_id, form_version, contact_id, email, status, detail, answers, utm, referrer, page_url, ip_hash, user_agent, outcomes';
	const marks = values.map(() => '?').join(', ');
	try {
		const row = await db
			.prepare(`INSERT INTO form_submissions (${cols}, held_at) VALUES (${marks}, CASE WHEN ? THEN datetime('now') END) RETURNING id`)
			.bind(...values, s.held ? 1 : 0)
			.first<{ id: number }>();
		return row!.id;
	} catch (e) {
		if (!isPreMigrationHeldError(e)) throw e;
		if (s.held) console.error('form submission stored without held_at: migration 0139 is not applied');
		const row = await db
			.prepare(`INSERT INTO form_submissions (${cols}) VALUES (${marks}) RETURNING id`)
			.bind(...values)
			.first<{ id: number }>();
		return row!.id;
	}
}

/**
 * #744: whether migration 0139's columns exist. False only on the missing-column error; any
 * other failure is thrown.
 */
export async function heldColumnsReady(db: D1Database): Promise<boolean> {
	try {
		await db.prepare('SELECT held_at, released_at, released_by FROM form_submissions LIMIT 0').all();
		return true;
	} catch (e) {
		if (isPreMigrationHeldError(e)) return false;
		throw e;
	}
}

export type SubmissionRow = {
	id: number;
	form_id: number;
	form_version: number | null;
	contact_id: number | null;
	email: string | null;
	status: SubmissionStatus;
	detail: string | null;
	answers: Answers;
	utm: Record<string, string> | null;
	referrer: string | null;
	page_url: string | null;
	created_at: string;
	contact_name: string | null;
	/** #514: ids of the outcomes that fired; null on older rows. */
	outcomes: string[] | null;
	/** #744: set while the submission is held by the daily send cap. */
	held_at: string | null;
	released_at: string | null;
	/** #744: held (`heldSql`), including a row a failed release could not put back. */
	held: boolean;
};

export type SubmissionFilter = {
	/** 'ok' (default) = added / updated / anonymous, not held; 'hidden' = spam + rejected; 'held'
	 *  = held by the daily send cap (#744); or one status. */
	status?: 'ok' | 'hidden' | 'held' | SubmissionStatus;
	/** YYYY-MM-DD, inclusive (UTC). */
	from?: string | null;
	to?: string | null;
	q?: string | null;
	/** #620: 'YYYY-MM-DD HH:MM:SS' (UTC) — only rows created strictly after it (the API's `since`). */
	after?: string | null;
	limit?: number;
	offset?: number;
};

const SUB_STATUSES: SubmissionStatus[] = ['added', 'updated', 'anonymous', 'spam', 'rejected'];

/** The Submissions tab's / CSV export's URL filter (`status`, `from`, `to`, `q`, `page`). */
export function parseSubmissionFilter(q: URLSearchParams): SubmissionFilter & { page: number } {
	const status = q.get('status');
	return {
		status: status === 'hidden' || status === 'spam' || status === 'rejected' || status === 'held' ? status : 'ok',
		from: q.get('from') || null,
		to: q.get('to') || null,
		q: (q.get('q') ?? '').slice(0, 200) || null,
		page: Math.max(1, Math.floor(Number(q.get('page')) || 1))
	};
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `held: false` = the database has no `held_at` yet (before migration 0139): no row is held, so
 * the held clauses are left out and the `held` filter matches nothing.
 */
function submissionWhere(formId: number, f: SubmissionFilter, opts: { held?: boolean } = {}): { sql: string; binds: unknown[] } {
	const parts = ['s.form_id = ?'];
	const binds: unknown[] = [formId];
	const st = f.status ?? 'ok';
	const heldCol = opts.held !== false;
	// #744: a held row (status `anonymous`) is listed under `held` only.
	const notHeld = heldCol ? ` AND NOT ${heldSql('s.')}` : '';
	if (st === 'ok') parts.push(`s.status IN ('added', 'updated', 'anonymous')${notHeld}`);
	else if (st === 'held') parts.push(heldCol ? heldSql('s.') : '0');
	else if (st === 'hidden') parts.push("s.status IN ('spam', 'rejected')");
	else if (SUB_STATUSES.includes(st)) {
		parts.push(`s.status = ?${st === 'anonymous' ? notHeld : ''}`);
		binds.push(st);
	}
	if (f.from && DAY_RE.test(f.from)) {
		parts.push('s.created_at >= ?');
		binds.push(`${f.from} 00:00:00`);
	}
	if (f.to && DAY_RE.test(f.to)) {
		parts.push('s.created_at <= ?');
		binds.push(`${f.to} 23:59:59`);
	}
	if (f.after && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(f.after)) {
		parts.push('s.created_at > ?');
		binds.push(f.after);
	}
	const q = (f.q ?? '').trim();
	if (q) {
		// #485: instr, not LIKE (D1 caps LIKE patterns at 50 bytes).
		parts.push(`(${containsSql('s.email')} OR ${containsSql('s.answers')})`);
		binds.push(q, q);
	}
	return { sql: parts.join(' AND '), binds };
}

function parseSub(
	r: Omit<SubmissionRow, 'answers' | 'utm' | 'outcomes' | 'held'> & { answers: string; utm: string | null; outcomes: string | null; held?: number | null }
): SubmissionRow {
	let answers: Answers = {};
	let utm: Record<string, string> | null = null;
	let outcomes: string[] | null = null;
	try {
		const o = r.outcomes ? JSON.parse(r.outcomes) : null;
		outcomes = Array.isArray(o) ? o.map(String) : null;
	} catch {
		outcomes = null;
	}
	try {
		answers = JSON.parse(r.answers) ?? {};
	} catch {
		answers = {};
	}
	try {
		utm = r.utm ? JSON.parse(r.utm) : null;
	} catch {
		utm = null;
	}
	return { ...r, answers, utm, outcomes, held: !!r.held };
}

export async function listSubmissions(
	db: D1Database,
	formId: number,
	f: SubmissionFilter = {}
): Promise<{ rows: SubmissionRow[]; total: number }> {
	const limit = Math.max(1, Math.min(5000, Math.floor(f.limit ?? 50)));
	const offset = Math.max(0, Math.floor(f.offset ?? 0));
	const run = (held: boolean) => {
		const w = submissionWhere(formId, f, { held });
		const heldCols = held ? `s.held_at, s.released_at, ${heldSql('s.')} AS held` : 'NULL AS held_at, NULL AS released_at, 0 AS held';
		return db.batch([
			db
				.prepare(
					`SELECT s.id, s.form_id, s.form_version, s.contact_id, s.email, s.status, s.detail, s.answers, s.utm, s.referrer, s.page_url, s.created_at, s.outcomes, ${heldCols},
					        NULLIF(TRIM(COALESCE(c.name, TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name
					 FROM form_submissions s LEFT JOIN contacts c ON c.id = s.contact_id
					 WHERE ${w.sql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`
				)
				.bind(...w.binds, limit, offset),
			db.prepare(`SELECT COUNT(*) AS n FROM form_submissions s WHERE ${w.sql}`).bind(...w.binds)
		]);
	};
	let rows: D1Result<unknown>;
	let total: D1Result<unknown>;
	try {
		[rows, total] = await run(true);
	} catch (e) {
		// #744: before migration 0139 there is no `held_at` (and so no held row).
		if (!isPreMigrationHeldError(e)) throw e;
		[rows, total] = await run(false);
	}
	return {
		rows: (rows.results as Parameters<typeof parseSub>[0][]).map(parseSub),
		total: (total.results[0] as { n: number } | undefined)?.n ?? 0
	};
}

export async function getSubmission(db: D1Database, id: number): Promise<SubmissionRow | null> {
	const r = await db
		.prepare(
			`SELECT s.id, s.form_id, s.form_version, s.contact_id, s.email, s.status, s.detail, s.answers, s.utm, s.referrer, s.page_url, s.created_at, s.outcomes,
			        NULL AS contact_name
			 FROM form_submissions s WHERE s.id = ?`
		)
		.bind(id)
		.first<Parameters<typeof parseSub>[0]>();
	return r ? parseSub(r) : null;
}

export const CSV_MAX_ROWS = 5000;

/** CSV of a form's submissions under the filter (≤ 5,000 rows, newest first). */
export async function submissionsCsv(db: D1Database, form: FormRow, f: SubmissionFilter = {}): Promise<string> {
	const { rows } = await listSubmissions(db, form.id, { ...f, limit: CSV_MAX_ROWS, offset: 0 });
	const fields = form.spec.fields.filter((x) => isAnswerType(x.type));
	// Keys that older versions of the form answered but the current one no longer has.
	const known = new Set(fields.map((x) => x.key));
	const extra = [...new Set(rows.flatMap((r) => Object.keys(r.answers)).filter((k) => !known.has(k)))];
	const header = [
		'submission_id',
		'submitted_at_utc',
		'status',
		'email',
		'contact_id',
		...fields.map((x) => x.label || x.key),
		...extra,
		'utm_source',
		'utm_medium',
		'utm_campaign',
		'referrer',
		'page_url'
	];
	const lines = [header.map(csvCell).join(',')];
	for (const r of rows) {
		lines.push(
			[
				r.id,
				r.created_at,
				r.status,
				r.email ?? '',
				r.contact_id ?? '',
				// A rating is exported as its bare number (#589), not "4 / 5".
				...fields.map((x) => (x.type === 'rating' && typeof r.answers[x.key] === 'number' ? r.answers[x.key] : answerText(r.answers[x.key], x))),
				...extra.map((k) => answerText(r.answers[k])),
				r.utm?.utm_source ?? '',
				r.utm?.utm_medium ?? '',
				r.utm?.utm_campaign ?? '',
				r.referrer ?? '',
				r.page_url ?? ''
			]
				.map(csvCell)
				.join(',')
		);
	}
	return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function deleteSubmission(db: D1Database, formId: number, id: number): Promise<boolean> {
	const res = await db.prepare('DELETE FROM form_submissions WHERE id = ? AND form_id = ?').bind(id, formId).run();
	return (res.meta.changes ?? 0) > 0;
}

/**
 * Nightly-safe prune (runs every heartbeat tick; a no-op when nothing is old): each form's
 * submissions older than its `retention_days` (a form with 0 / a bad value uses
 * `retentionDays`), plus stale rate-limit windows.
 */
export async function pruneSubmissions(
	db: D1Database,
	retentionDays = 365,
	now: Date = new Date()
): Promise<{ deleted: number; rateLimits: number }> {
	const nowTs = now.toISOString().slice(0, 19).replace('T', ' ');
	const res = await db
		.prepare(
			`DELETE FROM form_submissions WHERE id IN (
			   SELECT s.id FROM form_submissions s JOIN forms f ON f.id = s.form_id
			   WHERE s.created_at < datetime(?, '-' || (CASE WHEN f.retention_days > 0 THEN f.retention_days ELSE ? END) || ' days')
			   LIMIT 5000)`
		)
		.bind(nowTs, Math.max(1, Math.floor(retentionDays)))
		.run();
	const rateLimits = await pruneRateLimits(db, now);
	return { deleted: res.meta.changes ?? 0, rateLimits };
}

// ---------------------------------------------------------------------------------------
// The thanks page's signed submission id

const THANKS_PREFIX = 'form-thanks:';

export async function signSubmissionId(secret: string, id: number): Promise<string> {
	const sig = await hmac(secret, `${THANKS_PREFIX}${id}`);
	return `${id}.${b64urlEncode(sig.slice(0, 12))}`;
}

export async function verifySubmissionId(secret: string, token: string | null | undefined): Promise<number | null> {
	const m = /^(\d{1,12})\.([A-Za-z0-9_-]{10,40})$/.exec(String(token ?? ''));
	if (!m || !secret) return null;
	const id = Number(m[1]);
	const want = (await hmac(secret, `${THANKS_PREFIX}${id}`)).slice(0, 12);
	let got: Uint8Array;
	try {
		got = b64urlDecode(m[2]);
	} catch {
		return null;
	}
	return timingSafeEqual(want, got) ? id : null;
}

/** #744: forms with submissions held by the daily send cap (the dashboard notice), newest first. */
export async function heldSubmissionSummary(
	db: D1Database
): Promise<{ form_id: number; name: string; held: number; first_held_at: string; last_held_at: string }[]> {
	try {
		const res = await db
			.prepare(
				`SELECT s.form_id, f.name, COUNT(*) AS held,
				        MIN(COALESCE(s.held_at, s.released_at, s.created_at)) AS first_held_at,
				        MAX(COALESCE(s.held_at, s.released_at, s.created_at)) AS last_held_at
				 FROM form_submissions s JOIN forms f ON f.id = s.form_id
				 WHERE ${heldSql('s.')}
				 GROUP BY s.form_id ORDER BY last_held_at DESC LIMIT 20`
			)
			.all<{ form_id: number; name: string; held: number; first_held_at: string; last_held_at: string }>();
		return res.results;
	} catch (e) {
		if (isPreMigrationHeldError(e)) return [];
		throw e;
	}
}

/** #744: how many of a form's submissions are held (0 before migration 0139). */
export async function heldCount(db: D1Database, formId: number): Promise<number> {
	try {
		const r = await db
			.prepare(`SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ? AND ${heldSql()}`)
			.bind(formId)
			.first<{ n: number }>();
		return r?.n ?? 0;
	} catch (e) {
		if (isPreMigrationHeldError(e)) return 0;
		throw e;
	}
}

/** Rows per DELETE in `discardHeld`. */
export const DISCARD_CHUNK = 500;

/**
 * #744: delete a form's held submissions (only held rows a release may claim, only this form), in
 * chunks of `DISCARD_CHUNK`. Nothing else changes (a row that says a confirmation email was sent
 * keeps that email sent). Returns the count; 0 before migration 0139 (nothing is held there).
 */
export async function discardHeld(db: D1Database, formId: number): Promise<number> {
	let deleted = 0;
	// At most 200 chunks (100,000 rows) per call; the Submissions tab shows what is left.
	for (let i = 0; i < 200; i++) {
		let res: D1Result;
		try {
			res = await db
				.prepare(
					`DELETE FROM form_submissions WHERE id IN (
					   SELECT id FROM form_submissions WHERE form_id = ? AND ${releasableHeldSql()} ORDER BY id LIMIT ?)`
				)
				.bind(formId, DISCARD_CHUNK)
				.run();
		} catch (e) {
			if (isPreMigrationHeldError(e)) return deleted;
			throw e;
		}
		const n = res.meta.changes ?? 0;
		deleted += n;
		if (n < DISCARD_CHUNK) break;
	}
	return deleted;
}

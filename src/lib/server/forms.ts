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
	const rows = await db
		.prepare(
			`SELECT f.id, f.name, f.slug, f.status, f.version, f.updated_at, f.published_at,
			        (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id AND s.status IN ('added', 'updated', 'anonymous')) AS submissions,
			        (SELECT MAX(created_at) FROM form_submissions s WHERE s.form_id = f.id AND s.status IN ('added', 'updated', 'anonymous')) AS last_submission_at
			 FROM forms f WHERE ${where} ORDER BY f.updated_at DESC, f.id DESC`
		)
		.all<FormListRow>();
	return rows.results;
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
};

export async function recordSubmission(db: D1Database, s: NewSubmission): Promise<number> {
	const utm = s.utm && Object.keys(s.utm).length ? JSON.stringify(s.utm) : null;
	const row = await db
		.prepare(
			`INSERT INTO form_submissions (form_id, form_version, contact_id, email, status, detail, answers, utm, referrer, page_url, ip_hash, user_agent, outcomes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
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
		)
		.first<{ id: number }>();
	return row!.id;
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
};

export type SubmissionFilter = {
	/** 'ok' (default) = added / updated / anonymous; 'hidden' = spam + rejected; or one status. */
	status?: 'ok' | 'hidden' | SubmissionStatus;
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
		status: status === 'hidden' || status === 'spam' || status === 'rejected' ? status : 'ok',
		from: q.get('from') || null,
		to: q.get('to') || null,
		q: (q.get('q') ?? '').slice(0, 200) || null,
		page: Math.max(1, Math.floor(Number(q.get('page')) || 1))
	};
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function submissionWhere(formId: number, f: SubmissionFilter): { sql: string; binds: unknown[] } {
	const parts = ['s.form_id = ?'];
	const binds: unknown[] = [formId];
	const st = f.status ?? 'ok';
	if (st === 'ok') parts.push("s.status IN ('added', 'updated', 'anonymous')");
	else if (st === 'hidden') parts.push("s.status IN ('spam', 'rejected')");
	else if (SUB_STATUSES.includes(st)) {
		parts.push('s.status = ?');
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
		const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
		parts.push("(s.email LIKE ? ESCAPE '\\' OR s.answers LIKE ? ESCAPE '\\')");
		binds.push(like, like);
	}
	return { sql: parts.join(' AND '), binds };
}

function parseSub(
	r: Omit<SubmissionRow, 'answers' | 'utm' | 'outcomes'> & { answers: string; utm: string | null; outcomes: string | null }
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
	return { ...r, answers, utm, outcomes };
}

export async function listSubmissions(
	db: D1Database,
	formId: number,
	f: SubmissionFilter = {}
): Promise<{ rows: SubmissionRow[]; total: number }> {
	const w = submissionWhere(formId, f);
	const limit = Math.max(1, Math.min(5000, Math.floor(f.limit ?? 50)));
	const offset = Math.max(0, Math.floor(f.offset ?? 0));
	const [rows, total] = await db.batch([
		db
			.prepare(
				`SELECT s.id, s.form_id, s.form_version, s.contact_id, s.email, s.status, s.detail, s.answers, s.utm, s.referrer, s.page_url, s.created_at, s.outcomes,
				        NULLIF(TRIM(COALESCE(c.name, TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name
				 FROM form_submissions s LEFT JOIN contacts c ON c.id = s.contact_id
				 WHERE ${w.sql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`
			)
			.bind(...w.binds, limit, offset),
		db.prepare(`SELECT COUNT(*) AS n FROM form_submissions s WHERE ${w.sql}`).bind(...w.binds)
	]);
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

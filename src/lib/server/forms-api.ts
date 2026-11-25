// Forms (#620): read access for the Data API (GET /api/v1/forms, GET /api/v1/forms/:id/submissions)
// and the MCP server's read tools (list_forms, get_form_submissions) — one serialization, no
// writes. Only accepted submissions (added / updated / anonymous) are returned; spam and
// rejected rows stay in the app. The webhook URL is not exposed.
import { getForm, listForms, listSubmissions, type FormStatus } from './forms';

export const SUBMISSIONS_MAX_LIMIT = 200;
export const SUBMISSIONS_DEFAULT_LIMIT = 50;

export type ApiForm = {
	id: number;
	name: string;
	slug: string;
	status: FormStatus;
	version: number;
	url: string | null;
	fields: { key: string; type: string; label: string; required: boolean }[];
	pages: number;
	submissions: number;
	last_submission_at: string | null;
	published_at: string | null;
	updated_at: string;
};

/** Every form (archived ones only with `includeArchived`), newest edit first. */
export async function listFormsForApi(
	db: D1Database,
	baseUrl: string,
	opts: { includeArchived?: boolean; status?: FormStatus | null } = {}
): Promise<ApiForm[]> {
	const rows = opts.includeArchived ? [...(await listForms(db)), ...(await listForms(db, { archived: true }))] : await listForms(db);
	const base = baseUrl.replace(/\/$/, '');
	const out: ApiForm[] = [];
	for (const r of rows) {
		if (opts.status && r.status !== opts.status) continue;
		const form = await getForm(db, r.id);
		if (!form) continue;
		out.push({
			id: r.id,
			name: r.name,
			slug: r.slug,
			status: r.status,
			version: r.version,
			url: r.status === 'published' && base ? `${base}/f/${r.slug}` : null,
			fields: form.spec.fields
				.filter((f) => f.type !== 'page_break')
				.map((f) => ({ key: f.key, type: f.type, label: f.label, required: f.required })),
			pages: Math.max(1, form.spec.pages.length),
			submissions: r.submissions,
			last_submission_at: r.last_submission_at,
			published_at: r.published_at,
			updated_at: r.updated_at
		});
	}
	return out;
}

/**
 * `since` → the SQL timestamp `form_submissions.created_at` compares with ('YYYY-MM-DD HH:MM:SS', UTC).
 * Accepts YYYY-MM-DD or any ISO date-time; returns undefined when absent, null when unreadable.
 */
export function parseSince(raw: string | null | undefined): string | null | undefined {
	const v = (raw ?? '').trim();
	if (!v) return undefined;
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} 00:00:00`;
	const t = Date.parse(v);
	if (!Number.isFinite(t)) return null;
	return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

export type ApiSubmission = {
	id: number;
	form_id: number;
	form_version: number | null;
	contact_id: number | null;
	email: string | null;
	status: string;
	answers: Record<string, unknown>;
	utm: Record<string, string> | null;
	/** #656: the stored host page of an embedded form (#515), else the referrer — same as the webhook. */
	page_url: string | null;
	/** The raw Referer header the submission arrived with (for an embed: the host page's own referrer). */
	referrer: string | null;
	submitted_at: string;
};

const toIso = (sql: string) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(sql) ? `${sql.slice(0, 19).replace(' ', 'T')}Z` : sql);

/** One page of a form's accepted submissions, newest first; `since` = strictly after. */
export async function formSubmissionsForApi(
	db: D1Database,
	formId: number,
	opts: { since?: string; limit?: number; offset?: number } = {}
): Promise<{ rows: ApiSubmission[]; total: number; limit: number; offset: number }> {
	const limit = Math.max(1, Math.min(SUBMISSIONS_MAX_LIMIT, Math.floor(opts.limit ?? SUBMISSIONS_DEFAULT_LIMIT)));
	const offset = Math.max(0, Math.floor(opts.offset ?? 0));
	const res = await listSubmissions(db, formId, { status: 'ok', after: opts.since ?? null, limit, offset });
	return {
		rows: res.rows.map((r) => ({
			id: r.id,
			form_id: r.form_id,
			form_version: r.form_version,
			contact_id: r.contact_id,
			email: r.email,
			status: r.status,
			answers: r.answers,
			utm: r.utm,
			page_url: r.page_url ?? r.referrer,
			referrer: r.referrer,
			submitted_at: toIso(r.created_at)
		})),
		total: res.total,
		limit,
		offset
	};
}

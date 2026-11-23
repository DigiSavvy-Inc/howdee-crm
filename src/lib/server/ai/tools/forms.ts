// Forms read tools (#517, Forms 5/7): list_forms, get_form, get_form_submissions. Reads come
// from forms.ts (listForms, getForm, listSubmissions) and forms-api.ts (parseSince); nothing
// here writes. The notify webhook address is never returned (it can carry a secret).

import { answerText, isAnswerType, type FormField, type FormSpec } from '$lib/forms';
import { CSV_MAX_ROWS, getForm, listForms, listSubmissions, type FormListRow, type FormRow, type SubmissionFilter, type SubmissionRow } from '../../forms';
import { parseSince } from '../../forms-api';
import { formCounts, formOutline } from './form-input';
import { ToolInputError, intArg, strArg, type Tool, type ToolContext } from './types';

const FORM_STATUSES = ['draft', 'published', 'archived'];
const SUBMISSION_STATUSES = ['ok', 'hidden', 'added', 'updated', 'anonymous', 'spam', 'rejected'];
const SUBMISSIONS_MAX = 200;
/** Question types `summarize` counts by option. */
const COUNTED: FormField['type'][] = ['select', 'radio', 'checkboxes', 'rating'];

const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

function urls(ctx: ToolContext, f: { id: number; slug: string; status: string }) {
	return { url: `${ctx.baseUrl}/forms/${f.id}`, public_url: f.status === 'published' ? `${ctx.baseUrl}/f/${f.slug}` : null };
}

/** A form by `form_id` (or `slug`). */
export async function requireForm(ctx: ToolContext, input: Record<string, unknown>): Promise<FormRow> {
	const id = intArg(input, 'form_id', { min: 1 });
	const slug = strArg(input, 'slug', 80);
	if (!id && !slug) throw new ToolInputError('"form_id" is required.');
	const f = await getForm(ctx.db, id ?? slug);
	if (!f) throw new ToolInputError(id ? `No form with id ${id}.` : `No form at /f/${slug}.`);
	return f;
}

/** The spec as the model sees it: the notify webhook address left out. */
function shownSpec(spec: FormSpec): FormSpec {
	return { ...spec, settings: { ...spec.settings, notify_webhook: '' } };
}

/** Answers as `key: value` lines, in question order (keys older versions had come last). */
function answerLines(spec: FormSpec, answers: SubmissionRow['answers']): string[] {
	const fields = spec.fields.filter((f) => isAnswerType(f.type) && answers[f.key] !== undefined);
	const known = new Set(fields.map((f) => f.key));
	return [
		...fields.map((f) => `${f.key}: ${answerText(answers[f.key], f)}`),
		...Object.keys(answers)
			.filter((k) => !known.has(k))
			.map((k) => `${k}: ${answerText(answers[k])}`)
	];
}

/** Counts by option for the choice and rating questions over the given rows. */
function optionCounts(spec: FormSpec, rows: SubmissionRow[]) {
	return spec.fields
		.filter((f) => COUNTED.includes(f.type))
		.map((f) => {
			const counts = new Map<string, number>(f.type === 'rating' ? [] : f.options.map((o): [string, number] => [o.value, 0]));
			let answered = 0;
			for (const r of rows) {
				const v = r.answers[f.key];
				if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
				answered++;
				for (const x of Array.isArray(v) ? v : [v]) counts.set(String(x), (counts.get(String(x)) ?? 0) + 1);
			}
			const label = (value: string) => f.options.find((o) => o.value === value)?.label ?? value;
			const options = [...counts.entries()].map(([value, count]) => ({ option: label(value), count }));
			if (f.type === 'rating') options.sort((a, b) => Number(a.option) - Number(b.option));
			return { key: f.key, question: f.label, answered, options };
		});
}

export const formTools: Tool[] = [
	{
		name: 'list_forms',
		tier: 'read',
		description:
			'Forms (newest edit first): id, name, slug, status (draft / published / archived), accepted submissions in the last 7 days and in total, last submission, the builder url and the public url (published only). Archived forms only with include_archived or status "archived".',
		input_schema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: FORM_STATUSES },
				include_archived: { type: 'boolean', description: 'Also list archived forms (default false).' }
			}
		},
		summarize: (input) => (typeof input.status === 'string' ? input.status : 'all forms'),
		handler: async (ctx, input) => {
			const status = strArg(input, 'status', 10);
			if (status && !FORM_STATUSES.includes(status)) throw new ToolInputError('status must be draft, published or archived.');
			let rows: FormListRow[] = await listForms(ctx.db);
			if (status === 'archived' || input.include_archived === true) rows = [...rows, ...(await listForms(ctx.db, { archived: true }))];
			if (status) rows = rows.filter((r) => r.status === status);
			const weekAgo = sqlTs(new Date(ctx.now.getTime() - 7 * 86_400_000));
			const forms = [];
			for (const r of rows) {
				const week = await listSubmissions(ctx.db, r.id, { after: weekAgo, limit: 1 });
				forms.push({
					id: r.id,
					name: r.name,
					slug: r.slug,
					status: r.status,
					submissions_7d: week.total,
					submissions_total: r.submissions,
					last_submission_at: r.last_submission_at,
					updated_at: r.updated_at,
					...urls(ctx, r)
				});
			}
			return { count: forms.length, forms };
		}
	},
	{
		name: 'get_form',
		tier: 'read',
		description:
			'One form: status, whether the assistant may edit it (drafts only), the form in words (`outline`: questions, show rules, page jumps, outcomes, settings) and its whole `spec` (the create_form_draft / update_form format, field ids included). Read it before update_form and pass the edited spec back. The notify webhook address is never shown.',
		input_schema: {
			type: 'object',
			properties: {
				form_id: { type: 'integer', description: 'Form id.' },
				slug: { type: 'string', description: 'Instead of form_id: the form address (/f/<slug>).' }
			}
		},
		summarize: (input) => (input.form_id ? `form #${input.form_id}` : String(input.slug ?? '')),
		handler: async (ctx, input) => {
			const f = await requireForm(ctx, input);
			const subs = await listSubmissions(ctx.db, f.id, { limit: 1 });
			return {
				id: f.id,
				name: f.name,
				slug: f.slug,
				status: f.status,
				editable: f.status === 'draft',
				version: f.version,
				updated_at: f.updated_at,
				published_at: f.published_at,
				submissions: subs.total,
				notify_webhook: f.spec.settings.notify_webhook ? 'set (address not shown)' : 'off',
				...urls(ctx, f),
				summary: formCounts(f.spec),
				outline: await formOutline(ctx.db, f.spec),
				spec: shownSpec(f.spec)
			};
		}
	},
	{
		name: 'get_form_submissions',
		tier: 'read',
		description:
			'A form\'s submissions, newest first (≤ 200): when, status, email, contact and the answers as "key: value" lines. Filters: since (YYYY-MM-DD or ISO date-time, after it), status (ok = added / updated / anonymous, the default; hidden = spam + rejected; or one status), search (email or answer text contains). summarize: true adds counts by option for the dropdown, multiple-choice, checkbox-list and rating questions over every matching submission (up to 5,000).',
		input_schema: {
			type: 'object',
			properties: {
				form_id: { type: 'integer', description: 'Form id.' },
				since: { type: 'string', description: 'YYYY-MM-DD or an ISO date-time (UTC).' },
				status: { type: 'string', enum: SUBMISSION_STATUSES },
				search: { type: 'string', description: 'Email or answer text contains.' },
				limit: { type: 'integer', minimum: 1, maximum: SUBMISSIONS_MAX, description: 'Max rows (default 50).' },
				summarize: { type: 'boolean', description: 'Add counts by option.' }
			},
			required: ['form_id']
		},
		summarize: (input) => `form #${input.form_id}`,
		handler: async (ctx, input) => {
			const f = await requireForm(ctx, input);
			const since = parseSince(strArg(input, 'since', 40) || null);
			if (since === null) throw new ToolInputError('since must be a date (YYYY-MM-DD) or an ISO date-time.');
			const status = strArg(input, 'status', 10) || 'ok';
			if (!SUBMISSION_STATUSES.includes(status)) throw new ToolInputError(`status must be one of: ${SUBMISSION_STATUSES.join(', ')}.`);
			const limit = intArg(input, 'limit', { min: 1, max: SUBMISSIONS_MAX }) ?? 50;
			const summarize = input.summarize === true;
			const filter: SubmissionFilter = {
				status: status as SubmissionFilter['status'],
				after: since ?? null,
				q: strArg(input, 'search', 200) || null,
				limit: summarize ? CSV_MAX_ROWS : limit
			};
			const res = await listSubmissions(ctx.db, f.id, filter);
			return {
				form_id: f.id,
				form: f.name,
				total: res.total,
				returned: Math.min(limit, res.rows.length),
				submissions: res.rows.slice(0, limit).map((r) => ({
					id: r.id,
					submitted_at: r.created_at,
					status: r.status,
					email: r.email,
					contact_id: r.contact_id,
					contact: r.contact_name,
					contact_url: r.contact_id ? `${ctx.baseUrl}/contacts/${r.contact_id}` : null,
					answers: answerLines(f.spec, r.answers)
				})),
				...(summarize ? { counted: res.rows.length, summary: optionCounts(f.spec, res.rows) } : {})
			};
		}
	}
];

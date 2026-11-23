import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import { formWebhookSecret } from '$lib/server/form-webhook';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	archiveForm,
	deleteSubmission,
	duplicateForm,
	getForm,
	listSubmissions,
	publishForm,
	restoreForm,
	saveForm,
	unpublishForm,
	parseSubmissionFilter
} from '$lib/server/forms';
import { topicPicker } from '$lib/server/topics';
import { formFieldPicker } from '$lib/server/custom-fields';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { automationsForForm } from '$lib/server/form-trigger';
import { createAutomation } from '$lib/server/automation-write';
import { listActiveAutomations } from '$lib/server/automations';
import { formScoreRules } from '$lib/server/scoring/form-rules';
import { answerQuestions } from '$lib/scoring';

const PAGE_SIZE = 50;

/** The builder (#509). Members can look (and read submissions); every change is admin-only. */
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	const form = Number.isInteger(id) && id > 0 ? await getForm(db, id) : null;
	if (!form) throw error(404, 'Form not found');
	const isAdmin = event.locals.user?.role === 'admin';

	const filter = parseSubmissionFilter(event.url.searchParams);
	// #619: keys the form already maps to stay offered (by label) even when archived since.
	const usedKeys = new Set<string>();
	for (const f of form.spec.fields) if (f.map?.to === 'meta') usedKeys.add(f.map.key);
	for (const o of form.spec.outcomes) for (const a of o.actions) if (a.type === 'set_field') usedKeys.add(a.key);
	const [subs, lists, topics, users, customFields, tags, baseUrl] = await Promise.all([
		listSubmissions(db, form.id, { ...filter, limit: PAGE_SIZE, offset: (filter.page - 1) * PAGE_SIZE }),
		db
			.prepare("SELECT id, name FROM lists WHERE kind = 'list' AND archived_at IS NULL ORDER BY name COLLATE NOCASE")
			.all<{ id: number; name: string }>(),
		topicPicker(db),
		isAdmin
			? db
					.prepare('SELECT id, github_login AS login, email FROM users WHERE disabled_at IS NULL ORDER BY github_login COLLATE NOCASE')
					.all<{ id: number; login: string; email: string | null }>()
			: Promise.resolve({ results: [] as { id: number; login: string; email: string | null }[] }),
		formFieldPicker(db, [...usedKeys]),
		db.prepare("SELECT name FROM lists WHERE kind = 'tag' ORDER BY name COLLATE NOCASE LIMIT 500").all<{ name: string }>(),
		publicBaseUrlFor(event)
	]);
	// #516: the Settings tab's Automations section. #514: active automations for the Logic tab's
	// "Enroll in automation" action.
	const [automations, activeAutomations] = await Promise.all([automationsForForm(db, form.id), listActiveAutomations(db)]);

	// Lists already used by the form stay offered even when archived since.
	const usedLists = new Set<number>();
	for (const f of form.spec.fields) if (f.map?.to === 'list') usedLists.add(f.map.list_id);
	for (const o of form.spec.outcomes) for (const a of o.actions) if (a.type === 'add_to_list') usedLists.add(a.list_id);
	const listRows = [...lists.results];
	const missing = [...usedLists].filter((l) => !listRows.some((r) => r.id === l));
	if (missing.length) {
		const extra = await db
			.prepare("SELECT id, name || ' (archived)' AS name FROM lists WHERE kind = 'list' AND id IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(missing))
			.all<{ id: number; name: string }>();
		listRows.push(...extra.results);
	}

	// #621: the Settings tab's Scoring section (admins only).
	const scoreRules = isAdmin ? await formScoreRules(db, form.id, answerQuestions(form.spec.fields)) : [];
	// #620: the webhook's signing key (derived from SESSION_SECRET), admins only.
	const webhookSecret = isAdmin ? await formWebhookSecret(event.platform?.env?.SESSION_SECRET, form.id) : null;

	return {
		form,
		isAdmin,
		scoreRules,
		webhookSecret,
		baseUrl,
		lists: listRows,
		topics,
		users: users.results,
		customFields,
		tags: tags.results.map((r) => r.name),
		submissions: subs.rows,
		submissionTotal: subs.total,
		automations,
		activeAutomations,
		filter,
		pageSize: PAGE_SIZE
	};
};

function adminOnly(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Only admins can change forms.');
	return event.locals.user.id;
}

const formId = (event: { params: Record<string, string> }) => Number(event.params.id);

export const actions: Actions = {
	save: async (event) => {
		const uid = adminOnly(event);
		const data = await event.request.formData();
		let spec: unknown;
		try {
			spec = JSON.parse(String(data.get('spec') ?? '{}'));
		} catch {
			return fail(400, { error: 'The form couldn’t be read. Reload and try again.', problems: [] });
		}
		const res = await saveForm(
			getDB(event),
			formId(event),
			{ name: String(data.get('name') ?? ''), slug: String(data.get('slug') ?? ''), spec },
			uid
		);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Form not found');
			return fail(res.status, { error: res.error, problems: res.problems });
		}
		return { saved: true, version: res.form.version };
	},
	publish: async (event) => {
		const uid = adminOnly(event);
		const res = await publishForm(getDB(event), formId(event), uid);
		if (!res.ok) {
			if (res.status === 404) throw error(404, 'Form not found');
			return fail(res.status, { error: res.error, problems: res.problems });
		}
		return { published: true };
	},
	unpublish: async (event) => {
		const uid = adminOnly(event);
		await unpublishForm(getDB(event), formId(event), uid);
		return { unpublished: true };
	},
	archive: async (event) => {
		const uid = adminOnly(event);
		await archiveForm(getDB(event), formId(event), uid);
		return { archived: true };
	},
	restore: async (event) => {
		const uid = adminOnly(event);
		await restoreForm(getDB(event), formId(event), uid);
		return { restored: true };
	},
	duplicate: async (event) => {
		const uid = adminOnly(event);
		const id = await duplicateForm(getDB(event), formId(event), uid);
		if (!id) throw error(404, 'Form not found');
		throw redirect(303, `/forms/${id}`);
	},
	// #516: a draft automation with the "Form submitted" trigger set to this form. Same rule as
	// /automations' create (members and admins); activation stays manual on the automation page.
	createAutomation: async (event) => {
		const db = getDB(event);
		const form = await getForm(db, formId(event));
		if (!form) throw error(404, 'Form not found');
		const created = await createAutomation(
			db,
			{ name: `When “${form.name}” is submitted`.slice(0, 200), trigger: { type: 'form_submitted', form_id: form.id, filter: null } },
			{ kind: 'user', id: event.locals?.user?.id ?? null }
		);
		if (!created.ok) return fail(400, { error: created.error });
		throw redirect(303, `/automations/${created.data.automation_id}`);
	},
	deleteSubmission: async (event) => {
		adminOnly(event);
		const sid = Number((await event.request.formData()).get('submission_id'));
		if (!Number.isInteger(sid) || sid <= 0) return fail(400, { error: 'Missing submission.' });
		const ok = await deleteSubmission(getDB(event), formId(event), sid);
		return ok ? { deleted: true } : fail(404, { error: 'Submission not found.' });
	}
};

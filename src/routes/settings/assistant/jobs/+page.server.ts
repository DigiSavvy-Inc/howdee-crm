import { supportsTools } from '$lib/ai-models';
import { modelCatalog } from '$lib/server/ai/providers';
import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { formatLocal } from '$lib/server/businessdays';
import { getSettings, timezoneOptions } from '$lib/server/settings';
import { getAssistantConfig } from '$lib/server/ai/config';
import { keyStoreReady } from '$lib/server/ai/key';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { jobEmailSender } from '$lib/server/job-email-send';
import { adminRecipientOptions, parseEmailSelection, reviewToAddress } from '$lib/server/ai/jobs-email';
import {
	RUN_NOW_DEADLINE_MS,
	createDigestJob,
	deleteJob,
	getJob,
	jobDefaults,
	jobRuns,
	jobView,
	listJobs,
	runJob,
	saveJob,
	sendTestPayload,
	setJobEnabled,
	validateJobInput
} from '$lib/server/ai/jobs';

// Settings → Assistant → Jobs (#303): scheduled, read-only assistant runs posted to a webhook.
// Admin-only — load AND every action (it sits next to the key and the spend caps). The
// signing secret is write-only: only its last 4 characters reach the page.

const isAdmin = (event: { locals: App.Locals }) => event.locals.user?.role === 'admin';

/** A stored UTC 'YYYY-MM-DD HH:MM:SS' as local text in `tz`. */
function localText(utc: string | null, tz: string): string | null {
	if (!utc) return null;
	const d = new Date(`${utc.replace(' ', 'T')}Z`);
	if (Number.isNaN(d.getTime())) return utc;
	try {
		return formatLocal(d, tz);
	} catch {
		return `${utc} UTC`;
	}
}

function jobId(raw: FormDataEntryValue | string | null): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function fields(form: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
	// #390: the admin checkboxes repeat `email_to`.
	out.email_to = form.getAll('email_to').filter((v): v is string => typeof v === 'string').join(',');
	return out;
}

/** The emailed-report sender for this request (#390). */
async function emailSender(event: Parameters<PageServerLoad>[0] | Parameters<Actions[string]>[0]) {
	return jobEmailSender(getDB(event), event.platform?.env ?? {}, await publicBaseUrlFor(event));
}

export const load: PageServerLoad = async (event) => {
	if (!isAdmin(event)) throw error(403, 'Admins only.');
	const db = getDB(event);
	const cfg = await getAssistantConfig(db);
	const selectedId = jobId(event.url.searchParams.get('job'));
	const [jobs, defaults, selected, runs, admins] = await Promise.all([
		listJobs(db),
		jobDefaults(db, cfg),
		selectedId ? jobView(db, selectedId) : Promise.resolve(null),
		selectedId ? jobRuns(db, selectedId) : Promise.resolve([]),
		adminRecipientOptions(db)
	]);
	if (selectedId && !selected) throw error(404, 'Job not found.');
	const tzOf = (tz: string) => tz || defaults.timezone;
	return {
		jobs: jobs.map((j) => ({ ...j, next_run_text: localText(j.next_run_at, tzOf(j.timezone)), last_run_text: localText(j.last_run_at, tzOf(j.timezone)) })),
		job: selected ? { ...selected, email_to: parseEmailSelection(selected.email_admins) } : null,
		runs: runs.map((r) => ({ ...r, started_text: localText(r.started_at, tzOf(selected?.timezone ?? '')) })),
		allowedModels: cfg.allowedModels,
		// #696: the catalog (built-in + the install's other providers), tool-capable only.
		models: modelCatalog(cfg)
			.filter((m) => supportsTools(m))
			.map((m) => ({ id: m.id, label: m.label, efforts: [...m.efforts] })),
		defaults,
		timezones: timezoneOptions(selected?.timezone ?? defaults.timezone),
		secretStoreReady: keyStoreReady(event.platform?.env),
		admins,
		reviewTo: reviewToAddress(event.platform?.env, (await getSettings(db)).default_from),
		me: event.locals.user!.id,
		isNew: event.url.searchParams.has('new')
	};
};

export const actions: Actions = {
	save: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const f = fields(await event.request.formData());
		const id = jobId(f.id ?? null);
		const v = validateJobInput(f, await getAssistantConfig(db));
		if (!v.ok) return fail(400, { error: v.error });
		const saved = await saveJob(db, event.platform?.env, id, v.value, event.locals.user!.id);
		if (!saved.ok) return fail(400, { error: saved.error });
		throw redirect(303, `/settings/assistant/jobs?job=${saved.id}&saved=1`);
	},

	toggle: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const f = await event.request.formData();
		const id = jobId(f.get('id'));
		if (!id || !(await setJobEnabled(getDB(event), id, f.get('enabled') === '1'))) return fail(404, { error: 'Job not found.' });
		return { toggled: id };
	},

	delete: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const id = jobId((await event.request.formData()).get('id'));
		if (!id || !(await deleteJob(getDB(event), id))) return fail(404, { error: 'Job not found.' });
		throw redirect(303, '/settings/assistant/jobs?deleted=1');
	},

	// Synchronous, 60 s limit. Same checks and caps as a scheduled run; next_run_at is untouched.
	// Global fetch, NOT event.fetch (it adds Origin, which Anthropic treats as a browser call).
	runNow: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = jobId((await event.request.formData()).get('id'));
		const job = id ? await getJob(db, id) : null;
		if (!job) return fail(404, { error: 'Job not found.' });
		const r = await runJob(db, event.platform?.env, job, {
			trigger: 'manual',
			fetch,
			deadlineMs: RUN_NOW_DEADLINE_MS,
			emailSender: await emailSender(event)
		});
		return { runResult: r };
	},

	// #390 "Send me a test now": a real run out of schedule (same checks, counts against the
	// caps), emailed to the clicking admin ONLY — never the job's recipients, never the webhook.
	testEmail: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = jobId((await event.request.formData()).get('id'));
		const job = id ? await getJob(db, id) : null;
		if (!job) return fail(404, { error: 'Job not found.' });
		const r = await runJob(db, event.platform?.env, job, {
			trigger: 'manual',
			fetch,
			deadlineMs: RUN_NOW_DEADLINE_MS,
			emailSender: await emailSender(event),
			testRecipient: event.locals.user!.id
		});
		return { runResult: r, testEmail: true };
	},

	// #390: one click creates the "Weekly digest" job (Monday 07:00, email to admins).
	createDigest: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const saved = await createDigestJob(db, event.platform?.env, await getAssistantConfig(db), event.locals.user!.id);
		if (!saved.ok) return fail(400, { error: saved.error });
		throw redirect(303, `/settings/assistant/jobs?job=${saved.id}&saved=1`);
	},

	sendTest: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = jobId((await event.request.formData()).get('id'));
		const job = id ? await getJob(db, id) : null;
		if (!job) return fail(404, { error: 'Job not found.' });
		return { testResult: await sendTestPayload(db, event.platform?.env, job, { fetch }) };
	}
};

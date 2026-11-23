import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { deleteCompany, getCompany, updateCompany } from '$lib/server/companies';
import { contactsOrder } from '$lib/server/contacts-query';
import { activeContactSql } from '$lib/server/active-audience';
import {
	githubProviderFor,
	resolveIntegrationEnv,
	runProviderSync,
	timingProvider,
	zohoBooksProvider,
	zohoProviderFor,
	type IntegrationEnv
} from '$lib/server/integrations';
import { attachTimingProject, companyTiming, detachTimingProject } from '$lib/server/integrations/timing';
import { attachRepo, companyRepos, githubMetrics, removeRepo } from '$lib/server/integrations/github';
import { canSeeBilling, companyBilling, linkCustomer, unlinkCustomer } from '$lib/server/integrations/zoho';
import { evaluateMetricCrossings } from '$lib/server/metric-trigger';
import { generateBrief, latestBrief, setBriefFeedback } from '$lib/server/ai/account-brief';
import { availability, getAssistantConfig } from '$lib/server/ai/config';
import { loadCompanyDashboard } from '$lib/server/company-dashboard';
import { getTimezone } from '$lib/server/settings';
import { companyTimeline } from '$lib/server/company-timeline';
import { companyConversations, conversationPanelRows } from '$lib/server/company-conversations';
import { companyHistory } from '$lib/server/reports/history';
import { HOURS_SPARK_WEEKS, weeklyHours } from '$lib/company-panels';

const PER_OPTIONS = [25, 50, 100, 200];

function companyId(raw: string | undefined): number {
	const id = Number(raw);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Company not found');
	return id;
}

// /companies/[id] (#166) — header (name/domain/website/notes, inline-editable), the linked
// contacts with the same sort + pager as /contacts, and the Integrations card (Timing #168,
// GitHub repos #169), and the Billing panel (Zoho Books #353 — admins, or members when the
// Settings → Integrations switch allows it; without access nothing billing is loaded).

// Tokens resolve in-app first (encrypted, #175), then the Worker secrets.
async function integrationEnv(event: { platform?: App.Platform }): Promise<IntegrationEnv> {
	const e = event.platform?.env;
	return resolveIntegrationEnv(getDB(event), {
		TIMING_API_TOKEN: e?.TIMING_API_TOKEN,
		GITHUB_TOKEN: e?.GITHUB_TOKEN,
		MAIL_TOKEN_KEY: e?.MAIL_TOKEN_KEY
	});
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = companyId(event.params.id);
	const company = await getCompany(db, id);
	if (!company) throw error(404, 'Company not found');
	const env = await integrationEnv(event);

	const { sort, dir, orderExpr } = contactsOrder(event.url.searchParams);
	let per = Number(event.url.searchParams.get('per')) || 50;
	if (!PER_OPTIONS.includes(per)) per = 50;
	const pageCount = Math.max(1, Math.ceil(company.contact_count / per));
	let page = Math.floor(Number(event.url.searchParams.get('page')) || 1);
	if (page < 1) page = 1;
	if (page > pageCount) page = pageCount;

	const contacts = await db
		.prepare(
			`SELECT id, email, name, first_name, last_name, company, subscribed, source, created_at
			 FROM contacts WHERE company_id = ? AND ${activeContactSql()} ORDER BY ${orderExpr} LIMIT ? OFFSET ?`
		)
		.bind(id, per, (page - 1) * per)
		.all<{
			id: number;
			email: string;
			name: string | null;
			first_name: string | null;
			last_name: string | null;
			company: string | null;
			subscribed: number;
			source: string | null;
			created_at: string;
		}>();

	// Account brief (#388): the newest one this user may see (Zoho figures only with billing access).
	const seeBilling = await canSeeBilling(db, event.locals.user);
	const avail = event.locals.user ? await availability(db, await getAssistantConfig(db), event.platform?.env, event.locals.user) : null;

	const tz = await getTimezone(db);
	const now = new Date();
	const timing = await companyTiming(db, id);
	// #567: weekly hours for the Timing panel's sparkline (daily snapshots, #358).
	const hoursWeekly = timing?.timing_synced_at
		? weeklyHours(await companyHistory(db, 'hours_7d', { days: HOURS_SPARK_WEEKS * 7 + 7, now, companyId: id }), now)
		: null;

	return {
		company,
		tz,
		// #564: the at-a-glance strip (billing figures only with billing access).
		dashboard: await loadCompanyDashboard(db, id, { billing: seeBilling, tz }),
		// #566: the account timeline (`?tl=` source chip, `?tl_n=` size; billing rows only with access).
		timeline: await companyTimeline(db, id, {
			billing: seeBilling,
			filter: event.url.searchParams.get('tl'),
			size: event.url.searchParams.get('tl_n')
		}),
		brief: await latestBrief(db, id, seeBilling, event.locals.user?.id ?? null),
		briefCanGenerate: !!avail?.available,
		briefUnavailable: avail && !avail.available ? avail.message : null,
		contacts: contacts.results,
		sort,
		dir: dir === 'ASC' ? 'asc' : 'desc',
		page,
		per,
		pageCount,
		perOptions: PER_OPTIONS,
		// #567: streamed — threading every contact's mail mustn't hold up first paint.
		conversations: companyConversations(db, id, { now })
			.then((threads) => conversationPanelRows(threads))
			.catch((e) => {
				console.error('company conversations failed:', e);
				return null;
			}),
		timing,
		hoursWeekly,
		timingConfigured: timingProvider.isConfigured(env),
		github: {
			configured: !!env.GITHUB_TOKEN?.trim(),
			repos: await companyRepos(db, id),
			metrics: await githubMetrics(db, id)
		},
		billing: seeBilling
			? { configured: zohoBooksProvider.isConfigured(env), ...(await companyBilling(db, company)) }
			: null
	};
};

/** Billing actions need the same access as the panel. */
async function billingGuard(event: { locals: App.Locals; platform?: App.Platform }) {
	if (!(await canSeeBilling(getDB(event), event.locals.user))) throw error(403, 'Billing is admin-only.');
}

export const actions: Actions = {
	// Inline edit of one or more header fields — only the fields present in the form change.
	update: async (event) => {
		const id = companyId(event.params.id);
		const data = await event.request.formData();
		const input: Record<string, unknown> = {};
		for (const k of ['name', 'domain', 'website', 'notes']) {
			if (data.has(k)) input[k] = data.get(k);
		}
		const res = await updateCompany(getDB(event), id, input);
		if (!res.ok) {
			const msg =
				res.error === 'exists'
					? 'Another company already has that name.'
					: res.error === 'name_required'
						? 'Name cannot be empty.'
						: 'Company not found.';
			return fail(res.error === 'not_found' ? 404 : 400, { error: msg });
		}
		return { ok: true };
	},

	// Timing (#168): attach a project picked from /api/integrations/timing/projects.
	attachTiming: async (event) => {
		const id = companyId(event.params.id);
		const data = await event.request.formData();
		const projectId = String(data.get('project_id') ?? '').trim();
		if (!/^\/projects\/\d+$/.test(projectId)) return fail(400, { timingError: 'Pick a Timing project.' });
		await attachTimingProject(getDB(event), id, projectId, String(data.get('project_name') ?? '').trim());
		return { timingOk: 'attached' };
	},

	detachTiming: async (event) => {
		await detachTimingProject(getDB(event), companyId(event.params.id));
		return { timingOk: 'detached' };
	},

	// Sync now — this company only, through the shared runner (lease + integration_syncs row).
	syncTiming: async (event) => {
		const id = companyId(event.params.id);
		const env = await integrationEnv(event);
		const r = await runProviderSync(getDB(event), env, timingProvider, 'manual', { companyId: id });
		if ('skipped' in r) {
			return fail(409, {
				timingError: r.skipped === 'locked' ? 'A Timing sync is already running — try again in a minute.' : 'Timing is not connected — add a token in Settings → Integrations.'
			});
		}
		if (!r.ok) return fail(502, { timingError: 'error' in r.detail ? r.detail.error : 'Sync failed.' });
		if ('errors' in r.detail && r.detail.errors.length) return fail(502, { timingError: r.detail.errors[0] });
		return { timingOk: 'synced' };
	},

	// GitHub (#169): attach a repo (`owner/repo` or a GitHub URL), validated against the API.
	addRepo: async (event) => {
		const id = companyId(event.params.id);
		const data = await event.request.formData();
		const db = getDB(event);
		if (!(await getCompany(db, id))) return fail(404, { repoError: 'Company not found.' });
		const res = await attachRepo(db, await integrationEnv(event), id, String(data.get('repo') ?? ''));
		if (!res.ok) return fail(400, { repoError: res.error });
		return { repoAdded: res.fullName };
	},

	removeRepo: async (event) => {
		const id = companyId(event.params.id);
		const data = await event.request.formData();
		await removeRepo(getDB(event), id, Number(data.get('repo_id')));
		return { ok: true };
	},

	// Sync now: this company's repos only, through the shared runner (logged + locked).
	syncGithub: async (event) => {
		const id = companyId(event.params.id);
		const result = await runProviderSync(getDB(event), await integrationEnv(event), githubProviderFor(id), 'manual');
		if ('skipped' in result) {
			return fail(409, {
				repoError:
					result.skipped === 'locked' ? 'A GitHub sync is already running — try again in a minute.' : 'GitHub is not connected — add a token in Settings → Integrations.'
			});
		}
		if (!result.ok) return fail(502, { repoError: 'error' in result.detail ? result.detail.error : 'Sync failed.' });
		const errs = 'errors' in result.detail ? result.detail.errors : [];
		return { synced: true, syncErrors: errs };
	},

	// Zoho Books (#353): link a customer picked from search or a suggestion; never auto-linked.
	linkZoho: async (event) => {
		await billingGuard(event);
		const id = companyId(event.params.id);
		const data = await event.request.formData();
		const db = getDB(event);
		if (!(await getCompany(db, id))) return fail(404, { zohoError: 'Company not found.' });
		const res = await linkCustomer(
			db,
			id,
			{ zoho_contact_id: String(data.get('zoho_contact_id') ?? ''), contact_name: String(data.get('contact_name') ?? '') },
			event.locals.user?.id ?? null
		);
		if (!res.ok) return fail(400, { zohoError: res.error });
		// #439: pull this company's invoices + payments right away so the panel isn't empty. The
		// link stays whatever the sync does; a held lock or an error is only reported.
		const r = await runProviderSync(db, await integrationEnv(event), zohoProviderFor(id), 'manual');
		if ('skipped' in r) return { zohoOk: 'linked', zohoNote: 'Linked. Figures arrive with the next sync.' };
		const err = !r.ok ? ('error' in r.detail ? r.detail.error : 'Sync failed.') : 'errors' in r.detail && r.detail.errors.length ? r.detail.errors[0] : null;
		if (err) return { zohoOk: 'linked', zohoError: `Linked, but the sync failed: ${err}` };
		return { zohoOk: 'linked' };
	},

	// Unlink deletes that customer's mirrored invoices + payments.
	unlinkZoho: async (event) => {
		await billingGuard(event);
		const data = await event.request.formData();
		const db = getDB(event);
		await unlinkCustomer(db, companyId(event.params.id), Number(data.get('link_id')));
		// #445: the billing roll-up just changed — let "Company metric crossed" triggers compare (link
		// does this through its runProviderSync).
		await evaluateMetricCrossings(db).catch((e) => console.error('metric crossings failed:', e));
		return { zohoOk: 'unlinked' };
	},

	syncZoho: async (event) => {
		await billingGuard(event);
		const id = companyId(event.params.id);
		const r = await runProviderSync(getDB(event), await integrationEnv(event), zohoProviderFor(id), 'manual');
		if ('skipped' in r) {
			return fail(409, {
				zohoError: r.skipped === 'locked' ? 'A Zoho Books sync is already running — try again in a minute.' : 'Zoho Books is not connected — see Settings → Integrations.'
			});
		}
		if (!r.ok) return fail(502, { zohoError: 'error' in r.detail ? r.detail.error : 'Sync failed.' });
		if ('errors' in r.detail && r.detail.errors.length) return fail(502, { zohoError: r.detail.errors[0] });
		return { zohoOk: 'synced' };
	},

	// Account brief (#388): Generate / Refresh — the viewer's variant only; unchanged sources skip the call.
	generateBrief: async (event) => {
		const id = companyId(event.params.id);
		const db = getDB(event);
		const user = event.locals.user;
		if (!user) throw error(401, 'Sign in first.');
		if (!(await getCompany(db, id))) return fail(404, { briefError: 'Company not found.' });
		const r = await generateBrief(db, event.platform?.env, id, { billing: await canSeeBilling(db, user), trigger: 'manual', user });
		if (r.status === 'skipped') return fail(409, { briefError: r.message });
		if (r.status === 'error') return fail(502, { briefError: r.message });
		return { briefOk: r.status };
	},

	// Thumbs up / down on the brief shown (same vote again clears it).
	briefFeedback: async (event) => {
		const db = getDB(event);
		const user = event.locals.user;
		if (!user) throw error(401, 'Sign in first.');
		const data = await event.request.formData();
		const vote = Number(data.get('vote'));
		if (vote !== 1 && vote !== -1) return fail(400, { briefError: 'Pick thumbs up or down.' });
		const ok = await setBriefFeedback(db, Number(data.get('brief_id')), user.id, vote, await canSeeBilling(db, user));
		if (!ok) return fail(404, { briefError: 'Brief not found.' });
		return { briefVoted: true };
	},

	// Delete (confirmed client-side). Contacts keep their company text; company_id is nulled.
	delete: async (event) => {
		const id = companyId(event.params.id);
		await deleteCompany(getDB(event), id);
		throw redirect(303, '/companies');
	}
};

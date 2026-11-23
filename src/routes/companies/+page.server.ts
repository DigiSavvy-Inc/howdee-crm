import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { createCompany, listCompanies } from '$lib/server/companies';
import { briefsForCompanies } from '$lib/server/ai/account-brief';
import { canSeeBilling } from '$lib/server/integrations/zoho';
import { loadCompanyOverview, sourceState } from '$lib/server/company-overview';
import { briefPlainText } from '$lib/account-brief';
import {
	billingVisible,
	defaultDirFor,
	defaultSortFor,
	parseCompanyFilter,
	parseCompanySort,
	visibleFilters
} from '$lib/company-overview';

const PER = 50;

// /companies (#166) — the companies entity: name, domain, people, signals. Live search ?q= (name
// or domain), mirrors /contacts. #436: an overview strip over every company, ?filter=
// (all|active|quiet|issues|overdue|unlinked), ?sort=name|hours_30d|open_issues|outstanding|last_touch
// &dir=asc|desc. Billing (tiles, Outstanding column, overdue filter, outstanding sort) only for a
// viewer who may see it — otherwise it never leaves this loader.
export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	const q = (params.get('q') ?? '').trim().slice(0, 100);
	let page = Math.floor(Number(params.get('page')) || 1);
	if (page < 1) page = 1;
	const db = getDB(event);
	const seeBilling = await canSeeBilling(db, event.locals.user);
	const ov = await loadCompanyOverview(db, { billing: seeBilling });
	const state = sourceState(ov, seeBilling);
	const billing = billingVisible(state);
	const filter = parseCompanyFilter(params.get('filter'), state);
	const sort = parseCompanySort(params.get('sort'), billing) ?? defaultSortFor(filter);
	const rawDir = params.get('dir');
	const dir: 'asc' | 'desc' = rawDir === 'asc' || rawDir === 'desc' ? rawDir : defaultDirFor(sort);
	const opts = { q, sort, dir, filter, billing, limit: PER };
	let res = await listCompanies(db, { ...opts, offset: (page - 1) * PER });
	const pageCount = Math.max(1, Math.ceil(res.total / PER));
	if (page > pageCount) {
		page = pageCount;
		res = await listCompanies(db, { ...opts, offset: (page - 1) * PER });
	}
	// Account brief one-liners (#388) — the variant this user may see (no Zoho figures without billing access).
	const briefs = await briefsForCompanies(db, res.rows.map((r) => r.id), seeBilling);
	const companies = res.rows.map((r) => {
		const b = briefs.get(r.id);
		return { ...r, brief_one_liner: b?.one_liner ?? null, brief_text: b ? briefPlainText(b.brief_md) : null };
	});
	const isAdmin = event.locals.user?.role === 'admin';
	return {
		q,
		filter,
		sort,
		dir,
		companies,
		total: res.total,
		page,
		pageCount,
		per: PER,
		state,
		billing,
		filters: visibleFilters(state).map((f) => ({ key: f.key, label: f.label })),
		overview: { ...ov, billing: billing ? ov.billing : null },
		// Admins only: what's linked per provider, with a way to connect Zoho.
		setup: isAdmin
			? { timing: ov.timing.linked, github: ov.github.linked, zohoConnected: ov.zoho.connected, zoho: ov.zoho.linked }
			: null
	};
};

export const actions: Actions = {
	create: async (event) => {
		const data = await event.request.formData();
		const res = await createCompany(getDB(event), {
			name: data.get('name'),
			domain: data.get('domain'),
			website: data.get('website')
		});
		if (!res.ok) {
			return fail(400, {
				error: res.error === 'exists' ? 'A company with that name already exists.' : 'Enter a name.',
				existingId: res.ok === false && res.error === 'exists' ? (res.id ?? null) : null
			});
		}
		throw redirect(303, `/companies/${res.id}`);
	}
};

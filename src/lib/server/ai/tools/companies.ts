// Companies read tools (#287): list/search, one company with metrics and contacts.

import { getCompany, listCompanies, serializeCompany } from '../../company-read';
import { companyMetrics } from '../../company-metrics';
import { canSeeBilling } from '../../integrations/zoho';
import { latestBrief } from '../account-brief';
import { contactBriefs } from './contacts';
import { activeContactSql } from '../../active-audience';
import { LIMIT_PROP, ToolInputError, intArg, limitArg, strArg, type Tool } from './types';

export const companyTools: Tool[] = [
	{
		name: 'list_companies',
		tier: 'read',
		description: 'Companies by name, optionally matching name/domain, or sorted by Timing hours (30 d) or open GitHub issues.',
		input_schema: {
			type: 'object',
			properties: {
				q: { type: 'string', description: 'Name or domain contains.' },
				sort: { type: 'string', enum: ['name', 'hours_30d', 'open_issues'] },
				dir: { type: 'string', enum: ['asc', 'desc'] },
				limit: LIMIT_PROP,
				offset: { type: 'integer', minimum: 0 }
			}
		},
		summarize: (input) => (input.q ? `"${input.q}"` : 'all companies'),
		handler: async (ctx, input) => {
			const sort = strArg(input, 'sort', 20);
			const { rows, total } = await listCompanies(ctx.db, {
				q: strArg(input, 'q', 100),
				sort: sort === 'hours_30d' || sort === 'open_issues' ? sort : 'name',
				dir: strArg(input, 'dir', 4) === 'desc' ? 'desc' : 'asc',
				limit: limitArg(input),
				offset: intArg(input, 'offset', { min: 0 }) ?? 0
			});
			return {
				total,
				companies: rows.map((r) => ({
					...serializeCompany(r),
					hours_30d: r.hours_30d,
					open_issues: r.issues_open,
					url: `${ctx.baseUrl}/companies/${r.id}`
				}))
			};
		}
	},
	{
		name: 'get_company',
		tier: 'read',
		description: 'One company: details, Timing hours and GitHub issue metrics, and its (non-archived) contacts.',
		input_schema: { type: 'object', properties: { company_id: { type: 'integer' }, limit: LIMIT_PROP }, required: ['company_id'] },
		summarize: (input) => `company #${input.company_id}`,
		handler: async (ctx, input) => {
			const id = intArg(input, 'company_id', { required: true, min: 1 })!;
			const row = await getCompany(ctx.db, id);
			if (!row) throw new ToolInputError(`No company with id ${id}.`);
			const ids = await ctx.db
				.prepare(`SELECT id FROM contacts WHERE company_id = ? AND ${activeContactSql()} ORDER BY id DESC LIMIT ?`)
				.bind(id, limitArg(input))
				.all<{ id: number }>();
			return {
				...serializeCompany(row),
				metrics: await companyMetrics(ctx.db, id),
				contacts: await contactBriefs(ctx, ids.results.map((r) => r.id)),
				url: `${ctx.baseUrl}/companies/${id}`
			};
		}
	},
	{
		// #388: the stored AI account brief — read-only, never generates (no model call here).
		// Zoho figures only for a user who may see billing (the no-billing variant otherwise).
		name: 'get_account_brief',
		tier: 'read',
		description:
			"A company's account brief: a short sourced summary of where things stand (contacts, conversations, pipeline, Timing, GitHub, billing when the user may see it), its one-liner, open items and source links. Use it first for questions like \"what's going on with Acme?\". It may be missing or a day old — then use get_company and the other tools.",
		input_schema: { type: 'object', properties: { company_id: { type: 'integer' } }, required: ['company_id'] },
		summarize: (input) => `company #${input.company_id}`,
		handler: async (ctx, input) => {
			const id = intArg(input, 'company_id', { required: true, min: 1 })!;
			const row = await getCompany(ctx.db, id);
			if (!row) throw new ToolInputError(`No company with id ${id}.`);
			const brief = await latestBrief(ctx.db, id, await canSeeBilling(ctx.db, ctx.user));
			const url = `${ctx.baseUrl}/companies/${id}`;
			if (!brief) return { company_id: id, name: row.name, brief: null, message: 'No brief yet — it can be generated on the company page.', url };
			return {
				company_id: id,
				name: row.name,
				generated_at: brief.generated_at,
				one_liner: brief.one_liner,
				brief_markdown: brief.brief_md,
				open_items: brief.open_items,
				sources: brief.sources.map((s) => ({ tag: s.tag, label: s.label, url: s.href.startsWith('/') ? `${ctx.baseUrl}${s.href}` : s.href })),
				url
			};
		}
	}
];

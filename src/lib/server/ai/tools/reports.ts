// #389: suggest_report and get_report_preview are read-only and never save a report. suggest_report runs the
// natural-language builder (its own model call, validated like the Reports page; usage is
// stored in a "Report builder" thread so the spend caps see it) and returns the spec, a
// readback and a /reports/new link. get_report_preview runs a spec, capped at 50 rows, with the
// signed-in user's report permissions.

// Report tools (#358): list reports, run one (built-in, saved or an ad-hoc spec), describe
// the metric catalog, and save a spec as a report. All reads go through
// ../../reports/access.ts with the signed-in user's role, so hours, billing and pipeline
// value stay admin-only. Saving a report changes no contacts; it is never pinned.
//
// Deliberately absent: saving results as a segment / list and bulk-tagging from a report
// (a human clicks that on /reports), and anything that sends, schedules or enrolls.

import {
	adminOnlyKeys,
	adminOnlyMessage,
	isReportEntity,
	parseReportSpec,
	ReportError,
	type ReportEntity,
	type ReportSpec,
	type ReportViewer
} from '$lib/report-spec';
import { encodeSpec, folderOf } from '$lib/report-view';
import { getAssistantConfig, spendCheck } from '../config';
import { loadPickers } from '../../reports/page';
import { runReport, type ReportResult } from '../../reports/engine';
import { buildReportFromText } from '../../reports/nl';
import {
	capRows,
	metricCatalog,
	paramSource,
	parseReportRef,
	reportCatalog,
	runAdHoc,
	runReportRef
} from '../../reports/access';
import { createReport, deleteReport, getReport } from '../../reports/store';
import { ToolInputError, UndoRefused, intArg, strArg, type ReadTool, type Tool, type ToolContext, type WriteTool } from './types';

export const RUN_REPORT_MAX_ROWS = 50;

const suggestReport: ReadTool = {
	name: 'suggest_report',
	tier: 'read',
	description:
		'Turn a plain-English report request ("open rate by campaign for Q3, worst first") into a validated report spec. ' +
		'Returns the spec, a one-line readback and a link that opens it in the report builder (nothing is saved). ' +
		'May return clarifying questions instead — ask the user them. Pass `current_spec` to refine a spec you built earlier.',
	input_schema: {
		type: 'object',
		properties: {
			description: { type: 'string', description: 'What the report should show, in the user’s words.' },
			current_spec: { type: 'object', description: 'Optional: a spec from an earlier suggest_report call to refine.' }
		},
		required: ['description']
	},
	summarize: (input) => String(input.description ?? '').slice(0, 80),
	async handler(ctx, input) {
		const description = strArg(input, 'description', 1000);
		if (!description) throw new ToolInputError('"description" is required.');
		if (!ctx.ai) throw new ToolInputError('suggest_report is only available in chat.');
		const spend = await spendCheck(ctx.db, await getAssistantConfig(ctx.db), ctx.user.id, ctx.now);
		if (!spend.ok) throw new ToolInputError(spend.message);
		let current: ReportSpec | null = null;
		if (input.current_spec && typeof input.current_spec === 'object') {
			try {
				current = parseReportSpec(input.current_spec);
			} catch {
				current = null;
			}
		}
		const out = await buildReportFromText(ctx.db, {
			user: { id: ctx.user.id, role: ctx.user.role },
			description,
			current,
			records: await loadPickers(ctx.db),
			provider: ctx.ai.provider,
			model: ctx.ai.model,
			effort: ctx.ai.effort,
			audit: false // a read tool: no ai_actions row (usage still lands in the "Report builder" thread)
		});
		if (out.kind === 'questions') return { questions: out.questions };
		if (out.kind === 'error') throw new ToolInputError([out.error, ...(out.understood.length ? [`Understood: ${out.understood.join('; ')}`] : [])].join(' '));
		return { spec: out.spec, readback: out.readback, url: out.href, saved: false };
	}
};

const getReportPreview: ReadTool = {
	name: 'get_report_preview',
	tier: 'read',
	description: `Run a report spec (from suggest_report) and return up to ${RUN_REPORT_MAX_ROWS} rows. Read-only; uses the user's report permissions.`,
	input_schema: {
		type: 'object',
		properties: { spec: { type: 'object', description: 'A report spec, as suggest_report returns it.' } },
		required: ['spec']
	},
	summarize: (input) => {
		const spec = input.spec as { entity?: unknown } | undefined;
		return typeof spec?.entity === 'string' ? spec.entity : 'report';
	},
	async handler(ctx, input) {
		if (!input.spec || typeof input.spec !== 'object' || Array.isArray(input.spec)) throw new ToolInputError('"spec" must be an object.');
		try {
			const raw = input.spec as Record<string, unknown>;
			const asked = typeof raw.limit === 'number' && Number.isInteger(raw.limit) && raw.limit > 0 ? raw.limit : RUN_REPORT_MAX_ROWS;
			const spec = parseReportSpec({ ...raw, limit: Math.min(asked, RUN_REPORT_MAX_ROWS) });
			const result = await runReport(ctx.db, spec, { role: ctx.user.role });
			return {
				columns: result.columns.map((c) => ({ key: c.key, label: c.label, format: c.format })),
				rows: result.rows,
				total: result.total,
				truncated: result.truncated,
				url: `/reports/new?spec=${encodeSpec(spec)}`
			};
		} catch (e) {
			if (e instanceof ReportError) throw new ToolInputError(e.message);
			throw e;
		}
	}
};

const ROWS_DEFAULT = 50;
const ROWS_MAX = 200;

function viewerOf(ctx: ToolContext): ReportViewer {
	return { role: ctx.user.role === 'admin' ? 'admin' : 'member' };
}

function rowsOut(result: ReportResult, max: number) {
	const capped = capRows(result, max);
	return {
		columns: capped.columns.map((c) => ({ key: c.key, label: c.label, format: c.format })),
		rows: capped.rows,
		total: result.total,
		truncated: capped.truncated,
		...(capped.recordIds ? { record_ids: capped.recordIds } : {})
	};
}

/** ReportError (validation, admin-only) goes back to the model as the message. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof ReportError) throw new ToolInputError(e.message);
		throw e;
	}
}

function specArg(input: Record<string, unknown>): unknown {
	const raw = input.spec;
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw);
		} catch {
			throw new ToolInputError('"spec" is not valid JSON.');
		}
	}
	if (!raw || typeof raw !== 'object') throw new ToolInputError('"spec" is required.');
	return raw;
}

const readTools: Tool[] = [
	{
		name: 'list_reports',
		tier: 'read',
		description:
			'Reports: the built-in library (id "builtin:<key>", with its params) and saved reports (numeric id). Optional folder filter (Email, Contacts, Site, Segments, Pipeline, Clients & integrations).',
		input_schema: { type: 'object', properties: { folder: { type: 'string' } } },
		summarize: (input) => (input.folder ? String(input.folder) : 'all reports'),
		handler: async (ctx, input) => {
			const folder = strArg(input, 'folder', 80);
			const all = await reportCatalog(ctx.db, viewerOf(ctx));
			const reports = (folder ? all.filter((r) => r.folder.toLowerCase() === folder.toLowerCase()) : all).map((r) => ({
				...r,
				// Compact params for the model: allowed values only, no labels.
				...(r.params
					? { params: r.params.map((p) => ({ key: p.key, default: p.default, ...(p.options ? { options: p.options.map((o) => o.value) } : { kind: p.kind }) })) }
					: {}),
				url: r.kind === 'builtin' ? `${ctx.baseUrl}/reports/b/${r.id.slice('builtin:'.length)}` : `${ctx.baseUrl}/reports/${r.id}`
			}));
			return { total: reports.length, reports };
		}
	},
	{
		name: 'get_report_results',
		tier: 'read',
		description:
			'Run a report and return its rows. Give "report" (a built-in "builtin:<key>" or a saved report id from list_reports, with optional "params" for a built-in) or an ad-hoc "spec" (see get_report_metrics). Read-only; hours, billing and pipeline value are admins only.',
		input_schema: {
			type: 'object',
			properties: {
				report: { type: 'string', description: '"builtin:<key>" or a saved report id.' },
				params: { type: 'object', description: 'Built-in params by key, e.g. { "range": "30d" }.' },
				spec: { type: 'object', description: 'An ad-hoc report spec instead of "report".' },
				limit: { type: 'integer', minimum: 1, maximum: ROWS_MAX, description: `Max rows returned (default ${ROWS_DEFAULT}).` }
			}
		},
		summarize: (input) => (input.report ? String(input.report) : 'ad-hoc report'),
		handler: async (ctx, input) => {
			const max = intArg(input, 'limit', { min: 1, max: ROWS_MAX }) ?? ROWS_DEFAULT;
			const viewer = viewerOf(ctx);
			if (input.report != null && input.report !== '') {
				const ref = parseReportRef(input.report);
				if (!ref) throw new ToolInputError('"report" must be "builtin:<key>" or a saved report id.');
				const p = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? (input.params as Record<string, unknown>) : {};
				const ran = await guarded(() =>
					runReportRef(ctx.db, ref, viewer, paramSource((name) => (p[name] == null ? null : String(p[name]))), ctx.now)
				);
				if (!ran) throw new ToolInputError(`No report "${String(input.report)}". Use list_reports.`);
				const url = ref.kind === 'builtin' ? `${ctx.baseUrl}/reports/b/${ref.key}` : `${ctx.baseUrl}/reports/${ref.id}`;
				return { report: ran.id, name: ran.name, url, ...rowsOut(ran.result, max) };
			}
			const spec = specArg(input);
			const result = await guarded(() => runAdHoc(ctx.db, spec, viewer));
			return { report: null, ...rowsOut(result, max) };
		}
	},
	{
		name: 'get_report_metrics',
		tier: 'read',
		description:
			'The report spec vocabulary: entities, their columns with definitions, group-by keys, filter rule fields/ops, time presets, charts and an example spec. Optional "entity" (contacts, companies, campaigns, segments, pipeline, site_pages).',
		input_schema: { type: 'object', properties: { entity: { type: 'string' } } },
		summarize: (input) => (input.entity ? String(input.entity) : 'report catalog'),
		handler: async (ctx, input) => {
			const raw = strArg(input, 'entity', 40);
			if (raw && !isReportEntity(raw)) throw new ToolInputError(`Unknown entity "${raw}".`);
			return metricCatalog(viewerOf(ctx), (raw || undefined) as ReportEntity | undefined);
		}
	}
];

type Created = { report_id: number; updated_at: string };

const createReportDraft: WriteTool = {
	name: 'create_report_draft',
	tier: 'write',
	description:
		'Save a report spec as a new report (not pinned) in the Reports library, so the user can open, adjust and pin it. Changes no contacts. Check the spec with get_report_results first.',
	input_schema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			description: { type: 'string' },
			spec: { type: 'object' }
		},
		required: ['name', 'spec']
	},
	summarize: (input) => String(input.name ?? ''),
	plan: async (ctx, input) => {
		const name = strArg(input, 'name', 200);
		if (!name) throw new ToolInputError('"name" is required.');
		const spec = specArg(input);
		// Validate (and refuse admin-only keys for members) without saving.
		await guarded(async () => {
			const parsed = parseReportSpec(spec);
			const blocked = viewerOf(ctx).role === 'admin' ? [] : adminOnlyKeys(parsed);
			if (blocked.length) throw new ReportError(adminOnlyMessage(blocked));
		});
		return { count: 0, sample: [], summary: `Save report “${name}”` };
	},
	apply: async (ctx, input) => {
		const name = strArg(input, 'name', 200);
		const description = strArg(input, 'description', 2000) || null;
		const spec = specArg(input);
		const saved = await guarded(() =>
			createReport(
				ctx.db,
				{ name, description, spec, createdBy: ctx.user.id, pinned: false, folder: null },
				viewerOf(ctx)
			)
		);
		return {
			summary: `Saved report “${saved.name}”`,
			before: null,
			after: { report_id: saved.id, updated_at: saved.updated_at } satisfies Created,
			url: `${ctx.baseUrl}/reports/${saved.id}`,
			result: { report_id: saved.id, folder: folderOf(saved.folder, saved.spec.entity) }
		};
	},
	undo: async (ctx, _before, after) => {
		const created = after as Created | null;
		if (!created?.report_id) throw new UndoRefused('Nothing to undo.');
		const current = await getReport(ctx.db, created.report_id);
		if (!current) return; // already gone
		if (current.updated_at !== created.updated_at || current.pinned) {
			throw new UndoRefused('The report was changed since, so it was kept.');
		}
		await deleteReport(ctx.db, created.report_id);
	}
};

export const reportTools: Tool[] = [suggestReport, getReportPreview, ...readTools, createReportDraft];

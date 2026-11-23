// Reports pages (#355): load the builder and home, and the save / pin / CSV actions.
// Every run goes through `runReport`, so members hit the engine's "Admins only" refusal.

import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { validFieldKey, ReportError, parseReportSpec, type ReportEntity, type ReportSpec, type ReportViewer } from '$lib/report-spec';
import {
	columnsFor,
	decodeSpec,
	defaultSpec,
	folderOf,
	isReportFolder,
	previewLimit,
	reportCsv,
	REPORT_FOLDERS,
	sameSpec,
	type ColumnChoice,
	type ReportFolder
} from '$lib/report-view';
import { getDB } from '$lib/server/db';
import {
	builtInByKey,
	builtInInfo,
	builtInsFor,
	builtInSpec,
	builtInVisible,
	isDuplicable,
	paramQuery,
	resolveParams,
	runBuiltIn,
	type BuiltInDef,
	type BuiltInInfo,
	type ParamValues
} from '$lib/server/reports/builtins';
import { parseReportRef } from '$lib/server/reports/access';
import { compileReportQuery, runReport, type ReportResult } from '$lib/server/reports/engine';
import {
	createReport,
	deleteReport,
	getReport,
	listBuiltInPins,
	listReports,
	setBuiltInPin,
	updateReport,
	type SavedReport
} from '$lib/server/reports/store';
import { getTimezone } from '$lib/server/settings';
import { activeScores } from '$lib/server/scoring/reports';
import { scoreReportReadback } from '$lib/report-nl';

type ReportEvent = {
	request: Request;
	url: URL;
	params: { id?: string; key?: string };
	locals: App.Locals;
	platform?: App.Platform;
};

export type ReportPickers = {
	companies: { id: number; name: string }[];
	stages: { id: number; name: string }[];
	groups: { id: number; name: string; kind: string }[];
	lists: { id: number; name: string }[];
	sites: { id: number; name: string }[];
	fieldKeys: string[];
	/** #468: active scores for the scoring built-ins' Score picker. */
	scores: { slug: string; name: string }[];
};

export type BuilderLoad = {
	mode: 'new' | 'saved' | 'builtin';
	role: ReportViewer['role'];
	spec: ReportSpec;
	saved: SavedReport | null;
	builtIn: BuiltInInfo | null;
	unsaved: boolean;
	result: ReportResult | null;
	error: string | null;
	offeredByEntity: Record<ReportEntity, ColumnChoice[]>;
	pickers: ReportPickers;
	readOnly: boolean;
	/** Settings → Timezone: date-time cells read in it (#456). */
	tz: string;
	/** A Duplicate opens /reports/new with `?name=` / `description` / `folder` prefilled (#456). */
	draft: { name: string; description: string; folder: string } | null;
};

export type LibraryItem = {
	id: string;
	name: string;
	description: string | null;
	folder: ReportFolder;
	href: string;
	builtIn: boolean;
};

export type PinnedCard = {
	/** A saved report's id, or `b:<key>` for a pinned built-in (#456). */
	id: number | string;
	name: string;
	href: string;
	chart: NonNullable<ReportSpec['chart']> | 'table';
	/** #454: the chart reads oldest → newest when the table is sorted newest first. */
	sort: ReportSpec['sort'] | null;
	result: ReportResult | null;
	error: string | null;
};

export function reportViewer(event: { locals: App.Locals }): ReportViewer {
	const role = event.locals.user?.role;
	if (role !== 'admin' && role !== 'member') throw error(401, 'Sign in required.');
	return { role };
}

function offeredByEntity(role: ReportViewer['role']): Record<ReportEntity, ColumnChoice[]> {
	return {
		contacts: columnsFor('contacts', role),
		companies: columnsFor('companies', role),
		campaigns: columnsFor('campaigns', role),
		segments: columnsFor('segments', role),
		pipeline: columnsFor('pipeline', role),
		site_pages: columnsFor('site_pages', role)
	};
}

async function runSafe(
	db: D1Database,
	spec: ReportSpec,
	viewer: ReportViewer,
	builtIn?: { def: BuiltInDef; params: ParamValues }
): Promise<{ result: ReportResult | null; error: string | null }> {
	try {
		const result = builtIn ? await runBuiltIn(db, builtIn.def, builtIn.params, viewer) : await runReport(db, spec, viewer);
		return { result, error: null };
	} catch (err) {
		return { result: null, error: runErrorMessage(err) };
	}
}

/**
 * What a failed run shows (#453). A ReportError is already user-facing. Anything
 * else (a D1 error) is caught here so one broken report never takes down the
 * page or the home page's other cards.
 */
function runErrorMessage(err: unknown): string {
	if (err instanceof ReportError) return err.message;
	console.error('report run failed', err);
	const detail = err instanceof Error ? err.message : String(err);
	return `This report can't run: ${detail.replace(/^D1_ERROR:\s*/, '').slice(0, 200)}`;
}

function readSpecField(raw: FormDataEntryValue | null): ReportSpec {
	if (typeof raw !== 'string' || !raw.trim()) throw new ReportError('Report spec is missing.');
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ReportError('Report spec is incomplete.');
	}
	return parseReportSpec(parsed);
}

function postedMeta(data: FormData, entity: ReportSpec['entity']): { name: string; description: string; folder: string; pinned: boolean } {
	const folderRaw = String(data.get('folder') ?? '').trim();
	return {
		name: String(data.get('name') ?? ''),
		description: String(data.get('description') ?? ''),
		folder: folderRaw && isReportFolder(folderRaw) ? folderRaw : folderOf(null, entity),
		pinned: data.get('pinned') === '1'
	};
}

function catchReport(err: unknown): ReturnType<typeof fail> {
	if (err instanceof ReportError) return fail(400, { error: err.message });
	throw err;
}

export async function loadPickers(db: D1Database): Promise<ReportPickers> {
	const [companies, stages, groups, sites, metas] = await Promise.all([
		db.prepare(`SELECT id, name FROM companies ORDER BY name COLLATE NOCASE LIMIT 200`).all<{ id: number; name: string }>(),
		db.prepare(`SELECT id, name FROM pipeline_stages ORDER BY position, id`).all<{ id: number; name: string }>(),
		db
			.prepare(
				`SELECT id, name, kind FROM lists WHERE kind IN ('list', 'segment', 'tag', 'company') ORDER BY name COLLATE NOCASE LIMIT 300`
			)
			.all<{ id: number; name: string; kind: string }>(),
		db.prepare(`SELECT id, name FROM tracking_sites ORDER BY name COLLATE NOCASE`).all<{ id: number; name: string }>(),
		db.prepare(`SELECT meta FROM contacts WHERE meta IS NOT NULL AND TRIM(meta) NOT IN ('', '{}') LIMIT 200`).all<{ meta: string }>()
	]);
	const fieldKeys = new Set<string>();
	for (const row of metas.results ?? []) {
		try {
			const parsed = JSON.parse(row.meta) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
			for (const key of Object.keys(parsed)) if (validFieldKey(key)) fieldKeys.add(key);
		} catch {
			/* a bad meta blob is skipped; it isn't a column */
		}
	}
	const lists = (groups.results ?? []).filter((group) => group.kind === 'list' || group.kind === 'segment');
	return {
		companies: companies.results ?? [],
		stages: stages.results ?? [],
		groups: groups.results ?? [],
		lists: lists.map((group) => ({ id: group.id, name: group.name })),
		sites: sites.results ?? [],
		fieldKeys: [...fieldKeys].sort((a, b) => a.localeCompare(b)),
		scores: (await activeScores(db)).map((score) => ({ slug: score.slug, name: score.name }))
	};
}

export async function loadBuilder(event: ReportEvent, mode: BuilderLoad['mode']): Promise<BuilderLoad> {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const [pickers, tz] = await Promise.all([loadPickers(db), getTimezone(db)]);
	const base = {
		role: viewer.role,
		offeredByEntity: offeredByEntity(viewer.role),
		pickers,
		readOnly: mode === 'builtin',
		tz,
		draft: mode === 'new' ? draftFields(event.url.searchParams) : null
	};

	let saved: SavedReport | null = null;
	let builtIn: BuiltInInfo | null = null;
	let fallback = defaultSpec('contacts');

	if (mode === 'saved') {
		const id = Number(event.params.id);
		saved = Number.isInteger(id) ? await getReport(db, id) : null;
		if (!saved) throw error(404, 'Report not found.');
		fallback = saved.spec;
	} else if (mode === 'builtin') {
		const def = builtInByKey(event.params.key ?? '');
		if (!def || !(await builtInVisible(db, def, viewer))) throw error(404, 'Report not found.');
		const params = resolveParams(def, event.url.searchParams);
		builtIn = builtInInfo(def, params);
		if (def.params?.some((param) => param.kind === 'score')) {
			const score = pickers.scores.find((item) => item.slug === params.score) ?? pickers.scores[0] ?? null;
			builtIn.readback = scoreReportReadback(def.key, params, score?.name ?? null);
		}
		const pin = (await listBuiltInPins(db)).find((item) => item.key === def.key);
		if (pin) builtIn = { ...builtIn, pinned: true, pinnedHere: paramQuery(def, resolveParams(def, pinSource(pin.params))) === builtIn.query };
		const spec = builtInSpec(def, params, viewer);
		const run = await runSafe(db, spec, viewer, { def, params });
		return { ...base, mode, spec, saved, builtIn, unsaved: false, ...run };
	}

	const raw = event.url.searchParams.get('spec');
	if (raw) {
		try {
			const spec = decodeSpec(raw);
			const run = await runSafe(db, spec, viewer);
			return {
				...base,
				mode,
				spec,
				saved,
				builtIn,
				unsaved: saved != null && !sameSpec(spec, saved.spec),
				...run
			};
		} catch (err) {
			const message = err instanceof ReportError ? err.message : 'This report link is incomplete.';
			return { ...base, mode, spec: fallback, saved, builtIn, unsaved: false, result: null, error: message };
		}
	}

	const run = await runSafe(db, fallback, viewer);
	return { ...base, mode, spec: fallback, saved, builtIn, unsaved: false, ...run };
}

/** Name, description and folder a Duplicate hands to the new builder (#456). */
function draftFields(query: URLSearchParams): BuilderLoad['draft'] {
	const name = (query.get('name') ?? '').trim().slice(0, 120);
	const description = (query.get('description') ?? '').trim().slice(0, 2000);
	const folder = (query.get('folder') ?? '').trim();
	if (!name && !description && !folder) return null;
	return { name, description, folder: isReportFolder(folder) ? folder : '' };
}

/** Stored pin params (plain keys) as the `p_<key>` source `resolveParams` reads. */
function pinSource(params: Record<string, string>): { get(name: string): unknown } {
	return { get: (name: string) => (name.startsWith('p_') ? (params[name.slice(2)] ?? null) : null) };
}

/** A pinned built-in card's rows: like `previewLimit`, but a line keeps every period. */
function builtInPreview(result: ReportResult, chart: NonNullable<ReportSpec['chart']>): ReportResult {
	const max = chart === 'stat' ? 1 : chart === 'table' ? 5 : chart === 'bar' ? 12 : result.rows.length;
	if (result.rows.length <= max) return result;
	const out: ReportResult = { ...result, rows: result.rows.slice(0, max), truncated: true };
	if (result.recordIds) out.recordIds = result.recordIds.slice(0, max);
	return out;
}

export async function loadHome(
	event: ReportEvent
): Promise<{ library: LibraryItem[]; pinned: PinnedCard[]; folders: readonly ReportFolder[]; tz: string }> {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const [saved, tz] = await Promise.all([listReports(db), getTimezone(db)]);
	const library: LibraryItem[] = [
		...(await builtInsFor(db, viewer)).map((report) => ({
			id: `b:${report.key}`,
			name: report.name,
			description: report.description,
			folder: report.folder,
			href: `/reports/b/${report.key}`,
			builtIn: true
		})),
		...saved.map((report) => ({
			id: `s:${report.id}`,
			name: report.name,
			description: report.description,
			folder: folderOf(report.folder, report.spec.entity),
			href: `/reports/${report.id}`,
			builtIn: false
		}))
	];
	const pinned: PinnedCard[] = [];
	for (const report of saved) {
		if (!report.pinned) continue;
		let run: { result: ReportResult | null; error: string | null };
		try {
			const preview = parseReportSpec({ ...report.spec, limit: previewLimit(report.spec) });
			run = await runSafe(db, preview, viewer);
		} catch (err) {
			run = { result: null, error: runErrorMessage(err) };
		}
		pinned.push({
			id: report.id,
			name: report.name,
			href: `/reports/${report.id}`,
			chart: report.spec.chart ?? 'table',
			sort: report.spec.sort ?? null,
			result: run.result,
			error: run.error
		});
	}
	for (const pin of await listBuiltInPins(db)) {
		const def = builtInByKey(pin.key);
		if (!def || !(await builtInVisible(db, def, viewer))) continue;
		const params = resolveParams(def, pinSource(pin.params));
		const spec = builtInSpec(def, params, viewer);
		const run = await runSafe(db, spec, viewer, { def, params });
		const query = paramQuery(def, params);
		pinned.push({
			id: `b:${def.key}`,
			name: def.name,
			href: `/reports/b/${def.key}${query ? `?${query}` : ''}`,
			chart: def.chart,
			sort: spec.sort ?? null,
			result: run.result ? builtInPreview(run.result, def.chart) : null,
			error: run.error
		});
	}
	return { library, pinned, folders: REPORT_FOLDERS, tz };
}

export async function saveReportAction(event: RequestEvent) {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const data = await event.request.formData();
	try {
		const spec = readSpecField(data.get('spec'));
		parseReportSpec(spec);
		compileGuard(spec, viewer);
		const fields = postedMeta(data, spec.entity);
		const rawId = event.params.id;
		if (rawId) {
			const id = Number(rawId);
			const updated = await updateReport(db, id, { name: fields.name, description: fields.description, folder: fields.folder, pinned: fields.pinned, spec }, viewer);
			if (!updated) throw error(404, 'Report not found.');
			redirect(303, `/reports/${updated.id}`);
		}
		const created = await createReport(db, {
			name: fields.name,
			description: fields.description,
			folder: fields.folder,
			pinned: fields.pinned,
			spec,
			createdBy: event.locals.user?.id ?? null
		}, viewer);
		redirect(303, `/reports/${created.id}`);
	} catch (err) {
		return catchReport(err);
	}
}

export async function saveAsReportAction(event: RequestEvent) {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const data = await event.request.formData();
	try {
		const spec = readSpecField(data.get('spec'));
		compileGuard(spec, viewer);
		const fields = postedMeta(data, spec.entity);
		const created = await createReport(db, {
			name: fields.name,
			description: fields.description,
			folder: fields.folder,
			pinned: false,
			spec,
			createdBy: event.locals.user?.id ?? null
		}, viewer);
		redirect(303, `/reports/${created.id}`);
	} catch (err) {
		return catchReport(err);
	}
}

/**
 * #456: Duplicate opens the unsaved builder (`/reports/new?spec=…`) instead of saving a
 * "Copy of …" row on every click; the user saves when ready.
 */
export function duplicateHref(spec: ReportSpec, fields: { name: string; description?: string | null; folder?: string | null }): string {
	const query = new URLSearchParams();
	query.set('spec', JSON.stringify(spec));
	query.set('name', `Copy of ${fields.name}`.slice(0, 120));
	if (fields.description) query.set('description', fields.description);
	if (fields.folder) query.set('folder', fields.folder);
	return `/reports/new?${query}`;
}

export async function duplicateSavedAction(event: RequestEvent) {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const id = Number(event.params.id);
	const current = Number.isInteger(id) ? await getReport(db, id) : null;
	if (!current) throw error(404, 'Report not found.');
	try {
		compileGuard(current.spec, viewer);
		redirect(303, duplicateHref(current.spec, current));
	} catch (err) {
		return catchReport(err);
	}
}

export async function duplicateBuiltInAction(event: RequestEvent) {
	const viewer = reportViewer(event);
	const builtIn = builtInByKey(String(event.params.key ?? ''));
	const db = getDB(event);
	if (!builtIn || !(await builtInVisible(db, builtIn, viewer))) throw error(404, 'Report not found.');
	const params = resolveParams(builtIn, await event.request.formData());
	if (!isDuplicable(builtIn, params)) return fail(400, { error: "This report can't be duplicated: the builder can't express it." });
	const spec = builtInSpec(builtIn, params, viewer);
	try {
		compileGuard(spec, viewer);
		// Only duplicable built-ins get here: their spec is the report, so the description holds.
		redirect(303, duplicateHref(spec, builtIn));
	} catch (err) {
		return catchReport(err);
	}
}

/** #456: pin a built-in (with the posted params) to Reports home, or unpin it. */
export async function pinBuiltInAction(event: RequestEvent) {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const def = builtInByKey(String(event.params.key ?? ''));
	if (!def || !(await builtInVisible(db, def, viewer))) throw error(404, 'Report not found.');
	const data = await event.request.formData();
	const params = resolveParams(def, data);
	const stored: Record<string, string> = {};
	for (const param of def.params ?? []) {
		if (param.when && params[param.when.key] !== param.when.value) continue;
		stored[param.key] = params[param.key] ?? param.default;
	}
	await setBuiltInPin(db, def.key, data.get('pinned') === '1' ? stored : null);
	const query = paramQuery(def, params);
	redirect(303, `/reports/b/${def.key}${query ? `?${query}` : ''}`);
}

export async function pinReportAction(event: RequestEvent) {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const id = Number(event.params.id);
	const current = Number.isInteger(id) ? await getReport(db, id) : null;
	if (!current) throw error(404, 'Report not found.');
	const data = await event.request.formData();
	try {
		compileGuard(current.spec, viewer);
		const updated = await updateReport(db, current.id, { pinned: data.get('pinned') === '1' }, viewer);
		if (!updated) throw error(404, 'Report not found.');
		redirect(303, `/reports/${updated.id}`);
	} catch (err) {
		return catchReport(err);
	}
}

export async function deleteReportAction(event: RequestEvent) {
	reportViewer(event);
	const db = getDB(event);
	const id = Number(event.params.id);
	const current = Number.isInteger(id) ? await getReport(db, id) : null;
	if (!current) throw error(404, 'Report not found.');
	await deleteReport(db, current.id);
	redirect(303, '/reports');
}

function csvResponse(result: ReportResult, filename: string, tz: string): Response {
	return new Response(reportCsv(result.columns, result.rows, { tz }), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'no-store'
		}
	});
}

/** `?limit=` on a built-in CSV: raises or lowers its row limit (capped by the engine). */
function csvLimit(url: URL): number | null {
	const n = Math.floor(Number(url.searchParams.get('limit')));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** /reports/<id>.csv — a saved report, or `builtin:<key>` (#456). */
export async function reportCsvResponse(event: RequestEvent): Promise<Response> {
	const ref = parseReportRef(event.params.id);
	if (ref?.kind === 'builtin') return builtInCsvResponse(event, ref.key);
	const viewer = reportViewer(event);
	const db = getDB(event);
	if (ref?.kind !== 'saved') throw error(404, 'Report not found.');
	const report = await getReport(db, ref.id);
	if (!report) throw error(404, 'Report not found.');
	try {
		const result = await runReport(db, report.spec, viewer);
		return csvResponse(result, `report-${report.id}.csv`, await getTimezone(db));
	} catch (err) {
		if (err instanceof ReportError) throw error(403, err.message);
		throw err;
	}
}

/** /reports/b/<key>.csv (#456): the built-in with the `p_` params in the URL. */
export async function builtInCsvResponse(event: RequestEvent, key = String(event.params.key ?? '')): Promise<Response> {
	const viewer = reportViewer(event);
	const db = getDB(event);
	const def = builtInByKey(key);
	if (!def || !(await builtInVisible(db, def, viewer))) throw error(404, 'Report not found.');
	const params = resolveParams(def, event.url.searchParams);
	try {
		const result = await runBuiltIn(db, def, params, viewer, new Date(), { limit: csvLimit(event.url) });
		return csvResponse(result, `report-${def.key}.csv`, await getTimezone(db));
	} catch (err) {
		if (err instanceof ReportError) throw error(403, err.message);
		throw err;
	}
}

/** The engine's permission check. A refused spec is not saved, pinned or duplicated. */
function compileGuard(spec: ReportSpec, viewer: ReportViewer): void {
	compileReportQuery(spec, viewer);
}

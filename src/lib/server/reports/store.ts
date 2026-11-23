// Saved reports (#354). The spec is validated on the way in and again on the way out.

import {
	adminOnlyKeys,
	adminOnlyMessage,
	parseReportSpec,
	ReportError,
	type ReportSpec,
	type ReportViewer
} from '$lib/report-spec';

export type SavedReport = {
	id: number;
	name: string;
	description: string | null;
	spec: ReportSpec;
	created_by: number | null;
	pinned: number;
	folder: string | null;
	built_in_key: string | null;
	created_at: string;
	updated_at: string;
};

export type ReportInput = {
	name: string;
	description?: string | null;
	spec: unknown;
	createdBy?: number | null;
	pinned?: boolean;
	folder?: string | null;
	builtInKey?: string | null;
};

export type ReportPatch = {
	name?: string;
	description?: string | null;
	spec?: unknown;
	pinned?: boolean;
	folder?: string | null;
};

type ReportRow = {
	id: number;
	name: string;
	description: string | null;
	spec: string;
	created_by: number | null;
	pinned: number;
	folder: string | null;
	built_in_key: string | null;
	created_at: string;
	updated_at: string;
};

export async function createReport(db: D1Database, input: ReportInput, viewer: ReportViewer): Promise<SavedReport> {
	const name = cleanName(input.name);
	const description = cleanDescription(input.description);
	const folder = cleanFolder(input.folder);
	const builtInKey = cleanBuiltInKey(input.builtInKey);
	const parsed = parseReportSpec(input.spec);
	assertMemberSpec(parsed, viewer);
	const spec = JSON.stringify(parsed);
	const pinned = input.pinned ? 1 : 0;
	const row = await db
		.prepare(
			`INSERT INTO reports (name, description, spec, created_by, pinned, folder, built_in_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
		)
		.bind(name, description, spec, input.createdBy ?? null, pinned, folder, builtInKey)
		.first<ReportRow>();
	if (!row) throw new ReportError('Could not save the report.');
	return toSaved(row);
}

export async function updateReport(
	db: D1Database,
	id: number,
	patch: ReportPatch,
	viewer: ReportViewer
): Promise<SavedReport | null> {
	const current = await getReport(db, id);
	if (!current) return null;
	const name = patch.name !== undefined ? cleanName(patch.name) : current.name;
	const description = patch.description !== undefined ? cleanDescription(patch.description) : current.description;
	const folder = patch.folder !== undefined ? cleanFolder(patch.folder) : current.folder;
	const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : current.pinned;
	const parsed = patch.spec !== undefined ? parseReportSpec(patch.spec) : current.spec;
	assertMemberSpec(parsed, viewer);
	const spec = JSON.stringify(parsed);
	const row = await db
		.prepare(
			`UPDATE reports
			 SET name = ?, description = ?, spec = ?, pinned = ?, folder = ?, updated_at = datetime('now')
			 WHERE id = ? RETURNING *`
		)
		.bind(name, description, spec, pinned, folder, id)
		.first<ReportRow>();
	return row ? toSaved(row) : null;
}

export async function duplicateReport(
	db: D1Database,
	id: number,
	createdBy: number | null | undefined,
	viewer: ReportViewer
): Promise<SavedReport> {
	const current = await getReport(db, id);
	if (!current) throw new ReportError('Report not found.');
	assertMemberSpec(current.spec, viewer);
	return createReport(db, {
		name: copyName(current.name),
		description: current.description,
		spec: current.spec,
		createdBy: createdBy === undefined ? current.created_by : createdBy,
		pinned: false,
		folder: current.folder,
		builtInKey: null
	}, viewer);
}

// Fails closed: anything but an explicit admin viewer gets the member check.
function assertMemberSpec(spec: ReportSpec, viewer: ReportViewer): void {
	if (viewer?.role === 'admin') return;
	const blocked = adminOnlyKeys(spec);
	if (blocked.length) throw new ReportError(adminOnlyMessage(blocked));
}

export async function deleteReport(db: D1Database, id: number): Promise<boolean> {
	const res = await db.prepare('DELETE FROM reports WHERE id = ?').bind(id).run();
	return (res.meta?.changes ?? 0) > 0;
}

export async function listReports(db: D1Database, opts?: { folder?: string; pinned?: boolean }): Promise<SavedReport[]> {
	const parts: string[] = [];
	const binds: (string | number)[] = [];
	if (opts?.folder !== undefined) {
		parts.push('folder = ?');
		binds.push(opts.folder);
	}
	if (opts?.pinned !== undefined) {
		parts.push('pinned = ?');
		binds.push(opts.pinned ? 1 : 0);
	}
	const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
	const stmt = db.prepare(`SELECT * FROM reports ${where} ORDER BY pinned DESC, updated_at DESC, id DESC`);
	const res = await (binds.length ? stmt.bind(...binds) : stmt).all<ReportRow>();
	return (res.results ?? []).map(toSaved);
}

export async function getReport(db: D1Database, id: number): Promise<SavedReport | null> {
	const row = await db.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>();
	return row ? toSaved(row) : null;
}

// --- pinned built-ins (#456) -------------------------------------------------------------
// A built-in pin is { key, params } in app_state (no migration): built-ins aren't rows, and
// a reports row would also show up in the library and the API catalog.

const PINNED_BUILTINS_KEY = 'reports_pinned_builtins';
const PINNED_BUILTINS_MAX = 50;

export type BuiltInPin = { key: string; params: Record<string, string> };

export async function listBuiltInPins(db: D1Database): Promise<BuiltInPin[]> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(PINNED_BUILTINS_KEY).first<{ value: string | null }>();
	if (!row?.value) return [];
	try {
		const parsed = JSON.parse(row.value) as unknown;
		if (!Array.isArray(parsed)) return [];
		const out: BuiltInPin[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue;
			const { key, params } = item as { key?: unknown; params?: unknown };
			if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) continue;
			const clean: Record<string, string> = {};
			if (params && typeof params === 'object' && !Array.isArray(params)) {
				for (const [name, value] of Object.entries(params)) if (typeof value === 'string') clean[name] = value;
			}
			out.push({ key, params: clean });
		}
		return out;
	} catch {
		return [];
	}
}

/** Pin (or re-pin with new params) a built-in, or unpin it with `params = null`. */
export async function setBuiltInPin(db: D1Database, key: string, params: Record<string, string> | null): Promise<void> {
	cleanBuiltInKey(key);
	const all = await listBuiltInPins(db);
	const existing = all.findIndex((pin) => pin.key === key);
	const pins = all.filter((pin) => pin.key !== key);
	if (params) {
		const pin = { key, params };
		if (existing >= 0) pins.splice(existing, 0, pin);
		else pins.push(pin);
	}
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(PINNED_BUILTINS_KEY, JSON.stringify(pins.slice(0, PINNED_BUILTINS_MAX)))
		.run();
}

function toSaved(row: ReportRow): SavedReport {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		spec: parseReportSpec(JSON.parse(row.spec)),
		created_by: row.created_by,
		pinned: row.pinned,
		folder: row.folder,
		built_in_key: row.built_in_key,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function cleanName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 120) throw new ReportError('Report name must be 1–120 characters.');
	return trimmed;
}

function copyName(name: string): string {
	const next = `Copy of ${name}`;
	return next.length <= 120 ? next : next.slice(0, 120);
}

function cleanDescription(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > 2000) throw new ReportError('Description must be 2000 characters or fewer.');
	return trimmed;
}

function cleanFolder(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > 80) throw new ReportError('Folder must be 80 characters or fewer.');
	return trimmed;
}

function cleanBuiltInKey(value: string | null | undefined): string | null {
	if (value == null || value === '') return null;
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new ReportError('Unknown built-in report key.');
	return value;
}

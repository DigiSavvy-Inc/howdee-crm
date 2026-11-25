// #472: archived lists / segments (`lists.archived_at`) in pickers. An archived group is left out
// of every "pick a group" list, except where the thing being edited already points at it: then it
// stays, labelled "(archived)", so saving doesn't silently clear the choice. The archive / restore
// writes and their rules live in groups-bulk.ts (`archiveProblem`, `archiveGroups`, `restoreGroups`).

import { parseGateRules } from '$lib/condition-rules';
import { parseRules } from './segment-query';
import { containsSql } from './sql-match';

/** Picker label of an archived group that is still referenced. */
export function archivedName(name: string): string {
	return `${name} (archived)`;
}

/**
 * Picker rows without archived groups, except those whose id is in `keep` (already referenced
 * by what is being edited) — kept ones get `archivedName` and `archived: true`.
 */
export function forPicker<T extends { id: number; name: string; archived_at?: string | null }>(
	rows: T[],
	keep: Iterable<number | null | undefined> = []
): (T & { archived: boolean })[] {
	const kept = new Set<number>();
	for (const id of keep) if (typeof id === 'number' && id > 0) kept.add(id);
	const out: (T & { archived: boolean })[] = [];
	for (const r of rows) {
		if (!r.archived_at) out.push({ ...r, archived: false });
		else if (kept.has(r.id)) out.push({ ...r, name: archivedName(r.name), archived: true });
	}
	return out;
}

export type ApiGroup = {
	id: number;
	name: string;
	kind: string;
	dynamic: boolean;
	description: string | null;
	created_at: string;
	archived_at: string | null;
};

/**
 * `GET /api/v1/lists`: lists and segments by name. Archived ones are left out unless
 * `includeArchived`; every row carries `archived_at` (null = active).
 */
export async function listGroupsForApi(
	db: D1Database,
	opts: { kind?: 'list' | 'segment' | null; q?: string; includeArchived?: boolean; limit: number; offset: number }
): Promise<{ rows: ApiGroup[]; total: number }> {
	const where = [opts.kind ? 'kind = ?' : "kind IN ('list', 'segment')"];
	const binds: unknown[] = opts.kind ? [opts.kind] : [];
	if (!opts.includeArchived) where.push('archived_at IS NULL');
	const q = (opts.q ?? '').trim();
	if (q) {
		where.push(containsSql('name')); // #485: instr, no LIKE pattern cap
		binds.push(q);
	}
	const sql = where.join(' AND ');
	const total = (await db.prepare(`SELECT COUNT(*) AS n FROM lists WHERE ${sql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
	const res = await db
		.prepare(
			`SELECT id, name, kind, rules, description, created_at, archived_at FROM lists WHERE ${sql}
			 ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`
		)
		.bind(...binds, opts.limit, opts.offset)
		.all<Omit<ApiGroup, 'dynamic'> & { rules: string | null }>();
	return {
		rows: res.results.map(({ rules, ...r }) => ({ ...r, dynamic: r.kind === 'segment' && parseRules(rules) !== null })),
		total
	};
}

/** Group ids used by `list` / `topic` rules in a stored rule set (segment or Condition JSON). */
export function ruleListIds(raw: string | null | undefined): number[] {
	if (!raw) return [];
	const rules = parseGateRules(raw)?.rules ?? parseRules(raw)?.rules ?? [];
	const out: number[] = [];
	for (const r of rules) {
		if (r.field !== 'list' && r.field !== 'topic') continue;
		const n = Number(String(r.value ?? '').trim());
		if (Number.isInteger(n) && n > 0) out.push(n);
	}
	return out;
}

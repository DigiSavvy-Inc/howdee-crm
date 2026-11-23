// Pipeline as a contact condition (#207): the `/contacts` `?pipeline=` filter, the optional
// Stage column, and the `pipeline_stage` segment rule all read `pipeline_cards` through here.
// One card per contact (UNIQUE contact_id), so "in stage X" is a plain EXISTS.

import type { Clause } from './engagement-query';

/** `any` = on the board (any stage), `none` = not on the board, a number = in that stage. */
export type PipelineFilter = 'any' | 'none' | number;

/** `?pipeline=` / a rule value → a PipelineFilter, or null when blank/invalid. */
export function parsePipelineFilter(v: string | null | undefined): PipelineFilter | null {
	const s = String(v ?? '').trim();
	if (s === 'any' || s === 'none') return s;
	const n = Number(s);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * EXISTS clause over `pipeline_cards` for the contact id expression `idExpr` (e.g.
 * `contacts.id`, `c.id`). `negate` flips a stage match to "not in that stage" — which
 * includes contacts that aren't on the board at all.
 */
export function pipelineClause(f: PipelineFilter, idExpr: string, negate = false): Clause {
	const base = `SELECT 1 FROM pipeline_cards pc WHERE pc.contact_id = ${idExpr}`;
	if (f === 'any') return { clause: `${negate ? 'NOT ' : ''}EXISTS (${base})`, binds: [] };
	if (f === 'none') return { clause: `${negate ? '' : 'NOT '}EXISTS (${base})`, binds: [] };
	return { clause: `${negate ? 'NOT ' : ''}EXISTS (${base} AND pc.stage_id = ?)`, binds: [f] };
}

export type StageOption = { id: number; name: string; color: string | null };

/** Stage pickers (Filters popover, RuleBuilder) — board order. */
export async function stageOptions(db: D1Database): Promise<StageOption[]> {
	const res = await db
		.prepare('SELECT id, name, color FROM pipeline_stages ORDER BY position, id')
		.all<StageOption>();
	return res.results;
}

/** contact id → its stage, for the given (visible) contact ids only. Chunked under D1's bind cap. */
export async function stagesForContacts(
	db: D1Database,
	ids: number[]
): Promise<Record<number, { name: string; color: string | null }>> {
	const out: Record<number, { name: string; color: string | null }> = {};
	for (let i = 0; i < ids.length; i += 90) {
		const slice = ids.slice(i, i + 90);
		if (!slice.length) continue;
		const res = await db
			.prepare(
				`SELECT pc.contact_id, s.name, s.color FROM pipeline_cards pc
				 JOIN pipeline_stages s ON s.id = pc.stage_id
				 WHERE pc.contact_id IN (${slice.map(() => '?').join(',')})`
			)
			.bind(...slice)
			.all<{ contact_id: number; name: string; color: string | null }>();
		for (const r of res.results) out[r.contact_id] = { name: r.name, color: r.color };
	}
	return out;
}

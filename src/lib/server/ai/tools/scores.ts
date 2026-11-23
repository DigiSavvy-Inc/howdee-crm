// Named scores (#467, Scoring 2/3): read tools `list_scores`, `get_contact_scores`,
// `get_score_leaders` and the write tool `add_score_points` (a `manual` ledger row per contact,
// recomputed at once; over 25 contacts waits for approval). Reads go through
// scoring/query.ts + scoring/api.ts; the write through scoring/contact.ts `addScorePoints` —
// the same helper as the bulk bar and the Data API. Nothing here sends, enrolls or reaches the
// automation engine (tests/ai-no-send.test.ts). #552: the change (and its Undo) is recorded
// quiet, so the heartbeat never enrolls anyone into a `score_changed` automation from it; a
// trigger segment with a score_value / score_band rule on this score asks for Approve (#535's
// guard).

import { SCORE_LIMITS, pointsText, validateAdjust } from '$lib/scoring';
import { findScore, scoreDefinitions, scoreLeaders } from '../../scoring/query';
import { contactScoresApi } from '../../scoring/api';
import { addScorePoints } from '../../scoring/contact';
import { computePairs, markPairsDirty } from '../../scoring/engine';
import { contactWriteTriggerNotes } from './trigger-guard';
import { ToolInputError, UndoRefused, intArg, strArg, type Tool, type ToolContext, type WriteTool } from './types';

/** Most contacts one add_score_points call may adjust (like the other contact writes). */
const IDS_MAX = 500;

// Not write-contacts' contactIdsArg: that module pulls in contact-bulk, which the MCP server
// (it wraps these reads) must never reach (tests/mcp.test.ts).
function contactIdsArg(input: Record<string, unknown>): number[] {
	const raw = Array.isArray(input.contact_ids) ? input.contact_ids : input.contact_id !== undefined && input.contact_id !== null ? [input.contact_id] : [];
	const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
	if (!ids.length) throw new ToolInputError('Give contact_ids (or contact_id).');
	if (ids.length > IDS_MAX) throw new ToolInputError(`At most ${IDS_MAX} contacts per call.`);
	return ids;
}

const SCORE_PROP = { description: 'The score: its id, slug (e.g. "lead-score") or name.', type: ['integer', 'string'] };

async function scoreArg(ctx: ToolContext, input: Record<string, unknown>) {
	const ref = input.score ?? input.score_id;
	if (ref === undefined || ref === null || ref === '') throw new ToolInputError('"score" is required (id, slug or name — see list_scores).');
	const s = await findScore(ctx.db, ref as string | number);
	if (!s) throw new ToolInputError(`No score “${String(ref)}”. Use list_scores for the names.`);
	return s;
}

async function contactArg(ctx: ToolContext, input: Record<string, unknown>): Promise<number> {
	const id = intArg(input, 'contact_id', { min: 1 });
	if (id) {
		const row = await ctx.db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
		if (!row) throw new ToolInputError(`No contact with id ${id}.`);
		return id;
	}
	const email = strArg(input, 'email', 320).toLowerCase();
	if (!email) throw new ToolInputError('Give "contact_id" or "email".');
	const row = await ctx.db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
	if (!row) throw new ToolInputError(`No contact with the email ${email}.`);
	return row.id;
}

const readTools: Tool[] = [
	{
		name: 'list_scores',
		tier: 'read',
		description:
			'Every named contact score (Settings → Scoring): id, name, slug, description, status (active / paused), decay mode, bands [{label, min}] and how many point rules it has. Engagement tier is separate (get_engagement_tiers).',
		input_schema: { type: 'object', properties: {} },
		summarize: () => 'scores',
		handler: async (ctx) => {
			const scores = await scoreDefinitions(ctx.db);
			return { count: scores.length, scores, url: `${ctx.baseUrl}/settings/scoring` };
		}
	},
	{
		name: 'get_contact_scores',
		tier: 'read',
		description:
			"One contact's named scores: value and band per active score, and the last 20 point changes each (points, why, when, expiry, note). By contact_id or email.",
		input_schema: {
			type: 'object',
			properties: {
				contact_id: { type: 'integer' },
				email: { type: 'string', description: 'Instead of contact_id.' }
			}
		},
		summarize: (input) => String(input.contact_id ?? input.email ?? ''),
		handler: async (ctx, input) => {
			const id = await contactArg(ctx, input);
			return { contact_id: id, scores: await contactScoresApi(ctx.db, id, ctx.now), url: `${ctx.baseUrl}/contacts/${id}` };
		}
	},
	{
		name: 'get_score_leaders',
		tier: 'read',
		description:
			'The top contacts by one named score (highest first, archived contacts left out), optionally only those in one band (e.g. "Sales-ready"). Default 10, at most 100.',
		input_schema: {
			type: 'object',
			properties: {
				score: SCORE_PROP,
				band: { type: 'string', description: 'Only contacts in this band (case-insensitive).' },
				limit: { type: 'integer', minimum: 1, maximum: 100 }
			},
			required: ['score']
		},
		summarize: (input) => `${String(input.score ?? '')}${input.band ? ` · ${String(input.band)}` : ''}`,
		handler: async (ctx, input) => {
			const s = await scoreArg(ctx, input);
			const limit = intArg(input, 'limit', { min: 1, max: 100 }) ?? 10;
			const band = strArg(input, 'band', 60) || null;
			const leaders = await scoreLeaders(ctx.db, s.id, { limit, band });
			return {
				score: { id: s.id, name: s.name, slug: s.slug, status: s.status },
				band,
				count: leaders.length,
				contacts: leaders.map((c) => ({ ...c, url: `${ctx.baseUrl}/contacts/${c.contact_id}` }))
			};
		}
	}
];

// ---- add_score_points ----
// One `manual` ledger row per contact. Undo deletes exactly those rows (their source_id carries
// this call's tag) and recomputes, while they're still there.

type PointsAfter = { score_id: number; tag: string; ids: number[] };

function pointsInput(input: Record<string, unknown>) {
	const n = validateAdjust({ points: input.points, expires_days: input.expires_days ?? '', note: input.note ?? '' });
	if (!n.ok) throw new ToolInputError(n.error);
	return n.value;
}

const addScorePointsTool: WriteTool = {
	name: 'add_score_points',
	tier: 'write',
	description:
		`Add (or, with a negative number, take away) points on one named score for contacts — a manual entry in their score history, with an optional expiry in days and a note. Points: a whole number from ${SCORE_LIMITS.minPoints} to ${SCORE_LIMITS.maxPoints}, not 0. Over 25 contacts waits for approval. Undo removes the points again.`,
	input_schema: {
		type: 'object',
		properties: {
			contact_ids: { type: 'array', items: { type: 'integer' }, description: 'Contact ids. Use the selected ids from the page context for "these".' },
			contact_id: { type: 'integer', description: 'One contact id (instead of contact_ids).' },
			score: SCORE_PROP,
			points: { type: 'integer', description: '± points, not 0.' },
			expires_days: { type: 'integer', minimum: SCORE_LIMITS.minExpiryDays, maximum: SCORE_LIMITS.maxExpiryDays, description: 'Omit = never expires.' },
			note: { type: 'string', description: 'Why (shown in the score history, ≤ 200 characters).' }
		},
		required: ['score', 'points']
	},
	summarize: (input) => `${String(input.score ?? '')} ${String(input.points ?? '')}`,
	plan: async (ctx, input) => {
		const s = await scoreArg(ctx, input);
		const p = pointsInput(input);
		const ids = contactIdsArg(input);
		// #552: a trigger segment whose score_value / score_band rule reads this score.
		const trigger = await contactWriteTriggerNotes(ctx.db, ids, { scoreIds: [s.id] });
		return {
			count: ids.length,
			sample: [],
			summary: `Adjust ${s.name} by ${pointsText(p.points)} for ${ids.length} contact${ids.length === 1 ? '' : 's'}`,
			notes: [
				`Effect: a manual entry in each contact's ${s.name} history${p.expires_days ? `, expiring in ${p.expires_days} days` : ''}. Undo removes it.`,
				...trigger
			],
			...(trigger.length ? { approve: true } : {})
		};
	},
	apply: async (ctx, input) => {
		const s = await scoreArg(ctx, input);
		const p = pointsInput(input);
		const ids = contactIdsArg(input);
		const tag = `assistant-${ctx.now.toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
		const note = [p.note, `assistant (@${ctx.user.github_login})`].filter(Boolean).join(' · ');
		const res = await addScorePoints(
			ctx.db,
			ids,
			s.id,
			{ points: p.points, expires_days: p.expires_days, note, source_type: 'manual', sourceId: (c) => `${tag}-${c}`, quiet: true },
			ctx.now
		);
		if (!res.ok) throw new ToolInputError(res.error);
		const values = Object.fromEntries(res.values);
		return {
			summary: `Adjusted ${s.name} by ${pointsText(p.points)} for ${res.affected} contact${res.affected === 1 ? '' : 's'}`,
			before: null,
			after: { score_id: s.id, tag, ids } satisfies PointsAfter,
			url: ids.length === 1 ? `${ctx.baseUrl}/contacts/${ids[0]}` : `${ctx.baseUrl}/contacts`,
			result: { adjusted: res.affected, skipped: ids.length - res.affected, new_values: res.inline ? values : 'computed on the next heartbeat' }
		};
	},
	undo: async (ctx, _before, after) => {
		const a = after as PointsAfter | null;
		if (!a?.tag) return;
		const rows = await ctx.db
			.prepare(`SELECT contact_id FROM score_points WHERE score_id = ? AND source_type = 'manual' AND source_id LIKE ? ESCAPE '\\'`)
			.bind(a.score_id, `${a.tag.replace(/[\\%_]/g, (m) => `\\${m}`)}-%`)
			.all<{ contact_id: number }>();
		if (!rows.results.length) throw new UndoRefused('Those points are gone already — nothing to undo.');
		await ctx.db
			.prepare(`DELETE FROM score_points WHERE score_id = ? AND source_type = 'manual' AND source_id LIKE ? ESCAPE '\\'`)
			.bind(a.score_id, `${a.tag.replace(/[\\%_]/g, (m) => `\\${m}`)}-%`)
			.run();
		const pairs = [...new Set(rows.results.map((r) => r.contact_id))].map((c) => [c, a.score_id] as [number, number]);
		await markPairsDirty(ctx.db, pairs, ctx.now, { quiet: true });
		await computePairs(ctx.db, pairs.slice(0, 200), ctx.now, { quiet: true });
	}
};

export const scoreTools: Tool[] = [...readTools, addScorePointsTool];

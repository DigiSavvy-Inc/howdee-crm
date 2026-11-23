// Group write tools (#301): create a dynamic segment, edit its rules, create a tag or list.
// Rules use the segment rule schema (segment-query.ts) and are checked by its compiler, the
// same one sends and counts use. Creating touches no contacts, so nothing here needs Approve.
// Undo of a create removes the group only while it is exactly as created (no members, not
// used by a campaign, an automation or another rule) — never a group anyone has used.

import { ensureGroup } from '../../contact-bulk';
import {
	ARCHIVABLE_KINDS,
	archiveGroups,
	archiveProblem,
	groupNameProblem,
	groupRuleRefs,
	loadArchiveChecks,
	restoreGroups
} from '../../groups-bulk';
import { compileRule, parseRules, type SegmentRules } from '../../segment-query';
import { memberCount } from '../../segments';
import { segmentRuleChange, segmentTriggerNotes } from './trigger-guard';
import { ToolInputError, UndoRefused, intArg, strArg, type ToolContext, type WriteTool } from './types';

const RULES_MAX = 20;
const RULES_JSON_MAX = 8000; // what /lists/[id] saveRules stores at most

type Group = { id: number; name: string; kind: string; rules: string | null };

const RULES_DOC =
	'Rules: [{ field, op, value?, value2? }]. Fields and ops: tag has|not (value = tag name); list in|not (value = group id); ' +
	'subscribed yes|no; source is|contains; company exists|is; company_id exists|missing|is; engagement_tier is|not (hot|warm|cool|cold|never|new); ' +
	'last_open_within_days within|not (value = days); opens_last_90d gte|gt|lte|lt|eq (value = n); never_opened yes|no; ' +
	'opened / clicked has|not (value = days); created within (value = days) | before|after (value = YYYY-MM-DD); ' +
	'pipeline_stage is|not (value = stage id) | any|none; bounced hard|any|none; spam_complaint yes|no; ' +
	'topic out|in (value = topic list id: opted out of it / a member of it); ' +
	'visited / event has|not (value = path contains / event name, value2 = days or blank); ' +
	'field exists|missing|eq|ne|gt|gte|lt|lte (value2 = custom field key, value = the value); ' +
	'company_metric (value2 = metric, op gt|gte|lt|lte|eq|ne|older|within, value = number).';

/** Rules from the model, normalised and checked: every rule must compile. */
function rulesArg(input: Record<string, unknown>): SegmentRules {
	if (!Array.isArray(input.rules) || !input.rules.length) throw new ToolInputError('"rules" must be a non-empty array.');
	if (input.rules.length > RULES_MAX) throw new ToolInputError(`At most ${RULES_MAX} rules.`);
	const parsed = parseRules(JSON.stringify({ match: input.match === 'any' ? 'any' : 'all', rules: input.rules }))!;
	const rules = parsed.rules.map((r) => {
		if (!r || typeof r !== 'object') return null;
		const o = r as Record<string, unknown>;
		const clean: SegmentRules['rules'][number] = { field: String(o.field ?? '').trim(), op: String(o.op ?? '').trim() };
		if (o.value !== undefined && o.value !== null) clean.value = String(o.value).trim().slice(0, 200);
		if (o.value2 !== undefined && o.value2 !== null) clean.value2 = String(o.value2).trim().slice(0, 100);
		return clean;
	});
	const bad = rules.map((r, i) => (r && compileRule(r) ? null : i + 1)).filter((i) => i !== null);
	if (bad.length) throw new ToolInputError(`Rule ${bad.join(', ')} is not valid. ${RULES_DOC}`);
	const out: SegmentRules = { match: parsed.match, rules: rules as SegmentRules['rules'] };
	if (JSON.stringify(out).length > RULES_JSON_MAX) throw new ToolInputError('Those rules are too long.');
	return out;
}

function nameArg(input: Record<string, unknown>): string {
	const name = strArg(input, 'name', 100);
	const problem = groupNameProblem(name);
	if (problem) throw new ToolInputError(problem);
	return name;
}

async function byName(db: D1Database, name: string, kind: string): Promise<Group | null> {
	return db.prepare('SELECT id, name, kind, rules FROM lists WHERE kind = ? AND name = ? COLLATE NOCASE LIMIT 1').bind(kind, name).first<Group>();
}

async function groupById(db: D1Database, id: number): Promise<Group | null> {
	return db.prepare('SELECT id, name, kind, rules FROM lists WHERE id = ?').bind(id).first<Group>();
}

type Created = { group_id: number; name: string; rules: string | null };

/** Undo a create: refuse unless the group is exactly as created and nothing uses it. */
async function removeUntouched(ctx: ToolContext, after: unknown, noun: string): Promise<void> {
	const a = after as Created | null;
	if (!a) return;
	const g = await groupById(ctx.db, a.group_id);
	if (!g) return; // already gone — nothing to undo
	const [members, campaigns, triggers, refs] = await Promise.all([
		ctx.db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?').bind(g.id).first<{ n: number }>(),
		ctx.db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE list_id = ?').bind(g.id).first<{ n: number }>(),
		ctx.db.prepare('SELECT COUNT(*) AS n FROM automations WHERE trigger_list_id = ?').bind(g.id).first<{ n: number }>(),
		groupRuleRefs(ctx.db, [g.id])
	]);
	const why =
		g.name !== a.name || (g.rules ?? null) !== (a.rules ?? null)
			? 'it was edited since'
			: members?.n
				? 'it has members now'
				: campaigns?.n
					? 'a campaign uses it'
					: triggers?.n
						? 'an automation triggers from it'
						: refs.length
							? 'a segment or condition rule points at it'
							: null;
	if (why) throw new UndoRefused(`The ${noun} “${g.name}” was kept: ${why}.`);
	await ctx.db.prepare('DELETE FROM lists WHERE id = ?').bind(g.id).run();
}

function createTool(kind: 'tag' | 'list'): WriteTool {
	return {
		name: `create_${kind}`,
		tier: 'write',
		description:
			kind === 'tag'
				? 'Create an empty tag. (add_tag creates a missing tag by itself, so this is only for an empty one.)'
				: 'Create an empty list (kind list). Add contacts with add_to_list.',
		input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
		summarize: (input) => String(input.name ?? ''),
		plan: async (ctx, input) => {
			const name = nameArg(input);
			const dup = await byName(ctx.db, name, kind);
			if (dup) throw new ToolInputError(`A ${kind} named “${dup.name}” already exists (id ${dup.id}).`);
			return { count: 0, sample: [], summary: `Create ${kind} “${name}”` };
		},
		apply: async (ctx, input) => {
			const name = nameArg(input);
			const dup = await byName(ctx.db, name, kind);
			if (dup) throw new ToolInputError(`A ${kind} named “${dup.name}” already exists (id ${dup.id}).`);
			const g = await ensureGroup(ctx.db, name, kind);
			if (!g) throw new ToolInputError('Enter a name.');
			return {
				summary: `Created ${kind} “${g.name}”`,
				before: null,
				after: { group_id: g.id, name: g.name, rules: null } satisfies Created,
				url: `${ctx.baseUrl}/lists/${g.id}`,
				result: { group_id: g.id }
			};
		},
		undo: (ctx, _before, after) => removeUntouched(ctx, after, kind)
	};
}

export const groupWriteTools: WriteTool[] = [
	{
		name: 'create_segment',
		tier: 'write',
		description: `Create a dynamic segment: its members are every contact matching the rules (ALL or ANY), computed live. ${RULES_DOC}`,
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				match: { type: 'string', enum: ['all', 'any'] },
				rules: { type: 'array', items: { type: 'object' } }
			},
			required: ['name', 'rules']
		},
		summarize: (input) => String(input.name ?? ''),
		plan: async (ctx, input) => {
			const name = nameArg(input);
			rulesArg(input);
			const dup = await byName(ctx.db, name, 'segment');
			if (dup) throw new ToolInputError(`A segment named “${dup.name}” already exists (id ${dup.id}).`);
			return { count: 0, sample: [], summary: `Create segment “${name}”` };
		},
		apply: async (ctx, input) => {
			const name = nameArg(input);
			const rules = JSON.stringify(rulesArg(input));
			const dup = await byName(ctx.db, name, 'segment');
			if (dup) throw new ToolInputError(`A segment named “${dup.name}” already exists (id ${dup.id}).`);
			const g = await ensureGroup(ctx.db, name, 'segment');
			if (!g) throw new ToolInputError('Enter a name.');
			await ctx.db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(rules, g.id).run();
			const members = await memberCount(ctx.db, { id: g.id, kind: 'segment', rules });
			return {
				summary: `Created segment “${g.name}” · ${members.toLocaleString('en-US')} matching`,
				before: null,
				after: { group_id: g.id, name: g.name, rules } satisfies Created,
				url: `${ctx.baseUrl}/lists/${g.id}`,
				result: { segment_id: g.id, members }
			};
		},
		undo: (ctx, _before, after) => removeUntouched(ctx, after, 'segment')
	},
	{
		name: 'update_segment_rules',
		tier: 'write',
		description: `Replace a dynamic segment's rules (and ALL/ANY). Only for segments that already have rules — a hand-picked segment stays hand-picked. Waits for approval when over 25 contacts would enter or leave, or when the segment triggers an automation. ${RULES_DOC}`,
		input_schema: {
			type: 'object',
			properties: {
				segment_id: { type: 'integer' },
				match: { type: 'string', enum: ['all', 'any'] },
				rules: { type: 'array', items: { type: 'object' } }
			},
			required: ['segment_id', 'rules']
		},
		summarize: (input) => `segment #${input.segment_id}`,
		plan: async (ctx, input) => {
			const g = await dynamicSegment(ctx, input);
			const rules = rulesArg(input);
			// #535: the real membership change; a segment that triggers an automation always asks.
			const change = await segmentRuleChange(ctx.db, parseRules(g.rules), rules);
			const notes = await segmentTriggerNotes(ctx.db, g.id, change);
			const fmt = (n: number) => n.toLocaleString('en-US');
			return {
				count: change.entering + change.leaving,
				sample: [],
				summary: `Change the rules of “${g.name}” · ${fmt(change.before)} → ${fmt(change.after)} matching (${fmt(change.entering)} enter, ${fmt(change.leaving)} leave)`,
				...(notes.length ? { approve: true, notes } : {})
			};
		},
		apply: async (ctx, input) => {
			const g = await dynamicSegment(ctx, input);
			const rules = JSON.stringify(rulesArg(input));
			const before = await memberCount(ctx.db, { id: g.id, kind: 'segment', rules: g.rules });
			await ctx.db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(rules, g.id).run();
			const after = await memberCount(ctx.db, { id: g.id, kind: 'segment', rules });
			const fmt = (n: number) => n.toLocaleString('en-US');
			return {
				summary: `Changed the rules of “${g.name}” · ${fmt(before)} → ${fmt(after)} matching`,
				before: { segment_id: g.id, rules: g.rules },
				after: { segment_id: g.id, rules },
				changes: [{ field: 'matching contacts', from: fmt(before), to: fmt(after) }],
				url: `${ctx.baseUrl}/lists/${g.id}`,
				result: { segment_id: g.id, members_before: before, members_after: after }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as { segment_id: number; rules: string | null };
			const a = after as { segment_id: number; rules: string };
			const g = await groupById(ctx.db, a.segment_id);
			if (!g) throw new UndoRefused('That segment no longer exists.');
			if ((g.rules ?? null) !== a.rules) throw new UndoRefused(`The rules of “${g.name}” were changed since — nothing was undone.`);
			await ctx.db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(b.rules, g.id).run();
		}
	},
	createTool('tag'),
	createTool('list'),
	archiveTool('archive'),
	archiveTool('restore')
];

type ArchiveState = { group_id: number; name: string; archived_at: string | null };

/** #472: archive / restore a list or segment — the same rules as the Groups page (`archiveProblem`),
 *  admin-only. Touches no contacts or memberships; Undo flips it back while nothing else did. */
function archiveTool(op: 'archive' | 'restore'): WriteTool {
	const verb = op === 'archive' ? 'Archive' : 'Restore';
	const load = async (ctx: ToolContext, input: Record<string, unknown>): Promise<Group & { archived_at: string | null }> => {
		const id = intArg(input, 'group_id', { required: true, min: 1 })!;
		const g = await ctx.db
			.prepare('SELECT id, name, kind, rules, archived_at FROM lists WHERE id = ?')
			.bind(id)
			.first<Group & { archived_at: string | null }>();
		if (!g || !ARCHIVABLE_KINDS.includes(g.kind)) throw new ToolInputError(`No list or segment with id ${id}.`);
		if (op === 'archive') {
			const problem = archiveProblem((await loadArchiveChecks(ctx.db, [g.id]))[0]!);
			if (problem) throw new ToolInputError(`“${g.name}” can't be archived: ${problem}.`);
		} else if (!g.archived_at) throw new ToolInputError(`“${g.name}” is not archived.`);
		return g;
	};
	return {
		name: `${op}_group`,
		tier: 'write',
		description:
			op === 'archive'
				? 'Archive a list or segment: it is hidden from pickers and the Groups pages; members, rules and campaign history are kept. Refused while it is a public topic, the audience of a scheduled / sending campaign, or the trigger of an active automation. Admins only.'
				: 'Restore an archived list or segment exactly as it was. Admins only.',
		input_schema: { type: 'object', properties: { group_id: { type: 'integer' } }, required: ['group_id'] },
		summarize: (input) => `group #${input.group_id}`,
		gate: async (ctx) => (ctx.user.role === 'admin' ? null : `Only admins can ${op} lists and segments.`),
		plan: async (ctx, input) => {
			const g = await load(ctx, input);
			return { count: 0, sample: [], summary: `${verb} ${g.kind} “${g.name}”` };
		},
		apply: async (ctx, input) => {
			const g = await load(ctx, input);
			const r = op === 'archive' ? await archiveGroups(ctx.db, [g.id]) : await restoreGroups(ctx.db, [g.id]);
			if (r.skipped.length) throw new ToolInputError(`“${g.name}” was not ${op}d: ${r.skipped[0].reason}.`);
			const now = await ctx.db.prepare('SELECT archived_at FROM lists WHERE id = ?').bind(g.id).first<{ archived_at: string | null }>();
			return {
				summary: `${op === 'archive' ? 'Archived' : 'Restored'} ${g.kind} “${g.name}”`,
				before: { group_id: g.id, name: g.name, archived_at: g.archived_at } satisfies ArchiveState,
				after: { group_id: g.id, name: g.name, archived_at: now?.archived_at ?? null } satisfies ArchiveState,
				url: `${ctx.baseUrl}/lists/${g.id}`,
				result: { group_id: g.id, archived_at: now?.archived_at ?? null }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as ArchiveState;
			const a = after as ArchiveState;
			const g = await ctx.db.prepare('SELECT archived_at FROM lists WHERE id = ?').bind(a.group_id).first<{ archived_at: string | null }>();
			if (!g) throw new UndoRefused('That group no longer exists.');
			if ((g.archived_at ?? null) !== (a.archived_at ?? null)) throw new UndoRefused(`“${a.name}” was changed since — nothing was undone.`);
			await ctx.db.prepare('UPDATE lists SET archived_at = ? WHERE id = ?').bind(b.archived_at, a.group_id).run();
		}
	};
}

async function dynamicSegment(ctx: ToolContext, input: Record<string, unknown>): Promise<Group> {
	const id = intArg(input, 'segment_id', { required: true, min: 1 })!;
	const g = await groupById(ctx.db, id);
	if (!g || g.kind !== 'segment') throw new ToolInputError(`No segment with id ${id}.`);
	if (!parseRules(g.rules)) throw new ToolInputError(`“${g.name}” is a hand-picked segment (no rules).`);
	return g;
}

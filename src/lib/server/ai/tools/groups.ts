// Groups read tools (#287): lists, segments, tags and companies (all `lists` rows with a
// kind — the `kind` leak is handled by always filtering on it), members and counts.

import { activeMemberCount, activeOnly, memberCount, memberIds, type ListRow } from '../../segments';
import { parseRules } from '../../segment-query';
import { contactBriefs } from './contacts';
import { LIMIT_PROP, ToolInputError, intArg, limitArg, strArg, type Tool } from './types';

const KINDS = ['list', 'segment', 'tag', 'company'] as const;

type GroupRow = ListRow & { name: string; description: string | null; created_at: string; archived_at: string | null };

export const groupTools: Tool[] = [
	{
		name: 'list_groups',
		tier: 'read',
		description:
			'Lists, segments (hand-picked or dynamic rules), tags or companies, with member counts (members = non-archived contacts; subscribed = of those, subscribed). Up to 100, by name. Archived lists / segments are left out unless include_archived is true; archived_at is set on archived ones.',
		input_schema: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: [...KINDS], description: 'Group type.' },
				q: { type: 'string', description: 'Name contains.' },
				include_archived: { type: 'boolean', description: 'Also list archived lists / segments (default false).' }
			},
			required: ['kind']
		},
		summarize: (input) => `${input.kind}s${input.q ? ` matching "${input.q}"` : ''}`,
		handler: async (ctx, input) => {
			const kind = strArg(input, 'kind', 20);
			if (!(KINDS as readonly string[]).includes(kind)) throw new ToolInputError('kind must be list, segment, tag or company.');
			const q = strArg(input, 'q', 100);
			const includeArchived = input.include_archived === true;
			const rows = await ctx.db
				.prepare(
					`SELECT id, kind, name, description, created_at, rules, archived_at FROM lists
					 WHERE kind = ? AND (? = 1 OR archived_at IS NULL) AND (? = '' OR name LIKE ? ESCAPE '\\')
					 ORDER BY name COLLATE NOCASE LIMIT 100`
				)
				.bind(kind, includeArchived ? 1 : 0, q, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
				.all<GroupRow>();
			const groups = [];
			for (const r of rows.results) {
				// #705: `members` = the active audience (unsubscribed / archived not counted).
				const [members, subscribed] = await Promise.all([activeMemberCount(ctx.db, r), memberCount(ctx.db, r)]);
				groups.push({
					id: r.id,
					name: r.name,
					kind: r.kind,
					description: r.description,
					dynamic: r.kind === 'segment' && parseRules(r.rules ?? null) !== null,
					members,
					subscribed,
					created_at: r.created_at,
					archived_at: r.archived_at,
					url: `${ctx.baseUrl}/lists/${r.id}`
				});
			}
			return { kind, count: groups.length, groups };
		}
	},
	{
		name: 'get_group_members',
		tier: 'read',
		description: 'The members of one list/segment/tag/company by group id (dynamic segments resolved from their rules), with the rules when it has any.',
		input_schema: {
			type: 'object',
			properties: {
				group_id: { type: 'integer' },
				subscribed_only: { type: 'boolean' },
				limit: LIMIT_PROP,
				offset: { type: 'integer', minimum: 0 }
			},
			required: ['group_id']
		},
		summarize: (input) => `group #${input.group_id}`,
		handler: async (ctx, input) => {
			const id = intArg(input, 'group_id', { required: true, min: 1 })!;
			const group = await ctx.db
				.prepare(`SELECT id, kind, name, description, created_at, rules, archived_at FROM lists WHERE id = ?`)
				.bind(id)
				.first<GroupRow>();
			if (!group) throw new ToolInputError(`No group with id ${id}.`);
			// #705: the active audience only (unsubscribed / archived members are left out).
			const ids = await activeOnly(ctx.db, group, await memberIds(ctx.db, group, input.subscribed_only === true));
			const limit = limitArg(input);
			const offset = intArg(input, 'offset', { min: 0 }) ?? 0;
			return {
				group: { id: group.id, name: group.name, kind: group.kind, rules: parseRules(group.rules ?? null), archived_at: group.archived_at },
				total: ids.length,
				offset,
				members: await contactBriefs(ctx, ids.slice(offset, offset + limit))
			};
		}
	}
];

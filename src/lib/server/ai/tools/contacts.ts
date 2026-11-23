// Contacts read tools (#287): search/filter, one contact, engagement, timeline.

import {
	CONTACT_GROUPS_SQL,
	dynamicSegmentNames,
	loadContact,
	mergeDynamicLists,
	serializeContact,
	type ContactRow,
	type SerializedContact
} from '../../api-v1';
import { contactsOrder, contactsWhere, parseContactsFilter } from '../../contacts-query';
import { engagementProfile } from '../../engagement-query';
import { conversationsFor } from '../../conversations';
import { siteTimeline } from '../../site-activity';
import { apiHistoryFor } from '../../pipeline-api';
import { subscriptionStatusText } from '$lib/double-optin';
import { LIMIT_PROP, ToolInputError, intArg, limitArg, type Tool, type ToolContext } from './types';

// The /contacts URL filter keys (contacts-query.ts) the model may pass through.
const FILTER_KEYS = [
	'q', 'status', 'source', 'company', 'company_id', 'added_from', 'added_to', 'in', 'notin', 'visited',
	'visited_days', 'site', 'has_company', 'cm', 'tier', 'opened_days', 'never_opened', 'opened_n', 'opened_of',
	'pipeline', 'archived', 'bounced', 'spam', 'campaign', 'campaign_who', 'sort', 'dir'
];

function brief(c: SerializedContact, baseUrl: string, pending = false) {
	return {
		id: c.id,
		email: c.email,
		name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
		company: c.company,
		subscribed: c.subscribed,
		// #510: 'subscribed' | 'unsubscribed' | 'pending confirmation' (double opt-in not confirmed yet).
		status: subscriptionStatusText(c.subscribed, pending),
		archived: !!c.archived_at,
		tier: c.tier,
		score: c.score,
		tags: c.tags,
		lists: c.lists,
		created_at: c.created_at,
		url: `${baseUrl}/contacts/${c.id}`
	};
}

/** Brief rows (no meta) for these contact ids, in the given order. */
export async function contactBriefs(ctx: ToolContext, order: number[]) {
	if (!order.length) return [];
	const rows = await ctx.db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.company_id, c.subscribed, c.confirm_pending,
			        c.source, c.created_at, c.archived_at, NULL AS meta, ${CONTACT_GROUPS_SQL}
			 FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(order))
		.all<ContactRow & { confirm_pending: number }>();
	const byId = new Map(rows.results.map((r) => [r.id, serializeContact(r)]));
	const pending = new Set(rows.results.filter((r) => r.confirm_pending === 1).map((r) => r.id));
	const contacts = order.map((id) => byId.get(id)).filter((c): c is SerializedContact => !!c);
	mergeDynamicLists(contacts, await dynamicSegmentNames(ctx.db, order));
	return contacts.map((c) => brief(c, ctx.baseUrl, pending.has(c.id)));
}

async function requireContact(ctx: ToolContext, input: Record<string, unknown>): Promise<SerializedContact> {
	const id = intArg(input, 'contact_id', { required: true, min: 1 })!;
	const c = await loadContact(ctx.db, id);
	if (!c) throw new ToolInputError(`No contact with id ${id}.`);
	return c;
}

const CONTACT_ID = { contact_id: { type: 'integer', description: 'Contact id.' } };

export const contactTools: Tool[] = [
	{
		name: 'search_contacts',
		tier: 'read',
		description:
			'Search and filter contacts, same filters as the /contacts page. Archived contacts are excluded unless filter.archived is "1" (archived only) or "all". Returns the matching total and one page of contacts.',
		input_schema: {
			type: 'object',
			properties: {
				filter: {
					type: 'object',
					description:
						'Optional /contacts query params as strings: q (search email/name), status (default active = subscribed or pending; subscribed|unsubscribed|pending|all — pending = double opt-in not confirmed yet; unsubscribed or archived contacts only appear when asked for), source, company, company_id, added_from/added_to (YYYY-MM-DD), in/notin (group id), tier (hot|warm|cool|cold|never|new), opened_days, never_opened ("1"), opened_n + opened_of, pipeline (any|none|<stage id>), visited (path contains) + visited_days, site (any|none), has_company (yes|no), bounced (hard|any), spam ("1"), campaign (id) + campaign_who (sent|opens|opened|clicked|none|bounced|unsubscribed), archived ("1"|"all"), sort (created_at|email|name|company|source), dir (asc|desc).',
					additionalProperties: { type: ['string', 'number'] }
				},
				limit: LIMIT_PROP,
				offset: { type: 'integer', minimum: 0 }
			}
		},
		summarize: (input) => {
			const f = (input.filter ?? {}) as Record<string, unknown>;
			const parts = Object.entries(f).map(([k, v]) => `${k}=${v}`);
			return parts.length ? parts.join(', ') : 'all contacts';
		},
		handler: async (ctx, input) => {
			const raw = input.filter && typeof input.filter === 'object' ? (input.filter as Record<string, unknown>) : {};
			const params = new URLSearchParams();
			for (const k of FILTER_KEYS) {
				const v = raw[k];
				if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
			}
			const filter = parseContactsFilter(params);
			const { where, params: binds } = contactsWhere(filter);
			const { orderExpr } = contactsOrder(params);
			const limit = limitArg(input);
			const offset = intArg(input, 'offset', { min: 0 }) ?? 0;
			const [total, ids] = await Promise.all([
				ctx.db.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`).bind(...binds).first<{ n: number }>(),
				ctx.db
					.prepare(`SELECT id FROM contacts ${where} ORDER BY ${orderExpr} LIMIT ? OFFSET ?`)
					.bind(...binds, limit, offset)
					.all<{ id: number }>()
			]);
			const contacts = await contactBriefs(ctx, ids.results.map((r) => r.id));
			return { total: total?.n ?? 0, offset, contacts };
		}
	},
	{
		name: 'get_contact',
		tier: 'read',
		description: 'One contact by id: details, custom fields (meta), tags, lists, engagement tier/score.',
		input_schema: { type: 'object', properties: CONTACT_ID, required: ['contact_id'] },
		summarize: (input) => `contact #${input.contact_id}`,
		handler: async (ctx, input) => {
			const c = await requireContact(ctx, input);
			const p = await ctx.db.prepare('SELECT confirm_pending FROM contacts WHERE id = ?').bind(c.id).first<{ confirm_pending: number }>();
			return { ...c, status: subscriptionStatusText(c.subscribed, p?.confirm_pending), url: `${ctx.baseUrl}/contacts/${c.id}` };
		}
	},
	{
		name: 'get_contact_engagement',
		tier: 'read',
		description:
			"A contact's engagement profile: tier, score, sends/opens/clicks/replies, rates, last activity, best hour/day (UTC), top client/country, 12-month opens/clicks.",
		input_schema: { type: 'object', properties: CONTACT_ID, required: ['contact_id'] },
		summarize: (input) => `contact #${input.contact_id}`,
		handler: async (ctx, input) => {
			const c = await requireContact(ctx, input);
			return { contact_id: c.id, email: c.email, ...(await engagementProfile(ctx.db, c.id, ctx.now)) };
		}
	},
	{
		name: 'get_contact_timeline',
		tier: 'read',
		description:
			"A contact's history: email conversations (sends with opened/clicked signals, replies), site visits/events and pipeline moves, newest first.",
		input_schema: { type: 'object', properties: { ...CONTACT_ID, limit: LIMIT_PROP }, required: ['contact_id'] },
		summarize: (input) => `contact #${input.contact_id}`,
		handler: async (ctx, input) => {
			const c = await requireContact(ctx, input);
			const limit = limitArg(input, 25);
			const [convs, site, pipeline] = await Promise.all([
				conversationsFor(ctx.db, c.id),
				siteTimeline(ctx.db, c.id, limit),
				apiHistoryFor(ctx.db, c.id, limit)
			]);
			return {
				contact_id: c.id,
				conversations: convs.slice(0, limit).map((t) => ({
					subject: t.subject,
					kind: t.root_kind,
					campaign_id: t.root_campaign_id,
					sent: t.sent,
					replies: t.replies,
					last_at: t.last_at,
					awaiting_reply: t.awaiting,
					messages: t.messages.slice(-5).map((m) => ({
						dir: m.dir,
						at: m.at,
						subject: m.subject,
						status: m.status,
						signals: m.signals,
						text: m.text ? m.text.slice(0, 500) : (m.snippet ?? null)
					}))
				})),
				site_activity: site,
				pipeline: pipeline.map((h) => ({
					at: h.created_at,
					from: h.from_stage,
					to: h.to_stage,
					by: h.actor_label ?? h.actor_kind,
					note: h.note
				}))
			};
		}
	}
];

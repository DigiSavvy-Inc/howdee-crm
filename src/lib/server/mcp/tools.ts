// #348: the MCP server's tools. Thin wrappers, no forked logic:
//  - reads reuse the assistant's read tools (#287: contacts, groups, campaigns, deliverability)
//    or the modules the /api/v1 read handlers call (automations, checks, engagement);
//  - every write calls the /api/v1 draft handler itself (#238/#252 campaigns, #347
//    automations) in-process, with the caller's own Authorization header — so the handler's
//    scope check, validation, draft-only rule and usage counter apply unchanged.
// There is no send, schedule, activate or enroll tool, and nothing here may import one:
// tests/mcp.test.ts walks this module's import graph.

import type { RequestEvent } from '@sveltejs/kit';
import type { ApiScope } from '$lib/server/api-keys';
import type { SessionUser } from '$lib/server/users';
import { listAutomations } from '$lib/server/automation-read';
import { normalizeLabel } from '$lib/server/automation-labels';
import { AUTOMATION_VOCABULARY, automationRecord } from '$lib/server/automations-api';
import { engagementSummary } from '$lib/server/engagement-query';
import { getForm } from '$lib/server/forms';
import { formSubmissionsForApi, listFormsForApi, parseSince, SUBMISSIONS_MAX_LIMIT } from '$lib/server/forms-api';
import { presendInputForCampaign, runPresendChecks } from '$lib/server/presend-checks';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { contactTools } from '$lib/server/ai/tools/contacts';
import { groupTools } from '$lib/server/ai/tools/groups';
import { campaignTools } from '$lib/server/ai/tools/campaigns';
import { insightTools } from '$lib/server/ai/tools/insights';
import { scoreTools } from '$lib/server/ai/tools/scores';
import { ToolInputError, type ReadTool, type Tool, type ToolContext } from '$lib/server/ai/tools/types';

import { POST as campaignsPOST } from '../../../routes/api/v1/campaigns/+server';
import { PATCH as campaignPATCH } from '../../../routes/api/v1/campaigns/[id]/+server';
import { POST as automationsPOST } from '../../../routes/api/v1/automations/+server';
import { PATCH as automationPATCH } from '../../../routes/api/v1/automations/[id]/+server';
import { PUT as specPUT } from '../../../routes/api/v1/automations/[id]/spec/+server';
import { POST as stepsPOST } from '../../../routes/api/v1/automations/[id]/steps/+server';
import { PATCH as stepPATCH, DELETE as stepDELETE } from '../../../routes/api/v1/automations/[id]/steps/[stepId]/+server';
import { POST as reorderPOST } from '../../../routes/api/v1/automations/[id]/steps/reorder/+server';
import { POST as duplicatePOST } from '../../../routes/api/v1/automations/[id]/duplicate/+server';

/**
 * Which keys get a tool: `read` = read and read_write keys; a draft group = that draft scope or
 * read_write. A draft key gets only its own group (#538: like /api/v1, no reads), plus a tool
 * whose `alsoFor` names its scope (reference material that returns no CRM data).
 */
export type ToolGroup = 'read' | 'campaigns:draft' | 'automations:draft';

export type McpToolDef = {
	name: string;
	group: ToolGroup;
	/** Extra draft scopes that may use this tool — only for tools that return no CRM data. */
	alsoFor?: ApiScope[];
	description: string;
	inputSchema: Record<string, unknown>;
	run: (call: ToolCall) => Promise<unknown>;
};

export type ToolCall = { event: RequestEvent; args: Record<string, unknown> };

/** A tool failure the client sees as an `isError` result (bad input, 4xx from a handler). */
export class McpToolError extends Error {
	constructor(
		message: string,
		readonly detail?: unknown
	) {
		super(message);
	}
}

export function scopeAllows(scope: ApiScope, group: ToolGroup): boolean {
	if (scope === 'read_write') return true;
	if (group === 'read') return scope === 'read';
	return scope === group;
}

/** May a key with this scope list and call this tool? */
export function toolAllowed(scope: ApiScope, tool: Pick<McpToolDef, 'group' | 'alsoFor'>): boolean {
	return scopeAllows(scope, tool.group) || (tool.alsoFor?.includes(scope) ?? false);
}

/** The spec format, short enough for a tool description; the full one is get_automation_spec_format / GET /api/v1. */
const SPEC_HELP =
	'Spec format (AutomationSpec): { name, trigger: { type: manual | list_added (list_id) | company_metric | site_visit | pipeline_stage_entered | email_opened | email_clicked (email: any | { campaign_id } | { step_id }, list_id?, link?, exclude?) | site_activity (measure: pages|visits, threshold, days ≤ 180, site_id?, path_op?, path?, cooldown_hours?) | subscription_changed (events: [unsubscribed|resubscribed|bounced|complained|topic_optout|topic_optin], topic_list_id?, sources?; email steps are skipped for unsubscribed contacts) | score_changed (score_id, mode: crosses_above|crosses_below (threshold) | enters_band (band) | any_change), … }, reentry?: once | multiple, labels?: [..], entry_rules?: { match, rules }, steps: [StepSpec] }. ' +
	'StepSpec: { type: email | tag | branch | action | end, ref? (local name other steps point at), wait_seconds?, weekday_only?, … }. ' +
	'email: subject, body_md (markdown, merge tags like {{first_name}}), preheader?, from_email? (default From). tag: tag_action add|remove, tag_name. ' +
	'branch: condition (e.g. { kind: "opened", step_ref: "welcome" } or { kind: "rules", match: "all", rules: [...] }), yes: [steps], no: [steps]. ' +
	'action: { kind: enroll_automation | end_automation | end_all_automations | goto_step | pipeline_move | pipeline_remove | set_tier (tier: hot|warm|cool|cold|never|new|clear, days? 1–365) | adjust_score (score_id, points ±, expires_days?), … }. ' +
	'Call get_automation_spec_format (same as the `automations.vocabulary` block of GET /api/v1, the discovery doc) for every field and a full example before writing a flow.';

// ---- adapters ---------------------------------------------------------------------------

const API_USER: SessionUser = {
	id: 0,
	github_login: 'api',
	name: 'Data API key',
	avatar_url: null,
	role: 'member',
	tourSeen: true,
	navLayout: 'top',
	passwordSetAt: null,
	mustChangePassword: false
};

function findRead(tools: Tool[], name: string): ReadTool {
	const t = tools.find((x) => x.name === name);
	if (!t || t.tier !== 'read') throw new Error(`assistant read tool ${name} missing`);
	return t;
}

/** Run one of the assistant's read tools with a context for the key (reads never use `user`). */
async function assistantRead(tool: ReadTool, call: ToolCall, input: Record<string, unknown>): Promise<unknown> {
	const ctx: ToolContext = {
		db: call.event.platform!.env.DB,
		user: API_USER,
		baseUrl: await publicBaseUrlFor(call.event),
		now: new Date()
	};
	try {
		return await tool.handler(ctx, input);
	} catch (e) {
		if (e instanceof ToolInputError) throw new McpToolError(e.message);
		throw e;
	}
}

type Handler = (event: RequestEvent) => Response | Promise<Response>;

/**
 * Call a /api/v1 handler in-process: same platform and Authorization header, the route's
 * params and a JSON body. A 4xx/5xx becomes a tool error with the API's message.
 */
async function callApi(
	call: ToolCall,
	handler: unknown,
	method: string,
	path: string,
	params: Record<string, string>,
	body?: unknown
): Promise<unknown> {
	const url = new URL(path, call.event.url.origin);
	const headers = new Headers({ 'content-type': 'application/json' });
	const auth = call.event.request.headers.get('authorization');
	if (auth) headers.set('authorization', auth);
	const request = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const res = await (handler as Handler)({ ...call.event, request, url, params } as RequestEvent);
	if (res.status === 204) return { ok: true };
	const text = await res.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		parsed = { error: text };
	}
	if (res.status >= 400) {
		const { error, ...rest } = parsed;
		throw new McpToolError(typeof error === 'string' ? error : `HTTP ${res.status}`, Object.keys(rest).length ? rest : undefined);
	}
	return 'data' in parsed ? parsed.data : parsed;
}

function intArg(args: Record<string, unknown>, key: string): number {
	const n = Number(args[key]);
	if (!Number.isInteger(n) || n <= 0) throw new McpToolError(`${key} must be a positive integer.`);
	return n;
}

function objArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
	const v = args[key];
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new McpToolError(`${key} must be an object.`);
	return v as Record<string, unknown>;
}

/** Copy only the listed keys that are present. */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(keys.filter((k) => k in args).map((k) => [k, args[k]]));
}

// ---- schemas ----------------------------------------------------------------------------

const ID = (what: string) => ({ type: 'integer', minimum: 1, description: `${what} id.` });
const LIMIT = { type: 'integer', minimum: 1, maximum: 100, description: 'Page size (default 25).' };
const OFFSET = { type: 'integer', minimum: 0 };
const SPEC = { type: 'object', description: 'An AutomationSpec. ' + SPEC_HELP, additionalProperties: true };
const STEP_FIELDS =
	'Step fields of that type: wait_seconds, weekday_only; email: subject, body_md or body_blocks, preheader, from_email, tag_on_open, tag_on_click; tag: tag_action, tag_name; branch: condition; action: action. Step references here are real step ids (step_id), not refs.';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: 'object',
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

// ---- the tools --------------------------------------------------------------------------

const searchContacts = findRead(contactTools, 'search_contacts');
const getContact = findRead(contactTools, 'get_contact');
const listGroups = findRead(groupTools, 'list_groups');
const listCampaigns = findRead(campaignTools, 'list_campaigns');
const getCampaign = findRead(campaignTools, 'get_campaign');
const getDeliverability = findRead(insightTools, 'get_deliverability');
// #467: named scores — the assistant's read tools (the write tool add_score_points is not wrapped).
const listScores = findRead(scoreTools, 'list_scores');
const getContactScores = findRead(scoreTools, 'get_contact_scores');
const getScoreLeaders = findRead(scoreTools, 'get_score_leaders');

const AUTOMATION_STATUSES = ['active', 'paused', 'draft'];

export const MCP_TOOLS: McpToolDef[] = [
	// -- read (read and read_write keys) --
	{
		name: 'search_contacts',
		group: 'read',
		description:
			'Search contacts by email or name (q) and/or the /contacts filters. Archived contacts are left out unless filter.archived is "1" or "all". Returns the total and one page.',
		inputSchema: obj({
			q: { type: 'string', description: 'Email or name contains.' },
			filter: searchContacts.input_schema.properties
				? (searchContacts.input_schema.properties as Record<string, unknown>).filter
				: { type: 'object' },
			limit: LIMIT,
			offset: OFFSET
		}),
		run: (call) => {
			const filter = { ...((call.args.filter as Record<string, unknown> | undefined) ?? {}) };
			if (typeof call.args.q === 'string' && call.args.q.trim()) filter.q = call.args.q.trim();
			return assistantRead(searchContacts, call, { filter, limit: call.args.limit, offset: call.args.offset });
		}
	},
	{
		name: 'get_contact',
		group: 'read',
		description: getContact.description,
		inputSchema: obj({ contact_id: ID('Contact') }, ['contact_id']),
		run: (call) => assistantRead(getContact, call, { contact_id: intArg(call.args, 'contact_id') })
	},
	{
		name: 'list_groups',
		group: 'read',
		description: `${listGroups.description} Use a list or tag id here as trigger.list_id / list_id in automations and campaign drafts.`,
		inputSchema: obj(
			{
				kind: { type: 'string', enum: ['list', 'segment', 'tag', 'company'], description: 'Group type.' },
				q: { type: 'string', description: 'Name contains.' },
				include_archived: { type: 'boolean', description: 'Also list archived lists / segments (#472, default false).' }
			},
			['kind']
		),
		run: (call) => assistantRead(listGroups, call, pick(call.args, ['kind', 'q', 'include_archived']))
	},
	{
		name: 'list_campaigns',
		group: 'read',
		description: listCampaigns.description,
		inputSchema: obj({
			status: { type: 'string', enum: ['draft', 'scheduled', 'sending', 'sent'] },
			q: { type: 'string', description: 'Subject contains.' },
			limit: LIMIT,
			offset: OFFSET
		}),
		run: (call) => assistantRead(listCampaigns, call, pick(call.args, ['status', 'q', 'limit', 'offset']))
	},
	{
		name: 'get_campaign',
		group: 'read',
		description: getCampaign.description,
		inputSchema: obj({ campaign_id: ID('Campaign') }, ['campaign_id']),
		run: (call) => assistantRead(getCampaign, call, { campaign_id: intArg(call.args, 'campaign_id') })
	},
	{
		name: 'run_campaign_checks',
		group: 'read',
		description:
			'The pre-send checks for a stored campaign (links, images, content, merge tags, audience): each check is block / warn / pass. Read-only; it never sends or schedules. check_links adds a live link check (≤ 30 links).',
		inputSchema: obj({ campaign_id: ID('Campaign'), check_links: { type: 'boolean' } }, ['campaign_id']),
		run: async (call) => {
			// Same calls as POST /api/v1/campaigns/:id/checks.
			const id = intArg(call.args, 'campaign_id');
			const db = call.event.platform!.env.DB;
			const input = await presendInputForCampaign(db, id);
			if (!input) throw new McpToolError('No campaign with that id.');
			const r = await runPresendChecks(db, input, { media: call.event.platform?.env?.MEDIA, checkLinks: call.args.check_links === true });
			return { campaign_id: id, checks: r.checks, blocks: r.blocks, warns: r.warns, passes: r.passes, links_checked: r.linksChecked };
		}
	},
	{
		name: 'list_automations',
		group: 'read',
		description: 'Automations by name: id, name, status, trigger, re-entry, step count, active enrollment count, labels.',
		inputSchema: obj({
			status: { type: 'string', enum: AUTOMATION_STATUSES },
			label: { type: 'string', description: 'Exact label (case-insensitive).' }
		}),
		run: async (call) => {
			// Same calls as GET /api/v1/automations.
			const status = typeof call.args.status === 'string' ? call.args.status : null;
			if (status !== null && !AUTOMATION_STATUSES.includes(status)) throw new McpToolError('Invalid status filter. Use one of: active, paused, draft.');
			const label = normalizeLabel(typeof call.args.label === 'string' ? call.args.label : '');
			return listAutomations(call.event.platform!.env.DB, { status, label });
		}
	},
	{
		name: 'get_automation',
		group: 'read',
		description:
			'One automation: status, trigger, labels, editor_url, the whole flow as `spec` (the format build_automation / replace_automation_spec take), the flat `steps` list with real step ids (what the step tools take) and stats.',
		inputSchema: obj({ automation_id: ID('Automation') }, ['automation_id']),
		run: async (call) => {
			// Same calls as GET /api/v1/automations/:id.
			const record = await automationRecord(call.event.platform!.env.DB, intArg(call.args, 'automation_id'), await publicBaseUrlFor(call.event));
			if (!record) throw new McpToolError('Automation not found.');
			return record;
		}
	},
	{
		name: 'get_automation_spec_format',
		group: 'read',
		alsoFor: ['automations:draft'],
		description:
			'The AutomationSpec vocabulary: trigger types and fields, step types and fields, condition kinds, action kinds and a full example. Same as `resources.automations.vocabulary` in GET /api/v1 (the discovery doc). Read it before build_automation.',
		inputSchema: obj({}),
		run: async () => AUTOMATION_VOCABULARY
	},
	{
		name: 'get_deliverability',
		group: 'read',
		description: getDeliverability.description,
		inputSchema: obj({}),
		run: (call) => assistantRead(getDeliverability, call, {})
	},
	{
		name: 'list_scores',
		group: 'read',
		description: listScores.description,
		inputSchema: obj({}),
		run: (call) => assistantRead(listScores, call, {})
	},
	{
		name: 'get_contact_scores',
		group: 'read',
		description: getContactScores.description,
		inputSchema: obj({ contact_id: ID('Contact'), email: { type: 'string', description: 'Instead of contact_id.' } }),
		run: (call) => assistantRead(getContactScores, call, pick(call.args, ['contact_id', 'email']))
	},
	{
		name: 'get_score_leaders',
		group: 'read',
		description: getScoreLeaders.description,
		inputSchema: obj(
			{
				score: { type: ['integer', 'string'], description: 'The score: id, slug or name (see list_scores).' },
				band: { type: 'string', description: 'Only contacts in this band.' },
				limit: { type: 'integer', minimum: 1, maximum: 100 }
			},
			['score']
		),
		run: (call) => assistantRead(getScoreLeaders, call, pick(call.args, ['score', 'band', 'limit']))
	},
	{
		name: 'get_engagement_summary',
		group: 'read',
		description: 'Audience-wide engagement: contacts per tier (hot/warm/cool/cold/never/new), average score, opened/clicked in 30 days, recompute backlog.',
		inputSchema: obj({}),
		// Same call as GET /api/v1/engagement/summary.
		run: (call) => engagementSummary(call.event.platform!.env.DB)
	},
	{
		name: 'list_forms',
		group: 'read',
		description:
			'Forms (#620), newest edit first: id, name, slug, status (draft / published / archived), url (published only), fields (key, type, label, required), pages, accepted submission count, last submission time. Archived forms only with include_archived. Read-only.',
		inputSchema: obj({
			status: { type: 'string', enum: ['draft', 'published', 'archived'] },
			include_archived: { type: 'boolean', description: 'Also list archived forms (default false).' }
		}),
		run: async (call) => {
			// Same call as GET /api/v1/forms.
			const status = typeof call.args.status === 'string' ? call.args.status : null;
			if (status !== null && !['draft', 'published', 'archived'].includes(status)) throw new McpToolError('status must be draft, published or archived.');
			return listFormsForApi(call.event.platform!.env.DB, await publicBaseUrlFor(call.event), {
				includeArchived: status === 'archived' || call.args.include_archived === true,
				status: status as 'draft' | 'published' | 'archived' | null
			});
		}
	},
	{
		name: 'get_form_submissions',
		group: 'read',
		description:
			'One form\'s accepted submissions (added / updated / anonymous; spam and rejected are left out), newest first: id, contact_id, email, status, answers (by question key — see list_forms for the keys), utm, page_url, submitted_at. since = only submissions after a date or ISO date-time. Read-only.',
		inputSchema: obj(
			{
				form_id: ID('Form'),
				since: { type: 'string', description: 'YYYY-MM-DD or an ISO date-time (UTC); only submissions after it.' },
				limit: { type: 'integer', minimum: 1, maximum: SUBMISSIONS_MAX_LIMIT, description: 'Page size (default 50, max 200).' },
				offset: OFFSET
			},
			['form_id']
		),
		run: async (call) => {
			// Same calls as GET /api/v1/forms/:id/submissions.
			const db = call.event.platform!.env.DB;
			const since = parseSince(typeof call.args.since === 'string' ? call.args.since : null);
			if (since === null) throw new McpToolError('since must be a date (YYYY-MM-DD) or an ISO date-time.');
			const form = await getForm(db, intArg(call.args, 'form_id'));
			if (!form) throw new McpToolError('Form not found.');
			const limit = call.args.limit === undefined ? undefined : Number(call.args.limit);
			const offset = call.args.offset === undefined ? undefined : Number(call.args.offset);
			const res = await formSubmissionsForApi(db, form.id, {
				since,
				limit: Number.isFinite(limit) ? limit : undefined,
				offset: Number.isFinite(offset) ? offset : undefined
			});
			return { form_id: form.id, total: res.total, limit: res.limit, offset: res.offset, has_more: res.offset + res.limit < res.total, submissions: res.rows };
		}
	},

	// -- campaign drafts (campaigns:draft or read_write) --
	{
		name: 'create_campaign_draft',
		group: 'campaigns:draft',
		description:
			'Create a Compose DRAFT from a subject and a markdown body (merge tags like {{first_name}} work). Never sends or schedules; no recipients. Returns the id and compose_url — a human reviews and sends it in the app.',
		inputSchema: obj({ subject: { type: 'string' }, body: { type: 'string', description: 'Markdown.' } }, ['subject', 'body']),
		run: (call) => callApi(call, campaignsPOST, 'POST', '/api/v1/campaigns', {}, pick(call.args, ['subject', 'body']))
	},
	{
		name: 'update_campaign_draft',
		group: 'campaigns:draft',
		description:
			'Edit a DRAFT campaign (key-present: a given field is written, null clears). Anything that is not a draft is refused. Never sends or schedules.',
		inputSchema: obj(
			{
				campaign_id: ID('Campaign'),
				subject: { type: 'string' },
				preheader: { type: ['string', 'null'] },
				body: { type: 'string', description: 'Markdown; replaces the whole body.' },
				list_id: { type: ['integer', 'null'], description: 'Audience: a list or segment id (list_groups).' },
				template_id: { type: ['integer', 'null'] },
				from_email: { type: ['string', 'null'], description: 'An approved sender.' },
				resend_delay: { type: ['string', 'null'], enum: ['24h', '3d', null] }
			},
			['campaign_id']
		),
		run: (call) => {
			const id = intArg(call.args, 'campaign_id');
			const body = pick(call.args, ['subject', 'preheader', 'body', 'list_id', 'template_id', 'from_email', 'resend_delay']);
			return callApi(call, campaignPATCH, 'PATCH', `/api/v1/campaigns/${id}`, { id: String(id) }, body);
		}
	},

	// -- automation drafts (automations:draft or read_write) --
	{
		name: 'build_automation',
		group: 'automations:draft',
		description:
			'Create a whole automation as a DRAFT (never active, nobody enrolled) from a spec. Returns the record, editor_url and step_ids (ref → id). Activation is a human click in the app. A bad spec returns every problem with its path. ' +
			SPEC_HELP,
		inputSchema: obj({ spec: SPEC }, ['spec']),
		run: (call) => callApi(call, automationsPOST, 'POST', '/api/v1/automations', {}, objArg(call.args, 'spec'))
	},
	{
		name: 'update_automation',
		group: 'automations:draft',
		description: 'Edit a draft or paused automation: name, trigger (a TriggerSpec), reentry (once|multiple), labels (the whole new set). Never changes status.',
		inputSchema: obj(
			{
				automation_id: ID('Automation'),
				name: { type: 'string' },
				trigger: { type: 'object', additionalProperties: true, description: 'e.g. { "type": "list_added", "list_id": 12 }' },
				reentry: { type: 'string', enum: ['once', 'multiple'] },
				labels: { type: 'array', items: { type: 'string' } }
			},
			['automation_id']
		),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			return callApi(call, automationPATCH, 'PATCH', `/api/v1/automations/${id}`, { id: String(id) }, pick(call.args, ['name', 'trigger', 'reentry', 'labels']));
		}
	},
	{
		name: 'replace_automation_spec',
		group: 'automations:draft',
		description: 'Replace the whole flow of a DRAFT automation that has no enrollments yet. Flow: get_automation → edit `spec` → this. ' + SPEC_HELP,
		inputSchema: obj({ automation_id: ID('Automation'), spec: SPEC }, ['automation_id', 'spec']),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			return callApi(call, specPUT, 'PUT', `/api/v1/automations/${id}/spec`, { id: String(id) }, objArg(call.args, 'spec'));
		}
	},
	{
		name: 'add_automation_step',
		group: 'automations:draft',
		description:
			'Add one configured step to a draft or paused automation: step = { type, parent_step_id? (a branch), branch_label? (yes|no), position?, …fields }. ' + STEP_FIELDS,
		inputSchema: obj(
			{
				automation_id: ID('Automation'),
				step: { type: 'object', additionalProperties: true, properties: { type: { type: 'string', enum: ['email', 'tag', 'branch', 'action', 'end'] } }, required: ['type'] }
			},
			['automation_id', 'step']
		),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			return callApi(call, stepsPOST, 'POST', `/api/v1/automations/${id}/steps`, { id: String(id) }, objArg(call.args, 'step'));
		}
	},
	{
		name: 'edit_automation_step',
		group: 'automations:draft',
		description:
			"Replace a step's configuration with `fields` (not a patch: an omitted field takes its default — read get_automation first). Type and place can't change. " + STEP_FIELDS,
		inputSchema: obj({ automation_id: ID('Automation'), step_id: ID('Step'), fields: { type: 'object', additionalProperties: true } }, ['automation_id', 'step_id', 'fields']),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			const stepId = intArg(call.args, 'step_id');
			return callApi(call, stepPATCH, 'PATCH', `/api/v1/automations/${id}/steps/${stepId}`, { id: String(id), stepId: String(stepId) }, objArg(call.args, 'fields'));
		}
	},
	{
		name: 'delete_automation_step',
		group: 'automations:draft',
		description: 'Delete a step from a draft or paused automation (a branch takes its whole subtree).',
		inputSchema: obj({ automation_id: ID('Automation'), step_id: ID('Step') }, ['automation_id', 'step_id']),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			const stepId = intArg(call.args, 'step_id');
			return callApi(call, stepDELETE, 'DELETE', `/api/v1/automations/${id}/steps/${stepId}`, { id: String(id), stepId: String(stepId) });
		}
	},
	{
		name: 'reorder_automation_steps',
		group: 'automations:draft',
		description: "Reorder one lane: order = exactly that lane's step ids. Default lane is the trunk; give parent_step_id + branch_label for a branch lane.",
		inputSchema: obj(
			{
				automation_id: ID('Automation'),
				order: { type: 'array', items: { type: 'integer' } },
				parent_step_id: { type: ['integer', 'null'] },
				branch_label: { type: ['string', 'null'], enum: ['yes', 'no', null] }
			},
			['automation_id', 'order']
		),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			return callApi(call, reorderPOST, 'POST', `/api/v1/automations/${id}/steps/reorder`, { id: String(id) }, pick(call.args, ['order', 'parent_step_id', 'branch_label']));
		}
	},
	{
		name: 'duplicate_automation',
		group: 'automations:draft',
		description: 'Copy any automation (steps, branches, labels) into a new DRAFT named "<name> (copy)".',
		inputSchema: obj({ automation_id: ID('Automation') }, ['automation_id']),
		run: (call) => {
			const id = intArg(call.args, 'automation_id');
			return callApi(call, duplicatePOST, 'POST', `/api/v1/automations/${id}/duplicate`, { id: String(id) });
		}
	}
];

/** Writes are counted by the /api/v1 handler they call; everything else is counted by the MCP endpoint. */
export const countsItself = (t: McpToolDef) => t.group !== 'read';

/** Tool names per key scope, for Settings → API. */
export function toolsForScope(scope: ApiScope): string[] {
	return MCP_TOOLS.filter((t) => toolAllowed(scope, t)).map((t) => t.name);
}

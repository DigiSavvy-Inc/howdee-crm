// The assistant's tool registry (#287). Read tools since Phase 1; write tools (#301, Phase 2)
// apply at once with an Undo card, or wait for Approve over APPROVE_OVER contacts (see
// ../actions.ts). Their membership / company / pipeline writes pass `enroll: false` /
// `triggers: false`, so a write by the assistant never enrolls anyone into an automation.
//
// #322 (a #71 hard-rule change, 2026-10-17): contact management — create, update incl.
// email, unsubscribe / resubscribe (always Approve), archive / restore, delete (always
// Approve, ≤ 50, no Undo) — through the contacts bulk bar's own code (./write-contact-manage.ts).
//
// Deliberately absent, and structural rather than gated (tests/ai-no-send.test.ts):
//  - send / test send / send now, scheduling, resends, conversation replies (#309: campaign
//    drafting tools only write status='draft' rows; a proposed send time is not a schedule);
//  - activating automations, editing active ones, enrolling or ending enrollments (#309:
//    drafting tools create draft automations and edit draft / paused ones, nothing more —
//    #346: whole flows via build_automation (Approve first), any step type / lane, deleting a
//    step of a draft / paused one;
//    an unsubscribe cancels active passes, exactly as the bulk bar does);
//  - every other delete (groups, companies, campaigns, pipeline cards, stages) — Undo of a
//    create only removes the record it made, and only while nothing else uses it;
//  - Settings, imports, keys, and every admin-only area (Users, Integrations tokens, Mail,
//    Tracking keys, API keys);
//  - forms (#517): publishing, unpublishing, archiving, restoring, duplicating or deleting a
//    form, its allowed origins and its notify webhook — create_form_draft / update_form write
//    drafts only (./write-forms.ts), and Undo of a create only removes the untouched draft.

import type { ActionCard } from '$lib/assistant-actions';
import type { ToolDefinition } from '../provider';
import { runWrite } from '../actions';
import { automationTools } from './automations';
import { campaignTools } from './campaigns';
import { companyTools } from './companies';
import { contactTools } from './contacts';
import { conversationTools } from './conversations';
import { formTools } from './forms';
import { groupTools } from './groups';
import { insightTools } from './insights';
import { pipelineTools } from './pipeline';
import { reportTools } from './reports';
import { skillTools } from './skills';
import { scoreTools } from './scores';
import { automationDraftTools } from './write-automations';
import { campaignDraftTools } from './write-campaigns';
import { companyWriteTools } from './write-companies';
import { contactManageTools } from './write-contact-manage';
import { contactWriteTools } from './write-contacts';
import { formDraftTools } from './write-forms';
import { groupWriteTools } from './write-groups';
import { pipelineWriteTools } from './write-pipeline';
import { ToolInputError, type Tool, type ToolContext } from './types';
import type { AssistantConfig } from '../config';

export const TOOLS: Tool[] = [
	...contactTools,
	...groupTools,
	...campaignTools,
	...automationTools,
	...pipelineTools,
	...companyTools,
	...conversationTools,
	...insightTools,
	...reportTools, // #389: suggest_report, get_report_preview; #358: list_reports, get_report_results, get_report_metrics, create_report_draft (saves a spec, no contacts)
	...skillTools, // #302: load_skill
	...scoreTools, // #467: list_scores, get_contact_scores, get_score_leaders (read) + add_score_points (write)
	...formTools, // #517: list_forms, get_form, get_form_submissions
	// #301 write tools — never in JOB_TOOLS (../jobs.ts filters to tier 'read').
	...contactWriteTools,
	...contactManageTools, // #322
	...groupWriteTools,
	...pipelineWriteTools,
	...companyWriteTools,
	// #309 drafting — campaignDraftTools also holds two read tools (sections, subject checks).
	...campaignDraftTools,
	...automationDraftTools,
	...formDraftTools // #517: create_form_draft, update_form (approve; drafts only)
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools a setting can switch off (#322 addendum: Settings → Assistant → Permissions). */
const NO_DELETE: Tool[] = TOOLS.filter((t) => t.name !== 'delete_contacts');

/** The chat's tool list for one request: delete_contacts only while `allowDelete` is on.
 *  Same filtering style as JOB_TOOLS (../jobs.ts); order is kept, so the cache prefix only
 *  changes when the setting does. */
export function chatTools(cfg: Pick<AssistantConfig, 'allowDelete'>): Tool[] {
	return cfg.allowDelete ? TOOLS : NO_DELETE;
}

/** Renamed tools: older ai_actions rows still resolve (Undo / Approve) under the old name. */
const LEGACY_NAMES: Record<string, string> = { update_contact_fields: 'update_contact' }; // #322

export function toolByName(name: string): Tool | undefined {
	return BY_NAME.get(name) ?? BY_NAME.get(LEGACY_NAMES[name] ?? '');
}

/** API tool definitions (name, description, input_schema) — stable order for prompt caching. */
export function toolDefinitions(tools: Tool[] = TOOLS): ToolDefinition[] {
	return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/** A tool result is cut to this many characters before it goes back to the model. */
export const TOOL_RESULT_MAX = 24_000;

/** `action` = the card of a write (applied or failed); `pending` = it waits for Approve. */
export type ToolRun = { ok: boolean; content: string; summary: string; count: number | null; action?: ActionCard; pending?: boolean };

function countOf(value: unknown): number | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	if (typeof v.total === 'number') return v.total;
	if (typeof v.count === 'number') return v.count;
	for (const k of Object.keys(v)) if (Array.isArray(v[k])) return (v[k] as unknown[]).length;
	return null;
}

/** Run one tool call. Never throws: unknown tools, bad input and failures become errors. */
export async function runTool(ctx: ToolContext, name: string, input: unknown, registry: Tool[] = TOOLS, toolUseId = ''): Promise<ToolRun> {
	const tool = registry === TOOLS ? BY_NAME.get(name) : registry.find((t) => t.name === name);
	const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	let summary = name;
	try {
		summary = tool?.summarize?.(args) ?? name;
	} catch {
		/* summary is cosmetic */
	}
	if (!tool) {
		// A call to a tool left out of this request (e.g. delete_contacts while the setting is
		// off): say why, rather than "unknown", when a setting is what turned it off.
		const known = BY_NAME.get(name);
		let why: string | null = null;
		if (known && known.tier !== 'read' && known.gate) why = await known.gate(ctx).catch(() => null);
		return { ok: false, content: why ?? `Unknown tool "${name}".`, summary, count: null };
	}
	if (tool.tier !== 'read') {
		try {
			const w = await runWrite(ctx, tool, args, toolUseId);
			if (w.kind === 'pending') return { ok: true, content: '', summary, count: null, action: w.card, pending: true };
			return { ok: w.ok, content: w.content, summary, count: null, ...(w.card ? { action: w.card } : {}) };
		} catch (e) {
			console.error(`assistant tool ${name} failed:`, e instanceof Error ? e.message : 'error');
			return { ok: false, content: `The ${name} tool failed.`, summary, count: null };
		}
	}
	try {
		const value = await tool.handler(ctx, args);
		let content = JSON.stringify(value ?? null);
		if (content.length > TOOL_RESULT_MAX) content = `${content.slice(0, TOOL_RESULT_MAX)}… [truncated — ask for fewer rows]`;
		return { ok: true, content, summary, count: countOf(value) };
	} catch (e) {
		if (e instanceof ToolInputError) return { ok: false, content: e.message, summary, count: null };
		console.error(`assistant tool ${name} failed:`, e instanceof Error ? e.message : 'error');
		return { ok: false, content: `The ${name} tool failed.`, summary, count: null };
	}
}

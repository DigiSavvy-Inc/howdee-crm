// Pure view math for the assistant panel (#287): turn the stored thread into chat items,
// fold live stream events into them, and label the page-context chip. #301: assistant
// items carry the action cards of the writes made in that turn.

import type { ActionCard } from '$lib/assistant-actions';

import { skillTitle } from './ai-skills';

export type ToolRow = { id: string; name: string; status: 'running' | 'ok' | 'error'; summary: string; count: number | null; error?: string };

export type ChatItem =
	| { kind: 'user'; text: string }
	| {
			kind: 'assistant';
			text: string;
			tools: ToolRow[];
			costMicros: number;
			tokens: number;
			error?: string;
			streaming?: boolean;
			actions?: ActionCard[];
			/** #310: the turn's last stored assistant row — where thumbs up / down is saved. */
			messageId?: number;
			feedback?: Feedback | null;
	  };

/** #310: thumbs up = 1, thumbs down = -1 (ai_messages.feedback). */
export type Feedback = 1 | -1;

/** #293: clickable starters in an empty panel. Read-only questions only. */
export const EXAMPLE_PROMPTS = [
	'How did my last campaign do?',
	'Who clicked but never replied this month?',
	'Which contacts are going cold?'
] as const;

/** Rows of GET /api/assistant/threads/[id] (`displayMessages` on the server). */
export type StoredMessage =
	| { kind: 'user'; id: number; text: string; at: string }
	| { kind: 'assistant'; id: number; text: string; tools: { id: string; name: string; skill?: string }[]; at: string; costMicros: number; tokens: number; feedback?: Feedback | null }
	| { kind: 'tool'; id: number; results: { tool_use_id: string; ok: boolean; preview: string }[]; at: string };

/** One assistant item per user turn: the model's replies and tool rounds in between merge.
 *  `actions` (ai_actions cards) attach to the item holding their tool call. */
export function threadToItems(messages: StoredMessage[], actions: ActionCard[] = []): ChatItem[] {
	const items: ChatItem[] = [];
	const current = () => {
		const last = items[items.length - 1];
		if (last && last.kind === 'assistant') return last;
		const fresh: ChatItem = { kind: 'assistant', text: '', tools: [], costMicros: 0, tokens: 0 };
		items.push(fresh);
		return fresh;
	};
	for (const m of messages) {
		if (m.kind === 'user') items.push({ kind: 'user', text: m.text });
		else if (m.kind === 'assistant') {
			const a = current();
			if (m.text) a.text = a.text ? `${a.text}\n\n${m.text}` : m.text;
			for (const t of m.tools) a.tools.push({ id: t.id, name: t.name, status: 'running', summary: t.skill ? skillTitle(t.skill) : '', count: null });
			a.costMicros += m.costMicros;
			a.tokens += m.tokens;
			a.messageId = m.id;
			a.feedback = m.feedback ?? null;
		} else {
			const a = current();
			for (const r of m.results) {
				const row = a.tools.find((t) => t.id === r.tool_use_id);
				if (!row) continue;
				row.status = r.ok ? 'ok' : 'error';
				if (!r.ok) row.error = r.preview;
			}
		}
	}
	for (const card of actions) {
		const it = items.find((i) => i.kind === 'assistant' && i.tools.some((t) => t.id === card.tool_use_id));
		if (!it || it.kind !== 'assistant') continue;
		(it.actions ??= []).push(card);
		// A paused write has no stored result yet — it waits for Approve, it didn't fail.
		const row = it.tools.find((t) => t.id === card.tool_use_id)!;
		if (row.status === 'running') row.status = card.status === 'failed' ? 'error' : 'ok';
	}
	// A tool call with no stored result (an interrupted turn) didn't run.
	for (const it of items) if (it.kind === 'assistant') for (const t of it.tools) if (t.status === 'running') t.status = 'error';
	return items;
}

export type StreamEvent =
	| { type: 'thread'; id: number; model: string; effort: string | null }
	| { type: 'message'; id: number } // #310: a stored assistant row (the last one carries thumbs up / down)
	| { type: 'text'; text: string }
	| { type: 'tool_start'; id: string; name: string }
	| { type: 'tool_done'; id: string; name: string; ok: boolean; summary: string; count: number | null; error?: string }
	| { type: 'action'; action: ActionCard }
	| { type: 'pending'; action: ActionCard }
	| { type: 'usage'; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; costMicros: number }
	| { type: 'error'; message: string }
	| { type: 'done'; stopReason: string };

/** Apply one event from /api/assistant/chat to the streaming assistant item (mutates it). */
export function applyEvent(item: Extract<ChatItem, { kind: 'assistant' }>, e: StreamEvent): void {
	if (e.type === 'text') item.text += e.text;
	else if (e.type === 'message') item.messageId = e.id;
	else if (e.type === 'tool_start') {
		if (!item.tools.some((t) => t.id === e.id)) item.tools.push({ id: e.id, name: e.name, status: 'running', summary: '', count: null });
		// A paragraph break between text before and after a tool round.
		if (item.text && !item.text.endsWith('\n\n')) item.text += '\n\n';
	} else if (e.type === 'tool_done') {
		const row = item.tools.find((t) => t.id === e.id);
		const next: ToolRow = { id: e.id, name: e.name, status: e.ok ? 'ok' : 'error', summary: e.summary, count: e.count, error: e.error };
		if (row) Object.assign(row, next);
		else item.tools.push(next);
	} else if (e.type === 'action' || e.type === 'pending') {
		const list = (item.actions ??= []);
		const i = list.findIndex((a) => a.id === e.action.id);
		if (i >= 0) list[i] = e.action;
		else list.push(e.action);
	} else if (e.type === 'usage') {
		item.costMicros += e.costMicros;
		item.tokens += e.usage.input + e.usage.output + e.usage.cacheRead + e.usage.cacheWrite;
	} else if (e.type === 'error') item.error = e.message;
	else if (e.type === 'done') {
		item.streaming = false;
		item.text = item.text.trimEnd();
		for (const t of item.tools) if (t.status === 'running') t.status = 'error';
	}
}

/** #300: plain labels for tool rows (the raw name stays in the tooltip / expanded view). */
export const TOOL_LABELS: Record<string, string> = {
	search_contacts: 'Searched contacts',
	get_contact: 'Looked up a contact',
	get_contact_engagement: 'Checked contact engagement',
	get_contact_timeline: 'Read contact activity',
	list_campaigns: 'Looked up campaigns',
	get_campaign: 'Opened a campaign',
	get_campaign_engagement: 'Checked engagement',
	get_campaign_links: 'Checked link clicks',
	get_campaign_replies: 'Read campaign replies',
	list_companies: 'Looked up companies',
	get_company: 'Opened a company',
	get_account_brief: 'Read the account brief', // #388
	list_automations: 'Looked up automations',
	get_automation: 'Opened an automation',
	get_automation_performance: 'Checked automation performance',
	list_automation_enrollments: 'Checked enrollments',
	get_dashboard: 'Read the dashboard',
	get_engagement_tiers: 'Checked engagement tiers',
	list_scores: 'Looked up scores', // #467
	get_contact_scores: "Read a contact's scores",
	get_score_leaders: 'Read top contacts by score',
	get_going_cold: 'Checked who is going cold',
	get_deliverability: 'Checked deliverability',
	list_conversations: 'Looked up conversations',
	list_groups: 'Looked up lists and tags',
	get_group_members: 'Read group members',
	get_pipeline_board: 'Read the pipeline',
	get_pipeline_card: 'Checked a pipeline card',
	suggest_report: 'Suggested a report', // #389
	get_report_preview: 'Previewed a report',
	load_skill: 'Used skill', // #302: toolLabel adds ": <Skill title>" from the row summary
	// #301 write tools
	update_contact_fields: 'Updated a contact', // #301 name, kept for older threads
	// #322 contact management
	update_contact: 'Updated a contact',
	create_contact: 'Created a contact',
	unsubscribe_contacts: 'Unsubscribed contacts',
	resubscribe_contacts: 'Resubscribed contacts',
	archive_contacts: 'Archived contacts',
	restore_contacts: 'Restored contacts',
	delete_contacts: 'Deleted contacts',
	update_contact_tier: 'Set engagement tiers', // #460
	add_score_points: 'Adjusted scores', // #467
	add_tag: 'Tagged contacts',
	remove_tag: 'Removed a tag',
	add_to_list: 'Added contacts to a list',
	remove_from_list: 'Removed contacts from a list',
	create_tag: 'Created a tag',
	create_list: 'Created a list',
	archive_group: 'Archived a list', // #472
	restore_group: 'Restored a list',
	create_segment: 'Created a segment',
	update_segment_rules: 'Changed segment rules',
	add_pipeline_card: 'Added a deal',
	move_pipeline_card: 'Moved a deal',
	update_pipeline_card: 'Updated a deal',
	update_company_fields: 'Updated a company',
	// #309 drafting tools
	get_draft_sections: 'Read the draft',
	suggest_subject_lines: 'Checked subject lines',
	create_campaign_draft: 'Drafted a campaign',
	update_campaign_draft: 'Edited a draft',
	rewrite_draft_section: 'Rewrote a section',
	create_automation_draft: 'Drafted an automation',
	add_automation_step: 'Added a step',
	edit_automation_step: 'Edited a step',
	reorder_automation_steps: 'Reordered steps',
	delete_automation_step: 'Deleted a step', // #346
	build_automation: 'Built an automation',
	get_automation_spec: 'Read an automation flow',
	// #358 reports
	list_reports: 'Looked up reports',
	get_report_results: 'Ran a report',
	get_report_metrics: 'Read the report catalog',
	create_report_draft: 'Saved a report',
	// #517 forms
	list_forms: 'Looked up forms',
	get_form: 'Read a form',
	get_form_submissions: 'Read form submissions',
	create_form_draft: 'Drafted a form',
	update_form: 'Edited a draft form'
};

/**
 * "Looked up campaigns"; an unknown tool falls back to its name in words. A row whose tool is
 * load_skill reads "Used skill: Campaign strategy" (#302; the summary carries the skill title).
 */
export function toolLabel(t: string | Pick<ToolRow, 'name' | 'summary'>): string {
	const name = typeof t === 'string' ? t : t.name;
	if (name === 'load_skill') {
		const title = typeof t === 'string' ? '' : t.summary;
		return title ? `Used skill: ${title}` : 'Used skill';
	}
	const known = TOOL_LABELS[name];
	if (known) return known;
	const words = name.replace(/_+/g, ' ').trim();
	return words ? `Used ${words}` : 'Used a tool';
}

/** Header of a group of consecutive tool calls: "Looked at 5 things" / "Looking at 2 things…". */
export function toolGroupLabel(tools: readonly Pick<ToolRow, 'status'>[]): string {
	const n = tools.length;
	const things = `${n} thing${n === 1 ? '' : 's'}`;
	return tools.some((t) => t.status === 'running') ? `Looking at ${things}…` : `Looked at ${things}`;
}

/** "12k tokens" style. */
export function tokensText(n: number): string {
	if (n < 1000) return `${n} tokens`;
	return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k tokens`;
}

const SECTION_LABELS: Record<string, string> = {
	'': 'Dashboard',
	campaigns: 'Campaigns',
	compose: 'Compose',
	contacts: 'Contacts',
	companies: 'Companies',
	pipeline: 'Pipeline',
	automations: 'Automations',
	conversations: 'Conversations',
	deliverability: 'Deliverability',
	templates: 'Templates',
	pages: 'Pages',
	settings: 'Settings',
	groups: 'Groups'
};

/** Chip text for the page the user is on, e.g. "Campaign #47" or "Contacts". */
export function contextLabel(routeId: string | null, params: Record<string, string>): string {
	const id = routeId ?? '';
	if (id.startsWith('/campaign/[id]')) return `Campaign #${params.id}`;
	if (id === '/compose' && params.draft_id) return `Draft #${params.draft_id}`; // #309
	if (id.startsWith('/contacts/[id]')) return `Contact #${params.id}`;
	if (id.startsWith('/companies/[id]')) return `Company #${params.id}`;
	if (id.startsWith('/automations/[id]')) return `Automation #${params.id}`;
	if (id.startsWith('/lists/[id]')) return `Group #${params.id}`;
	if (id.startsWith('/groups/[kind]')) return `${params.kind ? params.kind[0].toUpperCase() + params.kind.slice(1) : 'Group'}s`;
	if (id.startsWith('/conversations/[key]')) return 'Conversation';
	const first = id.split('/')[1] ?? '';
	return SECTION_LABELS[first] ?? (first ? first[0].toUpperCase() + first.slice(1) : 'Dashboard');
}

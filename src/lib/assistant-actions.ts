// The assistant's action cards (#301), shared by the server (ai/actions.ts builds them from
// `ai_actions` rows) and the panel (AssistantActionCard.svelte renders them). Universal: no
// server imports.

import type { IconName } from '$lib/icons/glyphs';

export type ActionStatus = 'applied' | 'pending' | 'approved' | 'cancelled' | 'undone' | 'failed';

/** A single-field before → after, shown on the card for one-field edits. */
export type FieldChange = { field: string; from: string | null; to: string | null };

export type ActionCard = {
	id: number;
	tool: string;
	tool_use_id: string;
	status: ActionStatus;
	icon: IconName;
	summary: string;
	url: string | null;
	changes: FieldChange[];
	/** Approve-tier actions: how many contacts and a few names, shown before Approve. */
	scope: { count: number; sample: string[]; notes?: string[] } | null;
	error: string | null;
	/** #322: warnings about the applied change (e.g. address hygiene). */
	notes?: string[];
	/** #322: the change has no Undo (a delete, or an unsubscribe also suppressed in Postmark). */
	noUndo?: boolean;
};

/** A write is "done" (Undo offered) once applied — directly or after approval — unless it has no Undo. */
export function canUndo(card: ActionCard): boolean {
	return (card.status === 'applied' || card.status === 'approved') && !card.noUndo;
}

const ICONS: Record<string, IconName> = {
	update_contact_fields: 'edit', // #301 name, kept for older cards
	update_contact: 'edit',
	create_contact: 'add',
	unsubscribe_contacts: 'mail',
	resubscribe_contacts: 'mail',
	archive_contacts: 'contacts',
	restore_contacts: 'contacts',
	delete_contacts: 'delete',
	update_contact_tier: 'edit', // #460
	add_score_points: 'edit', // #467
	add_tag: 'tag',
	remove_tag: 'tag',
	add_to_list: 'list',
	remove_from_list: 'list',
	create_segment: 'filter',
	update_segment_rules: 'filter',
	create_tag: 'tag',
	create_list: 'list',
	archive_group: 'list', // #472
	restore_group: 'list',
	add_pipeline_card: 'pipeline',
	move_pipeline_card: 'move-stage',
	update_pipeline_card: 'pipeline',
	update_company_fields: 'companies',
	create_campaign_draft: 'campaigns',
	update_campaign_draft: 'edit',
	rewrite_draft_section: 'edit',
	create_automation_draft: 'automations',
	add_automation_step: 'add',
	edit_automation_step: 'edit',
	reorder_automation_steps: 'drag-handle',
	delete_automation_step: 'delete', // #346
	build_automation: 'automations',
	create_report_draft: 'reports', // #358
	create_form_draft: 'forms', // #517
	update_form: 'forms'
};

export function actionIcon(tool: string): IconName {
	return ICONS[tool] ?? 'action';
}

/** #309: the campaign a draft action points at (its url is the composer link), else null. */
export function draftIdOf(card: Pick<ActionCard, 'url'>): number | null {
	const m = card.url?.match(/\/compose\?draft=(\d+)/);
	return m ? Number(m[1]) : null;
}

/** #309: the card's link label — "Open in composer" for a campaign draft; #346: "Open
 *  automation" for an automation; #517: "Open in builder" for a form. */
export function openLabel(card: Pick<ActionCard, 'url'>): string {
	if (draftIdOf(card)) return 'Open in composer';
	if (/\/reports\/\d+$/.test(card.url ?? '')) return 'Open report'; // #358
	if (/\/forms\/\d+$/.test(card.url ?? '')) return 'Open in builder'; // #517
	return /\/automations\/\d+$/.test(card.url ?? '') ? 'Open automation' : 'Open';
}

/** "12 selected contacts" — the page-context chip while rows are checked. */
export function selectionLabel(n: number): string {
	return `${n.toLocaleString('en-US')} selected contact${n === 1 ? '' : 's'}`;
}

/** Selection sent as page context is capped (the bulk bar never checks more on a page). */
export const SELECTION_MAX = 500;

/** Put a card in the conversation: replace it where it already is, else add it to `current`. */
export function upsertAction<T extends { kind: string; actions?: ActionCard[] }>(items: T[], current: T | null, card: ActionCard): void {
	for (const it of items) {
		const i = it.actions?.findIndex((a) => a.id === card.id) ?? -1;
		if (i >= 0) {
			it.actions![i] = card;
			return;
		}
	}
	if (current) (current.actions ??= []).push(card);
}

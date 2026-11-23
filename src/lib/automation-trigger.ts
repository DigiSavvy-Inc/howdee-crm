// One-line trigger summary for the automation editor's Trigger tile (#220). Universal —
// pure over the automation row + the pickers the page already loads.
import type { IconName } from '$lib/icons/glyphs';
import { triggerLabel } from '$lib/company-metrics';
import { DEFAULT_COOLDOWN_HOURS } from '$lib/site-trigger';
import { engagementTriggerText, isEngagementKind, parseEngagementConfig } from '$lib/engagement-trigger';
import { isSiteActivityKind, parseSiteActivityConfig, siteActivityTriggerText } from '$lib/site-activity-trigger';
import { isSubscriptionKind, parseSubscriptionConfig, subscriptionTriggerText } from '$lib/subscription-trigger';
import { isScoreTriggerKind, parseScoreTriggerConfig, scoreTriggerText } from '$lib/score-trigger';
import { formTriggerText, isFormTriggerKind, parseFormTriggerConfig } from '$lib/form-trigger';

export type TriggerFields = {
	trigger_type: string;
	trigger_list_id: number | null;
	trigger_metric: string | null;
	trigger_direction: string | null;
	trigger_threshold: number | null;
	trigger_site_id: number | null;
	trigger_path_op: string | null;
	trigger_path: string | null;
	trigger_cooldown_hours: number | null;
	trigger_stage_id: number | null;
	/** #412: JSON config of email_opened / email_clicked, #434 site_activity, #444 subscription_changed (NULL for the older kinds). */
	trigger_config?: string | null;
	reentry: string;
};

export type TriggerContext = {
	/** #413: `dynamic` = a rule-based segment (polled each heartbeat, not added to). */
	lists: { id: number; name: string; kind: string; dynamic?: number | boolean }[];
	sites: { id: number; name: string }[];
	stages: { id: number; name: string }[];
	/** #412: titles of the campaigns / email steps an engagement trigger names. */
	emails?: { campaigns: { id: number; subject: string }[]; steps: { id: number; label: string }[] };
	/** #467: score names for the score_changed trigger. */
	scores?: { id: number; name: string }[];
	/** #516: form names for the form_submitted trigger. */
	forms?: { id: number; name: string }[];
};

// `description` is the one-liner under each card in the Trigger drawer's picker (#425).
export const TRIGGER_TYPES: { type: string; label: string; description: string; icon: IconName }[] = [
	{ type: 'manual', label: 'Manual', description: 'You or the API enroll contacts', icon: 'automations' },
	{ type: 'list_added', label: 'Added to list/segment/tag', description: 'When a contact joins the chosen group', icon: 'tag' },
	{ type: 'company_metric', label: 'Company metric', description: "When a company's metric crosses a threshold", icon: 'companies' },
	{ type: 'site_visit', label: 'Visits a page', description: 'From site tracking', icon: 'site-visit' },
	{ type: 'pipeline_stage_entered', label: 'Enters pipeline stage', description: 'When a card lands in a stage', icon: 'pipeline' },
	{ type: 'email_opened', label: 'Opens an email', description: 'When a contact opens a chosen email, or any email', icon: 'eye' },
	{ type: 'email_clicked', label: 'Clicks a link in an email', description: 'When a contact clicks a link in a chosen email, or any email', icon: 'link' },
	{ type: 'site_activity', label: 'Visits the site often', description: '10 pages or 10 visits in 30 days — you set the numbers', icon: 'site-visit' },
	{
		type: 'subscription_changed',
		label: 'Subscription changes',
		description: 'When a contact unsubscribes, resubscribes, bounces, complains or opts out of a topic',
		icon: 'mail'
	},
	{ type: 'score_changed', label: 'Score changes', description: 'When a score crosses a value, enters a band or changes', icon: 'reports' },
	{ type: 'form_submitted', label: 'Form submitted', description: 'When a contact submits a chosen form, or any form', icon: 'forms' }
];

export function triggerIcon(type: string): IconName {
	return TRIGGER_TYPES.find((t) => t.type === type)?.icon ?? 'automations';
}

export function reentryText(reentry: string): string {
	return reentry === 'multiple' ? 'multiple times' : 'once only';
}

const PATH_VERB: Record<string, string> = { contains: 'containing', equals: 'exactly', wildcard: 'matching' };

/** "When added to tag “opened-launch”", "Visits a page containing “/pricing” on any site · 24h cooldown", … */
export function triggerText(a: TriggerFields, ctx: TriggerContext): string {
	if (isEngagementKind(a.trigger_type)) {
		const cfg = parseEngagementConfig(a.trigger_type, a.trigger_config ?? null);
		return engagementTriggerText(a.trigger_type, cfg, {
			campaign: (id) => ctx.emails?.campaigns.find((c) => c.id === id)?.subject ?? null,
			step: (id) => ctx.emails?.steps.find((s) => s.id === id)?.label ?? null,
			list: (id) => ctx.lists.find((l) => l.id === id) ?? null
		});
	}
	if (isSubscriptionKind(a.trigger_type)) {
		return subscriptionTriggerText(parseSubscriptionConfig(a.trigger_config ?? null), (id) => ctx.lists.find((l) => l.id === id)?.name ?? null);
	}
	if (isScoreTriggerKind(a.trigger_type)) {
		return scoreTriggerText(parseScoreTriggerConfig(a.trigger_config ?? null), (id) => ctx.scores?.find((s) => s.id === id)?.name ?? null);
	}
	if (isFormTriggerKind(a.trigger_type)) {
		return formTriggerText(parseFormTriggerConfig(a.trigger_config ?? null), (id) => ctx.forms?.find((f) => f.id === id)?.name ?? null);
	}
	if (isSiteActivityKind(a.trigger_type)) {
		return siteActivityTriggerText(parseSiteActivityConfig(a.trigger_config ?? null), (id) => ctx.sites.find((s) => s.id === id)?.name ?? null);
	}
	switch (a.trigger_type) {
		case 'list_added': {
			if (!a.trigger_list_id) return 'When added to a list (choose one)';
			const l = ctx.lists.find((x) => x.id === a.trigger_list_id);
			if (l?.dynamic) return `When enters segment “${l.name}” (checked every heartbeat)`;
			return l ? `When added to ${l.kind} “${l.name}”` : 'When added to (deleted list)';
		}
		case 'company_metric':
			return `Company metric ${triggerLabel(a.trigger_metric, a.trigger_direction, a.trigger_threshold)}`;
		case 'site_visit': {
			const verb = PATH_VERB[a.trigger_path_op ?? 'contains'] ?? 'containing';
			const site =
				a.trigger_site_id === null
					? 'any site'
					: (ctx.sites.find((s) => s.id === a.trigger_site_id)?.name ?? '(deleted site)');
			const cd = a.trigger_cooldown_hours ?? DEFAULT_COOLDOWN_HOURS;
			return `Visits a page ${verb} “${a.trigger_path ?? ''}” on ${site} · ${cd}h cooldown`;
		}
		case 'pipeline_stage_entered': {
			const st = a.trigger_stage_id ? ctx.stages.find((s) => s.id === a.trigger_stage_id) : null;
			return st ? `Enters pipeline stage “${st.name}”` : 'Enters pipeline stage (deleted stage)';
		}
		default:
			return 'Manual enrollment';
	}
}

/** The tile's one line: trigger text + re-entry policy. */
export function triggerSummary(a: TriggerFields, ctx: TriggerContext): string {
	return `${triggerText(a, ctx)} · ${reentryText(a.reentry)}`;
}

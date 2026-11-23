// #412: the "Opens an email" / "Clicks a link in an email" automation triggers, fired by the
// Postmark webhook right after an open / click event is stored. Kept apart from the engine
// (it only knows how to match and enroll) like site-trigger.ts and pipeline-trigger.ts.

import { enroll } from './automations';
import { logEvent, recordPendingTriggers } from './automation-flow';
import { classifyProxyOpen } from './engagement';
import { evaluateRules } from './condition-eval';
import { sqliteUtc } from './businessdays';
import {
	linkMatches,
	parseEngagementConfig,
	type EmailRef,
	type EngagementTriggerKind,
	type ExcludeEntry
} from '$lib/engagement-trigger';

export type EngagementEvent = {
	type: 'open' | 'click';
	campaignId: number;
	contactId: number;
	recipientId: number | null;
	/** The parsed Postmark payload (OriginalLink, UserAgent, Client, FirstOpen …). */
	detail: Record<string, unknown>;
	now?: Date;
};

export type EngagementFireSummary = {
	/** Automations whose email / link / list / exclusions matched. */
	matched: number;
	/** Passes created. */
	enrolled: number;
	/** Paused automations that recorded the contact instead. */
	pending: number;
	/** Matched but skipped: an auto-open, or already fired for this email. */
	skipped: number;
};

type CampaignRef = { id: number; automation_step_id: number | null };

function emailMatches(ref: EmailRef | ExcludeEntry, c: CampaignRef): boolean {
	if (ref === 'any') return true;
	if ('campaign_id' in ref) return ref.campaign_id === c.id;
	if ('step_id' in ref) return c.automation_step_id !== null && ref.step_id === c.automation_step_id;
	return false;
}

/**
 * Enroll the contact into every ACTIVE automation of the matching kind whose config matches
 * this email (any / that campaign / that step email), link (clicks: any or the pattern), list
 * (the contact must be in it) and none of its exclusions. Then:
 * - opens with `ignore_proxy_opens` skip an Apple Mail / prefetch auto-open
 *   (`classifyProxyOpen` with the recipient's first delivery time);
 * - `once_per_email`: a contact this trigger already enrolled for this email is skipped
 *   (`engagement_trigger_fires`, stamped when a pass was created);
 * - `enroll()` applies the rest — subscribed, not archived, one active pass, re-entry policy,
 *   entry conditions;
 * - a PAUSED automation records the contact (`automation_pending_triggers`, offered on resume)
 *   and never enrolls; a draft is never looked at.
 * Each new pass gets a `trigger:<kind>` timeline event. Best-effort by design: the webhook
 * catches anything thrown here.
 */
export async function fireEngagementTriggers(db: D1Database, ev: EngagementEvent): Promise<EngagementFireSummary> {
	const summary: EngagementFireSummary = { matched: 0, enrolled: 0, pending: 0, skipped: 0 };
	const kind: EngagementTriggerKind = ev.type === 'open' ? 'email_opened' : 'email_clicked';
	const autos = await db
		.prepare(`SELECT id, status, trigger_config FROM automations WHERE status IN ('active', 'paused') AND trigger_type = ? ORDER BY id`)
		.bind(kind)
		.all<{ id: number; status: string; trigger_config: string | null }>();
	if (autos.results.length === 0) return summary;

	const campaign = await db
		.prepare('SELECT id, automation_step_id, subject FROM campaigns WHERE id = ?')
		.bind(ev.campaignId)
		.first<CampaignRef & { subject: string | null }>();
	if (!campaign) return summary;
	const link = typeof ev.detail.OriginalLink === 'string' ? ev.detail.OriginalLink : null;
	const now = ev.now ?? new Date();

	let proxy: boolean | null = null;
	const isProxy = async (): Promise<boolean> => {
		if (proxy !== null) return proxy;
		const d = ev.recipientId
			? await db
					.prepare(`SELECT MIN(recorded_at) AS at FROM events WHERE recipient_id = ? AND type = 'delivery'`)
					.bind(ev.recipientId)
					.first<{ at: string | null }>()
			: null;
		proxy = classifyProxyOpen(ev.detail, d?.at ?? null, sqliteUtc(now));
		return proxy;
	};

	const detailText = (
		kind === 'email_opened' ? `opened “${campaign.subject ?? `email #${campaign.id}`}”` : `clicked ${link ?? 'a link'} in “${campaign.subject ?? `email #${campaign.id}`}”`
	).slice(0, 300);

	for (const a of autos.results) {
		const cfg = parseEngagementConfig(kind, a.trigger_config);
		if (!emailMatches(cfg.email, campaign)) continue;
		if (kind === 'email_clicked' && cfg.link !== 'any' && !linkMatches(link, cfg.link)) continue;
		const excluded = cfg.exclude.some((x) =>
			'link' in x ? kind === 'email_clicked' && linkMatches(link, x.link) : emailMatches(x, campaign)
		);
		if (excluded) continue;
		if (cfg.list_id) {
			const inList = await evaluateRules(db, ev.contactId, { match: 'all', rules: [{ field: 'list', op: 'in', value: String(cfg.list_id) }] });
			if (!inList.pass) continue;
		}
		summary.matched++;
		if (kind === 'email_opened' && cfg.ignore_proxy_opens && (await isProxy())) {
			summary.skipped++;
			continue;
		}
		if (cfg.once_per_email) {
			const fired = await db
				.prepare('SELECT 1 FROM engagement_trigger_fires WHERE automation_id = ? AND contact_id = ? AND campaign_id = ? AND kind = ?')
				.bind(a.id, ev.contactId, campaign.id, kind)
				.first();
			if (fired) {
				summary.skipped++;
				continue;
			}
		}
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, [ev.contactId], kind);
			summary.pending++;
			continue;
		}
		const r = await enroll(db, a.id, [ev.contactId], { now });
		if (r.created.length === 0) continue;
		summary.enrolled++;
		await db
			.prepare(
				`INSERT INTO engagement_trigger_fires (automation_id, contact_id, campaign_id, kind, fired_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(automation_id, contact_id, campaign_id, kind) DO UPDATE SET fired_at = excluded.fired_at`
			)
			.bind(a.id, ev.contactId, campaign.id, kind, sqliteUtc(now))
			.run();
		for (const id of r.created) {
			await logEvent(db, { id, automation_id: a.id, contact_id: ev.contactId }, null, `trigger:${kind}`, detailText);
		}
	}
	return summary;
}

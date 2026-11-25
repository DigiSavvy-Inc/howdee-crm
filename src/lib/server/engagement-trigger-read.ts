// #412: reads for the engagement triggers' editor and summaries — the titles of the emails a
// trigger names, the "Select email" options and the "Select link" options. No engine / send
// imports (the list page, the API and the assistant's summary use it).

import { configEmailIds, isEngagementKind, parseEngagementConfig } from '$lib/engagement-trigger';
import { extractLinks } from '$lib/presend-checks';
import { stepNumbers } from '$lib/automation-action-labels';
import { CLICK_LINK_SQL } from './event-detail';
import { containsSql } from './sql-match';

export type TriggerEmailNames = { campaigns: { id: number; subject: string }[]; steps: { id: number; label: string }[] };

/** Titles of every campaign / email step these automations' triggers name (for triggerText). */
export async function triggerEmailNames(
	db: D1Database,
	rows: { trigger_type: string; trigger_config?: string | null }[]
): Promise<TriggerEmailNames> {
	const campaigns = new Set<number>();
	const steps = new Set<number>();
	for (const r of rows) {
		if (!isEngagementKind(r.trigger_type)) continue;
		const ids = configEmailIds(parseEngagementConfig(r.trigger_type, r.trigger_config ?? null));
		ids.campaigns.forEach((id) => campaigns.add(id));
		ids.steps.forEach((id) => steps.add(id));
	}
	const out: TriggerEmailNames = { campaigns: [], steps: [] };
	if (campaigns.size) {
		out.campaigns = (
			await db
				.prepare('SELECT id, subject FROM campaigns WHERE id IN (SELECT value FROM json_each(?))')
				.bind(JSON.stringify([...campaigns]))
				.all<{ id: number; subject: string | null }>()
		).results.map((c) => ({ id: c.id, subject: c.subject || `Campaign #${c.id}` }));
	}
	if (steps.size) {
		out.steps = (
			await db
				.prepare(
					`SELECT s.id, s.subject, a.name AS automation_name FROM automation_steps s JOIN automations a ON a.id = s.automation_id
					 WHERE s.id IN (SELECT value FROM json_each(?)) AND s.type = 'email'`
				)
				.bind(JSON.stringify([...steps]))
				.all<{ id: number; subject: string | null; automation_name: string }>()
		).results.map((s) => ({ id: s.id, label: `${s.automation_name} › ${s.subject || 'Untitled email'}` }));
	}
	return out;
}

export type TriggerEmailOption =
	| { kind: 'campaign'; id: number; label: string; detail: string }
	| { kind: 'step'; id: number; label: string; group: string; own: boolean };

export const TRIGGER_EMAIL_LIMIT = 50;

/**
 * The "Select email" options: sent / sending / scheduled broadcasts (newest first, subject +
 * date), then this automation's email steps ("Step 2: Welcome"), then other automations' email
 * steps grouped by automation. `q` narrows by subject / automation name; ≤ 50 in total.
 */
export async function triggerEmailOptions(db: D1Database, automationId: number, q = ''): Promise<TriggerEmailOption[]> {
	// #485: instr, not LIKE (D1 caps LIKE patterns at 50 bytes; subjects run long).
	const text = q.trim();
	const campaigns = (
		await db
			.prepare(
				`SELECT id, subject, status, COALESCE(sent_at, scheduled_at, created_at) AS at FROM campaigns
				 WHERE automation_step_id IS NULL AND status IN ('sent', 'sending', 'scheduled')
				   AND (list_id IS NOT NULL OR EXISTS (SELECT 1 FROM campaign_audiences ca WHERE ca.campaign_id = campaigns.id))
				   AND ${containsSql("COALESCE(subject, '')")}
				 ORDER BY at DESC, id DESC LIMIT ?`
			)
			.bind(text, TRIGGER_EMAIL_LIMIT)
			.all<{ id: number; subject: string | null; status: string; at: string | null }>()
	).results;
	const out: TriggerEmailOption[] = campaigns.map((c) => ({
		kind: 'campaign',
		id: c.id,
		label: c.subject || `Campaign #${c.id}`,
		detail: `${c.status === 'sent' ? 'sent' : c.status} ${(c.at ?? '').slice(0, 10)}`.trim()
	}));

	const own = (
		await db
			.prepare('SELECT id, position, type, parent_step_id, branch_label, subject FROM automation_steps WHERE automation_id = ?')
			.bind(automationId)
			.all<{ id: number; position: number; type: string; parent_step_id: number | null; branch_label: string | null; subject: string | null }>()
	).results;
	const numbers = stepNumbers(own);
	const needle = q.trim().toLowerCase();
	for (const s of own
		.filter((s) => s.type === 'email')
		.sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0))) {
		const label = `Step ${numbers.get(s.id) ?? '?'}: ${s.subject || 'Untitled email'}`;
		if (needle && !label.toLowerCase().includes(needle)) continue;
		out.push({ kind: 'step', id: s.id, label, group: 'This automation', own: true });
	}

	const room = Math.max(0, TRIGGER_EMAIL_LIMIT - out.length);
	if (room > 0) {
		const others = (
			await db
				.prepare(
					`SELECT s.id, s.subject, a.name AS automation_name FROM automation_steps s JOIN automations a ON a.id = s.automation_id
					 WHERE s.type = 'email' AND s.automation_id != ?
					   AND (${containsSql("COALESCE(s.subject, '')")} OR ${containsSql('a.name')})
					 ORDER BY a.name COLLATE NOCASE, s.automation_id, s.position, s.id LIMIT ?`
				)
				.bind(automationId, text, text, room)
				.all<{ id: number; subject: string | null; automation_name: string }>()
		).results;
		for (const s of others) out.push({ kind: 'step', id: s.id, label: s.subject || 'Untitled email', group: s.automation_name, own: false });
	}
	return out.slice(0, TRIGGER_EMAIL_LIMIT);
}

export const TRIGGER_LINK_LIMIT = 50;

/** The "Select link" options for one email: the links in its HTML plus the distinct links
 *  people clicked (Postmark's OriginalLink), de-duplicated, ≤ 50. */
export async function triggerLinkOptions(db: D1Database, email: { campaign_id?: number; step_id?: number }): Promise<string[]> {
	const campaignIds: number[] = [];
	const htmls: string[] = [];
	if (email.campaign_id) {
		const c = await db.prepare('SELECT id, body_html FROM campaigns WHERE id = ?').bind(email.campaign_id).first<{ id: number; body_html: string | null }>();
		if (c) {
			campaignIds.push(c.id);
			if (c.body_html) htmls.push(c.body_html);
		}
	} else if (email.step_id) {
		const rows = (
			await db.prepare('SELECT id, body_html FROM campaigns WHERE automation_step_id = ?').bind(email.step_id).all<{ id: number; body_html: string | null }>()
		).results;
		for (const r of rows) {
			campaignIds.push(r.id);
			if (r.body_html) htmls.push(r.body_html);
		}
	}
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (href: string) => {
		const h = href.trim();
		if (!/^https?:\/\//i.test(h) || h.includes('%%UNSUB_URL%%') || seen.has(h)) return;
		seen.add(h);
		out.push(h);
	};
	for (const html of htmls) for (const l of extractLinks(html)) add(l.href);
	if (campaignIds.length) {
		const link = CLICK_LINK_SQL('ev');
		const clicked = (
			await db
				.prepare(
					`SELECT DISTINCT ${link} AS url FROM events ev
					 WHERE ev.type = 'click' AND ev.campaign_id IN (SELECT value FROM json_each(?)) AND ${link} IS NOT NULL LIMIT ?`
				)
				.bind(JSON.stringify(campaignIds), TRIGGER_LINK_LIMIT)
				.all<{ url: string }>()
		).results;
		for (const r of clicked) add(String(r.url));
	}
	return out.slice(0, TRIGGER_LINK_LIMIT);
}

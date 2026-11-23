// #398: the editor's view of A/B tests on email steps — variant B's copy, the winner if one
// was picked, and per-variant sent / unique opens / unique clicks from the step's campaign
// (recipients.ab_variant). Opens count every open, Apple Mail / prefetch auto-opens included,
// so clicks are the better signal; the card says so. Writes are in automation-write.ts.

import { abStats, type AbCounts, type AbStat, type AbVariant } from '$lib/automation-ab';

export type AbTest = {
	step_id: number;
	enabled: boolean;
	subject_a: string;
	subject_b: string;
	preheader_b: string | null;
	body_b: string | null;
	winner: AbVariant | null;
	decided_at: string | null;
	stats: AbStat[];
};

/** Every email step of an automation that has (or had) a variant B, keyed by step id. */
export async function abTestsFor(db: D1Database, automationId: number): Promise<Record<number, AbTest>> {
	const steps = (
		await db
			.prepare(
				`SELECT id, subject, ab_enabled, ab_subject, ab_preheader, ab_body_md, ab_winner, ab_decided_at
				 FROM automation_steps WHERE automation_id = ? AND type = 'email' AND ab_subject IS NOT NULL`
			)
			.bind(automationId)
			.all<{
				id: number;
				subject: string;
				ab_enabled: number;
				ab_subject: string;
				ab_preheader: string | null;
				ab_body_md: string | null;
				ab_winner: string | null;
				ab_decided_at: string | null;
			}>()
	).results;
	const out: Record<number, AbTest> = {};
	for (const s of steps) {
		const rows = (
			await db
				.prepare(
					`SELECT r.ab_variant AS variant, COUNT(*) AS sent,
					        SUM(EXISTS (SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.type IN ('open', 'click'))) AS opened,
					        SUM(EXISTS (SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.type = 'click')) AS clicked
					 FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
					 WHERE c.automation_step_id = ? AND r.status = 'accepted' AND r.ab_variant IN ('a', 'b')
					 GROUP BY r.ab_variant`
				)
				.bind(s.id)
				.all<AbCounts>()
		).results;
		out[s.id] = {
			step_id: s.id,
			enabled: !!s.ab_enabled,
			subject_a: s.subject,
			subject_b: s.ab_subject,
			preheader_b: s.ab_preheader,
			body_b: s.ab_body_md,
			winner: s.ab_winner === 'a' || s.ab_winner === 'b' ? s.ab_winner : null,
			decided_at: s.ab_decided_at,
			stats: abStats(rows.map((r) => ({ variant: r.variant, sent: r.sent ?? 0, opened: r.opened ?? 0, clicked: r.clicked ?? 0 })))
		};
	}
	return out;
}

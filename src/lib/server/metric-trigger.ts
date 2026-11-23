// #170: the "Company metric crossed" automation trigger. Separate from ./company-metrics
// because it enrolls through the engine (./automations imports company-metrics for the
// Condition step — keeping this here avoids an import cycle).

import { TRIGGER_METRICS, crossed, type CrossDirection } from '$lib/company-metrics';
import { enroll } from './automations';
import { recordPendingTriggers } from './automation-flow';

const TRIGGER_KEYS = TRIGGER_METRICS.map((m) => m.key);

export type CrossingSummary = { crossings: number; enrolled: number };

/**
 * Run after every integration sync (runProviderSync): for each active `company_metric`
 * automation, find companies whose value crossed the threshold since the previous sync's
 * snapshot (company_metrics_prev) and enroll their contacts (enroll() skips unsubscribed and
 * already-enrolled contacts, so overlapping crossings can't double-enroll). Then snapshot the
 * current values. A company with no snapshot yet is a baseline — nothing fires for it.
 */
export async function evaluateMetricCrossings(db: D1Database): Promise<CrossingSummary> {
	const summary: CrossingSummary = { crossings: 0, enrolled: 0 };
	const current = await db
		.prepare(
			`SELECT m.company_id, ${TRIGGER_KEYS.map((k) => `m.${k}`).join(', ')}, p.metrics AS prev
			 FROM company_metrics m LEFT JOIN company_metrics_prev p ON p.company_id = m.company_id`
		)
		.all<Record<string, number | null> & { company_id: number; prev: string | null }>();

	const autos = await db
		.prepare(
			`SELECT id, status, trigger_metric, trigger_direction, trigger_threshold FROM automations
			 WHERE status IN ('active', 'paused') AND trigger_type = 'company_metric'`
		)
		.all<{ id: number; status: string; trigger_metric: string | null; trigger_direction: string | null; trigger_threshold: number | null }>();

	for (const a of autos.results) {
		if (!a.trigger_metric || !TRIGGER_KEYS.includes(a.trigger_metric) || a.trigger_threshold === null) continue;
		const dir: CrossDirection = a.trigger_direction === 'below' ? 'below' : 'above';
		for (const row of current.results) {
			if (!row.prev) continue;
			let prev: Record<string, number | null> = {};
			try {
				prev = JSON.parse(row.prev) ?? {};
			} catch {
				continue;
			}
			if (!crossed(prev[a.trigger_metric], row[a.trigger_metric], dir, a.trigger_threshold)) continue;
			summary.crossings++;
			const contacts = await db
				.prepare('SELECT id FROM contacts WHERE company_id = ? ORDER BY id')
				.bind(row.company_id)
				.all<{ id: number }>();
			// #397: a paused automation records the contacts (offered on resume), never enrolls.
			if (a.status === 'paused') {
				await recordPendingTriggers(db, a.id, contacts.results.map((c) => c.id), 'company_metric');
				continue;
			}
			const res = await enroll(db, a.id, contacts.results.map((c) => c.id));
			summary.enrolled += res.enrolled;
		}
	}

	const upsert = db.prepare(
		`INSERT INTO company_metrics_prev (company_id, metrics, captured_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(company_id) DO UPDATE SET metrics = excluded.metrics, captured_at = excluded.captured_at`
	);
	const stmts = current.results.map((row) => {
		const snap: Record<string, number | null> = {};
		for (const k of TRIGGER_KEYS) snap[k] = row[k] ?? null;
		return upsert.bind(row.company_id, JSON.stringify(snap));
	});
	for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
	return summary;
}

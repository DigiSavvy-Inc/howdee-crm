// #467: one contact's scores in the shape the Data API, the assistant and MCP return —
// value + band per active score and its last 20 ledger rows (contact.ts `contactScores`).

import { ruleTitle, sourceText } from '$lib/scoring';
import { contactScores } from './contact';

export type ContactScoreApi = {
	id: number;
	slug: string;
	name: string;
	value: number;
	band: string | null;
	prev_value: number | null;
	changed_at: string | null;
	pending: boolean;
	history: {
		points: number;
		reason: string;
		source_type: string;
		source_id: string;
		earned_at: string;
		expires_at: string | null;
		expired: boolean;
		note: string | null;
	}[];
};

export async function contactScoresApi(db: D1Database, contactId: number, now: Date = new Date()): Promise<ContactScoreApi[]> {
	const rows = await contactScores(db, contactId, now);
	return rows.map((s) => ({
		id: s.score_id,
		slug: s.slug,
		name: s.name,
		value: s.value,
		band: s.band,
		prev_value: s.prev_value,
		changed_at: s.changed_at,
		pending: s.pending,
		history: s.history.map((h) => ({
			points: h.points,
			reason: h.rule_kind ? ruleTitle({ label: h.rule_label, kind: h.rule_kind, event_type: h.event_type }) : sourceText(h.source_type),
			source_type: h.source_type,
			source_id: h.source_id,
			earned_at: h.earned_at,
			expires_at: h.expires_at,
			expired: h.expired,
			note: h.note
		}))
	}));
}

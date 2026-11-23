// Who did a list-less campaign go to? (#118)
//
// `campaigns.list_id` is NULL for 1:1 direct sends (compose "direct" action), the SEO
// Snapshot review emails (snapshot-review.ts, #108), and automation-step campaigns — see
// the `campaigns` entry in CLAUDE.md's Data model. Those all still write one `recipients`
// row per send (sendCampaignEmail, the shared send path — see FEATURE_CHECKLIST §2), so
// the audience is always recoverable even with no list: a small sample of `recipients`
// rows plus the total count.
//
// `describeAudience` is the pure derivation (list wins, then automation, then a
// recipients sample, then none) shared by the campaign page and the dashboard send log so
// both render the same thing from differently-shaped queries (the campaign page can afford
// a couple of extra per-campaign queries; the send log fetches many rows at once and needs
// a single cheap correlated subquery per row instead).

import { audienceView, readAudience } from './campaign-audience';
import { audienceLabel as groupsLabel, type AudienceGroup } from '$lib/campaign-audience';

export type AudienceRow = { id: number | null; email: string; contact_id: number | null };

export type Audience =
	// #332: `include` / `exclude` are set when the campaign targets more than one group.
	| { kind: 'list'; name: string; listId: number; include?: AudienceGroup[]; exclude?: AudienceGroup[] }
	| { kind: 'automation'; name: string; automationId: number }
	| { kind: 'recipients'; sample: AudienceRow[]; total: number } // list-less: direct / review / other
	| { kind: 'none' };

export type AudienceInput = {
	list_id: number | null;
	list_name: string | null;
	automation_id: number | null;
	automation_name: string | null;
	/** Total recipients for this campaign — only consulted when there's no list/automation. */
	recipient_count: number;
	/** Up to a handful of `recipients` rows, oldest-first (`ORDER BY id`). Only the first 3 are used. */
	sample: AudienceRow[];
};

const SAMPLE_LIMIT = 3;

/** Pure: list wins, else automation, else a recipients sample (when there's anyone), else none. */
export function describeAudience(input: AudienceInput): Audience {
	if (input.list_id != null && input.list_name) {
		return { kind: 'list', name: input.list_name, listId: input.list_id };
	}
	if (input.automation_id != null && input.automation_name) {
		return { kind: 'automation', name: input.automation_name, automationId: input.automation_id };
	}
	if (input.recipient_count > 0) {
		return { kind: 'recipients', sample: input.sample.slice(0, SAMPLE_LIMIT), total: input.recipient_count };
	}
	return { kind: 'none' };
}

/** One-line label: "Newsletter" | "automation: Welcome drip" | "jane@example.com" | "jane@example.com, bob@example.org" | "jane@example.com, bob@example.org, carol@example.net +4 more" | "—" */
export function audienceLabel(a: Audience): string {
	switch (a.kind) {
		case 'list':
			return a.include ? groupsLabel({ include: a.include, exclude: a.exclude ?? [] }) : a.name;
		case 'automation':
			return `automation: ${a.name}`;
		case 'recipients': {
			if (a.sample.length === 0) return '—';
			const shown = a.sample.slice(0, SAMPLE_LIMIT);
			const extra = a.total - shown.length;
			const joined = shown.map((r) => r.email).join(', ');
			return extra > 0 ? `${joined} +${extra} more` : joined;
		}
		case 'none':
			return '—';
	}
}

/**
 * Single-campaign lookup used by the campaign page: fetches the list/automation names plus
 * (only when neither applies) a sample of `recipients` rows and the total count, then runs
 * `describeAudience`. Cheap enough per-campaign; the send log's bulk list avoids this in
 * favor of one correlated subquery per row (see `sendlog-query.ts`/`+page.server.ts`).
 */
export async function loadAudience(db: D1Database, campaignId: number): Promise<Audience> {
	const row = await db
		.prepare(
			`SELECT c.list_id, l.name AS list_name, c.automation_id, a.name AS automation_name,
			        c.recipient_count
			 FROM campaigns c
			 LEFT JOIN lists l ON l.id = c.list_id
			 LEFT JOIN automations a ON a.id = c.automation_id
			 WHERE c.id = ?`
		)
		.bind(campaignId)
		.first<{
			list_id: number | null;
			list_name: string | null;
			automation_id: number | null;
			automation_name: string | null;
			recipient_count: number;
		}>();
	if (!row) return { kind: 'none' };

	let sample: AudienceRow[] = [];
	let total = row.recipient_count ?? 0;

	// Only bother fetching recipients when there's no list/automation to show instead —
	// describeAudience ignores `sample`/`recipient_count` in that case anyway.
	if (row.list_id == null && row.automation_id == null) {
		const sampleRows = await db
			.prepare(`SELECT id, email, contact_id FROM recipients WHERE campaign_id = ? ORDER BY id LIMIT ?`)
			.bind(campaignId, SAMPLE_LIMIT)
			.all<AudienceRow>();
		sample = sampleRows.results;

		const totalRow = await db
			.prepare(`SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?`)
			.bind(campaignId)
			.first<{ n: number }>();
		total = totalRow?.n ?? 0;
	}

	const out = describeAudience({
		list_id: row.list_id,
		list_name: row.list_name,
		automation_id: row.automation_id,
		automation_name: row.automation_name,
		recipient_count: total,
		sample
	});
	// #332: several included groups and / or exclusions.
	if (out.kind === 'list') {
		const v = await audienceView(db, await readAudience(db, campaignId, row.list_id));
		if (v.include.length > 1 || v.exclude.length) return { ...out, include: v.include, exclude: v.exclude };
	}
	return out;
}

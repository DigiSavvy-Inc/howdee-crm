// Engagement tier override (#460) — the one write path for the automation action, the
// contact page, the bulk bar, the assistant and the Data API. `contact_engagement.tier`
// stays the effective tier (override → unsubscribed-cold → score, see engagement.ts);
// this writes the override columns and recomputes the contacts so `tier` follows at once.
import type { TierName } from '$lib/engagement-view';
import { computeEngagement, markDirty } from './engagement';

/** Recompute inline up to this many contacts; more are marked dirty for the heartbeat. */
export const TIER_INLINE_RECOMPUTE_MAX = 200;
const CHUNK = 90;

export type TierOverrideState = {
	contact_id: number;
	tier: string | null;
	tier_auto: string | null;
	tier_override: string | null;
	tier_override_until: string | null;
	tier_override_source: string | null;
	tier_override_at: string | null;
};

export type SetTierOptions = {
	/** The tier to set; null = clear (back to automatic). */
	tier: TierName | null;
	/** 1–365 days; null / omitted = until cleared. Ignored when clearing. */
	days?: number | null;
	/** Who set it: `automation:<id>`, `user:<login>`, `bulk:<login>`, `assistant:<login>`, `api:<key id>`. */
	source: string;
	now?: Date;
};

export type SetTierResult = {
	/** Contacts whose override was written (set) or removed (clear). */
	changed: number[];
	/** Contacts left alone: clear with no override, or already overridden to that tier until cleared. */
	unchanged: number[];
	/** ISO expiry written (null = until cleared, or a clear). */
	until: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function isActive(r: Pick<TierOverrideState, 'tier_override' | 'tier_override_until'>, nowIso: string): boolean {
	return !!r.tier_override && (r.tier_override_until === null || r.tier_override_until > nowIso);
}

/** The automation's name for a `automation:<id>` source (null otherwise / when it's gone). */
export async function automationNameFromSource(db: D1Database, source: string | null | undefined): Promise<string | null> {
	const m = /^automation:(\d+)$/.exec(source ?? '');
	if (!m) return null;
	const row = await db.prepare('SELECT name FROM automations WHERE id = ?').bind(Number(m[1])).first<{ name: string }>();
	return row?.name ?? null;
}

/** Current override state for these contacts (contacts without a row are left out). */
export async function tierOverrideStates(db: D1Database, contactIds: number[]): Promise<Map<number, TierOverrideState>> {
	const out = new Map<number, TierOverrideState>();
	for (const batch of chunk(contactIds, CHUNK)) {
		const rows = await db
			.prepare(
				`SELECT contact_id, tier, tier_auto, tier_override, tier_override_until, tier_override_source, tier_override_at
				 FROM contact_engagement WHERE contact_id IN (${batch.map(() => '?').join(',')})`
			)
			.bind(...batch)
			.all<TierOverrideState>();
		for (const r of rows.results) out.set(r.contact_id, r);
	}
	return out;
}

/**
 * Set (or clear, `tier: null`) the tier override on `contactIds`, then recompute them —
 * inline up to TIER_INLINE_RECOMPUTE_MAX, else marked dirty for the heartbeat. Unknown ids
 * are ignored. Setting the tier a contact already has as an until-cleared override, with no
 * `days`, changes nothing; with `days` the window is refreshed.
 */
export async function setTierOverride(db: D1Database, contactIds: number[], opts: SetTierOptions): Promise<SetTierResult> {
	const now = opts.now ?? new Date();
	const nowIso = now.toISOString();
	const wanted = [...new Set(contactIds.filter((id) => Number.isInteger(id) && id > 0))];
	const days = opts.tier && opts.days ? Math.floor(opts.days) : null;
	const until = days ? new Date(now.getTime() + days * 86_400_000).toISOString() : null;
	if (!wanted.length) return { changed: [], unchanged: [], until };

	// Only real contacts; make sure each has an engagement row to hold the override.
	const ids: number[] = [];
	for (const batch of chunk(wanted, CHUNK)) {
		const ph = batch.map(() => '?').join(',');
		const rows = await db.prepare(`SELECT id FROM contacts WHERE id IN (${ph})`).bind(...batch).all<{ id: number }>();
		ids.push(...rows.results.map((r) => r.id));
		await db.prepare(`INSERT OR IGNORE INTO contact_engagement (contact_id, dirty) SELECT id, 1 FROM contacts WHERE id IN (${ph})`).bind(...batch).run();
	}
	const states = await tierOverrideStates(db, ids);

	const changed: number[] = [];
	const unchanged: number[] = [];
	for (const id of ids) {
		const st = states.get(id);
		const active = !!st && isActive(st, nowIso);
		if (opts.tier === null) {
			if (st?.tier_override) changed.push(id);
			else unchanged.push(id);
		} else if (active && st!.tier_override === opts.tier && !days && st!.tier_override_until === null) {
			unchanged.push(id);
		} else {
			changed.push(id);
		}
	}

	for (const batch of chunk(changed, CHUNK - 4)) {
		const ph = batch.map(() => '?').join(',');
		if (opts.tier === null) {
			await db
				.prepare(
					`UPDATE contact_engagement SET tier_override = NULL, tier_override_until = NULL, tier_override_source = NULL,
					   tier_override_at = NULL WHERE contact_id IN (${ph})`
				)
				.bind(...batch)
				.run();
		} else {
			await db
				.prepare(
					`UPDATE contact_engagement SET tier_override = ?, tier_override_until = ?, tier_override_source = ?,
					   tier_override_at = ? WHERE contact_id IN (${ph})`
				)
				.bind(opts.tier, until, opts.source.slice(0, 120), nowIso, ...batch)
				.run();
		}
	}

	if (changed.length) {
		if (changed.length <= TIER_INLINE_RECOMPUTE_MAX) await computeEngagement(db, { contactIds: changed, now });
		else await markDirty(db, changed);
	}
	return { changed, unchanged, until };
}

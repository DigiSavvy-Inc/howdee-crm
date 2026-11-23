// #467: the "Score changes" automation trigger (`score_changed`) and the "Adjust score" action
// (`adjust_score`). Universal (no server imports): the config stored in
// `automations.trigger_config` / `automation_steps.action_config`, validation, matching and the
// words the editor uses. Firing lives in `src/lib/server/score-trigger.ts`; the scoring engine
// records the changes (`score_change_events`) when it recomputes a watched score.
//
// Trigger config:
//   score_id   the score (score_defs.id)
//   mode       crosses_above | crosses_below (threshold) | enters_band (band label) | any_change
//   threshold  whole number, the crossing modes only
//   band       a band label, enters_band only (matched case-insensitively)

import { SCORE_LIMITS, pointsText } from '$lib/scoring';

export const SCORE_TRIGGER_KIND = 'score_changed';

export function isScoreTriggerKind(type: unknown): type is 'score_changed' {
	return type === SCORE_TRIGGER_KIND;
}

export const SCORE_TRIGGER_MODES = ['crosses_above', 'crosses_below', 'enters_band', 'any_change'] as const;
export type ScoreTriggerMode = (typeof SCORE_TRIGGER_MODES)[number];

export const SCORE_TRIGGER_MODE_LABELS: Record<ScoreTriggerMode, string> = {
	crosses_above: 'Rises to or above a value',
	crosses_below: 'Drops below a value',
	enters_band: 'Enters a band',
	any_change: 'Changes at all'
};

export type ScoreTriggerConfig = {
	score_id: number | null;
	mode: ScoreTriggerMode;
	threshold: number | null;
	band: string | null;
};

export function defaultScoreTriggerConfig(): ScoreTriggerConfig {
	return { score_id: null, mode: 'crosses_above', threshold: 50, band: null };
}

const isMode = (v: unknown): v is ScoreTriggerMode => (SCORE_TRIGGER_MODES as readonly unknown[]).includes(v);

/** Untrusted input → a clean config, or the first problem. Shape only — that the score (and
 *  its band) exists is checked by the write layer. */
export function normalizeScoreTriggerConfig(
	raw: Record<string, unknown> | null | undefined
): { ok: true; config: ScoreTriggerConfig } | { ok: false; error: string } {
	const src = raw && typeof raw === 'object' ? raw : {};
	const id = Number(src.score_id);
	if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Choose a score for the trigger.' };
	const mode = src.mode ?? 'crosses_above';
	if (!isMode(mode)) return { ok: false, error: `Unknown score trigger mode “${String(mode)}”.` };
	const cfg: ScoreTriggerConfig = { score_id: id, mode, threshold: null, band: null };
	if (mode === 'crosses_above' || mode === 'crosses_below') {
		const t = src.threshold === '' || src.threshold === null || src.threshold === undefined ? NaN : Number(src.threshold);
		if (!Number.isInteger(t) || Math.abs(t) > 1_000_000) return { ok: false, error: 'Set a whole-number value for the score trigger.' };
		cfg.threshold = t;
	}
	if (mode === 'enters_band') {
		const b = String(src.band ?? '').trim();
		if (!b) return { ok: false, error: 'Choose the band for the score trigger.' };
		cfg.band = b.slice(0, SCORE_LIMITS.bandLabelMax);
	}
	return { ok: true, config: cfg };
}

/** `automations.trigger_config` → config (junk → defaults, `score_id` null). */
export function parseScoreTriggerConfig(json: string | null | undefined): ScoreTriggerConfig {
	if (!json) return defaultScoreTriggerConfig();
	try {
		const r = normalizeScoreTriggerConfig(JSON.parse(json));
		return r.ok ? r.config : defaultScoreTriggerConfig();
	} catch {
		return defaultScoreTriggerConfig();
	}
}

export type ScoreChange = { score_id: number; old_value: number; new_value: number; old_band: string | null; new_band: string | null };

const sameBand = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** Does this change fire the trigger? Only real transitions — never a value that stays put. */
export function scoreChangeMatches(cfg: ScoreTriggerConfig, ch: ScoreChange): boolean {
	if (cfg.score_id !== ch.score_id) return false;
	switch (cfg.mode) {
		case 'crosses_above':
			return cfg.threshold !== null && ch.old_value < cfg.threshold && ch.new_value >= cfg.threshold;
		case 'crosses_below':
			return cfg.threshold !== null && ch.old_value >= cfg.threshold && ch.new_value < cfg.threshold;
		case 'enters_band':
			return !!cfg.band && !!ch.new_band && sameBand(ch.new_band, cfg.band) && !sameBand(ch.old_band, cfg.band);
		case 'any_change':
			return ch.old_value !== ch.new_value;
	}
}

/** "When Lead score rises to 50 or more", "When Lead score enters band “Sales-ready”". */
export function scoreTriggerText(cfg: ScoreTriggerConfig, scoreName: (id: number) => string | null): string {
	if (!cfg.score_id) return 'When a score changes (choose one)';
	const name = scoreName(cfg.score_id) ?? '(deleted score)';
	switch (cfg.mode) {
		case 'crosses_above':
			return `When ${name} rises to ${cfg.threshold} or more`;
		case 'crosses_below':
			return `When ${name} drops below ${cfg.threshold}`;
		case 'enters_band':
			return `When ${name} enters band “${cfg.band ?? ''}”`;
		case 'any_change':
			return `When ${name} changes`;
	}
}

// ── The "Adjust score" action ─────────────────────────────────────────────────────────────

export type AdjustScoreConfig = { score_id: number; points: number; expires_days: number | null };

/** Untrusted action fields → a clean config, or the first problem (shape only). */
export function normalizeAdjustScore(raw: {
	score_id?: unknown;
	points?: unknown;
	expires_days?: unknown;
}): { ok: true; value: AdjustScoreConfig } | { ok: false; error: string } {
	const id = Number(raw.score_id);
	if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Choose the score to adjust.' };
	const p = Number(String(raw.points ?? '').replace('−', '-'));
	if (raw.points === '' || raw.points == null || !Number.isInteger(p) || p === 0 || p < SCORE_LIMITS.minPoints || p > SCORE_LIMITS.maxPoints)
		return { ok: false, error: `Points: a whole number from ${SCORE_LIMITS.minPoints} to ${SCORE_LIMITS.maxPoints}, not 0.` };
	let expires: number | null = null;
	if (raw.expires_days !== null && raw.expires_days !== undefined && raw.expires_days !== '') {
		const e = Number(raw.expires_days);
		if (!Number.isInteger(e) || e < SCORE_LIMITS.minExpiryDays || e > SCORE_LIMITS.maxExpiryDays)
			return { ok: false, error: `Expiry: ${SCORE_LIMITS.minExpiryDays}–${SCORE_LIMITS.maxExpiryDays} days, or blank for never.` };
		expires = e;
	}
	return { ok: true, value: { score_id: id, points: p, expires_days: expires } };
}

/** `automation_steps.action_config` → config, or null. */
export function parseAdjustScore(json: string | null | undefined): AdjustScoreConfig | null {
	if (!json) return null;
	try {
		const r = normalizeAdjustScore(JSON.parse(json));
		return r.ok ? r.value : null;
	} catch {
		return null;
	}
}

/** Canvas title: "Adjust Lead score by +5 · expires in 30 days". */
export function adjustScoreTitle(cfg: AdjustScoreConfig | null, scoreName: string | null): string {
	if (!cfg) return 'Adjust a score (choose one)';
	const exp = cfg.expires_days ? ` · expires in ${cfg.expires_days} day${cfg.expires_days === 1 ? '' : 's'}` : '';
	return `Adjust ${scoreName ?? '(deleted score)'} by ${pointsText(cfg.points)}${exp}`;
}

/** The decision / timeline label: "Adjusted Email interest by +5". */
export function adjustedLabel(scoreName: string, points: number): string {
	return `Adjusted ${scoreName} by ${pointsText(points)}`;
}

export function isAdjustedLabel(label: string): boolean {
	return label.startsWith('Adjusted ');
}

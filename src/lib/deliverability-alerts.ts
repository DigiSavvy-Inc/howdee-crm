// Post-send deliverability alerts (#305) — universal vocabulary shared by the engine
// (src/lib/server/deliverability-alerts.ts), Settings → Deliverability, the banners and the
// dashboard digest: thresholds, the rate maths, the level rule and the config normaliser.
//
// Rates are fractions of `sent` (0.02 = 2%). A rate AT a threshold is that level (>=).
// The level of a check is the worse of the hard-bounce level and the complaint level; the
// all-bounces rate is reported alongside but has no threshold of its own.

export const ALERT_LEVELS = ['ok', 'warning', 'critical'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export const WEBHOOK_FORMATS = ['json', 'slack'] as const;
export type AlertWebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export type Thresholds = {
	hardWarn: number;
	hardCrit: number;
	complaintWarn: number;
	complaintCrit: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
	hardWarn: 0.02,
	hardCrit: 0.05,
	complaintWarn: 0.0005,
	complaintCrit: 0.001
};

export type AlertConfig = Thresholds & {
	webhookUrl: string;
	webhookFormat: AlertWebhookFormat;
	/** On a critical campaign alert, hold queued scheduled broadcasts to the same list. Off by default. */
	holdOnCritical: boolean;
};

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
	...DEFAULT_THRESHOLDS,
	webhookUrl: '',
	webhookFormat: 'json',
	holdOnCritical: false
};

export type CheckCounts = { sent: number; bounces: number; hard_bounces: number; complaints: number };
export type CheckRates = { bounceRate: number; hardRate: number; complaintRate: number };

/** Rates over `sent`; all 0 when nothing was sent. */
export function checkRates(c: CheckCounts): CheckRates {
	if (!c.sent || c.sent <= 0) return { bounceRate: 0, hardRate: 0, complaintRate: 0 };
	return { bounceRate: c.bounces / c.sent, hardRate: c.hard_bounces / c.sent, complaintRate: c.complaints / c.sent };
}

// Tolerance so 5/10000 reads as AT 0.05% however the float rounds.
const EPS = 1e-12;

/** `critical` at or above `crit`, `warning` at or above `warn`, else `ok`. */
export function levelFor(rate: number, warn: number, crit: number): AlertLevel {
	if (rate + EPS >= crit) return 'critical';
	if (rate + EPS >= warn) return 'warning';
	return 'ok';
}

const RANK: Record<AlertLevel, number> = { ok: 0, warning: 1, critical: 2 };

export function worseLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
	return RANK[a] >= RANK[b] ? a : b;
}

/** The check's level: worse of hard bounces and complaints. Nothing sent → ok. */
export function checkLevel(c: CheckCounts, t: Thresholds): { level: AlertLevel; hard: AlertLevel; complaint: AlertLevel } {
	if (!c.sent || c.sent <= 0) return { level: 'ok', hard: 'ok', complaint: 'ok' };
	const r = checkRates(c);
	const hard = levelFor(r.hardRate, t.hardWarn, t.hardCrit);
	const complaint = levelFor(r.complaintRate, t.complaintWarn, t.complaintCrit);
	return { level: worseLevel(hard, complaint), hard, complaint };
}

/** "12.0%", "0.05%" — two decimals under 1%, one above. */
export function formatRate(rate: number): string {
	const pct = rate * 100;
	return `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
}

/** Threshold as typed in the form ("2", "0.05"): a percent, no trailing zeros. */
export function percentInput(rate: number): string {
	return String(Number((rate * 100).toFixed(4)));
}

/** Week-over-week direction of a rate: up = worse. Within 0.01 percentage points = flat. */
export function trendDirection(current: number, previous: number): 'up' | 'down' | 'flat' {
	const d = current - previous;
	if (Math.abs(d) < 0.0001) return 'flat';
	return d > 0 ? 'up' : 'down';
}

export const LEVEL_LABELS: Record<AlertLevel, string> = { ok: 'OK', warning: 'Warning', critical: 'Critical' };

/** Why the thresholds can't be saved, or null. Each in (0, 100%], warning below critical. */
export function thresholdsProblem(t: Thresholds): string | null {
	for (const v of [t.hardWarn, t.hardCrit, t.complaintWarn, t.complaintCrit]) {
		if (!Number.isFinite(v) || v <= 0 || v > 1) return 'Thresholds must be percentages above 0 and at most 100.';
	}
	if (t.hardWarn >= t.hardCrit) return 'The hard-bounce warning must be below the critical level.';
	if (t.complaintWarn >= t.complaintCrit) return 'The complaint warning must be below the critical level.';
	return null;
}

/** Stored JSON → a usable config: bad or missing pieces fall back to the defaults. */
export function normalizeAlertConfig(raw: unknown): AlertConfig {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : d);
	const t: Thresholds = {
		hardWarn: num(o.hardWarn, DEFAULT_THRESHOLDS.hardWarn),
		hardCrit: num(o.hardCrit, DEFAULT_THRESHOLDS.hardCrit),
		complaintWarn: num(o.complaintWarn, DEFAULT_THRESHOLDS.complaintWarn),
		complaintCrit: num(o.complaintCrit, DEFAULT_THRESHOLDS.complaintCrit)
	};
	const thresholds = thresholdsProblem(t) ? { ...DEFAULT_THRESHOLDS } : t;
	return {
		...thresholds,
		webhookUrl: typeof o.webhookUrl === 'string' ? o.webhookUrl.trim() : '',
		webhookFormat: o.webhookFormat === 'slack' ? 'slack' : 'json',
		holdOnCritical: o.holdOnCritical === true
	};
}

export type Reason = { reason: string; n: number };

/** One banner box: the newest undismissed warning/critical check of a campaign or automation. */
export type ActiveAlert = {
	id: number;
	scope: 'campaign' | 'automation';
	ref_id: number;
	check_key: string;
	level: 'warning' | 'critical';
	sent: number;
	bounces: number;
	hard_bounces: number;
	complaints: number;
	reasons: Reason[];
	held_count: number;
	checked_at: string;
	title: string | null; // campaign subject / automation name (null when deleted)
	href: string;
	bounced_href: string;
	held: { id: number; subject: string; scheduled_at: string | null }[];
};

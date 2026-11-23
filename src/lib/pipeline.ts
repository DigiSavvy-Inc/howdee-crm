// Pipeline (#206) — universal vocabulary + view math, safe on client and server.

export type StageKind = 'open' | 'won' | 'lost';
export const STAGE_KINDS: StageKind[] = ['open', 'won', 'lost'];

/** Stage colours are keys into existing tokens (status + viz ramp) — no new colours. The
 *  colour is a dot/pill accent only; card text stays in text tokens. */
export const STAGE_COLORS = ['muted', 'accent', 'viz-1', 'viz-2', 'viz-3', 'success', 'warn', 'danger'] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

export function isStageColor(v: unknown): v is StageColor {
	return typeof v === 'string' && (STAGE_COLORS as readonly string[]).includes(v);
}

/** CSS colour for a stage's dot/pill. Unknown/NULL → muted. */
export function stageColorVar(color: string | null | undefined): string {
	return `var(--${isStageColor(color) ? color : 'muted'})`;
}

/** List/kanban choice, remembered in a cookie (like #200's status filter). */
export const VIEW_COOKIE = 'pipeline_view';
export type PipelineView = 'kanban' | 'list';
export function parseView(v: string | null | undefined): PipelineView | null {
	return v === 'kanban' || v === 'list' ? v : null;
}

export function formatValue(v: number | null | undefined): string {
	if (v == null) return '—';
	return '$' + v.toLocaleString('en-US');
}

/** Whole days between a UTC 'YYYY-MM-DD HH:MM:SS' timestamp and now (never negative). */
export function daysSince(ts: string | null | undefined, now: Date = new Date()): number {
	if (!ts) return 0;
	const t = new Date(ts.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z')).getTime();
	if (Number.isNaN(t)) return 0;
	return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function initials(s: string | null | undefined): string {
	const parts = String(s ?? '').trim().split(/[\s@._-]+/).filter(Boolean);
	return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

/** A pipeline_history row as the contact page / timeline / feed read it (#206, #207). */
export type HistoryLike = {
	from_stage_id: number | null;
	to_stage_id: number | null;
	from_name: string | null;
	to_name: string | null;
	actor_kind: string;
	actor_label: string | null;
};

/** "Added to Lead" / "Qualified → Proposal" / "Removed from Proposal". A stage deletion's
 *  system row has from = to (both the destination) and reads "Moved to Lead" — its note
 *  says why. A stage that's gone reads "(deleted stage)". */
export function historyMoveText(h: HistoryLike): string {
	const to = h.to_name ?? '(deleted stage)';
	const from = h.from_name ?? '(deleted stage)';
	if (h.to_stage_id == null) return h.from_stage_id == null ? 'Removed from the pipeline' : `Removed from ${from}`;
	if (h.from_stage_id == null) return `Added to ${to}`;
	if (h.from_stage_id === h.to_stage_id) return `Moved to ${to}`;
	return `${from} → ${to}`;
}

/** Who made the change: "@jdoe", "automation “Nurture”", "the API", or "system". */
export function historyActorText(h: HistoryLike): string {
	if (h.actor_kind === 'user') return h.actor_label ?? 'a user';
	if (h.actor_kind === 'automation') return h.actor_label ? `automation “${h.actor_label}”` : 'an automation';
	return h.actor_kind === 'api' ? 'the API' : 'system';
}

/** "by @jdoe" — except the system, which is just "system" (nobody did it). */
export function historyByText(h: HistoryLike): string {
	return h.actor_kind === 'system' ? 'system' : `by ${historyActorText(h)}`;
}

/** The fields the list view sorts on (a subset of a board card). */
export type SortableCard = {
	name: string;
	stage_position: number;
	value: number | null;
	owner_login: string | null;
	days_in_stage: number;
	last_activity_at: string | null;
};
export const LIST_SORTS = ['name', 'stage', 'value', 'owner', 'days', 'activity'] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/** List view sort. NULLs (no value / owner / activity) always go last, either direction. */
export function sortCards<T extends SortableCard>(cards: T[], sort: ListSort, dir: 'asc' | 'desc'): T[] {
	const key = (c: T): string | number | null => {
		switch (sort) {
			case 'name': return c.name.toLowerCase();
			case 'stage': return c.stage_position;
			case 'value': return c.value;
			case 'owner': return c.owner_login?.toLowerCase() ?? null;
			case 'days': return c.days_in_stage;
			case 'activity': return c.last_activity_at;
		}
	};
	const sign = dir === 'asc' ? 1 : -1;
	return [...cards].sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		if (ka == null && kb == null) return 0;
		if (ka == null) return 1;
		if (kb == null) return -1;
		return ka < kb ? -sign : ka > kb ? sign : 0;
	});
}

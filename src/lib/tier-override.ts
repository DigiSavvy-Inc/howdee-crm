// Engagement tier override (#460): the universal (client + server) vocabulary shared by the
// "Set engagement tier" automation action, the contact page, the bulk bar, the assistant
// and the Data API. The write helper lives in `$lib/server/tier-override.ts`.
import { TIER_LABELS, isTier, type TierName } from './engagement-view';

export const TIER_OVERRIDE_DAYS_MAX = 365;

/** `tier` = one of TIERS, or 'clear' / null = back to automatic. `days` 1–365, blank = until cleared. */
export type TierOverrideInput = { tier: unknown; days?: unknown };
export type TierOverride = { tier: TierName | null; days: number | null };

/** Validate an override request. `tier` null / '' / 'clear' clears (days must then be blank). */
export function normalizeTierOverride(input: TierOverrideInput): { ok: true; value: TierOverride } | { ok: false; error: string } {
	const raw = typeof input.tier === 'string' ? input.tier.trim().toLowerCase() : input.tier;
	const clear = raw === null || raw === undefined || raw === '' || raw === 'clear' || raw === 'auto' || raw === 'automatic';
	if (!clear && !isTier(raw)) return { ok: false, error: 'Choose a tier: hot, warm, cool, cold, never or new (or clear).' };
	const d = input.days;
	let days: number | null = null;
	if (d !== null && d !== undefined && d !== '') {
		const n = Number(d);
		if (!Number.isInteger(n) || n < 1 || n > TIER_OVERRIDE_DAYS_MAX) {
			return { ok: false, error: `Days must be a whole number from 1 to ${TIER_OVERRIDE_DAYS_MAX} (blank = until cleared).` };
		}
		days = n;
	}
	if (clear) return { ok: true, value: { tier: null, days: null } };
	return { ok: true, value: { tier: raw as TierName, days } };
}

export function tierLabel(tier: string | null | undefined): string {
	return isTier(tier) ? TIER_LABELS[tier] : (tier ?? '');
}

/** Action step title: "Set tier to Hot for 30 days" / "Set tier to Hot" / "Clear tier override". */
export function tierActionTitle(tier: string | null | undefined, days: number | null | undefined): string {
	if (!tier || tier === 'clear') return 'Clear tier override';
	if (!isTier(tier)) return 'Set engagement tier';
	return `Set tier to ${TIER_LABELS[tier]}${days ? ` for ${days} day${days === 1 ? '' : 's'}` : ''}`;
}

/** `automation:12` → "automation #12", `user:jdoe` → "@jdoe", … — for "set by …". */
export function tierSourceText(source: string | null | undefined, automationName?: string | null): string {
	if (!source) return 'hand';
	const [kind, ...rest] = source.split(':');
	const ref = rest.join(':');
	switch (kind) {
		case 'automation':
			return automationName ? `automation “${automationName}”` : `automation #${ref}`;
		case 'user':
			return ref ? `@${ref}` : 'hand';
		case 'bulk':
			return ref ? `@${ref} (bulk)` : 'bulk action';
		case 'assistant':
			return ref ? `the assistant (@${ref})` : 'the assistant';
		case 'api':
			return ref ? `API key #${ref}` : 'the API';
		default:
			return source;
	}
}

/** "2026-11-23T10:00:00.000Z" → "2026-11-23". */
export function untilDate(until: string | null | undefined): string | null {
	return until ? until.slice(0, 10) : null;
}

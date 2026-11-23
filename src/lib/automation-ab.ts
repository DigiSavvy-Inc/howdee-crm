// #398: subject / content A/B on an automation email step — the universal parts: which
// variant a pass gets, and the per-variant stats maths. The engine (automations.ts), the
// simulator and the editor's A/B card all use these. Storage: automation_steps.ab_* columns
// and recipients.ab_variant (migration 0102).

export type AbVariant = 'a' | 'b';

/** Variant for one pass at one step: stable (a retried tick or a simulation of an existing
 *  pass gets the same answer), 50/50, and independent of the branch split's hash. */
export function abVariantFor(enrollmentId: number, stepId: number): AbVariant {
	// 32-bit integer mix (murmur-style finaliser) over both ids.
	let h = Math.imul(enrollmentId ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(stepId + 0x632be5ab, 0xc2b2ae35);
	h ^= h >>> 16;
	h = Math.imul(h, 0x7feb352d);
	h ^= h >>> 15;
	h = Math.imul(h, 0x846ca68b);
	h ^= h >>> 16;
	return (h >>> 0) % 2 === 0 ? 'a' : 'b';
}

export type AbCounts = { variant: AbVariant; sent: number; opened: number; clicked: number };
export type AbStat = AbCounts & { openRate: number | null; clickRate: number | null };

function rate(n: number, d: number): number | null {
	return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** Both variants' rows (a missing one = zeros) with open / click rates, one decimal. */
export function abStats(rows: AbCounts[]): AbStat[] {
	return (['a', 'b'] as const).map((variant) => {
		const r = rows.find((x) => x.variant === variant) ?? { variant, sent: 0, opened: 0, clicked: 0 };
		return { ...r, openRate: rate(r.opened, r.sent), clickRate: rate(r.clicked, r.sent) };
	});
}

/** The variant ahead on clicks (then opens), or null when tied / nothing sent. Only a hint —
 *  the operator picks the winner. */
export function abLeader(stats: AbStat[]): AbVariant | null {
	const [a, b] = stats;
	if (!a || !b || a.sent === 0 || b.sent === 0) return null;
	const by = (k: 'clickRate' | 'openRate') => (a[k] ?? 0) - (b[k] ?? 0);
	const d = by('clickRate') || by('openRate');
	return d > 0 ? 'a' : d < 0 ? 'b' : null;
}

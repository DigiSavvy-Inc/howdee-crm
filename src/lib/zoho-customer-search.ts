// Zoho Books customer search (#439) — pure, universal. The company page's Billing panel
// filters the cached customer list (app_state.zoho_books_customers) with this before any
// live Zoho call: case-insensitive "contains" over name, company name and email domain,
// customers where a field starts with the query ranked first, capped, with the total.

export type SearchableCustomer = { id: string; name: string; company_name: string | null; domain: string | null };

export const CUSTOMER_SEARCH_CAP = 25;

export type CustomerMatches<T> = { customers: T[]; total: number };

/** 0 = a field starts with q, 1 = a field contains q, -1 = no match. `q` is lowercased. */
function rank(c: SearchableCustomer, q: string): number {
	let best = -1;
	for (const f of [c.name, c.company_name, c.domain]) {
		const s = (f ?? '').toLowerCase();
		const at = s.indexOf(q);
		if (at === 0) return 0;
		if (at > 0) best = 1;
	}
	return best;
}

export function matchCustomers<T extends SearchableCustomer>(customers: T[], query: string, cap = CUSTOMER_SEARCH_CAP): CustomerMatches<T> {
	const q = query.trim().toLowerCase();
	if (!q) return { customers: [], total: 0 };
	const hits: { c: T; r: number; i: number }[] = [];
	customers.forEach((c, i) => {
		const r = rank(c, q);
		if (r >= 0) hits.push({ c, r, i });
	});
	hits.sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name, undefined, { sensitivity: 'base' }) || a.i - b.i);
	return { customers: hits.slice(0, cap).map((h) => h.c), total: hits.length };
}

/**
 * Local matches first, then live results not already listed (deduped by id), capped. The total
 * counts every distinct customer seen: the local total plus the live ones the cache didn't have.
 */
export function mergeCustomers<T extends SearchableCustomer>(local: CustomerMatches<T>, live: T[], cap = CUSTOMER_SEARCH_CAP): CustomerMatches<T> {
	const seen = new Set(local.customers.map((c) => c.id));
	const extra: T[] = [];
	for (const c of live) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		extra.push(c);
	}
	return { customers: [...local.customers, ...extra].slice(0, cap), total: local.total + extra.length };
}

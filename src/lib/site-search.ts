// Site-wide search (#477) — universal helpers shared by the palette (SearchPalette.svelte)
// and the endpoint (`GET /api/search`, `$lib/server/site-search.ts`).

import { isMacPlatform, keyLabel } from '$lib/shortcuts';

/** A group's `total` stops at this many; the UI then shows "100+". */
export const SEARCH_TOTAL_CAP = 100;
/** How many recently opened records the empty palette shows. */
export const RECENT_MAX = 8;
export const RECENT_STORAGE_KEY = 'ds-search-recent';

export type SearchGroupKey = 'contacts' | 'companies' | 'campaigns' | 'automations';
/** Display order — a later "Commands" group slots in here. */
export const SEARCH_GROUPS: { key: SearchGroupKey; label: string; noun: string; listHref: string }[] = [
	{ key: 'contacts', label: 'Contacts', noun: 'contacts', listHref: '/contacts' },
	{ key: 'companies', label: 'Companies', noun: 'companies', listHref: '/companies' },
	{ key: 'campaigns', label: 'Campaigns', noun: 'campaigns', listHref: '/campaigns' },
	{ key: 'automations', label: 'Automations', noun: 'automations', listHref: '/automations' }
];

export type ContactHit = { id: number; title: string; email: string; company: string | null; tier: string; href: string };
export type CompanyHit = { id: number; title: string; domain: string | null; contact_count: number; href: string };
export type CampaignHit = { id: number; title: string; status: string; date: string | null; href: string };
export type AutomationHit = { id: number; title: string; status: string; trigger: string; href: string };

export type SearchGroup<T> = { items: T[]; total: number; capped: boolean };
export type SearchResponse = {
	q: string;
	contacts: SearchGroup<ContactHit>;
	companies: SearchGroup<CompanyHit>;
	campaigns: SearchGroup<CampaignHit>;
	automations: SearchGroup<AutomationHit>;
};

/** "100+" when the count was capped, else the number. */
export function totalLabel(g: { total: number; capped: boolean }): string {
	return g.capped ? `${SEARCH_TOTAL_CAP}+` : String(g.total);
}

/** The list page with the query filled in ("See all N contacts →"). */
export function seeAllHref(key: SearchGroupKey, q: string): string {
	const g = SEARCH_GROUPS.find((x) => x.key === key)!;
	return `${g.listHref}?q=${encodeURIComponent(q)}`;
}

/** Does the query look like one email address? (offers "Create contact with this email"). */
export function looksLikeEmail(q: string): boolean {
	const s = q.trim();
	if (s.length > 254 || /\s/.test(s)) return false;
	return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(s) && !/\.\./.test(s) && !s.startsWith('.') && !/\.@/.test(s);
}

/** Split `text` into plain / matched parts (case-insensitive, every occurrence) for <mark>.
 *  The caller renders each part as text, so nothing is ever injected as HTML. */
export function highlightParts(text: string, q: string): { text: string; match: boolean }[] {
	const needle = q.trim().toLowerCase();
	if (!needle || !text) return [{ text, match: false }];
	const hay = text.toLowerCase();
	const out: { text: string; match: boolean }[] = [];
	let i = 0;
	while (i < text.length) {
		const at = hay.indexOf(needle, i);
		if (at < 0) break;
		if (at > i) out.push({ text: text.slice(i, at), match: false });
		out.push({ text: text.slice(at, at + needle.length), match: true });
		i = at + needle.length;
	}
	if (i < text.length) out.push({ text: text.slice(i), match: false });
	return out.length ? out : [{ text, match: false }];
}

/** Is focus somewhere the `/` key types a character? */
export function isTypingTarget(el: EventTarget | null): boolean {
	if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
	const h = el as HTMLElement;
	const tag = h.tagName.toLowerCase();
	if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
	return h.isContentEditable === true || !!h.closest?.('[contenteditable=""], [contenteditable="true"]');
}

/** Is this the open-search shortcut? Cmd+K on a Mac, Ctrl+K elsewhere. */
export function isSearchShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
	if (e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return false;
	return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Apple platform? Re-exported from $lib/shortcuts (#572). */
export { isMacPlatform };

/** The tooltip hint for this computer: "⌘K" on a Mac, "Ctrl+K" elsewhere (#572). */
export function searchShortcutHint(mac: boolean): string {
	return keyLabel('Mod+K', mac);
}

// ---- Recently opened records (per browser; must work without storage) ----

export type RecentItem = { type: SearchGroupKey; id: number; title: string; sub?: string; href: string };

export function parseRecent(raw: string | null): RecentItem[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v
			.filter(
				(x) =>
					x &&
					SEARCH_GROUPS.some((g) => g.key === x.type) &&
					Number.isInteger(x.id) &&
					typeof x.title === 'string' &&
					typeof x.href === 'string' &&
					x.href.startsWith('/') &&
					!x.href.startsWith('//')
			)
			.slice(0, RECENT_MAX)
			.map((x) => ({ type: x.type, id: x.id, title: x.title, sub: typeof x.sub === 'string' ? x.sub : undefined, href: x.href }));
	} catch {
		return [];
	}
}

/** Newest first, de-duplicated, at most RECENT_MAX. */
export function pushRecent(list: RecentItem[], item: RecentItem): RecentItem[] {
	return [item, ...list.filter((x) => !(x.type === item.type && x.id === item.id))].slice(0, RECENT_MAX);
}

export function loadRecent(): RecentItem[] {
	try {
		return parseRecent(localStorage.getItem(RECENT_STORAGE_KEY));
	} catch {
		return [];
	}
}

export function saveRecent(list: RecentItem[]): void {
	try {
		localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
	} catch {
		// no storage (private mode, quota) — recents just aren't kept
	}
}

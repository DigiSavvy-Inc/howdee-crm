// #134: per-user nav layout — 'top' (classic header + tab bar, the default) or 'left'
// (sidebar). Client- AND server-safe: the layout, Settings, and hooks.server.ts share it.

export type NavLayout = 'top' | 'left';

export const NAV_LAYOUTS: readonly NavLayout[] = ['top', 'left'];
export const DEFAULT_NAV_LAYOUT: NavLayout = 'top';
/** localStorage key mirroring the saved preference (read pre-paint in app.html). */
export const NAV_STORAGE_KEY = 'nav';

export function isNavLayout(v: unknown): v is NavLayout {
	return v === 'top' || v === 'left';
}

/** Coerce anything (a DB value, a form field) to a valid layout, falling back to the default. */
export function parseNavLayout(v: unknown): NavLayout {
	return isNavLayout(v) ? v : DEFAULT_NAV_LAYOUT;
}

/**
 * Stamp `data-nav` on the document's `<html>` tag so a signed-in page renders in the right
 * layout on first paint, even on a device whose localStorage hasn't seen the preference yet.
 * Leaves the HTML untouched when there's no `<html` tag (i.e. a later streamed chunk).
 */
export function withNavLayoutAttr(html: string, layout: NavLayout): string {
	return html.replace(/<html(\s|>)/i, `<html data-nav="${parseNavLayout(layout)}"$1`);
}

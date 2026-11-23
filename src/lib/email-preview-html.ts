/** Inject <base target="_blank"> into rendered email HTML so every link — including a
 *  recipient's own unsubscribe link — opens in a new tab at its real destination when
 *  shown inside the sandboxed preview iframe (which has no top-level navigation of its
 *  own). Safe on any HTML string; adds a <head> if there is none. */
export function withBaseTargetBlank(html: string): string {
	if (/<head[\s>]/i.test(html)) {
		return html.replace(/<head([^>]*)>/i, (m) => `${m}<base target="_blank">`);
	}
	if (/<html[\s>]/i.test(html)) {
		return html.replace(/<html([^>]*)>/i, (m) => `${m}<head><base target="_blank"></head>`);
	}
	return `<head><base target="_blank"></head>${html}`;
}

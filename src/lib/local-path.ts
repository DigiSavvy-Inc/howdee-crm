/**
 * #741: whether `v` is a path on this site that is safe to redirect or link to: one leading `/`
 * whose next character is not `/` or `\` (another host), and no backslash or control character
 * (U+0000–U+001F, U+007F) anywhere. Browsers read `\` in a URL path as `/`, and URL parsers drop
 * tab, CR and LF, so `/\evil.example` and `/\t/evil.example` both mean `//evil.example`, another
 * site; SvelteKit 3's `redirect()` reads them the same way and throws (a 500) for an external
 * location it wasn't allowed to follow. Universal: used by server redirects and client links alike.
 */
// eslint-disable-next-line no-control-regex
const LOCAL_PATH = /^\/(?![/\\])[^\\\x00-\x1f\x7f]*$/;

export function isLocalPath(v: string): boolean {
	return LOCAL_PATH.test(v);
}

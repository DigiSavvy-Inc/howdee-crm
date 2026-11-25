// Shared CSV helpers (safe for both client and server).

/** Loose shape only (one @, a dot after it). Use `isEmail` to check an address. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// #744: characters a plain (unquoted) local part may hold; anything at or above U+0080 is
// allowed too (internationalised local parts).
const LOCAL_CHAR = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\-\u0080-\uFFFF]+$/;
// A domain label: letters, digits, hyphens (and non-ASCII letters), never starting or ending
// with a hyphen. Punycode (`xn--…`) passes as ordinary letters and hyphens.
const LABEL = /^(?!-)[A-Za-z0-9\-\u0080-\uFFFF]{1,63}(?<!-)$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Invisible characters: Unicode format characters (category Cf: zero-width space and joiners,
// bidi controls, word joiner, byte order mark, soft hyphen, …) and lone surrogates (Cs; with the
// `u` flag a lone surrogate is its own code point, a valid pair is one astral character).
const INVISIBLE = /[\p{Cf}\p{Cs}]/u;

/**
 * The shared address check (forms, ingest, newsletter signup, manual add, API, import): one
 * `@`, a local part of dot-separated atoms (no leading, trailing or doubled dot; ≤ 64 chars), a
 * domain of two or more labels (no empty label, none starting or ending with a hyphen, a TLD of
 * two or more characters that isn't all digits), ≤ 254 chars, no spaces, control characters,
 * backslashes, quotes or invisible characters (format characters such as zero-width spaces,
 * bidi controls or a byte order mark, and lone surrogates; checked before trimming). Plus tags,
 * subdomains, long TLDs and punycode domains pass. Surrounding whitespace is trimmed first.
 * For an address already stored on a contact, use `isStoredEmail`.
 */
export function isEmail(s: string): boolean {
	const raw = String(s ?? '');
	if (INVISIBLE.test(raw)) return false;
	const v = raw.trim();
	if (!v || v.length > 254 || CONTROL.test(v) || /\s/.test(v)) return false;
	const at = v.lastIndexOf('@');
	if (at <= 0 || v.indexOf('@') !== at) return false;
	const local = v.slice(0, at);
	const domain = v.slice(at + 1);
	if (local.length > 64) return false;
	if (local.split('.').some((atom) => !atom || !LOCAL_CHAR.test(atom))) return false;
	const labels = domain.split('.');
	if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return false;
	const tld = labels[labels.length - 1];
	return tld.length >= 2 && !/^\d+$/.test(tld);
}

/**
 * #744: the looser check addresses were stored under before `isEmail` became stricter (one `@`,
 * a dot after it, no spaces). Only for an address that is already on a contact (looking it up,
 * an unchanged address on an edit, a re-send, the hygiene pass over existing contacts), so such a
 * contact keeps working. A new or changed address uses `isEmail`.
 */
export function isStoredEmail(s: string): boolean {
	return EMAIL_RE.test(String(s ?? '').trim());
}

export type ColumnGuess = {
	email: string | null;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
};

/** Auto-detect which CSV headers map to our contact fields. */
export function guessColumns(headers: string[]): ColumnGuess {
	const find = (re: RegExp) => headers.find((h) => re.test(h.trim())) ?? null;
	return {
		email: find(/^e[-_ ]?mail$|email/i),
		first_name: find(/^first[\s_-]?name$|^first$|fname/i),
		last_name: find(/^last[\s_-]?name$|^last$|lname|surname/i),
		name: find(/^name$|full[\s_-]?name|display[\s_-]?name/i),
		company: find(/^company$|^org(ani[sz]ation)?$|company[\s_-]?name|employer/i)
	};
}

/**
 * Undo `csvCell`'s spreadsheet-formula guard (#539): a cell that starts with an apostrophe
 * followed by = + - @ had it added on export, so drop it. Anything else is untouched.
 */
export function unguardCsvCell(value: string): string {
	return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

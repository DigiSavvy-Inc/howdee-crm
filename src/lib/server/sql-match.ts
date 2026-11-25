/**
 * Text matches without a bound LIKE pattern (#485).
 *
 * D1 refuses any LIKE or GLOB pattern over 50 bytes ("LIKE or GLOB pattern too complex",
 * a 500), and local miniflare doesn't enforce that cap, so a pattern built from user input
 * (a search box, a "contains" rule, a page URL) only fails in production. These fragments
 * compare with instr / substr, which have no cap.
 *
 * Bind the raw text — not an escaped `%…%` pattern. `%` and `_` in it are literal, exactly
 * as they were with `LIKE … ESCAPE '\'` and an escaped bind. `lower()` folds ASCII only, the
 * same case-insensitivity LIKE gives, so short inputs match exactly as before. A NULL column
 * gives NULL (no match), like LIKE; wrap the column in COALESCE where the old SQL did.
 *
 * `p` is the placeholder (`?` or a numbered `?2`). `tests/like-binds-485.test.ts` fails when
 * a new bound LIKE appears outside its short list of bounded binds.
 */

/** Case-insensitive "col contains p". */
export function containsSql(col: string, p = '?'): string {
	return `instr(lower(${col}), lower(${p})) > 0`;
}

/** Case-insensitive "col does not contain p" (NULL col → NULL, like NOT LIKE). */
export function notContainsSql(col: string, p = '?'): string {
	return `instr(lower(${col}), lower(${p})) = 0`;
}

/** Case-insensitive "col starts with p" (an empty p matches every non-NULL value). */
export function startsWithSql(col: string, p = '?'): string {
	return `instr(lower(${col}), lower(${p})) = 1`;
}

/** Case-insensitive "col equals p" — LIKE without wildcards. */
export function equalsCiSql(col: string, p = '?'): string {
	return `lower(${col}) = lower(${p})`;
}

/**
 * Case-insensitive "col ends with p". Uses `p` three times, so with a plain `?` bind the
 * value three times (or pass a numbered placeholder). An empty p matches every non-NULL value.
 */
export function endsWithSql(col: string, p = '?'): string {
	return `(length(${p}) = 0 OR substr(lower(${col}), -length(${p})) = lower(${p}))`;
}

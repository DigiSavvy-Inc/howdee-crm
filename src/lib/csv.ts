// Shared CSV helpers (safe for both client and server).

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isEmail(s: string): boolean {
	return EMAIL_RE.test(s.trim());
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

// Forms (#515): allowed-origin checks, shared by the spec validator (`$lib/forms`) and the
// embed helpers (`$lib/form-embed`). No imports, so neither of those forms a cycle.

/** Why a line isn't an origin (`https://example.com`, optional port, no path), or null. */
export function originProblem(o: string): string | null {
	const s = String(o ?? '').trim();
	if (!s) return 'Empty origin.';
	if (!/^https?:\/\//i.test(s)) return `“${s}” must start with https:// (or http://).`;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return `“${s}” isn’t a valid address.`;
	}
	if (u.username || u.password) return `“${s}” can’t include a user name or password.`;
	if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return `“${s}” must be an origin only — no path, query or #.`;
	if (!u.hostname || /[*\s;,'"]/.test(s)) return `“${s}” isn’t a valid origin.`;
	return null;
}

/** One typed line → the canonical origin when valid (lowercased, no trailing slash), else trimmed as is. */
export function cleanOriginLine(o: string): string {
	const s = String(o ?? '').trim();
	if (!s || originProblem(s)) return s;
	return new URL(s).origin.toLowerCase();
}

/** Only the valid origins of a stored list, canonical and de-duplicated (header-safe). */
export function validOrigins(list: readonly string[] | null | undefined): string[] {
	const out: string[] = [];
	for (const o of list ?? []) {
		if (originProblem(o)) continue;
		const c = cleanOriginLine(o);
		if (!out.includes(c)) out.push(c);
	}
	return out;
}

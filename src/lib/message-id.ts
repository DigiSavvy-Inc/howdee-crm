// Message-ID comparison (#157), universal so the thread view (#378) can match replies to
// their parents in the browser as well as on the server.

/**
 * Comparable form of a message id: lowercased, brackets dropped, and only the part before
 * '@' — Postmark's Message-ID header is `<MessageID@mtasv.net>` while recipients store the
 * bare MessageID.
 */
export function messageIdKey(id: string | null | undefined): string {
	const s = String(id ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
	const at = s.indexOf('@');
	return at >= 0 ? s.slice(0, at) : s;
}

/** Longest References header kept (#585): Gmail threads rarely carry more than a few dozen ids. */
export const REFERENCES_MAX = 4000;

/**
 * Every message id in a References (or In-Reply-To) header, brackets stripped, oldest first,
 * de-duplicated by `messageIdKey`. A header without brackets is split on whitespace.
 */
export function parseReferences(value: string | null | undefined): string[] {
	const s = String(value ?? '').trim();
	if (!s) return [];
	const found = [...s.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
	const ids = found.length ? found : s.split(/[\s,]+/).filter((x) => x.includes('@'));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		const k = messageIdKey(id);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(id.slice(0, 500));
	}
	return out;
}

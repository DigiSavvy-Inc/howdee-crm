/** Serialize a contact's custom-field meta to JSON within a size cap — by dropping the
 *  largest values until it fits, never by slicing the JSON string (a sliced string is
 *  invalid JSON: the next parse would throw and silently wipe every field). */
export function safeMetaJson(meta: Record<string, unknown>, cap = 8000): string | null {
	let json = JSON.stringify(meta);
	while (json.length > cap) {
		const keys = Object.keys(meta);
		if (keys.length === 0) return null;
		// Drop the entry contributing the most bytes.
		let biggest = keys[0];
		let biggestLen = -1;
		for (const k of keys) {
			const len = JSON.stringify(meta[k])?.length ?? 0;
			if (len > biggestLen) {
				biggest = k;
				biggestLen = len;
			}
		}
		delete meta[biggest];
		json = JSON.stringify(meta);
	}
	return Object.keys(meta).length ? json : null;
}

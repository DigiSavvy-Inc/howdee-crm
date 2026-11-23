// Settings → Approved senders (comma-separated full addresses and/or domains). Universal so
// the automation step's From picker (#396) and the server's `fromAllowed` share one rule.

export type ApprovedSenders = { addresses: string[]; domains: string[] };

export function parseApprovedSenders(csv: string | null | undefined): ApprovedSenders {
	const entries = (csv ?? '')
		.split(/[\s,;]+/)
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	return { addresses: entries.filter((e) => e.includes('@')), domains: entries.filter((e) => !e.includes('@')) };
}

/** True when `from` is an approved address or on an approved domain; an empty list allows anything. */
export function senderAllowed(from: string, approved: ApprovedSenders): boolean {
	if (!approved.addresses.length && !approved.domains.length) return true;
	const f = from.trim().toLowerCase();
	const domain = f.split('@')[1] ?? '';
	return approved.addresses.includes(f) || approved.domains.includes(domain);
}

export type SenderOption = { value: string; approved: boolean };

/**
 * The From picker's options: the approved full addresses, plus `extra` addresses (the default
 * From, other steps' Froms) that are approved — and the current value, kept and flagged when
 * it isn't (anymore). `other` = a free-text entry is useful (a domain is approved, or no list).
 */
export function senderOptions(
	approved: ApprovedSenders,
	extra: string[],
	current: string
): { options: SenderOption[]; other: boolean } {
	const seen = new Set<string>();
	const options: SenderOption[] = [];
	const add = (raw: string, keepUnapproved = false) => {
		const v = raw.trim();
		const k = v.toLowerCase();
		if (!v || seen.has(k)) return;
		const ok = senderAllowed(v, approved);
		if (!ok && !keepUnapproved) return;
		seen.add(k);
		options.push({ value: v, approved: ok });
	};
	add(current, true);
	for (const a of approved.addresses) add(a);
	for (const e of extra) add(e);
	return { options, other: approved.domains.length > 0 || (!approved.addresses.length && !approved.domains.length) };
}

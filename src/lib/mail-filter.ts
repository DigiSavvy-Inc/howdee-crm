// Gmail sync noise rules (#443) — client- and server-safe, pure, so the tests drive it.
// Two questions per synced message:
//   1. Is it automated mail (receipts, notifications, lists, auto-replies)? → never stored.
//   2. Which participants are internal (our own mailboxes, users, internal domains)? → an
//      internal address never makes a message a conversation and is never linked to a contact.

/** Gmail category labels skipped like Promotions / Social (backfill query + history). */
export const SKIP_CATEGORY_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

/** Sender local parts that are machines, not people. */
export const AUTOMATED_LOCAL_RE = /^(no-?reply|noreply|notifications?|receipts?|billing|mailer-daemon|do-?not-?reply)/i;

/** Headers the sync fetches on top of the address / threading ones, for `automatedReason`. */
export const AUTOMATION_HEADERS = ['List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'X-Auto-Response-Suppress'];

export type HeaderLookup = (name: string) => string | null;

/** True when the address's local part is an automated sender (noreply@, billing@, …). */
export function isAutomatedSender(email: string | null | undefined): boolean {
	const local = String(email ?? '').split('@')[0] ?? '';
	return AUTOMATED_LOCAL_RE.test(local.trim());
}

/**
 * Why a message is automated, or null when it looks like a person wrote it. `header` returns
 * a header's value (case-insensitive name) or null when absent.
 */
export function automatedReason(header: HeaderLookup, fromEmail: string | null, labels: string[] = []): string | null {
	const label = labels.find((l) => SKIP_CATEGORY_LABELS.includes(l));
	if (label) return `label:${label}`;
	if (header('List-Unsubscribe') != null) return 'list-unsubscribe';
	const precedence = (header('Precedence') ?? '').trim().toLowerCase();
	if (['bulk', 'list', 'auto_reply'].includes(precedence)) return `precedence:${precedence}`;
	const auto = header('Auto-Submitted');
	if (auto != null && auto.trim().toLowerCase() !== 'no') return 'auto-submitted';
	if (header('X-Auto-Response-Suppress') != null) return 'x-auto-response-suppress';
	if (isAutomatedSender(fromEmail)) return 'automated-sender';
	return null;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** "example.com, @Example.org" → ['example.com', 'example.org']; junk entries dropped. */
export function parseDomainList(value: string | null | undefined): string[] {
	const out: string[] = [];
	for (const raw of String(value ?? '').split(/[\s,;]+/)) {
		const d = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.+$/, '');
		if (d && DOMAIN_RE.test(d) && !out.includes(d)) out.push(d);
	}
	return out;
}

export const domainOf = (email: string): string => (email.split('@')[1] ?? '').trim().toLowerCase();

export type InternalSet = { addresses: Set<string>; domains: Set<string> };

/**
 * The internal set: every given address (mailboxes, users' emails) lowercased, plus the
 * internal domains. `domains` null = the default, the domain of each mailbox.
 */
export function buildInternalSet(args: {
	mailboxes: (string | null | undefined)[];
	userEmails?: (string | null | undefined)[];
	domains?: string[] | null;
}): InternalSet {
	const clean = (xs: (string | null | undefined)[]) => xs.map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => x.includes('@'));
	const mailboxes = clean(args.mailboxes);
	const addresses = new Set([...mailboxes, ...clean(args.userEmails ?? [])]);
	const domains = new Set(args.domains ?? mailboxes.map(domainOf).filter(Boolean));
	return { addresses, domains };
}

/** True when the address is ours: listed, or at an internal domain (or a subdomain of one). */
export function isInternal(email: string, set: InternalSet): boolean {
	const e = email.trim().toLowerCase();
	if (set.addresses.has(e)) return true;
	const d = domainOf(e);
	if (!d) return false;
	for (const dom of set.domains) if (d === dom || d.endsWith(`.${dom}`)) return true;
	return false;
}

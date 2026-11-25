// Address hygiene (#306) — the checks that need no network: syntax, typo'd consumer
// domains, disposable domains, role addresses. Universal (the CSV import preview and the
// server share it). The MX/A lookup lives in $lib/server/hygiene.ts.

import { isEmail, isStoredEmail } from '$lib/csv';

/** Throwaway-inbox domains. `isDisposable` in $lib/server/spam re-exports this check. */
export const DISPOSABLE_DOMAINS = new Set([
	'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com',
	'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
	'grr.la', 'maildrop.cc', 'getnada.com', 'nada.email', 'dispostable.com',
	'fakeinbox.com', 'throwawaymail.com', 'mailnesia.com', 'mintemail.com',
	'spamgourmet.com', 'mytemp.email', 'tempinbox.com', 'emailondeck.com', 'moakt.com',
	'tempr.email', 'discard.email', 'mailcatch.com', 'inboxkitten.com', 'tmpmail.org',
	'33mail.com', 'jetable.org', 'spam4.me', 'mailmetrash.com', 'trbvm.com', 'mohmal.com',
	'wegwerfemail.de', 'einrot.com', 'cock.li', 'mvrht.net'
]);

export function isDisposableDomain(domain: string): boolean {
	return DISPOSABLE_DOMAINS.has(domain.trim().toLowerCase());
}

/** The consumer domains a typo is matched against (~30 most common). */
export const COMMON_DOMAINS = [
	'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'hotmail.com',
	'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
	'protonmail.com', 'proton.me', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
	'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'gmx.com', 'mail.com',
	'zoho.com', 'yandex.com', 'fastmail.com', 'yahoo.co.uk', 'hotmail.co.uk'
];

// Real domains one edit away from a common one — never "corrected".
const KNOWN_REAL = new Set([
	...COMMON_DOMAINS,
	'gmx.net', 'gmx.de', 'yahoo.ca', 'yahoo.fr', 'yahoo.de', 'hotmail.fr', 'hotmail.de',
	'outlook.fr', 'live.ca', 'live.co.uk', 'mail.ru', 'web.de', 'hey.com', 'qq.com', 'pm.me'
]);

// Mistyped `.com` endings: gmail.co, gmail.con, gmail.cmo, …
const COM_TYPOS = new Set(['co', 'con', 'cm', 'om', 'comm', 'cpm', 'xom', 'vom', 'cim', 'cok', 'c0m', 'coom']);

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition). */
export function editDistance(a: string, b: string): number {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[a.length][b.length];
}

/**
 * A likely-intended common domain for a misspelt one (`gmial.com` → `gmail.com`), else null.
 * Known real domains are left alone; short domains need an exact `.com` slip to match, so
 * a real 2–3 letter domain isn't "corrected" into a mail provider.
 */
export function suggestDomain(domain: string): string | null {
	const d = domain.trim().toLowerCase();
	if (!d || KNOWN_REAL.has(d)) return null;
	const dot = d.lastIndexOf('.');
	if (dot > 0 && COM_TYPOS.has(d.slice(dot + 1))) {
		const fixed = `${d.slice(0, dot)}.com`;
		if (COMMON_DOMAINS.includes(fixed)) return fixed;
	}
	if (d.length < 7) return null;
	let best: string | null = null;
	let bestDist = Infinity;
	let tie = false;
	for (const c of COMMON_DOMAINS) {
		const dist = editDistance(d, c);
		if (dist < bestDist) {
			best = c;
			bestDist = dist;
			tie = false;
		} else if (dist === bestDist) tie = true;
	}
	const max = d.length >= 10 ? 2 : 1;
	return best && !tie && bestDist <= max ? best : null;
}

/** Role mailboxes — a warning only (they're real, just rarely a person). */
const ROLE_LOCALS = new Set([
	'info', 'sales', 'admin', 'administrator', 'noreply', 'no-reply', 'no.reply', 'donotreply',
	'do-not-reply', 'support', 'contact', 'hello', 'office', 'billing', 'help', 'marketing',
	'team', 'webmaster', 'postmaster', 'hostmaster', 'abuse', 'root', 'enquiries', 'inquiries',
	'enquiry', 'inquiry', 'careers', 'jobs', 'hr', 'accounts', 'accounting', 'feedback', 'press',
	'media', 'newsletter', 'service', 'customerservice', 'security', 'privacy', 'legal', 'orders',
	'reception', 'mailer-daemon', 'notifications', 'all', 'staff'
]);

export function isRoleAddress(email: string): boolean {
	const local = email.trim().toLowerCase().split('@')[0].split('+')[0];
	return ROLE_LOCALS.has(local);
}

export type MxStatus = 'ok' | 'none' | 'unknown';

export type Hygiene = {
	email: string;
	syntax: boolean;
	disposable: boolean;
	role: boolean;
	/** The corrected address when the domain looks misspelt, else null. */
	suggestion: string | null;
	/** null = not looked up. */
	mx: MxStatus | null;
};

export function emailDomain(email: string): string {
	const at = email.lastIndexOf('@');
	return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/**
 * Everything except the MX lookup. `stored` (#744): the address is already on a contact (the
 * pass over existing contacts), so syntax is the looser check it was stored under; a new
 * address uses the strict `isEmail`.
 */
export function checkAddressSync(raw: string, opts: { stored?: boolean } = {}): Hygiene {
	const email = raw.trim().toLowerCase();
	const syntax = opts.stored ? isStoredEmail(email) : isEmail(email);
	const domain = emailDomain(email);
	const fixed = syntax ? suggestDomain(domain) : null;
	return {
		email,
		syntax,
		disposable: syntax && isDisposableDomain(domain),
		role: syntax && isRoleAddress(email),
		suggestion: fixed ? `${email.slice(0, email.lastIndexOf('@'))}@${fixed}` : null,
		mx: null
	};
}

/** Bad syntax, a disposable domain or no mail server → `hygiene:invalid`. */
export function hygieneInvalid(h: Hygiene): boolean {
	return !h.syntax || h.disposable || h.mx === 'none';
}

export type HygieneStatus = 'ok' | 'warn' | 'invalid';

export function hygieneStatus(h: Hygiene): HygieneStatus {
	if (hygieneInvalid(h)) return 'invalid';
	return h.role || h.suggestion ? 'warn' : 'ok';
}

/** Machine flags, in a stable order. */
export function hygieneFlags(h: Hygiene): string[] {
	const f: string[] = [];
	if (!h.syntax) f.push('syntax');
	if (h.disposable) f.push('disposable');
	if (h.mx === 'none') f.push('no-mx');
	if (h.mx === 'unknown') f.push('mx-unknown');
	if (h.role) f.push('role');
	if (h.suggestion) f.push(`typo:${emailDomain(h.suggestion)}`);
	return f;
}

/**
 * The `meta.hygiene` string stored on a contact: the status, then its flags —
 * `ok`, `warn role typo:gmail.com`, `invalid disposable`. The contacts filter reads it.
 */
export function hygieneMeta(h: Hygiene): string {
	return [hygieneStatus(h), ...hygieneFlags(h)].join(' ');
}

/** Short human-readable notes for the UI. */
export function hygieneNotes(h: Hygiene): string[] {
	const n: string[] = [];
	if (!h.syntax) n.push('Invalid address');
	if (h.disposable) n.push('Disposable domain');
	if (h.mx === 'none') n.push('No mail server');
	if (h.role) n.push('Role address');
	if (h.suggestion) n.push(`Did you mean ${h.suggestion}?`);
	return n;
}

export const HYGIENE_FILTERS = ['invalid', 'role', 'typo'] as const;
export type HygieneFilter = (typeof HYGIENE_FILTERS)[number];
export const HYGIENE_FILTER_LABELS: Record<HygieneFilter, string> = {
	invalid: 'Invalid (no MX / disposable)',
	role: 'Role address',
	typo: 'Typo suggested'
};
export function isHygieneFilter(v: string): v is HygieneFilter {
	return (HYGIENE_FILTERS as readonly string[]).includes(v);
}

// Contacts filter `?hygiene=invalid|role|typo` — reads `meta.hygiene` (see hygieneMeta).

export function hygieneClause(kind: HygieneFilter, metaCol = 'meta'): string {
	const h = `COALESCE(CASE WHEN json_valid(${metaCol}) THEN CAST(json_extract(${metaCol}, '$.hygiene') AS TEXT) END, '')`;
	if (kind === 'invalid') return `${h} LIKE 'invalid%'`;
	if (kind === 'role') return `(' ' || ${h} || ' ') LIKE '% role %'`;
	return `${h} LIKE '% typo:%'`;
}

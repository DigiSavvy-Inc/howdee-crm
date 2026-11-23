// Basic spam/quality checks for inbound signups.

import { isDisposableDomain, type MxStatus } from '$lib/email-hygiene';

export function isDisposable(domain: string): boolean {
	return isDisposableDomain(domain);
}

/**
 * Confirm a domain can plausibly receive email (has MX, or an A record as the
 * RFC 5321 fallback) via Cloudflare DNS-over-HTTPS. Fail-open: returns true on
 * any network/parse error so a real signup is never dropped over a flaky lookup.
 */
export async function domainCanReceiveMail(domain: string): Promise<boolean> {
	try {
		const mx = await dohHasType(domain, 'MX', 15);
		if (mx) return true;
		if (mx === null) return true; // lookup failed — accept rather than reject
		const a = await dohHasType(domain, 'A', 1);
		return a !== false; // null (error) -> accept; true -> accept; false -> reject
	} catch {
		return true;
	}
}

/**
 * Tri-state MX/A lookup for address hygiene (#306): 'ok' (MX, or an A record as the
 * fallback), 'none' (definitively neither), 'unknown' (the lookup itself failed).
 */
export async function domainMailStatus(domain: string): Promise<MxStatus> {
	try {
		const mx = await dohHasType(domain, 'MX', 15);
		if (mx) return 'ok';
		if (mx === null) return 'unknown';
		const a = await dohHasType(domain, 'A', 1);
		return a === null ? 'unknown' : a ? 'ok' : 'none';
	} catch {
		return 'unknown';
	}
}

async function dohHasType(name: string, type: string, code: number): Promise<boolean | null> {
	const answers = await dohQuery(name, type);
	if (answers === null) return null;
	return answers.some((a) => a.type === code);
}

export type DohAnswer = { name?: string; type: number; data: string };

/**
 * One Cloudflare DNS-over-HTTPS lookup. Returns the Answer records ([] for NXDOMAIN / no
 * records), or null when the lookup itself failed (network, non-2xx, SERVFAIL…). Also used
 * by the domain-auth checks (#304).
 */
export async function dohQuery(name: string, type: string): Promise<DohAnswer[] | null> {
	try {
		const res = await fetch(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
			{ headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) }
		);
		if (!res.ok) return null;
		const j = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
		// 0 = NOERROR, 3 = NXDOMAIN (a definite "nothing there"); anything else is a failed lookup.
		if (typeof j.Status === 'number' && j.Status !== 0 && j.Status !== 3) return null;
		return Array.isArray(j.Answer) ? j.Answer : [];
	} catch {
		return null;
	}
}

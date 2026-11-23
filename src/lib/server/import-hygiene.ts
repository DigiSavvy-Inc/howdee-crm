// Address hygiene for the hand-entered paths (#306): the CSV import preview + import, and
// manual add. Checks in $lib/email-hygiene; MX + recording in ./hygiene.

import { checkAddressSync, emailDomain, hygieneInvalid, hygieneNotes, type Hygiene } from '$lib/email-hygiene';
import { isEmail } from '$lib/csv';
import { mxStatuses, type MxOptions } from './hygiene';

/** Fresh MX lookups per request; the rest of a big file shows as "not checked". */
export const IMPORT_MX_LOOKUPS = 150;
/** Rows listed in the preview's Hygiene table. */
export const PREVIEW_ISSUE_CAP = 500;

export type InvalidMode = 'unsubscribe' | 'skip';

export function parseInvalidMode(v: unknown): InvalidMode {
	return v === 'skip' ? 'skip' : 'unsubscribe';
}

/** Hygiene (MX included, capped) for each distinct address, keyed by the lowercased email. */
export async function hygieneForEmails(
	emails: string[],
	opts: MxOptions & { max?: number } = {}
): Promise<{ byEmail: Map<string, Hygiene>; unchecked: number }> {
	const byEmail = new Map<string, Hygiene>();
	for (const e of emails) {
		const h = checkAddressSync(e);
		if (!byEmail.has(h.email)) byEmail.set(h.email, h);
	}
	const domains = [...byEmail.values()].filter((h) => h.syntax && !h.disposable).map((h) => emailDomain(h.email));
	const { statuses } = await mxStatuses(domains, { ...opts, max: opts.max ?? IMPORT_MX_LOOKUPS });
	let unchecked = 0;
	for (const h of byEmail.values()) {
		if (!h.syntax || h.disposable) continue;
		h.mx = statuses.get(emailDomain(h.email)) ?? 'unknown';
		if (h.mx === 'unknown') unchecked++;
	}
	return { byEmail, unchecked };
}

export type HygieneCounts = {
	checked: number; // distinct valid-syntax addresses
	invalid: number; // disposable or no MX
	disposable: number;
	noMx: number;
	role: number;
	typo: number;
	unchecked: number; // MX not looked up (cap) or the lookup failed
};

export function countHygiene(list: Iterable<Hygiene>, unchecked = 0): HygieneCounts {
	const c: HygieneCounts = { checked: 0, invalid: 0, disposable: 0, noMx: 0, role: 0, typo: 0, unchecked };
	for (const h of list) {
		if (!h.syntax) continue;
		c.checked++;
		if (hygieneInvalid(h)) c.invalid++;
		if (h.disposable) c.disposable++;
		if (h.mx === 'none') c.noMx++;
		if (h.role) c.role++;
		if (h.suggestion) c.typo++;
	}
	return c;
}

export type PreviewIssue = {
	row: number; // 1-based data row in the file
	email: string;
	notes: string[];
	suggestion: string | null;
	invalid: boolean;
};

/**
 * The CSV preview: one entry per row with something to say (bad syntax, disposable, no
 * MX, role, a typo suggestion), the first PREVIEW_ISSUE_CAP of them, plus counts.
 */
export async function previewImportHygiene(
	emails: string[],
	opts: MxOptions & { max?: number } = {}
): Promise<{ counts: HygieneCounts & { rows: number; syntax: number }; issues: PreviewIssue[]; more: number }> {
	const { byEmail, unchecked } = await hygieneForEmails(emails, opts);
	const issues: PreviewIssue[] = [];
	let total = 0;
	let syntax = 0;
	emails.forEach((raw, i) => {
		const email = raw.trim().toLowerCase();
		if (!email) return;
		const h = byEmail.get(email)!;
		if (!h.syntax) syntax++;
		const notes = hygieneNotes(h);
		if (!notes.length) return;
		total++;
		if (issues.length < PREVIEW_ISSUE_CAP) {
			issues.push({ row: i + 1, email, notes, suggestion: h.suggestion, invalid: hygieneInvalid(h) });
		}
	});
	return {
		counts: { rows: emails.filter((e) => e.trim()).length, syntax, ...countHygiene(byEmail.values(), unchecked) },
		issues,
		more: total - issues.length
	};
}

/**
 * Accepted fixes from the import form (`fixes` = JSON `{ "<original>": "<fixed>" }`). Only a
 * fix equal to our own suggestion for that address is kept — the form can't rewrite an
 * address to anything else.
 */
export function parseFixes(raw: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (typeof raw !== 'string' || !raw.trim()) return out;
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return out;
	}
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		const from = k.trim().toLowerCase();
		const to = String(v ?? '').trim().toLowerCase();
		if (!isEmail(from) || !isEmail(to)) continue;
		if (checkAddressSync(from).suggestion === to) out.set(from, to);
	}
	return out;
}

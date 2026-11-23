// #105: contact avatar resolution. A cached per-contact avatar — Gravatar → GitHub → a
// domain favicon → an initials tile fallback — resolved server-side so a contact's email
// (or its hash) never has to reach the browser directly. See CLAUDE.md "Avatars (#105)".
import { sha256Hex } from '$lib/server/api-keys';
import { isValidGitHubLogin } from '$lib/server/users';
import { USER_AGENT } from './user-agent';

export type AvatarSource = 'gravatar' | 'github' | 'domain' | 'none';

export type AvatarResult = {
	source: AvatarSource;
	bytes?: ArrayBuffer;
	contentType?: string;
	transient?: boolean; // true = a network/timeout error occurred; caller must NOT persist 'none'
};

const FREEMAIL_EXACT = new Set([
	'gmail.com',
	'googlemail.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'aol.com',
	'proton.me',
	'protonmail.com',
	'mail.com',
	'zoho.com',
	'hey.com',
	'pm.me'
]);

// Wildcard families — e.g. yahoo.com, yahoo.co.uk, yahoo.ca all start with "yahoo.".
const FREEMAIL_PREFIXES = ['yahoo.', 'hotmail.', 'outlook.', 'live.', 'gmx.', 'yandex.', 'fastmail.'];

/** True for freemail providers we skip the domain-favicon step for (own logo isn't the
 *  contact's identity). Exact matches plus dot-prefixed wildcard families. */
export function isFreemailDomain(domain: string): boolean {
	const d = (domain ?? '').trim().toLowerCase();
	if (!d) return false;
	if (FREEMAIL_EXACT.has(d)) return true;
	return FREEMAIL_PREFIXES.some((p) => d.startsWith(p));
}

/** Initials for the fallback tile: name (first+last word) > first/last name > email local-part > '?'. */
export function initials(
	name: string | null | undefined,
	firstName: string | null | undefined,
	lastName: string | null | undefined,
	email: string | null | undefined
): string {
	const n = (name ?? '').trim();
	if (n) {
		const words = n.split(/\s+/).filter(Boolean);
		if (words.length === 1) return words[0].charAt(0).toUpperCase();
		return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
	}
	const first = (firstName ?? '').trim();
	const last = (lastName ?? '').trim();
	if (first || last) {
		return ((first ? first.charAt(0) : '') + (last ? last.charAt(0) : '')).toUpperCase();
	}
	const em = (email ?? '').trim();
	if (em) return em.split('@')[0].charAt(0).toUpperCase();
	return '?';
}

/** Deterministic 0–359 hue from an email, for the initials tile background. Pure/no-entropy. */
export function hueFor(email: string): number {
	const s = (email ?? '').trim().toLowerCase();
	let hash = 0;
	for (let i = 0; i < s.length; i++) {
		hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
	}
	return hash % 360;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Self-contained initials-tile SVG (160x160), used as the fallback avatar. */
export function initialsSvg(letters: string, hue: number): string {
	const safe = escapeXml(letters);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160">
	<rect width="160" height="160" rx="24" fill="hsl(${hue} 55% 45%)" />
	<text x="80" y="80" text-anchor="middle" dominant-baseline="central"
		font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
		font-size="64" font-weight="700" fill="#ffffff">${safe}</text>
</svg>`;
}

/** Gravatar URL from the SHA-256 of the lowercased, trimmed email. `d=404` makes a miss a clean 404. */
export async function gravatarUrl(email: string): Promise<string> {
	const hash = await sha256Hex(email.trim().toLowerCase());
	return `https://gravatar.com/avatar/${hash}?d=404&s=160`;
}

/** Reads a GitHub login out of the contact's custom fields (`github` / `github_login` /
 *  `github_username`, first present wins), tolerating a pasted profile URL or `@handle`. */
export function githubLogin(meta: Record<string, unknown> | null | undefined): string | null {
	if (!meta) return null;
	const raw = [meta.github, meta.github_login, meta.github_username].find(
		(v) => typeof v === 'string' && v.trim() !== ''
	) as string | undefined;
	if (!raw) return null;
	let login = raw.trim();
	login = login.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/+$/, '');
	login = login.replace(/^@/, '');
	if (!login || !isValidGitHubLogin(login)) return null;
	return login;
}

/** A Google favicon lookup for a business domain. */
export function domainLogoUrl(domain: string): string {
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/** Is the cached avatar still good — same email, checked within the last 30 days? */
export function avatarIsFresh(
	row: { avatar_checked_at: string | null; avatar_email: string | null },
	currentEmail: string
): boolean {
	if (!row.avatar_checked_at || !row.avatar_email) return false;
	if (row.avatar_email.trim().toLowerCase() !== currentEmail.trim().toLowerCase()) return false;
	const checked = new Date(row.avatar_checked_at.replace(' ', 'T') + 'Z');
	if (Number.isNaN(checked.getTime())) return false;
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	return Date.now() - checked.getTime() < THIRTY_DAYS_MS;
}

const FETCH_HEADERS = { 'User-Agent': USER_AGENT, Accept: 'image/*' };
const FETCH_TIMEOUT_MS = 4000;
const MIN_DOMAIN_LOGO_BYTES = 500; // Google's generic "unknown domain" globe icon is tiny

function isImageResponse(res: Response): boolean {
	return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/');
}

/**
 * Resolve an avatar for a contact: Gravatar → GitHub (if a login is on file) → a domain
 * favicon (skipped for freemail domains) → 'none' (caller falls back to an initials tile).
 * Any thrown exception (network failure, timeout abort, ...) short-circuits to
 * `{ source: 'none', transient: true }` so a flaky moment is never persisted as a definitive
 * negative — only a clean non-match at every step is.
 */
export async function resolveAvatar(
	email: string,
	meta: Record<string, unknown> | null,
	fetchImpl: typeof fetch = fetch
): Promise<AvatarResult> {
	try {
		const gUrl = await gravatarUrl(email);
		const gRes = await fetchImpl(gUrl, {
			headers: FETCH_HEADERS,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (isImageResponse(gRes)) {
			return {
				source: 'gravatar',
				bytes: await gRes.arrayBuffer(),
				contentType: gRes.headers.get('content-type') ?? undefined
			};
		}

		const login = githubLogin(meta);
		if (login) {
			const ghRes = await fetchImpl(`https://github.com/${login}.png?size=160`, {
				headers: FETCH_HEADERS,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (isImageResponse(ghRes)) {
				return {
					source: 'github',
					bytes: await ghRes.arrayBuffer(),
					contentType: ghRes.headers.get('content-type') ?? undefined
				};
			}
		}

		const domain = email.split('@')[1]?.trim().toLowerCase();
		if (domain && !isFreemailDomain(domain)) {
			const dRes = await fetchImpl(domainLogoUrl(domain), {
				headers: FETCH_HEADERS,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (isImageResponse(dRes)) {
				const bytes = await dRes.arrayBuffer();
				if (bytes.byteLength > MIN_DOMAIN_LOGO_BYTES) {
					return { source: 'domain', bytes, contentType: dRes.headers.get('content-type') ?? undefined };
				}
			}
		}

		return { source: 'none' };
	} catch {
		return { source: 'none', transient: true };
	}
}

/**
 * Domain authentication panel (#304). For every domain the app sends as, checks live:
 *   - DMARC: exactly one `v=DMARC1` TXT at `_dmarc.<domain>` (two of them broke sends in #286)
 *   - SPF: exactly one `v=spf1`, DNS-lookup count (limit 10), the closing `all` qualifier
 *   - DKIM: Postmark's selector + status (Domains API, needs an account token) and whether
 *     DNS still serves that key; `google._domainkey` as an informational Workspace check
 *   - Return-Path: the CNAME to `pm.mtasv.net`
 * DNS goes through Cloudflare DoH (`dohQuery` in spam.ts). A failed lookup is `unknown`,
 * never `fail`, so a flaky resolver can't raise an alert.
 *
 * Results live in `app_state.domain_auth` (JSON `DomainAuthResult`). Each run compares
 * against the previous one: a check that goes pass → fail is added to
 * `app_state.domain_auth_alert` (the red banner on the Dashboard + Deliverability) and
 * appended to `app_state.domain_auth_events` (the activity feed reads it) — once; a check
 * that keeps failing raises nothing new, and one that stops failing drops off the banner.
 * The heartbeat runs it at most once per 24 h (`app_state.domain_auth_cron_at`).
 * #363: each stored result also keeps `prev` (the run before's raw status per check), so the
 * panel can mark "was Fail → now Pass" (`statusChanges`).
 * #373: the same run reads the broadcast stream's unsubscribe handling
 * (`GET /message-streams/{POSTMARK_STREAM}`, server token) into `result.stream`: Custom =
 * pass, Postmark = warn (pass → warn raises the banner, like pass → fail for DNS), an error =
 * unknown. `switchToCustomUnsubscribe` PATCHes it to Custom (never the transactional stream).
 */

import { dohQuery } from './spam';
import { getSettings } from './settings';
import { resolveMailCredentials } from './mail/config';
import { casAppState } from './app-state-claim';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type CheckKey = 'dmarc' | 'spf' | 'dkim' | 'google_dkim' | 'return_path' | 'unsubscribe_handling';

/** #363: the one place the account-token hint is shown (the DKIM row's fix). */
export const POSTMARK_TOKEN_FIX =
	'Reading DKIM from Postmark needs an account API token: copy one from Postmark → Account → API Tokens, then set it as POSTMARK_ACCOUNT_TOKEN with: npx wrangler secret put POSTMARK_ACCOUNT_TOKEN';

export type DnsRecord = { type: 'TXT' | 'CNAME'; host: string; value: string };

export type AuthCheck = {
	key: CheckKey;
	label: string;
	status: CheckStatus;
	summary: string; // what we found
	fix?: string; // plain-English next step (warn / fail / unknown)
	record?: DnsRecord; // the exact record to add, when known
	found?: string[]; // the raw record(s) found
	informational?: boolean;
	lastKnown?: CheckStatus; // on an `unknown` check: the last pass/warn/fail seen, so a DNS blip can't hide a pass → fail
};

export type PostmarkDomain = {
	id: number;
	name: string;
	dkimVerified: boolean;
	dkimHost: string | null;
	dkimValue: string | null;
	dkimPendingHost: string | null;
	dkimPendingValue: string | null;
	dkimUpdateStatus: string | null;
	returnPathDomain: string | null;
	returnPathVerified: boolean;
	returnPathCname: string | null;
};

export type DomainReport = { domain: string; checks: AuthCheck[]; postmark: PostmarkDomain | null };
/** #373: the broadcast stream's unsubscribe handling. */
export type StreamReport = { stream: string; check: AuthCheck };

export type DomainAuthResult = {
	at: string; // ISO
	trigger: 'manual' | 'cron';
	postmarkError: string | null;
	domains: DomainReport[];
	stream?: StreamReport | null; // #373 (absent on results stored before it)
	prev?: PrevStatuses | null; // #363: the run before this one (statuses only, never nested further)
};

/** #363: one run's raw status per check, keyed by `changeKey(domain, key)`. */
export type PrevStatuses = { at: string; statuses: Record<string, CheckStatus> };
export type StatusChange = { was: CheckStatus; now: CheckStatus };

export type AlertItem = { domain: string; key: CheckKey; label: string; summary: string; since: string };
export type DomainAuthAlert = { items: AlertItem[] };
export type DomainAuthEvent = { at: string; domain: string; key: CheckKey; text: string };

export const LABELS: Record<CheckKey, string> = {
	dmarc: 'DMARC',
	spf: 'SPF',
	dkim: 'DKIM (Postmark)',
	google_dkim: 'DKIM (Google)',
	return_path: 'Return-Path',
	unsubscribe_handling: 'Broadcast unsubscribe handling'
};

const RESULT_KEY = 'domain_auth';
const ALERT_KEY = 'domain_auth_alert';
const EVENTS_KEY = 'domain_auth_events';
const CRON_KEY = 'domain_auth_cron_at';
const MAX_EVENTS = 50;
const MAX_DOMAINS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PM_API = 'https://api.postmarkapp.com';
const PM_TIMEOUT_MS = 15_000; // #536: never hang on a Postmark call
const RETURN_PATH_TARGET = 'pm.mtasv.net';
export const SPF_LOOKUP_LIMIT = 10;
export const SPF_LOOKUP_WARN = 8;

// ---------------------------------------------------------------------------------------
// Pure parsing

/** A DoH TXT `data` string → its text: quoted chunks joined (`"a" "b"` → `ab`). */
export function txtValue(data: string): string {
	const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
	return parts.length ? parts.join('') : data.trim();
}

function stripDot(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '');
}

/** Tags of a `k=v; k=v` record, keys lowercased. */
export function parseTags(record: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of record.split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		const k = part.slice(0, i).trim().toLowerCase();
		if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
	}
	return out;
}

export function isDmarcRecord(txt: string): boolean {
	return /^v\s*=\s*DMARC1\s*(;|$)/i.test(txt.trim());
}

export function isSpfRecord(txt: string): boolean {
	return /^v=spf1(\s|$)/i.test(txt.trim());
}

/** DMARC from every TXT string at `_dmarc.<domain>`. */
export function checkDmarc(domain: string, txts: string[]): AuthCheck {
	const records = txts.filter(isDmarcRecord);
	const base = { key: 'dmarc' as const, label: LABELS.dmarc, found: records };
	const suggested: DnsRecord = { type: 'TXT', host: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}` };
	if (records.length === 0) {
		return {
			...base,
			status: 'fail',
			summary: 'No DMARC record.',
			fix: 'Add one DMARC TXT record. Start with p=none to monitor, then tighten to quarantine.',
			record: suggested
		};
	}
	if (records.length > 1) {
		return {
			...base,
			status: 'fail',
			summary: `${records.length} DMARC records. Receivers treat that as an error and may reject mail (554 5.7.5).`,
			fix: `Delete all but one TXT record at _dmarc.${domain}.`
		};
	}
	const tags = parseTags(records[0]);
	const p = (tags.p ?? '').toLowerCase();
	const pct = tags.pct ?? '100';
	const parts = [`p=${p || '(missing)'}`, `pct=${pct}`, tags.rua ? `rua=${tags.rua}` : 'no rua'];
	const summary = `Policy ${parts.join(' · ')}.`;
	if (!['none', 'quarantine', 'reject'].includes(p)) {
		return { ...base, status: 'fail', summary, fix: 'The record needs a valid p= tag (none, quarantine or reject).' };
	}
	if (p === 'none') {
		return { ...base, status: 'warn', summary, fix: 'p=none only monitors. Move to p=quarantine once reports look clean.' };
	}
	return { ...base, status: 'pass', summary };
}

/** The SPF terms after `v=spf1`. */
function spfTerms(record: string): string[] {
	return record.trim().split(/\s+/).slice(1).filter(Boolean);
}

/**
 * The lookups one SPF record costs by itself (include, a, mx, ptr, exists, redirect=),
 * plus the domains to recurse into (include targets and redirect).
 */
export function spfDirectLookups(record: string): { lookups: number; nested: string[] } {
	let lookups = 0;
	const nested: string[] = [];
	for (const raw of spfTerms(record)) {
		const t = raw.replace(/^[+\-~?]/, '').toLowerCase();
		const include = /^include:(.+)$/.exec(t);
		const redirect = /^redirect=(.+)$/.exec(t);
		if (include) {
			lookups++;
			nested.push(include[1]);
		} else if (redirect) {
			lookups++;
			nested.push(redirect[1]);
		} else if (/^(a|mx|ptr)([:/]|$)/.test(t) || /^exists:/.test(t)) {
			lookups++;
		}
	}
	return { lookups, nested };
}

/** The closing `all` term (with its qualifier), or null; `redirect` = a redirect= modifier. */
export function spfAll(record: string): { qualifier: '+' | '-' | '~' | '?' | null; redirect: boolean } {
	const terms = spfTerms(record).map((t) => t.toLowerCase());
	const redirect = terms.some((t) => t.startsWith('redirect='));
	const all = terms.find((t) => /^[+\-~?]?all$/.test(t));
	if (!all) return { qualifier: null, redirect };
	const q = all[0] === 'a' ? '+' : (all[0] as '+' | '-' | '~' | '?');
	return { qualifier: q, redirect };
}

type TxtResolver = (name: string) => Promise<string[] | null>;

/**
 * Total DNS lookups an SPF record costs, following include/redirect. Stops once past the
 * limit. `errors`: nested domains with no (or several) SPF records; `unknown`: a nested
 * lookup failed, so the count may be low.
 */
export async function countSpfLookups(
	record: string,
	resolveTxt: TxtResolver,
	state: { count: number; errors: string[]; unknown: boolean; seen: Set<string> } = { count: 0, errors: [], unknown: false, seen: new Set() },
	depth = 0
): Promise<{ count: number; errors: string[]; unknown: boolean }> {
	const { lookups, nested } = spfDirectLookups(record);
	state.count += lookups;
	for (const name of nested) {
		if (state.count > SPF_LOOKUP_LIMIT || depth >= 10) break;
		const n = stripDot(name);
		if (state.seen.has(n)) continue; // a loop is its own permerror; don't spin
		state.seen.add(n);
		const txts = await resolveTxt(n);
		if (txts === null) {
			state.unknown = true;
			continue;
		}
		const spf = txts.filter(isSpfRecord);
		if (spf.length !== 1) {
			state.errors.push(`${n} has ${spf.length === 0 ? 'no' : spf.length} SPF record${spf.length === 1 ? '' : 's'}`);
			continue;
		}
		await countSpfLookups(spf[0], resolveTxt, state, depth + 1);
	}
	return { count: state.count, errors: state.errors, unknown: state.unknown };
}

/** SPF from every TXT string at `<domain>`. */
export async function checkSpf(domain: string, txts: string[], resolveTxt: TxtResolver): Promise<AuthCheck> {
	const records = txts.filter(isSpfRecord);
	const base = { key: 'spf' as const, label: LABELS.spf, found: records };
	if (records.length === 0) {
		return {
			...base,
			status: 'fail',
			summary: 'No SPF record.',
			fix: 'Add one SPF TXT record that lists every service sending as this domain.',
			record: { type: 'TXT', host: domain, value: 'v=spf1 include:spf.mtasv.net ~all' }
		};
	}
	if (records.length > 1) {
		return {
			...base,
			status: 'fail',
			summary: `${records.length} SPF records. SPF fails outright (permerror) when there is more than one.`,
			fix: 'Merge them into a single v=spf1 record.'
		};
	}
	const { count, errors, unknown } = await countSpfLookups(records[0], resolveTxt);
	const { qualifier, redirect } = spfAll(records[0]);
	const lookupText = `${count > SPF_LOOKUP_LIMIT ? `over ${SPF_LOOKUP_LIMIT}` : count}${unknown ? '+' : ''} DNS lookup${count === 1 ? '' : 's'} of ${SPF_LOOKUP_LIMIT}`;
	const endText = qualifier ? `ends in ${qualifier === '+' ? '+all' : `${qualifier}all`}` : redirect ? 'uses redirect=' : 'no all';
	const summary = `One record · ${lookupText} · ${endText}.`;
	if (count > SPF_LOOKUP_LIMIT) {
		return { ...base, status: 'fail', summary, fix: 'More than 10 lookups makes SPF fail. Remove includes you no longer use.' };
	}
	if (errors.length) {
		return { ...base, status: 'fail', summary: `${summary} ${errors.join('; ')}.`, fix: 'Fix or remove the broken include.' };
	}
	const fixes: string[] = [];
	if (count >= SPF_LOOKUP_WARN) fixes.push(`${count} of 10 lookups used. Adding one more service may break SPF.`);
	if (!redirect && qualifier !== '-' && qualifier !== '~') fixes.push('End the record with ~all (or -all) so other senders fail.');
	if (unknown) fixes.push('A nested lookup failed, so the count may be low. Re-check later.');
	if (fixes.length) return { ...base, status: 'warn', summary, fix: fixes.join(' ') };
	return { ...base, status: 'pass', summary };
}

/** The selector of a DKIM host (`20230101pm._domainkey.x.com` → `20230101pm`). */
export function dkimSelector(host: string | null): string | null {
	if (!host) return null;
	const i = host.toLowerCase().indexOf('._domainkey');
	return i > 0 ? host.slice(0, i) : null;
}

function hasDkimKey(txts: string[]): boolean {
	return txts.some((t) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(t));
}

/**
 * Postmark's DKIM, confirmed against DNS. `dnsTxts` = the TXT strings at the Postmark DKIM
 * host (null = lookup failed or no host known).
 */
export function checkPostmarkDkim(pm: PostmarkDomain | null, postmarkError: string | null, dnsTxts: string[] | null): AuthCheck {
	const base = { key: 'dkim' as const, label: LABELS.dkim };
	if (!pm) {
		if (postmarkError) {
			return { ...base, status: 'unknown', summary: `Couldn't read Postmark: ${postmarkError}`, fix: POSTMARK_TOKEN_FIX };
		}
		return { ...base, status: 'warn', summary: 'This domain is not set up in Postmark.', fix: 'Add it in Postmark → Sender signatures → Domains, then publish the DKIM and Return-Path records Postmark shows.' };
	}
	const selector = dkimSelector(pm.dkimHost) ?? dkimSelector(pm.dkimPendingHost);
	const pending: DnsRecord | undefined =
		pm.dkimPendingHost && pm.dkimPendingValue ? { type: 'TXT', host: pm.dkimPendingHost, value: pm.dkimPendingValue } : undefined;
	const current: DnsRecord | undefined = pm.dkimHost && pm.dkimValue ? { type: 'TXT', host: pm.dkimHost, value: pm.dkimValue } : undefined;
	if (!pm.dkimVerified) {
		return {
			...base,
			status: 'fail',
			summary: `Postmark has not verified DKIM${selector ? ` (selector ${selector})` : ''}.`,
			fix: 'Add this TXT record, then click Verify on the domain in Postmark.',
			record: pending ?? current
		};
	}
	if (pm.dkimHost && dnsTxts !== null && !hasDkimKey(dnsTxts)) {
		return {
			...base,
			status: 'fail',
			summary: `Postmark verified selector ${selector ?? pm.dkimHost}, but DNS no longer serves the key.`,
			fix: 'Put the DKIM TXT record back.',
			record: current
		};
	}
	if (pending) {
		return {
			...base,
			status: 'warn',
			summary: `Verified (selector ${selector}). A new key is waiting${pm.dkimUpdateStatus ? ` (${pm.dkimUpdateStatus})` : ''}.`,
			fix: 'Add the new TXT record so Postmark can rotate the key.',
			record: pending
		};
	}
	return { ...base, status: 'pass', summary: `Verified in Postmark · selector ${selector ?? '?'}.` };
}

export function checkGoogleDkim(domain: string, txts: string[] | null): AuthCheck {
	const base = { key: 'google_dkim' as const, label: LABELS.google_dkim, informational: true };
	if (txts === null) return { ...base, status: 'unknown', summary: 'DNS lookup failed.', fix: 'Re-check later.' };
	if (hasDkimKey(txts)) return { ...base, status: 'pass', summary: `google._domainkey.${domain} is published.` };
	return {
		...base,
		status: 'warn',
		summary: `No key at google._domainkey.${domain}. Informational: only matters for mail sent from Google Workspace.`,
		fix: 'In the Google Admin console → Apps → Google Workspace → Gmail → Authenticate email, generate a key, publish the TXT record and click Start authentication.'
	};
}

/** `cname` = the CNAME target(s) at the Return-Path host (null = lookup failed). */
export function checkReturnPath(domain: string, pm: PostmarkDomain | null, cname: string[] | null): AuthCheck {
	const base = { key: 'return_path' as const, label: LABELS.return_path };
	const fromPostmark = !!pm?.returnPathDomain;
	const host = stripDot(pm?.returnPathDomain || `pm-bounces.${domain}`);
	const target = stripDot(pm?.returnPathCname || RETURN_PATH_TARGET);
	const record: DnsRecord = { type: 'CNAME', host, value: target };
	if (cname === null) return { ...base, status: 'unknown', summary: `DNS lookup for ${host} failed.`, fix: 'Re-check later.', record };
	const found = cname.map(stripDot);
	if (found.includes(target)) {
		if (pm && !pm.returnPathVerified) {
			return { ...base, status: 'warn', summary: `${host} → ${target} is in DNS, but Postmark hasn't verified it.`, fix: 'Click Verify next to Return-Path on the domain in Postmark.', found };
		}
		return { ...base, status: 'pass', summary: `${host} → ${target}.`, found };
	}
	const summary = found.length ? `${host} points to ${found.join(', ')}, not ${target}.` : `No CNAME at ${host}.`;
	return {
		...base,
		// Without a Return-Path set in Postmark, `pm-bounces` is only our guess at the host.
		status: fromPostmark ? 'fail' : 'warn',
		summary,
		fix: fromPostmark
			? 'Add this CNAME so bounces are handled under your domain (needed for DMARC alignment).'
			: 'Add this CNAME and set it as the custom Return-Path for the domain in Postmark.',
		record,
		found
	};
}

// ---------------------------------------------------------------------------------------
// Postmark Domains API

type PmListResponse = { Domains?: { ID: number; Name: string }[] };
type PmDomainDetail = {
	ID: number;
	Name: string;
	DKIMVerified?: boolean;
	DKIMHost?: string;
	DKIMTextValue?: string;
	DKIMPendingHost?: string;
	DKIMPendingTextValue?: string;
	DKIMUpdateStatus?: string;
	ReturnPathDomain?: string;
	ReturnPathDomainVerified?: boolean;
	ReturnPathDomainCNAMEValue?: string;
};

export function mapPostmarkDomain(d: PmDomainDetail): PostmarkDomain {
	const s = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
	return {
		id: d.ID,
		name: d.Name.toLowerCase(),
		dkimVerified: d.DKIMVerified === true,
		dkimHost: s(d.DKIMHost),
		dkimValue: s(d.DKIMTextValue),
		dkimPendingHost: s(d.DKIMPendingHost),
		dkimPendingValue: s(d.DKIMPendingTextValue),
		dkimUpdateStatus: s(d.DKIMUpdateStatus),
		returnPathDomain: s(d.ReturnPathDomain),
		returnPathVerified: d.ReturnPathDomainVerified === true,
		returnPathCname: s(d.ReturnPathDomainCNAMEValue)
	};
}

async function pmGet(token: string, path: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
	try {
		const res = await fetch(`${PM_API}${path}`, { headers: { Accept: 'application/json', 'X-Postmark-Account-Token': token }, signal: AbortSignal.timeout(PM_TIMEOUT_MS) });
		if (res.status === 401 || res.status === 403) return { ok: false, error: 'Postmark rejected the token (reading domains needs an account API token)' };
		if (!res.ok) return { ok: false, error: `Postmark error ${res.status}` };
		return { ok: true, body: await res.json() };
	} catch (e) {
		return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
	}
}

/** Postmark's record for each wanted domain (missing = not set up there). Never throws. */
export async function fetchPostmarkDomains(
	token: string | undefined,
	names: string[]
): Promise<{ domains: Map<string, PostmarkDomain>; error: string | null }> {
	const domains = new Map<string, PostmarkDomain>();
	if (!token) return { domains, error: 'POSTMARK_ACCOUNT_TOKEN is not set' };
	const list = await pmGet(token, '/domains?count=500&offset=0');
	if (!list.ok) return { domains, error: list.error };
	const wanted = new Set(names.map((n) => n.toLowerCase()));
	for (const d of (list.body as PmListResponse).Domains ?? []) {
		if (!d?.Name || !wanted.has(d.Name.toLowerCase())) continue;
		const detail = await pmGet(token, `/domains/${encodeURIComponent(String(d.ID))}`);
		if (!detail.ok) return { domains, error: detail.error };
		const m = mapPostmarkDomain(detail.body as PmDomainDetail);
		domains.set(m.name, m);
	}
	return { domains, error: null };
}

// ---------------------------------------------------------------------------------------
// #373: the broadcast stream's unsubscribe handling

export const UNSUB_HANDLING_FIX =
	'Postmark is still adding its own unsubscribe link. Switch it to custom in Postmark → Servers → <server> → broadcast stream → Settings → Unsubscribe handling.';

export type StreamRead = { ok: true; body: unknown } | { ok: false; error: string };

/** The check from a `GET /message-streams/{stream}` answer. */
export function checkUnsubscribeHandling(stream: string, read: StreamRead): AuthCheck {
	const base = { key: 'unsubscribe_handling' as const, label: LABELS.unsubscribe_handling };
	if (!read.ok) return { ...base, status: 'unknown', summary: `Couldn't read the ${stream} stream from Postmark: ${read.error}.`, fix: 'Re-check later.' };
	const cfg = (read.body as { SubscriptionManagementConfiguration?: { UnsubscribeHandlingType?: unknown } } | null)?.SubscriptionManagementConfiguration;
	const type = typeof cfg?.UnsubscribeHandlingType === 'string' ? cfg.UnsubscribeHandlingType : null;
	if (type === 'Custom') {
		return { ...base, status: 'pass', summary: `Custom on the ${stream} stream: the app's link and List-Unsubscribe headers are the only unsubscribe path.` };
	}
	if (type === 'Postmark') {
		return { ...base, status: 'warn', summary: `Postmark manages unsubscribes on the ${stream} stream.`, fix: UNSUB_HANDLING_FIX };
	}
	return { ...base, status: 'unknown', summary: `Postmark didn't say how the ${stream} stream handles unsubscribes.`, fix: 'Re-check later.' };
}

/** `GET /message-streams/{stream}` with the server token. Never throws. */
export async function fetchStreamConfig(token: string | undefined, stream: string): Promise<StreamRead> {
	if (!token) return { ok: false, error: 'no Postmark token set' };
	try {
		const res = await fetch(`${PM_API}/message-streams/${encodeURIComponent(stream)}`, {
			headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token },
			signal: AbortSignal.timeout(PM_TIMEOUT_MS)
		});
		if (res.status === 401 || res.status === 403) return { ok: false, error: 'Postmark rejected the server token' };
		if (!res.ok) return { ok: false, error: `Postmark error ${res.status}` };
		return { ok: true, body: await res.json() };
	} catch (e) {
		return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
	}
}

/** The broadcast stream, and whether it is (also) the transactional one — never touched. */
function broadcastStream(env: DomainAuthEnv): { stream: string; transactional: boolean } {
	const stream = (env.POSTMARK_STREAM || '').trim() || 'broadcast';
	const tx = (env.POSTMARK_STREAM_TX || '').trim() || 'outbound';
	return { stream, transactional: stream === tx || stream === 'outbound' };
}

/**
 * #700: `env` with the Postmark server token and stream names the sending path uses
 * (Settings → Sending, else the env), so a token saved only in Settings works here too. An
 * env-only install gets its own values back. A stored token that can't be read leaves the
 * token empty and sets `POSTMARK_TOKEN_ERROR` (no env fallback).
 */
export async function withSendingCreds<E extends DomainAuthEnv>(db: D1Database, env: E): Promise<E> {
	const pm = (await resolveMailCredentials(db, env)).postmark;
	return {
		...env,
		POSTMARK_TOKEN: pm.token,
		POSTMARK_STREAM: pm.stream,
		POSTMARK_STREAM_TX: pm.txStream,
		POSTMARK_TOKEN_ERROR: pm.tokenError ?? undefined
	};
}

export async function checkStream(env: DomainAuthEnv): Promise<StreamReport> {
	const { stream, transactional } = broadcastStream(env);
	const token = (env.POSTMARK_TOKEN || '').trim();
	const read: StreamRead = transactional
		? { ok: false, error: 'POSTMARK_STREAM is the transactional stream' }
		: !token && env.POSTMARK_TOKEN_ERROR
			? { ok: false, error: env.POSTMARK_TOKEN_ERROR }
			: await fetchStreamConfig(token || undefined, stream);
	return { stream, check: checkUnsubscribeHandling(stream, read) };
}

export const CUSTOM_UNSUB_BODY = { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } } as const;

/**
 * "Switch to custom": `PATCH /message-streams/{POSTMARK_STREAM}` with `CUSTOM_UNSUB_BODY`.
 * Refuses the transactional stream (`POSTMARK_STREAM_TX`, default `outbound`). Callers gate
 * it to admins and pass `withSendingCreds(db, env)` (#700). Never throws.
 */
export async function switchToCustomUnsubscribe(env: DomainAuthEnv): Promise<{ ok: true; stream: string } | { ok: false; error: string }> {
	const { stream, transactional } = broadcastStream(env);
	if (transactional) return { ok: false, error: `${stream} is the transactional stream; only the broadcast stream is switched.` };
	const token = (env.POSTMARK_TOKEN || '').trim();
	if (!token) return { ok: false, error: env.POSTMARK_TOKEN_ERROR || 'No Postmark server token set.' };
	try {
		const res = await fetch(`${PM_API}/message-streams/${encodeURIComponent(stream)}`, {
			method: 'PATCH',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
			body: JSON.stringify(CUSTOM_UNSUB_BODY),
			signal: AbortSignal.timeout(PM_TIMEOUT_MS)
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { Message?: string } | null;
			return { ok: false, error: `Postmark error ${res.status}${body?.Message ? `: ${String(body.Message).slice(0, 160)}` : ''}` };
		}
		return { ok: true, stream };
	} catch (e) {
		return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
	}
}

// ---------------------------------------------------------------------------------------
// Running the checks

async function resolveTxt(name: string): Promise<string[] | null> {
	const a = await dohQuery(name, 'TXT');
	return a === null ? null : a.filter((r) => r.type === 16).map((r) => txtValue(r.data));
}

async function resolveCname(name: string): Promise<string[] | null> {
	const a = await dohQuery(name, 'CNAME');
	return a === null ? null : a.filter((r) => r.type === 5).map((r) => r.data);
}

/** The domain part of `Name <a@example.com>` / `a@example.com` / a bare `example.com`. */
export function domainOf(value: string | null | undefined): string | null {
	const v = (value ?? '').trim().toLowerCase();
	if (!v) return null;
	const m = /@([a-z0-9.-]+\.[a-z]{2,})>?\s*$/.exec(v);
	if (m) return m[1];
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/**
 * The domains the app sends as: POSTMARK_FROM, Settings Default From and approved senders,
 * REVIEW_FROM, and the From of campaigns in the last 90 days. At most 5.
 */
export async function senderDomains(db: D1Database, env: { POSTMARK_FROM?: string; REVIEW_FROM?: string }): Promise<string[]> {
	const out = new Set<string>();
	const add = (v: string | null | undefined) => {
		const d = domainOf(v);
		if (d) out.add(d);
	};
	add(env.POSTMARK_FROM);
	try {
		const s = await getSettings(db);
		add(s.default_from);
		for (const part of (s.approved_senders ?? '').split(',')) add(part);
	} catch {
		// settings unreadable → env + campaigns only
	}
	add(env.REVIEW_FROM);
	try {
		const rows = await db
			.prepare(
				`SELECT DISTINCT from_email FROM campaigns
				 WHERE from_email IS NOT NULL AND from_email != '' AND COALESCE(sent_at, created_at) >= datetime('now', '-90 days')
				 LIMIT 50`
			)
			.all<{ from_email: string }>();
		for (const r of rows.results) add(r.from_email);
	} catch {
		// no campaigns yet
	}
	return [...out].slice(0, MAX_DOMAINS);
}

export async function checkDomain(domain: string, pm: PostmarkDomain | null, postmarkError: string | null): Promise<DomainReport> {
	const [dmarcTxt, rootTxt, googleTxt, dkimTxt, rpCname] = await Promise.all([
		resolveTxt(`_dmarc.${domain}`),
		resolveTxt(domain),
		resolveTxt(`google._domainkey.${domain}`),
		pm?.dkimHost ? resolveTxt(pm.dkimHost) : Promise.resolve(null),
		resolveCname(stripDot(pm?.returnPathDomain || `pm-bounces.${domain}`))
	]);
	const unknown = (key: CheckKey): AuthCheck => ({ key, label: LABELS[key], status: 'unknown', summary: 'DNS lookup failed.', fix: 'Re-check later.' });
	const checks: AuthCheck[] = [
		dmarcTxt === null ? unknown('dmarc') : checkDmarc(domain, dmarcTxt),
		rootTxt === null ? unknown('spf') : await checkSpf(domain, rootTxt, resolveTxt),
		checkPostmarkDkim(pm, postmarkError, dkimTxt),
		checkReturnPath(domain, pm, rpCname),
		checkGoogleDkim(domain, googleTxt)
	];
	return { domain, checks, postmark: pm };
}

export type DomainAuthEnv = {
	POSTMARK_TOKEN?: string;
	POSTMARK_ACCOUNT_TOKEN?: string;
	POSTMARK_FROM?: string;
	REVIEW_FROM?: string;
	POSTMARK_STREAM?: string;
	POSTMARK_STREAM_TX?: string;
	/** #700: opens the token saved in Settings → Sending (`withSendingCreds`). */
	MAIL_TOKEN_KEY?: string;
	/** #700: set by `withSendingCreds` when the token saved in Settings → Sending can't be read. */
	POSTMARK_TOKEN_ERROR?: string;
};

/**
 * The token for the Domains API: the account token only. #605: the server token is refused
 * there, so without POSTMARK_ACCOUNT_TOKEN no Domains request is made and the DKIM row says
 * what to set.
 */
function postmarkDomainsToken(env: DomainAuthEnv): string | undefined {
	return (env.POSTMARK_ACCOUNT_TOKEN || '').trim() || undefined;
}

async function getJson<T>(db: D1Database, key: string): Promise<T | null> {
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string | null }>();
		return row?.value ? (JSON.parse(row.value) as T) : null;
	} catch {
		return null;
	}
}

async function putState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

/** ISO → SQLite UTC 'YYYY-MM-DD HH:MM:SS' (the activity feed's `at`). */
function sqlTime(iso: string): string {
	return iso.slice(0, 19).replace('T', ' ');
}

export function bannerText(item: Pick<AlertItem, 'domain' | 'key'>): string {
	if (item.key === 'unsubscribe_handling') return `Postmark is adding its own unsubscribe link on the ${item.domain} stream`;
	return `${LABELS[item.key]} broken on ${item.domain}: mail may bounce`;
}

/** Every check of a result with what it belongs to: a domain, or (#373) the stream name. */
export function resultChecks(result: DomainAuthResult | null): { domain: string; check: AuthCheck }[] {
	const out: { domain: string; check: AuthCheck }[] = [];
	for (const d of result?.domains ?? []) for (const c of d.checks) out.push({ domain: d.domain, check: c });
	if (result?.stream?.check) out.push({ domain: result.stream.stream, check: result.stream.check });
	return out;
}

/** A status that belongs on the banner: fail, or (#373) Postmark-managed unsubscribes. */
function alerting(c: AuthCheck): boolean {
	return c.status === 'fail' || (c.key === 'unsubscribe_handling' && c.status === 'warn');
}

/**
 * Compare a new result with the previous one. pass → fail (#373: pass → warn for the
 * unsubscribe handling) raises an alert item + an event;
 * a check still failing keeps its item (no new event); a check no longer failing (or a
 * domain no longer checked) drops off. `unknown` keeps whatever was there.
 */
export function applyTransitions(
	prev: DomainAuthResult | null,
	next: DomainAuthResult,
	alert: DomainAuthAlert | null
): { alert: DomainAuthAlert; raised: DomainAuthEvent[] } {
	const prevStatus = new Map<string, CheckStatus>();
	for (const { domain, check: c } of resultChecks(prev)) {
		prevStatus.set(`${domain}\n${c.key}`, c.status === 'unknown' ? (c.lastKnown ?? 'unknown') : c.status);
	}
	for (const { domain, check: c } of resultChecks(next)) {
		const was = prevStatus.get(`${domain}\n${c.key}`);
		if (c.status === 'unknown' && was && was !== 'unknown') c.lastKnown = was;
	}
	const nextChecks = new Map<string, { domain: string; check: AuthCheck }>();
	for (const e of resultChecks(next)) nextChecks.set(`${e.domain}\n${e.check.key}`, e);

	const items: AlertItem[] = [];
	for (const item of alert?.items ?? []) {
		const n = nextChecks.get(`${item.domain}\n${item.key}`);
		if (n && (alerting(n.check) || n.check.status === 'unknown')) items.push(item);
	}
	const raised: DomainAuthEvent[] = [];
	for (const [k, { domain, check }] of nextChecks) {
		if (!alerting(check) || prevStatus.get(k) !== 'pass') continue;
		if (items.some((i) => i.domain === domain && i.key === check.key)) continue;
		items.push({ domain, key: check.key, label: check.label, summary: check.summary, since: next.at });
		raised.push({ at: sqlTime(next.at), domain, key: check.key, text: `${bannerText({ domain, key: check.key })}. ${check.summary}` });
	}
	return { alert: { items }, raised };
}

/** Run every check, store the result, raise/clear alerts. Never throws on a lookup failure. */
export async function runDomainAuthCheck(
	db: D1Database,
	env: DomainAuthEnv,
	trigger: 'manual' | 'cron',
	now = new Date()
): Promise<{ result: DomainAuthResult; raised: DomainAuthEvent[] }> {
	const names = await senderDomains(db, env);
	const { domains: pm, error } = names.length ? await fetchPostmarkDomains(postmarkDomainsToken(env), names) : { domains: new Map(), error: null };
	const reports: DomainReport[] = [];
	for (const name of names) reports.push(await checkDomain(name, pm.get(name) ?? null, error));
	const stream = await checkStream(await withSendingCreds(db, env));
	const result: DomainAuthResult = { at: now.toISOString(), trigger, postmarkError: error, domains: reports, stream };
	const raised = await recordResult(db, result);
	return { result, raised };
}

/** #363: the key of one check in `PrevStatuses.statuses` / `statusChanges`. */
export function changeKey(domain: string, key: CheckKey): string {
	return `${domain}/${key}`;
}

/** #363: a result's raw status per check (what the next run compares against). */
export function statusSnapshot(result: DomainAuthResult): PrevStatuses {
	const statuses: Record<string, CheckStatus> = {};
	for (const { domain, check: c } of resultChecks(result)) statuses[changeKey(domain, c.key)] = c.status;
	return { at: result.at, statuses };
}

/**
 * #363: checks whose status differs from the run before (raw statuses, so unknown → pass
 * counts). A check the previous run didn't have, or no previous run, is not a change.
 */
export function statusChanges(result: DomainAuthResult | null): Record<string, StatusChange> {
	const out: Record<string, StatusChange> = {};
	const prev = result?.prev?.statuses;
	if (!result || !prev) return out;
	for (const { domain, check: c } of resultChecks(result)) {
		const k = changeKey(domain, c.key);
		const was = prev[k];
		if (was && was !== c.status) out[k] = { was, now: c.status };
	}
	return out;
}

/**
 * #363: the Re-check confirmation's counts. A domain passes when every check that isn't
 * informational passes; anything else needs attention.
 */
export function checkSummary(result: DomainAuthResult): { domains: number; passing: number; attention: number } {
	const passing = result.domains.filter((d) => d.checks.every((c) => c.informational || c.status === 'pass')).length;
	return { domains: result.domains.length, passing, attention: result.domains.length - passing };
}

/** Store a result and apply its transitions against the stored previous one. */
export async function recordResult(db: D1Database, result: DomainAuthResult): Promise<DomainAuthEvent[]> {
	const [prev, alert] = await Promise.all([getJson<DomainAuthResult>(db, RESULT_KEY), getJson<DomainAuthAlert>(db, ALERT_KEY)]);
	const { alert: nextAlert, raised } = applyTransitions(prev, result, alert);
	result.prev = prev && typeof prev.at === 'string' && Array.isArray(prev.domains) ? statusSnapshot(prev) : null;
	await putState(db, RESULT_KEY, JSON.stringify(result));
	await putState(db, ALERT_KEY, JSON.stringify(nextAlert));
	if (raised.length) {
		const events = (await getJson<DomainAuthEvent[]>(db, EVENTS_KEY)) ?? [];
		await putState(db, EVENTS_KEY, JSON.stringify([...(Array.isArray(events) ? events : []), ...raised].slice(-MAX_EVENTS)));
	}
	return raised;
}

/** The heartbeat's daily run: at most once per 24 h, stamped before the run. Never throws. */
export async function runDomainAuthDaily(
	db: D1Database,
	env: DomainAuthEnv,
	now = Date.now()
): Promise<{ skipped: string } | { checked: number; failing: number; raised: number } | { error: string }> {
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(CRON_KEY).first<{ value: string | null }>();
		const last = row?.value ? Date.parse(row.value) : NaN;
		if (Number.isFinite(last) && now - last < DAY_MS) return { skipped: 'ran in the last 24h' };
		// #729: compare-and-set on the stamp we just read, so two clocks ticking at once can't both run it.
		if (!(await casAppState(db, CRON_KEY, row?.value ?? null, new Date(now).toISOString()))) return { skipped: 'ran in the last 24h' };
		const { result, raised } = await runDomainAuthCheck(db, env, 'cron', new Date(now));
		const failing = result.domains.reduce((n, d) => n + d.checks.filter((c) => c.status === 'fail').length, 0);
		return { checked: result.domains.length, failing, raised: raised.length };
	} catch (e) {
		const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		console.error('domain auth check failed:', error);
		return { error };
	}
}

export async function lastDomainAuth(db: D1Database): Promise<DomainAuthResult | null> {
	const v = await getJson<DomainAuthResult>(db, RESULT_KEY);
	return v && typeof v.at === 'string' && Array.isArray(v.domains) ? v : null;
}

/** The banner's items (empty = no banner). */
export async function domainAuthAlert(db: D1Database): Promise<(AlertItem & { text: string })[]> {
	const v = await getJson<DomainAuthAlert>(db, ALERT_KEY);
	return (Array.isArray(v?.items) ? v.items : []).map((i) => ({ ...i, text: bannerText(i) }));
}

// ---------------------------------------------------------------------------------------
// Bounce-reason watch

export type AuthBounce = {
	id: number;
	recorded_at: string;
	contact_id: number | null;
	email: string | null;
	campaign_id: number | null;
	subject: string | null;
	bounce_type: string | null;
	reason: string | null;
};

const ENHANCED_57 = /\b5\.7\.\d{1,3}\b/;

/** Bounces in the last `hours` that cite DMARC policy or a 5.7.x (auth/policy) code. */
export async function authBounces(db: D1Database, hours = 24): Promise<AuthBounce[]> {
	const rows = await db
		.prepare(
			`SELECT e.id, e.recorded_at, COALESCE(e.contact_id, r.contact_id) AS contact_id, COALESCE(c.email, r.email) AS email,
			        e.campaign_id, cp.subject,
			        CASE WHEN json_valid(e.detail) THEN json_extract(e.detail, '$.Type') END AS bounce_type,
			        CASE WHEN json_valid(e.detail) THEN COALESCE(NULLIF(json_extract(e.detail, '$.Details'), ''), json_extract(e.detail, '$.Description')) END AS reason,
			        e.detail AS raw
			 FROM events e
			 LEFT JOIN recipients r ON r.id = e.recipient_id
			 LEFT JOIN contacts c ON c.id = COALESCE(e.contact_id, r.contact_id)
			 LEFT JOIN campaigns cp ON cp.id = e.campaign_id
			 WHERE e.type = 'bounce' AND e.recorded_at >= datetime('now', ?)
			   AND (e.detail LIKE '%DMARCPolicy%' OR e.detail LIKE '%5.7.%')
			 ORDER BY e.recorded_at DESC, e.id DESC LIMIT 200`
		)
		.bind(`-${Math.max(1, Math.floor(hours))} hours`)
		.all<AuthBounce & { raw: string | null }>();
	return rows.results
		.filter((r) => r.bounce_type === 'DMARCPolicy' || /DMARCPolicy/.test(r.raw ?? '') || ENHANCED_57.test(r.raw ?? ''))
		.slice(0, 50)
		.map(({ raw, ...r }) => ({ ...r, reason: r.reason ? String(r.reason).slice(0, 300) : null }));
}

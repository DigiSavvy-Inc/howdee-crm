// App settings (#43) — small operator-editable values in app_state, with env-var
// fallbacks so prod keeps working before anything is configured.
//
// Keys:
//   inbound_forward_to  comma-separated inboxes that receive captured replies
//   approved_senders    comma-separated Postmark-approved domains and/or full addresses
//   default_from        default From for compose / automation steps
//   luma_webhook_secret Luma webhook signing secret (whsec_…); env LUMA_WEBHOOK_SECRET fallback (#70)
//   luma_list           newsletter list Luma registrants are added to (#70)
//   timezone            IANA tz (#119) — "weekend" for weekday-only scheduling is relative
//                       to this; default America/Los_Angeles when unset. Storage stays UTC.
//   reply_bcc_operator  '1' = BCC the operator on replies sent from a conversation (#159),
//                       so the thread stays complete in their own mailbox. Unset = off.
//   ai_resend_subject   'on' | 'off' (#246) — "Let Claude suggest resend subjects"; also
//                       needs an Anthropic key (in-app or the secret). Unset = off. See ai-subject.ts.
//   mailing_address     the sender's postal address (#311): the pre-send checks look for it
//                       in the email (CAN-SPAM). Unset = look for any address-like line.

import { parseApprovedSenders, senderAllowed } from '$lib/approved-senders';

export type AppSettings = {
	inbound_forward_to: string | null;
	approved_senders: string | null;
	default_from: string | null;
	luma_webhook_secret: string | null;
	luma_list: string | null;
	timezone: string | null;
	reply_bcc_operator: string | null;
	ai_resend_subject: string | null;
	mailing_address: string | null;
};

const KEYS: (keyof AppSettings)[] = [
	'inbound_forward_to',
	'approved_senders',
	'default_from',
	'luma_webhook_secret',
	'luma_list',
	'timezone',
	'reply_bcc_operator',
	'ai_resend_subject',
	'mailing_address'
];

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Canonical IANA zones for the Settings dropdown and `isValidTimezone`.
 * `Intl.supportedValuesOf('timeZone')` omits `UTC`, so it is added here.
 * One list — the dropdown and the validator both start from this.
 */
export function timezoneNames(): string[] {
	let zones: string[] = [];
	const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
	if (typeof supportedValuesOf === 'function') {
		try {
			zones = [...supportedValuesOf('timeZone')];
		} catch {
			zones = [];
		}
	}
	if (!zones.includes('UTC')) zones.push('UTC');
	zones.sort();
	return zones;
}

/** Dropdown options. A stored value that isn't on the canonical list is still shown. */
export function timezoneOptions(stored?: string | null): string[] {
	const list = timezoneNames();
	const extra = stored?.trim();
	if (extra && !list.includes(extra)) list.push(extra);
	return list;
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
	const placeholders = KEYS.map(() => '?').join(', ');
	const rows = await db
		.prepare(`SELECT key, value FROM app_state WHERE key IN (${placeholders})`)
		.bind(...KEYS)
		.all<{ key: string; value: string | null }>();
	const out = {
		inbound_forward_to: null,
		approved_senders: null,
		default_from: null,
		luma_webhook_secret: null,
		luma_list: null,
		timezone: null,
		reply_bcc_operator: null,
		ai_resend_subject: null,
		mailing_address: null
	} as AppSettings;
	for (const r of rows.results) {
		if ((KEYS as string[]).includes(r.key)) out[r.key as keyof AppSettings] = r.value?.trim() || null;
	}
	return out;
}

/**
 * Validate an IANA timezone name (#119). True when the name is on `timezoneNames()`
 * (the same list the Settings dropdown uses, including `UTC`). A miss falls through
 * to `Intl.DateTimeFormat`, which still accepts legacy aliases like `US/Pacific`.
 */
export function isValidTimezone(tz: string): boolean {
	const name = tz.trim();
	if (!name) return false;
	if (timezoneNames().includes(name)) return true;
	// Legacy aliases (`US/Pacific`) are absent from the canonical list but still valid.
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

/** The operator's configured timezone (#119), or DEFAULT_TIMEZONE when unset/invalid.
 *  A failed read also falls back — a tick must not die because this query threw. */
export async function getTimezone(db: D1Database): Promise<string> {
	try {
		const row = await db
			.prepare(`SELECT value FROM app_state WHERE key = 'timezone'`)
			.first<{ value: string | null }>();
		const tz = row?.value?.trim();
		return tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
	} catch {
		return DEFAULT_TIMEZONE;
	}
}

export async function setSettings(db: D1Database, values: Partial<AppSettings>): Promise<void> {
	const upsert = db.prepare(
		`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	);
	const stmts = Object.entries(values)
		.filter(([k]) => (KEYS as string[]).includes(k))
		.map(([k, v]) => upsert.bind(k, (v ?? '').trim() || null));
	if (stmts.length) await db.batch(stmts);
}

/** Parse a comma/space/newline-separated list of emails (lowercased, deduped). */
export function parseEmailList(csv: string | null | undefined, cap = 10): string[] {
	return [
		...new Set(
			(csv ?? '')
				.split(/[\s,;]+/)
				.map((e) => e.trim().toLowerCase())
				.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
		)
	].slice(0, cap);
}

/**
 * Validate a From address against the approved-senders setting (#43): entries are
 * Postmark-verified DOMAINS (any address on them passes — the common case) or full
 * addresses (exact match). An empty/unset setting means no enforcement.
 */
export function fromAllowed(from: string, approvedCsv: string | null | undefined): boolean {
	return senderAllowed(from, parseApprovedSenders(approvedCsv));
}

/**
 * The active audience (#705) — one rule for who shows up in lists, tags, segments, companies,
 * reports, search, pickers and every "N contacts" count:
 *
 *   not archived (`archived_at IS NULL`) AND (subscribed OR pending double opt-in).
 *
 * Unsubscribed contacts (`subscribed = 0`, not `confirm_pending`) and archived ones are hidden
 * everywhere except the Contacts page, where its Status / Archived filters show them on purpose.
 * The contact page itself still opens by direct link.
 *
 * This is a VIEW rule. Who gets mail is decided by the send / enroll paths (`subscribed = 1`,
 * not archived), which are stricter (pending contacts are never sent to) and stay as they are.
 * Stored campaign history (sent / opened / clicked) is never filtered by it.
 *
 * Every SQL fragment here is a constant over a whitelisted alias — nothing user-supplied.
 */

/** `alias` → its column prefix (`'c'` → `c.`, `''` → no prefix). Only `[A-Za-z_][A-Za-z0-9_]*`. */
function prefix(alias: string): string {
	if (!alias) return '';
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`active-audience: bad alias ${alias}`);
	return `${alias}.`;
}

/** Subscribed or pending double opt-in (#510) — the subscription half of the rule. */
export function activeSubscriptionSql(alias = ''): string {
	const p = prefix(alias);
	return `(${p}subscribed = 1 OR ${p}confirm_pending = 1)`;
}

/** The whole rule over `contacts` aliased `alias`: not archived, subscribed or pending. */
export function activeContactSql(alias = ''): string {
	return `(${prefix(alias)}archived_at IS NULL AND ${activeSubscriptionSql(alias)})`;
}

/** The complement over the same alias: what the rule hides (unsubscribed or archived). */
export function hiddenContactSql(alias = ''): string {
	return `NOT ${activeContactSql(alias)}`;
}

/**
 * The hidden ones split in two, for the group page's note: archived (whatever their
 * subscription, so an archived unsubscribed contact counts once, here) and unsubscribed
 * (not archived). The two never overlap and together are exactly `hiddenContactSql`.
 */
export function hiddenArchivedSql(alias = ''): string {
	return `(${prefix(alias)}archived_at IS NOT NULL)`;
}
export function hiddenUnsubscribedSql(alias = ''): string {
	return `(${prefix(alias)}archived_at IS NULL AND NOT ${activeSubscriptionSql(alias)})`;
}

export type HiddenPart = { count: number; href: string | null };
export type HiddenNote = { count: number; unsubscribed: HiddenPart; archived: HiddenPart };

/**
 * The group page's "· 1 unsubscribed (view) · 1 archived (view)" note. Each link opens
 * /contacts with this group as the In group filter: `status=unsubscribed` (the default,
 * non-archived view) for the unsubscribed, the Archived view with every status for the
 * archived. `groupId` null = no links (a rules segment isn't an In group target).
 */
export function hiddenNote(unsubscribed: number, archived: number, groupId: number | null): HiddenNote {
	const link = (qs: string) => (groupId == null ? null : `/contacts?in=${groupId}&${qs}`);
	return {
		count: unsubscribed + archived,
		unsubscribed: { count: unsubscribed, href: link('status=unsubscribed') },
		archived: { count: archived, href: link('archived=1&status=all') }
	};
}

/**
 * True when a rule set itself asks about subscription (a `subscribed` rule, either way) — then
 * the rule decides and only the archived half of the active rule applies. Archived contacts
 * can't be asked for: `compileSegment` always leaves them out.
 */
export function rulesAskForSubscription(rules: { rules?: { field?: string }[] } | null | undefined): boolean {
	return !!rules?.rules?.some((r) => r?.field === 'subscribed');
}

/** The rule for a segment's (or report's) members: active, unless its rules ask about subscription. */
export function segmentAudienceSql(rules: { rules?: { field?: string }[] } | null | undefined, alias = ''): string {
	return rulesAskForSubscription(rules) ? `(${prefix(alias)}archived_at IS NULL)` : activeContactSql(alias);
}

/** Plain-language wording, shared by the help text, notices and tests. */
export const ACTIVE_AUDIENCE_TEXT =
	'Unsubscribed and archived contacts are hidden from lists, tags, segments, companies, reports and counts. Find them on the Contacts page with the Status or Archived filter.';

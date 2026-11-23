// "View email" deep links (#155) — client- AND server-safe. A link that knows the person
// opens the campaign's View email modal already rendered as them; without one it's just
// the campaign page (whose modal then defaults to the template as authored).
//   recipientId → /campaign/<id>?as=<recipientId>#email   (exact send row)
//   contactId   → /campaign/<id>?as_contact=<contactId>#email (resolved server-side)
export function viewEmailHref(
	campaignId: number,
	who: { recipientId?: number | null; contactId?: number | null } = {}
): string {
	if (who.recipientId) return `/campaign/${campaignId}?as=${who.recipientId}#email`;
	if (who.contactId) return `/campaign/${campaignId}?as_contact=${who.contactId}#email`;
	return `/campaign/${campaignId}`;
}

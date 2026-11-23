// #668: operator / account mail the app sends itself — not campaigns, not conversations.
//
// `campaigns.system_kind` (migration 0132) is NULL for every send a person made (broadcast,
// 1:1, automation step, …). Account emails (invite, password reset, email verification, #639)
// are stored as `'account'`: their row only exists so the send path, recipients and webhook
// attribution work. Every reader that lists or counts campaigns or conversations for people
// to browse filters them out with `visibleCampaignSql(alias)`, so a member never sees who was
// invited or who asked for a reset. Import-free on purpose (the MCP / assistant import walks).

export const ACCOUNT_MAIL_KIND = 'account';

/** SQL condition: the campaign row `alias` is a person's send, not system mail. */
export function visibleCampaignSql(alias: string): string {
	return `${alias}.system_kind IS NULL`;
}

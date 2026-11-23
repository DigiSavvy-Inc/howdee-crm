// Company conversations (#567, extracted from the account brief's source collector, #388): the
// threads of a company's active contacts with activity in the last N days. A thread counts when
// someone replied, or it is a direct 1:1 / Gmail thread — an unreplied broadcast is bulk mail.
// Used by the account brief (`collectBriefSources`) and the company page's Conversations panel.
// Read-only.

import { conversationsFor, type Conversation } from './conversations';

export const COMPANY_CONVERSATION_DAYS = 90;
export const COMPANY_CONVERSATION_CONTACTS = 10;

/** Newest first (by the thread's last message). */
export async function companyConversations(
	db: D1Database,
	companyId: number,
	opts: { now?: Date; days?: number; contacts?: number } = {}
): Promise<Conversation[]> {
	const now = opts.now ?? new Date();
	const days = opts.days ?? COMPANY_CONVERSATION_DAYS;
	const cutoffSql = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
	const convContacts = await db
		.prepare(
			`SELECT c.id FROM contacts c WHERE c.company_id = ? AND c.archived_at IS NULL AND (
			   EXISTS (SELECT 1 FROM replies r WHERE r.contact_id = c.id AND r.received_at >= ?)
			   OR EXISTS (SELECT 1 FROM mail_message_contacts mmc JOIN mail_messages mm ON mm.id = mmc.message_id
			              WHERE mmc.contact_id = c.id AND mm.sent_at >= ?)
			   OR EXISTS (SELECT 1 FROM recipients rc JOIN campaigns ca ON ca.id = rc.campaign_id
			              WHERE rc.contact_id = c.id AND ca.list_id IS NULL AND ca.automation_step_id IS NULL
			                AND COALESCE(ca.sent_at, ca.created_at) >= ?))
			 ORDER BY c.id DESC LIMIT ?`
		)
		.bind(companyId, cutoffSql, cutoffSql, cutoffSql, opts.contacts ?? COMPANY_CONVERSATION_CONTACTS)
		.all<{ id: number }>();
	const threads: Conversation[] = [];
	for (const { id } of convContacts.results) {
		for (const t of await conversationsFor(db, id)) {
			if (t.last_at < cutoffSql) continue;
			if (t.replies === 0 && t.root_kind !== 'direct' && t.root_kind !== 'gmail') continue; // bulk mail, not a conversation
			threads.push(t);
		}
	}
	threads.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
	return threads;
}

export type ConversationPanelRow = {
	key: string;
	subject: string;
	contact_id: number | null;
	who: string;
	last_at: string;
	awaiting: boolean;
	count: number;
	gmail: boolean;
};

/** The company page panel: awaiting our reply first, then newest; at most `max` rows. */
export function conversationPanelRows(threads: Conversation[], max = 6): { rows: ConversationPanelRow[]; total: number; awaiting: number } {
	const sorted = [...threads].sort((a, b) => Number(b.awaiting) - Number(a.awaiting) || (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
	return {
		total: threads.length,
		awaiting: threads.filter((t) => t.awaiting).length,
		rows: sorted.slice(0, max).map((t) => ({
			key: t.key,
			subject: t.subject || '(no subject)',
			contact_id: t.contact_id,
			who: t.name || t.email,
			last_at: t.last_at,
			awaiting: t.awaiting,
			count: t.count,
			gmail: t.root_kind === 'gmail' || t.messages.some((m) => m.source === 'gmail')
		}))
	};
}

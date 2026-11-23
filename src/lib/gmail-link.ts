// #158: "Open in Gmail" deep link for a synced thread (client- and server-safe).
export function gmailThreadUrl(threadId: string): string {
	return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

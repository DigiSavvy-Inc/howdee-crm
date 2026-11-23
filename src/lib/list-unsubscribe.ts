// #264 / #373: our unsubscribe path on broadcast mail (universal, so the send path and the
// pre-send checks share it). The broadcast stream's unsubscribe handling is set to Custom in
// Postmark, so Postmark adds no link or header of its own: the body link and these headers are
// the only way out of a broadcast. A broadcast message missing any of them must not go out.

export type MailHeader = { Name: string; Value: string };

/** RFC 8058 one-click unsubscribe headers (#264). URL only: no inbound mailbox processes
 *  unsubscribe mail, so there's no `mailto:` alternative. */
export function listUnsubscribeHeaders(oneClickUrl: string): MailHeader[] {
	return [
		{ Name: 'List-Unsubscribe', Value: `<${oneClickUrl}>` },
		{ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }
	];
}

/** #373: the error on a broadcast message refused for a missing unsubscribe path. */
export const UNSUB_REFUSED_PREFIX = 'Not sent: unsubscribe path incomplete';

export const UNSUB_PROBLEMS = {
	html: 'No unsubscribe link in the body',
	text: 'No unsubscribe link in the plain-text version',
	header: 'No List-Unsubscribe header',
	post: 'No List-Unsubscribe-Post header'
} as const;

/**
 * #373: what a broadcast message lacks of its unsubscribe path (empty = complete). `link` is
 * what the body must carry: the `%%UNSUB_URL%%` placeholder before personalization, the
 * recipient's own URL after it.
 */
export function unsubscribeProblems(m: { html: string; text: string; headers?: MailHeader[] | null }, link: string): string[] {
	const out: string[] = [];
	if (!link || !m.html.includes(link)) out.push(UNSUB_PROBLEMS.html);
	if (!link || !m.text.includes(link)) out.push(UNSUB_PROBLEMS.text);
	const header = (name: string) => (m.headers ?? []).find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value.trim() ?? '';
	if (!/^<[^<>\s]+>$/.test(header('List-Unsubscribe'))) out.push(UNSUB_PROBLEMS.header);
	if (header('List-Unsubscribe-Post') !== 'List-Unsubscribe=One-Click') out.push(UNSUB_PROBLEMS.post);
	return out;
}

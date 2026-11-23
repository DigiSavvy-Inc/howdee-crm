import { htmlToText, looksLikeHtml, stripHelpdeskMarkers, stripTrailingQuoteIntro } from '$lib/email-text';

/**
 * Postmark's Inbound webhook leaves `StrippedTextReply`/`TextBody` as EMPTY STRINGS (not
 * undefined) for HTML-only replies — Apple Mail and others send no plain-text part at all,
 * so the `??` fallback chain in the webhook handler never kicks in and the captured reply
 * ends up empty. This derives a best-effort plain-text reply from `HtmlBody` as a last
 * resort: strips quoted history (`<blockquote>`, Gmail's `gmail_quote` wrapper, a trailing
 * "On ... wrote:" attribution line), then converts the rest with `htmlToText` (#380).
 */
export function htmlToReplyText(html: string): string {
	if (!html) return '';

	let s = html;

	// <head>/<style>/<script> are dropped by htmlToText; cut them first so the quote
	// searches below never match inside a stylesheet.
	s = s.replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

	// Cut Gmail's quoted-history wrapper and everything from it onward.
	const gmailIdx = s.search(/<div[^>]*class=["'][^"']*gmail_quote/i);
	if (gmailIdx !== -1) s = s.slice(0, gmailIdx);

	// Cut <blockquote>...</blockquote> (quoted history, e.g. Apple Mail). Blockquotes can
	// nest, so remove from the FIRST opening tag to the LAST closing tag — that drops the
	// whole quoted block regardless of nesting depth.
	const bqStart = s.search(/<blockquote[^>]*>/i);
	if (bqStart !== -1) {
		const closeRe = /<\/blockquote\s*>/gi;
		let lastClose = -1;
		let m: RegExpExecArray | null;
		while ((m = closeRe.exec(s))) {
			lastClose = m.index + m[0].length;
		}
		s = lastClose !== -1 ? s.slice(0, bqStart) + s.slice(lastClose) : s.slice(0, bqStart);
	}

	// Tags, entities, links and blank lines (#380): the shared converter.
	s = htmlToText(s);

	// Drop a dangling "On ... wrote:" attribution line (shared with the forward, #381).
	s = stripTrailingQuoteIntro(s);

	return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Cap on the original HTML kept for "View original" (#380). */
export const ORIGINAL_HTML_MAX = 200_000;

/**
 * The text to store for a Postmark inbound payload (#380): `StrippedTextReply`, then a real
 * `TextBody`, then text converted from `HtmlBody`, then a text part that was HTML after all
 * (converted). Helpdesk "reply above this line" markers are dropped. `html` is the markup the
 * text was converted from (kept for "View original"), else null; `fromHtmlBody` = the text
 * came from `HtmlBody`.
 */
export function pickInboundText(p: { StrippedTextReply?: unknown; TextBody?: unknown; HtmlBody?: unknown }): {
	text: string;
	html: string | null;
	fromHtmlBody: boolean;
} {
	const stripped = String(p.StrippedTextReply ?? '').trim();
	const body = String(p.TextBody ?? '').trim();
	const htmlBody = String(p.HtmlBody ?? '');
	if (stripped && !looksLikeHtml(stripped)) return { text: stripHelpdeskMarkers(stripped), html: null, fromHtmlBody: false };
	if (body && !looksLikeHtml(body)) return { text: stripHelpdeskMarkers(body), html: null, fromHtmlBody: false };
	if (htmlBody.trim()) {
		return {
			text: stripHelpdeskMarkers(htmlToReplyText(htmlBody)),
			html: htmlBody.slice(0, ORIGINAL_HTML_MAX),
			fromHtmlBody: true
		};
	}
	const htmlText = stripped || body;
	if (htmlText) {
		return { text: stripHelpdeskMarkers(htmlToText(htmlText)), html: htmlText.slice(0, ORIGINAL_HTML_MAX), fromHtmlBody: false };
	}
	return { text: '', html: null, fromHtmlBody: false };
}

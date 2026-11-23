/**
 * Readable text for inbound mail (#380). Some senders put HTML in the plain-text part (a
 * Pantheon / Zendesk auto-reply shows up as `<center class="wrapper" style=…><table …>`),
 * and replies stored before this landed may hold that HTML verbatim. These helpers turn it
 * into plain text for display and build the sandboxed "View original" document.
 *
 * Universal (client + server), pure string work — no DOM, no dependencies — so it runs in
 * the Worker, in the browser and in tests alike.
 */

/** Tag names that count as "this is HTML" when they appear as real tags. */
const HTML_TAG_RE =
	/<\/?(?:html|head|body|table|tbody|thead|tr|td|th|div|span|p|br|center|style|img|a|font|b|strong|i|em|u|ul|ol|li|h[1-6]|hr|meta|blockquote|section|title|link)\b[^<>]*>/gi;

/**
 * True when `s` looks like HTML markup rather than text that merely contains a `<`. Needs
 * three real tags (`<div>`, `</td>`, `<br/>`), or one document-level marker (`<!doctype html`,
 * `<html`, `<body`, `<style`). "a < b", "<3" or a lone `<br>` mention stay text.
 */
export function looksLikeHtml(s: string | null | undefined): boolean {
	if (!s || s.indexOf('<') === -1) return false;
	if (/<!doctype\s+html|<html[\s>]|<body[\s>]|<style[\s>]/i.test(s)) return true;
	const m = s.match(HTML_TAG_RE);
	return !!m && m.length >= 3;
}

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', reg: '®',
	trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
	rdquo: '”', bull: '•', middot: '·', laquo: '«', raquo: '»', euro: '€', pound: '£',
	yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', para: '¶', sect: '§',
	zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ', thinsp: ' '
};

/** Decode named (common set), decimal and hex entities in one pass — `&amp;lt;` → `&lt;`. */
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
			try {
				return String.fromCodePoint(code);
			} catch {
				return whole;
			}
		}
		const v = NAMED_ENTITIES[body.toLowerCase()];
		return v === undefined ? whole : v;
	});
}

// Invisible characters mail templates use as preheader padding.
const INVISIBLE_RE = /[­͏​-‍⁠﻿]/g;

// Paragraph-like blocks get a blank line around them; other blocks start a new line.
const PARA_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre']);
const BLOCK_TAGS = new Set([
	'div', 'tr', 'li', 'hr', 'table', 'center', 'section', 'header', 'footer', 'article', 'dl', 'dt', 'dd'
]);
const CELL_TAGS = new Set(['td', 'th']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source']);

/** Link URLs not worth printing next to the link text: click trackers and images. */
export function isNoisyUrl(url: string): boolean {
	if (url.length > 200) return true;
	if (/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#]|$)/i.test(url)) return true;
	return /(?:^https?:\/\/(?:click|clicks|track|tracking|trk|links?|email|e|go|t|url\d*)\.)|list-manage\.com|sendgrid\.net|mandrillapp\.com|mailchi\.mp|hubspotlinks|hs-sites|\/ls\/click|\/track\/click|\/wf\/click|mailgun|mjt\.lu|ct\.sendgrid|safelinks\.protection/i.test(
		url
	);
}

function sameAsText(url: string, text: string): boolean {
	const norm = (s: string) =>
		s.trim().toLowerCase().replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
	return norm(url) === norm(text);
}

function attr(attrs: string, name: string): string | null {
	const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
	if (!m) return null;
	return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

function isHidden(attrs: string): boolean {
	const style = attr(attrs, 'style');
	if (style && /display\s*:\s*none|mso-hide\s*:\s*all|visibility\s*:\s*hidden/i.test(style)) return true;
	return /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs);
}

/**
 * HTML → plain text for display. Drops `<head>`, `<style>`, `<script>`, comments and hidden
 * elements; block elements become line breaks, table cells spaces; links keep their text, with
 * the URL in parentheses only when it differs from the text and isn't a tracker or an image;
 * images keep their alt text at most; entities are decoded; blank-line runs collapse to one.
 */
export function htmlToText(html: string): string {
	if (!html) return '';
	let s = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
		.replace(/<!doctype[^>]*>/gi, '')
		.replace(/<(head|style|script|title|noscript|template|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<(?:style|script)\b[^>]*>[\s\S]*$/i, ''); // unterminated block: drop the rest

	let out = '';
	type Anchor = { href: string | null; start: number; text: boolean; alt: string };
	const anchors: Anchor[] = [];
	let skipTag: string | null = null;
	let skipDepth = 0;
	// Soft break: end the output with at least `n` newlines (nothing at the very start), so
	// nested blocks and empty cells don't stack up blank lines.
	const brk = (n: number) => {
		const body = out.replace(/[ \t]+$/, '');
		if (!body.trim()) return;
		const have = body.length - body.replace(/\n+$/, '').length;
		out = body + '\n'.repeat(Math.max(0, n - have));
	};

	const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(s))) {
		const [whole, slash, rawName, attrs = '', textPart] = m;
		if (textPart !== undefined || !rawName) {
			if (skipTag) continue;
			const t = decodeEntities(textPart ?? whole).replace(INVISIBLE_RE, '').replace(/\s+/g, ' ');
			if (t.trim() && anchors.length) anchors[anchors.length - 1].text = true;
			out += t;
			continue;
		}
		const name = rawName.toLowerCase();
		const closing = slash === '/';
		const selfClosing = /\/\s*$/.test(attrs) || VOID_TAGS.has(name);

		if (skipTag) {
			if (name === skipTag && !selfClosing) skipDepth += closing ? -1 : 1;
			if (skipDepth <= 0) skipTag = null;
			continue;
		}
		if (!closing && !selfClosing && isHidden(attrs)) {
			skipTag = name;
			skipDepth = 1;
			continue;
		}

		if (name === 'br') out += '\n';
		else if (PARA_TAGS.has(name)) brk(2);
		else if (BLOCK_TAGS.has(name)) brk(1);
		else if (CELL_TAGS.has(name)) out += ' ';
		else if (name === 'img' && !closing) {
			const alt = (attr(attrs, 'alt') ?? '').replace(INVISIBLE_RE, '').trim();
			// File names and spacer alts ("spacer.gif", "*") aren't content.
			if (alt && /[a-z0-9]/i.test(alt) && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(alt)) {
				if (anchors.length) anchors[anchors.length - 1].alt += (anchors[anchors.length - 1].alt ? ' ' : '') + alt;
				else out += ` ${alt} `;
			}
		} else if (name === 'a') {
			if (!closing) {
				anchors.push({ href: attr(attrs, 'href'), start: out.length, text: false, alt: '' });
			} else {
				const a = anchors.pop();
				if (a) {
					if (!a.text) {
						// Image-only link (social icons, logos): the alt text at most, never the URL.
						if (a.alt) out += ` ${a.alt} `;
					} else {
						const label = out.slice(a.start).trim();
						const href = (a.href ?? '').trim();
						if (/^(?:https?:|mailto:)/i.test(href) && !isNoisyUrl(href) && !sameAsText(href, label)) {
							out += ` (${href.replace(/^mailto:/i, '')})`;
						}
					}
				}
			}
		}
	}

	return out
		.split('\n')
		.map((l) => l.replace(/[ \t ]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Helpdesk "reply above this line" separators (Zendesk, Freshdesk, Help Scout, Jira Service
 * Management, Kayako, generic). Matched against a whole trimmed line.
 */
export const HELPDESK_MARKERS: RegExp[] = [
	// Zendesk: "##- Please type your reply above this line -##"
	/^#+\s*-?\s*please\s+type\s+your\s+reply\s+above\s+this\s+line\s*-?\s*#+$/i,
	// Freshdesk / Help Scout / generic: "## Please reply above this line ##", "-- Reply above this line --"
	/^[#\-=*_>\s]*(?:please\s+)?(?:type\s+your\s+)?(?:reply|respond|write)(?:\s+to\s+this\s+(?:email|message))?\s+above\s+this\s+line\.?[#\-=*_<\s]*$/i,
	// Jira Service Management: "—-—-—-—" + "Reply above this line."
	/^[\s\-—–]*reply\s+above\s+this\s+line\.?[\s\-—–]*$/i,
	// "Please do not write below this line" / "Do not reply below this line"
	/^[#\-=*_>\s]*(?:please\s+)?do\s+not\s+(?:write|reply|type)\s+below\s+this\s+line\.?[#\-=*_<\s]*$/i
];

/** Drop helpdesk reply-above-this-line marker lines (and the blank line they leave). */
export function stripHelpdeskMarkers(s: string): string {
	if (!s) return '';
	const kept = s.split('\n').filter((line) => {
		const t = line.trim();
		return !t || !HELPDESK_MARKERS.some((re) => re.test(t));
	});
	return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Display text for a stored message body: HTML converted, helpdesk markers dropped. */
export function cleanMessageText(text: string | null | undefined): { text: string; converted: boolean } {
	const raw = String(text ?? '');
	const converted = looksLikeHtml(raw);
	return { text: stripHelpdeskMarkers(converted ? htmlToText(raw) : raw), converted };
}

/** Just the cleaned text (previews, snippets). */
export function displayText(text: string | null | undefined): string {
	return cleanMessageText(text).text;
}

/**
 * The srcdoc for "View original": rendered inside `<iframe sandbox="">` (no scripts, no
 * same-origin, no forms). Scripts, `<meta>` / `<base>` / `<link>` tags and inline event handlers
 * are removed; a CSP `<meta>` blocks every network fetch except, with `loadImages`, images.
 * Without `loadImages`, `<img src>` / `srcset` and `background=` are stripped too (the CSP
 * also stops CSS background images). Links get `target="_blank" rel="noopener noreferrer"`.
 */
export function originalSrcdoc(html: string, opts: { loadImages?: boolean } = {}): string {
	let s = String(html ?? '')
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
		.replace(/<script\b[^>]*>/gi, '')
		.replace(/<(?:meta|base|link)\b[^>]*>/gi, '')
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
	if (!opts.loadImages) {
		s = s
			.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(/\s(?:src|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''))
			.replace(/\sbackground\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
	}
	s = s.replace(/<a\b([^>]*)>/gi, (_tag, attrs: string) => {
		const rest = attrs.replace(/\s(?:target|rel)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
		return `<a${rest} target="_blank" rel="noopener noreferrer">`;
	});
	const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${opts.loadImages ? 'https: http: data:' : 'data:'}; font-src data:`;
	return `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">${s}`;
}

/**
 * Quote-intro lines a mail client writes above quoted history: "On … wrote:" (EN),
 * "El … escribió:" (ES), "Le … a écrit :" (FR), "Am … schrieb:" (DE), and Outlook's
 * "-----Original Message-----". Matched per line, case-insensitive.
 */
const QUOTE_INTRO: RegExp[] = [
	/^\s*on\b.+\bwrote:\s*$/i,
	/^\s*el\b.+\bescribi[óo]:\s*$/i,
	/^\s*le\b.+\ba\s+[ée]crit\s*:\s*$/i,
	/^\s*am\b.+\bschrieb\b.*:\s*$/i,
	/^\s*-{2,}\s*original message\s*-{2,}\s*$/i
];

/** True when a single line is a quote-intro ("On … wrote:" and friends). */
export function isQuoteIntroLine(line: string): boolean {
	return QUOTE_INTRO.some((re) => re.test(line));
}

/**
 * Drop a quote-intro line left dangling at the end of a reply (the quoted history was
 * stripped, its intro line wasn't — #381). Only removes it when nothing but blank lines
 * or `>` quote markers follow; text in the middle of a message is left alone. Some clients
 * wrap the intro over two lines ("On Wed, … <a@b.c>\nwrote:"), so a trailing pair is
 * also checked joined when the last line is only the verb.
 */
export function stripTrailingQuoteIntro(text: string): string {
	const lines = String(text ?? '').split(/\r?\n/);
	let end = lines.length;
	const blank = (l: string) => /^[\s>]*$/.test(l);
	while (end > 0 && blank(lines[end - 1])) end--;
	if (end === 0) return '';
	if (isQuoteIntroLine(lines[end - 1].replace(/^[\s>]+/, ''))) {
		end--;
	} else if (
		end > 1 &&
		/^[\s>]*(?:wrote|escribi[óo]|a\s+[ée]crit|schrieb)\s*:\s*$/i.test(lines[end - 1]) &&
		isQuoteIntroLine(`${lines[end - 2]} ${lines[end - 1]}`.replace(/^[\s>]+/, ''))
	) {
		end -= 2;
	} else {
		return lines.slice(0, end).join('\n');
	}
	while (end > 0 && blank(lines[end - 1])) end--;
	return lines.slice(0, end).join('\n');
}

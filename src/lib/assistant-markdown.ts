// Safe Markdown for the assistant panel (#300). The model's text can echo tool results
// (contact names, reply bodies, subjects), so it is treated as hostile:
// - raw HTML is escaped, never rendered (block and inline);
// - links only for http(s) and app paths — anything else (javascript:, data:, mailto:, …)
//   renders as its text; app links carry `data-app-link`, external ones open a new tab;
// - images never render — the alt text becomes a link (or plain text);
// - GFM tables are wrapped for horizontal scroll, numeric columns right-aligned;
// - fenced code (#327) gets a bar with the language label and a Copy button (`data-code-copy`,
//   handled by the panel's click handler); over CODE_COLLAPSE_LINES lines it starts collapsed
//   with a "Show all" button (`data-code-expand`). The code itself is always escaped.
// Universal (no DOM): the panel re-parses the accumulated text on each animation frame
// while streaming, so a half-written table or fence must not throw.

import { Marked, type Tokens } from 'marked';
import { iconSvg } from '$lib/icons/icon';

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export type SafeLink = { href: string; internal: boolean };

/**
 * Classify a link target: an app path (`/campaign/47`, or an absolute URL on one of
 * `appOrigins`) → internal, an http(s) URL → external, anything else → null (plain text).
 */
export function safeLink(raw: string, appOrigins: readonly string[] = []): SafeLink | null {
	// Control characters and whitespace can hide a scheme from naive checks.
	// eslint-disable-next-line no-control-regex
	const href = raw.replace(/[\u0000- \u007f]/g, '');
	if (!href || href.includes('\\')) return null;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
	if (scheme) {
		const s = scheme[1].toLowerCase();
		if (s !== 'http' && s !== 'https') return null;
		let url: URL;
		try {
			url = new URL(href);
		} catch {
			return null;
		}
		if (appOrigins.includes(url.origin)) return { href: `${url.pathname}${url.search}${url.hash}`, internal: true };
		return { href: url.href, internal: false };
	}
	// Protocol-relative (`//host`) is another site.
	if (href.startsWith('//')) return null;
	if (href.startsWith('/') || href.startsWith('#') || href.startsWith('?')) return { href, internal: true };
	// A bare relative path ("campaign/47") is meant from the app root, not the current page.
	return { href: `/${href}`, internal: true };
}

function anchor(link: SafeLink, inner: string, title?: string | null): string {
	const t = title ? ` title="${escapeHtml(title)}"` : '';
	const href = escapeHtml(link.href);
	return link.internal
		? `<a href="${href}" data-app-link${t}>${inner}</a>`
		: `<a href="${href}" target="_blank" rel="noopener noreferrer"${t}>${inner}</a>`;
}

const NUMERIC_CELL = /^[([]?[-+−]?[$€£]?\s?[-+−]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\s?(%|k|m|ms|s|h|d|x)?[)\]]?$/i;

/** A column is numeric when every non-empty body cell looks like a number (and one exists). */
export function isNumericColumn(cells: readonly string[]): boolean {
	let seen = false;
	for (const raw of cells) {
		const c = raw.replace(/[*_`]/g, '').trim();
		if (!c || c === '—' || c === '-' || c === '–') continue;
		if (!/\d/.test(c) || !NUMERIC_CELL.test(c)) return false;
		seen = true;
	}
	return seen;
}

/** A fenced block longer than this starts collapsed behind "Show all". */
export const CODE_COLLAPSE_LINES = 30;

/** The fence's language tag, reduced to a short safe label ('' when none). */
export function codeLanguage(lang: string | undefined): string {
	const first = (lang ?? '').trim().split(/\s+/)[0] ?? '';
	return first.replace(/[^\w+#.-]/g, '').slice(0, 20).toLowerCase();
}

function codeBlock(text: string, lang: string | undefined): string {
	const code = text.replace(/\n$/, '');
	const label = codeLanguage(lang);
	const lines = code.split('\n').length;
	const long = lines > CODE_COLLAPSE_LINES;
	const bar =
		`<div class="md-code-bar"><span class="md-code-lang">${escapeHtml(label || 'code')}</span>` +
		`<button type="button" class="md-code-copy" data-code-copy aria-label="Copy code">${iconSvg('copy', 16)}<span>Copy</span></button></div>`;
	const more = long ? `<button type="button" class="md-code-more" data-code-expand>Show all ${lines} lines</button>` : '';
	return `<div class="md-code${long ? ' md-code-long' : ''}">${bar}<pre><code>${escapeHtml(code)}</code></pre>${more}</div>\n`;
}

// One instance; the origins for the current (synchronous) parse live here.
let origins: readonly string[] = [];

const md = new Marked({
	gfm: true,
	breaks: true,
	async: false,
	renderer: {
		html({ text, block }: Tokens.HTML | Tokens.Tag) {
			return block ? `<p>${escapeHtml(text.trim()).replace(/\n/g, '<br>')}</p>\n` : escapeHtml(text);
		},
		text(token: Tokens.Text | Tokens.Escape) {
			if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
			// #531: always escape. marked flags text after an inline <code>/<pre>/<kbd>/<script>
			// tag as already escaped; trusting that let `<img onerror>` through.
			return escapeHtml(token.text);
		},
		codespan({ text }: Tokens.Codespan) {
			return `<code>${escapeHtml(text)}</code>`;
		},
		code({ text, lang }: Tokens.Code) {
			return codeBlock(text, lang);
		},
		heading({ tokens, depth }: Tokens.Heading) {
			// One modest size for h1–h3 inside the panel; h4–h6 a step smaller.
			const tag = depth <= 3 ? 'h3' : 'h4';
			return `<${tag}>${this.parser.parseInline(tokens)}</${tag}>\n`;
		},
		link({ href, title, tokens }: Tokens.Link) {
			const inner = this.parser.parseInline(tokens);
			const link = safeLink(href, origins);
			return link ? anchor(link, inner, title) : inner;
		},
		image({ href, title, text }: Tokens.Image) {
			const alt = escapeHtml(text || 'image');
			const link = safeLink(href, origins);
			return link ? anchor(link, alt, title) : alt;
		},
		checkbox({ checked }: Tokens.Checkbox) {
			return checked ? '[x] ' : '[ ] ';
		},
		table(token: Tokens.Table) {
			const numeric = token.header.map((_, i) => isNumericColumn(token.rows.map((r) => r[i]?.text ?? '')));
			const cell = (c: Tokens.TableCell, i: number, tag: 'th' | 'td') => {
				const align = c.align ?? (numeric[i] ? 'right' : null);
				const cls = align ? ` class="md-${align}"` : '';
				return `<${tag}${cls}>${this.parser.parseInline(c.tokens)}</${tag}>`;
			};
			const head = `<tr>${token.header.map((c, i) => cell(c, i, 'th')).join('')}</tr>`;
			const body = token.rows.map((r) => `<tr>${r.map((c, i) => cell(c, i, 'td')).join('')}</tr>`).join('');
			return `<div class="md-table"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>\n`;
		}
	}
});

/**
 * Render the assistant's Markdown to safe HTML. `appOrigins` = origins whose absolute
 * URLs count as in-app links (the panel passes `location.origin`). Never throws.
 */
export function renderAssistantMarkdown(text: string, appOrigins: readonly string[] = []): string {
	if (!text) return '';
	origins = appOrigins;
	try {
		return md.parse(text) as string;
	} catch {
		return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
	} finally {
		origins = [];
	}
}

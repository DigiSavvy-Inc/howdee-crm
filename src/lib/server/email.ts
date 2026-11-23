import { signatureHtml, signatureText, type EmailSignature } from '$lib/signature';
import { evaluateConditionals, type CondCtx } from '$lib/conditionals';
import {
	applyMergeTokens,
	parseCompanyToken,
	parseMarkdownPreservingMergeTags,
	unescapeHtmlText,
	type TemplateMode
} from '$lib/merge-tags';
import { COMPANY_MERGE_KEYS } from '$lib/company-metrics';
import { fillFormTags } from '$lib/form-embed';
import { canvasIsSet, canvasPadding, fontStack, CANVAS_LAYOUT_MARK, type EmailCanvas } from '$lib/blocks';
import { autoTextColor, contrastRatio } from '$lib/brand';

export { MERGE_TAGS } from '$lib/signature';

/** Placeholder embedded in stored HTML; swapped per-recipient at send time. */
export const UNSUB_PLACEHOLDER = '%%UNSUB_URL%%';

export type RenderOpts = {
	/** Include the in-body unsubscribe footer. Off for personal 1:1 sends. */
	unsubscribe?: boolean;
	/** Hidden inbox-preview (preheader) text shown after the subject. */
	preheader?: string;
	/** Permission reminder (#54): the audience's origin note, shown in the footer as
	 *  "You're receiving this email because: …" — reduces "who is this?" spam reports. */
	originNote?: string;
	/** #270: the template's canvas (backdrop, card width / radius, text and link colours,
	 *  font size). Unset or empty = the classic shell, unchanged. */
	canvas?: EmailCanvas | null;
	/** #594: the signature setting (`getSignature`). Unset / null = no signature, no wrapper. */
	signature?: EmailSignature | null;
};

/** The signature wrapper, or '' when no signature is set. */
function signatureBlock(sig: EmailSignature | null | undefined, style = ''): string {
	const html = signatureHtml(sig);
	return html ? `\n<div class="signature"${style}>${html}</div>` : '';
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Hidden snippet email clients show as the preview line, plus spacer to stop body bleed. */
function preheaderBlock(text: string): string {
	const t = escapeHtml(text.trim());
	if (!t) return '';
	const spacer = '&#847;&zwnj;&nbsp;'.repeat(60);
	return `<div style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${t}<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${spacer}</span></div>`;
}

/**
 * Render markdown into a clean, simple HTML email with the signature setting appended.
 * By default includes the in-body unsubscribe footer (for broadcast sends); pass
 * `unsubscribe: false` for personal 1:1 transactional mail.
 */
export function renderEmailHtml(markdownBody: string, opts: RenderOpts = {}): string {
	// Shield {{merge}} / {{#if}} through marked so hrefs stay substitutable.
	const inner = parseMarkdownPreservingMergeTags(markdownBody);
	return emailShell(inner, opts);
}

/** Same shell (preheader, signature, unsubscribe footer, permission reminder) around
 *  pre-rendered HTML — used by builder-block templates (#60), whose content is already
 *  email-safe table markup from renderBlocksEmailHtml(). */
export function renderEmailHtmlFromContent(innerHtml: string, opts: RenderOpts = {}): string {
	return emailShell(innerHtml, opts);
}

function emailShell(inner: string, opts: RenderOpts = {}): string {
	const preheader = opts.preheader ? preheaderBlock(opts.preheader) : '';
	const reminder = (opts.originNote ?? '').trim()
		? `You're receiving this email because: ${escapeHtml(opts.originNote!.trim())}<br>`
		: '';
	if (canvasIsSet(opts.canvas)) return canvasShell(inner, opts.canvas, preheader, reminder, opts.unsubscribe !== false, opts.signature);
	const footer =
		opts.unsubscribe === false
			? ''
			: `<div class="footer">
${reminder}Don't want these emails? <a href="${UNSUB_PLACEHOLDER}">Unsubscribe here</a>.
</div>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${EMAIL_STYLES}
</head>
<body>
${preheader}
<div class="email">
${inner}${signatureBlock(opts.signature)}
</div>
${footer}
</body>
</html>`;
}

/** #270: the shell with a template canvas: a full-width backdrop table (bgcolor) around
 *  a centred card table of the canvas width. Text colour, font size and link colour sit
 *  on the card cell (inherited) plus one small style block for markdown links. */
function canvasShell(
	inner: string,
	c: EmailCanvas,
	preheader: string,
	reminder: string,
	unsubscribe: boolean,
	signature: EmailSignature | null | undefined
): string {
	const backdrop = c.backdrop ?? '#ffffff';
	const width = c.width ?? 600;
	const radius = c.radius ?? 0;
	const text = c.text ?? '#1f2328';
	const size = c.fontSize ?? 16;
	// A block document laid out for the canvas (renderBlocksEmailHtml) pads its own runs so
	// full-bleed sections reach the card edges; anything else gets the card padding here.
	const laidOut = inner.startsWith(CANVAS_LAYOUT_MARK);
	const pad = laidOut ? '0' : c.padding === undefined ? '32px 24px' : `${c.padding}px`;
	// The footer sits on the backdrop: muted grey unless that would vanish (dark backdrop).
	const footColor = contrastRatio('#8b949e', backdrop) >= 3 ? '#8b949e' : autoTextColor(backdrop);
	const extra = `<style>
  .email a { color:${c.link ?? '#2563eb'}; }
  .footer a { color:${footColor}; }
${c.headingFont ? `  .email h1, .email h2, .email h3 { font-family:${fontStack(c.headingFont)}; }\n` : ''}</style>`;
	// #275: the canvas body font / line height on the card cell (unset = the shared styles').
	const type = `${c.font ? `font-family:${fontStack(c.font)};` : ''}${c.lineHeight ? `line-height:${c.lineHeight};` : ''}`;
	// With no card padding, the signature keeps its own inset.
	const cp = canvasPadding(c);
	const sigStyle = c.padding === 0 ? ' style="padding:0 24px 24px;"' : laidOut ? ` style="padding:0 ${cp.side}px ${cp.bottom}px;"` : '';
	const footer = unsubscribe
		? `<div class="footer" style="max-width:${width}px;margin:0 auto;color:${footColor};">
${reminder}Don't want these emails? <a href="${UNSUB_PLACEHOLDER}">Unsubscribe here</a>.
</div>`
		: '';
	const PRES = 'role="presentation" border="0" cellpadding="0" cellspacing="0"';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${EMAIL_STYLES}
${extra}
</head>
<body style="margin:0;padding:0;background-color:${backdrop};">
${preheader}
<table ${PRES} width="100%" bgcolor="${backdrop}" style="background-color:${backdrop};"><tr><td align="center" style="padding:24px 12px;">
<table ${PRES} width="${width}" align="center" bgcolor="#ffffff" style="width:100%;max-width:${width}px;margin:0 auto;background-color:#ffffff;border-radius:${radius}px;border-collapse:separate;overflow:hidden;"><tr>
<td class="email" style="max-width:none;padding:${pad};color:${text};font-size:${size}px;${type}border-radius:${radius}px;">
${inner}${signatureBlock(signature, sigStyle)}
</td></tr></table>
${footer}
</td></tr></table>
</body>
</html>`;
}

/** The shared <style> block every email document carries (also used by emailDocument). */
const EMAIL_STYLES = `<style>
  body { margin:0; padding:0; background:#ffffff; }
  .email { max-width:640px; margin:0; padding:32px 24px; text-align:left;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    font-size:16px; line-height:1.6; color:#1f2328; }
  .email h1 { font-size:24px; font-weight:700; margin:0 0 16px; line-height:1.25; }
  .email h2 { font-size:18px; font-weight:700; margin:28px 0 10px; line-height:1.3; }
  .email h3 { font-size:16px; font-weight:700; margin:22px 0 8px; }
  .email p { margin:0 0 16px; }
  .email ul, .email ol { margin:0 0 16px; padding-left:22px; }
  .email li { margin:0 0 8px; }
  .email a { color:#2563eb; text-decoration:none; }
  .email a:hover { text-decoration:underline; }
  .email img { max-width:100%; height:auto; }
  .email blockquote { margin:0 0 16px; padding:4px 0 4px 16px;
    border-left:3px solid #e5e7eb; color:#57606a; }
  .email hr { border:none; border-top:1px solid #e5e7eb; margin:24px 0; }
  .email code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:14px;
    background:#f4f4f5; padding:1px 5px; border-radius:4px; }
  .signature { margin-top:28px; font-size:14px; line-height:1.5; }
  .signature a { text-decoration:none; }
  .footer { max-width:640px; margin:0; padding:16px 24px 40px; text-align:left;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    font-size:12px; line-height:1.5; color:#8b949e; }
  .footer a { color:#8b949e; text-decoration:underline; }
  @media (max-width:480px) {
    .ds-display { font-size:34px !important; line-height:1.1 !important; }
    .ds-sec-lg { padding:28px 20px !important; }
    .ds-sec-md { padding:22px 18px !important; }
    .ds-cta-link { display:block !important; }
  }
</style>`;

/**
 * A styled email DOCUMENT around pre-rendered HTML with NO signature, footer, or
 * unsubscribe link — for internal/operator mail (e.g. the SEO Snapshot review email) and
 * for previewing legacy fragment-only bodies. Same typography as emailShell().
 */
export function emailDocument(innerHtml: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${EMAIL_STYLES}
</head>
<body>
<div class="email">
${innerHtml}
</div>
</body>
</html>`;
}

/** Plain-text alternative (markdown reads fine as text) with signature + unsubscribe. */
export function renderEmailText(markdownBody: string, opts: RenderOpts = {}): string {
	const reminder = (opts.originNote ?? '').trim()
		? `\nYou're receiving this email because: ${opts.originNote!.trim()}`
		: '';
	const unsub = opts.unsubscribe === false ? '' : `\n\n—${reminder}\nUnsubscribe: ${UNSUB_PLACEHOLDER}`;
	const sig = signatureText(opts.signature);
	return `${markdownBody.trim()}${sig ? `\n\n${sig}` : ''}${unsub}`;
}

export type MergeRecipient = {
	email: string;
	name?: string | null;
	first_name?: string | null;
	last_name?: string | null;
	company?: string | null;
	/** #170: {{company.*}} values (companyMergeFields). Absent/null = no linked company. */
	companyFields?: Record<string, string> | null;
	/** #515: {{form:<slug>}} → `<formBase>/f/<slug>?c=<formToken>`. No base = the tag is left as is. */
	formBase?: string | null;
	formToken?: string | null;
};

const COMPANY_KEYS: readonly string[] = COMPANY_MERGE_KEYS;

/**
 * Replace the unsubscribe placeholder and {{merge}} tags for one recipient.
 * `html` escapes values in text and keeps href/src attribute-safe (http(s)/mailto
 * only when a tag is the entire URL). Default `text` inserts the raw value.
 */
export function personalize(
	template: string,
	unsubUrl: string,
	r: MergeRecipient,
	opts?: { mode?: TemplateMode }
): string {
	const first = (r.first_name ?? '').trim() || 'there';
	const last = (r.last_name ?? '').trim();
	const full =
		(r.name ?? '').trim() || [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || first;
	const values: Record<string, string> = {
		first_name: first,
		last_name: last,
		name: full,
		company: (r.company ?? '').trim(),
		email: r.email
	};
	const mode = opts?.mode ?? 'text';
	// #515: the prefilled form link, before the other tags (its URL has no merge-tag meaning).
	if (r.formBase) template = fillFormTags(template, r.formBase, r.formToken);
	const resolve = (token: string): string | null => {
		if (Object.prototype.hasOwnProperty.call(values, token)) return values[token];
		// #170: {{company.<key>|fallback}} — blank (or the fallback) when unset / no company.
		const ct = parseCompanyToken(token);
		if (!ct || !COMPANY_KEYS.includes(ct.key)) return null;
		const value = (r.companyFields?.[ct.key] ?? '').trim();
		if (value) return value;
		// #553: in HTML the fallback is template text, which the renderers may already have
		// escaped (`&quot;x&quot; &amp; Co`); unescape it once so applyMergeTokens escapes it
		// exactly once. A no-op for a fallback without entities.
		return mode === 'html' ? unescapeHtmlText(ct.fallback) : ct.fallback;
	};
	if (mode !== 'html') return applyMergeTokens(template, mode, resolve).split(UNSUB_PLACEHOLDER).join(unsubUrl);
	const prepared = normalizeCompanyTokens(template, resolve);
	const filled = applyMergeTokens(prepared.html, mode, prepared.resolve);
	return filled.split(UNSUB_PLACEHOLDER).join(unsubUrl);
}

/** #553: characters that end an HTML attribute value or open a tag (backtick: old IE quoting). */
const ATTR_BREAKERS = /["'<>`]/;

/** #553: HTML-escape a fallback that will never be filled, so it stays inert text. Existing
 *  entities are kept (`&amp;` is not written as `&amp;amp;`). */
function escapeInertFallback(s: string): string {
	return s
		.replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[\da-fA-F]+;)/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/`/g, '&#96;');
}

/**
 * #553: before the HTML merge pass, make sure applyMergeTokens never meets a `"`, `'`, `<`,
 * `>` or backtick inside a `{{company.<key>|fallback}}` token. Its attribute scan ends an
 * href / src at the first quote, so such a token (restored raw into a markdown link by the
 * merge-tag shield, or decoded there from `%7B%7B…%7D%7D` by evaluateConditionals or by
 * applyMergeTokens itself) is cut in half, never filled, and its quotes split the attribute.
 *
 * - A token that gets a value is swapped for an alias token with a plain fallback; the
 *   returned resolver maps the alias back to the real token, so the engine fills it through
 *   its normal paths: escaped once in text, percent-encoded (or URL-checked) in an href.
 * - A token nothing fills gets its fallback HTML-escaped (raw form) or stays percent-encoded
 *   (`%257B`, encoded form), so it is left as inert text and never ends an attribute.
 * Tokens without those characters, and everything else, are untouched.
 */
function normalizeCompanyTokens(
	html: string,
	resolve: (token: string) => string | null
): { html: string; resolve: (token: string) => string | null } {
	const aliases = new Map<string, string>(); // alias token → real token
	const aliasOf = new Map<string, string>(); // real token → alias token
	let mark = 'pmk553x';
	while (html.includes(mark)) mark += 'x';
	const alias = (token: string): string => {
		let a = aliasOf.get(token);
		if (a === undefined) {
			a = `${token.slice(0, token.indexOf('|'))}|${mark}${aliasOf.size}`;
			aliasOf.set(token, a);
			aliases.set(a, token);
		}
		return `{{${a}}}`;
	};
	// A token the engine would fill: its company-token shape (fallback ≤ 80 chars) and a value.
	const fills = (token: string): boolean =>
		/^company\.[a-z0-9_]+\|[^{}|]{0,80}$/.test(token) && resolve(token) !== null;

	let out = html;
	// Raw tokens, wherever they sit (a token holds no `{`, `}` or second `|`, so this cannot run
	// past one, even inside an attribute its own quote has already ended). Same bound as the
	// engine's token pattern, so only tokens it would act on are touched.
	if (out.includes('{{company.')) {
		out = out.replace(/\{\{(company\.[a-z0-9_]+)\|([^{}|]{0,80})\}\}/g, (full, head: string, fallback: string) => {
			if (!ATTR_BREAKERS.test(fallback)) return full;
			const token = `${head}|${fallback}`;
			return fills(token) ? alias(token) : `{{${head}|${escapeInertFallback(fallback)}}}`;
		});
	}
	// Percent-encoded tokens in href / src: the same attribute and token patterns
	// applyMergeTokens decodes with, so exactly the tokens it would decode are seen here.
	if (/%7B%7B/i.test(out)) {
		out = out.replace(/(\b(?:href|src)\s*=\s*)(["'])([\s\S]*?)\2/gi, (_full, pre: string, q: string, val: string) => {
			const next = val.replace(/%7B%7B([\w:%#.\- ]*?)%7D%7D/gi, (enc, inner: string) => {
				let text: string;
				try {
					text = decodeURIComponent(inner);
				} catch {
					return enc; // undecodable: applyMergeTokens keeps it encoded too
				}
				if (!/["'<>{}`]/.test(text)) return enc;
				return fills(text) ? alias(text) : enc.replace(/%7B/gi, '%257B');
			});
			return pre + q + next + q;
		});
	}
	if (aliases.size === 0) return { html: out, resolve };
	return { html: out, resolve: (token) => resolve(aliases.get(token) ?? token) };
}

/** Per-recipient subject / HTML / text, in the same order the send path uses:
 *  conditionals (field tags + {{#if}}), then name/email merge tags. HTML is escaped;
 *  subject and plain text are not. */
export function fillRecipientTemplates(
	parts: { subject: string; html: string; text: string },
	unsubUrl: string,
	recipient: MergeRecipient,
	condCtx: CondCtx | null
): { subject: string; html: string; text: string } {
	const subj = condCtx ? evaluateConditionals(parts.subject, condCtx) : parts.subject;
	const html = condCtx ? evaluateConditionals(parts.html, condCtx, { mode: 'html' }) : parts.html;
	const text = condCtx ? evaluateConditionals(parts.text, condCtx) : parts.text;
	return {
		subject: personalize(subj, unsubUrl, recipient),
		html: personalize(html, unsubUrl, recipient, { mode: 'html' }),
		text: personalize(text, unsubUrl, recipient)
	};
}

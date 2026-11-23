// #531: one Content-Security-Policy for the public pages rendered from member-authored content on
// the app origin — hosted pages (/p/[slug]) and the newsletter archive (/newsletter,
// /newsletter/[slug]; not feed.xml). The renderers emit no script, so none may run. Styles are
// inline (PAGE_CSS + style attributes); `https:` styles and fonts are for raw-HTML newsletter
// issues, which render in a `sandbox=""` srcdoc iframe that inherits this policy and may load web
// fonts. Images from anywhere; same-origin frames and form posts only. No frame-ancestors:
// public content may be framed (app-wide framing is #540).
export const PUBLIC_PAGE_CSP = [
	"default-src 'none'",
	"script-src 'none'",
	"style-src 'unsafe-inline' https:",
	'img-src http: https: data:',
	'font-src https: data:',
	'media-src https:',
	"frame-src 'self'",
	"form-action 'self'",
	"base-uri 'none'",
	"object-src 'none'"
].join('; ');

/** The headers every public page route sends with its HTML. */
export const PUBLIC_PAGE_HEADERS = {
	'Content-Security-Policy': PUBLIC_PAGE_CSP,
	'X-Content-Type-Options': 'nosniff'
} as const;

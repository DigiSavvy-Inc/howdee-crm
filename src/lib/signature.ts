// Email signature (#594) + merge-tag definitions. Client- and server-safe (no server-only
// imports) so the compose preview and Settings → Signature can render it too.
//
// The signature is a setting (app_state `email_signature_html` / `_text`, read by
// `getSignature` in $lib/server/email-signature). Unset = no signature and no wrapper.

/** The stored signature: HTML for the HTML part, plain text for the text part. */
export type EmailSignature = { html: string; text: string };

/** Signature HTML, or '' when none is set. */
export function signatureHtml(sig: EmailSignature | null | undefined): string {
	return (sig?.html ?? '').trim();
}

/** Plain-text signature, or '' when none is set. */
export function signatureText(sig: EmailSignature | null | undefined): string {
	return (sig?.text ?? '').trim();
}

/** Limits for Settings → Signature. */
export const SIGNATURE_MAX = 20_000;

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeUrl(url: string): string | null {
	const u = url.trim();
	return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

/** One line of simple text → HTML: **bold**, *italic* / _italic_, [label](url) (http(s) / mailto). */
function inlineHtml(line: string): string {
	const parts: string[] = [];
	const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	const fmt = (s: string) =>
		escHtml(s)
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
			.replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');
	while ((m = re.exec(line))) {
		parts.push(fmt(line.slice(last, m.index)));
		const href = safeUrl(m[2]);
		parts.push(href ? `<a href="${escHtml(href)}">${fmt(m[1])}</a>` : fmt(m[0]));
		last = m.index + m[0].length;
	}
	parts.push(fmt(line.slice(last)));
	return parts.join('');
}

/** Settings → Signature's simple editor: one line per row (blank line = a gap), with
 *  **bold**, *italic* and [label](https://…) links. */
export function simpleSignatureHtml(source: string): string {
	const lines = source.replace(/\r\n?/g, '\n').trim().split('\n');
	if (!lines.join('').trim()) return '';
	return `<div>${lines.map((l) => (l.trim() ? `<div>${inlineHtml(l.trimEnd())}</div>` : '<div><br></div>')).join('')}</div>`;
}

/** The plain-text version of the simple editor's source: formatting dropped, links as
 *  "label: url" (mailto: left off). */
export function simpleSignatureText(source: string): string {
	return source
		.replace(/\r\n?/g, '\n')
		.trim()
		.split('\n')
		.map((l) =>
			l
				.trimEnd()
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
					const clean = url.replace(/^mailto:/i, '');
					return label.trim() === clean ? clean : `${label}: ${clean}`;
				})
				.replace(/\*\*(.+?)\*\*/g, '$1')
				.replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1$2')
				.replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1$2')
		)
		.join('\n');
}

/** Merge variables available in the composer. */
export const MERGE_TAGS = [
	{ tag: '{{first_name}}', desc: "Recipient's first name (falls back to “there”)" },
	{ tag: '{{name}}', desc: "Recipient's full name" },
	{ tag: '{{last_name}}', desc: "Recipient's last name" },
	{ tag: '{{email}}', desc: "Recipient's email address" },
	{ tag: '{{company}}', desc: "Recipient's company / org (blank if unset)" },
	{ tag: '{{field:tier}}', desc: 'Any custom field by name (blank if unset)' },
	{ tag: '{{form:your-form}}', desc: 'Link to a published form (#515), signed for each contact: their email is filled in and hidden. Use the form’s address' },
	{ tag: '{{company.name}}', desc: 'Linked company name (#170) — add a fallback with {{company.name|your team}}' },
	{ tag: '{{company.hours_30d}}', desc: 'Company hours tracked, last 30 days (also hours_7d / hours_90d / hours_total)' },
	{ tag: '{{company.issues_open}}', desc: 'Company open GitHub issues (also issues_opened_30d / issues_closed_30d)' },
	{ tag: '{{company.last_tracked_title}}', desc: 'Title of the latest Timing entry (also last_tracked_at, last_issue_at, domain, website)' },
	{
		tag: '{{#if tag:hot}}…{{else}}…{{/if}}',
		desc: 'Conditional content: tag:name, !tag:name, field:name, field:name == "value", >, <'
	}
];

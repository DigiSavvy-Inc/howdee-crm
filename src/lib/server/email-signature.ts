// #594: the email signature as a setting. app_state keys:
//   email_signature_html   — the HTML appended to every email (sanitised on save)
//   email_signature_text   — the plain-text part's signature
//   email_signature_source — the simple editor's text (absent = edited as HTML)
// Neither html nor text set = no signature (and no empty wrapper in the email).
// Migration 0121 seeds the signature our install sent before this became a setting.
import { sanitizeEmailHtml } from './gmail';
import { htmlToText } from '$lib/email-text';
import { SIGNATURE_MAX, simpleSignatureHtml, simpleSignatureText, type EmailSignature } from '$lib/signature';

export const SIGNATURE_KEYS = {
	html: 'email_signature_html',
	text: 'email_signature_text',
	source: 'email_signature_source'
} as const;

export type SignatureSetting = { html: string; text: string; source: string | null };

async function readKeys(db: D1Database): Promise<Map<string, string>> {
	const { results } = await db
		.prepare('SELECT key, value FROM app_state WHERE key IN (?, ?, ?)')
		.bind(SIGNATURE_KEYS.html, SIGNATURE_KEYS.text, SIGNATURE_KEYS.source)
		.all<{ key: string; value: string | null }>();
	return new Map(results.map((r) => [r.key, r.value ?? '']));
}

/** The signature to append to emails, or null when none is set. */
export async function getSignature(db: D1Database): Promise<EmailSignature | null> {
	const m = await readKeys(db);
	const html = (m.get(SIGNATURE_KEYS.html) ?? '').trim();
	const text = (m.get(SIGNATURE_KEYS.text) ?? '').trim();
	return html || text ? { html: m.get(SIGNATURE_KEYS.html) ?? '', text: m.get(SIGNATURE_KEYS.text) ?? '' } : null;
}

/** Everything Settings → Signature needs (source = null: last saved as HTML). */
export async function getSignatureSetting(db: D1Database): Promise<SignatureSetting> {
	const m = await readKeys(db);
	return {
		html: m.get(SIGNATURE_KEYS.html) ?? '',
		text: m.get(SIGNATURE_KEYS.text) ?? '',
		source: m.has(SIGNATURE_KEYS.source) ? (m.get(SIGNATURE_KEYS.source) ?? '') : null
	};
}

/** Pasted signature HTML made safe for an email body: the shared email sanitiser plus
 *  document wrappers, <style>, comments and media tags a signature has no use for. */
export function sanitizeSignatureHtml(html: string): string {
	return sanitizeEmailHtml(html)
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(style|title|head|svg|video|audio)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<\/?(html|head|body|!doctype|style|svg|video|audio|source|input|button|textarea|select)\b[^>]*>/gi, '')
		.trim();
}

export type SignatureInput = { mode: 'simple' | 'html'; source: string; html: string; text: string };

/** Validate + normalise what the settings form posted. A blank signature clears it. */
export function buildSignature(input: SignatureInput): { ok: true; value: SignatureSetting } | { ok: false; error: string } {
	const raw = input.mode === 'simple' ? input.source : input.html;
	if (raw.length > SIGNATURE_MAX || input.text.length > SIGNATURE_MAX) {
		return { ok: false, error: `The signature is too long (max ${SIGNATURE_MAX.toLocaleString('en-US')} characters).` };
	}
	if (input.mode === 'simple') {
		const source = input.source.replace(/\r\n?/g, '\n').trim();
		const text = input.text.replace(/\r\n?/g, '\n').trim() || simpleSignatureText(source);
		return { ok: true, value: { html: simpleSignatureHtml(source), text: source ? text : '', source } };
	}
	const html = sanitizeSignatureHtml(input.html);
	const text = input.text.replace(/\r\n?/g, '\n').trim() || (html ? htmlToText(html).trim() : '');
	return { ok: true, value: { html, text: html ? text : input.text.trim(), source: null } };
}

/** Store the signature; empty html and text = no signature (keys removed). */
export async function saveSignature(db: D1Database, s: SignatureSetting): Promise<void> {
	const put = (k: string, v: string) =>
		db
			.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
			.bind(k, v);
	const del = (k: string) => db.prepare('DELETE FROM app_state WHERE key = ?').bind(k);
	if (!s.html.trim() && !s.text.trim()) {
		await clearSignature(db);
		return;
	}
	await db.batch([
		put(SIGNATURE_KEYS.html, s.html),
		put(SIGNATURE_KEYS.text, s.text),
		s.source === null ? del(SIGNATURE_KEYS.source) : put(SIGNATURE_KEYS.source, s.source)
	]);
}

export async function clearSignature(db: D1Database): Promise<void> {
	await db
		.prepare('DELETE FROM app_state WHERE key IN (?, ?, ?)')
		.bind(SIGNATURE_KEYS.html, SIGNATURE_KEYS.text, SIGNATURE_KEYS.source)
		.run();
}

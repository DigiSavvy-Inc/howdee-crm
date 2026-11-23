// Webhook delivery for scheduled assistant jobs (#303): the SSRF guard, the two payload
// formats (json, slack), the Luma-style signature and the POST itself (10 s timeout, one
// retry on a 5xx or a network failure, redirects never followed). The signing secret is
// never logged and never appears in an error message.

import type { PayloadFormat } from '$lib/ai-jobs';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const SIGNATURE_HEADER = 'X-DS-Signature';

// ---- SSRF guard ----
// Moved to the universal $lib/webhook-url (#620: the form webhook validates it in the browser too).
export { webhookUrlProblem, WEBHOOK_URL_MAX } from '$lib/webhook-url';
import { webhookUrlProblem } from '$lib/webhook-url';

// ---- signature ----

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` — the same shape as Luma's header. */
export async function signatureHeader(secret: string, body: string, unix: number): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${unix}.${body}`)));
	return `t=${unix},v1=${toHex(sig)}`;
}

// ---- Markdown → plain text / Slack mrkdwn ----

function isTableLine(line: string): boolean {
	return /^\s*\|.*\|\s*$/.test(line);
}

/** Markdown with the markup removed (for `output_text`). Tables keep their rows. */
export function stripMarkdown(md: string): string {
	return md
		.split('\n')
		.filter((l) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)) // table separators
		.map((l) =>
			l
				.replace(/^\s*```.*$/, '')
				.replace(/^#{1,6}\s+/, '')
				.replace(/^(\s*)[*+]\s+/, '$1- ')
				.replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, t: string, u: string) => (t && t !== u ? `${t} (${u})` : u))
				.replace(/(\*\*|__)(.+?)\1/g, '$2')
				.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
				.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
				.replace(/~~(.+?)~~/g, '$1')
				.replace(/`([^`]+)`/g, '$1')
		)
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function slackEscape(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slackInline(line: string): string {
	const BOLD = '\u0001';
	return slackEscape(line)
		.replace(/^#{1,6}\s+(.+)$/, `${BOLD}$1${BOLD}`)
		.replace(/^(\s*)[-*+]\s+/, '$1• ')
		.replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, t: string, u: string) => (t ? `<${u}|${t}>` : `<${u}>`))
		.replace(/(\*\*|__)(.+?)\1/g, `${BOLD}$2${BOLD}`)
		.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
		.replace(/~~(.+?)~~/g, '~$1~')
		.replaceAll(BOLD, '*');
}

/** Markdown → Slack mrkdwn: bold, bullets, links, headings as bold; a table becomes a code
 *  block; fenced code passes through unchanged. */
export function toSlackMrkdwn(md: string): string {
	const out: string[] = [];
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			out.push('```');
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		if (isTableLine(line)) {
			const table: string[] = [];
			while (i < lines.length && isTableLine(lines[i])) table.push(lines[i++].trim());
			i--;
			out.push('```', ...table, '```');
			continue;
		}
		out.push(slackInline(line));
	}
	return out.join('\n').trim();
}

// ---- payloads ----

export type PayloadInput = {
	job: { id: number; name: string };
	run: { id: number | null; started_at: string; finished_at: string; status: string };
	model: string;
	output_markdown: string;
	cost_micros: number;
	app_url: string;
};

/** The request body for `format`. */
export function buildPayload(format: PayloadFormat, p: PayloadInput): string {
	if (format === 'slack') {
		const head = `*${slackEscape(p.job.name)}*`;
		return JSON.stringify({ text: `${head}\n${toSlackMrkdwn(p.output_markdown)}\n<${p.app_url}|Open in the app>` });
	}
	return JSON.stringify({
		job: p.job,
		run: p.run,
		model: p.model,
		output_markdown: p.output_markdown,
		output_text: stripMarkdown(p.output_markdown),
		cost_usd: Math.round(p.cost_micros) / 1_000_000,
		app_url: p.app_url
	});
}

/** The fixed sample "Send test payload" posts. */
export function samplePayload(job: { id: number; name: string }, appUrl: string, now: Date): PayloadInput {
	const at = now.toISOString().slice(0, 19).replace('T', ' ');
	return {
		job,
		run: { id: null, started_at: at, finished_at: at, status: 'test' },
		model: 'test',
		output_markdown:
			'## Test payload\n\nThis is a **test** from Settings → Assistant → Jobs. A real run posts the report here.\n\n- Bullet one\n- Bullet two\n\n| Metric | Value |\n| --- | --- |\n| Sent | 1,240 |\n| Opens | 38% |',
		cost_micros: 0,
		app_url: appUrl
	};
}

// ---- delivery ----

export type Delivery = { status: number | null; error: string | null };

/** POST `body` to `url`: guard re-checked first, 10 s timeout, one retry on a 5xx or a
 *  network failure, redirects returned as-is (never followed). */
export async function deliverWebhook(
	url: string,
	body: string,
	opts: { secret?: string | null; fetch?: typeof fetch; now?: Date; userAgent?: string } = {}
): Promise<Delivery> {
	const problem = webhookUrlProblem(url);
	if (problem) return { status: null, error: problem };
	const doFetch = opts.fetch ?? fetch;
	const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': opts.userAgent ?? 'ds-email-assistant-jobs/1' };
	if (opts.secret) headers[SIGNATURE_HEADER] = await signatureHeader(opts.secret, body, Math.floor((opts.now ?? new Date()).getTime() / 1000));
	let last: Delivery = { status: null, error: 'Not sent.' };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await doFetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
			await res.body?.cancel().catch(() => {});
			last = { status: res.status, error: res.status >= 200 && res.status < 300 ? null : `The webhook answered ${res.status}.` };
			if (res.status < 500) return last;
		} catch (e) {
			const name = e instanceof Error ? e.name : '';
			last = { status: null, error: name === 'TimeoutError' || name === 'AbortError' ? 'The webhook timed out (10 s).' : "Couldn't reach the webhook." };
		}
	}
	return last;
}

// Email delivery for scheduled assistant jobs (#390) — the parts that don't send: who may
// receive a job's report, and the email it becomes. The send itself lives OUTSIDE ai/
// (../job-email-send.ts) and is handed to runJob by the caller, so nothing under ai/ imports
// a sending module (tests/ai-no-send.test.ts) and the model never has a send tool.
//
// Recipient rule (enforced here, used by save AND send): a job's `email_admins` is a list of
// user ids plus optionally REVIEW_TO_KEY. At save, each id must be an ACTIVE ADMIN; anything
// else — a member, a missing user, an email address, a contact, a list — is refused. At send,
// addresses come only from `users.email` of ids that are still active admins, and from the
// REVIEW_TO env var. There is no way to pass a free-text address.

import { EMAIL_WORD_CAP, REVIEW_TO_KEY } from '$lib/ai-jobs';
import { DEFAULT_APP_NAME } from '$lib/branding';
import { escapeHtml, renderAssistantMarkdown } from '$lib/assistant-markdown';
import { emailDocument } from '../email';
import { stripMarkdown } from './jobs-webhook';

export type EmailSelection = (number | typeof REVIEW_TO_KEY)[];

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

/** The stored column → a selection (null = email off). Junk entries are dropped. */
export function parseEmailSelection(raw: string | null | undefined): EmailSelection | null {
	if (raw === null || raw === undefined || raw === '') return null;
	try {
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return null;
		return v.filter((x): x is number | typeof REVIEW_TO_KEY => x === REVIEW_TO_KEY || (Number.isInteger(x) && x > 0));
	} catch {
		return null;
	}
}

/** Submitted values (strings) → a selection, shape only: ids and REVIEW_TO_KEY, nothing else. */
export function selectionFromValues(values: string[]): { ok: true; value: EmailSelection } | { ok: false; error: string } {
	const out: EmailSelection = [];
	for (const raw of values.map((v) => v.trim()).filter(Boolean)) {
		if (raw === REVIEW_TO_KEY) {
			if (!out.includes(REVIEW_TO_KEY)) out.push(REVIEW_TO_KEY);
			continue;
		}
		if (!/^\d+$/.test(raw)) return { ok: false, error: 'Email recipients can only be admins of this CRM.' };
		const id = Number(raw);
		if (!out.includes(id)) out.push(id);
	}
	if (!out.length) return { ok: false, error: 'Choose at least one admin to email.' };
	return { ok: true, value: out };
}

export type AdminOption = { id: number; github_login: string; name: string | null; email: string | null };

/** Active admins — the only users a report may be emailed to. */
export async function adminRecipientOptions(db: D1Database): Promise<AdminOption[]> {
	const rows = await db
		.prepare(`SELECT id, github_login, name, email FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY github_login COLLATE NOCASE`)
		.all<AdminOption>();
	return rows.results;
}

/** Server-side check at save: every id must be an active admin. */
export async function checkEmailSelection(db: D1Database, sel: EmailSelection): Promise<string | null> {
	const admins = new Set((await adminRecipientOptions(db)).map((a) => a.id));
	for (const v of sel) if (v !== REVIEW_TO_KEY && !admins.has(v)) return 'Email recipients can only be active admins of this CRM.';
	return null;
}

/** The default selection: every admin with an email address, and REVIEW_TO. */
export async function defaultEmailSelection(db: D1Database): Promise<EmailSelection> {
	const ids = (await adminRecipientOptions(db)).filter((a) => a.email && EMAIL_RE.test(a.email)).map((a) => a.id);
	return [...ids, REVIEW_TO_KEY];
}

/** #596: REVIEW_TO, else Settings → Default From (`defaultFrom`), else '' = not configured
 *  (that entry of a selection then resolves to nothing). Never a built-in address. */
export function reviewToAddress(env: { REVIEW_TO?: string } | undefined, defaultFrom?: string | null): string {
	return (env?.REVIEW_TO || '').trim() || (defaultFrom || '').trim();
}

/** Addresses for a selection, read at send time: only still-active admins with an email, and
 *  REVIEW_TO. Lowercased and de-duplicated. `skipped` = ids that resolved to nothing. */
export async function resolveEmailRecipients(
	db: D1Database,
	sel: EmailSelection,
	reviewTo: string
): Promise<{ addresses: string[]; skipped: number }> {
	const admins = new Map((await adminRecipientOptions(db)).map((a) => [a.id, a.email]));
	const out = new Set<string>();
	let skipped = 0;
	for (const v of sel) {
		const email = v === REVIEW_TO_KEY ? reviewTo : admins.get(v);
		if (email && EMAIL_RE.test(email.trim())) out.add(email.trim().toLowerCase());
		else skipped += 1;
	}
	return { addresses: [...out], skipped };
}

// ---- the email ----

/** Keep the first `cap` words, line breaks intact. */
export function capWords(md: string, cap = EMAIL_WORD_CAP): { text: string; trimmed: boolean } {
	let n = 0;
	for (const m of md.matchAll(/\S+/g)) {
		if (++n > cap) return { text: md.slice(0, m.index).trimEnd(), trimmed: true };
	}
	return { text: md, trimmed: false };
}

/** Monday of `now`'s week in `tz`, as "October 19, 2026". */
export function weekOf(now: Date, tz: string): string {
	let parts: Record<string, string>;
	try {
		parts = Object.fromEntries(
			new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
				.formatToParts(now)
				.map((p) => [p.type, p.value])
		);
	} catch {
		return weekOf(now, 'UTC');
	}
	const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
	const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
	const monday = new Date(local - ((dow + 6) % 7) * 86_400_000);
	return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(monday);
}

/** #596: `appName` = Settings → Branding's app name. */
export function jobEmailSubject(job: { name: string; schedule_kind: string }, now: Date, tz: string, appName: string = DEFAULT_APP_NAME): string {
	const app = appName.trim() || DEFAULT_APP_NAME;
	if (job.schedule_kind === 'weekly') return `${app} digest, week of ${weekOf(now, tz)}`;
	let day: string;
	try {
		day = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' }).format(now);
	} catch {
		day = now.toISOString().slice(0, 10);
	}
	return `${app}: ${job.name}, ${day}`;
}

// sendCampaignEmail fills {{merge}} tags and %%UNSUB_URL%%; the model's text must stay as written.
const inert = (s: string) => s.replace(/\{\{/g, '{​{').replace(/%%/g, '%​%');

const CELL = 'border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;';

/**
 * The model's Markdown → { subject, html, text }. HTML goes through the assistant's safe
 * renderer (raw HTML escaped, only http(s) links), app paths become absolute links to the
 * CRM, panel-only buttons are dropped. Trimmed to EMAIL_WORD_CAP words.
 */
export function renderJobEmail(a: {
	markdown: string;
	job: { name: string; schedule_kind: string };
	baseUrl: string;
	jobUrl: string;
	now: Date;
	timezone: string;
	/** Settings → Branding's app name, for the subject (#596). */
	appName?: string;
}): { subject: string; html: string; text: string; trimmed: boolean } {
	const base = a.baseUrl.replace(/\/+$/, '');
	const { text: capped, trimmed } = capWords(a.markdown);
	// Markdown links to app paths → absolute, so they work from a mail client.
	const md = capped.replace(/\]\(\s*(\/(?!\/)[^)\s]*)/g, `](${base}$1`);
	const body = renderAssistantMarkdown(md)
		.replace(/<button[\s\S]*?<\/button>/g, '')
		.replace(/<a href="([^"]*)" data-app-link/g, (_m, h: string) => `<a href="${escapeHtml(base)}${h.startsWith('/') ? '' : '/'}${h}"`)
		.replace(/<table>/g, '<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px;">')
		.replace(/<(th|td)( class="md-(left|right|center)")?>/g, (_m, tag: string, _c, align?: string) => `<${tag} style="${CELL}text-align:${align ?? 'left'};">`);
	const trimNote = trimmed ? `Trimmed to ${EMAIL_WORD_CAP.toLocaleString('en-US')} words. The full report is in the run history.` : '';
	const footer =
		`<hr style="border:0;border-top:1px solid #d0d7de;margin:24px 0 12px;">` +
		`<p style="color:#59636e;font-size:13px;">${trimNote ? `${escapeHtml(trimNote)} ` : ''}Sent by the scheduled assistant job “${escapeHtml(a.job.name)}” to the admins of this CRM. ` +
		`<a href="${escapeHtml(a.jobUrl)}">Manage it in Settings → Assistant → Jobs</a>.</p>`;
	const html = emailDocument(`<div>${body}${footer}</div>`);
	const plain = stripMarkdown(md)
		.replace(/<[^>]*>/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const text = `${plain}\n\n—\n${trimNote ? `${trimNote}\n` : ''}Sent by the scheduled assistant job "${a.job.name}" to the admins of this CRM.\nManage it: ${a.jobUrl}`;
	const subject = jobEmailSubject(a.job, a.now, a.timezone, a.appName);
	return { subject: inert(subject), html: inert(html), text: inert(text), trimmed };
}

export type EmailMessage = { subject: string; html: string; text: string };
export type EmailOutcome = { status: 'sent' | 'partial' | 'failed'; sent: number; error: string | null };

/** What runJob is handed to send a report: the selection (never addresses) + the message.
 *  Implemented in ../job-email-send.ts. */
export type JobEmailSender = (sel: EmailSelection, msg: EmailMessage) => Promise<EmailOutcome>;

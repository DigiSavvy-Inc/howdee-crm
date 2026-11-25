// The send half of #390: a scheduled assistant job's report emailed to admins. Lives outside
// src/lib/server/ai/ on purpose — the assistant's modules never import a sending module; the
// tick and Settings → Assistant → Jobs hand `jobEmailSender(...)` to runJob.
//
// Like the snapshot review emails (snapshot-review.ts): a direct campaign row, From
// REVIEW_FROM, the transactional stream, no open/link tracking, no unsubscribe footer.
// Recipients are resolved here from the selection (admin user ids + REVIEW_TO) by
// resolveEmailRecipients — the caller can't pass an address. One retry, only when the send
// threw or hit a network failure / timeout (#536: `Transport` results); a Postmark refusal is
// recorded, not retried.

import { sendCampaignEmail } from './send';
import { credentialError, mailSetup } from './mail';
import { fromAllowed, getSettings } from './settings';
import { resolveEmailRecipients, reviewToAddress, type EmailMessage, type EmailOutcome, type EmailSelection, type JobEmailSender } from './ai/jobs-email';

export type JobEmailEnv = {
	POSTMARK_TOKEN?: string;
	POSTMARK_STREAM_TX?: string;
	REVIEW_FROM?: string;
	REVIEW_TO?: string;
	SESSION_SECRET?: string;
};

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export async function sendJobEmail(
	db: D1Database,
	env: JobEmailEnv,
	baseUrl: string,
	sel: EmailSelection,
	msg: EmailMessage,
	deliver: typeof sendCampaignEmail = sendCampaignEmail
): Promise<EmailOutcome> {
	const fail = (error: string): EmailOutcome => ({ status: 'failed', sent: 0, error });
	const settings = await getSettings(db);
	// #596: REVIEW_FROM, else Settings → Default From — never a built-in address.
	const from = (env.REVIEW_FROM || settings.default_from || '').trim();
	if (!from) return fail('No sender configured: set REVIEW_FROM or Settings → General → Default From.');
	if (!EMAIL_RE.test(from)) return fail(`${env.REVIEW_FROM ? 'REVIEW_FROM' : 'Default From'} is not an email address.`);
	if (!fromAllowed(from, settings.approved_senders)) return fail(`From ${from} is not in Settings → Approved senders.`);
	const { provider: mail, creds } = await mailSetup(db, env);
	if (!mail) return fail(credentialError(creds) ?? 'POSTMARK_TOKEN is not set.');
	const { addresses } = await resolveEmailRecipients(db, sel, reviewToAddress(env, settings.default_from));
	if (!addresses.length) return fail('No recipient has an email address (admins need one on their user record).');

	const campaign = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, sent_at)
			 VALUES (?, ?, ?, ?, NULL, ?, 'sending', datetime('now')) RETURNING id`
		)
		.bind(msg.subject, msg.text, msg.html, msg.text, from)
		.first<{ id: number }>();
	const campaignId = campaign!.id;
	const once = () =>
		deliver(db, {
			provider: mail,
			secret: env.SESSION_SECRET || 'unused',
			baseUrl,
			campaignId,
			recipients: addresses.map((email) => ({ id: null, email, name: null, first_name: null, last_name: null })),
			subject: msg.subject,
			htmlTemplate: msg.html,
			textTemplate: msg.text,
			from,
			stream: mail.streams.transactional,
			streamKind: 'transactional',
			trackOpens: false,
			trackLinks: 'None',
			unsubscribe: false,
			skipAlreadySent: true // #536: the retry only reaches whoever the first attempt missed
		});

	let result;
	try {
		try {
			result = await once();
			// #536: a network failure / timeout now comes back as `Transport` results instead of
			// a throw. The retry skips anyone the first attempt already reached.
			if (result.results?.some((r) => r.Transport)) result = await once();
		} catch {
			result = await once(); // the one retry
		}
	} catch (e) {
		const message = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
		await db.prepare(`UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?`).bind(message, campaignId).run();
		return fail(message);
	}
	const sent = result.accepted + (result.skipped ?? 0);
	const ok = sent > 0;
	await db
		.prepare('UPDATE campaigns SET status = ?, recipient_count = ?, error = ? WHERE id = ?')
		.bind(ok ? 'sent' : 'failed', sent, result.failed ? result.firstError : null, campaignId)
		.run();
	if (!ok) return fail(result.firstError ?? 'Postmark refused the email.');
	return { status: result.failed ? 'partial' : 'sent', sent, error: result.failed ? result.firstError : null };
}

/** The sender runJob / runDueJobs take. */
export function jobEmailSender(db: D1Database, env: JobEmailEnv, baseUrl: string): JobEmailSender {
	return (sel, msg) => sendJobEmail(db, env, baseUrl, sel, msg);
}

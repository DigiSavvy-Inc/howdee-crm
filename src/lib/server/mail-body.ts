// Gmail message bodies (#158) — fetched on demand when a message is expanded
// (users.messages.get format=full), never during sync. text/plain is preferred, else the
// HTML is sanitised (and still rendered in a script-less sandboxed iframe). Cached in R2 at
// mail/<account>/<gmail_id>.txt for 90 days; the body kind rides in customMetadata.

import { extractBody, getMessageFull, GmailError, type MessageBody } from './gmail';
import { accessTokenFor, type MailAccountRow, type MailEnv } from './mail-sync';

export const BODY_CACHE_DAYS = 90;

export const bodyKey = (accountId: number, gmailId: string) => `mail/${accountId}/${gmailId}.txt`;

export type BodyResult = { ok: true; body: MessageBody; cached: boolean } | { ok: false; status: number; error: string };

export async function loadMessageBody(
	db: D1Database,
	env: MailEnv,
	mailMessageId: number,
	opts: { media?: R2Bucket; fetch?: typeof fetch; now?: Date } = {}
): Promise<BodyResult> {
	const now = opts.now ?? new Date();
	const row = await db
		.prepare(
			`SELECT m.gmail_id, a.id, a.refresh_blob FROM mail_messages m
			 JOIN mail_accounts a ON a.id = m.account_id WHERE m.id = ?`
		)
		.bind(mailMessageId)
		.first<{ gmail_id: string } & Pick<MailAccountRow, 'id' | 'refresh_blob'>>();
	if (!row) return { ok: false, status: 404, error: 'Message not found.' };

	const key = bodyKey(row.id, row.gmail_id);
	if (opts.media) {
		const hit = await opts.media.get(key);
		if (hit && now.getTime() - hit.uploaded.getTime() < BODY_CACHE_DAYS * 86_400_000) {
			const kind = hit.customMetadata?.kind === 'html' ? 'html' : 'text';
			return { ok: true, body: { kind, body: await hit.text() }, cached: true };
		}
	}

	try {
		const fetchImpl = opts.fetch ?? fetch;
		const token = await accessTokenFor(row, env, fetchImpl, now);
		const body = extractBody(await getMessageFull(token, row.gmail_id, fetchImpl));
		if (opts.media) {
			await opts.media.put(key, body.body, {
				httpMetadata: { contentType: 'text/plain; charset=utf-8' },
				customMetadata: { kind: body.kind }
			});
		}
		return { ok: true, body, cached: false };
	} catch (e) {
		if (e instanceof GmailError && e.status === 404) return { ok: false, status: 404, error: 'Gone from Gmail.' };
		return { ok: false, status: 502, error: "Couldn't load this message from Gmail." };
	}
}

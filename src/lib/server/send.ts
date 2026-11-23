import { fillRecipientTemplates } from './email';
import { signUnsub } from './token';
import { sendBatch, type PostmarkMessage, type PostmarkResult } from './postmark';
import { buildCondCtx, hasConditionals } from '$lib/conditionals';
import { decorateLinks, loadLinkMatcher, type LinkMatcher } from './site-tracking';
import { signVisitorToken } from './track-token';
import { hasFormTags } from '$lib/form-embed';
import { hasCompanyTags } from '$lib/merge-tags';
import { companyMergeFields } from './company-metrics';
import { listUnsubscribeHeaders, unsubscribeProblems, UNSUB_REFUSED_PREFIX } from '$lib/list-unsubscribe';

export type SendableRecipient = {
	/** contacts.id, or null for an address with no contact record (1:1 to a stranger). */
	id: number | null;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company?: string | null;
	/** Comma-concatenated tag names + custom-field JSON — fuels per-recipient
	 *  conditional content (#62). Optional: senders without them get no conditionals. */
	tags?: string | null;
	meta?: string | null;
};

export type SendResult = {
	/** Newly accepted by Postmark in this call. */
	accepted: number;
	/** #536: recipients skipped because an earlier attempt already has an accepted row for
	 *  this campaign and pass (their result is ErrorCode 0, `ALREADY_SENT`). */
	skipped?: number;
	failed: number;
	firstError: string | null;
	/** Raw Postmark results, same order as `recipients`. Lets callers (e.g. the
	 *  automation engine) classify per-recipient ErrorCodes as hard vs transient. */
	results: PostmarkResult[];
};

export { listUnsubscribeHeaders, UNSUB_REFUSED_PREFIX };

/** #536: recipients per Postmark request = Postmark's batch limit, so each sendBatch call is
 *  exactly one request and its rows are written before the next one goes out. */
export const SEND_CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/**
 * Shared send path for broadcasts, 1:1 direct sends, and automation steps.
 *
 * Personalizes the (already-rendered) templates per recipient, sends them via Postmark
 * 500 at a time, and records one `recipients` row per recipient with its MessageID (the
 * webhook attribution key) right after its chunk returns (#536). Never throws on a Postmark
 * failure; with `skipAlreadySent`, a contact that already has an accepted row for this
 * campaign and pass is skipped, so calling it again after an interrupted send only sends to
 * the rest. Caller owns the `campaigns` row: create it first (so its
 * id can sign unsubscribe links), then update status/counts from the returned result.
 *
 * `unsubscribe: true` builds a per-recipient signed `/unsubscribe` URL and swaps the
 * `%%UNSUB_URL%%` placeholder, and adds the `List-Unsubscribe` / `List-Unsubscribe-Post`
 * one-click headers (#264); `false` uses an inert `#` (the no-footer template has no
 * placeholder anyway) and sends no unsubscribe headers.
 *
 * #373: with `unsubscribe: true` every message must carry its unsubscribe URL in the HTML
 * and the text and both headers — the broadcast stream uses custom unsubscribe handling, so
 * Postmark adds nothing. A message missing any of them is never handed to Postmark; it is
 * recorded as an error (`UNSUB_REFUSED_PREFIX`). 1:1 sends (`unsubscribe: false`) are exempt.
 */
export async function sendCampaignEmail(
	db: D1Database,
	opts: {
		token: string;
		secret: string;
		baseUrl: string;
		campaignId: number;
		recipients: SendableRecipient[];
		subject: string;
		htmlTemplate: string;
		textTemplate: string;
		from: string;
		stream: string;
		trackOpens?: boolean;
		trackLinks?: 'None' | 'HtmlAndText' | 'HtmlOnly' | 'TextOnly';
		unsubscribe?: boolean;
		/** Postmark inbound address (e.g. abc@inbound.postmarkapp.com). When set, each
		 *  message gets a per-recipient Reply-To `<local>+c<cid>r<contact>@<domain>` so a
		 *  reply's MailboxHash pins it to this campaign + contact (#38). */
		replyToInbound?: string;
		/** Explicit Reply-To. Wins over `replyToInbound` when both are set. */
		replyTo?: string;
		/** Bcc on every message (#159: the operator's copy of a conversation reply). */
		bcc?: string;
		/** Extra headers on every message (#159: In-Reply-To / References). */
		headers?: { Name: string; Value: string }[];
		/** #115: existing `recipients` row ids (same order as `recipients`) — the
		 *  best-time drain's claimed queue rows. Their message_id/status/error are filled
		 *  in place instead of inserting new rows. */
		recipientRowIds?: number[];
		/** #246: 'resend' stamps `recipients.send_pass` on the inserted rows (a resend to
		 *  non-openers). Omitted = NULL, which counts as the original send. */
		sendPass?: 'resend';
		/** #395: an automation step send — stamps `recipients.enrollment_id` (the pass) and
		 *  `enrollment_visit` (its jump_count) so the engine's already-sent guard is per visit. */
		enrollment?: { id: number; visit: number };
		/** #398: the A/B variant of an automation step send — stamps `recipients.ab_variant`. */
		abVariant?: 'a' | 'b';
		/** #536: skip recipients who already have an accepted row for this campaign's original
		 *  send (or this automation visit), so calling again after an interrupted send only
		 *  reaches the rest. Off by default: a caller that re-sends on purpose keeps doing so. */
		skipAlreadySent?: boolean;
	}
): Promise<SendResult> {
	const {
		token,
		secret,
		baseUrl,
		campaignId,
		recipients,
		subject,
		htmlTemplate,
		textTemplate,
		from,
		stream,
		trackOpens = true,
		trackLinks = 'HtmlAndText',
		unsubscribe = true,
		replyToInbound,
		replyTo: explicitReplyTo,
		bcc,
		headers,
		recipientRowIds,
		sendPass,
		enrollment,
		abVariant,
		skipAlreadySent = false
	} = opts;

	const inboundParts = replyToInbound ? replyToInbound.split('@') : null;
	const fixedReplyTo = explicitReplyTo?.trim() || '';
	// If the From carries a display name ("Jane Doe <jane@…>"), reuse it on the Reply-To so
	// mail clients show the person, not the raw tagged address.
	const fromName = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from)?.[1]?.trim() ?? '';

	// Conditional content (#62): only pay the per-recipient evaluation when the
	// template actually contains {{#if}} / {{field:}} constructs.
	const conditional = hasConditionals(htmlTemplate) || hasConditionals(textTemplate) || hasConditionals(subject);

	// Site tracking (#151): links to an enabled tracking site carry a per-contact `dsv=`
	// token. Best-effort — a failed lookup sends undecorated links, never fails the send.
	let linkMatcher: LinkMatcher | null = null;
	try {
		linkMatcher = await loadLinkMatcher(db);
	} catch (e) {
		console.error('site tracking link lookup failed:', e);
	}
	let appHost: string | null = null;
	try {
		appHost = new URL(baseUrl).hostname;
	} catch {
		appHost = null;
	}

	// #170: {{company.*}} values, loaded only when a template uses them.
	let companyFields = new Map<number, Record<string, string>>();
	if (hasCompanyTags(subject) || hasCompanyTags(htmlTemplate) || hasCompanyTags(textTemplate)) {
		companyFields = await companyMergeFields(db, recipients.map((r) => r.id));
	}

	// #515: {{form:<slug>}} prefilled form links, signed per contact only when a template uses one.
	const formTags = hasFormTags(subject) || hasFormTags(htmlTemplate) || hasFormTags(textTemplate);

	// #536: retry safety. Rows already written for this campaign and pass: an `accepted` one
	// means that contact got the email on an earlier (interrupted) attempt → skip it; an `error`
	// one becomes the accepted row when this attempt succeeds. Best-time rows
	// (`recipientRowIds`) were claimed by the caller and are filled in place as before.
	const results: PostmarkResult[] = new Array(recipients.length);
	const rowIds: (number | null)[] = recipients.map((_, i) => recipientRowIds?.[i] ?? null);
	const pending: number[] = [];
	let skipped = 0;
	// Opt-in (`skipAlreadySent`), and never for a resend: a campaign may be resent more than once
	// (#83), and resend rows carry no marker of which resend they belong to.
	const prior = skipAlreadySent && !recipientRowIds && sendPass !== 'resend' ? await priorRows(db, campaignId, enrollment) : null;
	recipients.forEach((r, i) => {
		const hit = prior ? ((r.id != null ? prior.get(`c:${r.id}`) : undefined) ?? prior.get(`e:${r.email.trim().toLowerCase()}`)) : undefined;
		if (hit?.status === 'accepted') {
			results[i] = { ErrorCode: 0, Message: ALREADY_SENT, ...(hit.message_id ? { MessageID: hit.message_id } : {}) };
			skipped++;
			return;
		}
		if (hit) rowIds[i] = hit.id;
		pending.push(i);
	});

	const messages: PostmarkMessage[] = new Array(recipients.length);
	const refused: (string | null)[] = new Array(recipients.length).fill(null);
	for (const i of pending) {
		const r = recipients[i];
		const unsubToken = unsubscribe
			? encodeURIComponent(await signUnsub(secret, { c: campaignId, k: r.id, e: r.email }))
			: null;
		const unsubUrl = unsubToken ? `${baseUrl}/unsubscribe?t=${unsubToken}` : '#';
		// #264: RFC 8058 one-click headers on every send that carries our unsubscribe link,
		// so Postmark's own footer link + headers can be switched off on the stream.
		const msgHeaders = [
			...(headers ?? []),
			...(unsubToken ? listUnsubscribeHeaders(`${baseUrl}/unsubscribe/one-click?t=${unsubToken}`) : [])
		];
		const replyAddr =
			inboundParts && inboundParts.length === 2
				? `${inboundParts[0]}+c${campaignId}r${r.id ?? 0}@${inboundParts[1]}`
				: undefined;
		// An explicit Reply-To (#108) wins; else the tagged inbound address, with the From's name.
		const replyTo = fixedReplyTo
			? fixedReplyTo
			: replyAddr
				? fromName ? `${fromName} <${replyAddr}>` : replyAddr
				: undefined;
		const ctx = conditional ? buildCondCtx(r.tags, r.meta) : null;
		// #515: {{form:<slug>}} = the form link signed for this contact (the `dsv=` link token).
		const formToken = formTags && r.id && secret ? await signVisitorToken(secret.trim(), { c: r.id }) : null;
		const filled = fillRecipientTemplates(
			{ subject, html: htmlTemplate, text: textTemplate },
			unsubUrl,
			{ ...r, companyFields: r.id ? companyFields.get(r.id) : null, ...(formTags ? { formBase: baseUrl, formToken } : {}) },
			ctx
		);
		if (linkMatcher && r.id && secret) {
			filled.html = decorateLinks(filled.html, linkMatcher, await signVisitorToken(secret.trim(), { c: r.id }), appHost);
		}
		messages[i] = {
			From: from,
			To: r.email,
			...(replyTo ? { ReplyTo: replyTo } : {}),
			...(bcc ? { Bcc: bcc } : {}),
			...(msgHeaders.length ? { Headers: msgHeaders } : {}),
			Subject: filled.subject,
			HtmlBody: filled.html,
			TextBody: filled.text,
			MessageStream: stream,
			TrackOpens: trackOpens,
			TrackLinks: trackLinks
		};
		const problems = unsubscribe ? unsubscribeProblems({ html: filled.html, text: filled.text, headers: msgHeaders }, unsubUrl) : [];
		refused[i] = problems.length ? `${UNSUB_REFUSED_PREFIX}: ${problems.join('; ')}.` : null;
	}
	if (refused.some(Boolean)) console.error(`campaign ${campaignId}: ${refused.filter(Boolean).length} message(s) refused, unsubscribe path incomplete`);

	const insert = db.prepare(
		`INSERT INTO recipients (campaign_id, contact_id, email, message_id, status, error, send_pass, enrollment_id, enrollment_visit, ab_variant)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const update = db.prepare(`UPDATE recipients SET message_id = ?, status = ?, error = ? WHERE id = ?`);
	let accepted = 0;
	let firstError: string | null = null;

	// #536: one Postmark request per chunk, and that chunk's rows are written right after it
	// returns — so mail that went out always has its row (MessageID = the webhook join key),
	// even when a later chunk fails or the Worker dies. A failed request (sendBatch reports it
	// as error results; a throw is caught here too) marks only its own chunk as errors.
	// #373: refused messages never go to Postmark.
	for (const part of chunk(pending, SEND_CHUNK)) {
		const toSend = part.filter((i) => !refused[i]);
		let sent: PostmarkResult[] = [];
		if (toSend.length) {
			try {
				sent = (await sendBatch(token, toSend.map((i) => messages[i]))) ?? [];
			} catch (e) {
				const why = `Postmark request failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
				sent = toSend.map(() => ({ ErrorCode: -1, Message: why, Transport: true }));
			}
		}
		toSend.forEach((i, k) => (results[i] = sent[k] ?? { ErrorCode: -1, Message: 'No response' }));
		const rows = part.map((i) => {
			const r = recipients[i];
			const res = refused[i] ? { ErrorCode: -1, Message: refused[i]! } : results[i];
			results[i] = res;
			const ok = res.ErrorCode === 0;
			if (ok) accepted++;
			else if (!firstError) firstError = res.Message ?? 'Unknown error';
			// A claimed best-time row is always filled in; an earlier attempt's error row is turned
			// into the accepted row when this attempt succeeds (one row per recipient), else a new
			// error row records this attempt too.
			const rowId = recipientRowIds ? rowIds[i] : ok ? rowIds[i] : null;
			if (rowId != null) return update.bind(res.MessageID ?? null, ok ? 'accepted' : 'error', ok ? null : res.Message, rowId);
			return insert.bind(
				campaignId,
				r.id,
				r.email,
				res.MessageID ?? null,
				ok ? 'accepted' : 'error',
				ok ? null : res.Message,
				sendPass ?? null,
				enrollment?.id ?? null,
				enrollment ? enrollment.visit : null,
				abVariant ?? null
			);
		});
		for (const rowPart of chunk(rows, 50)) await db.batch(rowPart);
	}

	return { accepted, skipped, failed: recipients.length - accepted - skipped, firstError, results };
}

/** Result message for a recipient skipped because an earlier attempt already sent to them. */
export const ALREADY_SENT = 'Already sent';

type PriorRow = { id: number; contact_id: number | null; email: string; status: string; message_id: string | null };

/** #536: this campaign's existing accepted / error rows for the same pass, keyed by
 *  `c:<contact id>` and `e:<lowercased email>` (an accepted row wins over an error one).
 *  Pass = the automation visit (enrollment + jump count) for step sends, else the original
 *  send (`send_pass` NULL / 'original'). */
async function priorRows(
	db: D1Database,
	campaignId: number,
	enrollment: { id: number; visit: number } | undefined
): Promise<Map<string, PriorRow>> {
	const [passSql, passBinds]: [string, number[]] = enrollment
		? ['enrollment_id = ? AND COALESCE(enrollment_visit, 0) = ?', [enrollment.id, enrollment.visit]]
		: ["(send_pass IS NULL OR send_pass = 'original') AND enrollment_id IS NULL", []];
	const rows = await db
		.prepare(
			`SELECT id, contact_id, email, status, message_id FROM recipients
			 WHERE campaign_id = ? AND status IN ('accepted', 'error') AND ${passSql}
			 ORDER BY id`
		)
		.bind(campaignId, ...passBinds)
		.all<PriorRow>();
	const map = new Map<string, PriorRow>();
	const put = (key: string, row: PriorRow) => {
		const seen = map.get(key);
		if (!seen || (seen.status !== 'accepted' && row.status === 'accepted')) map.set(key, row);
	};
	for (const row of rows.results) {
		if (row.contact_id != null) put(`c:${row.contact_id}`, row);
		put(`e:${String(row.email).trim().toLowerCase()}`, row);
	}
	return map;
}

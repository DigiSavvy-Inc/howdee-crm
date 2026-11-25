// One-off test sends — Compose's "Send test" (moved here from the compose action) and, since
// #396, an automation email step's "Send test". No campaign, no DB writes. A broadcast test
// carries the same unsubscribe link + List-Unsubscribe headers as the real send (#373) and is
// refused when they'd be incomplete.

import { companyMergeFields } from './company-metrics';
import { fillRecipientTemplates, UNSUB_PLACEHOLDER } from './email';
import { buildCondCtx } from '$lib/conditionals';
import type { TemplateRow } from './templates';
import { renderBody, renderBodyInTemplate, type ComposeBody } from './compose-body';
import { getSignature } from './email-signature';
import { signUnsub } from './token';
import { asMailProvider, streamFields, toMailResult, type MailProvider } from './mail';
import { listUnsubscribeHeaders, unsubscribeProblems, UNSUB_REFUSED_PREFIX } from '$lib/list-unsubscribe';

export type TestSendInput = {
	from: string;
	to: string;
	subject: string;
	body: ComposeBody;
	preheader: string;
	templateId?: number | null;
	/** A 1:1 test: no unsubscribe footer, no headers (like the real direct send). */
	direct?: boolean;
};

/** #700: `provider` = the active sending provider; without one, a Postmark adapter for `token`
 *  (the test then goes to the named `stream`, as before). */
export type TestSendEnv = { token?: string; stream: string; secret: string; baseUrl: string; provider?: MailProvider | null };

/** Render (template, merge tags, conditionals for the recipient's contact record) and send. */
export async function sendTestEmail(db: D1Database, env: TestSendEnv, input: TestSendInput): Promise<{ ok: true } | { ok: false; error: string }> {
	const { from, to: testTo, subject, body, preheader } = input;
	const isDirect = !!input.direct;

	// Personalize using the recipient's contact record if we have one.
	const contact = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.meta,
			        (SELECT GROUP_CONCAT(l.name) FROM list_members lm2 JOIN lists l ON l.id = lm2.list_id WHERE lm2.contact_id = c.id AND l.kind = 'tag') AS tags
			 FROM contacts c WHERE c.email = ?`
		)
		.bind(testTo.toLowerCase())
		.first<{ id: number; email: string; name: string | null; first_name: string | null; last_name: string | null; company: string | null; meta: string | null; tags: string | null }>();
	const r = contact ?? { email: testTo };

	// #373: signed for the matching contact (if any), so a test's unsubscribe acts on that
	// contact exactly like a real send's; no contact → k null, the address alone.
	const t = encodeURIComponent(await signUnsub(env.secret, { c: null, k: contact?.id ?? null, e: testTo }));
	const unsubUrl = `${env.baseUrl}/unsubscribe?t=${t}`;
	// Broadcast tests carry the same one-click headers as the real send; 1:1 tests don't.
	const testHeaders = isDirect ? [] : listUnsubscribeHeaders(`${env.baseUrl}/unsubscribe/one-click?t=${t}`);

	// Tests honor the selected template (#64) so what you test is what sends.
	let testHtml: string;
	let testText: string;
	const tpl = input.templateId
		? await db
				.prepare('SELECT name, kind, blocks, html, use_global_header, use_global_footer, canvas FROM templates WHERE id = ?')
				.bind(input.templateId)
				.first<TemplateRow>()
		: null;
	if (tpl?.kind === 'builder') {
		({ html: testHtml, text: testText } = await renderBodyInTemplate(db, tpl, body, { preheader, unsubscribe: !isDirect }));
	} else if (tpl?.kind === 'html') {
		let raw = tpl.html ?? '';
		if (!raw.includes(UNSUB_PLACEHOLDER)) raw += `<div style="font-size:12px;color:#8b949e;">Unsubscribe: <a href="${UNSUB_PLACEHOLDER}">here</a></div>`;
		testHtml = raw;
		// #373: same text version as the real send, ending with the unsubscribe line.
		const stripped = raw.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 5000);
		testText = isDirect ? stripped : `${stripped}\n\nUnsubscribe: ${UNSUB_PLACEHOLDER}`;
	} else {
		({ html: testHtml, text: testText } = renderBody(body, { preheader, unsubscribe: !isDirect, signature: await getSignature(db) }));
	}

	// #170: {{company.*}} from the test address's contact, when it has a company.
	const companyFields = contact ? (await companyMergeFields(db, [contact.id])).get(contact.id) : null;
	const filled = fillRecipientTemplates(
		{ subject, html: testHtml, text: testText },
		unsubUrl,
		{ ...r, companyFields },
		buildCondCtx(contact?.tags, contact?.meta)
	);
	// #373: a test the real send would refuse (missing link / headers) isn't sent either.
	if (!isDirect) {
		const problems = unsubscribeProblems({ html: filled.html, text: filled.text, headers: testHeaders }, unsubUrl);
		if (problems.length) return { ok: false, error: `${UNSUB_REFUSED_PREFIX}: ${problems.join('; ')}.` };
	}
	const provider = env.provider ?? asMailProvider({ token: env.token, stream: env.stream }) ?? null;
	if (!provider) return { ok: false, error: 'Postmark error: no server token is set.' };
	const results = await provider.sendBatch([
		{
			from,
			to: testTo,
			...(testHeaders.length ? { headers: testHeaders.map((h) => ({ name: h.Name, value: h.Value })) } : {}),
			subject: `[TEST] ${filled.subject}`,
			html: filled.html,
			text: filled.text,
			...streamFields(provider, env.stream),
			tracking: { opens: false, links: 'none' }
		}
	]);

	const res = toMailResult(results[0]);
	if (!res || res.ErrorCode !== 0) return { ok: false, error: `${provider.label} error: ${res?.Message ?? 'no response'}` };
	return { ok: true };
}

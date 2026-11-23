import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { readComposeBody, renderBody, renderBodyInTemplate } from '$lib/server/compose-body';
import { getSignature } from '$lib/server/email-signature';
import type { TemplateRow } from '$lib/server/templates';

// #250: the visual editor's Desktop / Mobile preview. Session-gated (not in
// PUBLIC_PREFIXES); takes the compose form fields and returns the exact email document
// a send would store — same renderer as send / test send. Merge tags stay unfilled.
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		throw error(400, 'Expected form data.');
	}
	const body = readComposeBody(data);
	const preheader = String(data.get('preheader') ?? '').trim();
	const unsubscribe = String(data.get('direct') ?? '') !== '1';
	const templateId = Number(data.get('template_id')) || 0;

	const tpl = templateId
		? await db
				.prepare('SELECT name, kind, blocks, html, use_global_header, use_global_footer, canvas FROM templates WHERE id = ?')
				.bind(templateId)
				.first<TemplateRow>()
		: null;
	let html: string;
	if (tpl?.kind === 'builder') html = (await renderBodyInTemplate(db, tpl, body, { preheader, unsubscribe })).html;
	else if (tpl?.kind === 'html') html = tpl.html ?? '';
	else html = renderBody(body, { preheader, unsubscribe, signature: await getSignature(db) }).html;

	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
	});
};

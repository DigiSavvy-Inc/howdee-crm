import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { getForm } from '$lib/server/forms';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { embedScript, EMBED_SCRIPT_MAX_AGE } from '$lib/form-embed';
import { isAnswerType } from '$lib/forms';

/**
 * Forms (#515): the embed script for one published form. Public (`/f` is in PUBLIC_PREFIXES),
 * GET only, cached for EMBED_SCRIPT_MAX_AGE seconds (1 minute, #669: so an allowed-origins change
 * reaches the script soon; the frame header and the submit check apply it at once). Unknown / unpublished → a 404 with a comment body (a script tag
 * that 404s just does nothing).
 */
export const GET: RequestHandler = async (event) => {
	const slug = String(event.params.slug ?? '').toLowerCase();
	const db = getDB(event);
	const form = await getForm(db, slug);
	const headers = {
		'content-type': 'text/javascript; charset=utf-8',
		'x-content-type-options': 'nosniff'
	};
	if (!form || form.status !== 'published' || form.slug !== slug) {
		return new Response('/* form not found */\n', { status: 404, headers: { ...headers, 'cache-control': 'no-store' } });
	}
	const crmOrigin = new URL(await publicBaseUrlFor(event)).origin;
	const body = embedScript({
		slug: form.slug,
		name: form.spec.title || form.name,
		crmOrigin,
		allowed: form.spec.settings.allowed_origins,
		keys: form.spec.fields.filter((f) => isAnswerType(f.type)).map((f) => f.key)
	});
	return new Response(body, { status: 200, headers: { ...headers, 'cache-control': `public, max-age=${EMBED_SCRIPT_MAX_AGE}` } });
};

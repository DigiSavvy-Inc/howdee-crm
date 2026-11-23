import type { RequestHandler } from './$types';

// #136: the form-webhook keys page moved under Settings. Keep old bookmarks working
// (query string included). Not to be confused with the Postmark endpoint /api/webhook.
export const GET: RequestHandler = ({ url }) =>
	new Response(null, { status: 301, headers: { location: '/settings/webhooks' + url.search } });

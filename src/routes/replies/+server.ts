import type { RequestHandler } from './$types';

// #157: the Replies inbox became the Conversations tab. Keep old bookmarks working
// (query string included).
export const GET: RequestHandler = ({ url }) =>
	new Response(null, { status: 301, headers: { location: '/conversations' + url.search } });

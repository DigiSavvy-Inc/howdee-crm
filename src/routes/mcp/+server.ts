import type { RequestHandler } from '@sveltejs/kit';
import { handleMcpPost } from '$lib/server/mcp/server';

// #348: remote MCP server (Streamable HTTP, plain JSON responses). Bearer Data API key; the
// key's scope decides the tools. Public route (PUBLIC_PREFIXES + CSRF_EXEMPT + REDIRECT_EXEMPT).
export const POST: RequestHandler = (event) => handleMcpPost(event);

// No server-initiated SSE stream and no sessions: the transport says to answer 405.
const notAllowed: RequestHandler = () =>
	new Response(JSON.stringify({ error: 'Use POST with a JSON-RPC message.' }), {
		status: 405,
		headers: { allow: 'POST', 'content-type': 'application/json' }
	});
export const GET = notAllowed;
export const DELETE = notAllowed;

import type { RequestHandler } from '@sveltejs/kit';
import { handleDraftReply } from '$lib/server/ai/draft-reply';

// Draft reply in Conversations (#387): session-gated SSE — see $lib/server/ai/draft-reply.ts.
export const POST: RequestHandler = (event) => handleDraftReply(event);

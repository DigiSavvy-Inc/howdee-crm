import type { RequestHandler } from '@sveltejs/kit';
import { handleChat } from '$lib/server/ai/chat';

// The assistant's chat turn (#287): session-gated SSE — see $lib/server/ai/chat.ts.
export const POST: RequestHandler = (event) => handleChat(event);

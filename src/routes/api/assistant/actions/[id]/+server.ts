import type { RequestHandler } from '@sveltejs/kit';
import { handleAction } from '$lib/server/ai/chat';

// Undo / Approve / Cancel one of the signed-in user's assistant actions (#301) — see
// $lib/server/ai/chat.ts. Session-gated; someone else's action → 404.
export const POST: RequestHandler = (event) => handleAction(event);

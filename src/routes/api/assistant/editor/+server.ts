import type { RequestHandler } from '@sveltejs/kit';
import { handleEditorAsk } from '$lib/server/ai/editor-ask';

// Ask AI in the editor (#679): session-gated SSE — see $lib/server/ai/editor-ask.ts.
export const POST: RequestHandler = (event) => handleEditorAsk(event);

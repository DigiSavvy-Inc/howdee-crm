import type { LayoutServerLoad } from './$types';
import { brandingFor } from '$lib/server/branding';
import { brandKitFor } from '$lib/server/brand-kit';
import { panelSummary } from '$lib/server/suggestions/panel';
import { assistantVisible, draftReplyVisible, editorAskVisible, getAssistantConfig } from '$lib/server/ai/config';

export const load: LayoutServerLoad = async (event) => {
	const { locals, depends } = event;
	// #134: the nav-layout toggle invalidates this after saving the preference.
	depends('app:user');
	// #292: the assistant's header button + Cmd/Ctrl+J only for people Settings → Assistant
	// lets in (admins also while it's off). One app_state read, signed-in pages only.
	const db = event.platform?.env?.DB;
	const aiCfg = locals.user && db ? await getAssistantConfig(db) : null;
	const showAssistant = aiCfg ? assistantVisible(aiCfg, locals.user) : false;
	// #387: the Conversations Reply box's "Draft reply" (setting on + assistant access).
	const draftReply = aiCfg ? draftReplyVisible(aiCfg, locals.user) : false;
	// #679: "Ask AI" in the editors' selection bubble (setting on + assistant access).
	const editorAsk = aiCfg ? editorAskVisible(aiCfg, locals.user) : false;
	// #188: app name / short name / logo for the header, favicon, login page and tour.
	// #595: the brand kit (editor swatches + logos, ColorField) — signed-in pages only.
	const brandKit = locals.user ? await brandKitFor(event) : null;
	// #714: the suggestions pill — the count in this user's panel only (cards load on open).
	// null = the feature is off or not open to them. Never fails the page.
	let suggestions: Awaited<ReturnType<typeof panelSummary>> = null;
	if (locals.user && db) {
		try {
			suggestions = await panelSummary(db, locals.user);
		} catch {
			suggestions = null;
		}
	}
	return { authed: locals.authed, user: locals.user, showAssistant, draftReply, editorAsk, suggestions, branding: await brandingFor(event), brandKit };
};

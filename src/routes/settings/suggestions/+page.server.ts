import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getSuggestionsConfig } from '$lib/server/suggestions/config';
import { saveSuggestionsForm, suggestionsModelLine } from '$lib/server/suggestions/settings';
import { scorePicker } from '$lib/server/scoring/query';

// Settings → Suggestions (#715), admin-only (load + every action). Saving writes
// `app_state.suggestions_config` and asks the next heartbeat tick for a rules pass, so a
// threshold change lands on the next tick. Turning the feature off hides the panel at once
// (`suggestionViewer` reads the config on every request) and the tick does no suggestions work
// (`runSuggestions` → `{ off: true }`).

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = getDB(event);
	const cfg = await getSuggestionsConfig(db);
	return { cfg, scores: await scorePicker(db), modelLine: suggestionsModelLine(cfg) };
};

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const res = await saveSuggestionsForm(getDB(event), await event.request.formData());
		if (!res.ok) return fail(400, { problems: res.problems, values: res.values });
		return { saved: true, cfg: res.cfg, modelLine: suggestionsModelLine(res.cfg) };
	}
};

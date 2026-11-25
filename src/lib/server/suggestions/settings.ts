// Settings → Suggestions (#715): what the page shows and saves, kept out of the route so tests
// can call it. No send / engine / AI imports (the structural test in tests/suggestions-712 walks
// the suggestions graph).

import { suggestionsConfigFromForm, suggestionsConfigProblems, type ConfigProblem, type SuggestionsConfig } from '$lib/suggestions';
import { scorePicker } from '../scoring/query';
import { saveSuggestionsConfig } from './config';

/**
 * The model line. AI ranking and wording (#713) isn't built yet, so it always reads "Rules only",
 * with the reason. Once #713 adds the `suggestions` AI feature, this shows the model picked in
 * Settings → Assistant → Model per feature (or the default model).
 */
export function suggestionsModelLine(cfg: SuggestionsConfig): { model: string | null; text: string } {
	if (!cfg.use_ai) return { model: null, text: 'Use AI is off.' };
	return { model: null, text: 'AI ranking and wording are not available in this version yet.' };
}

export type SaveResult =
	| { ok: true; cfg: SuggestionsConfig }
	| { ok: false; problems: ConfigProblem[]; values: Record<string, unknown> };

/** Validate the posted form (every threshold in its range, an active score) and save it. */
export async function saveSuggestionsForm(db: D1Database, data: FormData): Promise<SaveResult> {
	const raw = suggestionsConfigFromForm((k) => {
		const v = data.get(k);
		return typeof v === 'string' ? v : null;
	});
	const problems = suggestionsConfigProblems(raw);
	if (raw.score_id !== null) {
		const active = (await scorePicker(db)).map((s) => s.id);
		if (!active.includes(raw.score_id as number)) problems.push({ path: 'score_id', message: 'Pick an active score.' });
	}
	if (problems.length) return { ok: false, problems, values: raw };
	return { ok: true, cfg: await saveSuggestionsConfig(db, raw) };
}

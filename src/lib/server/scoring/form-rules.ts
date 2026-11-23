// #621: "Submitted a CRM form" score rules — the reads the score editor and the form page need.
// Read-only; the engine (./engine) does the awarding.

import { normalizeFormSpec } from '$lib/forms';
import { answerQuestions, answerRulesText, parseFilter, type AnswerQuestion } from '$lib/scoring';

export type FormPicker = { id: number; name: string; archived: boolean; questions: AnswerQuestion[] };

/** Forms for the rule editor's picker (not archived, plus any in `keep`), each with its questions. */
export async function formPickers(db: D1Database, keep: number[] = []): Promise<FormPicker[]> {
	const res = await db
		.prepare(
			`SELECT id, name, status, spec FROM forms
			 WHERE status != 'archived' OR id IN (SELECT value FROM json_each(?))
			 ORDER BY name COLLATE NOCASE LIMIT 500`
		)
		.bind(JSON.stringify(keep.filter((n) => Number.isInteger(n) && n > 0)))
		.all<{ id: number; name: string; status: string; spec: string }>();
	return res.results.map((f) => ({
		id: f.id,
		name: f.status === 'archived' ? `${f.name} (archived)` : f.name,
		archived: f.status === 'archived',
		questions: answerQuestions(normalizeFormSpec(f.spec).fields)
	}));
}

export type FormScoreRule = {
	rule_id: number;
	score_id: number;
	score_name: string;
	score_status: string;
	points: number;
	active: boolean;
	label: string;
	/** True when the rule names this form; false = it counts any CRM form. */
	this_form: boolean;
	/** The answer conditions in words ('' = any answers). */
	conditions: string;
};

/** Score rules a submission of this form can earn points from: rules on this form, and rules on
 *  any CRM form. */
export async function formScoreRules(db: D1Database, formId: number, questions: AnswerQuestion[]): Promise<FormScoreRule[]> {
	const res = await db
		.prepare(
			`SELECT r.id, r.score_id, d.name, d.status, r.points, r.active, r.label, r.filter FROM score_rules r JOIN score_defs d ON d.id = r.score_id
			 WHERE r.kind = 'event' AND r.event_type = 'crm_form_submit'
			 ORDER BY d.position, d.id, r.position, r.id`
		)
		.all<{ id: number; score_id: number; name: string; status: string; points: number; active: number; label: string; filter: string | null }>();
	const out: FormScoreRule[] = [];
	for (const r of res.results) {
		const f = parseFilter(r.filter);
		if (f.form_id != null && Number(f.form_id) !== formId) continue;
		out.push({
			rule_id: r.id,
			score_id: r.score_id,
			score_name: r.name,
			score_status: r.status,
			points: r.points,
			active: !!r.active,
			label: r.label,
			this_form: f.form_id != null,
			conditions: answerRulesText(f.answers, questions)
		});
	}
	return out;
}

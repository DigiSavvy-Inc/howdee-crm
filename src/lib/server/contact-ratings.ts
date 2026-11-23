// Ratings a contact gave us (#589): one `contact_ratings` row per answered Rating question of a
// form submission that resolved to a contact. Kept after the submission is pruned (the link is
// nulled), deleted with the contact. No SvelteKit imports — the submit path, double opt-in's
// confirm and the contact page all use it.
import { ratingOf, type Answers, type FormField } from '$lib/forms';
import { isRatingStyle, type RatingStyle } from '$lib/form-rating';

/** One rating to store, before it has a contact / submission. Also the double opt-in intent
 *  shape (stored as JSON until the contact confirms). */
export type RatingInput = {
	form_id: number | null;
	field_key: string;
	question: string;
	value: number;
	low: number;
	high: number;
	style: RatingStyle;
};

/** The answered rating questions among `fields` (the shown ones), as rows to store. */
export function ratingsFromAnswers(formId: number, fields: FormField[], answers: Answers): RatingInput[] {
	const out: RatingInput[] = [];
	for (const f of fields) {
		if (f.type !== 'rating') continue;
		const v = answers[f.key];
		if (typeof v !== 'number' || !Number.isInteger(v)) continue;
		const r = ratingOf(f);
		if (v < r.min || v > r.max) continue;
		out.push({ form_id: formId, field_key: f.key, question: (f.label || f.key).slice(0, 300), value: v, low: r.min, high: r.max, style: r.style });
	}
	return out;
}

/** Bounded clean-up of a stored intent's ratings (double opt-in replays them later). */
export function cleanRatingInputs(raw: unknown): RatingInput[] {
	if (!Array.isArray(raw)) return [];
	const out: RatingInput[] = [];
	for (const x of raw.slice(0, 20)) {
		if (!x || typeof x !== 'object') continue;
		const o = x as Record<string, unknown>;
		const value = Number(o.value);
		const low = Number(o.low);
		const high = Number(o.high);
		if (![value, low, high].every(Number.isInteger) || low > high || value < low || value > high || high > 10 || low < 0) continue;
		if (!isRatingStyle(o.style)) continue;
		const formId = Number(o.form_id);
		out.push({
			form_id: Number.isInteger(formId) && formId > 0 ? formId : null,
			field_key: String(o.field_key ?? '').slice(0, 80),
			question: String(o.question ?? '').slice(0, 300),
			value,
			low,
			high,
			style: o.style
		});
	}
	return out;
}

export async function insertRatings(db: D1Database, contactId: number, rows: RatingInput[], submissionId: number | null = null): Promise<number> {
	if (!rows.length) return 0;
	await db.batch(
		rows.map((r) =>
			db
				.prepare(
					`INSERT INTO contact_ratings (contact_id, form_id, submission_id, field_key, question, value, low, high, style)
					 VALUES (?, (SELECT id FROM forms WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(contactId, r.form_id, submissionId, r.field_key, r.question, r.value, r.low, r.high, r.style)
		)
	);
	return rows.length;
}

export type ContactRatingRow = {
	id: number;
	form_id: number | null;
	form_name: string | null;
	submission_id: number | null;
	field_key: string;
	question: string;
	value: number;
	low: number;
	high: number;
	style: RatingStyle;
	created_at: string;
};

/** A contact's ratings, newest first (the contact page's Ratings card). */
export async function contactRatings(db: D1Database, contactId: number, limit = 50): Promise<ContactRatingRow[]> {
	const res = await db
		.prepare(
			`SELECT r.id, r.form_id, f.name AS form_name, r.submission_id, r.field_key, r.question, r.value, r.low, r.high, r.style, r.created_at
			   FROM contact_ratings r LEFT JOIN forms f ON f.id = r.form_id
			  WHERE r.contact_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`
		)
		.bind(contactId, limit)
		.all<ContactRatingRow>();
	return res.results;
}

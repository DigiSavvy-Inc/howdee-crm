// Forms: the Rating question (#589). Universal (no server imports, nothing from `$lib/forms`, which
// imports this). The settings a rating question carries, their lenient read and strict check, the
// choices both renderers draw (FormRenderer and the script-free plain renderer, #587), the inline
// SVG glyphs, the spoken label of each choice, and the CSS-only look shared by both renderers.
//
// The answer is a whole number. Stars and hearts run 1–5 or 1–10, faces are always 1–5, the
// number scale offers 1–5, 1–10 and 0–10.

export const RATING_STYLES = ['stars', 'hearts', 'faces', 'numbers'] as const;
export type RatingStyle = (typeof RATING_STYLES)[number];
export const RATING_STYLE_LABELS: Record<RatingStyle, string> = {
	stars: 'Stars',
	hearts: 'Hearts',
	faces: 'Faces',
	numbers: 'Number scale'
};

export type RatingScale = { min: number; max: number };
export const RATING_SCALES: Record<RatingStyle, RatingScale[]> = {
	stars: [
		{ min: 1, max: 5 },
		{ min: 1, max: 10 }
	],
	hearts: [
		{ min: 1, max: 5 },
		{ min: 1, max: 10 }
	],
	faces: [{ min: 1, max: 5 }],
	numbers: [
		{ min: 1, max: 5 },
		{ min: 1, max: 10 },
		{ min: 0, max: 10 }
	]
};

export type RatingSettings = {
	style: RatingStyle;
	min: number;
	max: number;
	/** Optional words under the lowest / highest end ("Not likely" … "Very likely"). */
	low_label: string;
	high_label: string;
};

export const RATING_LABEL_MAX = 60;

export const DEFAULT_RATING: RatingSettings = { style: 'stars', min: 1, max: 5, low_label: '', high_label: '' };

export const isRatingStyle = (v: unknown): v is RatingStyle => (RATING_STYLES as readonly unknown[]).includes(v);

export function scaleAllowed(style: RatingStyle, min: number, max: number): boolean {
	return RATING_SCALES[style].some((s) => s.min === min && s.max === max);
}

export const scaleLabel = (s: RatingScale) => `${s.min} to ${s.max}`;

/** Untrusted / stored JSON → settings. Junk → the defaults; a scale the style doesn't offer →
 *  that style's first scale. Never throws. */
export function normalizeRating(raw: unknown): RatingSettings {
	const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const style = isRatingStyle(o.style) ? o.style : DEFAULT_RATING.style;
	const min = Number(o.min);
	const max = Number(o.max);
	const scale = scaleAllowed(style, min, max) ? { min, max } : RATING_SCALES[style][0];
	const label = (v: unknown) => (typeof v === 'string' ? v : '').trim().slice(0, RATING_LABEL_MAX * 2);
	return { style, min: scale.min, max: scale.max, low_label: label(o.low_label), high_label: label(o.high_label) };
}

/** Problems with stored settings (the save check), `path` relative to the field. */
export function ratingProblems(r: RatingSettings): { path: string; message: string }[] {
	const out: { path: string; message: string }[] = [];
	if (!isRatingStyle(r.style)) out.push({ path: 'rating.style', message: 'Pick a rating style.' });
	else if (!scaleAllowed(r.style, r.min, r.max)) out.push({ path: 'rating.scale', message: `${RATING_STYLE_LABELS[r.style]} can’t use ${r.min} to ${r.max}.` });
	if (r.low_label.length > RATING_LABEL_MAX) out.push({ path: 'rating.low_label', message: `The low end label is over ${RATING_LABEL_MAX} characters.` });
	if (r.high_label.length > RATING_LABEL_MAX) out.push({ path: 'rating.high_label', message: `The high end label is over ${RATING_LABEL_MAX} characters.` });
	return out;
}

/** A posted value → a whole number inside the scale, or an error. Empty = no answer. */
export function coerceRating(r: RatingSettings, text: string): { value?: number; error?: string } {
	const t = text.trim();
	if (!t) return {};
	const bad = { error: `Pick a rating from ${r.min} to ${r.max}.` };
	if (!/^\d{1,3}$/.test(t)) return bad;
	const n = Number(t);
	return n >= r.min && n <= r.max ? { value: n } : bad;
}

const NOUN: Record<RatingStyle, string> = { stars: 'stars', hearts: 'hearts', faces: '', numbers: '' };
export const FACE_WORDS = ['Very unhappy', 'Unhappy', 'Neutral', 'Happy', 'Very happy'] as const;

/** "4 out of 5 stars", "Happy, 4 out of 5", "7 out of 10" (+ the end label at either end). */
export function ratingSpoken(r: RatingSettings, v: number): string {
	const noun = NOUN[r.style];
	let s = `${v} out of ${r.max}${noun ? ` ${noun}` : ''}`;
	if (r.style === 'faces') s = `${FACE_WORDS[Math.min(4, Math.max(0, v - 1))]}, ${s}`;
	if (v === r.min && r.low_label) s += ` (${r.low_label})`;
	if (v === r.max && r.high_label) s += ` (${r.high_label})`;
	return s;
}

/** "4 / 5" — the one-line text of an answer (answerText, CSV-free surfaces). */
export const ratingText = (v: number, r: Pick<RatingSettings, 'max'>) => `${v} / ${r.max}`;

export type RatingChoice = { value: number; spoken: string };
export function ratingChoices(r: RatingSettings): RatingChoice[] {
	const out: RatingChoice[] = [];
	for (let v = r.min; v <= r.max; v++) out.push({ value: v, spoken: ratingSpoken(r, v) });
	return out;
}

const STAR = 'M12 2.8l2.8 5.7 6.3.9-4.55 4.43 1.07 6.27L12 17.1l-5.62 2.96 1.07-6.27L2.9 9.4l6.3-.9z';
const HEART = 'M12 20.3s-7.4-4.5-9.1-9.1C1.7 7.8 3.9 4.6 7.2 4.6c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.3 0 5.5 3.2 4.3 6.6-1.7 4.6-9.1 9.1-9.1 9.1z';
const MOUTHS = ['M8 17 Q12 12.4 16 17', 'M8.5 16.4 Q12 14.2 15.5 16.4', 'M8.5 15.5 L15.5 15.5', 'M8.5 14.6 Q12 16.8 15.5 14.6', 'M8 14 Q12 19.2 16 14'];

/** The glyph of one choice as inline SVG markup (decorative: the label carries the words).
 *  Numbers have no glyph (''). Faces: index by value (1–5). */
export function ratingGlyph(style: RatingStyle, value: number, size = 28): string {
	const open = `<svg class="rt-g" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">`;
	if (style === 'stars') return `${open}<path d="${STAR}"/></svg>`;
	if (style === 'hearts') return `${open}<path d="${HEART}"/></svg>`;
	if (style === 'faces') {
		const m = MOUTHS[Math.min(4, Math.max(0, value - 1))];
		return `${open}<circle cx="12" cy="12" r="9.2"/><circle class="rt-eye" cx="9" cy="10" r="1"/><circle class="rt-eye" cx="15" cy="10" r="1"/><path class="rt-mouth" d="${m}"/></svg>`;
	}
	return '';
}

/** Whether a style fills every choice up to the picked one (stars, hearts) or marks only it. */
export const fillsUpTo = (style: RatingStyle) => style === 'stars' || style === 'hearts';

const esc = (s: unknown) =>
	String(s ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

export type RatingGroupOptions = {
	/** The radio group's name (the answer key). */
	name: string;
	/** The legend text (the question), escaped here. */
	legend: string;
	/** HTML appended inside the legend (the required mark) — trusted, not escaped. */
	legendSuffix?: string;
	required?: boolean;
	disabled?: boolean;
	/** The pre-picked value (prefill), if any. */
	checked?: number | null;
	/** id of the help text, for aria-describedby. */
	describedBy?: string;
	/** Extra class(es) on the fieldset (each renderer's own question class). */
	className?: string;
	autofocus?: boolean;
	/** HTML appended inside the fieldset after the ends (help, error) — trusted, not escaped. */
	after?: string;
};

/**
 * The rating question as HTML: a fieldset + legend, one visually hidden radio per choice inside a
 * label (glyph or number, plus the spoken label for screen readers), and the end labels. No script;
 * looks come from RATING_CSS. Both renderers use it, so the markup is identical.
 */
export function ratingGroupHtml(r: RatingSettings, o: RatingGroupOptions): string {
	const kind = r.style === 'numbers' ? 'rt-num' : r.style === 'faces' ? 'rt-faces' : 'rt-fill';
	const cls = [...new Set(['rt', kind, `rt-${r.style}`, o.className ?? ''])].filter(Boolean).join(' ');
	const opts = ratingChoices(r)
		.map((c, i) => {
			const attrs = [
				`type="radio"`,
				`name="${esc(o.name)}"`,
				`value="${c.value}"`,
				o.checked === c.value ? 'checked' : '',
				o.required ? 'required' : '',
				o.disabled ? 'disabled' : '',
				o.autofocus && i === 0 ? 'autofocus' : ''
			]
				.filter(Boolean)
				.join(' ');
			const face = r.style === 'numbers' ? `<span aria-hidden="true">${c.value}</span>` : ratingGlyph(r.style, c.value);
			return `<label class="rt-opt"><input ${attrs}>${face}<span class="rt-sr">${esc(c.spoken)}</span></label>`;
		})
		.join('');
	const ends =
		r.low_label || r.high_label ? `<div class="rt-ends" aria-hidden="true"><span>${esc(r.low_label)}</span><span>${esc(r.high_label)}</span></div>` : '';
	const described = o.describedBy ? ` aria-describedby="${esc(o.describedBy)}"` : '';
	return `<fieldset class="${cls}"${described}><legend>${esc(o.legend)}${o.legendSuffix ?? ''}</legend><div class="rt-opts">${opts}</div>${ends}${o.after ?? ''}</fieldset>`;
}

/**
 * The look of the rating group, CSS only (no script). Shared by FormRenderer (inside `.dsf`, wrapped
 * in `:global`) and the plain renderer's PLAIN_FORM_CSS. Uses the form's `--f-*` variables.
 *   .rt            the group (fieldset); `.rt-fill` when stars / hearts fill up to the pick
 *   .rt-opts       the row of choices (wraps on a phone)
 *   .rt-opt        one choice: a <label> holding a visually hidden radio + the glyph / number
 * Filling: a choice is "on" when its radio is checked, or (fill styles) when a later choice's is —
 * `:has(~ …)`, so the DOM keeps its natural 1 → 5 order for the keyboard and screen readers.
 */
export const RATING_CSS = `
.rt { border:0; margin:0; padding:0; min-width:0; display:flex; flex-direction:column; gap:6px; }
.rt-opts { display:flex; flex-wrap:wrap; gap:4px; }
.rt-opt { position:relative; display:inline-flex; align-items:center; justify-content:center; min-width:44px; min-height:44px;
  border-radius:var(--f-radius); color:var(--f-muted); cursor:pointer; font-size:16px; font-weight:600; line-height:1; }
.rt-opt input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }
.rt-opt .rt-g { fill:transparent; transition:fill .1s, color .1s; }
.rt-opt .rt-eye { fill:currentColor; stroke:none; }
.rt-opt .rt-mouth { fill:none; }
.rt-opt:has(input:focus-visible) { outline:2px solid var(--f-accent); outline-offset:2px; }
.rt-num .rt-opt { border:1px solid var(--f-border); background:var(--f-surface); color:var(--f-text); padding:0 6px; }
.rt-fill .rt-opt:has(input:checked), .rt-fill .rt-opt:has(~ .rt-opt input:checked),
.rt-fill .rt-opts:hover .rt-opt:hover, .rt-fill .rt-opts:hover .rt-opt:has(~ .rt-opt:hover) { color:var(--f-accent); }
.rt-fill .rt-opt:has(input:checked) .rt-g, .rt-fill .rt-opt:has(~ .rt-opt input:checked) .rt-g { fill:var(--f-accent); }
.rt-fill .rt-opts:hover .rt-opt:hover .rt-g, .rt-fill .rt-opts:hover .rt-opt:has(~ .rt-opt:hover) .rt-g { fill:color-mix(in srgb, var(--f-accent) 45%, transparent); }
.rt-faces .rt-opt:hover, .rt-faces .rt-opt:has(input:checked) { color:var(--f-accent); }
.rt-faces .rt-opt:has(input:checked) { border-radius:50%; background:color-mix(in srgb, var(--f-accent) 16%, transparent); box-shadow:inset 0 0 0 2px var(--f-accent); }
.rt-faces .rt-opt:has(input:checked) .rt-g { fill:color-mix(in srgb, var(--f-accent) 18%, transparent); }
.rt-num .rt-opt:hover { border-color:var(--f-accent); }
.rt-num .rt-opt:has(input:checked) { background:var(--f-accent); border-color:var(--f-accent); color:var(--f-on-accent); }
.rt-ends { display:flex; justify-content:space-between; gap:12px; font-size:13px; color:var(--f-muted); }
.rt-ends span:last-child { text-align:right; }
.rt-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
`;

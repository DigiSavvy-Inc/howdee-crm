// Draft reply in Conversations (#387): the vocabulary the Reply box and the server share —
// tones, quick actions, limits — plus Spanish detection for the "Translate to Spanish" offer.
// Universal (no server imports).

export const DRAFT_TONES = ['friendly', 'direct', 'formal'] as const;
export type DraftTone = (typeof DRAFT_TONES)[number];
export const TONE_LABELS: Record<DraftTone, string> = { friendly: 'Friendly', direct: 'Direct', formal: 'Formal' };

/** Quick actions on an existing draft. */
export const DRAFT_QUICK = ['shorter', 'longer', 'formal', 'spanish'] as const;
export type DraftQuick = (typeof DRAFT_QUICK)[number];
export const QUICK_LABELS: Record<DraftQuick, string> = {
	shorter: 'Shorter',
	longer: 'Longer',
	formal: 'More formal',
	spanish: 'Translate to Spanish'
};

/** The optional one-line instruction ("decline politely", "propose Tuesday"). */
export const INSTRUCTION_MAX = 200;
/** The current draft sent back for a quick action. */
export const DRAFT_TEXT_MAX = 8000;

export function isTone(v: unknown): v is DraftTone {
	return typeof v === 'string' && (DRAFT_TONES as readonly string[]).includes(v);
}
export function isQuick(v: unknown): v is DraftQuick {
	return typeof v === 'string' && (DRAFT_QUICK as readonly string[]).includes(v);
}

// Common function words that are (nearly) exclusive to one language. Short and stable on
// purpose: a heuristic for offering a translation, never for deciding anything else.
const ES = new Set(
	('de la que el en los las del por para con una su al es lo como más mas pero sus le ya este sí porque esta entre cuando muy sin ' +
		'sobre también tambien hastahay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto ' +
		'antes algunos qué unos yo otro otras otra él tanto esa estos mucho nada muchos cual poco ella estar estas algunas algo ' +
		'nosotros gracias hola saludos usted ustedes buenos buenas días dias tengo tiene quiero puede podemos necesito estoy está ' +
		'fue mañana semana correo favor pregunta reunión reunion')
		.split(' ')
);
const EN = new Set(
	('the and to of is you that it for on with this are be have we your will can thanks thank hi hello was not but at from ' +
		'they would there their what about which when just do if so my me our please could should been has had').split(' ')
);

/** True when `text` reads as Spanish: enough Spanish function words, clearly more than English ones. */
export function looksSpanish(text: string): boolean {
	const words = text.toLowerCase().match(/[a-záéíóúüñ]+/g) ?? [];
	if (words.length < 4) return false;
	let es = 0;
	let en = 0;
	for (const w of words) {
		if (ES.has(w)) es++;
		else if (EN.has(w)) en++;
	}
	if (/[ñ¿¡]/.test(text)) es += 2;
	return es >= 3 && es > en * 2 && es / words.length >= 0.15;
}

/** Whether the contact writes in Spanish: their newest reply with enough text decides. */
export function contactWritesSpanish(theirTexts: (string | null | undefined)[]): boolean {
	for (let i = theirTexts.length - 1; i >= 0; i--) {
		const t = (theirTexts[i] ?? '').trim();
		if ((t.match(/\S+/g) ?? []).length >= 4) return looksSpanish(t);
	}
	return false;
}

export function wordCount(text: string): number {
	return (text.match(/\S+/g) ?? []).length;
}

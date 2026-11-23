// #414: curated subscription topics — the public wording a topic list shows on the
// preference page, and the checks that keep internal names off it. Universal (the list
// editor's live preview, Settings → Unsubscribe page → Topics and the server all use it).

export const TOPIC_LABEL_MAX = 40;
export const TOPIC_BLURB_MAX = 120;

/** The `unsubscribes.reason` of a preference-page save with every topic unticked. */
export const PREFERENCES_REASON = 'preferences';

/** Internal naming an operator types by hand: `zz-archived · …`, `[merged] into …`,
 *  `Seg · …`, "archived". A name like that is never shown to a subscriber. */
const INTERNAL_MARKERS: RegExp[] = [
	/^\s*zz[\s\-_·.:]/i,
	/\[(merged|archived|old|deprecated|test)\]/i,
	/\barchived?\b/i,
	/^\s*seg(ment)?\s*[·:|-]/i,
	/·/
];

export function looksInternalName(name: string | null | undefined): boolean {
	const n = (name ?? '').trim();
	if (!n) return true;
	return INTERNAL_MARKERS.some((re) => re.test(n));
}

export type TopicSource = { name: string; topic_label: string | null; topic_blurb: string | null };

/** What the preference page shows for a topic list: label + blurb only, never `name` /
 *  `description`. No label → the name, unless it looks internal; then null (skipped). */
export function topicDisplay(t: TopicSource): { label: string; blurb: string | null } | null {
	const label = (t.topic_label ?? '').trim();
	const blurb = (t.topic_blurb ?? '').trim() || null;
	if (label) return { label, blurb };
	if (!looksInternalName(t.name)) return { label: t.name.trim(), blurb };
	return null;
}

export type TopicWarning = 'archived' | 'no_label' | 'empty';

export const TOPIC_WARNING_TEXT: Record<TopicWarning, string> = {
	archived: 'looks archived',
	no_label: 'no label',
	empty: '0 members'
};

/** Badges for Settings → Unsubscribe page → Topics. A topic with no label whose name looks
 *  internal is hidden from subscribers ("looks archived" + "no label"). */
export function topicWarnings(t: TopicSource & { members: number }): TopicWarning[] {
	const out: TopicWarning[] = [];
	if (looksInternalName(t.name)) out.push('archived');
	if (!(t.topic_label ?? '').trim()) out.push('no_label');
	if (!t.members) out.push('empty');
	return out;
}

/** The list editor's topic fields, trimmed and capped. Order: an integer 0–9999, else null. */
export function cleanTopicFields(raw: { label?: unknown; blurb?: unknown; order?: unknown }): {
	topic_label: string | null;
	topic_blurb: string | null;
	topic_order: number | null;
} {
	const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;
	const o = typeof raw.order === 'number' ? raw.order : typeof raw.order === 'string' && raw.order.trim() ? Number(raw.order) : NaN;
	return {
		topic_label: s(raw.label, TOPIC_LABEL_MAX),
		topic_blurb: s(raw.blurb, TOPIC_BLURB_MAX),
		topic_order: Number.isInteger(o) && o >= 0 && o <= 9999 ? o : null
	};
}

/** Compose's "This email belongs to topic …" value: '' = automatic (NULL), '0' = none, else an id. */
export function parseTopicChoice(v: unknown): number | null {
	const s = String(v ?? '').trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The preference page's topics block: none (hidden), one ("Keep receiving <Label>" next to
 *  "Unsubscribe from everything") or many (checkboxes + one Save button). */
export function topicLayout(count: number): 'none' | 'one' | 'many' {
	return count <= 0 ? 'none' : count === 1 ? 'one' : 'many';
}

/** "How it appears: Label — blurb" (plain text; the editor bolds the label itself). */
export function topicPreview(label: string, blurb: string | null): string {
	return blurb ? `${label} — ${blurb}` : label;
}

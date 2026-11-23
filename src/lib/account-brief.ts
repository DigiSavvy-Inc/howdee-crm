// Account briefs (#388) — the universal half: source tags and rendering. A brief's Markdown
// cites facts as `[tag]` (e.g. `[timing]`, `[reply 14 Oct]`); each tag is one of the sources
// the server handed the model (stored in company_briefs.sources_json). The UI turns a known
// tag into a small chip linking to the thing; an unknown tag stays plain text. The model's
// text goes through the assistant's safe Markdown renderer (#300) — raw HTML escaped, links
// only to app paths / http(s) — never straight into {@html}.

import { renderAssistantMarkdown } from './assistant-markdown';

export type BriefSource = {
	tag: string; // as cited, without brackets: "timing", "reply 14 Oct"
	href: string; // app path (or the record's https URL)
	label: string; // tooltip: what the source is
};

/** The title marker that the chip CSS keys on (`a[title^="Source: "]`). */
export const SOURCE_TITLE_PREFIX = 'Source: ';

// `[tag]` that is not already a link (`[x](…)`) or a reference (`[x][y]`), not an image.
const TAG_RE = /(?<!!)\[([^\][\n]{1,60})\](?![(\[:])/g;

function sourceMap(sources: readonly BriefSource[]): Map<string, BriefSource> {
	return new Map(sources.map((s) => [s.tag.trim().toLowerCase(), s]));
}

/** Replace known `[tag]`s with Markdown links titled "Source: …"; unknown ones are left as text. */
export function linkSourceTags(md: string, sources: readonly BriefSource[]): string {
	const map = sourceMap(sources);
	// Leave code spans and fences alone.
	return md
		.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part.replace(TAG_RE, (whole, tag: string) => {
						const s = map.get(tag.trim().toLowerCase());
						if (!s) return whole;
						const title = `${SOURCE_TITLE_PREFIX}${s.label}`.replace(/["\\]/g, '');
						return `[${tag.trim()}](${s.href.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`)} "${title}")`;
					})
		)
		.join('');
}

/** Safe HTML for a brief: source tags → chips, everything through the assistant renderer. */
export function renderBriefHtml(md: string, sources: readonly BriefSource[], appOrigins: readonly string[] = []): string {
	return renderAssistantMarkdown(linkSourceTags(md, sources), appOrigins);
}

/** Plain text (for a one-liner or a hover tooltip): tags and Markdown marks dropped. */
export function briefPlainText(md: string): string {
	return md
		.replace(/(?<!!)\[([^\][\n]{1,60})\](?!\()/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^#+\s*/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '• ')
		.replace(/[*_`]/g, '')
		.replace(/[ \t]+([.,;:])/g, '$1')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** "Generated 14 Oct, 09:12 UTC" style for a SQLite UTC datetime. */
export function generatedText(at: string | null | undefined): string {
	if (!at) return '';
	const d = new Date(`${at.replace(' ', 'T')}Z`);
	if (Number.isNaN(d.getTime())) return at;
	const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
	const time = d.toISOString().slice(11, 16);
	return `${date}, ${time} UTC`;
}

// "Exclude from this segment" on a dynamic segment (bulk bar, Data API): the selection is
// tagged and the segment gets a `tag is absent` rule for that tag. Universal — the bar names
// the tag in its confirm, `$lib/server/contact-bulk` creates it.

/** The exclusion tag for a segment, named after it (tag names are ≤ 60 chars). */
export function exclusionTagName(segmentName: string): string {
	return `excluded: ${segmentName.trim()}`.slice(0, 60);
}

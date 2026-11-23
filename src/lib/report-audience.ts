// Reports → audiences (#356): wording shared by the builder and the server actions.
// Pure, so the builder can explain itself without a round trip.

import type { ReportSpec } from '$lib/report-spec';

/** Entities whose results can become a list or segment of contacts. */
export function hasAudience(spec: Pick<ReportSpec, 'entity'>): boolean {
	return spec.entity === 'contacts' || spec.entity === 'companies';
}

/**
 * Why this report can't be saved as a live segment, in one line, or null when it can.
 * Mirrors `specToSegmentRules` (which returns null for the same cases) plus the
 * no-filter case: a segment with no rules would match every contact.
 */
export function liveSegmentBlocker(spec: ReportSpec): string | null {
	if (spec.entity === 'companies') {
		return "Company reports expand to each company's contacts, which a live segment can't follow yet. Save as a list instead.";
	}
	if (spec.entity !== 'contacts') return 'Only contact and company reports can be saved as contacts.';
	if (spec.thresholds?.minSent != null) {
		return `Thresholds like “at least ${spec.thresholds.minSent} sends” can't be expressed as a live segment yet. Save as a list instead.`;
	}
	if (spec.entityFilters?.length) {
		return "The report's extra contact filters can't be expressed as a live segment yet. Use filter rules instead, or save as a list.";
	}
	if (spec.timeRange && !('preset' in spec.timeRange && spec.timeRange.preset === 'all')) {
		return "A time range can't be expressed as a live segment yet. Save as a list instead.";
	}
	if (!spec.filters.rules.length) {
		return 'With no filters this report matches every contact. Add a filter to save a live segment, or save as a list.';
	}
	return null;
}

/** The description marker that links a group back to the saved report it came from. */
export function reportMarker(reportId: number): string {
	return `From report #${reportId}: `;
}

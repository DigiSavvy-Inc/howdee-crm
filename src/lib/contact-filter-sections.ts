/**
 * #583: how the Filters panel (`ContactFilters.svelte`) groups its controls — sections, the words
 * "Find a filter" matches for each control, and how many filters are active per section. Pure,
 * so the grouping is testable without rendering.
 */
import type { ContactsFilter } from '$lib/server/contacts-query';

export type FilterSectionKey = 'people' | 'engagement' | 'deliverability' | 'website' | 'pipeline';

/** Each control's label plus the words someone might type for it. */
export const FIELD_TEXT: Record<string, string> = {
	status: 'Status subscribed unsubscribed pending confirmation',
	in: 'In group list segment tag company',
	notin: 'Not in group exclude list segment tag company',
	source: 'Source contains import csv',
	added_from: 'Added from date',
	added_to: 'Added to date',
	created_days: 'Created within N days new',
	form: 'Submitted form forms submission',
	form_days: 'Submitted form in the last N days forms submission',
	company: 'Company contains',
	company_id: 'Company is',
	has_company: 'Has a company',
	tier: 'Engagement tier hot warm cool cold never new',
	opened_days: 'Last opened within N days',
	score: 'Score points',
	band: 'Score band',
	opened_n: 'Opened at least N of the last M sends',
	never_opened: 'Never opened',
	bounced: 'Bounced bounce hard',
	hygiene: 'Address hygiene invalid role typo',
	spam: 'Marked as spam complaint',
	topic_out: 'Opted out of topic preferences',
	campaign: 'Campaign recipients',
	visited: 'Visited path contains page website',
	visited_days: 'Visited in the last N days website',
	site: 'Site activity website tracking',
	pipeline: 'Pipeline stage deal board',
	metrics: 'Company metrics hours issues billing Timing GitHub Zoho'
};

export const FILTER_SECTIONS: { key: FilterSectionKey; title: string; fields: string[] }[] = [
	{
		key: 'people',
		title: 'People',
		fields: ['status', 'in', 'notin', 'source', 'added_from', 'added_to', 'created_days', 'form', 'form_days', 'company', 'company_id', 'has_company']
	},
	{ key: 'engagement', title: 'Engagement', fields: ['tier', 'opened_days', 'score', 'band', 'opened_n', 'never_opened'] },
	{ key: 'deliverability', title: 'Deliverability', fields: ['bounced', 'hygiene', 'spam', 'topic_out', 'campaign'] },
	{ key: 'website', title: 'Website', fields: ['visited', 'visited_days', 'site'] },
	{ key: 'pipeline', title: 'Pipeline and company data', fields: ['pipeline', 'metrics'] }
];

/** Case-insensitive: every typed word must appear in the control's text. Empty = everything. */
export function fieldMatches(field: string, find: string): boolean {
	const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const text = (FIELD_TEXT[field] ?? field).toLowerCase();
	return words.every((w) => text.includes(w));
}

/** Active filters per section. `toolbar` = status and "In group" live outside the panel. */
export function sectionActiveCounts(f: ContactsFilter, opts: { toolbar?: boolean } = {}): Record<FilterSectionKey, number> {
	const n = (...xs: unknown[]) => xs.filter(Boolean).length;
	return {
		people: n(
			!opts.toolbar && f.status !== (f.archived ? 'all' : 'active'), // #705: the default status
			!opts.toolbar && f.inGroup,
			f.notInGroup,
			f.source,
			f.addedFrom,
			f.addedTo,
			f.createdDays,
			f.form,
			f.company,
			f.companyId,
			f.hasCompany
		),
		engagement: n(f.tier, f.openedDays, f.score, f.band, f.openedN && f.openedOf, f.neverOpened),
		deliverability: n(f.bounced, f.hygiene, f.spam, f.topicOut, f.campaign),
		website: n(f.visited, f.site !== 'all'),
		pipeline: n(f.pipeline) + f.metrics.length
	};
}

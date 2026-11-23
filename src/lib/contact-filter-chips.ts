/**
 * #583: one removable chip per active `/contacts` filter, in words. Pure (no DB): the page
 * load resolves the names (groups, company, stages, topics, scores, campaign) and passes them in.
 *
 * A chip removes itself by dropping its `clear` params; a company-metric chip instead `set`s
 * `cm` to the conditions that stay. The search (`q`) and status have their own toolbar
 * controls (search box, status pills), so they get no chip.
 */
import type { ContactsFilter } from '$lib/server/contacts-query';
import { conditionLabel, encodeCondition } from '$lib/company-metrics';
import { TIER_LABELS } from '$lib/engagement-view';
import { HYGIENE_FILTER_LABELS } from '$lib/email-hygiene';

export type FilterChip = {
	/** Stable kind (`source`, `in`, `metric`, `bounced`, …) — tests and keys. */
	kind: string;
	label: string;
	/** URL params to drop when the chip is removed. */
	clear: string[];
	/** URL params to set instead (company metrics: the remaining conditions; '' = drop). */
	set?: Record<string, string>;
	/** Optional link inside the chip (the company page). */
	href?: string;
};

export type ChipNames = {
	groups?: { id: number; name: string; kind?: string }[];
	company?: { id: number; name: string } | null;
	stages?: { id: number; name: string }[];
	topics?: { id: number; label: string }[];
	scores?: { id: number; name: string }[];
	forms?: { id: number; name: string }[];
	campaignLabel?: string;
	billing?: boolean;
};

const KIND_WORD: Record<string, string> = { list: 'list', segment: 'segment', tag: 'tag', company: 'company' };
const SCORE_OPS: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };

/** The pipeline filter in words (null when unset). */
export function pipelineChipLabel(pipeline: ContactsFilter['pipeline'], stages: { id: number; name: string }[] = []): string | null {
	if (pipeline === 'any') return 'On the pipeline (any stage)';
	if (pipeline === 'none') return 'Not in pipeline';
	if (pipeline) return `Pipeline stage: ${stages.find((s) => s.id === pipeline)?.name ?? '(deleted stage)'}`;
	return null;
}

/** Kinds that the "Overview for: …" line lists after the core filters (the old delivery chips). */
export const DELIVERY_CHIP_KINDS = new Set([
	'bounced',
	'spam',
	'hygiene',
	'unsub_from',
	'cooled_days',
	'score',
	'band',
	'topic_out',
	'created_days',
	'form',
	'awaiting',
	'no_list',
	'campaign'
]);

export function contactFilterChips(f: ContactsFilter, names: ChipNames = {}): FilterChip[] {
	const chips: FilterChip[] = [];
	const group = (id: number, verb: string) => {
		const g = names.groups?.find((x) => x.id === id);
		const word = g?.kind ? KIND_WORD[g.kind] ?? 'group' : 'group';
		return `${verb} ${word}: ${g?.name ?? `#${id}`}`;
	};

	// People
	if (f.inGroup) chips.push({ kind: 'in', label: group(f.inGroup, 'In'), clear: ['in'] });
	if (f.notInGroup) chips.push({ kind: 'notin', label: group(f.notInGroup, 'Not in'), clear: ['notin'] });
	if (f.source) chips.push({ kind: 'source', label: `Source contains “${f.source}”`, clear: ['source'] });
	if (f.addedFrom || f.addedTo) {
		const label = f.addedFrom && f.addedTo ? `Added ${f.addedFrom} – ${f.addedTo}` : f.addedFrom ? `Added from ${f.addedFrom}` : `Added up to ${f.addedTo}`;
		chips.push({ kind: 'added', label, clear: ['added_from', 'added_to'] });
	}
	if (f.company) chips.push({ kind: 'company', label: `Company contains “${f.company}”`, clear: ['company'] });
	if (f.companyId) {
		const co = names.company;
		chips.push({
			kind: 'company_id',
			label: `Company: ${co?.name ?? `#${f.companyId} (deleted)`}`,
			clear: ['company_id'],
			href: co ? `/companies/${co.id}` : undefined
		});
	}
	if (f.hasCompany) chips.push({ kind: 'has_company', label: f.hasCompany === 'yes' ? 'Has a company' : 'No company', clear: ['has_company'] });

	// Engagement
	if (f.tier) chips.push({ kind: 'tier', label: `Tier: ${TIER_LABELS[f.tier]}`, clear: ['tier'] });
	if (f.openedDays) chips.push({ kind: 'opened_days', label: `Opened in the last ${f.openedDays} days`, clear: ['opened_days'] });
	if (f.neverOpened) chips.push({ kind: 'never_opened', label: 'Never opened', clear: ['never_opened'] });
	if (f.openedN && f.openedOf) {
		chips.push({ kind: 'opened_n', label: `Opened ${f.openedN} of the last ${f.openedOf} sends`, clear: ['opened_n', 'opened_of'] });
	}

	// Website
	if (f.visited) {
		const label = f.visitedDays ? `Visited “${f.visited}” in the last ${f.visitedDays} days` : `Visited “${f.visited}”`;
		chips.push({ kind: 'visited', label, clear: ['visited', 'visited_days'] });
	}
	if (f.site !== 'all') chips.push({ kind: 'site', label: f.site === 'any' ? 'Has site activity' : 'No site activity', clear: ['site'] });

	// Pipeline and company data
	const pipe = pipelineChipLabel(f.pipeline, names.stages);
	if (pipe) chips.push({ kind: 'pipeline', label: pipe, clear: ['pipeline'] });
	const codes = f.metrics.map((m) => encodeCondition(m));
	f.metrics.forEach((m, i) => {
		const rest = codes.filter((_, j) => j !== i).join(',');
		chips.push({ kind: 'metric', label: conditionLabel(m, { billing: !!names.billing }), clear: [], set: { cm: rest } });
	});

	// Deliverability, scores and the Overview tile filters (the order the "Overview for" line uses).
	if (f.bounced) chips.push({ kind: 'bounced', label: f.bounced === 'hard' ? 'Hard bounced' : 'Bounced', clear: ['bounced'] });
	if (f.spam) chips.push({ kind: 'spam', label: 'Marked as spam', clear: ['spam'] });
	if (f.hygiene) chips.push({ kind: 'hygiene', label: `Hygiene: ${HYGIENE_FILTER_LABELS[f.hygiene]}`, clear: ['hygiene'] });
	if (f.unsubFrom) chips.push({ kind: 'unsub_from', label: `Unsubscribed since ${f.unsubFrom}`, clear: ['unsub_from'] });
	if (f.cooledDays) chips.push({ kind: 'cooled_days', label: `Going cold (last ${f.cooledDays} days)`, clear: ['cooled_days'] });
	if (f.score) {
		const sc = names.scores?.find((x) => x.id === f.score!.scoreId);
		const cmp = f.score.op === 'between' ? `between ${f.score.n} and ${f.score.n2}` : `${SCORE_OPS[f.score.op]} ${f.score.n}`;
		chips.push({ kind: 'score', label: `${sc?.name ?? 'Score (deleted)'} ${cmp}`, clear: ['score'] });
	}
	if (f.band) {
		const sc = names.scores?.find((x) => x.id === f.band!.scoreId);
		chips.push({ kind: 'band', label: `${sc?.name ?? 'Score (deleted)'} band: ${f.band.label}`, clear: ['band'] });
	}
	if (f.topicOut) {
		const t = names.topics?.find((x) => x.id === f.topicOut);
		chips.push({ kind: 'topic_out', label: `Opted out of topic: ${t?.label ?? '(not a topic)'}`, clear: ['topic_out'] });
	}
	if (f.createdDays) chips.push({ kind: 'created_days', label: `Created in the last ${f.createdDays} days`, clear: ['created_days'] });
	// #516
	if (f.form) {
		const name = f.form === 'any' ? 'any form' : `form “${names.forms?.find((x) => x.id === f.form)?.name ?? '(deleted form)'}”`;
		const when = f.formDays ? ` in the last ${f.formDays} days` : '';
		chips.push({ kind: 'form', label: `Submitted ${name}${when}`, clear: ['form', 'form_days'] });
	}
	if (f.awaiting) {
		chips.push({
			kind: 'awaiting',
			label: f.awaitingDays ? `Awaiting our reply > ${f.awaitingDays} days` : 'Awaiting our reply',
			clear: ['awaiting', 'awaiting_days']
		});
	}
	if (f.noList) chips.push({ kind: 'no_list', label: 'In no list', clear: ['no_list'] });
	if (f.campaign) {
		chips.push({ kind: 'campaign', label: names.campaignLabel || `Recipients of campaign #${f.campaign}`, clear: ['campaign', 'campaign_who'] });
	}
	return chips;
}

/** The overrides a chip's × link applies (always resets the page). */
export function chipOverrides(c: FilterChip): Record<string, string | null> {
	const o: Record<string, string | null> = { page: null };
	for (const k of c.clear) o[k] = null;
	for (const [k, v] of Object.entries(c.set ?? {})) o[k] = v || null;
	return o;
}

// Dynamic segments (#66): compile a rule group into a parameterized SQL fragment that
// selects matching contact ids. Whitelisted fields/ops only; every value is a bound
// parameter (never interpolated) so rules can't inject SQL.

import { normalizeCondition } from '$lib/company-metrics';
import { metricClause } from './company-metrics';
import { isTier } from '$lib/engagement-view';
import { neverOpenedClause, openedWithinClause, opensInWindowClause, tierClause } from './engagement-query';
import { pipelineClause } from './pipeline-query';
import { bouncedClause, spamClause } from './bounce-filter';
import { proxyOpenSql } from './engagement';
import { scoreBandClause, scoreValueClause } from './scoring/query';
import { formSubmittedClause } from './form-reads';

export type SegmentRule = {
	field: string; // 'tag' | 'field' | 'subscribed' | 'source' | 'company' | 'opened' | 'clicked' | 'created' | 'visited' | 'event'
	//                #170: | 'company_id' (linked company) | 'company_metric'
	//                #114: | 'engagement_tier' | 'last_open_within_days' | 'opens_last_90d' | 'never_opened'
	//                #207: | 'pipeline_stage' (op is|not = stage id, any = on the board, none = not on it)
	//                #224: | 'list' (op in|not, value = a hand-picked group id)
	//                #279: | 'bounced' (op hard|any|none) | 'spam_complaint' (op yes|no)
	//                #448: | 'topic' (op out = opted out of that topic list, in = a member of it)
	//                #516: | 'form_submitted' (op yes|no, value = form id or blank = any, value2 = days)
	op: string;
	value?: string;
	// field:<name> rules: the custom-field key. visited/event rules (#153): the window in
	// days ("in the last N days"; blank = any time). company_metric rules (#170): the metric key.
	value2?: string;
	// #228: `DELETED_LIST` on a `list` rule whose group was deleted — never compiled.
	invalid?: string;
};

export type SegmentRules = {
	match: 'all' | 'any';
	rules: SegmentRule[];
};

export type CompiledSegment = { sql: string; binds: unknown[] };

function tagExists(negate: boolean): string {
	const inner = `SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id
		WHERE lm.contact_id = c.id AND l.kind = 'tag' AND l.name = ?`;
	return negate ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`;
}

// #412: an "opened" rule ignores Apple Mail / prefetch auto-opens (proxyOpenSql — the same
// rule as classifyProxyOpen); "clicked" counts every click.
function eventInWindow(type: 'open' | 'click', negate: boolean): string {
	const inner = `SELECT 1 FROM events ev WHERE ev.contact_id = c.id AND ev.type = '${type}'
		AND ev.recorded_at >= datetime('now', ?)${type === 'open' ? ` AND NOT ${proxyOpenSql('ev')}` : ''}`;
	return negate ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`;
}

// Site tracking (#153): a pageview whose path contains `value`, or a named custom event,
// optionally within the last N days. LIKE wildcards in the user's text are escaped.
function siteActivity(kind: 'pageview' | 'event', negate: boolean, windowed: boolean): string {
	const match = kind === 'pageview' ? `COALESCE(se.path, '') LIKE ? ESCAPE '\\'` : 'se.name = ?';
	const inner = `SELECT 1 FROM site_events se WHERE se.contact_id = c.id AND se.kind = '${kind}' AND ${match}${
		windowed ? ` AND se.occurred_at >= datetime('now', ?)` : ''
	}`;
	return negate ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`;
}

/** One rule → { clause, binds } over the alias `c` (contacts). Returns null for an
 *  unrecognized/empty rule (skipped). Also used per rule by Condition steps (#221). */
export function compileRule(r: SegmentRule): { clause: string; binds: unknown[] } | null {
	if (r.invalid) return null; // #228: a rule marked invalid (deleted list) is ignored
	const v = (r.value ?? '').trim();
	const days = Math.max(0, Math.floor(Number(v) || 0));

	switch (r.field) {
		case 'tag':
			if (!v) return null;
			return { clause: tagExists(r.op === 'not'), binds: [v] };

		// #224: in / not in a hand-picked group (list, hand-picked segment, company) by id —
		// what "Exclude these / Require this" on /lists/[id] appends. Stored rows only: a
		// dynamic segment id never matches. Condition steps compile their own `list` kind.
		case 'list': {
			if (r.op !== 'in' && r.op !== 'not') return null;
			const id = Number(v);
			if (!Number.isInteger(id) || id <= 0) return null;
			const inner = 'SELECT 1 FROM list_members lm WHERE lm.list_id = ? AND lm.contact_id = c.id';
			return { clause: r.op === 'not' ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`, binds: [id] };
		}

		case 'subscribed':
			return { clause: 'c.subscribed = ?', binds: [r.op === 'no' ? 0 : 1] };

		// #448: a preference-page topic (a public_topic list, by id). `out` = unticked it there
		// (topic_optouts); `in` = a member of the list (opting out drops the membership).
		case 'topic': {
			if (r.op !== 'out' && r.op !== 'in') return null;
			const id = Number(v);
			if (!Number.isInteger(id) || id <= 0) return null;
			const inner =
				r.op === 'out'
					? 'SELECT 1 FROM topic_optouts tpo WHERE tpo.list_id = ? AND tpo.contact_id = c.id'
					: 'SELECT 1 FROM list_members lm WHERE lm.list_id = ? AND lm.contact_id = c.id';
			return { clause: `EXISTS (${inner})`, binds: [id] };
		}

		// #516: submitted a form (value = form id, blank = any form; value2 = last N days, blank = ever).
		case 'form_submitted': {
			if (r.op !== 'yes' && r.op !== 'no') return null;
			const formId = v ? Number(v) : null;
			if (formId !== null && !(Number.isInteger(formId) && formId > 0)) return null;
			const w = (r.value2 ?? '').trim();
			const days = w ? Number(w) : null;
			if (days !== null && !(Number.isInteger(days) && days > 0)) return null;
			return formSubmittedClause('c.id', formId, days ? Math.min(days, 3650) : null, r.op === 'no');
		}

		case 'source':
			if (!v) return null;
			if (r.op === 'contains') return { clause: 'LOWER(COALESCE(c.source, \'\')) LIKE ?', binds: [`%${v.toLowerCase()}%`] };
			return { clause: 'LOWER(COALESCE(c.source, \'\')) = ?', binds: [v.toLowerCase()] };

		case 'company':
			if (r.op === 'exists') return { clause: "COALESCE(c.company, '') != ''", binds: [] };
			if (!v) return null;
			return { clause: 'LOWER(COALESCE(c.company, \'\')) = ?', binds: [v.toLowerCase()] };

		// #170: the linked companies row (contacts.company_id), not the free-text company.
		case 'company_id': {
			if (r.op === 'exists') return { clause: 'c.company_id IS NOT NULL', binds: [] };
			if (r.op === 'missing') return { clause: 'c.company_id IS NULL', binds: [] };
			const id = Number(v);
			if (!Number.isInteger(id) || id <= 0) return null;
			return { clause: 'c.company_id = ?', binds: [id] };
		}

		case 'company_metric': {
			const cond = normalizeCondition((r.value2 ?? '').trim(), r.op, v);
			return cond ? metricClause(cond, 'c.company_id') : null;
		}

		// Engagement (#114) — shared with the /contacts filters (engagement-query.ts).
		case 'engagement_tier':
			return isTier(v) ? tierClause(v, 'c.id', r.op === 'not') : null;

		case 'last_open_within_days':
			if (days <= 0) return null;
			return openedWithinClause(days, 'c.id', r.op === 'not');

		case 'opens_last_90d': {
			const n = Number(v);
			if (v === '' || !Number.isFinite(n) || n < 0) return null;
			return opensInWindowClause(r.op, Math.floor(n), 90, 'c.id');
		}

		case 'never_opened':
			return neverOpenedClause('c.id', r.op === 'no');

		// Scores (#467) — shared with the /contacts score / band filters (scoreValueClause).
		case 'score_value': {
			const scoreId = Number((r.value2 ?? '').trim());
			if (r.op === 'between') {
				const [lo, hi] = v.split(':').map((x) => x.trim());
				if (!lo || !hi) return null;
				return scoreValueClause(scoreId, 'between', Number(lo), 'c.id', Number(hi));
			}
			return v === '' ? null : scoreValueClause(scoreId, r.op, Number(v), 'c.id');
		}

		case 'score_band':
			return scoreBandClause(Number((r.value2 ?? '').trim()), v, 'c.id', r.op === 'not');

		// Pipeline (#207). `not` = not in that stage, INCLUDING contacts not on the board.
		case 'pipeline_stage': {
			if (r.op === 'any') return pipelineClause('any', 'c.id');
			if (r.op === 'none') return pipelineClause('none', 'c.id');
			if (r.op !== 'is' && r.op !== 'not') return null;
			const id = Number(v);
			if (!Number.isInteger(id) || id <= 0) return null;
			return pipelineClause(id, 'c.id', r.op === 'not');
		}

		// Deliverability (#279) — shared with the /contacts bounce/spam filters (bounce-filter.ts).
		case 'bounced':
			if (r.op === 'hard' || r.op === 'any') return bouncedClause(r.op, 'c.id');
			if (r.op === 'none') return bouncedClause('any', 'c.id', true);
			return null;

		case 'spam_complaint':
			return spamClause('c.id', r.op === 'no');

		case 'opened':
			return { clause: eventInWindow('open', r.op === 'not'), binds: [`-${days} days`] };

		case 'clicked':
			return { clause: eventInWindow('click', r.op === 'not'), binds: [`-${days} days`] };

		case 'created':
			if (r.op === 'within') return { clause: "c.created_at >= datetime('now', ?)", binds: [`-${days} days`] };
			if (r.op === 'before') return { clause: 'c.created_at < ?', binds: [v] };
			if (r.op === 'after') return { clause: 'c.created_at > ?', binds: [v] };
			return null;

		case 'visited':
		case 'event': {
			if (!v) return null;
			const n = Math.floor(Number((r.value2 ?? '').trim()) || 0);
			const windowed = n > 0;
			const match = r.field === 'visited' ? `%${v.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : v;
			const binds: unknown[] = [match];
			if (windowed) binds.push(`-${n} days`);
			return { clause: siteActivity(r.field === 'visited' ? 'pageview' : 'event', r.op === 'not', windowed), binds };
		}

		// Substring of a custom field, case-insensitive (the legacy field-contains gate; #448: in
		// segments too). A missing field reads as '' — so "does not contain" passes. Malformed meta = ''.
		case 'field_contains': {
			const name = (r.value2 ?? '').trim();
			if (!name || !v || (r.op !== 'contains' && r.op !== 'not')) return null;
			const text = `LOWER(COALESCE(CASE WHEN json_valid(c.meta) THEN CAST(json_extract(c.meta, ?) AS TEXT) END, ''))`;
			const path = `$."${name.replaceAll('"', '')}"`;
			const needle = v.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
			return {
				clause: `${text} ${r.op === 'not' ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '\\'`,
				binds: [path, `%${needle}%`]
			};
		}

		case 'field': {
			const name = (r.value2 ?? '').trim();
			if (!name) return null;
			const expr = 'json_extract(c.meta, ?)';
			const path = `$."${name.replaceAll('"', '')}"`;
			if (r.op === 'exists') return { clause: `${expr} IS NOT NULL`, binds: [path] };
			if (r.op === 'missing') return { clause: `${expr} IS NULL`, binds: [path] };
			if (!v) return null;
			// Numeric compare when the value is numeric; else string compare on the text form.
			const numeric = v !== '' && Number.isFinite(Number(v));
			const cast = numeric ? `CAST(${expr} AS REAL)` : `CAST(${expr} AS TEXT)`;
			const bound = numeric ? Number(v) : v;
			const opSql = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[r.op];
			if (!opSql) return null;
			return { clause: `${cast} ${opSql} ?`, binds: [path, bound] };
		}

		default:
			return null;
	}
}

/**
 * Compile a rule group to a SQL fragment selecting matching contact ids. The returned
 * `sql` is a full `SELECT c.id FROM contacts c WHERE …` (or selects all when the group is
 * empty), always excluding archived contacts (#280). Callers either run it directly or
 * embed `c.id IN (sql)`. Rules marked invalid
 * (#228, a deleted list) are left out; when they are ALL that's left, it selects nobody
 * rather than everybody.
 */
export function compileSegment(rules: SegmentRules | null | undefined, opts: { includeArchived?: boolean } = {}): CompiledSegment {
	const parts: string[] = [];
	const binds: unknown[] = [];
	let ignored = 0;
	for (const r of rules?.rules ?? []) {
		if (r.invalid) {
			ignored++;
			continue;
		}
		const c = compileRule(r);
		if (c) {
			parts.push(`(${c.clause})`);
			binds.push(...c.binds);
		}
	}
	const joiner = rules?.match === 'any' ? ' OR ' : ' AND ';
	const where = parts.length ? parts.join(joiner) : ignored ? '0=1' : '1=1';
	// #280: archived contacts are never in a dynamic segment (sends, counts, enroll,
	// branch conditions all resolve through here).
	// `includeArchived` (#535's restore guard only): who would match once restored.
	return { sql: `SELECT c.id FROM contacts c WHERE ${opts.includeArchived ? '' : 'c.archived_at IS NULL AND '}(${where})`, binds };
}

/**
 * A dynamic segment's membership as a predicate on a contacts id (#224) —
 * `<idExpr> IN (SELECT c.id …)` — so it can be AND'd to the `/contacts` filter
 * (`contactsWhere`, which runs over `contacts` with no alias).
 */
export function segmentMembershipSql(
	rules: SegmentRules | null | undefined,
	idExpr = 'contacts.id'
): { sql: string; params: unknown[] } {
	const c = compileSegment(rules);
	return { sql: `${idExpr} IN (${c.sql})`, params: c.binds };
}

/** Parse stored rules JSON defensively. Returns null for non-dynamic segments. */
export function parseRules(json: string | null | undefined): SegmentRules | null {
	if (!json) return null;
	try {
		const v = JSON.parse(json);
		if (v && typeof v === 'object' && Array.isArray(v.rules)) {
			return { match: v.match === 'any' ? 'any' : 'all', rules: v.rules };
		}
	} catch {
		/* malformed → treat as not-dynamic */
	}
	return null;
}

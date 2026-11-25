import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getMailProvider } from '$lib/server/mail';
import { parseRules, segmentMembershipSql, type SegmentRules } from '$lib/server/segment-query';
import {
	contactsFilterParams,
	contactsOrder,
	contactsWhere,
	isNarrowed,
	parseContactsFilter,
	type ContactsFilter
} from '$lib/server/contacts-query';
import { applyFilterRule, filterRuleOptions } from '$lib/server/segment-filter-rule';
import { listActiveAutomations } from '$lib/server/automations';
import {
	groupsOfIds,
	groupsOfQuery,
	runBulkForm,
	BULK_CAP,
	type BulkFormAction,
	type IdQuery
} from '$lib/server/contact-bulk';
import { emptyFilter, filterParams, isFiltered, memberQuery, parseFilter } from '$lib/server/contact-filter';
import { stageOptions } from '$lib/server/pipeline-query';
import { topicPicker } from '$lib/server/topics';
import { scorePicker } from '$lib/server/scoring/query';
import { fieldPicker } from '$lib/server/custom-fields';
import { formPicker } from '$lib/server/form-reads';
import { archiveGroups, archiveProblem, healDanglingListRules, loadArchiveChecks, restoreGroups } from '$lib/server/groups-bulk';
import { forPicker, ruleListIds } from '$lib/server/group-archive';
import { isDeletedListRule } from '$lib/condition-rules';
import { cleanTopicFields } from '$lib/topics';
import { canSeeBilling } from '$lib/server/integrations/zoho';
import {
	activeContactSql,
	hiddenArchivedSql,
	hiddenNote,
	hiddenUnsubscribedSql,
	rulesAskForSubscription,
	segmentAudienceSql
} from '$lib/server/active-audience';

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

const PER_OPTIONS = [25, 50, 100];

/** `count` = active stored members (#688, the bulk bar's pickers); 0 for a rules segment. */
type Group = { id: number; name: string; kind: string; created_at: string; dynamic: number; archived_at: string | null; count: number };
type GroupDetail = {
	id: number;
	name: string;
	kind: string;
	description: string | null;
	origin: string | null;
	rules: string | null;
	public_topic: number;
	topic_label: string | null;
	topic_blurb: string | null;
	topic_order: number | null;
	created_at: string;
	archived_at: string | null;
};
type MemberRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	subscribed: number;
	source: string | null;
	created_at: string;
	added_at: string | null;
};

/** Every list/segment/tag/company, for the filter dropdowns and the "add to" picker.
 *  `dynamic` = a rules-based segment (no list_members rows). #472: archived groups are left
 *  out unless `keep` names them (this group's rules / the current filter) — then "(archived)". */
async function allGroups(db: D1Database, keep: number[] = []): Promise<(Group & { archived: boolean })[]> {
	const res = await db
		.prepare(
			`SELECT id, name, kind, created_at, archived_at, (kind = 'segment' AND COALESCE(rules, '') != '') AS dynamic,
			        (SELECT COUNT(*) FROM list_members lm JOIN contacts c ON c.id = lm.contact_id AND ${activeContactSql('c')}
			          WHERE lm.list_id = lists.id) AS count
			 FROM lists ORDER BY name COLLATE NOCASE`
		)
		.all<Group>();
	return forPicker(res.results, keep);
}

/** #705: a group page only ever shows the active audience — the /contacts filter's ways to see
 *  unsubscribed (`status=all|unsubscribed`) or archived contacts don't apply here — unless the
 *  segment's own rules ask about subscription (then the rules decide: status `all`). */
function groupViewFilter(f: ContactsFilter, rules: SegmentRules | null = null): ContactsFilter {
	const status = f.status === 'subscribed' || f.status === 'pending' ? f.status : rulesAskForSubscription(rules) ? 'all' : 'active';
	return { ...f, status, archived: undefined };
}

/** #224: a dynamic segment's members narrowed by the /contacts filter — `WHERE …` over `contacts`. */
function dynamicWhere(rules: SegmentRules, f: ContactsFilter): { where: string; params: unknown[] } {
	const seg = segmentMembershipSql(rules);
	const rest = contactsWhere(groupViewFilter(f, rules));
	if (!rest.where) return { where: `WHERE ${seg.sql}`, params: seg.params };
	return { where: `WHERE ${seg.sql} AND (${rest.where.replace(/^WHERE\s+/, '')})`, params: [...seg.params, ...rest.params] };
}

/**
 * #214: "Remove from list" / "Remove tag" pickers only offer groups the selection is in —
 * per visible row for checked rows, aggregated over the whole view for "all matching".
 */
async function bulkPickers(db: D1Database, pageIds: number[], matched: number, all: IdQuery) {
	return {
		pageGroups: await groupsOfIds(db, pageIds),
		matchGroups: matched > pageIds.length ? await groupsOfQuery(db, all) : [],
		bulkCap: BULK_CAP
	};
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	if (!id) throw error(404, 'List not found');

	const group = await db
		.prepare(
			'SELECT id, name, kind, description, origin, rules, public_topic, topic_label, topic_blurb, topic_order, created_at, archived_at FROM lists WHERE id = ?'
		)
		.bind(id)
		.first<GroupDetail>();
	if (!group) throw error(404, 'List not found');
	// #445: the Billing company-metric group in the rule builder / filters only with billing access.
	const billing = await canSeeBilling(db, event.locals?.user ?? null);

	let per = Number(event.url.searchParams.get('per')) || 25;
	if (!PER_OPTIONS.includes(per)) per = 25;
	let page = Math.floor(Number(event.url.searchParams.get('page')) || 1);
	if (page < 1) page = 1;

	// Dynamic segment (#66): membership computed from rules, no list_members rows to
	// filter/sort/join against. Everything else (list, tag, hand-picked segment, and
	// company — which DOES have list_members rows via syncCompanyMembership) is
	// "filterable": filters/sort/columns/select-all-matching all work against it.
	let segRules = group.kind === 'segment' ? parseRules(group.rules) : null;
	// #228: a `list` rule whose group is gone is marked invalid (and then ignored).
	if (segRules && (await healDanglingListRules(db, segRules))) {
		const row = await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(id).first<{ rules: string | null }>();
		group.rules = row?.rules ?? null;
		segRules = parseRules(group.rules);
	}
	const deletedRules = (segRules?.rules ?? []).filter(isDeletedListRule).length;
	const dynamic = !!segRules;
	const filterable = !dynamic;

	// #170: the rule builder's "Company is …" picker (segments only).
	const companyPicker =
		group.kind === 'segment'
			? (await db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE LIMIT 500').all<{ id: number; name: string }>()).results
			: [];
	// #207: the rule builder's pipeline stage picker (segments only).
	const stagePicker = group.kind === 'segment' ? await stageOptions(db) : [];
	// #448: the topic preference rule + the tag picker (segments only).
	const topicOptions = group.kind === 'segment' ? await topicPicker(db) : [];
	// #467: the score value / band rules.
	const scorePicks = group.kind === 'segment' ? await scorePicker(db) : [];
	// #619: custom field rules pick defined fields by label.
	const fieldPicks = group.kind === 'segment' ? await fieldPicker(db) : [];
	// #467: the bulk bar's "Adjust score" — admins only.
	const adjustScores = event.locals?.user?.role === 'admin' ? await scorePicker(db) : [];
	// #516: the "Submitted form" filter and segment rule (questions unused here).
	const formOptions = (await formPicker(db)).map((f) => ({ id: f.id, name: f.status === 'archived' ? `${f.name} (archived)` : f.name, questions: [] }));

	// Needed for "also in/not in" AND the bulk "add to"/tag pickers. #472: archived groups only
	// when this segment's rules or the current In / Not in filter already point at them.
	const sp = event.url.searchParams;
	const groups = await allGroups(db, [id, ...ruleListIds(group.rules), Number(sp.get('in')), Number(sp.get('notin'))]);
	const activeAutomations = await listActiveAutomations(db);

	// #472: Archive / Restore (admins) — and why Archive is refused right now, if it is.
	const isAdmin = event.locals?.user?.role === 'admin';
	const archiveBlock =
		isAdmin && !group.archived_at && (group.kind === 'list' || group.kind === 'segment')
			? archiveProblem((await loadArchiveChecks(db, [id]))[0]!)
			: null;
	const archive = { isAdmin, archivable: group.kind === 'list' || group.kind === 'segment', block: archiveBlock };

	// Tags for the rows on this page (optional column) — chunked, well under D1's 100-var cap.
	async function tagsFor(ids: number[]): Promise<Record<number, string[]>> {
		const out: Record<number, string[]> = {};
		for (const part of chunk(ids, 90)) {
			const rows = await db
				.prepare(
					`SELECT lm.contact_id, l.name
					 FROM list_members lm
					 JOIN lists l ON l.id = lm.list_id
					 WHERE l.kind = 'tag' AND lm.contact_id IN (${part.map(() => '?').join(',')})
					 ORDER BY l.name COLLATE NOCASE`
				)
				.bind(...part)
				.all<{ contact_id: number; name: string }>();
			for (const r of rows.results) (out[r.contact_id] ??= []).push(r.name);
		}
		return out;
	}

	if (dynamic) {
		// #224: the rules as a predicate AND'd to the full /contacts filter and sort. The
		// header count stays the whole membership; `matched` is the filtered view.
		const cfilter = groupViewFilter(parseContactsFilter(event.url.searchParams), segRules);
		const { sort, dir, orderExpr } = contactsOrder(event.url.searchParams);
		const seg = segmentMembershipSql(segRules!);
		// #705: the header count is the active audience (or what the rules ask for); `hidden` =
		// matching but unsubscribed.
		const audience = segmentAudienceSql(segRules);
		// Split into unsubscribed (not archived) and archived, as on the list path below.
		const [totalRes, unsubRes, archRes] = await db.batch<{ n: number }>([
			db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${seg.sql} AND ${audience}`).bind(...seg.params),
			db
				.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${seg.sql} AND NOT ${audience} AND archived_at IS NULL`)
				.bind(...seg.params),
			db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${seg.sql} AND ${hiddenArchivedSql()}`).bind(...seg.params)
		]);
		const total = totalRes.results[0]?.n ?? 0;
		// No links: a rules segment's members aren't list_members, so /contacts?in= can't find them.
		const hidden = hiddenNote(unsubRes.results[0]?.n ?? 0, archRes.results[0]?.n ?? 0, null);

		const { where, params } = dynamicWhere(segRules!, cfilter);
		// `all` here is groupViewFilter's "the rules decide", not a filter the user picked.
		const filtered = isNarrowed(cfilter.status === 'all' ? { ...cfilter, status: 'active' } : cfilter);
		const matchRow = filtered
			? await db.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`).bind(...params).first<{ n: number }>()
			: null;
		const matched = filtered ? (matchRow?.n ?? 0) : total;
		const pageCount = Math.max(1, Math.ceil(matched / per));
		if (page > pageCount) page = pageCount;
		const offset = (page - 1) * per;

		const members = await db
			.prepare(
				`SELECT id, email, name, first_name, last_name, subscribed, source, created_at, NULL AS added_at
				 FROM contacts ${where}
				 ORDER BY ${orderExpr}
				 LIMIT ? OFFSET ?`
			)
			.bind(...params, per, offset)
			.all<MemberRow>();
		const ids = members.results.map((m) => m.id);

		// Links carry the filter plus a non-default sort (the bulk bar posts these too).
		const linkParams = contactsFilterParams(cfilter);
		if (sort !== 'created_at') linkParams.sort = sort;
		if (dir !== 'DESC') linkParams.dir = 'asc';

		return {
			group,
			dynamic,
			filterable,
			segRules: segRules ?? { match: 'all', rules: [] },
			billing,
			deletedRules,
			companyPicker,
			stagePicker,
			topicOptions,
			scorePicks,
			fieldPicks,
			formOptions,
		adjustScores,
			...(await bulkPickers(db, ids, matched, memberIdQuery(id, group, event.url.searchParams))),
			members: members.results,
			tagsByContact: await tagsFor(ids),
			groups,
			archive,
			activeAutomations,
			total,
			hidden,
			matched,
			filter: emptyFilter(),
			cfilter,
			// "In group" / "Not in group" pickers: hand-picked groups only (as on /contacts).
			groupOptions: {
				lists: groups.filter((x) => x.kind === 'list'),
				segments: groups.filter((x) => x.kind === 'segment' && !x.dynamic),
				tags: groups.filter((x) => x.kind === 'tag'),
				companies: groups.filter((x) => x.kind === 'company')
			},
			ruleShortcuts: await filterRuleOptions(db, segRules!, cfilter),
			sort,
			dir: dir === 'ASC' ? 'asc' : 'desc',
			filterParams: linkParams,
			filtered,
			page,
			per,
			pageCount,
			perOptions: PER_OPTIONS,
			from: matched === 0 ? 0 : offset + 1,
			to: Math.min(offset + per, matched)
		};
	}

	// Filterable path: list_members-backed (list / tag / hand-picked segment / company).
	const filter = parseFilter(event.url.searchParams);
	const { where, params, orderBy } = memberQuery(id, filter);

	// #705: the header count is the active audience; `hidden` = members it leaves out, split
	// into unsubscribed and archived, each found on /contacts with this group as the In group filter.
	const countWhere = (rule: string) =>
		db.prepare(`SELECT COUNT(*) AS n FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE lm.list_id = ? AND ${rule}`).bind(id);
	const [totalRes, unsubRes, archRes] = await db.batch<{ n: number }>([
		countWhere(activeContactSql('c')),
		countWhere(hiddenUnsubscribedSql('c')),
		countWhere(hiddenArchivedSql('c'))
	]);
	const total = totalRes.results[0]?.n ?? 0;
	const hidden = hiddenNote(unsubRes.results[0]?.n ?? 0, archRes.results[0]?.n ?? 0, id);

	const matchRow = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${where}`
		)
		.bind(...params)
		.first<{ n: number }>();
	const matched = matchRow?.n ?? 0;

	const pageCount = Math.max(1, Math.ceil(matched / per));
	if (page > pageCount) page = pageCount;
	const offset = (page - 1) * per;

	const members = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.subscribed, c.source,
			        c.created_at, lm.added_at
			 FROM list_members lm
			 JOIN contacts c ON c.id = lm.contact_id
			 WHERE ${where}
			 ORDER BY ${orderBy}
			 LIMIT ? OFFSET ?`
		)
		.bind(...params, per, offset)
		.all<MemberRow>();

	const ids = members.results.map((m) => m.id);
	const tagsByContact = await tagsFor(ids);

	return {
		group,
		dynamic,
		filterable,
		segRules: segRules ?? { match: 'all', rules: [] },
		billing,
		deletedRules,
		companyPicker,
		stagePicker,
		topicOptions,
		scorePicks,
		fieldPicks,
		formOptions,
		adjustScores,
		...(await bulkPickers(db, ids, matched, memberIdQuery(id, group, event.url.searchParams))),
		members: members.results,
		tagsByContact,
		groups,
		archive,
		activeAutomations,
		total,
		hidden,
		matched,
		filter,
		cfilter: null,
		groupOptions: null,
		ruleShortcuts: null,
		sort: filter.sort as string,
		dir: filter.dir,
		filterParams: filterParams(filter),
		filtered: isFiltered(filter),
		page,
		per,
		pageCount,
		perOptions: PER_OPTIONS,
		from: matched === 0 ? 0 : offset + 1,
		to: Math.min(offset + per, matched)
	};
};

/**
 * The "all matching" id query for this page's view (#214) — re-run server-side by the bulk
 * helper, never a client-supplied id list. Dynamic segments resolve via their rules AND the
 * /contacts filter (#224); everything else via `memberQuery` with the filter posted
 * alongside `all=1`.
 */
function memberIdQuery(
	listId: number,
	group: { kind: string; rules: string | null },
	src: FormData | URLSearchParams
): IdQuery {
	const segRules = group.kind === 'segment' ? parseRules(group.rules) : null;
	if (segRules) {
		const { where, params } = dynamicWhere(segRules, parseContactsFilter(src));
		return { sql: `SELECT id FROM contacts ${where}`, binds: params };
	}
	const { where, params } = memberQuery(listId, parseFilter(src));
	return {
		sql: `SELECT c.id AS id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${where}`,
		binds: params
	};
}

async function bulk(event: RequestEvent, action: BulkFormAction) {
	const db = getDB(event);
	const id = Number(event.params.id);
	const data = await event.request.formData();
	const group = await db
		.prepare('SELECT kind, rules FROM lists WHERE id = ?')
		.bind(id)
		.first<{ kind: string; rules: string | null }>();
	if (!group) return fail(404, { bulkError: 'List not found.' });
	const out = await runBulkForm(db, data, action, {
		query: () => memberIdQuery(id, group, data),
		currentGroup: id,
		postmark: await getMailProvider(db, event.platform?.env),
		actor: event.locals?.user?.github_login
	});
	if (!out.ok) return fail(out.status, { bulkError: out.error });
	return { bulkSuccess: out.message, affected: out.affected, skipped: out.skipped, bulkHref: out.href ?? null };
}

export const actions: Actions = {
	// Save dynamic-segment rules (#66). Empty rules clears them → back to hand-picked.
	saveRules: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const g = await db.prepare('SELECT kind FROM lists WHERE id = ?').bind(id).first<{ kind: string }>();
		if (g?.kind !== 'segment') return fail(400, { rulesError: 'Only segments can have rules.' });
		const parsed = parseRules(String((await event.request.formData()).get('rules') ?? ''));
		const value = parsed && parsed.rules.length ? JSON.stringify(parsed).slice(0, 8000) : null;
		await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(value, id).run();
		return { rulesOk: true };
	},

	// #224: "Exclude these from this segment" / "Require this for this segment" — append the
	// filter's group condition (negated / as is) to the rules, then drop the filter.
	filterRule: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const out = await applyFilterRule(db, id, {
			cond: String(data.get('cond') ?? ''),
			groupId: Number(data.get('group_id')),
			mode: String(data.get('mode') ?? '')
		});
		if (!out.ok) return fail(400, { ruleError: out.error });
		const per = Number(data.get('per'));
		redirect(303, `/lists/${id}${PER_OPTIONS.includes(per) && per !== 25 ? `?per=${per}` : ''}`);
	},

	// Bulk bar (#214) — same actions and banner as /contacts, via $lib/server/contact-bulk.
	// "Add to" = an existing list/segment or a brand-new segment (#73 + filters).
	addToSegment: (event) => bulk(event, 'add_segment'),
	addTo: (event) => bulk(event, 'add_segment'),
	addToList: (event) => bulk(event, 'add_list'),
	// Remove from this list/tag/hand-picked segment by default (#73), or from any list the
	// selection is in. Refused for kind='company' (derived) and dynamic segments (no rows).
	removeFromList: (event) => bulk(event, 'remove_list'),
	removeMembers: (event) => bulk(event, 'remove_list'),
	// Dynamic segment: tag the selection with the segment's exclusion tag + a `tag is absent` rule.
	excludeFromSegment: (event) => bulk(event, 'exclude_segment'),
	// Tag (find-or-create); `snapshot:approved` is refused in bulk (#110).
	bulkTag: (event) => bulk(event, 'add_tag'),
	removeTag: (event) => bulk(event, 'remove_tag'),
	// Enroll the selection into an active automation (#97).
	addToAutomation: (event) => bulk(event, 'enroll'),
	// Permanently delete the selection (shared cascade rules) (#73).
	deleteContacts: (event) => bulk(event, 'delete'),
	// #280: archive — the member table only shows active contacts, so no restore here.
	archiveContacts: (event) => bulk(event, 'archive'),
	// #279: bulk unsubscribe / resubscribe (shared helper, same as /contacts).
	bulkUnsubscribe: (event) => bulk(event, 'unsubscribe'),
	bulkResubscribe: (event) => bulk(event, 'resubscribe'),
	// #460: set / clear the engagement tier override on the selection.
	bulkSetTier: (event) => bulk(event, 'set_tier'),
	// #467: ± points on a score for the selection (admin only — like the contact page's Adjust).
	bulkAdjustScore: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { bulkError: 'Only admins can adjust scores.' });
		return bulk(event, 'adjust_score');
	},

	// #472: archive / restore this list or segment (admin-only; the rules are archiveProblem's).
	archiveGroup: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { archiveError: 'Only admins can archive.' });
		const r = await archiveGroups(getDB(event), [Number(event.params.id)]);
		if (r.skipped.length) return fail(400, { archiveError: `Can't archive: ${r.skipped[0].reason}.` });
		return { archiveOk: 'Archived. Hidden from pickers; members and history kept.' };
	},
	restoreGroup: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { archiveError: 'Only admins can restore.' });
		const r = await restoreGroups(getDB(event), [Number(event.params.id)]);
		if (r.skipped.length) return fail(400, { archiveError: `Can't restore: ${r.skipped[0].reason}.` });
		return { archiveOk: 'Restored.' };
	},

	// Edit the group's description + origin/consent note (#53).
	updateMeta: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		const description = String(data.get('description') ?? '').trim().slice(0, 500) || null;
		const origin = String(data.get('origin') ?? '').trim().slice(0, 500) || null;
		const kind = (await db.prepare('SELECT kind FROM lists WHERE id = ?').bind(id).first<{ kind: string }>())?.kind;
		if (!kind) return fail(404, { metaError: 'Group not found.' });
		// #414: only a list can be a topic; its public label / blurb / order are kept as typed
		// (the preference page never shows the list's name or description).
		const publicTopic = kind === 'list' && data.get('public_topic') ? 1 : 0;
		const topic = cleanTopicFields({ label: data.get('topic_label'), blurb: data.get('topic_blurb'), order: data.get('topic_order') });
		const res =
			kind === 'list'
				? await db
						.prepare('UPDATE lists SET description = ?, origin = ?, public_topic = ?, topic_label = ?, topic_blurb = ?, topic_order = ? WHERE id = ?')
						.bind(description, origin, publicTopic, topic.topic_label, topic.topic_blurb, topic.topic_order, id)
						.run()
				: await db.prepare('UPDATE lists SET description = ?, origin = ?, public_topic = 0 WHERE id = ?').bind(description, origin, id).run();
		if (!res.meta.changes) return fail(404, { metaError: 'Group not found.' });
		return { metaOk: true };
	}
};

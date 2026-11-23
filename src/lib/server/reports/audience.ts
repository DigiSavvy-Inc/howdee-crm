// Reports → audiences (#356): save a contacts or companies report's results as a live
// segment or a static list, and tag / untag them. Selection and writes go through the
// contacts bulk bar's helpers (`contact-bulk.ts`). Nothing here sends, schedules,
// enrolls (every add passes `enroll: false`) or deletes.

import { fail, type RequestEvent } from '@sveltejs/kit';
import { hasAudience, liveSegmentBlocker, reportMarker } from '$lib/report-audience';
import { parseReportSpec, ReportError, type ReportSpec, type ReportViewer } from '$lib/report-spec';
import {
	BULK_CAP,
	bulkAddTag,
	bulkAddToGroup,
	bulkRemoveTag,
	findGroup,
	fmt,
	resolveSelection
} from '$lib/server/contact-bulk';
import { getDB } from '$lib/server/db';
import { groupNameProblem } from '$lib/server/groups-bulk';
import { reportAudienceQuery, specToSegmentRules } from '$lib/server/reports/engine';
import { reportViewer } from '$lib/server/reports/page';
import { compileSegment } from '$lib/server/segment-query';

export type AudienceLoad = {
	total: number;
	subscribed: number;
	/** Over BULK_CAP: the list and tag actions are refused (a segment still works). */
	overCap: boolean;
	/** Why a live segment isn't offered, or null when it is. */
	liveBlocker: string | null;
	lists: { id: number; name: string }[];
	tags: string[];
	/** Groups created from this saved report. */
	savedAs: { id: number; name: string; kind: string }[];
};

export type AudienceForm = { audienceSuccess?: string; audienceHref?: string; audienceError?: string };

/** The audience panel for a report, or null when the entity has none / the viewer is refused. */
export async function loadAudience(
	db: D1Database,
	spec: ReportSpec,
	viewer: ReportViewer,
	reportId: number | null
): Promise<AudienceLoad | null> {
	if (!hasAudience(spec)) return null;
	let query: ReturnType<typeof reportAudienceQuery>;
	try {
		query = reportAudienceQuery(spec, viewer);
	} catch (err) {
		if (err instanceof ReportError) return null;
		throw err;
	}
	if (!query) return null;
	const marker = reportId ? reportMarker(reportId) : null;
	const [counts, lists, tags, savedAs] = await Promise.all([
		db
			.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(subscribed), 0) AS subscribed FROM contacts WHERE id IN (${query.sql})`)
			.bind(...query.binds)
			.first<{ n: number; subscribed: number }>(),
		db
			.prepare(`SELECT id, name FROM lists WHERE kind = 'list' AND archived_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 300`)
			.all<{ id: number; name: string }>(),
		db.prepare(`SELECT name FROM lists WHERE kind = 'tag' ORDER BY name COLLATE NOCASE LIMIT 300`).all<{ name: string }>(),
		marker
			? db
					.prepare(
						`SELECT id, name, kind FROM lists WHERE kind IN ('list', 'segment') AND substr(description, 1, ?) = ? ORDER BY id`
					)
					.bind(marker.length, marker)
					.all<{ id: number; name: string; kind: string }>()
			: Promise.resolve({ results: [] as { id: number; name: string; kind: string }[] })
	]);
	const total = counts?.n ?? 0;
	return {
		total,
		subscribed: counts?.subscribed ?? 0,
		overCap: total > BULK_CAP,
		liveBlocker:
			liveSegmentBlocker(spec) ?? (specToSegmentRules(spec, viewer) ? null : 'This report can’t be saved as a live segment.'),
		lists: lists.results ?? [],
		tags: (tags.results ?? []).map((row) => row.name),
		savedAs: savedAs.results ?? []
	};
}

function readSpec(data: FormData): ReportSpec {
	const raw = data.get('spec');
	if (typeof raw !== 'string' || !raw.trim()) throw new ReportError('Report spec is missing.');
	try {
		return parseReportSpec(JSON.parse(raw));
	} catch (err) {
		if (err instanceof ReportError) throw err;
		throw new ReportError('Report spec is incomplete.');
	}
}

function reportIdOf(event: RequestEvent): number | null {
	const id = Number(event.params.id);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function describe(reportId: number | null, reportName: string): string | null {
	const name = reportName.trim() || 'Untitled report';
	return reportId ? `${reportMarker(reportId)}${name}`.slice(0, 500) : `From the report “${name}”`.slice(0, 500);
}

async function nameTaken(db: D1Database, kind: string, name: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT id FROM lists WHERE kind = ? AND name = ? COLLATE NOCASE LIMIT 1')
		.bind(kind, name)
		.first<{ id: number }>();
	return row != null;
}

type Op = 'segment' | 'list' | 'tag' | 'untag';

/** One handler per op, so each route can wire them as form actions. */
export function audienceAction(op: Op) {
	return async (event: RequestEvent) => {
		const viewer = reportViewer(event);
		const db = getDB(event);
		const data = await event.request.formData();
		try {
			const spec = readSpec(data);
			if (!hasAudience(spec)) return fail(400, { audienceError: 'Only contact and company reports can be saved as contacts.' });
			const field = (key: string) => String(data.get(key) ?? '').trim();
			const reportId = reportIdOf(event);

			if (op === 'segment') {
				const rules = specToSegmentRules(spec, viewer);
				const blocker = liveSegmentBlocker(spec);
				if (!rules || blocker) return fail(400, { audienceError: blocker ?? 'This report can’t be saved as a live segment.' });
				const name = field('name');
				const problem = groupNameProblem(name);
				if (problem) return fail(400, { audienceError: problem });
				if (await nameTaken(db, 'segment', name)) return fail(400, { audienceError: `A segment named “${name}” already exists.` });
				const row = await db
					.prepare(`INSERT INTO lists (name, kind, rules, description) VALUES (?, 'segment', ?, ?) RETURNING id`)
					.bind(name, JSON.stringify(rules), describe(reportId, field('report_name')))
					.first<{ id: number }>();
				if (!row) return fail(500, { audienceError: 'The segment was not saved.' });
				const compiled = compileSegment(rules);
				const count = await db
					.prepare(`SELECT COUNT(*) AS n FROM (${compiled.sql})`)
					.bind(...compiled.binds)
					.first<{ n: number }>();
				return {
					audienceSuccess: `Saved live segment “${name}” · ${fmt(count?.n ?? 0)} contacts now`,
					audienceHref: `/lists/${row.id}`
				} satisfies AudienceForm;
			}

			const query = reportAudienceQuery(spec, viewer);
			if (!query) return fail(400, { audienceError: 'Only contact and company reports can be saved as contacts.' });
			const sel = await resolveSelection(db, { query });
			if (!sel.ok) return fail(400, { audienceError: sel.empty ? 'This report matches no contacts.' : sel.error });

			if (op === 'tag' || op === 'untag') {
				const tag = field('tag');
				const res = op === 'tag' ? await bulkAddTag(db, sel, tag, { enroll: false }) : await bulkRemoveTag(db, sel, tag);
				if (!res.ok) return fail(res.status, { audienceError: res.error });
				return { audienceSuccess: res.message } satisfies AudienceForm;
			}

			// op === 'list': append to an existing hand-picked list, or create one.
			const listId = Number(field('list_id'));
			let list: { id: number; name: string; kind: string; rules: string | null } | null = null;
			if (listId) {
				list = await findGroup(db, listId, ['list']);
				if (!list) return fail(404, { audienceError: 'List not found.' });
			} else {
				const name = field('new_list');
				const problem = groupNameProblem(name);
				if (problem) return fail(400, { audienceError: problem });
				if (await nameTaken(db, 'list', name)) {
					return fail(400, { audienceError: `A list named “${name}” already exists. Pick it under “Add to an existing list”.` });
				}
				list = await db
					.prepare(`INSERT INTO lists (name, kind, description) VALUES (?, 'list', ?) RETURNING id, name, kind, rules`)
					.bind(name, describe(reportId, field('report_name')))
					.first<{ id: number; name: string; kind: string; rules: string | null }>();
				if (!list) return fail(500, { audienceError: 'The list was not saved.' });
			}
			const res = await bulkAddToGroup(db, sel, list, { enroll: false });
			if (!res.ok) return fail(res.status, { audienceError: res.error });
			return { audienceSuccess: res.message, audienceHref: `/lists/${list.id}` } satisfies AudienceForm;
		} catch (err) {
			if (err instanceof ReportError) return fail(400, { audienceError: err.message });
			throw err;
		}
	};
}

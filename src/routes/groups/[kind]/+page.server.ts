import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	ARCHIVABLE_KINDS,
	MERGEABLE_KINDS,
	archiveGroups,
	archiveProblem,
	cleanGroupIds,
	deleteGroups,
	dynamicMemberCount,
	emptyGroup,
	groupRuleRefs,
	isManageableKind,
	loadArchiveChecks,
	loadGroups,
	mergeGroups,
	renameGroup,
	restoreGroups,
	triggeringAutomations
} from '$lib/server/groups-bulk';
import { parseRules } from '$lib/server/segment-query';
import { activeContactSql } from '$lib/server/active-audience';
import { containsSql } from '$lib/server/sql-match';

const KINDS: Record<string, { label: string; plural: string }> = {
	list: { label: 'List', plural: 'Lists' },
	segment: { label: 'Segment', plural: 'Segments' },
	tag: { label: 'Tag', plural: 'Tags' },
	company: { label: 'Company', plural: 'Companies' }
};

/** Typed `delete` is required past this many members (or when an automation is affected). */
const CONFIRM_MEMBERS = 100;

type GroupRow = {
	id: number;
	name: string;
	description: string | null;
	created_at: string;
	rules: string | null;
	count: number;
	last_used: string | null;
	campaign_count: number;
	archived_at: string | null;
};

export const load: PageServerLoad = async (event) => {
	const kind = String(event.params.kind);
	const meta = KINDS[kind];
	if (!meta) throw error(404, 'Unknown group type');

	const q = (event.url.searchParams.get('q') ?? '').trim();
	const sortParam = event.url.searchParams.get('sort');
	const sort = sortParam === 'name' || sortParam === 'created' ? sortParam : 'members';
	// #472: Active (default) | Archived view (?archived=1); only lists and segments are archived.
	const archivable = ARCHIVABLE_KINDS.includes(kind);
	const archived = archivable && event.url.searchParams.get('archived') === '1';

	const db = getDB(event);
	const rows = await db
		.prepare(
			`SELECT l.id, l.name, l.description, l.created_at, l.rules, l.archived_at,
			        (SELECT COUNT(*) FROM list_members lm JOIN contacts ct ON ct.id = lm.contact_id
			           WHERE lm.list_id = l.id AND ${activeContactSql('ct')}) AS count,
			        (SELECT MAX(COALESCE(c.sent_at, c.scheduled_at, c.created_at)) FROM campaigns c WHERE c.list_id = l.id) AS last_used,
			        (SELECT COUNT(*) FROM campaigns c WHERE c.list_id = l.id) AS campaign_count
			 FROM lists l
			 WHERE l.kind = ? AND (l.archived_at IS NULL) = ? AND (? = '' OR ${containsSql('l.name')})`
		)
		.bind(kind, archived ? 0 : 1, q, q) // #485: instr, no LIKE pattern cap
		.all<GroupRow>();

	const groups = [];
	for (const r of rows.results) {
		const dynamic = kind === 'segment' && parseRules(r.rules) !== null;
		groups.push({
			id: r.id,
			name: r.name,
			description: r.description,
			created_at: r.created_at,
			last_used: r.last_used,
			campaign_count: r.campaign_count,
			archived_at: r.archived_at,
			dynamic,
			count: dynamic ? await dynamicMemberCount(db, r.rules) : r.count
		});
	}
	const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
	groups.sort((a, b) =>
		sort === 'name'
			? collator.compare(a.name, b.name)
			: sort === 'created'
				? b.created_at.localeCompare(a.created_at) || collator.compare(a.name, b.name)
				: b.count - a.count || collator.compare(a.name, b.name)
	);

	// Automations whose list_added trigger is one of these groups (for the count column and
	// the delete modal's warning).
	const autos = await db
		.prepare(
			`SELECT a.id, a.name, a.status, a.trigger_list_id FROM automations a
			 JOIN lists l ON l.id = a.trigger_list_id AND l.kind = ?
			 ORDER BY a.name COLLATE NOCASE`
		)
		.bind(kind)
		.all<{ id: number; name: string; status: string; trigger_list_id: number }>();

	// #228: segment rules / Condition steps that use these groups by id (delete modal).
	const ruleRefs = isManageableKind(kind) ? await groupRuleRefs(db, groups.map((g) => g.id)) : [];

	// #472: why a group can't be archived (shown per row in the archive modal).
	const archiveBlocks: Record<number, string> = {};
	if (archivable && !archived) {
		for (const c of await loadArchiveChecks(db, groups.map((g) => g.id))) {
			const problem = archiveProblem(c);
			if (problem) archiveBlocks[c.id] = problem;
		}
	}

	return {
		kind,
		label: meta.label,
		plural: meta.plural,
		groups,
		automations: autos.results,
		ruleRefs,
		q,
		sort,
		archived,
		archivable,
		archiveBlocks,
		isAdmin: isAdmin(event),
		manageable: isManageableKind(kind),
		mergeable: MERGEABLE_KINDS.includes(kind),
		confirmMembers: CONFIRM_MEMBERS
	};
};

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function skippedText(skipped: { name: string; reason: string }[]): string {
	return skipped.length ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.` : '';
}

/** #472: archive / restore are admin-only. */
function isAdmin(event: { locals: App.Locals }): boolean {
	return (event.locals?.user ?? null)?.role === 'admin';
}

async function idsFrom(event: { request: Request }): Promise<{ data: FormData; ids: number[] }> {
	const data = await event.request.formData();
	return { data, ids: cleanGroupIds(data.getAll('id')) };
}

// Members and admins manage groups alike — same rule as before #215 (only user
// management is admin-gated).
export const actions: Actions = {
	// Create an empty group of this page's kind (#51). Companies are derived from
	// contacts.company — not hand-creatable.
	create: async (event) => {
		const db = getDB(event);
		const kind = String(event.params.kind);
		if (kind !== 'list' && kind !== 'segment' && kind !== 'tag') {
			return fail(400, { error: 'This group type cannot be created by hand.' });
		}
		const data = await event.request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Enter a name.' });
		if (name.length > 60) return fail(400, { error: 'Name is too long (60 chars max).' });
		const existing = await db
			.prepare('SELECT id FROM lists WHERE name = ? AND kind = ?')
			.bind(name, kind)
			.first<{ id: number }>();
		if (existing) return fail(400, { error: `A ${kind} named “${name}” already exists.` });
		const description = String(data.get('description') ?? '').trim().slice(0, 500) || null;
		const origin = String(data.get('origin') ?? '').trim().slice(0, 500) || null;
		await db
			.prepare('INSERT INTO lists (name, kind, description, origin) VALUES (?, ?, ?, ?)')
			.bind(name, kind, description, origin)
			.run();
		return { ok: true };
	},

	// #215: delete one or many groups. Typed `delete` is required when the selection holds
	// more than CONFIRM_MEMBERS members or any automation triggers from it — re-checked here.
	delete: async (event) => {
		const db = getDB(event);
		const kind = String(event.params.kind);
		if (!isManageableKind(kind)) return fail(400, { bulkError: 'That group type cannot be deleted here.' });
		const { data, ids } = await idsFrom(event);
		if (ids.length === 0) return fail(400, { bulkError: `Select at least one ${kind}.` });

		const groups = (await loadGroups(db, ids)).filter((g) => g.kind === kind);
		const members = groups.reduce((n, g) => n + g.members, 0);
		const autos = await triggeringAutomations(db, groups.map((g) => g.id));
		const typed = String(data.get('confirm') ?? '').trim().toLowerCase() === 'delete';
		if ((members > CONFIRM_MEMBERS || autos.length > 0) && !typed) {
			return fail(400, { bulkError: 'Type “delete” to confirm.' });
		}

		const r = await deleteGroups(db, ids, kind);
		let msg = `Deleted ${plural(r.deleted, kind)} and removed ${plural(r.membersRemoved, 'membership')} (contacts kept).`;
		const inv = r.rulesInvalidated;
		if (inv.segmentRules || inv.conditions) {
			const parts = [];
			if (inv.segmentRules) parts.push(plural(inv.segmentRules, 'segment rule'));
			if (inv.conditions) parts.push(plural(inv.conditions, 'condition'));
			msg += ` Marked ${parts.join(' and ')} as using a deleted list.`;
		}
		if (r.automationsPaused.length) {
			msg += ` Paused ${r.automationsPaused.map((a) => a.name).join(', ')} — their trigger was deleted.`;
		}
		return { bulkMessage: msg + skippedText(r.skipped) };
	},

	// #472: archive lists / segments (admin-only). Refused ones come back with the reason;
	// members, history and rules are untouched.
	archive: async (event) => {
		if (!isAdmin(event)) return fail(403, { bulkError: 'Only admins can archive.' });
		const db = getDB(event);
		const kind = String(event.params.kind);
		if (!ARCHIVABLE_KINDS.includes(kind)) return fail(400, { bulkError: 'Only lists and segments can be archived.' });
		const { ids } = await idsFrom(event);
		if (ids.length === 0) return fail(400, { bulkError: `Select at least one ${kind}.` });
		const r = await archiveGroups(db, ids, kind);
		return {
			bulkMessage: `Archived ${plural(r.changed.length, kind)} — hidden from pickers; members and history kept.` + skippedText(r.skipped)
		};
	},

	// #472: restore archived lists / segments exactly as they were (admin-only).
	restore: async (event) => {
		if (!isAdmin(event)) return fail(403, { bulkError: 'Only admins can restore.' });
		const db = getDB(event);
		const kind = String(event.params.kind);
		if (!ARCHIVABLE_KINDS.includes(kind)) return fail(400, { bulkError: 'Only lists and segments can be restored.' });
		const { ids } = await idsFrom(event);
		if (ids.length === 0) return fail(400, { bulkError: `Select at least one ${kind}.` });
		const r = await restoreGroups(db, ids, kind);
		return { bulkMessage: `Restored ${plural(r.changed.length, kind)}.` + skippedText(r.skipped) };
	},

	// #215: remove every member, keep the group.
	empty: async (event) => {
		const db = getDB(event);
		const kind = String(event.params.kind);
		if (!isManageableKind(kind)) return fail(400, { bulkError: 'That group type cannot be emptied here.' });
		const { ids } = await idsFrom(event);
		if (ids.length === 0) return fail(400, { bulkError: `Select at least one ${kind}.` });
		const r = await emptyGroup(db, ids, kind);
		return {
			bulkMessage:
				`Emptied ${plural(r.emptied, kind)} — removed ${plural(r.membersRemoved, 'membership')} (contacts kept).` +
				skippedText(r.skipped)
		};
	},

	// #215: rename one group (unique per kind, case-insensitive; #110 snapshot guard).
	rename: async (event) => {
		const db = getDB(event);
		const kind = String(event.params.kind);
		const data = await event.request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { renameError: 'Missing group.', renameId: 0 });
		const r = await renameGroup(db, id, String(data.get('name') ?? ''), kind);
		if (!r.ok) return fail(400, { renameError: r.error, renameId: id });
		return { bulkMessage: `Renamed to “${r.name}”.` };
	},

	// #215: merge tags (or lists) into a kept one or a new name.
	merge: async (event) => {
		const db = getDB(event);
		const kind = String(event.params.kind);
		const { data, ids } = await idsFrom(event);
		const into = Number(data.get('into'));
		const newName = String(data.get('new_name') ?? '').trim();
		const target = newName ? { newName } : { intoId: into };
		const r = await mergeGroups(db, target, ids, kind);
		if (!r.ok) return fail(400, { mergeError: r.error });
		const repointed = r.automations + r.branches + r.refs.segments + r.refs.steps + r.refs.campaigns + r.refs.webhookKeys + r.refs.settings;
		return {
			bulkMessage:
				`Merged ${r.merged.map((m) => m.name).join(', ')} into “${r.into.name}”${r.into.created ? ' (new)' : ''}: ` +
				`${plural(r.membersAdded, 'contact')} added, ${plural(r.duplicates, 'duplicate')} dropped, ` +
				`${plural(repointed, 'reference')} repointed.`
		};
	}
};

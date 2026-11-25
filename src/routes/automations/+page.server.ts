import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	allLabelsWithCounts,
	automationsListQuery,
	labelsByAutomation,
	normalizeLabel,
	resolveStatusFilter,
	STATUS_COOKIE
} from '$lib/server/automation-labels';
import { bulkLabel, bulkSetStatus, deleteAutomations, type BulkResult } from '$lib/server/automation-bulk';
import { createAutomation, createFromSpec } from '$lib/server/automation-write';
import { triggerEmailNames } from '$lib/server/engagement-trigger-read';
import { isEngagementKind, parseEngagementConfig } from '$lib/engagement-trigger';
import { defaultFrom } from '$lib/server/automations-api';
import { RECIPES, recipeByKey, recipeStepCount } from '$lib/automation-recipes';
import { tagParam } from '$lib/automations-filter';

// #164 result banner: "Paused 3 of 3 selected", "… · skipped 1 (Welcome v2: no steps)".
function bulkMessage(verb: string, selected: number, r: BulkResult): string {
	let msg = `${verb} ${r.changed} of ${selected} selected`;
	if (r.skipped.length > 0) {
		msg += ` · skipped ${r.skipped.length} (${r.skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})`;
	}
	return msg;
}

async function selectedIds(request: Request): Promise<{ data: FormData; ids: string[] }> {
	const data = await request.formData();
	return { data, ids: data.getAll('id').map(String) };
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);

	// #200: ?status= wins and is remembered; a clean URL falls back to the cookie. `status`
	// is the effective filter, so urlWith() (tag chips, bulk forms) carries it along.
	const { status, write } = resolveStatusFilter(
		event.url.searchParams.get('status'),
		event.cookies.get(STATUS_COOKIE)
	);
	if (write) {
		event.cookies.set(STATUS_COOKIE, write, {
			path: '/automations',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 365
		});
	}
	// #432: labels are "tags" in the UI — `?tag=` is canonical, an old `?label=` link still filters.
	const tag = normalizeLabel(tagParam(event.url.searchParams));
	// #477: ?q= (name or tag contains) — the search palette's "See all N automations".
	const searchQ = (event.url.searchParams.get('q') ?? '').trim().slice(0, 100);

	const { automations, total, matched, statusCounts } = await automationsListQuery(db, { label: tag, status, q: searchQ || null });
	const labelMap = await labelsByAutomation(db, automations.map((a) => a.id));

	const tickLog = await db
		.prepare(
			`SELECT id, ran_at, processed, sent, advanced, failed, retried
			 FROM tick_log ORDER BY id DESC LIMIT 20`
		)
		.all<{
			id: number;
			ran_at: string;
			processed: number;
			sent: number;
			advanced: number;
			failed: number;
			retried: number;
		}>();

	// #396: the pickers' names for the shared triggerSummary (same helper as the editor's tile).
	// #412: engagement triggers keep their list in trigger_config, plus the emails they name.
	const configListIds = automations.map((a) => (isEngagementKind(a.trigger_type) ? parseEngagementConfig(a.trigger_type, a.trigger_config).list_id : null));
	const triggerCtx = {
		lists: (
			await db
				.prepare(
					`SELECT id, name, kind, (kind = 'segment' AND rules IS NOT NULL) AS dynamic FROM lists
					 WHERE id IN (SELECT trigger_list_id FROM automations WHERE trigger_list_id IS NOT NULL) OR id IN (SELECT value FROM json_each(?))`
				)
				.bind(JSON.stringify(configListIds.filter((x): x is number => !!x)))
				.all<{ id: number; name: string; kind: string; dynamic: number }>()
		).results,
		sites: (await db.prepare('SELECT id, name FROM tracking_sites').all<{ id: number; name: string }>()).results,
		stages: (await db.prepare('SELECT id, name FROM pipeline_stages').all<{ id: number; name: string }>()).results,
		emails: await triggerEmailNames(db, automations)
	};

	// #398: "Start from a recipe" cards + their pickers.
	const recipes = RECIPES.map((r) => ({ key: r.key, name: r.name, description: r.description, needs: r.needs, needsLabel: r.needsLabel, steps: recipeStepCount(r) }));
	const recipeLists = (
		// #472: archived lists / segments are not offered.
		await db
			.prepare("SELECT id, name, kind FROM lists WHERE kind IN ('list', 'segment', 'tag') AND archived_at IS NULL ORDER BY name COLLATE NOCASE")
			.all<{ id: number; name: string; kind: string }>()
	).results;
	const recipeStages = (await db.prepare('SELECT id, name FROM pipeline_stages ORDER BY position').all<{ id: number; name: string }>()).results;

	// #714: a suggestion's "Move to an automation" step (`?enroll_list=<group>`): pick an active
	// automation, then its Enroll contacts dialog opens with the group picked. Nothing enrolls here.
	const enrollListId = Number(event.url.searchParams.get('enroll_list')) || 0;
	let enrollPick: { group: { id: number; name: string; kind: string }; automations: { id: number; name: string }[] } | null = null;
	if (enrollListId > 0) {
		const group = await db
			.prepare("SELECT id, name, kind FROM lists WHERE id = ? AND kind IN ('list', 'segment', 'tag') AND archived_at IS NULL")
			.bind(enrollListId)
			.first<{ id: number; name: string; kind: string }>();
		if (group) {
			const active = await db
				.prepare(
					`SELECT a.id, a.name FROM automations a
					  WHERE a.status = 'active' AND EXISTS (SELECT 1 FROM automation_steps s WHERE s.automation_id = a.id)
					  ORDER BY a.name COLLATE NOCASE`
				)
				.all<{ id: number; name: string }>();
			enrollPick = { group, automations: active.results };
		}
	}

	return {
		enrollPick,
		recipes,
		recipeLists,
		recipeStages,
		triggerCtx,
		automations: automations.map((a) => ({ ...a, labels: labelMap.get(a.id) ?? [] })),
		tickLog: tickLog.results,
		labelCounts: await allLabelsWithCounts(db),
		filter: { tag, status },
		q: searchQ,
		total,
		matched,
		statusCounts
	};
};

export const actions: Actions = {
	create: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const name = String(data.get('name') ?? '');
		// #345: the shared write layer — a manual-trigger draft.
		const created = await createAutomation(db, { name }, { kind: 'user', id: event.locals?.user?.id ?? null });
		if (!created.ok) return fail(400, { error: created.error });
		throw redirect(303, `/automations/${created.data.automation_id}`);
	},

	// #398: a draft from a recipe's spec (the same createFromSpec the assistant / API use).
	fromRecipe: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const key = String(data.get('recipe') ?? '');
		const recipe = recipeByKey(key);
		if (!recipe) return fail(400, { recipeError: 'Unknown recipe.', recipeKey: key });
		const posInt = (v: FormDataEntryValue | null) => {
			const n = Number(v);
			return Number.isInteger(n) && n > 0 ? n : null;
		};
		const spec = recipe.spec({ list_id: posInt(data.get('list_id')), stage_id: posInt(data.get('stage_id')) });
		const created = await createFromSpec(db, spec, { kind: 'user', id: event.locals?.user?.id ?? null }, { defaultFrom: await defaultFrom(event, db) });
		if (!created.ok) return fail(400, { recipeError: created.error, recipeKey: key });
		throw redirect(303, `/automations/${created.data.automation_id}`);
	},

	// Bulk actions (#164). The forms post to `?/<action>&status=…&tag=…`, so the page
	// re-renders with the same filter whether or not JS is on; the result is the banner.
	bulkActivate: async (event) => {
		const { ids } = await selectedIds(event.request);
		if (ids.length === 0) return fail(400, { bulkError: 'Select at least one automation.' });
		const r = await bulkSetStatus(getDB(event), ids, 'active', { userId: event.locals?.user?.id ?? null });
		return { bulkMessage: bulkMessage('Activated', ids.length, r) };
	},

	bulkPause: async (event) => {
		const { ids } = await selectedIds(event.request);
		if (ids.length === 0) return fail(400, { bulkError: 'Select at least one automation.' });
		const r = await bulkSetStatus(getDB(event), ids, 'paused', { userId: event.locals?.user?.id ?? null });
		return { bulkMessage: bulkMessage('Paused', ids.length, r) };
	},

	bulkAddLabel: async (event) => {
		const { data, ids } = await selectedIds(event.request);
		if (ids.length === 0) return fail(400, { bulkError: 'Select at least one automation.' });
		const r = await bulkLabel(getDB(event), ids, String(data.get('label') ?? ''), 'add');
		if ('error' in r) return fail(400, { bulkError: r.error });
		return { bulkMessage: bulkMessage('Tagged', ids.length, r) };
	},

	bulkRemoveLabel: async (event) => {
		const { data, ids } = await selectedIds(event.request);
		if (ids.length === 0) return fail(400, { bulkError: 'Select at least one automation.' });
		const r = await bulkLabel(getDB(event), ids, String(data.get('label') ?? ''), 'remove');
		if ('error' in r) return fail(400, { bulkError: r.error });
		return { bulkMessage: bulkMessage('Removed the tag from', ids.length, r) };
	},

	bulkDelete: async (event) => {
		const { data, ids } = await selectedIds(event.request);
		if (ids.length === 0) return fail(400, { bulkError: 'Select at least one automation.' });
		// The modal gates the button on typing "delete"; re-check so a scripted post can't skip it.
		if (String(data.get('confirm') ?? '').trim().toLowerCase() !== 'delete') {
			return fail(400, { bulkError: 'Type “delete” to confirm.' });
		}
		const r = await deleteAutomations(getDB(event), ids);
		return { bulkMessage: bulkMessage('Deleted', ids.length, r) };
	}
};

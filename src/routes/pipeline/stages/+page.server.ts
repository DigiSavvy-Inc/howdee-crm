import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { createStage, deleteStage, listStages, nudgeStage, reorderStages, updateStage } from '$lib/server/pipeline';
import type { StageKind } from '$lib/pipeline';

// Pipeline stages (#206): admins only — checked in load AND every action (like /settings/users).
function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

function id(v: FormDataEntryValue | null): number | null {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function kind(v: FormDataEntryValue | null): StageKind | undefined {
	const k = String(v ?? '');
	return k === 'open' || k === 'won' || k === 'lost' ? k : undefined;
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event.locals);
	const db = getDB(event);
	const stages = await listStages(db);
	const counts = await db
		.prepare('SELECT stage_id, COUNT(*) AS n FROM pipeline_cards GROUP BY stage_id')
		.all<{ stage_id: number; n: number }>();
	const byStage = new Map(counts.results.map((r) => [r.stage_id, r.n]));
	return { stages: stages.map((s) => ({ ...s, cards: byStage.get(s.id) ?? 0 })) };
};

export const actions: Actions = {
	create: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const r = await createStage(getDB(event), {
			name: String(data.get('name') ?? ''),
			color: String(data.get('color') ?? ''),
			kind: kind(data.get('kind'))
		});
		return r.ok ? { ok: 'Stage added.' } : fail(400, { error: r.error });
	},

	update: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const sid = id(data.get('id'));
		if (!sid) return fail(400, { error: 'Missing stage.', errorId: null });
		const r = await updateStage(getDB(event), sid, {
			name: data.has('name') ? String(data.get('name')) : undefined,
			color: data.has('color') ? String(data.get('color')) : undefined,
			kind: kind(data.get('kind'))
		});
		return r.ok ? { ok: 'Saved.' } : fail(400, { error: r.error, errorId: sid });
	},

	// Arrow buttons (keyboard/touch fallback for drag).
	nudge: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const sid = id(data.get('id'));
		if (!sid) return fail(400, { error: 'Missing stage.' });
		const r = await nudgeStage(getDB(event), sid, data.get('dir') === 'up' ? -1 : 1);
		return r.ok ? { ok: null } : fail(400, { error: r.error });
	},

	// Drag reorder: the full ordered id list.
	reorder: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const ids = String(data.get('order') ?? '')
			.split(',')
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0);
		const r = await reorderStages(getDB(event), ids);
		return r.ok ? { ok: null } : fail(400, { error: r.error });
	},

	delete: async (event) => {
		requireAdmin(event.locals);
		const data = await event.request.formData();
		const sid = id(data.get('id'));
		if (!sid) return fail(400, { error: 'Missing stage.', errorId: null });
		const r = await deleteStage(getDB(event), sid, id(data.get('move_to')));
		if (!r.ok) return fail(400, { error: r.error, errorId: sid });
		return { ok: r.moved ? `Stage deleted — ${r.moved} card${r.moved === 1 ? '' : 's'} moved.` : 'Stage deleted.' };
	}
};

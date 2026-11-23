import { error, fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getEngagementConfig } from '$lib/server/engagement';
import { deleteScore, getScore, listScores, setScoreStatus } from '$lib/server/scoring/store';
import { lastScoringRun, rebuildScore } from '$lib/server/scoring/engine';

// Settings → Scoring (#466), admin-only (load AND every action): the built-in Engagement
// score explained, then every custom score with Pause / Resume, Rebuild and Delete.
// Create / edit is ./[id].

function isAdmin(event: RequestEvent): boolean {
	return event.locals?.user?.role === 'admin';
}

export const load: PageServerLoad = async (event) => {
	if (!isAdmin(event)) throw error(403, 'Admins only.');
	const db = getDB(event);
	const formId = Number(event.url.searchParams.get('form')) || 0;
	const [scores, engagement, lastRun, addForm] = await Promise.all([
		listScores(db),
		getEngagementConfig(db),
		lastScoringRun(db),
		// #621: ?form=<id> (a form's "Add a score rule") — pick a score, its page opens the rule.
		formId
			? db.prepare('SELECT id, name FROM forms WHERE id = ?').bind(formId).first<{ id: number; name: string }>()
			: Promise.resolve(null)
	]);
	return { scores, engagement, lastRun, addForm };
};

async function idFrom(event: RequestEvent): Promise<{ form: FormData; id: number }> {
	const form = await event.request.formData();
	return { form, id: Number(form.get('id')) || 0 };
}

export const actions: Actions = {
	status: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const { form, id } = await idFrom(event);
		const status = form.get('status') === 'paused' ? 'paused' : 'active';
		if (!(await setScoreStatus(getDB(event), id, status))) return fail(404, { error: 'That score no longer exists.' });
		return { done: status === 'paused' ? 'Score paused — it stops earning points until you resume it.' : 'Score resumed.' };
	},

	rebuild: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const { id } = await idFrom(event);
		const db = getDB(event);
		const score = await getScore(db, id);
		if (!score) return fail(404, { error: 'That score no longer exists.' });
		await rebuildScore(db, id);
		return { done: `Rebuilding “${score.name}” from the last 365 days — it fills in over the next heartbeat ticks.` };
	},

	delete: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const { id } = await idFrom(event);
		if (!(await deleteScore(getDB(event), id))) return fail(404, { error: 'That score no longer exists.' });
		return { done: 'Score deleted, with its points.' };
	}
};

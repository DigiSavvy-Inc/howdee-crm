import { error, fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { deleteSkill, duplicateSkill, getSkill, listSkills, moveSkill, setSkillEnabled } from '$lib/server/ai/skills';

// Settings → Assistant → Skills (#302), admin-only (load AND every action). The list:
// enable/disable, reorder, duplicate, delete. Create/edit is ./[id].

export const load: PageServerLoad = async (event) => {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
	const skills = (await listSkills(getDB(event))).map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description,
		mode: s.mode,
		enabled: !!s.enabled,
		chars: s.body.length,
		updated_at: s.updated_at,
		updated_by_login: s.updated_by_login
	}));
	return { skills };
};

async function idFrom(event: RequestEvent): Promise<{ form: FormData; id: number }> {
	const form = await event.request.formData();
	return { form, id: Number(form.get('id')) || 0 };
}

export const actions: Actions = {
	toggle: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
		const { form, id } = await idFrom(event);
		const on = form.get('enabled') === '1';
		if (!(await setSkillEnabled(getDB(event), id, on, event.locals.user.id))) return fail(404, { error: 'That skill no longer exists.' });
		return { done: on ? 'Skill enabled.' : 'Skill disabled — the assistant no longer sees it.' };
	},

	move: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
		const { form, id } = await idFrom(event);
		const dir = form.get('dir') === 'up' ? -1 : 1;
		await moveSkill(getDB(event), id, dir);
		return { moved: true };
	},

	duplicate: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
		const { id } = await idFrom(event);
		const r = await duplicateSkill(getDB(event), id, event.locals.user.id);
		if (!r.ok) return fail(400, { error: r.error });
		const copy = await getSkill(getDB(event), r.id);
		return { done: `Duplicated as "${copy?.name}" (disabled until you turn it on).` };
	},

	delete: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
		const { id } = await idFrom(event);
		if (!(await deleteSkill(getDB(event), id))) return fail(404, { error: 'That skill no longer exists.' });
		return { done: 'Skill deleted.' };
	}
};

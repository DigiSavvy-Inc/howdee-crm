import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { validateSkill } from '$lib/ai-skills';
import { createSkill, getSkill, listSkills, updateSkill } from '$lib/server/ai/skills';

// Settings → Assistant → Skills → one skill (#302): /new creates, /<id> edits. Admin-only
// (load AND the action).

function parseId(raw: string): number | 'new' | null {
	if (raw === 'new') return 'new';
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export const load: PageServerLoad = async (event) => {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
	const id = parseId(event.params.id);
	if (id === null) throw error(404, 'Skill not found.');
	const db = getDB(event);
	const all = await listSkills(db);
	const skill = id === 'new' ? null : (all.find((s) => s.id === id) ?? null);
	if (id !== 'new' && !skill) throw error(404, 'Skill not found.');
	// Characters of the OTHER enabled always-on skills, for the live size estimate.
	const otherAlwaysChars = all
		.filter((s) => s.mode === 'always' && s.enabled && s.id !== skill?.id)
		.reduce((n, s) => n + s.body.length, 0);
	return {
		skill: skill
			? {
					id: skill.id,
					name: skill.name,
					description: skill.description,
					body: skill.body,
					mode: skill.mode,
					enabled: !!skill.enabled,
					updated_at: skill.updated_at,
					updated_by_login: skill.updated_by_login
				}
			: null,
		otherAlwaysChars
	};
};

export const actions: Actions = {
	save: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
		const id = parseId(event.params.id ?? '');
		if (id === null) return fail(404, { error: 'Skill not found.' });
		const form = await event.request.formData();
		const values = {
			name: String(form.get('name') ?? ''),
			description: String(form.get('description') ?? ''),
			body: String(form.get('body') ?? ''),
			mode: String(form.get('mode') ?? ''),
			enabled: form.get('enabled') === 'on'
		};
		const v = validateSkill(values);
		if (!v.ok) return fail(400, { error: v.error, values });
		const db = getDB(event);
		if (id === 'new') {
			const r = await createSkill(db, v.skill, event.locals.user.id);
			if (!r.ok) return fail(400, { error: r.error, values });
			throw redirect(303, `/settings/assistant/skills/${r.id}?saved=1`);
		}
		if (!(await getSkill(db, id))) return fail(404, { error: 'That skill no longer exists.' });
		const r = await updateSkill(db, id, v.skill, event.locals.user.id);
		if (!r.ok) return fail(400, { error: r.error, values });
		return { saved: true };
	}
};

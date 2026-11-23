import { error, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getFrequencyCap, setFrequencyCap } from '$lib/server/automation-flow';
import { FREQUENCY_CAP_MAX } from '$lib/automation-flow';

// Settings → Automations (#397), admin-only (load + action): the frequency cap — at most N
// automation emails per contact per 24 h and / or 7 days. Off by default. The engine holds an
// email step that would break it until the contact's oldest counted email ages out.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { cap: await getFrequencyCap(getDB(event)), max: FREQUENCY_CAP_MAX };
};

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const on = (k: string) => data.get(`${k}_on`) === '1';
		const cap = await setFrequencyCap(getDB(event), {
			per_day: on('per_day') ? Number(data.get('per_day')) : null,
			per_week: on('per_week') ? Number(data.get('per_week')) : null
		});
		return { saved: true, cap };
	}
};

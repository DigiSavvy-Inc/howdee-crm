import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import {
	archiveCustomField,
	createCustomField,
	defineKey,
	formsUsingKeys,
	listCustomFields,
	moveCustomField,
	restoreCustomField,
	undefinedKeys,
	updateCustomField,
	valueCounts
} from '$lib/server/custom-fields';

// Settings → Custom fields (#619), admin-only (load + every action). Defines the keys stored in
// contacts.meta: label, type, options, order. Archiving hides a field from pickers; contact
// data is never touched. A second list shows keys found on contacts with no definition.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = getDB(event);
	const [fields, counts, forms, undefinedList] = await Promise.all([
		listCustomFields(db, { includeArchived: true }),
		valueCounts(db),
		formsUsingKeys(db),
		undefinedKeys(db)
	]);
	return {
		fields: fields.map((f) => ({ ...f, count: counts.get(f.key) ?? 0, forms: forms.get(f.key) ?? [] })),
		undefinedKeys: undefinedList.map((u) => ({ ...u, forms: forms.get(u.key) ?? [] }))
	};
};

const idOf = (data: FormData) => Number(data.get('id'));
const optionsOf = (data: FormData) => String(data.get('options') ?? '');

export const actions: Actions = {
	create: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const res = await createCustomField(getDB(event), {
			label: String(data.get('label') ?? ''),
			key: String(data.get('key') ?? '').trim() || undefined,
			type: String(data.get('type') ?? 'text'),
			options: optionsOf(data)
		});
		if (!res.ok) return fail(res.status, { error: res.error, op: 'create' });
		return { ok: `Created “${res.field.label}”.` };
	},
	update: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const res = await updateCustomField(getDB(event), idOf(data), {
			label: String(data.get('label') ?? ''),
			type: String(data.get('type') ?? 'text'),
			options: optionsOf(data)
		});
		if (!res.ok) return fail(res.status, { error: res.error, op: 'update', id: idOf(data) });
		return { ok: `Saved “${res.field.label}”.` };
	},
	move: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		await moveCustomField(getDB(event), idOf(data), data.get('dir') === 'up' ? -1 : 1);
		return { moved: true };
	},
	archive: async (event) => {
		requireAdmin(event);
		const res = await archiveCustomField(getDB(event), idOf(await event.request.formData()));
		if (!res.ok) return fail(res.status, { error: res.error });
		return { ok: `Archived “${res.field.label}”. Contact data is kept.` };
	},
	restore: async (event) => {
		requireAdmin(event);
		const res = await restoreCustomField(getDB(event), idOf(await event.request.formData()));
		if (!res.ok) return fail(res.status, { error: res.error });
		return { ok: `Restored “${res.field.label}”.` };
	},
	define: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const key = String(data.get('key') ?? '');
		const res = await defineKey(getDB(event), key);
		if (!res.ok) return fail(res.status, { error: res.error });
		return { ok: `Defined “${res.field.label}”.` };
	}
};

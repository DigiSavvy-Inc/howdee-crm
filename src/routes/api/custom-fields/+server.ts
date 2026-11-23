import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { createCustomField, defineKey, formFieldPicker } from '$lib/server/custom-fields';
import { isFormProtectedKey, validateField } from '$lib/custom-fields';

// #619: custom fields for the form builder's picker. Session-gated by hooks.server.ts (not a
// PUBLIC_PREFIX). GET = active definitions (anyone signed in); POST = create one, or define an
// existing contacts.meta key (`define: true`) — admins only, like every form change. Keys only the
// app writes (FORM_PROTECTED_KEYS) are never listed and never created or defined here.

export const GET: RequestHandler = async (event) => {
	return json({ fields: await formFieldPicker(getDB(event)) });
};

export const POST: RequestHandler = async (event) => {
	if (event.locals.user?.role !== 'admin') return json({ error: 'Only admins can create custom fields.' }, { status: 403 });
	let body: { key?: unknown; label?: unknown; type?: unknown; options?: unknown; define?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'Bad request.' }, { status: 400 });
	}
	if (!body || typeof body !== 'object') return json({ error: 'Bad request.' }, { status: 400 });
	const db = getDB(event);
	const input = {
		key: typeof body.key === 'string' ? body.key : undefined,
		label: typeof body.label === 'string' ? body.label : '',
		type: typeof body.type === 'string' ? body.type : 'text',
		options: body.options
	};
	const define = body.define === true && !!input.key;
	const v = define ? null : validateField(input);
	const key = define ? input.key : v?.ok ? v.key : undefined;
	if (key && isFormProtectedKey(key)) return json({ error: `“${key}” is set by the app; a form can’t fill it.` }, { status: 400 });
	const res =
		define && input.key
			? await defineKey(db, input.key, { label: input.label, type: input.type, options: input.options })
			: await createCustomField(db, input);
	if (!res.ok) return json({ error: res.error }, { status: res.status });
	const f = res.field;
	return json({ field: { key: f.key, label: f.label, type: f.type, options: f.options } }, { status: 201 });
};

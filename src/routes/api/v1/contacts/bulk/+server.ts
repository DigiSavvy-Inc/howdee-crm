import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { getMailProvider } from '$lib/server/mail';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { contactsFilterQuery, resolveSelection, runBulk, BULK_CAP, type BulkOp } from '$lib/server/contact-bulk';

const ACTIONS = [
	'add_list',
	'remove_list',
	'exclude_segment',
	'add_tag',
	'remove_tag',
	'delete',
	'archive',
	'restore',
	'unsubscribe',
	'resubscribe'
] as const;
type Action = (typeof ACTIONS)[number];

// POST /api/v1/contacts/bulk (read_write, #214) — one bulk action over explicit `ids` or a
// `filter` (the same query params as /contacts, e.g. { company_id: 4, tag… }). Same caps and
// guards as the UI bulk bar ($lib/server/contact-bulk): ≤ 20,000 contacts, chunks of 500,
// `snapshot:approved` refused, a filter delete needs `confirm: "delete"`. `archive` / `restore`
// (#280) set / clear `archived_at`; a filter excludes archived contacts unless it carries
// `archived: 1` (or `"all"`), so a filter restore needs that.
// #279: `unsubscribe` (reason `operator (bulk)`, active passes cancelled; `suppress` = also
// suppress in Postmark, default true) and `resubscribe` (subscribed = 1 only; #285 skips
// addresses Postmark suppresses for a hard bounce / spam complaint). The Postmark suppression
// sync (#285) is not a bulk action here: it acts on Postmark's list, not on a selection.
// `exclude_segment` (`segment`: id|name of a dynamic segment) tags the selection with the segment's
// exclusion tag and appends a `tag is absent` rule to it.
// Body: { ids?: number[], filter?: object, action, list?: id|name, segment?: id|name, tag?: name, confirm?, suppress? }
// → { data: { action, matched, affected, skipped, message } }.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;
	// #700: the active sending provider (Settings → Sending, else the env).
	const postmark = await getMailProvider(getDB(event), event.platform?.env);

	let body: Record<string, unknown>;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Invalid JSON body.');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return apiError(400, 'Body must be a JSON object.');
	}

	const action = body.action as Action;
	if (!ACTIONS.includes(action)) return apiError(400, `action must be one of: ${ACTIONS.join(', ')}.`);

	const hasIds = body.ids !== undefined;
	const hasFilter = body.filter !== undefined;
	if (hasIds === hasFilter) return apiError(400, 'Provide exactly one of ids or filter.');
	if (hasIds && !Array.isArray(body.ids)) return apiError(400, 'ids must be an array.');
	if (hasIds && (body.ids as unknown[]).length > BULK_CAP) {
		return apiError(400, `Too many ids; at most ${BULK_CAP} per request.`);
	}
	if (hasFilter && (body.filter === null || typeof body.filter !== 'object' || Array.isArray(body.filter))) {
		return apiError(400, 'filter must be an object of /contacts query params.');
	}

	let op: BulkOp;
	const ref = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? v.trim() : '');
	switch (action) {
		case 'add_list':
		case 'remove_list': {
			const list = ref(body.list);
			if (list === '') return apiError(400, 'list (id or name) is required.');
			op = action === 'add_list' ? { action, list, create: true } : { action, list };
			break;
		}
		case 'exclude_segment': {
			// Tags the selection with the segment's exclusion tag and adds a `tag is absent` rule.
			const segment = ref(body.segment);
			if (segment === '') return apiError(400, 'segment (id or name) is required.');
			op = { action, segment };
			break;
		}
		case 'add_tag':
		case 'remove_tag': {
			const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
			if (!tag) return apiError(400, 'tag (name) is required.');
			op = { action, tag };
			break;
		}
		case 'delete':
			op = { action, confirm: typeof body.confirm === 'string' ? body.confirm : null };
			break;
		case 'unsubscribe':
			if (body.suppress !== undefined && typeof body.suppress !== 'boolean') {
				return apiError(400, 'suppress must be a boolean.');
			}
			op = { action, suppress: body.suppress !== false, postmark, source: 'api' };
			break;
		case 'resubscribe':
			op = { action, postmark, source: 'api' };
			break;
		case 'archive':
		case 'restore':
			op = { action };
			break;
	}

	const db = getDB(event);
	let sel;
	if (hasFilter) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(body.filter as Record<string, unknown>)) {
			if (v !== null && v !== undefined && typeof v !== 'object') params.set(k, String(v));
		}
		// #705: no `status` in an API filter still means every status (not the page's `active`).
		sel = await resolveSelection(db, { query: await contactsFilterQuery(db, params, { defaultStatus: 'all' }) });
	} else {
		sel = await resolveSelection(db, { ids: body.ids as unknown[] });
	}
	if (!sel.ok) {
		// Nothing matched / no such contacts isn't a failure — there is just nothing to do.
		if (!sel.empty) return apiError(400, sel.error);
		const skipped = hasIds ? (body.ids as unknown[]).length : 0;
		return apiData({ action, matched: 0, affected: 0, skipped, message: sel.error });
	}

	const out = await runBulk(db, sel, op);
	if (!out.ok) return apiError(out.status, out.error);
	return apiData({
		action,
		matched: sel.ids.length,
		affected: out.affected,
		skipped: out.skipped,
		message: out.message
	});
};

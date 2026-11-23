import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { enrollContactsInAutomation } from '$lib/server/automations';

const MAX_IDENTIFIERS = 500;
const EMAIL_CHUNK = 90; // stay under D1's ~100-bound-variable cap per query

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

type EnrollBody = {
	contact_ids?: unknown;
	emails?: unknown;
};

/** Resolve emails -> contact ids via chunked `IN (...)` lookups; report ones that don't exist. */
async function resolveEmails(
	db: D1Database,
	emails: string[]
): Promise<{ ids: number[]; unknown: string[] }> {
	const normalized = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
	if (normalized.length === 0) return { ids: [], unknown: [] };

	const found = new Map<string, number>();
	for (let i = 0; i < normalized.length; i += EMAIL_CHUNK) {
		const chunk = normalized.slice(i, i + EMAIL_CHUNK);
		const placeholders = chunk.map(() => '?').join(', ');
		const rows = await db
			.prepare(`SELECT id, email FROM contacts WHERE email IN (${placeholders})`)
			.bind(...chunk)
			.all<{ id: number; email: string }>();
		for (const r of rows.results) found.set(r.email, r.id);
	}

	const unknown = normalized.filter((e) => !found.has(e));
	return { ids: [...found.values()], unknown };
}

// POST /api/v1/automations/:id/enroll — explicit enrollment (read_write scope).
// Body: { contact_ids?: number[], emails?: string[] } — at least one non-empty,
// combined count <= 500. Emails resolve to contacts (unknown ones are reported, not created).
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid automation id.');

	const automation = await getDB(event)
		.prepare('SELECT id, name FROM automations WHERE id = ?')
		.bind(id)
		.first<{ id: number; name: string }>();
	if (!automation) return apiError(404, 'Automation not found.');

	let body: EnrollBody;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Invalid JSON body.');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return apiError(400, 'Body must be a JSON object.');
	}

	const rawContactIds = body.contact_ids;
	const rawEmails = body.emails;
	if (rawContactIds !== undefined && !Array.isArray(rawContactIds)) {
		return apiError(400, 'contact_ids must be an array.');
	}
	if (rawEmails !== undefined && !Array.isArray(rawEmails)) {
		return apiError(400, 'emails must be an array.');
	}

	const contactIds: unknown[] = rawContactIds ?? [];
	const emails: unknown[] = rawEmails ?? [];
	if (contactIds.length === 0 && emails.length === 0) {
		return apiError(400, 'Provide at least one of contact_ids or emails.');
	}
	if (contactIds.length + emails.length > MAX_IDENTIFIERS) {
		return apiError(400, `Too many identifiers; the combined total must be ${MAX_IDENTIFIERS} or fewer.`);
	}

	const db = getDB(event);
	const { ids: idsFromEmails, unknown: unknownEmails } = await resolveEmails(
		db,
		emails.filter((e): e is string => typeof e === 'string')
	);

	const numericContactIds = contactIds.filter((n): n is number => typeof n === 'number');
	const combinedIds = [...new Set([...numericContactIds, ...idsFromEmails])];

	if (combinedIds.length === 0) {
		// Every provided identifier was an unknown email (or no valid contact ids) — nothing
		// to enroll, but not an error: report it the same shape as a real attempt.
		return apiData({
			automation: { id: automation.id, name: automation.name },
			enrolled: 0,
			skipped: 0,
			unknown_emails: unknownEmails
		});
	}

	const result = await enrollContactsInAutomation(db, id, combinedIds);
	if (!result.ok) return apiError(409, result.error);

	return apiData({
		automation: { id: automation.id, name: result.automationName },
		enrolled: result.enrolled,
		skipped: result.skipped,
		unknown_emails: unknownEmails
	});
};

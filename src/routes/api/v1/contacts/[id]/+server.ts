import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { json } from '@sveltejs/kit';
import { isEmail, isStoredEmail } from '$lib/csv';
import { requireKey, apiData, apiError, loadContact } from '$lib/server/api-v1';
import {
	applyContactFields,
	applyMemberships,
	validateContactWriteBody,
	type ContactWriteBody
} from '$lib/server/contact-write';
import { deleteContactsByIds } from '$lib/server/contacts';
import { snapshot } from '$lib/server/snapshot';
import { getCompany } from '$lib/server/companies';
import { companyMetrics } from '$lib/server/company-metrics';
import { normalizeTierOverride } from '$lib/tier-override';
import { setTierOverride } from '$lib/server/tier-override';

async function embeddedCompany(db: D1Database, companyId: number | null) {
	if (!companyId) return null;
	const co = await getCompany(db, companyId);
	if (!co) return null;
	const { company_id: _omit, ...metrics } = await companyMetrics(db, companyId);
	return { id: co.id, name: co.name, domain: co.domain, website: co.website, metrics };
}

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/v1/contacts/:id — one contact by numeric id (read scope).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');

	const db = getDB(event);
	const contact = await loadContact(db, id);
	if (!contact) return apiError(404, 'Contact not found.');
	// #170: the linked company + its metrics. `company` stays the name string (existing
	// clients read it), so the object rides alongside as `company_detail`; null = no company.
	return apiData({ ...contact, company_detail: await embeddedCompany(db, contact.company_id) });
};

// PATCH /api/v1/contacts/:id — partial update (read_write scope). Key-present semantics:
// a field in the body is written (incl. "" to clear); omitted fields are untouched.
// Also supports list/tags/remove_tags membership + enroll, like the upsert endpoint.
export const PATCH: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');

	let body: ContactWriteBody;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Invalid JSON body.');
	}
	const invalid = validateContactWriteBody(body);
	if (invalid) return apiError(400, invalid);

	// #460: `tier_override` (a tier; null / "" / "clear" = back to automatic) + optional
	// `tier_override_days` (1–365; omitted / null = until cleared). Checked before any write.
	const raw = body as Record<string, unknown>;
	const hasTier = Object.prototype.hasOwnProperty.call(raw, 'tier_override');
	if (!hasTier && raw.tier_override_days != null) return apiError(400, 'tier_override_days needs tier_override.');
	const tierReq = hasTier ? normalizeTierOverride({ tier: raw.tier_override, days: raw.tier_override_days }) : null;
	if (tierReq && !tierReq.ok) return apiError(400, tierReq.error);

	const db = getDB(event);
	const existing = await db.prepare('SELECT id, email FROM contacts WHERE id = ?').bind(id).first<{ id: number; email: string }>();
	if (!existing) return apiError(404, 'Contact not found.');

	// Rename via `email` — collision-checked against the UNIQUE email.
	if (Object.prototype.hasOwnProperty.call(body, 'email')) {
		const ne = String(body.email ?? '').trim().toLowerCase();
		// #744: an unchanged stored address is accepted; a changed one needs the strict check.
		if (!isEmail(ne) && !(ne === existing.email && isStoredEmail(ne))) return apiError(400, 'Invalid email.');
		if (ne !== existing.email) {
			const clash = await db.prepare('SELECT id FROM contacts WHERE email = ? AND id != ?').bind(ne, id).first<{ id: number }>();
			if (clash) return json({ error: 'email already in use', conflict_id: clash.id }, { status: 409 });
		}
	}

	try {
		await applyContactFields(db, id, body, { currentEmail: existing.email });
	} catch (e) {
		// Pre-check race: a concurrent write claimed the new email between check and UPDATE.
		if (String(e).includes('UNIQUE')) {
			return json({ error: 'email already in use' }, { status: 409 });
		}
		throw e;
	}
	// #604: no snapshot release hook unless SNAPSHOT_MODE turns snapshots on.
	const approvedHook = snapshot.enabled(event.platform?.env)
		? snapshot.approvedHook(db, event.platform?.env, { allowReenroll: true })
		: undefined;
	await applyMemberships(db, id, body, approvedHook);
	if (tierReq?.ok) await setTierOverride(db, [id], { ...tierReq.value, source: `api:${gate.key.id}` });

	return apiData((await loadContact(db, id))!);
};

// DELETE /api/v1/contacts/:id — delete with the project's cascade rules (read_write scope).
export const DELETE: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');

	const db = getDB(event);
	const deleted = await deleteContactsByIds(db, [id]);
	if (!deleted) return apiError(404, 'Contact not found.');
	return apiData({ deleted: true, id });
};

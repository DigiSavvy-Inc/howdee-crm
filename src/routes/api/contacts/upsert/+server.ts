import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { isEmail } from '$lib/csv';
import { safeEqual } from '$lib/server/auth';
import { syncCompanyMembership } from '$lib/server/companies';
import {
	applyContactFields,
	applyContactMeta,
	applyMemberships,
	validateContactWriteBody,
	validateFieldsBag,
	coerceSubscribed,
	type ContactWriteBody
} from '$lib/server/contact-write';
import { hygieneOnEntry } from '$lib/server/hygiene';
import { needsConfirmation, requestConfirmation } from '$lib/server/double-optin';
import { snapshot } from '$lib/server/snapshot';

/**
 * Contact record management (#45). Auth: `Authorization: Bearer <INGEST_KEY>` (shares the
 * ingest key — same programmatic-contact trust boundary; no separate secret to provision).
 *
 * Unlike /api/ingest (signup-shaped: forces a default list + auto-enroll, only overwrites
 * non-empty), this is CRM-shaped:
 *  - Target by `id` (must exist) or `email` (upsert — created if absent).
 *  - Field updates use **key-present semantics**: a key in the body is written (including
 *    "" / null to clear); an omitted key is left untouched.
 *  - Rename via `new_email` (collision-checked against the UNIQUE email).
 *  - `subscribed` (bool), `company`, `source`, name fields.
 *  - `list` (add to a list), `tags[]` / `remove_tags[]` (manage tags).
 *  - `tags[]` adds always fire "added to tag" automation triggers (consistent with every
 *    other tagging path); `list` adds enroll only with `enroll: true`.
 *  - `fields` (#84): custom fields merged into `contacts.meta`, key-present per key
 *    (null / "" deletes the key). Values must be scalars.
 *  - `source: "seo-snapshot"` (#84) additionally runs the WS Form #6 magnet transform —
 *    list `magnet-seo-snapshot` + source/role/platform/situation/icp tags. See
 *    `$lib/server/snapshot/` (via the entry module, #608) and docs/seo-snapshot-ingest.md.
 *
 * Body: { id?, email?, new_email?, name?, first_name?, last_name?, company?, source?,
 *         subscribed?, list?, tags?: string[], remove_tags?: string[], enroll?: boolean,
 *         fields?: Record<string, scalar>, icp?: 'buyer'|'tourist'|'unclear', confirm?: boolean }
 *
 * `confirm: true` (#510): a new or not-subscribed contact gets a double opt-in email instead
 * of the write; `list` / `tags` / `fields` / `enroll` wait for the confirm button. Response
 * `{ status: 'pending_confirmation' }`. An already-subscribed contact is written as usual.
 */
export const POST: RequestHandler = async (event) => {
	const key = event.platform?.env?.INGEST_KEY ?? '';
	const provided = (event.request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!key || !safeEqual(provided, key)) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	let body: Record<string, unknown>;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}
	// Shared shape validation (also catches loosely-typed `subscribed` — the string
	// "false" must never coerce to subscribed=1).
	const invalid = validateContactWriteBody(body) ?? validateFieldsBag(body as ContactWriteBody);
	if (invalid) return json({ error: invalid }, { status: 400 });

	const db = getDB(event);
	const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
	const str = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);

	// --- Resolve the target contact: by id (must exist), else by email (upsert) ---
	let target: { id: number; email: string } | null = null;
	if (has('id') && body.id != null) {
		const tid = Number(body.id);
		if (!Number.isInteger(tid)) return json({ error: 'invalid id' }, { status: 400 });
		target = await db.prepare('SELECT id, email FROM contacts WHERE id = ?').bind(tid).first();
		if (!target) return json({ error: 'contact not found', status: 'not_found' }, { status: 404 });
	}

	const bodyEmail = has('email') ? String(body.email ?? '').trim().toLowerCase() : null;
	if (!target) {
		if (!bodyEmail) return json({ error: 'provide id or email' }, { status: 400 });
		if (!isEmail(bodyEmail)) return json({ error: 'invalid email' }, { status: 400 });
		target = await db.prepare('SELECT id, email FROM contacts WHERE email = ?').bind(bodyEmail).first();
	}
	const creating = !target;

	// Double opt-in (#510).
	if (body.confirm === true && (creating ? true : await needsConfirmation(db, target!.email))) {
		const email = creating ? bodyEmail! : target!.email;
		const res = await requestConfirmation(db, event.platform?.env ?? {}, {
			email,
			contactId: target?.id ?? null,
			source: 'upsert',
			intent: {
				lists: has('list') && str(body.list) ? [str(body.list)!] : [],
				tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
				fields: has('fields') ? (body.fields as Record<string, unknown>) : undefined,
				enroll: body.enroll === true,
				source: str(body.source) ?? 'api'
			},
			contact: { name: str(body.name), first_name: str(body.first_name), last_name: str(body.last_name), company: str(body.company) }
		});
		if (creating && res.contactId) await hygieneOnEntry(db, res.contactId, email);
		return json({
			ok: true,
			status: res.reason === 'already_subscribed' ? 'updated' : 'pending_confirmation',
			id: res.contactId ?? null,
			email,
			sent: res.sent,
			...(res.reason && res.reason !== 'already_subscribed' ? { reason: res.reason } : {})
		});
	}

	// --- Decide the email to store (rename only via new_email; email is a lookup/create key) ---
	let finalEmail = creating ? bodyEmail! : target!.email;
	if (has('new_email')) {
		const ne = String(body.new_email ?? '').trim().toLowerCase();
		if (!isEmail(ne)) return json({ error: 'invalid new_email' }, { status: 400 });
		if (ne !== finalEmail) {
			const clash = await db
				.prepare('SELECT id FROM contacts WHERE email = ? AND id != ?')
				.bind(ne, target?.id ?? -1)
				.first<{ id: number }>();
			if (clash) {
				return json({ error: 'new_email already in use', status: 'conflict', conflict_id: clash.id }, { status: 409 });
			}
		}
		finalEmail = ne;
	}

	// --- Create or update (shared write helpers — same invariants as /api/v1, #73) ---
	let contactId: number;
	if (creating) {
		const row = await db
			.prepare(
				`INSERT INTO contacts (email, name, first_name, last_name, company, source, subscribed)
				 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
			)
			.bind(
				finalEmail,
				str(body.name),
				str(body.first_name),
				str(body.last_name),
				str(body.company),
				str(body.source) ?? 'api',
				coerceSubscribed(body.subscribed) === false ? 0 : 1
			)
			.first<{ id: number }>();
		contactId = row!.id;
		// Company sync on create (updates are handled inside applyContactFields).
		await syncCompanyMembership(db, contactId, str(body.company));
	} else {
		contactId = target!.id;
		// Key-present field updates via the shared helper. The rename travels as `email`
		// (already validated + collision-checked above via new_email).
		const patch: ContactWriteBody = { ...(body as ContactWriteBody) };
		delete patch.email; // upsert's `email` is a lookup key, not a rename
		if (finalEmail !== target!.email) patch.email = finalEmail;
		await applyContactFields(db, contactId, patch, { currentEmail: target!.email });
	}

	// Custom fields → contacts.meta, key-present per key (#84).
	if (has('fields')) {
		await applyContactMeta(db, contactId, body.fields as Record<string, unknown>);
	}

	// Address hygiene (#306) on a new address: `meta.hygiene` + `hygiene:invalid`, never a reject.
	if (creating || finalEmail !== target!.email) await hygieneOnEntry(db, contactId, finalEmail);

	// #604: with SNAPSHOT_MODE unset / off there is no approved hook, magnet transform or queue.
	const snapshots = snapshot.enabled(event.platform?.env);

	// List / tag membership + opt-in list enrollment via the shared helper.
	await applyMemberships(
		db,
		contactId,
		body as ContactWriteBody,
		snapshots ? snapshot.approvedHook(db, event.platform?.env, { allowReenroll: true }) : undefined
	);

	// WS Form #6 magnet transform (#84) + snapshot job queue (#95) for `source: "seo-snapshot"`.
	if (snapshots) await snapshot.afterContactUpsert(db, event.platform?.env, contactId, body);

	return json({ ok: true, status: creating ? 'added' : 'updated', id: contactId, email: finalEmail });
};

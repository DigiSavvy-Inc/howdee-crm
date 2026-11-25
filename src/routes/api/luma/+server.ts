import { json, type RequestHandler } from '@sveltejs/kit';
import { hygieneOnEntry } from '$lib/server/hygiene';
import { getDB } from '$lib/server/db';
import { isEmail } from '$lib/csv';
import { addTag, autoEnroll } from '$lib/server/automations';
import { safeMetaJson } from '$lib/server/meta';
import { guardReportUrl } from '$lib/server/report-url';
import { getSettings } from '$lib/server/settings';
import { lumaSecretFor } from '$lib/server/luma-secret';
import { verifyLumaSignature, extractGuest, STATUS_TAGS } from '$lib/server/luma';
import { NO_DEFAULT_LIST_ERROR, defaultListName } from '$lib/server/default-list';

// Human-readable, mutually-exclusive status tags (kind='tag'). An update reconciles to
// exactly one of these.
const STATUS_TAG_NAME: Record<(typeof STATUS_TAGS)[number], string> = {
	going: 'Luma: Going',
	pending: 'Luma: Pending',
	'not-going': 'Luma: Not Going'
};

/**
 * Inbound Luma webhook (#70). Adds event registrants to a configured newsletter list and
 * keeps them tagged as their status (Going/Pending/Not Going) and interests (registration
 * answers) change. Public route (PUBLIC_PREFIXES) but gated by Luma's HMAC signature, not
 * the session cookie. Mirrors /api/ingest for the contact-upsert + tag + autoEnroll path.
 *
 * Order matters: read the RAW body first (the signature covers it byte-for-byte), verify,
 * THEN parse JSON. Dedupe by Webhook-Id (Luma retries 3x). Respond <5s with 2xx.
 */
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	const rawBody = await event.request.text();
	const webhookId = event.request.headers.get('webhook-id');

	const settings = await getSettings(db);
	// #750: the stored secret may be sealed with MAIL_TOKEN_KEY; env LUMA_WEBHOOK_SECRET is the fallback.
	const secret = await lumaSecretFor(db, event.platform?.env);
	// #605: no signing secret = the integration isn't set up. Answer quietly, store nothing.
	if (!secret) return json({ error: 'Luma integration is not set up' }, { status: 404 });

	// Best-effort audit row; webhook_id is UNIQUE so a retry of an already-handled delivery
	// is deduped. We claim the row first (status 'processing') and delete it on error so a
	// crashed delivery can be safely retried by Luma.
	const logFinal = async (id: number, status: string, email: string | null, detail: string | null) => {
		try {
			await db.batch([
				db
					.prepare('UPDATE luma_events SET status = ?, email = ?, detail = ? WHERE id = ?')
					.bind(status, email, detail, id),
				db.prepare('DELETE FROM luma_events WHERE id < (SELECT MAX(id) FROM luma_events) - 1000')
			]);
		} catch (e) {
			console.error('luma event log failed:', e);
		}
	};
	const logStandalone = async (status: string, detail: string | null) => {
		try {
			await db
				.prepare('INSERT INTO luma_events (webhook_id, type, status, detail, payload) VALUES (?, ?, ?, ?, ?)')
				.bind(null, null, status, detail, rawBody.slice(0, 1000))
				.run();
		} catch (e) {
			console.error('luma event log failed:', e);
		}
	};

	// 1. Verify signature + freshness (replay guard).
	const verdict = await verifyLumaSignature(
		secret,
		event.request.headers.get('webhook-signature'),
		rawBody,
		Math.floor(Date.now() / 1000)
	);
	// #750: a request that fails the check is not stored, and the answer doesn't say why.
	if (!verdict.ok) return json({ error: 'invalid signature' }, { status: 401 });

	// 2. Parse the (now-trusted) payload.
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		await logStandalone('rejected', 'invalid JSON');
		return json({ error: 'invalid body' }, { status: 400 });
	}
	const type = typeof payload.type === 'string' ? payload.type : null;

	// 3. Idempotency: claim the webhook_id. A second delivery of the same id finds the row
	// already present → no insert → treat as duplicate and 200 immediately.
	let rowId: number | null = null;
	const claim = await db
		.prepare(
			'INSERT OR IGNORE INTO luma_events (webhook_id, type, status, payload) VALUES (?, ?, ?, ?) RETURNING id'
		)
		.bind(webhookId, type, 'processing', rawBody.slice(0, 1000))
		.first<{ id: number }>();
	if (webhookId && !claim) {
		return json({ ok: true, status: 'duplicate' });
	}
	rowId = claim?.id ?? null;

	try {
		const guest = extractGuest(payload);

		if (!isEmail(guest.email)) {
			if (rowId) await logFinal(rowId, 'ignored', guest.email || null, 'no usable email in payload');
			return json({ ok: true, status: 'ignored', reason: 'no email' });
		}

		// #596: Settings → Luma list, else the DEFAULT_LIST_NAME var; neither → rejected
		// before anything is written.
		const listName = settings.luma_list?.trim() || defaultListName(event.platform?.env);
		if (!listName) {
			if (rowId) await logFinal(rowId, 'rejected', guest.email, 'no list configured');
			return json({ error: NO_DEFAULT_LIST_ERROR }, { status: 422 });
		}

		// Upsert the contact (same shape as /api/ingest).
		const existing = await db
			.prepare('SELECT id FROM contacts WHERE email = ?')
			.bind(guest.email)
			.first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO contacts (email, name, first_name, last_name, source)
				 VALUES (?, ?, ?, ?, 'luma')
				 ON CONFLICT(email) DO UPDATE SET
				   name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
				   first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
				   last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
				   archived_at = NULL` // #280: a new registration = re-engaged → restore
			)
			.bind(guest.email, guest.name, guest.first, guest.last)
			.run();
		const contact = (await db
			.prepare('SELECT id FROM contacts WHERE email = ?')
			.bind(guest.email)
			.first<{ id: number }>())!;

		// Always ensure newsletter-list membership (idempotent) — a registrant should land on
		// the list even if we only ever see an update. Fires list_added automations.
		let list = await db
			.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'list'")
			.bind(listName)
			.first<{ id: number }>();
		if (!list) {
			list = (await db
				.prepare("INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id")
				.bind(listName)
				.first<{ id: number }>())!;
		}
		await db
			.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)')
			.bind(list.id, contact.id)
			.run();

		const appliedTags: string[] = [];

		// Status — reconcile to exactly one of the three (remove the stale two).
		if (guest.status) {
			const keep = STATUS_TAG_NAME[guest.status];
			const drop = STATUS_TAGS.filter((s) => s !== guest.status).map((s) => STATUS_TAG_NAME[s]);
			await db
				.prepare(
					`DELETE FROM list_members WHERE contact_id = ? AND list_id IN
					   (SELECT id FROM lists WHERE kind = 'tag' AND name IN (?, ?))`
				)
				.bind(contact.id, drop[0], drop[1])
				.run();
			await addTag(db, keep, contact.id);
			appliedTags.push(keep);
		}

		// Event tag (segment per event).
		if (guest.eventName) {
			const ev = `Luma: ${guest.eventName}`.slice(0, 60);
			await addTag(db, ev, contact.id);
			appliedTags.push(ev);
		}

		// Interests — each registration answer becomes a plain tag (split multi-selects),
		// capped so a free-text question can't explode the tag set. All answers are also
		// stored on the contact's meta regardless.
		const interestTags: string[] = [];
		for (const a of guest.answers) {
			for (const piece of a.answer.split(',')) {
				const t = piece.trim().slice(0, 60);
				if (t && interestTags.length < 10 && !interestTags.includes(t)) interestTags.push(t);
			}
		}
		for (const t of interestTags) {
			await addTag(db, t, contact.id);
			appliedTags.push(t);
		}

		// Persist status + event + answers into contacts.meta (merged, newest wins).
		const extras: Record<string, unknown> = {};
		if (guest.rawStatus) extras['luma_status'] = guest.rawStatus;
		if (guest.eventName) extras['luma_event'] = guest.eventName;
		for (const a of guest.answers) extras[`luma: ${a.label}`.slice(0, 50)] = a.answer.slice(0, 500);
		if (Object.keys(extras).length) {
			const prev = await db
				.prepare('SELECT meta FROM contacts WHERE id = ?')
				.bind(contact.id)
				.first<{ meta: string | null }>();
			let merged: Record<string, unknown> = {};
			try {
				merged = prev?.meta ? JSON.parse(prev.meta) : {};
			} catch {
				merged = {};
			}
			Object.assign(merged, extras);
			guardReportUrl(merged);
			await db.prepare('UPDATE contacts SET meta = ? WHERE id = ?').bind(safeMetaJson(merged), contact.id).run();
		}

		// Address hygiene (#306) for a new contact: `meta.hygiene` + `hygiene:invalid`, never a reject.
		if (!existing) await hygieneOnEntry(db, contact.id, guest.email);

		// Fire list_added automations for the list + every tag (idempotent, best-effort).
		try {
			await autoEnroll(db, list.id, [contact.id]);
			for (const name of appliedTags) {
				const tag = await db
					.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'tag'")
					.bind(name)
					.first<{ id: number }>();
				if (tag) await autoEnroll(db, tag.id, [contact.id]);
			}
		} catch (e) {
			console.error('luma auto-enroll failed:', e);
		}

		const outcome = existing ? 'updated' : 'added';
		const detail = `${listName}${appliedTags.length ? ` · ${appliedTags.join(', ')}` : ''}`.slice(0, 300);
		if (rowId) await logFinal(rowId, outcome, guest.email, detail);
		return json({ ok: true, status: outcome, list: listName, tags: appliedTags });
	} catch (e) {
		// Release the idempotency claim so Luma's retry can re-process this delivery.
		if (rowId) {
			try {
				await db.prepare('DELETE FROM luma_events WHERE id = ?').bind(rowId).run();
			} catch {
				/* ignore */
			}
		}
		console.error('luma webhook processing failed:', e);
		return json({ error: 'processing failed' }, { status: 500 });
	}
};

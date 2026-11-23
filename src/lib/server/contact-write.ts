// #73: shared scalar-field + membership writes for the Data API's create/update endpoints.
// Mirrors /api/contacts/upsert semantics so both paths keep the same invariants
// (company-group sync, tag auto-enroll, opt-in list enroll).
import { syncCompanyMembership } from '$lib/server/companies';
import { addTagAndEnroll, removeTag, addToList, autoEnroll } from '$lib/server/contacts';
import { guardReportUrl } from '$lib/server/report-url';
import { redactSecrets } from '$lib/server/redact';
import { safeMetaJson } from '$lib/server/meta';
import { subscriptionChanged } from './subscription-trigger';

export type ContactWriteBody = {
	email?: unknown;
	name?: unknown;
	first_name?: unknown;
	last_name?: unknown;
	company?: unknown;
	source?: unknown;
	subscribed?: unknown;
	list?: unknown;
	tags?: unknown;
	remove_tags?: unknown;
	enroll?: unknown;
	fields?: unknown;
};

const has = (b: object, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const str = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);

/**
 * Coerce a `subscribed` value strictly: booleans, 0/1, and "true"/"false" only.
 * Returns null for anything else (e.g. the string "false" would be truthy — a
 * compliance-relevant wrong write if coerced loosely). Callers 400 on null.
 */
export function coerceSubscribed(v: unknown): boolean | null {
	if (v === true || v === 1 || v === 'true') return true;
	if (v === false || v === 0 || v === 'false') return false;
	return null;
}

/**
 * Validate a write body's shape before applying it. Returns an error message or null.
 * Catches: non-object bodies (JSON `null` is valid JSON but not a valid body),
 * loosely-typed `subscribed`, and scalar `tags`/`remove_tags` (which would otherwise be
 * silently dropped by the Array.isArray guards below — a 200 that did nothing).
 */
export function validateContactWriteBody(body: unknown): string | null {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return 'Body must be a JSON object.';
	}
	const b = body as ContactWriteBody;
	if (has(b, 'subscribed') && coerceSubscribed(b.subscribed) === null) {
		return 'subscribed must be a boolean.';
	}
	for (const k of ['tags', 'remove_tags'] as const) {
		if (has(b, k) && !Array.isArray(b[k])) {
			return `${k} must be an array of tag names.`;
		}
	}
	return null;
}

/**
 * Apply scalar field **updates** with key-present semantics: a key in the body is written
 * (including "" / null to clear); an omitted key is left untouched. Email rename (if present)
 * must be pre-validated + collision-checked by the caller. Keeps the company group in sync.
 * Create paths should INSERT all fields in one statement instead (no partial-write window),
 * then call `syncCompanyMembership` themselves.
 */
export async function applyContactFields(
	db: D1Database,
	id: number,
	body: ContactWriteBody,
	opts: { currentEmail: string; enroll?: boolean }
): Promise<void> {
	const sets: string[] = [];
	const vals: unknown[] = [];
	const setField = (col: string, key: keyof ContactWriteBody) => {
		if (has(body, key)) {
			sets.push(`${col} = ?`);
			vals.push(str(body[key]));
		}
	};

	if (has(body, 'email')) {
		const ne = String(body.email ?? '').trim().toLowerCase();
		if (ne !== opts.currentEmail) {
			sets.push('email = ?');
			vals.push(ne);
		}
	}
	setField('name', 'name');
	setField('first_name', 'first_name');
	setField('last_name', 'last_name');
	setField('company', 'company');
	setField('source', 'source');
	if (has(body, 'subscribed')) {
		// Pre-validated by validateContactWriteBody; strict coercion (never truthiness).
		sets.push('subscribed = ?');
		vals.push(coerceSubscribed(body.subscribed) ? 1 : 0);
		// #280: an explicit `subscribed: true` means they re-engaged — restore if archived.
		// A write without the field never restores.
		if (coerceSubscribed(body.subscribed)) sets.push('archived_at = NULL');
	}

	// #444: the subscribe state before, so a real change fires the "Subscription changes" trigger.
	const wasSubscribed = has(body, 'subscribed')
		? (await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())?.subscribed
		: undefined;

	if (sets.length) {
		vals.push(id);
		await db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
	}

	if (wasSubscribed !== undefined) {
		const now = coerceSubscribed(body.subscribed) ? 1 : 0;
		if (now !== wasSubscribed) {
			// #551: `enroll: false` (the assistant) never fires the trigger; the tier still refreshes.
			await subscriptionChanged(db, [id], now ? 'resubscribed' : 'unsubscribed', { source: 'api', triggers: opts.enroll !== false });
		}
	}

	// Keep the company group in sync (#47) when company changed.
	if (has(body, 'company')) {
		await syncCompanyMembership(db, id, str(body.company), { enroll: opts.enroll ?? true });
	}
}

/**
 * Validate a `fields` custom-field bag (#84): a plain object of scalar values. Returns an
 * error message or null. Separate from validateContactWriteBody because only /api/contacts/upsert
 * accepts `fields` (the v1 endpoints would silently ignore it).
 */
export function validateFieldsBag(body: ContactWriteBody): string | null {
	if (!has(body, 'fields')) return null;
	const f = body.fields;
	if (f === null || typeof f !== 'object' || Array.isArray(f)) {
		return 'fields must be an object of custom fields.';
	}
	for (const v of Object.values(f)) {
		if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
			return 'fields values must be scalars (string / number / boolean / null).';
		}
	}
	return null;
}

/**
 * Merge a validated `fields` bag into `contacts.meta` with key-present semantics: each key
 * in the bag is written (null / "" deletes the key); keys not in the bag are untouched.
 * Same store the webhook-payload extras and the contact page's Custom fields section use,
 * so `{{field:<name>}}` merge tags and conditionals pick the values up for free.
 */
export async function applyContactMeta(
	db: D1Database,
	id: number,
	fields: Record<string, unknown>
): Promise<void> {
	if (Object.keys(fields).length === 0) return;
	const prev = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(id).first<{ meta: string | null }>();
	let merged: Record<string, unknown> = {};
	try {
		merged = prev?.meta ? JSON.parse(prev.meta) : {};
	} catch {
		merged = {};
	}
	for (const [k, v] of Object.entries(fields)) {
		const key = k.trim().slice(0, 50);
		if (!key) continue;
		if (v === null || v === '') delete merged[key];
		else merged[key] = typeof v === 'string' ? v.trim().slice(0, 500) : v;
	}
	guardReportUrl(merged);
	await db.prepare('UPDATE contacts SET meta = ? WHERE id = ?').bind(safeMetaJson(merged), id).run();
}

/** Trimmed-string view of a body field for insert paths ("" → null). */
export function fieldStr(body: ContactWriteBody, key: keyof ContactWriteBody): string | null {
	return str(body[key]);
}

/**
 * Apply list/tag membership from the body: `list` (single, find-or-create + add), `tags[]`
 * (add — always fires "added to tag" automation triggers), `remove_tags[]`. List adds enroll
 * only on explicit `enroll: true` (record management shouldn't push into list-triggered flows).
 */
export async function applyMemberships(
	db: D1Database,
	id: number,
	body: ContactWriteBody,
	afterTag?: (contactId: number, tagName: string) => Promise<void>
): Promise<void> {
	const addedLists: number[] = [];
	if (has(body, 'list')) {
		const lid = await addToList(db, String(body.list ?? ''), id);
		if (lid) addedLists.push(lid);
	}
	if (Array.isArray(body.tags)) {
		for (const t of body.tags) {
			const name = String(t ?? '');
			await addTagAndEnroll(db, name, id);
			if (afterTag) {
				try {
					await afterTag(id, name);
				} catch (e) {
					const raw = e instanceof Error ? e.message : 'afterTag failed';
					const masked = redactSecrets(raw, [])
						.replace(/key=[^&\s]+/gi, 'key=[REDACTED]')
						.replace(/\b(dsk_|vk_|dk_live_|whsec_)[A-Za-z0-9_.=-]{4,}/g, '[REDACTED]')
						.slice(0, 200);
					console.error('contact-write afterTag failed:', masked);
				}
			}
		}
	}
	if (Array.isArray(body.remove_tags)) {
		for (const t of body.remove_tags) await removeTag(db, String(t ?? ''), id);
	}
	if (body.enroll === true && addedLists.length) {
		for (const lid of addedLists) {
			try {
				await autoEnroll(db, lid, [id]);
			} catch (e) {
				console.error('contact-write list auto-enroll failed:', e);
			}
		}
	}
}

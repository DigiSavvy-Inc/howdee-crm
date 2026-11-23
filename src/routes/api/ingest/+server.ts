import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { isEmail } from '$lib/csv';
import { safeEqual } from '$lib/server/auth';
import { checkAddress, recordHygiene } from '$lib/server/hygiene';
import { autoEnroll, addTag } from '$lib/server/automations';
import { syncCompanyMembership } from '$lib/server/companies';
import { safeMetaJson } from '$lib/server/meta';
import { guardReportUrl } from '$lib/server/report-url';
import { snapshot } from '$lib/server/snapshot';
import { findSiteByKey } from '$lib/server/site-tracking';
import { signVisitorId } from '$lib/server/track-token';
import { sessionSecret } from '$lib/server/token';
import { needsConfirmation, requestConfirmation } from '$lib/server/double-optin';
import { NO_DEFAULT_LIST_ERROR, defaultListName } from '$lib/server/default-list';

// Max distinct tags applied per request (key defaults + payload); extras are dropped.
const MAX_TAGS = 25;

/**
 * Programmatic contact ingest — the webhook a form posts to. Auth via either
 * `Authorization: Bearer <INGEST_KEY>` or a `?key=<INGEST_KEY>` query param (so simple
 * form tools that can only paste a URL still work). Accepts a JSON body OR a regular
 * form post (urlencoded / multipart) so any form builder can hit it directly.
 * Fields: { email, name?, first_name?, last_name?, company?, list?, source?, tags?, website?, site_key?, confirm? }
 * `confirm` (#510): true (or the key's "Require confirmation") → double opt-in, response
 * `{ status: 'pending_confirmation' }`; nothing is subscribed until the link's button is pressed.
 * (`tags`: array or comma-separated string — merged with the key's default tags).
 * `site_key` (#152): an enabled tracking site's key → the response adds `dsv_id`, a signed
 * visitor id the site's success JS hands to `dsv.identify()` (none for opted-out contacts).
 * Spam: honeypot (website), syntax. Address hygiene (#306): a disposable domain or no MX is
 * accepted — machine paths never reject — but tagged `hygiene:invalid` (+ `meta.hygiene`).
 */
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	const provided =
		(event.request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
		event.url.searchParams.get('key') ||
		'';

	// Auth: the legacy INGEST_KEY env value, OR an active managed webhook key (#48).
	const envKey = event.platform?.env?.INGEST_KEY ?? '';
	const envOk = !!envKey && !!provided && safeEqual(provided, envKey);
	let webhookKey: { id: number; default_list: string | null; source: string | null; default_tags: string | null; require_confirm: number } | null = null;
	if (!envOk && provided) {
		webhookKey = await db
			.prepare('SELECT id, default_list, source, default_tags, require_confirm FROM webhook_keys WHERE token = ? AND revoked_at IS NULL')
			.bind(provided)
			.first();
	}
	if (!envOk && !webhookKey) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	// Accept JSON or a normal form post (urlencoded / multipart).
	let body: Record<string, unknown>;
	try {
		const ct = event.request.headers.get('content-type') ?? '';
		if (ct.includes('application/json')) {
			body = await event.request.json();
		} else {
			const fd = await event.request.formData();
			body = Object.fromEntries(
				[...fd.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : ''])
			);
		}
	} catch {
		return json({ error: 'invalid body' }, { status: 400 });
	}

	// Log each request to webhook_events + bump the key's usage (#48 activity log). Called
	// once per request at its outcome; best-effort so logging never breaks an ingest.
	const logEvent = async (status: string, detail: string | null) => {
		try {
			const stmts = [
				db
					.prepare('INSERT INTO webhook_events (key_id, email, status, detail, payload) VALUES (?, ?, ?, ?, ?)')
					.bind(
						webhookKey?.id ?? null,
						String(body.email ?? '').trim().toLowerCase().slice(0, 200) || null,
						status,
						detail,
						JSON.stringify(body).slice(0, 1000)
					)
			];
			if (webhookKey) {
				stmts.push(
					db
						.prepare("UPDATE webhook_keys SET last_used_at = datetime('now'), request_count = request_count + 1 WHERE id = ?")
						.bind(webhookKey.id)
				);
			}
			// Self-prune: keep the last ~1000 events so the log can't grow unboundedly.
			stmts.push(db.prepare('DELETE FROM webhook_events WHERE id < (SELECT MAX(id) FROM webhook_events) - 1000'));
			await db.batch(stmts);
		} catch (e) {
			console.error('webhook event log failed:', e);
		}
	};

	// Honeypot — pretend success, store nothing.
	if (body.website) {
		await logEvent('ignored', 'honeypot');
		return json({ ok: true, status: 'ignored' });
	}

	const email = String(body.email ?? '').trim().toLowerCase();
	if (!isEmail(email)) {
		await logEvent('rejected', 'invalid email');
		return json({ error: 'invalid email' }, { status: 400 });
	}

	// Hygiene (#306) is advisory, never a reject: DNS hiccups and brand-new domains would
	// silently drop real leads (and the visitor already left the page — there's no retry).
	// Accept the contact; tag it `hygiene:invalid` and flag it in the activity log instead.
	const hygiene = await checkAddress(email);
	const mxOk = hygiene.mx !== 'none';

	const name = String(body.name ?? '').trim();
	let first = String(body.first_name ?? '').trim();
	let last = String(body.last_name ?? '').trim();
	if (!first && name) {
		const p = name.split(/\s+/);
		first = p[0];
		last = p.slice(1).join(' ');
	}
	const fullName = name || [first, last].filter(Boolean).join(' ');
	const company = String(body.company ?? '').trim();
	// Per-key defaults (#48): body wins, then the key's defaults, then DEFAULT_LIST_NAME (#596).
	const listName =
		String(body.list ?? '').trim() || webhookKey?.default_list?.trim() || defaultListName(event.platform?.env);
	if (!listName) {
		await logEvent('rejected', 'no list configured');
		return json({ error: NO_DEFAULT_LIST_ERROR }, { status: 400 });
	}
	const source = String(body.source ?? '').trim() || webhookKey?.source?.trim() || 'api';
	// #190: a booking (snapshot:booked) must name its own list — not the magnet, not the fallback.
	// #604: only while SNAPSHOT_MODE turns snapshots on.
	const bookingProblem = snapshot.enabled(event.platform?.env) && snapshot.bookingListProblem(
		[
			...(webhookKey?.default_tags ?? '').split(','),
			...(Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags ?? '').split(','))
		],
		String(body.list ?? '').trim() || webhookKey?.default_list?.trim() || ''
	);
	if (bookingProblem) {
		await logEvent('rejected', bookingProblem);
		return json({ error: bookingProblem }, { status: 400 });
	}

	// Double opt-in (#510): `confirm: true` or the key's "Require confirmation" → a pending
	// contact + one confirm email; the list, tags and fields wait for the confirm button.
	// An already-subscribed address skips it (the normal path below).
	const wantConfirm = body.confirm === true || body.confirm === 'true' || body.confirm === '1' || !!webhookKey?.require_confirm;
	if (wantConfirm && (await needsConfirmation(db, email))) {
		const extras = extraFields(body);
		const res = await requestConfirmation(
			db,
			event.platform?.env ?? {},
			{
				email,
				source,
				intent: {
					lists: [listName],
					tags: [
						...(mxOk ? [] : ['unverified-domain']),
						...(webhookKey?.default_tags ?? '').split(','),
						...(Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags ?? '').split(','))
					]
						.map((t) => t.trim())
						.filter(Boolean)
						.slice(0, MAX_TAGS),
					fields: Object.keys(extras).length ? extras : undefined,
					enroll: true,
					source
				},
				contact: { name: fullName, first_name: first, last_name: last, company }
			}
		);
		if (res.contactId) {
			try {
				await recordHygiene(db, res.contactId, hygiene);
			} catch (e) {
				console.error('hygiene (ingest, pending) failed:', e);
			}
		}
		await logEvent('pending', res.sent ? 'confirmation sent' : `confirmation not sent: ${res.reason ?? 'unknown'}${res.error ? ` (${res.error.slice(0, 100)})` : ''}`);
		return json({ ok: true, status: 'pending_confirmation', ...(res.reason === 'rate_limited' ? { note: 'a confirmation was sent recently' } : {}) });
	}

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

	const existing = await db
		.prepare('SELECT id FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number }>();

	await db
		.prepare(
			`INSERT INTO contacts (email, name, first_name, last_name, company, source)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
			   first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
			   last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
			   company = COALESCE(NULLIF(excluded.company, ''), contacts.company),
			   archived_at = NULL` // #280: arriving again = re-engaged → restore
		)
		.bind(email, fullName, first, last, company || null, source)
		.run();

	await db
		.prepare(
			`INSERT OR IGNORE INTO list_members (list_id, contact_id)
			 SELECT ?, id FROM contacts WHERE email = ?`
		)
		.bind(list.id, email)
		.run();

	// Extra payload fields → contacts.meta (see extraFields).
	const extras = extraFields(body);

	// Auto-enroll into any active list_added automation on this list (best-effort),
	// and sync the company group (#47) when a company was supplied.
	try {
		const c = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
		if (c) {
			if (Object.keys(extras).length) {
				const prev = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(c.id).first<{ meta: string | null }>();
				let merged: Record<string, unknown> = {};
				try {
					merged = prev?.meta ? JSON.parse(prev.meta) : {};
				} catch {
					merged = {};
				}
				Object.assign(merged, extras);
				guardReportUrl(merged);
				await db
					.prepare('UPDATE contacts SET meta = ? WHERE id = ?')
					.bind(safeMetaJson(merged), c.id)
					.run();
			}
			await autoEnroll(db, list.id, [c.id]);
			await recordHygiene(db, c.id, hygiene);
			if (company) await syncCompanyMembership(db, c.id, company);

			// Tags: the key's default tags + any sent in the payload (`tags` as an array or a
			// comma-separated string — lets a triage step send e.g. tags:["hot"]). Each tag
			// also fires list_added automation triggers, like every other tagging path.
			// No-MX accepts get an `unverified-domain` tag so they're visible and excludable.
			const rawTags = [
				...(mxOk ? [] : ['unverified-domain']), // first — survives the MAX_TAGS cap
				...(webhookKey?.default_tags ?? '').split(','),
				...(Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags ?? '').split(','))
			];
			const tagNames = [...new Set(rawTags.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TAGS);
			for (const tn of tagNames) {
				await addTag(db, tn.slice(0, 60), c.id);
				const tag = await db
					.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'tag'")
					.bind(tn.slice(0, 60))
					.first<{ id: number }>();
				if (tag) await autoEnroll(db, tag.id, [c.id]);
			}
		}
	} catch (e) {
		console.error('auto-enroll (ingest) failed:', e);
	}

	const flagged = hygiene.disposable ? 'accepted — disposable domain' : mxOk ? null : 'accepted — no MX on domain';
	await logEvent(existing ? 'updated' : 'added', flagged);

	const dsv_id = await visitorIdFor(db, event.platform?.env, body.site_key, email);
	return json({ ok: true, status: existing ? 'updated' : 'added', list: listName, ...(dsv_id ? { dsv_id } : {}) });
};

// Keep any extra payload fields (project_type, details, tier, score, ...) as JSON on the
// contact — merged over what's already there, newest value wins. Capped to stay small.
// Skips webhook bookkeeping noise (event names, submission ids, timestamps) — that's
// visible in the /webhooks activity log, not lead context worth pinning to the contact.
const KNOWN_FIELDS = new Set([
	'email', 'name', 'first_name', 'last_name', 'company', 'list', 'source', 'tags', 'website',
	'event', 'submitted_at', 'submission_id', 'triage_via', 'site_key', 'confirm'
]);

function extraFields(body: Record<string, unknown>): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		if (KNOWN_FIELDS.has(k) || v === '' || v === null || v === undefined) continue;
		extras[k.slice(0, 50)] = typeof v === 'string' ? v.slice(0, 500) : v;
	}
	return extras;
}

/** Site tracking form hook (#152): a visitor id for this contact on the given site, or null
 *  (no/unknown/disabled site, opted-out contact). Best-effort — never fails the ingest. */
async function visitorIdFor(
	db: D1Database,
	env: { SESSION_SECRET?: string | null } | undefined,
	siteKey: unknown,
	email: string
): Promise<string | null> {
	if (!siteKey) return null;
	try {
		const site = await findSiteByKey(db, siteKey);
		const secret = sessionSecret(env);
		if (!site || !secret) return null;
		const c = await db
			.prepare('SELECT id, tracking_optout FROM contacts WHERE email = ?')
			.bind(email)
			.first<{ id: number; tracking_optout: number }>();
		if (!c || c.tracking_optout) return null;
		return await signVisitorId(secret, { c: c.id, s: site.id });
	} catch (e) {
		console.error('ingest dsv_id failed:', e);
		return null;
	}
}

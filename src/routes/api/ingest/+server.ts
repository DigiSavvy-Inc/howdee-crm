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
import { signVisitorId, verifyVisitorToken } from '$lib/server/track-token';
import { findWebhookKey, clientBucket, type WebhookKey } from '$lib/server/webhook-keys';
import { limit, ipHash } from '$lib/server/rate-limit';
import { sessionSecret } from '$lib/server/token';
import { needsConfirmation, requestConfirmation, type DeliveryResult } from '$lib/server/double-optin';
import { NO_DEFAULT_LIST_ERROR, defaultListName } from '$lib/server/default-list';

// Max distinct tags applied per request (key defaults + payload); extras are dropped.
const MAX_TAGS = 25;

// #742: rate limits, requests per 10 minutes. A client is its address (IPv6 by its /64).
const INGEST_WINDOW_SEC = 600;
/** Per client, before the key is looked up (so wrong keys count too). Not for the env key. */
const INGEST_LIMIT_PER_CLIENT = 600;
/** Per client and key, once the key is found: a key that does not trust the body. */
const INGEST_LIMIT_PER_CLIENT_KEY = 60;
/** Per client and key for a trusted key: a form backend or integration platform sends from a
 *  few addresses for many people. */
const INGEST_LIMIT_PER_CLIENT_TRUSTED_KEY = 600;
/** Per key (each webhook key, and the env key): only requests that passed the client limits. */
const INGEST_LIMIT_PER_KEY = 3000;

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
 *
 * #742: a webhook key sits in a web page, so it is public. Unless the key's "trust the body"
 * switch is on (`trust_body`): the body's `list` and `tags` are ignored (the key's own apply),
 * an existing contact only gets blank fields filled (custom fields only for keys it doesn't have
 * yet; an archived contact stays archived, also on the confirmation path until the link is
 * confirmed), and the answer is the same for a new and an existing address (`status:
 * 'accepted'`, or `pending_confirmation`). Such a key can still add the submitted address to
 * its own list and tags, which can start that key's automations.
 * `dsv_id`: an untrusted key gets it only with a valid `dsv` link token for that contact; a
 * trusted key also when this request created the contact.
 *
 * The env INGEST_KEY is a server-to-server secret and fully trusted. Never put it in a web page
 * or a form tool's URL. A web form uses a webhook key (Settings → Webhooks) with the trust
 * switch off.
 *
 * Rate limits (10 minutes, 429 + Retry-After, before anything is stored): per client before the
 * key lookup (INGEST_LIMIT_PER_CLIENT), per client and key (INGEST_LIMIT_PER_CLIENT_KEY, or
 * INGEST_LIMIT_PER_CLIENT_TRUSTED_KEY), then per key (INGEST_LIMIT_PER_KEY), counted only for a
 * request that passed the client limits. The env key gets the per-key limit only.
 * The confirmation email is sent after the response (`waitUntil`) for every key.
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

	// #742: per-client limit before the key lookup (no key hashing, no write but the counter).
	// The env key is server to server, where many submissions share one address: per-key only.
	const client = envOk ? null : await clientId(event);
	if (client) {
		const wait = await overLimit(db, `ingest:ip:${client}`, INGEST_LIMIT_PER_CLIENT);
		if (wait) return tooMany(wait);
	}

	let webhookKey: WebhookKey | null = null;
	if (!envOk && provided) webhookKey = await findWebhookKey(db, provided);
	if (!envOk && !webhookKey) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	// The env key is a server secret (server to server); a webhook key trusts the body only
	// when its switch is on.
	const trusted = envOk || webhookKey?.trust_body === 1;

	// Per client and key, then per key. A client refused by its own limit never reaches the
	// key's counter, so it can't use up a site form's allowance for everyone.
	if (webhookKey && client) {
		const max = trusted ? INGEST_LIMIT_PER_CLIENT_TRUSTED_KEY : INGEST_LIMIT_PER_CLIENT_KEY;
		const wait = await overLimit(db, `ingest:ipk:k${webhookKey.id}:${client}`, max);
		if (wait) return tooMany(wait);
	}
	{
		const wait = await overLimit(db, `ingest:key:${webhookKey ? `k${webhookKey.id}` : 'env'}`, INGEST_LIMIT_PER_KEY);
		if (wait) return tooMany(wait);
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
	// #742: the stored copy leaves out the `dsv` link token.
	const loggedBody: Record<string, unknown> = { ...body };
	delete loggedBody.dsv;
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
						JSON.stringify(loggedBody).slice(0, 1000)
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
	// Per-key defaults (#48): body wins (only when trusted, #742), then the key's defaults, then
	// DEFAULT_LIST_NAME (#596).
	const bodyList = trusted ? String(body.list ?? '').trim() : '';
	const bodyTags = trusted ? (Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags ?? '').split(',')) : [];
	const listName = bodyList || webhookKey?.default_list?.trim() || defaultListName(event.platform?.env);
	if (!listName) {
		await logEvent('rejected', 'no list configured');
		return json({ error: NO_DEFAULT_LIST_ERROR }, { status: 400 });
	}
	const source = String(body.source ?? '').trim() || webhookKey?.source?.trim() || 'api';
	// #190: a booking (snapshot:booked) must name its own list — not the magnet, not the fallback.
	// #604: only while SNAPSHOT_MODE turns snapshots on.
	const bookingProblem = snapshot.enabled(event.platform?.env) && snapshot.bookingListProblem(
		[...(webhookKey?.default_tags ?? '').split(','), ...bodyTags],
		bodyList || webhookKey?.default_list?.trim() || ''
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
		// #742: the email goes out after the response (every key), so the answer's timing doesn't
		// depend on whether one was sent.
		const held: { delivery?: Promise<DeliveryResult> } = {};
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
						...bodyTags
					]
						.map((t) => t.trim())
						.filter(Boolean)
						.slice(0, MAX_TAGS),
					fields: Object.keys(extras).length ? extras : undefined,
					// #742: untrusted → custom fields fill blanks only when confirmed.
					fields_fill_only: !trusted || undefined,
					enroll: true,
					source
				},
				contact: { name: fullName, first_name: first, last_name: last, company },
				// #742: untrusted → an archived contact is restored only by the confirm click.
				keepArchived: !trusted
			},
			{
				defer: (delivery) => {
					held.delivery = delivery;
				}
			}
		);
		if (res.contactId) {
			try {
				await recordHygiene(db, res.contactId, hygiene);
			} catch (e) {
				console.error('hygiene (ingest, pending) failed:', e);
			}
		}
		const finish = async () => {
			const sent = held.delivery ? await held.delivery : null;
			const ok = sent ? sent.ok : res.sent;
			const reason = sent ? 'send_failed' : (res.reason ?? 'unknown');
			const error = sent && !sent.ok ? sent.error : res.error;
			await logEvent('pending', ok ? 'confirmation sent' : `confirmation not sent: ${reason}${error ? ` (${error.slice(0, 100)})` : ''}`);
		};
		const followUp = finish().catch((e) => console.error('ingest confirmation follow-up failed:', e));
		const waitUntil = waitUntilOf(event);
		if (waitUntil) waitUntil(followUp);
		else await followUp;
		return json({ ok: true, status: 'pending_confirmation', ...(trusted && res.reason === 'rate_limited' ? { note: 'a confirmation was sent recently' } : {}) });
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
		.prepare('SELECT id, company FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number; company: string | null }>();

	await db
		.prepare(
			trusted
				? `INSERT INTO contacts (email, name, first_name, last_name, company, source)
				   VALUES (?, ?, ?, ?, ?, ?)
				   ON CONFLICT(email) DO UPDATE SET
				     name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
				     first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
				     last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
				     company = COALESCE(NULLIF(excluded.company, ''), contacts.company),
				     archived_at = NULL` // #280: arriving again = re-engaged → restore
				: // #742: body not trusted — fill blank fields only, never overwrite, never restore.
					`INSERT INTO contacts (email, name, first_name, last_name, company, source)
				   VALUES (?, ?, ?, ?, ?, ?)
				   ON CONFLICT(email) DO UPDATE SET
				     name = COALESCE(NULLIF(contacts.name, ''), NULLIF(excluded.name, ''), contacts.name),
				     first_name = COALESCE(NULLIF(contacts.first_name, ''), NULLIF(excluded.first_name, ''), contacts.first_name),
				     last_name = COALESCE(NULLIF(contacts.last_name, ''), NULLIF(excluded.last_name, ''), contacts.last_name),
				     company = COALESCE(NULLIF(contacts.company, ''), NULLIF(excluded.company, ''), contacts.company)`
		)
		.bind(email, fullName, first, last, company || null, source)
		.run();
	// The company text only changed when it was written: always when trusted, else only when blank.
	const companyApplied = !!company && (trusted || !existing || !String(existing.company ?? '').trim());

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
				if (trusted) Object.assign(merged, extras);
				// #742: body not trusted — add only keys the contact doesn't have yet.
				else for (const [k, v] of Object.entries(extras)) if (merged[k] === undefined) merged[k] = v;
				guardReportUrl(merged);
				await db
					.prepare('UPDATE contacts SET meta = ? WHERE id = ?')
					.bind(safeMetaJson(merged), c.id)
					.run();
			}
			await autoEnroll(db, list.id, [c.id]);
			await recordHygiene(db, c.id, hygiene);
			if (companyApplied) await syncCompanyMembership(db, c.id, company);

			// Tags: the key's default tags + any sent in the payload (`tags` as an array or a
			// comma-separated string — lets a triage step send e.g. tags:["hot"]). Each tag
			// also fires list_added automation triggers, like every other tagging path.
			// No-MX accepts get an `unverified-domain` tag so they're visible and excludable.
			const rawTags = [
				...(mxOk ? [] : ['unverified-domain']), // first — survives the MAX_TAGS cap
				...(webhookKey?.default_tags ?? '').split(','),
				...bodyTags
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

	const dsv_id = await visitorIdFor(db, event.platform?.env, body.site_key, email, {
		created: !existing,
		trusted,
		linkToken: body.dsv
	});
	// #742: the same answer for a new and an existing address (with confirmation asked for,
	// the same answer the double opt-in branch gives).
	if (!trusted) return json({ ok: true, status: wantConfirm ? 'pending_confirmation' : 'accepted', ...(dsv_id ? { dsv_id } : {}) });
	return json({ ok: true, status: existing ? 'updated' : 'added', list: listName, ...(dsv_id ? { dsv_id } : {}) });
};

// Keep any extra payload fields (project_type, details, tier, score, ...) as JSON on the
// contact — merged over what's already there, newest value wins. Capped to stay small.
// Skips webhook bookkeeping noise (event names, submission ids, timestamps) — that's
// visible in the /webhooks activity log, not lead context worth pinning to the contact.
const KNOWN_FIELDS = new Set([
	'email', 'name', 'first_name', 'last_name', 'company', 'list', 'source', 'tags', 'website',
	'event', 'submitted_at', 'submission_id', 'triage_via', 'site_key', 'confirm', 'dsv'
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
 *  (no/unknown/disabled site, opted-out contact). #742: only when `linkToken` is a valid `dsv`
 *  link token for that same contact, or, for a trusted key only, when this request created the
 *  contact (for an untrusted key that would tell the caller whether the address was new).
 *  Best-effort — never fails the ingest. */
async function visitorIdFor(
	db: D1Database,
	env: { SESSION_SECRET?: string | null } | undefined,
	siteKey: unknown,
	email: string,
	opts: { created: boolean; trusted: boolean; linkToken: unknown }
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
		if (!(opts.trusted && opts.created)) {
			const link = typeof opts.linkToken === 'string' ? await verifyVisitorToken(secret, opts.linkToken) : null;
			if (!link || link.c !== c.id) return null;
		}
		return await signVisitorId(secret, { c: c.id, s: site.id });
	} catch (e) {
		console.error('ingest dsv_id failed:', e);
		return null;
	}
}

const tooMany = (retryAfter: number) =>
	json({ error: 'too many requests' }, { status: 429, headers: { 'retry-after': String(retryAfter) } });

/** Seconds to wait when `key` is over `max` in the window, else 0. A limiter failure never
 *  blocks a real lead (fails open). */
async function overLimit(db: D1Database, key: string, max: number): Promise<number> {
	try {
		const r = await limit(db, key, { max, windowSec: INGEST_WINDOW_SEC });
		return r.ok ? 0 : r.retryAfter;
	} catch (e) {
		console.error('ingest rate limit failed:', e);
		return 0;
	}
}

/** The client's rate-limit id: a hash of its address bucket (IPv6 by /64), or null. */
async function clientId(event: Parameters<RequestHandler>[0]): Promise<string | null> {
	try {
		const bucket = clientBucket(event.request.headers.get('cf-connecting-ip'));
		return bucket ? await ipHash(bucket, event.platform?.env?.SESSION_SECRET) : null;
	} catch (e) {
		console.error('ingest client id failed:', e);
		return null;
	}
}

/** The request's `waitUntil`, bound, when the platform has one (dev / tests: none). */
function waitUntilOf(event: Parameters<RequestHandler>[0]): ((p: Promise<unknown>) => void) | undefined {
	const ctx = event.platform?.ctx;
	return ctx?.waitUntil ? (p) => ctx.waitUntil(p) : undefined;
}

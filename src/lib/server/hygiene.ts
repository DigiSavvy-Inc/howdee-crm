// Address hygiene at entry (#306) — server side: the cached MX/A lookup, recording the
// result on a contact (`meta.hygiene` + the `hygiene:invalid` tag) and the Deliverability
// "Check existing contacts" backfill. Network-free checks: $lib/email-hygiene.

import {
	checkAddressSync,
	emailDomain,
	hygieneInvalid,
	hygieneMeta,
	type Hygiene,
	type MxStatus
} from '$lib/email-hygiene';
import { domainMailStatus } from './spam';
import { autoEnroll, ensureTag } from './automations';

export const HYGIENE_INVALID_TAG = 'hygiene:invalid';

// ---------------------------------------------------------------------------------------
// MX cache — per isolate, 24 h for a definitive answer. A failed lookup ('unknown') is
// never cached, so the next caller tries again.

export const MX_TTL_MS = 24 * 60 * 60 * 1000;
const mxCache = new Map<string, { status: MxStatus; at: number }>();

export type MxLookup = (domain: string) => Promise<MxStatus>;
export type MxOptions = { lookup?: MxLookup; now?: number };

export function clearMxCache(): void {
	mxCache.clear();
}

/** The cached status, or undefined when it has to be looked up. */
export function cachedMx(domain: string, now = Date.now()): MxStatus | undefined {
	const hit = mxCache.get(domain.toLowerCase());
	if (!hit) return undefined;
	if (now - hit.at >= MX_TTL_MS) {
		mxCache.delete(domain.toLowerCase());
		return undefined;
	}
	return hit.status;
}

export async function mxStatus(domain: string, opts: MxOptions = {}): Promise<MxStatus> {
	const d = domain.trim().toLowerCase();
	if (!d) return 'none';
	const now = opts.now ?? Date.now();
	const hit = cachedMx(d, now);
	if (hit) return hit;
	let status: MxStatus;
	try {
		status = await (opts.lookup ?? domainMailStatus)(d);
	} catch {
		status = 'unknown';
	}
	if (status !== 'unknown') mxCache.set(d, { status, at: now });
	return status;
}

/**
 * Statuses for many domains: cached ones free, at most `max` fresh lookups (6 at a time).
 * Domains past the cap come back 'unknown' (not checked).
 */
export async function mxStatuses(
	domains: Iterable<string>,
	opts: MxOptions & { max?: number } = {}
): Promise<{ statuses: Map<string, MxStatus>; looked: number; unchecked: number }> {
	const max = opts.max ?? 150;
	const statuses = new Map<string, MxStatus>();
	const todo: string[] = [];
	let unchecked = 0;
	for (const raw of domains) {
		const d = raw.trim().toLowerCase();
		if (!d || statuses.has(d)) continue;
		const hit = cachedMx(d, opts.now);
		if (hit) statuses.set(d, hit);
		else if (todo.length < max) {
			statuses.set(d, 'unknown');
			todo.push(d);
		} else {
			statuses.set(d, 'unknown');
			unchecked++;
		}
	}
	for (let i = 0; i < todo.length; i += 6) {
		const part = todo.slice(i, i + 6);
		const res = await Promise.all(part.map((d) => mxStatus(d, opts)));
		part.forEach((d, j) => statuses.set(d, res[j]));
	}
	return { statuses, looked: todo.length, unchecked };
}

/** Every check, MX included (skipped for a bad address or a disposable domain). */
export async function checkAddress(email: string, opts: MxOptions = {}): Promise<Hygiene> {
	const h = checkAddressSync(email);
	if (h.syntax && !h.disposable) h.mx = await mxStatus(emailDomain(h.email), opts);
	return h;
}

// ---------------------------------------------------------------------------------------
// Recording on contacts

const SET_META_SQL = `UPDATE contacts
	SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.hygiene', ?)
	WHERE id = ?`;

/**
 * Add `hygiene:invalid` to these contacts. Only the newly tagged fire `list_added`
 * automations, so re-checking the same contact never re-enrolls it. Returns that count.
 */
export async function tagInvalid(db: D1Database, contactIds: number[]): Promise<number> {
	if (!contactIds.length) return 0;
	const tagId = await ensureTag(db, HYGIENE_INVALID_TAG);
	if (tagId == null) return 0;
	const added: number[] = [];
	for (let i = 0; i < contactIds.length; i += 500) {
		const res = await db
			.prepare(
				`INSERT OR IGNORE INTO list_members (list_id, contact_id)
				 SELECT ?, value FROM json_each(?) RETURNING contact_id`
			)
			.bind(tagId, JSON.stringify(contactIds.slice(i, i + 500)))
			.all<{ contact_id: number }>();
		added.push(...res.results.map((r) => r.contact_id));
	}
	if (added.length) {
		try {
			await autoEnroll(db, tagId, added);
		} catch (e) {
			console.error('hygiene tag auto-enroll failed:', e);
		}
	}
	return added.length;
}

/** Store `meta.hygiene` on many contacts (50 per batch) and tag the invalid ones. */
export async function recordHygieneMany(
	db: D1Database,
	rows: { id: number; hygiene: Hygiene }[]
): Promise<void> {
	const stmt = db.prepare(SET_META_SQL);
	for (let i = 0; i < rows.length; i += 50) {
		await db.batch(rows.slice(i, i + 50).map((r) => stmt.bind(hygieneMeta(r.hygiene), r.id)));
	}
	await tagInvalid(
		db,
		rows.filter((r) => hygieneInvalid(r.hygiene)).map((r) => r.id)
	);
}

export async function recordHygiene(db: D1Database, contactId: number, h: Hygiene): Promise<void> {
	await recordHygieneMany(db, [{ id: contactId, hygiene: h }]);
}

/**
 * Machine entry paths (ingest, upsert, /api/v1, Luma): check, store, tag — never reject,
 * never throw. Returns the result (null when something failed).
 */
export async function hygieneOnEntry(
	db: D1Database,
	contactId: number,
	email: string,
	opts: MxOptions = {}
): Promise<Hygiene | null> {
	try {
		const h = await checkAddress(email, opts);
		await recordHygiene(db, contactId, h);
		return h;
	} catch (e) {
		console.error('hygiene check failed:', e);
		return null;
	}
}

// ---------------------------------------------------------------------------------------
// Backfill — Deliverability "Check existing contacts". Walks subscribed, active contacts
// by id from a cursor in `app_state.hygiene_backfill`; each heartbeat tick looks up at
// most BACKFILL_DOMAINS new domains. Tags, never unsubscribes.

const BACKFILL_KEY = 'hygiene_backfill';
export const BACKFILL_DOMAINS = 25;
const BACKFILL_BATCH = 300;

export type BackfillState = {
	started_at: string;
	cursor: number;
	done: boolean;
	finished_at: string | null;
};

export async function backfillState(db: D1Database): Promise<BackfillState | null> {
	try {
		const row = await db
			.prepare('SELECT value FROM app_state WHERE key = ?')
			.bind(BACKFILL_KEY)
			.first<{ value: string | null }>();
		const v = row?.value ? (JSON.parse(row.value) as BackfillState) : null;
		return v && typeof v.cursor === 'number' ? v : null;
	} catch {
		return null;
	}
}

async function saveState(db: D1Database, s: BackfillState): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(BACKFILL_KEY, JSON.stringify(s))
		.run();
}

/** Start (or restart) a pass from the first contact. */
export async function startHygieneBackfill(db: D1Database, now = new Date()): Promise<BackfillState> {
	const s: BackfillState = { started_at: now.toISOString(), cursor: 0, done: false, finished_at: null };
	await saveState(db, s);
	return s;
}

export type BackfillStep = { checked: number; domains: number; invalid: number; done: boolean } | { skipped: string };

/**
 * One batch of the running pass. Re-running a batch (a crash before the cursor moved)
 * writes the same `meta.hygiene` and tag again — idempotent. Never throws.
 */
export async function runHygieneBackfill(
	db: D1Database,
	opts: MxOptions & { maxDomains?: number; batch?: number } = {}
): Promise<BackfillStep> {
	try {
		const state = await backfillState(db);
		if (!state || state.done) return { skipped: 'idle' };
		const maxDomains = opts.maxDomains ?? BACKFILL_DOMAINS;
		const batch = opts.batch ?? BACKFILL_BATCH;
		const rows = (
			await db
				.prepare(
					`SELECT id, email FROM contacts
					 WHERE id > ? AND subscribed = 1 AND archived_at IS NULL
					 ORDER BY id LIMIT ?`
				)
				.bind(state.cursor, batch)
				.all<{ id: number; email: string }>()
		).results;

		// Take contacts in id order until one would need a lookup past the domain cap.
		const fresh = new Set<string>();
		const take: { id: number; hygiene: Hygiene }[] = [];
		for (const r of rows) {
			// #744: an existing contact's address is checked with the rule it was stored under.
			const h = checkAddressSync(r.email, { stored: true });
			const d = emailDomain(h.email);
			const needs = h.syntax && !h.disposable && !cachedMx(d, opts.now) && !fresh.has(d);
			if (needs) {
				if (fresh.size >= maxDomains) break;
				fresh.add(d);
			}
			take.push({ id: r.id, hygiene: h });
		}
		const { statuses } = await mxStatuses(fresh, { ...opts, max: maxDomains });
		for (const t of take) {
			if (t.hygiene.syntax && !t.hygiene.disposable) {
				const d = emailDomain(t.hygiene.email);
				t.hygiene.mx = statuses.get(d) ?? (await mxStatus(d, opts));
			}
		}
		await recordHygieneMany(db, take);

		const done = take.length === rows.length && rows.length < batch;
		const next: BackfillState = {
			...state,
			cursor: take.length ? take[take.length - 1].id : state.cursor,
			done,
			finished_at: done ? new Date(opts.now ?? Date.now()).toISOString() : null
		};
		await saveState(db, next);
		return {
			checked: take.length,
			domains: fresh.size,
			invalid: take.filter((t) => hygieneInvalid(t.hygiene)).length,
			done
		};
	} catch (e) {
		console.error('hygiene backfill failed:', e);
		return { skipped: 'error' };
	}
}

export type BackfillCounts = {
	checked: number;
	invalid: number;
	role: number;
	typo: number;
	remaining: number;
};

/** Live counts over subscribed, active contacts (read from `meta.hygiene`). */
export async function hygieneCounts(db: D1Database, state?: BackfillState | null): Promise<BackfillCounts> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
			        COALESCE(SUM(h != ''), 0) AS checked,
			        COALESCE(SUM(h LIKE 'invalid%'), 0) AS invalid,
			        COALESCE(SUM((' ' || h || ' ') LIKE '% role %'), 0) AS role,
			        COALESCE(SUM(h LIKE '% typo:%'), 0) AS typo,
			        COALESCE(SUM(id > ?), 0) AS remaining
			 FROM (SELECT id, COALESCE(CASE WHEN json_valid(meta) THEN CAST(json_extract(meta, '$.hygiene') AS TEXT) END, '') AS h
			       FROM contacts WHERE subscribed = 1 AND archived_at IS NULL)`
		)
		.bind(state && !state.done ? state.cursor : Number.MAX_SAFE_INTEGER)
		.first<{ total: number; checked: number; invalid: number; role: number; typo: number; remaining: number }>();
	return {
		checked: row?.checked ?? 0,
		invalid: row?.invalid ?? 0,
		role: row?.role ?? 0,
		typo: row?.typo ?? 0,
		remaining: row?.remaining ?? 0
	};
}

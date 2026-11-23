import { json, type RequestHandler } from '@sveltejs/kit';
import { safeEqual } from '$lib/server/auth';

/**
 * #637: health check for monitoring and deploy tooling (is the instance migrated and ticking?).
 *
 * Auth: `Authorization: Bearer <CRON_KEY>` only (the same key and constant-time compare
 * the tick route uses). No key configured, or a wrong one → 401. Returns counts and
 * names only — no personal data: `ok`, `latest_migration`, `last_tick_at`, `users`.
 */
export const GET: RequestHandler = async (event) => {
	const key = String(event.platform?.env?.CRON_KEY ?? '');
	const provided = (event.request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!key || !provided || !safeEqual(provided, key)) {
		return json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
	}

	const db = event.platform?.env?.DB as D1Database | undefined;
	if (!db) {
		return json(
			{ ok: false, latest_migration: null, last_tick_at: null, users: null, error: 'no database binding' },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	}

	let latest: string | null = null;
	let lastTick: string | null = null;
	let users: number | null = null;
	let error: string | undefined;
	try {
		latest =
			(await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>())?.name ?? null;
	} catch {
		error = 'migrations not readable';
	}
	try {
		lastTick =
			(await db.prepare(`SELECT updated_at FROM app_state WHERE key = 'last_tick'`).first<{ updated_at: string | null }>())
				?.updated_at ?? null;
		users = (await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;
	} catch {
		error = error ?? 'database not readable';
	}

	const ok = !error;
	return json(
		{ ok, latest_migration: latest, last_tick_at: lastTick, users, ...(error ? { error } : {}) },
		{ status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};

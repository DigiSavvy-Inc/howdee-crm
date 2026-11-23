import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

/** Get the D1 binding or fail loudly (helps when platform proxy isn't wired in dev). */
export function getDB(event: { platform?: App.Platform }): D1Database {
	const db = event.platform?.env?.DB;
	if (!db) {
		throw error(
			500,
			'D1 binding (DB) is not available. Run via `npm run dev` so the Cloudflare platform proxy is active.'
		);
	}
	return db;
}

/** Read a required config/secret value from the platform env. */
export function env<K extends keyof Env>(event: RequestEvent, key: K): Env[K] {
	const val = event.platform?.env?.[key];
	if (val === undefined || val === null || val === '') {
		throw error(500, `Missing required env: ${String(key)}`);
	}
	return val as Env[K];
}

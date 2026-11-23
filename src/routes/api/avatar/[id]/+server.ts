import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { resolveAvatar, avatarIsFresh, initials, hueFor, initialsSvg } from '$lib/server/avatars';

// #105: serves a contact's avatar. Session-gated automatically — this path is NOT in
// PUBLIC_PREFIXES (src/hooks.server.ts), so a contact's email (or its Gravatar hash) is
// never exposed to an unauthenticated request. Resolves + caches on first view (R2 + the
// four avatar_* columns on `contacts`); `?refresh=1` forces a re-check.

type ContactAvatarRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	meta: string | null;
	avatar_source: string | null;
	avatar_key: string | null;
	avatar_checked_at: string | null;
	avatar_email: string | null;
};

let loggedNoR2 = false;

function initialsResponse(row: ContactAvatarRow, extraHeaders: Record<string, string>): Response {
	const letters = initials(row.name, row.first_name, row.last_name, row.email);
	const hue = hueFor(row.email);
	return new Response(initialsSvg(letters, hue), {
		headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', ...extraHeaders }
	});
}

export const GET: RequestHandler = async (event) => {
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');

	const db = getDB(event);
	const row = await db
		.prepare(
			`SELECT id, email, name, first_name, last_name, meta,
			        avatar_source, avatar_key, avatar_checked_at, avatar_email
			 FROM contacts WHERE id = ?`
		)
		.bind(id)
		.first<ContactAvatarRow>();
	if (!row) throw error(404, 'Not found');

	let meta: Record<string, unknown> = {};
	try {
		meta = row.meta ? JSON.parse(row.meta) : {};
	} catch {
		meta = {};
	}

	const forceRefresh = event.url.searchParams.get('refresh') === '1';
	const fresh = !forceRefresh && avatarIsFresh(row, row.email);

	if (fresh && row.avatar_source === 'none') {
		return initialsResponse(row, {
			'Cache-Control': 'private, max-age=86400',
			'X-Avatar-Source': 'none',
			'X-Avatar-Cache': 'hit'
		});
	}

	if (fresh && row.avatar_source && row.avatar_key) {
		const bucket = event.platform?.env?.MEDIA;
		if (bucket) {
			const obj = await bucket.get(row.avatar_key);
			if (obj) {
				return new Response(obj.body, {
					headers: {
						'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
						'Cache-Control': 'private, max-age=86400',
						'X-Avatar-Source': row.avatar_source,
						'X-Avatar-Cache': 'hit'
					}
				});
			}
			// R2 object vanished unexpectedly — fall through and re-resolve.
		}
		// Bucket missing — fall through and re-resolve.
	}

	const result = await resolveAvatar(row.email, meta, fetch);

	if (result.source !== 'none') {
		const bucket = event.platform?.env?.MEDIA;
		let avatarKey: string | null = null;
		if (bucket) {
			try {
				await bucket.put('avatars/' + id, result.bytes!, {
					httpMetadata: { contentType: result.contentType }
				});
				avatarKey = 'avatars/' + id;
			} catch (e) {
				console.error('[avatar] R2 put failed for contact', id, e);
			}
		} else if (!loggedNoR2) {
			loggedNoR2 = true;
			console.log(
				'[avatar] MEDIA R2 binding not available — avatars will not be cached to R2 (expected in some local dev setups)'
			);
		}

		await db
			.prepare(
				`UPDATE contacts SET avatar_source = ?, avatar_key = ?, avatar_checked_at = datetime('now'), avatar_email = ?
				 WHERE id = ?`
			)
			.bind(result.source, avatarKey, row.email, id)
			.run();

		return new Response(result.bytes, {
			headers: {
				'Content-Type': result.contentType!,
				'Cache-Control': 'private, max-age=86400',
				'X-Avatar-Source': result.source,
				'X-Avatar-Cache': 'miss'
			}
		});
	}

	if (!result.transient) {
		await db
			.prepare(
				`UPDATE contacts SET avatar_source = 'none', avatar_key = NULL, avatar_checked_at = datetime('now'), avatar_email = ?
				 WHERE id = ?`
			)
			.bind(row.email, id)
			.run();

		return initialsResponse(row, {
			'Cache-Control': 'private, max-age=86400',
			'X-Avatar-Source': 'none',
			'X-Avatar-Cache': 'miss'
		});
	}

	// Transient network failure — don't persist 'none', retry soon.
	return initialsResponse(row, {
		'Cache-Control': 'private, max-age=60',
		'X-Avatar-Source': 'none',
		'X-Avatar-Cache': 'miss'
	});
};

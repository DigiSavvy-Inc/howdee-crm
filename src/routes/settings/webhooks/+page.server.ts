import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { snapshot } from '$lib/server/snapshot';

type KeyRow = {
	id: number;
	label: string;
	token: string;
	default_list: string | null;
	default_tags: string | null;
	source: string | null;
	created_at: string;
	last_used_at: string | null;
	request_count: number;
	revoked_at: string | null;
	require_confirm: number;
};

/** 48 hex chars of CSPRNG. */
function genToken(): string {
	const b = new Uint8Array(24);
	crypto.getRandomValues(b);
	return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// #532: admin-only — load AND every action (a member could mint a read_write key / read ingest tokens).
const isAdmin = (event: { locals: App.Locals }) => event.locals.user?.role === 'admin';

export const load: PageServerLoad = async (event) => {
	if (!isAdmin(event)) throw error(403, 'Admins only.');
	const db = getDB(event);

	const keys = await db
		.prepare(
			`SELECT id, label, token, default_list, default_tags, source, created_at, last_used_at, request_count, revoked_at, require_confirm
			 FROM webhook_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC`
		)
		.all<KeyRow>();

	const lists = await db
		// #472: archived lists aren't offered — unless a key already routes to one (kept by name,
		// since the key stores the name).
		.prepare(
			`SELECT name FROM lists WHERE kind = 'list'
			   AND (archived_at IS NULL OR name IN (SELECT default_list FROM webhook_keys WHERE default_list IS NOT NULL))
			 ORDER BY name`
		)
		.all<{ name: string }>();

	// Recent activity across all keys — what each request received and how it was handled.
	const events = await db
		.prepare(
			`SELECT e.id, e.email, e.status, e.detail, e.payload, e.created_at, k.label AS key_label
			 FROM webhook_events e
			 LEFT JOIN webhook_keys k ON k.id = e.key_id
			 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`
		)
		.all<{
			id: number;
			email: string | null;
			status: string;
			detail: string | null;
			payload: string | null;
			created_at: string;
			key_label: string | null;
		}>();

	const baseUrl = await publicBaseUrlFor(event);

	return { keys: keys.results, lists: lists.results.map((l) => l.name), events: events.results, baseUrl };
};

export const actions: Actions = {
	create: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const label = String(data.get('label') ?? '').trim();
		const defaultList = String(data.get('default_list') ?? '').trim() || null;
		const source = String(data.get('source') ?? '').trim() || null;
		// Normalize the comma-separated tag list (trim, drop empties, cap at 10).
		const defaultTags =
			String(data.get('default_tags') ?? '')
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean)
				.slice(0, 10)
				.join(', ') || null;
		if (!label) return fail(400, { error: 'Give the webhook a name.' });
		// #604: the snapshot:booked list rule applies only while snapshots are on.
		const bookingProblem = snapshot.enabled(event.platform?.env)
			? snapshot.bookingListProblem((defaultTags ?? '').split(','), defaultList)
			: null;
		if (bookingProblem) return fail(400, { error: bookingProblem });

		const token = genToken();
		const requireConfirm = data.get('require_confirm') === '1' ? 1 : 0; // #510
		const row = await db
			.prepare(
				`INSERT INTO webhook_keys (label, token, default_list, default_tags, source, require_confirm)
				 VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
			)
			.bind(label, token, defaultList, defaultTags, source, requireConfirm)
			.first<{ id: number }>();
		return { ok: true, createdId: row?.id };
	},

	// Edit an active key's routing (label stays; token never changes).
	update: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Missing key.' });
		const defaultList = String(data.get('default_list') ?? '').trim() || null;
		const source = String(data.get('source') ?? '').trim() || null;
		const defaultTags =
			String(data.get('default_tags') ?? '')
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean)
				.slice(0, 10)
				.join(', ') || null;
		// #604: the snapshot:booked list rule applies only while snapshots are on.
		const bookingProblem = snapshot.enabled(event.platform?.env)
			? snapshot.bookingListProblem((defaultTags ?? '').split(','), defaultList)
			: null;
		if (bookingProblem) return fail(400, { error: bookingProblem });
		await db
			.prepare('UPDATE webhook_keys SET default_list = ?, default_tags = ?, source = ?, require_confirm = ? WHERE id = ? AND revoked_at IS NULL')
			.bind(defaultList, defaultTags, source, data.get('require_confirm') === '1' ? 1 : 0, id)
			.run();
		return { ok: true };
	},

	revoke: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing key.' });
		await db
			.prepare("UPDATE webhook_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
			.bind(id)
			.run();
		return { ok: true };
	},

	remove: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing key.' });
		// Hard-delete only revoked keys (keeps active ones safe from accidental loss).
		await db.prepare('DELETE FROM webhook_keys WHERE id = ? AND revoked_at IS NOT NULL').bind(id).run();
		return { ok: true };
	}
};

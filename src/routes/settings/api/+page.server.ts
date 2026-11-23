import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { generateApiKey, type ApiKeyRow, type ApiScope } from '$lib/server/api-keys';
import { toolsForScope } from '$lib/server/mcp/tools';

function normScope(v: FormDataEntryValue | null): ApiScope {
	const s = String(v ?? '');
	return s === 'read_write' || s === 'campaigns:draft' || s === 'automations:draft' ? s : 'read';
}

// #532: admin-only — load AND every action (a member could mint a read_write key / read ingest tokens).
const isAdmin = (event: { locals: App.Locals }) => event.locals.user?.role === 'admin';

export const load: PageServerLoad = async (event) => {
	if (!isAdmin(event)) throw error(403, 'Admins only.');
	const db = getDB(event);
	const keys = await db
		.prepare(
			`SELECT id, label, token_prefix, token_last4, scope, created_at, last_used_at, request_count, revoked_at
			 FROM api_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC`
		)
		.all<ApiKeyRow>();

	const baseUrl = await publicBaseUrlFor(event);
	// #348: the MCP card — endpoint + which tools each scope gets.
	const scopes: ApiScope[] = ['read', 'campaigns:draft', 'automations:draft', 'read_write'];
	const mcpTools = scopes.map((scope) => ({ scope, tools: toolsForScope(scope) }));
	return { keys: keys.results, apiBase: `${baseUrl}/api/v1`, mcpUrl: `${baseUrl}/mcp`, mcpTools };
};

/** Mint a key, persist its hash, and return the plaintext once for show-once display. */
async function mint(db: D1Database, label: string, scope: ApiScope) {
	const k = await generateApiKey();
	const row = await db
		.prepare(
			`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope)
			 VALUES (?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(label, k.tokenHash, k.prefix, k.last4, scope)
		.first<{ id: number }>();
	return { id: row?.id, token: k.token };
}

export const actions: Actions = {
	create: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const label = String(data.get('label') ?? '').trim();
		if (!label) return fail(400, { error: 'Give the key a name.' });
		const { id, token } = await mint(db, label, normScope(data.get('scope')));
		// `token` is returned ONCE — the page shows it then it's unrecoverable.
		return { ok: true, createdId: id, token, label };
	},

	// Rotate: mint a replacement (same label + scope), then revoke the old one. The new
	// plaintext is shown once; the old key stops working immediately.
	rotate: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Missing key.' });
		const old = await db
			.prepare('SELECT label, scope FROM api_keys WHERE id = ? AND revoked_at IS NULL')
			.bind(id)
			.first<{ label: string; scope: ApiScope }>();
		if (!old) return fail(400, { error: 'Key not found or already revoked.' });

		// Mint + revoke atomically (one D1 batch = one transaction): a failure can't leave
		// both keys active, nor a new active key whose plaintext was never shown.
		const k = await generateApiKey();
		const results = await db.batch([
			db
				.prepare(
					`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope)
					 VALUES (?, ?, ?, ?, ?) RETURNING id`
				)
				.bind(old.label, k.tokenHash, k.prefix, k.last4, old.scope),
			db
				.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
				.bind(id)
		]);
		const newId = (results[0].results as { id: number }[])[0]?.id;
		return { ok: true, createdId: newId, token: k.token, label: old.label, rotatedFrom: id };
	},

	revoke: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing key.' });
		await db
			.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
			.bind(id)
			.run();
		return { ok: true };
	},

	remove: async (event) => {
		if (!isAdmin(event)) return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const id = Number((await event.request.formData()).get('id'));
		if (!id) return fail(400, { error: 'Missing key.' });
		// Hard-delete only revoked keys (active ones are safe from accidental loss).
		await db.prepare('DELETE FROM api_keys WHERE id = ? AND revoked_at IS NOT NULL').bind(id).run();
		return { ok: true };
	}
};

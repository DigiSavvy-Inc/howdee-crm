import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { cleanGroupIds, isManageableKind, loadGroups } from '$lib/server/groups-bulk';
import { memberIds } from '$lib/server/segments';
import { csvCell } from '$lib/report-view';
import { activeContactSql, rulesAskForSubscription } from '$lib/server/active-audience';
import { parseRules } from '$lib/server/segment-query';

/**
 * #215: members of the selected groups as CSV (`?id=1&id=2`), one row per contact with the
 * selected groups it's in. Session-authed (NOT in PUBLIC_PREFIXES). Dynamic segments
 * resolve through their rules. #705: only the active audience — no unsubscribed or archived
 * rows (the Contacts page export follows its own filter).
 */
export const GET: RequestHandler = async (event) => {
	const kind = String(event.params.kind);
	if (!isManageableKind(kind)) throw error(404, 'Unknown group type');
	const db = getDB(event);
	const groups = (await loadGroups(db, event.url.searchParams.getAll('id'))).filter((g) => g.kind === kind);
	if (groups.length === 0) throw error(400, `Select at least one ${kind}.`);

	const inGroups = new Map<number, string[]>();
	// #705: members of a segment whose rules ask about subscription keep their unsubscribed rows.
	const keepUnsubscribed = new Set<number>();
	for (const g of groups) {
		const asks = g.kind === 'segment' && rulesAskForSubscription(parseRules(g.rules));
		for (const id of await memberIds(db, g)) {
			const names = inGroups.get(id) ?? [];
			names.push(g.name);
			inGroups.set(id, names);
			if (asks) keepUnsubscribed.add(id);
		}
	}

	const ids = [...inGroups.keys()].sort((a, b) => a - b);
	const header = ['email', 'name', 'first_name', 'last_name', 'company', 'subscribed', 'source', 'created_at', kind + 's'];
	const lines = [header.join(',')];
	for (let i = 0; i < ids.length; i += 90) {
		const part = ids.slice(i, i + 90);
		const rows = await db
			.prepare(
				`SELECT id, email, name, first_name, last_name, company, subscribed, source, created_at,
				        ${activeContactSql()} AS active
				 FROM contacts WHERE id IN (${part.map(() => '?').join(', ')}) AND archived_at IS NULL ORDER BY id`
			)
			.bind(...part)
			.all<Record<string, unknown> & { id: number; active: number }>();
		for (const r of rows.results) {
			if (!r.active && !keepUnsubscribed.has(r.id)) continue;
			lines.push(
				[
					csvCell(r.email), csvCell(r.name), csvCell(r.first_name), csvCell(r.last_name), csvCell(r.company), csvCell(r.subscribed),
					csvCell(r.source), csvCell(r.created_at), csvCell((inGroups.get(r.id) ?? []).join('; '))
				].join(',')
			);
		}
	}

	const today = new Date().toISOString().slice(0, 10);
	const slug = groups.length === 1 ? groups[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || kind : `${kind}s`;
	return new Response(lines.join('\r\n') + '\r\n', {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${slug}-members-${today}.csv"`
		}
	});
};

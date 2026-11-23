import type { RequestHandler } from '@sveltejs/kit';
import { hygieneOnEntry } from '$lib/server/hygiene';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { isEmail } from '$lib/csv';
import {
	requireKey,
	apiData,
	apiError,
	parsePaging,
	parseBool,
	buildPagination,
	serializeContact,
	loadContact,
	listMembershipWhere,
	dynamicSegmentNames,
	mergeDynamicLists,
	CONTACT_GROUPS_SQL,
	type ContactRow
} from '$lib/server/api-v1';
import { syncCompanyMembership } from '$lib/server/companies';
import {
	applyMemberships,
	validateContactWriteBody,
	coerceSubscribed,
	fieldStr,
	type ContactWriteBody
} from '$lib/server/contact-write';
import { snapshot } from '$lib/server/snapshot';
import { archivedClause, parseArchivedView } from '$lib/server/contacts-query';
import { activeSubscriptionSql } from '$lib/server/active-audience';

// GET /api/v1/contacts — list contacts (read scope).
// Filters: email (exact), q (search email/name), subscribed, source (exact),
//          list (name; any list/segment/company), tag (name), company_id (#166),
//          created_since, created_until, archived (#280: default active only; `1` = archived
//          only, `all` = both). #705: with none of subscribed / email / archived, only the
//          active audience (subscribed or pending) is listed.
// Paging: limit (default 50, max 200), offset.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const db = getDB(event);
	const url = event.url;
	const { limit, offset } = parsePaging(url);

	const where: string[] = [];
	const binds: unknown[] = [];

	const email = url.searchParams.get('email')?.trim();
	if (email) {
		where.push('c.email = ?');
		binds.push(email.toLowerCase());
	}

	const q = url.searchParams.get('q')?.trim();
	if (q) {
		const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
		where.push("(c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.first_name LIKE ? ESCAPE '\\' OR c.last_name LIKE ? ESCAPE '\\')");
		binds.push(like, like, like, like);
	}

	const subscribed = parseBool(url.searchParams.get('subscribed'));
	if (subscribed !== undefined) {
		where.push('c.subscribed = ?');
		binds.push(subscribed ? 1 : 0);
	}

	const source = url.searchParams.get('source')?.trim();
	if (source) {
		where.push('c.source = ?');
		binds.push(source);
	}

	const list = url.searchParams.get('list')?.trim();
	if (list) {
		// Resolve the list row first so dynamic segments (#66, rules-based — no
		// list_members rows) filter through their compiled rules, like the rest of the app.
		const listRow = await db
			.prepare("SELECT id, kind, rules FROM lists WHERE name = ? AND kind IN ('list','segment','company')")
			.bind(list)
			.first<{ id: number; kind: string; rules: string | null }>();
		if (!listRow) {
			return apiData([], buildPagination(limit, offset, 0));
		}
		const m = listMembershipWhere(listRow);
		where.push(m.sql);
		binds.push(...m.binds);
	}

	const tag = url.searchParams.get('tag')?.trim();
	if (tag) {
		where.push(
			"EXISTS (SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = c.id AND l.name = ? AND l.kind = 'tag')"
		);
		binds.push(tag);
	}

	const companyId = url.searchParams.get('company_id')?.trim();
	if (companyId) {
		const cid = Number(companyId);
		if (!Number.isInteger(cid) || cid <= 0) return apiError(400, 'Invalid company_id.');
		where.push('c.company_id = ?');
		binds.push(cid);
	}

	const createdSince = url.searchParams.get('created_since')?.trim();
	if (createdSince) {
		where.push('c.created_at >= ?');
		binds.push(createdSince);
	}
	const createdUntil = url.searchParams.get('created_until')?.trim();
	if (createdUntil) {
		where.push('c.created_at <= ?');
		binds.push(createdUntil);
	}

	// #280: archived contacts are left out unless asked for — `archived=1` only them,
	// `archived=all` both.
	const archivedView = parseArchivedView(url.searchParams.get('archived'));
	const arch = archivedClause(archivedView, 'c.archived_at');
	if (arch) where.push(arch);
	// #705: with no `subscribed`, `email` or `archived` param, the list is the active audience
	// (subscribed or pending double opt-in). `subscribed=false` lists the unsubscribed; an exact
	// `email` lookup finds a contact whatever their status.
	if (subscribed === undefined && !email && !archivedView) where.push(activeSubscriptionSql('c'));

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

	const totalRow = await db
		.prepare(`SELECT COUNT(*) AS n FROM contacts c ${whereSql}`)
		.bind(...binds)
		.first<{ n: number }>();
	const total = totalRow?.n ?? 0;

	const rows = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.company_id, c.subscribed,
			        c.source, c.created_at, c.archived_at, c.meta, ${CONTACT_GROUPS_SQL}
			 FROM contacts c ${whereSql}
			 ORDER BY c.created_at DESC, c.id DESC
			 LIMIT ? OFFSET ?`
		)
		.bind(...binds, limit, offset)
		.all<ContactRow>();

	const contacts = rows.results.map(serializeContact);
	mergeDynamicLists(contacts, await dynamicSegmentNames(db, contacts.map((c) => c.id)));
	return apiData(contacts, buildPagination(limit, offset, total));
};

// POST /api/v1/contacts — create a contact (read_write scope). `email` required; 409 if it
// already exists. Optional: name/first_name/last_name/company/source/subscribed, plus
// list/tags/remove_tags/enroll membership. Returns 201 with the created contact.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	let body: ContactWriteBody;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Invalid JSON body.');
	}
	const invalid = validateContactWriteBody(body);
	if (invalid) return apiError(400, invalid);

	const email = String(body.email ?? '').trim().toLowerCase();
	if (!email) return apiError(400, 'email is required.');
	if (!isEmail(email)) return apiError(400, 'Invalid email.');

	const db = getDB(event);
	const existing = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
	if (existing) return json({ error: 'A contact with this email already exists.', conflict_id: existing.id }, { status: 409 });

	// One INSERT carrying every provided field (no partial-write window). Source defaults
	// to 'api' when absent OR empty — matching /api/contacts/upsert's create semantics.
	// The UNIQUE catch covers the pre-check race (two concurrent creates): 409, not 500.
	let id: number;
	try {
		const inserted = await db
			.prepare(
				`INSERT INTO contacts (email, name, first_name, last_name, company, source, subscribed)
				 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
			)
			.bind(
				email,
				fieldStr(body, 'name'),
				fieldStr(body, 'first_name'),
				fieldStr(body, 'last_name'),
				fieldStr(body, 'company'),
				fieldStr(body, 'source') ?? 'api',
				coerceSubscribed(body.subscribed) === false ? 0 : 1
			)
			.first<{ id: number }>();
		id = inserted!.id;
	} catch (e) {
		if (String(e).includes('UNIQUE')) {
			const clash = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
			return json({ error: 'A contact with this email already exists.', conflict_id: clash?.id }, { status: 409 });
		}
		throw e;
	}

	await syncCompanyMembership(db, id, fieldStr(body, 'company'));
	await hygieneOnEntry(db, id, email); // #306: tag, never reject
	// #604: no snapshot release hook unless SNAPSHOT_MODE turns snapshots on.
	const approvedHook = snapshot.enabled(event.platform?.env)
		? snapshot.approvedHook(db, event.platform?.env, { allowReenroll: true })
		: undefined;
	await applyMemberships(db, id, body, approvedHook);

	return json({ data: (await loadContact(db, id))! }, { status: 201 });
};

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions as contactActions } from '../src/routes/contacts/+page.server';
import { actions as contactPageActions } from '../src/routes/contacts/[id]/+page.server';
import { POST as bulkApi } from '../src/routes/api/v1/contacts/bulk/+server';
import { GET as contactsApi } from '../src/routes/api/v1/contacts/+server';
import { POST as ingest } from '../src/routes/api/ingest/+server';
import { generateApiKey } from '../src/lib/server/api-keys';
import { enroll, tick } from '../src/lib/server/automations';
import { memberCount, memberIds, recipientsForList } from '../src/lib/server/segments';
import { contactsFilterQuery } from '../src/lib/server/contact-bulk';
import { archiveContacts, restoreContacts } from '../src/lib/server/contact-archive';
import { applyContactFields } from '../src/lib/server/contact-write';
import { nonOpenerRecipients } from '../src/lib/server/resend';

// #280: archive hides a contact from views and from every send path; restore brings it back.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}
async function group(name: string, kind: string, rules: string | null = null): Promise<number> {
	return (await db
		.prepare('INSERT INTO lists (name, kind, rules) VALUES (?, ?, ?) RETURNING id')
		.bind(name, kind, rules)
		.first<{ id: number }>())!.id;
}
async function join(listId: number, ...ids: number[]) {
	await db.batch(ids.map((c) => db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c)));
}
async function archivedAt(id: number): Promise<string | null> {
	return (await db.prepare('SELECT archived_at FROM contacts WHERE id = ?').bind(id).first<{ archived_at: string | null }>())!.archived_at;
}
function form(fields: Record<string, string | string[]>): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
	return fd;
}
function contactsEvent(action: string, fields: Record<string, string | string[]>) {
	return {
		platform: { env },
		request: new Request(`https://app.test/contacts?/${action}`, { method: 'POST', body: form(fields) })
	} as any;
}
async function key(): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
		.bind('t', k.tokenHash, k.prefix, k.last4, 'read_write')
		.run();
	return k.token;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM webhook_events'),
		db.prepare('DELETE FROM webhook_keys'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('archive keeps a contact out of sends', () => {
	it('list sends, member ids and counts skip archived contacts; restore brings them back', async () => {
		const list = await group('News', 'list');
		const a = await contact('a@arch.test');
		const b = await contact('b@arch.test');
		await join(list, a, b);
		expect(await archiveContacts(db, [b])).toBe(1);
		expect(await archiveContacts(db, [b])).toBe(0); // idempotent

		expect((await recipientsForList(db, list)).map((r) => r.email)).toEqual(['a@arch.test']);
		expect(await memberIds(db, { id: list, kind: 'list' })).toEqual([a]);
		expect(await memberCount(db, { id: list, kind: 'list' })).toBe(1);
		// Subscription is untouched.
		expect((await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(b).first<{ subscribed: number }>())!.subscribed).toBe(1);

		expect(await restoreContacts(db, [b])).toBe(1);
		expect(await archivedAt(b)).toBeNull();
		expect(await memberCount(db, { id: list, kind: 'list' })).toBe(2);
	});

	it('dynamic segments exclude archived contacts (sends and counts)', async () => {
		const a = await contact('a@seg.test');
		const b = await contact('b@seg.test');
		const seg = await group('All subscribed', 'segment', JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] }));
		await archiveContacts(db, [a]);
		const row = { id: seg, kind: 'segment', rules: JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] }) };
		expect(await memberCount(db, row)).toBe(1);
		expect((await recipientsForList(db, seg)).map((r) => r.id)).toEqual([b]);
	});

	it('resend to non-openers skips archived contacts', async () => {
		const a = await contact('a@res.test');
		const b = await contact('b@res.test');
		const camp = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('S', '', '', 'x@y.z', 'sent') RETURNING id")
			.first<{ id: number }>())!.id;
		await db.batch(
			[a, b].map((c, i) =>
				db
					.prepare("INSERT INTO recipients (campaign_id, contact_id, email, status, message_id) VALUES (?, ?, ?, 'accepted', ?)")
					.bind(camp, c, `${'ab'[i]}@res.test`, `m${i}`)
			)
		);
		await archiveContacts(db, [b]);
		expect((await nonOpenerRecipients(db, camp)).map((r) => r.id)).toEqual([a]);
	});

	it('enroll() skips archived contacts, and the tick cancels an active pass with reason "archived"', async () => {
		const aid = (await db.prepare("INSERT INTO automations (name, status) VALUES ('A', 'active') RETURNING id").first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
				 VALUES (?, 0, 0, '', '', '', 'tag', 'add', 'reached')`
			)
			.bind(aid)
			.run();
		const a = await contact('a@auto.test');
		const b = await contact('b@auto.test');
		await archiveContacts(db, [a]);
		expect(await enroll(db, aid, [a, b])).toMatchObject({ enrolled: 1, skipped: 1 });

		await archiveContacts(db, [b]); // archived while mid-flow
		const summary = await tick(db, cfg);
		expect(summary.cancelled).toBe(1);
		const row = await db
			.prepare('SELECT status, last_error, ended_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(b)
			.first<{ status: string; last_error: string | null; ended_at: string | null }>();
		expect(row).toMatchObject({ status: 'cancelled', last_error: 'archived' });
		expect(row!.ended_at).not.toBeNull();
	});
});

describe('/contacts archive view + bulk bar', () => {
	it('the filter hides archived by default; archived=1 lists only archived ones', async () => {
		const a = await contact('a@view.test');
		const b = await contact('b@view.test');
		await archiveContacts(db, [b]);
		const run = async (qs: string) => {
			const q = await contactsFilterQuery(db, new URLSearchParams(qs));
			return (await db.prepare(q.sql).bind(...q.binds).all<{ id: number }>()).results.map((r) => r.id).sort();
		};
		expect(await run('')).toEqual([a]);
		expect(await run('archived=1')).toEqual([b]);
		expect(await run('archived=all')).toEqual([a, b].sort());
	});

	it('Archive acts on checked rows; Restore on all matching in the archived view', async () => {
		const a = await contact('a@bulk.test');
		const b = await contact('b@bulk.test');
		const c = await contact('c@bulk.test');
		const res = await contactActions.archiveContacts(contactsEvent('archiveContacts', { contact_ids: [String(a), String(b)] }));
		expect(res).toMatchObject({ affected: 2, bulkSuccess: 'Archived 2 contacts' });
		expect(await archivedAt(a)).not.toBeNull();
		expect(await archivedAt(c)).toBeNull();

		const back = await contactActions.restoreContacts(contactsEvent('restoreContacts', { all: '1', archived: '1' }));
		expect(back).toMatchObject({ affected: 2 });
		expect(await archivedAt(a)).toBeNull();
		expect(await archivedAt(b)).toBeNull();
	});

	it('the contact page archives and restores one contact', async () => {
		const a = await contact('a@page.test');
		const ev = (archive: string) =>
			({
				platform: { env },
				params: { id: String(a) },
				request: new Request(`https://app.test/contacts/${a}?/setArchived`, { method: 'POST', body: form({ archive }) })
			}) as any;
		expect(await contactPageActions.setArchived(ev('1'))).toEqual({ archiveOk: true });
		expect(await archivedAt(a)).not.toBeNull();
		await contactPageActions.setArchived(ev('0'));
		expect(await archivedAt(a)).toBeNull();
	});
});

describe('Data API', () => {
	function req(handler: any, path: string, token: string, init: RequestInit = {}) {
		const url = new URL(`https://app.test${path}`);
		const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
		return handler({ request: new Request(url, { ...init, headers }), platform: { env }, url, params: {} } as any);
	}
	const json = async (res: Response) => JSON.parse(await res.text());

	it('GET /contacts hides archived by default; ?archived=1 / all; archived_at serialized', async () => {
		const t = await key();
		const a = await contact('a@api.test');
		const b = await contact('b@api.test');
		await archiveContacts(db, [b]);
		const ids = async (qs: string) => (await json(await req(contactsApi, `/api/v1/contacts${qs}`, t))).data.map((c: any) => c.id).sort();
		expect(await ids('')).toEqual([a]);
		expect(await ids('?archived=1')).toEqual([b]);
		expect(await ids('?archived=all')).toEqual([a, b].sort());
		const one = (await json(await req(contactsApi, '/api/v1/contacts?archived=1', t))).data[0];
		expect(typeof one.archived_at).toBe('string');
	});

	it('bulk archive by ids and restore by filter', async () => {
		const t = await key();
		const a = await contact('a@bapi.test');
		const b = await contact('b@bapi.test');
		const post = (body: unknown) => req(bulkApi, '/api/v1/contacts/bulk', t, { method: 'POST', body: JSON.stringify(body) });
		const arch = await post({ action: 'archive', ids: [a, b] });
		expect(arch.status).toBe(200);
		expect((await json(arch)).data).toMatchObject({ action: 'archive', affected: 2 });
		expect(await archivedAt(a)).not.toBeNull();

		const rest = await post({ action: 'restore', filter: { archived: 1 } });
		expect((await json(rest)).data).toMatchObject({ action: 'restore', matched: 2, affected: 2 });
		expect(await archivedAt(b)).toBeNull();
	});

	it('a write with subscribed: true restores; one without the field does not', async () => {
		const a = await contact('a@patch.test');
		await archiveContacts(db, [a]);
		await applyContactFields(db, a, { name: 'Ann' }, { currentEmail: 'a@patch.test' });
		expect(await archivedAt(a)).not.toBeNull();
		await applyContactFields(db, a, { subscribed: true }, { currentEmail: 'a@patch.test' });
		expect(await archivedAt(a)).toBeNull();
	});
});

describe('ingest restores an archived contact', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('a form submission un-archives them', async () => {
		globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch; // DoH fails open
		await db.prepare("INSERT INTO webhook_keys (label, token, default_list, trust_body) VALUES ('Form', 'wk_arch', 'Arch list', 1)").run();
		const a = await contact('back@example.com');
		await archiveContacts(db, [a]);
		const url = 'https://crm.test/api/ingest';
		const res = await ingest({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer wk_arch' },
				body: JSON.stringify({ email: 'back@example.com' })
			}),
			url: new URL(url),
			platform: { env }
		} as any);
		expect(res.status).toBeLessThan(300);
		expect(await archivedAt(a)).toBeNull();
	});
});

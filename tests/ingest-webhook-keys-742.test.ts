import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { POST as ingest } from '../src/routes/api/ingest/+server';
import * as webhooks from '../src/routes/settings/webhooks/+page.server';
import { signVisitorToken, verifyVisitorId } from '../src/lib/server/track-token';
import { sha256Hex } from '../src/lib/server/api-keys';
import { ipHash } from '../src/lib/server/rate-limit';
import { clientBucket, findWebhookKey, isPlaintextToken, isPreMigrationKeyError } from '../src/lib/server/webhook-keys';
import { REDACTED_COLUMNS } from '../src/lib/server/backups';
import { applyIntent } from '../src/lib/server/double-optin';

// #742: form webhook keys — the "trust the body" switch, the visitor id rule, the rate limit
// and hashed keys.

const db = (env as any).DB as D1Database;
const SECRET = 'test-session-secret-742';
const SITE_KEY = 'dsv_742000000000000000000742'; // gitleaks:allow
const ENV_KEY = 'env742-ingest-key'; // gitleaks:allow
// The env key has no default list of its own and the test env sets no DEFAULT_LIST_NAME, so a
// server-to-server caller names its list in the body (else 400 NO_DEFAULT_LIST_ERROR).
const ENV_LIST = 'W742 env list';
const admin = { id: 990742, github_login: 'admin-742', role: 'admin', navLayout: 'top' };
const member = { id: 990743, github_login: 'member-742', role: 'member', navLayout: 'top' };
const realFetch = globalThis.fetch;

const testEnv = () => ({ ...(env as object), SESSION_SECRET: SECRET, INGEST_KEY: ENV_KEY });

function post(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
	const url = 'https://crm.test/api/ingest';
	return ingest({
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
			body: JSON.stringify(body)
		}),
		url: new URL(url),
		platform: { env: testEnv() }
	} as any);
}

async function key(token: string, opts: { trust?: 0 | 1; list?: string; tags?: string } = {}): Promise<number> {
	const r = await db
		.prepare('INSERT INTO webhook_keys (label, token, default_list, default_tags, trust_body) VALUES (?, ?, ?, ?, ?) RETURNING id')
		.bind(`k742-${token}`, token, opts.list ?? 'Key list', opts.tags ?? null, opts.trust ?? 0)
		.first<{ id: number }>();
	return r!.id;
}

async function contact(email: string) {
	return db
		.prepare('SELECT id, name, first_name, last_name, company, meta, archived_at FROM contacts WHERE email = ?')
		.bind(email)
		.first<{ id: number; name: string | null; first_name: string | null; last_name: string | null; company: string | null; meta: string | null; archived_at: string | null }>();
}

async function groupsOf(email: string): Promise<string[]> {
	const r = await db
		.prepare(
			`SELECT l.kind || ':' || l.name AS g FROM list_members m JOIN lists l ON l.id = m.list_id
			 JOIN contacts c ON c.id = m.contact_id WHERE c.email = ? ORDER BY l.kind, l.name`
		)
		.bind(email)
		.all<{ g: string }>();
	return r.results.map((x) => x.g).filter((g) => !g.startsWith('tag:hygiene') && g !== 'tag:unverified-domain');
}

function ev(path: string, fields: Record<string, string> = {}, user: typeof admin = admin) {
	const url = new URL(`https://app.test${path}`);
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		request: new Request(url, { method: 'POST', body }),
		platform: { env: testEnv() },
		url,
		params: {},
		depends: () => {},
		locals: { user, authed: true }
	} as any;
}

async function cleanup() {
	await db.prepare("DELETE FROM webhook_keys WHERE label LIKE 'k742-%'").run();
	await db.prepare("DELETE FROM rate_limits WHERE key LIKE 'ingest:%'").run();
	await db.prepare("DELETE FROM webhook_events WHERE email LIKE '%@w742.test'").run();
	await db.prepare("DELETE FROM subscription_confirmations WHERE email LIKE '%@w742.test'").run();
	await db.prepare("DELETE FROM contacts WHERE email LIKE '%@w742.test'").run();
	await db.prepare('DELETE FROM tracking_sites').run();
	await db.prepare('DELETE FROM lists WHERE name = ?').bind(ENV_LIST).run();
}

beforeEach(async () => {
	globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch; // DoH fails open
	await cleanup();
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	await cleanup();
});

describe('a key that does not trust the body', () => {
	it("uses the key's own list and tags; the body's are ignored", async () => {
		await key('wk742a', { list: 'Key list', tags: 'from-key' });
		const res = await post('wk742a', { email: 'a@w742.test', list: 'Other list', tags: ['vip', 'hot'] });
		expect(res.status).toBe(200);
		expect(await groupsOf('a@w742.test')).toEqual(['list:Key list', 'tag:from-key']);
		const other = await db.prepare("SELECT id FROM lists WHERE name = 'Other list'").first();
		expect(other).toBeNull();
	});

	it('fills blank fields of an existing contact and overwrites nothing', async () => {
		await db
			.prepare("INSERT INTO contacts (email, name, first_name, last_name, company, meta) VALUES ('b@w742.test', 'Jane Doe', 'Jane', 'Doe', '', ?)")
			.bind(JSON.stringify({ plan: 'gold' }))
			.run();
		await key('wk742b');
		await post('wk742b', { email: 'b@w742.test', name: 'Someone Else', company: 'Example Co', plan: 'free', city: 'Springfield' });
		const c = await contact('b@w742.test');
		expect(c).toMatchObject({ name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', company: 'Example Co' });
		const meta = JSON.parse(c!.meta ?? '{}');
		expect(meta.plan).toBe('gold');
		expect(meta.city).toBe('Springfield');
	});

	it('keeps an existing company', async () => {
		await db.prepare("INSERT INTO contacts (email, company) VALUES ('c@w742.test', 'First Co')").run();
		await key('wk742c');
		await post('wk742c', { email: 'c@w742.test', company: 'Second Co' });
		expect((await contact('c@w742.test'))?.company).toBe('First Co');
	});

	it('leaves an archived contact archived', async () => {
		await db.prepare("INSERT INTO contacts (email, archived_at) VALUES ('d@w742.test', datetime('now'))").run();
		await key('wk742d');
		await post('wk742d', { email: 'd@w742.test' });
		expect((await contact('d@w742.test'))?.archived_at).not.toBeNull();
	});

	it('answers the same for a new and an existing address', async () => {
		await key('wk742e');
		const first = await (await post('wk742e', { email: 'e@w742.test' })).json();
		const again = await (await post('wk742e', { email: 'e@w742.test' })).json();
		expect(first).toEqual({ ok: true, status: 'accepted' });
		expect(again).toEqual(first);
	});

	it('with confirmation asked, an archived contact stays archived', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed, archived_at) VALUES ('ca@w742.test', 0, datetime('now'))").run();
		await key('wk742ca');
		const res = await post('wk742ca', { email: 'ca@w742.test', confirm: true });
		expect(await res.json()).toEqual({ ok: true, status: 'pending_confirmation' });
		const c = await db
			.prepare('SELECT archived_at, confirm_pending FROM contacts WHERE email = ?')
			.bind('ca@w742.test')
			.first<{ archived_at: string | null; confirm_pending: number }>();
		expect(c!.archived_at).not.toBeNull();
		expect(c!.confirm_pending).toBe(1);
	});

	it('with confirmation asked, answers the same for a new, a subscribed and an unsubscribed address', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('cs@w742.test', 1), ('cu@w742.test', 0)").run();
		await key('wk742cr');
		const answers = [];
		for (const email of ['cn@w742.test', 'cs@w742.test', 'cu@w742.test']) {
			const res = await post('wk742cr', { email, confirm: true });
			answers.push({ status: res.status, body: await res.json() });
		}
		expect(answers[0]).toEqual({ status: 200, body: { ok: true, status: 'pending_confirmation' } });
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
	});

	it('when a confirmed sign-up is applied, custom fields fill blanks only', async () => {
		const r = await db
			.prepare("INSERT INTO contacts (email, meta) VALUES ('cf@w742.test', ?) RETURNING id")
			.bind(JSON.stringify({ plan: 'gold' }))
			.first<{ id: number }>();
		await applyIntent(db, r!.id, { fields: { plan: 'free', city: 'Springfield' }, fields_fill_only: true });
		const meta = JSON.parse((await contact('cf@w742.test'))!.meta ?? '{}');
		expect(meta).toMatchObject({ plan: 'gold', city: 'Springfield' });
		// Without the flag (trusted keys, hosted forms) the value is replaced as before.
		await applyIntent(db, r!.id, { fields: { plan: 'free' } });
		expect(JSON.parse((await contact('cf@w742.test'))!.meta ?? '{}').plan).toBe('free');
	});
});

describe('a key that trusts the body (every key made before #742)', () => {
	it('keeps the old behaviour: body list and tags, fields updated, added / updated', async () => {
		await db.prepare("INSERT INTO contacts (email, name, first_name, last_name) VALUES ('f@w742.test', 'Old Name', 'Old', 'Name')").run();
		await key('wk742f', { trust: 1 });
		const res = await (await post('wk742f', { email: 'f@w742.test', name: 'New Name', list: 'Body list', tags: ['vip'] })).json();
		expect(res).toMatchObject({ ok: true, status: 'updated', list: 'Body list' });
		expect((await contact('f@w742.test'))?.name).toBe('New Name');
		expect(await groupsOf('f@w742.test')).toEqual(['list:Body list', 'tag:vip']);
		const added = await (await post('wk742f', { email: 'g@w742.test' })).json();
		expect(added).toMatchObject({ status: 'added' });
	});

	it('still restores an archived contact', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed, archived_at) VALUES ('ta@w742.test', 1, datetime('now'))").run();
		await key('wk742ta', { trust: 1 });
		expect((await post('wk742ta', { email: 'ta@w742.test' })).status).toBe(200);
		expect((await contact('ta@w742.test'))?.archived_at).toBeNull();
	});
});

describe('request log', () => {
	it('never stores the dsv link token', async () => {
		await db.prepare("INSERT INTO contacts (email) VALUES ('lg@w742.test')").run();
		const c = await contact('lg@w742.test');
		const token = await signVisitorToken(SECRET, { c: c!.id });
		for (const [k, trust] of [['wk742lg0', 0], ['wk742lg1', 1]] as const) {
			await key(k, { trust });
			expect((await post(k, { email: 'lg@w742.test', dsv: token, plan: 'x' })).status).toBe(200);
		}
		expect((await post(ENV_KEY, { email: 'lg@w742.test', dsv: token, list: ENV_LIST })).status).toBe(200);
		const rows = await db
			.prepare('SELECT payload FROM webhook_events WHERE email = ?')
			.bind('lg@w742.test')
			.all<{ payload: string }>();
		expect(rows.results.length).toBe(3);
		for (const r of rows.results) {
			expect(r.payload).not.toContain(token);
			expect(JSON.parse(r.payload).dsv).toBeUndefined();
			expect(JSON.parse(r.payload).email).toBe('lg@w742.test');
		}
	});
});

describe('visitor id (dsv_id)', () => {
	async function site(): Promise<number> {
		const r = await db
			.prepare("INSERT INTO tracking_sites (name, domain, origins, site_key, enabled) VALUES ('S', 'w742.test', '[]', ?, 1) RETURNING id")
			.bind(SITE_KEY)
			.first<{ id: number }>();
		return r!.id;
	}

	it('a trusted key gets it for a contact this request created', async () => {
		const siteId = await site();
		await key('wk742h', { trust: 1 });
		const j: any = await (await post('wk742h', { email: 'h@w742.test', site_key: SITE_KEY })).json();
		const c = await contact('h@w742.test');
		expect(await verifyVisitorId(SECRET, j.dsv_id)).toMatchObject({ c: c!.id, s: siteId });
	});

	it('an untrusted key does not get it for a new contact without a link token', async () => {
		await site();
		await key('wk742hu');
		const j: any = await (await post('wk742hu', { email: 'hu@w742.test', site_key: SITE_KEY })).json();
		expect(j.dsv_id).toBeUndefined();
		expect(await contact('hu@w742.test')).not.toBeNull();
	});

	it('an untrusted key answers the same for a new and an existing address with a site_key', async () => {
		await site();
		await db.prepare("INSERT INTO contacts (email) VALUES ('ho@w742.test')").run();
		await key('wk742hs');
		const fresh = await post('wk742hs', { email: 'hn@w742.test', site_key: SITE_KEY });
		const known = await post('wk742hs', { email: 'ho@w742.test', site_key: SITE_KEY });
		expect(fresh.status).toBe(known.status);
		expect(await fresh.json()).toEqual(await known.json());
	});

	it('is not returned for an existing contact without a link token', async () => {
		await site();
		await db.prepare("INSERT INTO contacts (email) VALUES ('i@w742.test')").run();
		for (const trust of [0, 1] as const) {
			await key(`wk742i${trust}`, { trust });
			const j: any = await (await post(`wk742i${trust}`, { email: 'i@w742.test', site_key: SITE_KEY })).json();
			expect(j.dsv_id).toBeUndefined();
		}
	});

	it("is returned with that contact's link token, not another contact's", async () => {
		await site();
		await db.prepare("INSERT INTO contacts (email) VALUES ('j@w742.test'), ('k@w742.test')").run();
		const j = await contact('j@w742.test');
		const k = await contact('k@w742.test');
		await key('wk742j');
		const own: any = await (await post('wk742j', { email: 'j@w742.test', site_key: SITE_KEY, dsv: await signVisitorToken(SECRET, { c: j!.id }) })).json();
		expect(await verifyVisitorId(SECRET, own.dsv_id)).toMatchObject({ c: j!.id });
		const other: any = await (await post('wk742j', { email: 'j@w742.test', site_key: SITE_KEY, dsv: await signVisitorToken(SECRET, { c: k!.id }) })).json();
		expect(other.dsv_id).toBeUndefined();
		const bad: any = await (await post('wk742j', { email: 'j@w742.test', site_key: SITE_KEY, dsv: 'not-a-token' })).json();
		expect(bad.dsv_id).toBeUndefined();
		// The link token is never kept as a custom field.
		expect((await contact('j@w742.test'))?.meta ?? '').not.toContain('dsv');
	});
});

describe('rate limit', () => {
	const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

	const count = async (k: string) =>
		(await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(k).first<{ count: number }>())?.count ?? 0;

	it('answers 429 once a key is over its limit, writing nothing', async () => {
		const id = await key('wk742l');
		await db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 3000, ?)').bind(`ingest:key:k${id}`, now()).run();
		const res = await post('wk742l', { email: 'l@w742.test' });
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBeTruthy();
		expect(await contact('l@w742.test')).toBeNull();
	});

	it('answers 429 once a client address is over its limit for a key; IPv6 counts by /64', async () => {
		const id = await key('wk742m');
		const h = await ipHash(clientBucket('2001:db8:1:2::1'), SECRET);
		await db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 60, ?)').bind(`ingest:ipk:k${id}:${h}`, now()).run();
		const res = await post('wk742m', { email: 'm@w742.test' }, { 'cf-connecting-ip': '2001:db8:1:2:abcd::9' });
		expect(res.status).toBe(429);
		const elsewhere = await post('wk742m', { email: 'm@w742.test' }, { 'cf-connecting-ip': '2001:db8:1:3::1' });
		expect(elsewhere.status).toBe(200);
	});

	it('a trusted key allows more per client address', async () => {
		const id = await key('wk742mt', { trust: 1 });
		const h = await ipHash(clientBucket('203.0.113.20'), SECRET);
		await db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 60, ?)').bind(`ingest:ipk:k${id}:${h}`, now()).run();
		expect((await post('wk742mt', { email: 'mt@w742.test' }, { 'cf-connecting-ip': '203.0.113.20' })).status).toBe(200);
		await db.prepare('UPDATE rate_limits SET count = 600 WHERE key = ?').bind(`ingest:ipk:k${id}:${h}`).run();
		expect((await post('wk742mt', { email: 'mt@w742.test' }, { 'cf-connecting-ip': '203.0.113.20' })).status).toBe(429);
	});

	it('counts a client before the key is looked up, wrong keys included', async () => {
		await key('wk742pre');
		const h = await ipHash(clientBucket('203.0.113.30'), SECRET);
		await db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 600, ?)').bind(`ingest:ip:${h}`, now()).run();
		const wrong = await post('wk742wrong', { email: 'pre@w742.test' }, { 'cf-connecting-ip': '203.0.113.30' });
		expect(wrong.status).toBe(429);
		const right = await post('wk742pre', { email: 'pre@w742.test' }, { 'cf-connecting-ip': '203.0.113.30' });
		expect(right.status).toBe(429);
		expect(await contact('pre@w742.test')).toBeNull();
	});

	it("a client refused by its own limit does not use up the key's allowance", async () => {
		const id = await key('wk742share');
		const statuses: number[] = [];
		// The honeypot answer stores no contact, so this stays quick; it still passes the limits.
		for (let i = 0; i < 62; i++) {
			const res = await post('wk742share', { email: 'share@w742.test', website: 'x' }, { 'cf-connecting-ip': '203.0.113.40' });
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
		expect(statuses.slice(60)).toEqual([429, 429]);
		expect(await count(`ingest:key:k${id}`)).toBe(60);
		const other = await post('wk742share', { email: 'share2@w742.test' }, { 'cf-connecting-ip': '203.0.113.41' });
		expect(other.status).toBe(200);
		expect(await count(`ingest:key:k${id}`)).toBe(61);
	});

	it('the env key gets the per-key limit only', async () => {
		const h = await ipHash(clientBucket('203.0.113.50'), SECRET);
		await db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 600, ?)').bind(`ingest:ip:${h}`, now()).run();
		const ok = await post(ENV_KEY, { email: 'env@w742.test', list: ENV_LIST }, { 'cf-connecting-ip': '203.0.113.50' });
		expect(ok.status).toBe(200);
		expect(await count(`ingest:ip:${h}`)).toBe(600);
		await db
			.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 3000, ?) ON CONFLICT(key) DO UPDATE SET count = 3000, window_start = excluded.window_start')
			.bind('ingest:key:env', now())
			.run();
		const refused = await post(ENV_KEY, { email: 'env2@w742.test', list: ENV_LIST }, { 'cf-connecting-ip': '203.0.113.51' });
		expect(refused.status).toBe(429);
		expect(await contact('env2@w742.test')).toBeNull();
	});

	it('clientBucket', () => {
		expect(clientBucket('203.0.113.7')).toBe('203.0.113.7');
		expect(clientBucket('2001:db8:1:2::1')).toBe(clientBucket('2001:0db8:0001:0002:ffff:1:2:3'));
		expect(clientBucket('2001:db8:1:2::1')).not.toBe(clientBucket('2001:db8:1:3::1'));
		expect(clientBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
		expect(clientBucket('')).toBeNull();
	});
});

describe('hashed keys', () => {
	it('an old plaintext key works, then is stored as a hash only', async () => {
		const id = await key('wk742oldkey', { trust: 1 });
		expect((await post('wk742oldkey', { email: 'n@w742.test' })).status).toBe(200);
		const row = await db.prepare('SELECT token, token_hash, token_last4 FROM webhook_keys WHERE id = ?').bind(id).first<{ token: string; token_hash: string; token_last4: string }>();
		expect(row!.token_hash).toBe(await sha256Hex('wk742oldkey'));
		expect(row!.token).not.toContain('wk742oldkey');
		expect(isPlaintextToken(row!.token)).toBe(false);
		expect(row!.token_last4).toBe('dkey');
		expect((await post('wk742oldkey', { email: 'o@w742.test' })).status).toBe(200);
	});

	it('refuses a revoked key, a placeholder and a wrong key', async () => {
		await db.prepare("INSERT INTO webhook_keys (label, token, revoked_at) VALUES ('k742-rev', 'wk742revoked', datetime('now'))").run();
		expect((await post('wk742revoked', { email: 'p@w742.test' })).status).toBe(401);
		const id = await key('wk742plain');
		await findWebhookKey(db, 'wk742plain'); // moves it over
		const row = await db.prepare('SELECT token FROM webhook_keys WHERE id = ?').bind(id).first<{ token: string }>();
		expect((await post(row!.token, { email: 'p@w742.test' })).status).toBe(401);
		await db.prepare("INSERT INTO webhook_keys (label, token) VALUES ('k742-red', 'redacted:webhook_keys:1')").run();
		expect((await post('redacted:webhook_keys:1', { email: 'p@w742.test' })).status).toBe(401);
		expect((await post('wk742nope', { email: 'p@w742.test' })).status).toBe(401);
	});

	it('a new key is stored as a hash, shown once, and works', async () => {
		const res = (await (webhooks.actions as any).create(ev('/settings/webhooks?/create', { label: 'k742-new', default_list: 'New list' }))) as {
			createdId: number;
			createdToken: string;
		};
		expect(res.createdToken).toMatch(/^[0-9a-f]{48}$/);
		const row = await db
			.prepare('SELECT token, token_hash, token_last4, trust_body FROM webhook_keys WHERE id = ?')
			.bind(res.createdId)
			.first<{ token: string; token_hash: string; token_last4: string; trust_body: number }>();
		expect(row!.token).not.toBe(res.createdToken);
		expect(row!.token_hash).toBe(await sha256Hex(res.createdToken));
		expect(row!.trust_body).toBe(0);
		expect((await post(res.createdToken, { email: 'q@w742.test' })).status).toBe(200);

		const data = (await (webhooks.load as any)(ev('/settings/webhooks'))) as { keys: { id: number; token: string | null; token_last4: string }[] };
		const k = data.keys.find((x) => x.id === res.createdId)!;
		expect(k.token).toBeNull();
		expect(k.token_last4).toBe(res.createdToken.slice(-4));
		expect(JSON.stringify(data)).not.toContain(res.createdToken);
		expect(JSON.stringify(data)).not.toContain(row!.token_hash);
	});

	it('before migration 0138, looks a key up by its plaintext and treats it as trusted, writing nothing', async () => {
		const missing = new Error('D1_ERROR: no such column: token_hash: SQLITE_ERROR');
		const seen: string[] = [];
		const fakeDb = {
			prepare(sql: string) {
				seen.push(sql);
				const stmt = {
					bind: () => stmt,
					first: async () => {
						if (/token_hash|trust_body|token_last4/.test(sql)) throw missing;
						return { id: 7, default_list: 'Old list', source: null, default_tags: null, require_confirm: 0, token: 'wk742premig' };
					},
					run: async () => {
						throw new Error('no write expected');
					}
				};
				return stmt;
			}
		} as unknown as D1Database;
		expect(await findWebhookKey(fakeDb, 'wk742premig')).toMatchObject({ id: 7, default_list: 'Old list', trust_body: 1 });
		expect(await findWebhookKey(fakeDb, 'wk742other')).toBeNull();
		expect(seen.some((q) => /^UPDATE/i.test(q.trim()))).toBe(false);
	});

	it('the pre-migration check matches only the new columns', () => {
		expect(isPreMigrationKeyError(new Error('D1_ERROR: no such column: token_hash: SQLITE_ERROR'))).toBe(true);
		expect(isPreMigrationKeyError(new Error('no such column: trust_body'))).toBe(true);
		expect(isPreMigrationKeyError(new Error('wrapper', { cause: new Error('no such column: webhook_keys.token_last4') }))).toBe(true);
		expect(isPreMigrationKeyError(new Error('no such column: default_list'))).toBe(false);
		expect(isPreMigrationKeyError(new Error('database is locked'))).toBe(false);
		expect(isPreMigrationKeyError(null)).toBe(false);
	});

	it('the backup leaves out the key hashes', () => {
		expect(REDACTED_COLUMNS.some((c) => c.table === 'webhook_keys' && c.column === 'token_hash')).toBe(true);
		expect(REDACTED_COLUMNS.some((c) => c.table === 'webhook_keys' && c.column === 'token')).toBe(true);
	});
});

describe('the trust switch in Settings → Webhooks', () => {
	it('turning it on needs confirmation; off needs none', async () => {
		const id = await key('wk742s');
		const trust = async () => (await db.prepare('SELECT trust_body FROM webhook_keys WHERE id = ?').bind(id).first<{ trust_body: number }>())!.trust_body;
		const refused = await (webhooks.actions as any).setTrust(ev('/settings/webhooks?/setTrust', { id: String(id), trust: '1' }));
		expect(refused?.status).toBe(400);
		expect(await trust()).toBe(0);
		await (webhooks.actions as any).setTrust(ev('/settings/webhooks?/setTrust', { id: String(id), trust: '1', confirm: '1' }));
		expect(await trust()).toBe(1);
		await (webhooks.actions as any).setTrust(ev('/settings/webhooks?/setTrust', { id: String(id), trust: '0' }));
		expect(await trust()).toBe(0);
	});

	it('a member is refused', async () => {
		const id = await key('wk742sm');
		const res = await (webhooks.actions as any).setTrust(
			ev('/settings/webhooks?/setTrust', { id: String(id), trust: '1', confirm: '1' }, member)
		);
		expect(res?.status).toBe(403);
		const row = await db.prepare('SELECT trust_body FROM webhook_keys WHERE id = ?').bind(id).first<{ trust_body: number }>();
		expect(row!.trust_body).toBe(0);
	});
});

// #154: site tracking D — the "Visits a page" trigger, the `visited` Condition, the
// site-activity Data API reads and POST /api/track/server.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { signVisitorId } from '../src/lib/server/track-token';
import { resetRateLimits } from '../src/lib/server/site-tracking';
import { tick } from '../src/lib/server/automations';
import { fireSiteVisitTriggers } from '../src/lib/server/site-trigger';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { decodeVisited, normalizeVisited, pathMatches, siteTriggerLabel, visitedLabel } from '../src/lib/site-trigger';
import { POST as trackPOST } from '../src/routes/api/track/+server';
import { POST as serverPOST } from '../src/routes/api/track/server/+server';
import { GET as siteEventsGET } from '../src/routes/api/v1/site-events/+server';
import { GET as contactActivityGET } from '../src/routes/api/v1/contacts/[id]/site-activity/+server';

const db = (env as any).DB as D1Database;
const SECRET = 'test-session-secret';
const ORIGIN = 'https://ourco.example';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const testEnv = { ...(env as any), SESSION_SECRET: SECRET };

let siteId: number;
let contactId: number;

beforeEach(async () => {
	resetRateLimits();
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM site_visit_fires'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
	siteId = (await db
		.prepare(`INSERT INTO tracking_sites (name, domain, origins, site_key) VALUES ('DS', 'ourco.example', ?, 'sk_test') RETURNING id`)
		.bind(JSON.stringify([ORIGIN]))
		.first<{ id: number }>())!.id;
	contactId = (await db.prepare("INSERT INTO contacts (email) VALUES ('v@x.example.net') RETURNING id").first<{ id: number }>())!.id;
});

async function automation(o: {
	status?: string;
	op?: string;
	path?: string;
	site?: number | null;
	cooldown?: number | null;
	reentry?: string;
}): Promise<number> {
	const id = (await db
		.prepare(
			`INSERT INTO automations (name, status, trigger_type, trigger_site_id, trigger_path_op, trigger_path, trigger_cooldown_hours, reentry)
			 VALUES ('Visit', ?, 'site_visit', ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(o.status ?? 'active', o.site ?? null, o.op ?? 'contains', o.path ?? '/pricing', o.cooldown ?? null, o.reentry ?? 'once')
		.first<{ id: number }>())!.id;
	await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
			 VALUES (?, 0, 'tag', 'add', 'visited-pricing', '', '', '', 3600)`
		)
		.bind(id)
		.run();
	return id;
}

const passes = async (aid: number) =>
	(await db.prepare('SELECT status FROM automation_enrollments WHERE automation_id = ? ORDER BY id').bind(aid).all<{ status: string }>())
		.results;

function beacon(body: Record<string, unknown>) {
	const url = 'https://app.test/api/track';
	return {
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'text/plain', origin: ORIGIN, 'user-agent': UA },
			body: JSON.stringify(body)
		}),
		platform: { env: testEnv },
		url: new URL(url)
	} as any;
}

async function view(path: string, c = contactId) {
	const id = await signVisitorId(SECRET, { c, s: siteId });
	return trackPOST(beacon({ site_key: 'sk_test', id, kind: 'pageview', path }));
}

describe('pathMatches / labels', () => {
	it('contains / equals / wildcard, case-insensitive, trailing slash ignored', () => {
		expect(pathMatches('/Pricing/Team', 'contains', '/pricing')).toBe(true);
		expect(pathMatches('/about', 'contains', '/pricing')).toBe(false);
		expect(pathMatches('/pricing/', 'equals', '/pricing')).toBe(true);
		expect(pathMatches('/pricing/team', 'equals', '/pricing')).toBe(false);
		expect(pathMatches('/blog/a/b', 'wildcard', '/blog/*')).toBe(true);
		expect(pathMatches('/blog', 'wildcard', '/blog/*')).toBe(false);
		expect(pathMatches('/shop/x/checkout', 'wildcard', '/shop/*/checkout')).toBe(true);
		expect(pathMatches('/a.b', 'wildcard', '/a.b')).toBe(true);
		expect(pathMatches('/axb', 'wildcard', '/a.b')).toBe(false); // '.' is literal
		expect(pathMatches('/x', 'contains', '')).toBe(false);
		expect(pathMatches('/x', 'bogus', '/x')).toBe(false);
	});

	it('labels the trigger and the condition', () => {
		expect(siteTriggerLabel('contains', '/pricing', null, null)).toBe(
			'Visits a page whose path contains “/pricing” on any site (cooldown 24 h)'
		);
		expect(visitedLabel({ mode: 'page', match: '/pricing', days: 7 })).toBe('Visited a page containing “/pricing” in the last 7 days');
		expect(visitedLabel({ mode: 'event', match: 'booked_call', days: 0 })).toBe('Did event «booked_call»');
		expect(decodeVisited('/pricing', 'page:30')).toEqual({ mode: 'page', match: '/pricing', days: 30 });
		expect(normalizeVisited('page', '  ', '3')).toBeNull();
		expect(normalizeVisited('nope', '/x', '3')).toBeNull();
		expect(normalizeVisited('event', 'x', '-1')).toBeNull();
	});
});

describe('site_visit trigger (at ingest)', () => {
	it('enrolls on a matching pageview, not on a non-matching one', async () => {
		const aid = await automation({ op: 'equals', path: '/pricing' });
		expect((await view('/about')).status).toBe(204);
		expect(await passes(aid)).toEqual([]);
		expect((await view('/pricing/?utm_source=x')).status).toBe(204);
		expect(await passes(aid)).toEqual([{ status: 'active' }]);
	});

	it('fires once per cooldown even with re-entry = multiple', async () => {
		const aid = await automation({ reentry: 'multiple', cooldown: 24 });
		const now = new Date();
		const r1 = await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' }, now);
		expect(r1).toEqual({ matched: 1, enrolled: 1, cooling: 0 });
		// The pass ends (e.g. finished) — without the cooldown re-entry=multiple would re-enroll.
		await db.prepare("UPDATE automation_enrollments SET status = 'completed', ended_at = datetime('now')").run();
		const r2 = await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' }, new Date(now.getTime() + 3_600_000));
		expect(r2).toEqual({ matched: 1, enrolled: 0, cooling: 1 });
		const r3 = await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' }, new Date(now.getTime() + 25 * 3_600_000));
		expect(r3.enrolled).toBe(1);
		expect((await passes(aid)).map((p) => p.status)).toEqual(['completed', 'active']);
	});

	it('honours re-entry = once after the cooldown, and a 0 h cooldown', async () => {
		const aid = await automation({ cooldown: 0 });
		await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' });
		await db.prepare("UPDATE automation_enrollments SET status = 'completed'").run();
		const r = await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' });
		expect(r).toEqual({ matched: 1, enrolled: 0, cooling: 0 });
		expect(await passes(aid)).toHaveLength(1);
	});

	it('ignores paused/draft automations, other sites, and unsubscribed contacts', async () => {
		const paused = await automation({ status: 'paused' });
		const draft = await automation({ status: 'draft' });
		const other = await automation({ site: siteId + 999 });
		await view('/pricing');
		expect(await passes(paused)).toEqual([]);
		expect(await passes(draft)).toEqual([]);
		expect(await passes(other)).toEqual([]);

		const onSite = await automation({ site: siteId });
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(contactId).run();
		const r = await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' });
		expect(r.enrolled).toBe(0);
		expect(await passes(onSite)).toEqual([]);
		// Not stamped: a later visit after re-subscribing still fires.
		await db.prepare('UPDATE contacts SET subscribed = 1 WHERE id = ?').bind(contactId).run();
		expect((await fireSiteVisitTriggers(db, { siteId, contactId, path: '/pricing' })).enrolled).toBe(1);
	});

	it('custom events never fire the page trigger', async () => {
		const aid = await automation({ path: 'pricing' });
		const id = await signVisitorId(SECRET, { c: contactId, s: siteId });
		await trackPOST(beacon({ site_key: 'sk_test', id, kind: 'event', name: 'pricing_click', path: '/pricing' }));
		expect(await passes(aid)).toEqual([]);
	});
});

describe('visited Condition', () => {
	async function branchFlow(name: string, value: string) {
		const aid = (await db.prepare("INSERT INTO automations (name, status) VALUES ('C', 'active') RETURNING id").first<{ id: number }>())!.id;
		const ins = (type: string, o: Record<string, unknown> = {}) =>
			db
				.prepare(
					`INSERT INTO automation_steps (automation_id, position, type, subject, body_md, from_email, tag_action, tag_name,
					   gate_kind, gate_name, gate_value, parent_step_id, branch_label)
					 VALUES (?, 0, ?, '', '', '', ?, ?, ?, ?, ?, ?, ?) RETURNING id`
				)
				.bind(aid, type, o.tag ? 'add' : null, o.tag ?? null, o.kind ?? null, o.name ?? null, o.value ?? null, o.parent ?? null, o.label ?? null)
				.first<{ id: number }>()
				.then((r) => r!.id);
		const br = await ins('branch', { kind: 'visited', name, value });
		await ins('tag', { tag: 'yes', parent: br, label: 'yes' });
		await ins('tag', { tag: 'no', parent: br, label: 'no' });
		return { aid, br };
	}

	async function run(aid: number, br: number, contacts: number[]) {
		for (const c of contacts) {
			await db
				.prepare(
					"INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, next_run_at, status) VALUES (?, ?, ?, datetime('now', '-1 minute'), 'active')"
				)
				.bind(aid, c, br)
				.run();
		}
		const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		const rows = await db
			.prepare(
				`SELECT c.email, l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN contacts c ON c.id = lm.contact_id
				 WHERE l.kind = 'tag' ORDER BY c.email`
			)
			.all<{ email: string; name: string }>();
		return Object.fromEntries(rows.results.map((r) => [r.email, r.name]));
	}

	async function contact(email: string) {
		return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
	}
	async function siteEvent(c: number, kind: string, name: string, path: string | null, daysAgo: number) {
		await db
			.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, path, occurred_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
			.bind(siteId, c, kind, name, path, `-${daysAgo} days`)
			.run();
	}

	it('page visits within the window go YES; older or none go NO', async () => {
		const recent = await contact('recent@x.example.net');
		const old = await contact('old@x.example.net');
		const none = await contact('none@x.example.net');
		await siteEvent(recent, 'pageview', 'pageview', '/pricing/team', 2);
		await siteEvent(old, 'pageview', 'pageview', '/pricing', 40);
		const { aid, br } = await branchFlow('/pricing', 'page:30');
		expect(await run(aid, br, [recent, old, none])).toEqual({ 'recent@x.example.net': 'yes', 'old@x.example.net': 'no', 'none@x.example.net': 'no' });
	});

	it('event mode is an exact name; days 0 = ever', async () => {
		const did = await contact('did@x.example.net');
		const other = await contact('other@x.example.net');
		await siteEvent(did, 'event', 'booked_call', null, 90);
		await siteEvent(other, 'event', 'booked_call_cancelled', null, 1);
		const { aid, br } = await branchFlow('booked_call', 'event:0');
		expect(await run(aid, br, [did, other])).toEqual({ 'did@x.example.net': 'yes', 'other@x.example.net': 'no' });
	});

	it('a misconfigured condition goes NO (#395 — no longer fails open)', async () => {
		const c = await contact('m@x.example.net');
		const { aid, br } = await branchFlow('', 'page:3');
		expect(await run(aid, br, [c])).toEqual({ 'm@x.example.net': 'no' });
	});
});

describe('Data API + server events', () => {
	async function makeKey(scope: ApiScope): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, ?)`)
			.bind(k.tokenHash, k.prefix, k.last4, scope)
			.run();
		return k.token;
	}
	function req(path: string, method: string, token: string | undefined, body?: unknown, params: Record<string, string> = {}) {
		const url = new URL(`https://app.test${path}`);
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (token) headers.authorization = `Bearer ${token}`;
		return {
			request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
			platform: { env: testEnv },
			url,
			params
		} as any;
	}
	const jsonOf = async (r: Response) => JSON.parse(await r.text());

	it('POST /api/track/server needs a read_write key (401 none, 403 read, never the site key)', async () => {
		const body = { email: 'v@x.example.net', name: 'order_placed' };
		expect((await serverPOST(req('/api/track/server', 'POST', undefined, body))).status).toBe(401);
		expect((await serverPOST(req('/api/track/server', 'POST', 'sk_test', body))).status).toBe(401);
		expect((await serverPOST(req('/api/track/server', 'POST', await makeKey('read'), body))).status).toBe(403);
	});

	it('stores a server event by email (case-insensitive) with props + occurred_at', async () => {
		const token = await makeKey('read_write');
		const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
		const res = await serverPOST(
			req('/api/track/server', 'POST', token, { email: ' V@X.example.net ', name: 'order_placed', props: { total: 49 }, occurred_at: at })
		);
		expect(res.status).toBe(201);
		const d = (await jsonOf(res)).data;
		expect(d).toMatchObject({ stored: true, contact_id: contactId, site_id: siteId, occurred_at: at.replace('T', ' ').slice(0, 19) });
		const row = await db.prepare('SELECT kind, name, props, contact_id FROM site_events WHERE id = ?').bind(d.id).first<any>();
		expect(row).toEqual({ kind: 'event', name: 'order_placed', props: '{"total":49}', contact_id: contactId });
		const dirty = await db.prepare('SELECT dirty FROM contact_engagement WHERE contact_id = ?').bind(contactId).first<any>();
		expect(dirty?.dirty).toBe(1);
	});

	it('never creates a contact; validates the body; site required when ambiguous', async () => {
		const token = await makeKey('read_write');
		const post = (b: unknown) => serverPOST(req('/api/track/server', 'POST', token, b));
		expect((await post({ email: 'nobody@x.example.net', name: 'x' })).status).toBe(404);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'nobody@x.example.net'").first<any>()).n).toBe(0);
		expect((await post({ email: 'v@x.example.net' })).status).toBe(400); // no name
		expect((await post({ name: 'x' })).status).toBe(400); // no contact
		expect((await post({ contact_id: 'abc', name: 'x' })).status).toBe(400);
		expect((await post({ contact_id: contactId, name: 'x', props: [1] })).status).toBe(400);
		expect((await post({ contact_id: contactId, name: 'x', props: { big: 'x'.repeat(3000) } })).status).toBe(400);
		expect((await post({ contact_id: contactId, name: 'x', occurred_at: 'soon' })).status).toBe(400);
		expect((await post({ contact_id: contactId, name: 'x', occurred_at: Date.now() + 86_400_000 })).status).toBe(400);
		expect((await post({ contact_id: contactId, name: 'x', site: 'nope.example' })).status).toBe(404);

		await db.prepare(`INSERT INTO tracking_sites (name, domain, site_key) VALUES ('Shop', 'shop.example', 'sk_shop')`).run();
		expect((await post({ contact_id: contactId, name: 'x' })).status).toBe(400);
		const res = await post({ contact_id: contactId, name: 'x', site: 'www.shop.example' });
		expect(res.status).toBe(201);
		expect((await jsonOf(res)).data.site_id).not.toBe(siteId);
	});

	it('acknowledges but drops an event for an opted-out contact', async () => {
		const token = await makeKey('read_write');
		await db.prepare('UPDATE contacts SET tracking_optout = 1 WHERE id = ?').bind(contactId).run();
		const res = await serverPOST(req('/api/track/server', 'POST', token, { contact_id: contactId, name: 'x' }));
		expect(res.status).toBe(200);
		expect((await jsonOf(res)).data).toMatchObject({ stored: false, reason: 'tracking_optout' });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM site_events').first<any>()).n).toBe(0);
	});

	it('GET /api/v1/site-events filters by since/path/site/kind and pages', async () => {
		const token = await makeKey('read');
		const ins = (kind: string, name: string, path: string | null, daysAgo: number) =>
			db
				.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, path, utm, occurred_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`)
				.bind(siteId, contactId, kind, name, path, kind === 'pageview' ? '{"source":"news"}' : null, `-${daysAgo} days`)
				.run();
		await ins('pageview', 'pageview', '/pricing', 1);
		await ins('pageview', 'pageview', '/blog/a', 2);
		await ins('pageview', 'pageview', '/pricing', 20);
		await ins('event', 'booked_call', null, 3);

		expect((await siteEventsGET(req('/api/v1/site-events', 'GET', undefined))).status).toBe(401);

		const all = await jsonOf(await siteEventsGET(req('/api/v1/site-events?limit=2', 'GET', token)));
		expect(all.pagination).toEqual({ limit: 2, offset: 0, total: 4, has_more: true });
		expect(all.data[0]).toMatchObject({ path: '/pricing', email: 'v@x.example.net', site: { id: siteId, domain: 'ourco.example' }, utm: { source: 'news' } });

		const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
		const f = await jsonOf(await siteEventsGET(req(`/api/v1/site-events?since=${since}&path=pricing&site=ourco.example`, 'GET', token)));
		expect(f.data.map((r: any) => r.path)).toEqual(['/pricing']);
		const ev = await jsonOf(await siteEventsGET(req(`/api/v1/site-events?kind=event&site=${siteId}`, 'GET', token)));
		expect(ev.data.map((r: any) => r.name)).toEqual(['booked_call']);

		expect((await siteEventsGET(req('/api/v1/site-events?since=garbage', 'GET', token))).status).toBe(400);
		expect((await siteEventsGET(req('/api/v1/site-events?site=unknown.example', 'GET', token))).status).toBe(404);
		expect((await siteEventsGET(req('/api/v1/site-events?kind=x', 'GET', token))).status).toBe(400);
	});

	it('GET /api/v1/contacts/:id/site-activity is paged and 404s for an unknown contact', async () => {
		const token = await makeKey('read');
		for (let i = 0; i < 3; i++) {
			await db
				.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, path, occurred_at) VALUES (?, ?, 'pageview', 'pageview', ?, datetime('now', ?))`)
				.bind(siteId, contactId, `/p${i}`, `-${i} hours`)
				.run();
		}
		const p = (q: string, id = String(contactId)) =>
			contactActivityGET(req(`/api/v1/contacts/${id}/site-activity${q}`, 'GET', token, undefined, { id }));
		const page2 = await jsonOf(await p('?limit=2&offset=2'));
		expect(page2.data.map((r: any) => r.path)).toEqual(['/p2']);
		expect(page2.pagination).toMatchObject({ total: 3, has_more: false });
		expect((await p('', '999999')).status).toBe(404);
		expect((await p('', 'x')).status).toBe(400);
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #311: pre-send checks — every rule on a fixture body, the SSRF guard, the merge-tag
// coverage maths, the server-side "Send anyway" gate, and the two endpoints.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import {
	placeholderReason,
	extractLinks,
	linkChecks,
	extractImages,
	imageChecks,
	findMergeTags,
	mergeTagCoverage,
	mergeTagChecks,
	contentChecks,
	audienceChecks,
	linkProbeChecks,
	spamPhrases,
	isShouting,
	looksLikeAddress,
	summarize,
	type Check
} from '../src/lib/presend-checks';
import { ssrfGuard, checkLinks, looksLikeLogin, LINK_CHECK_MAX } from '../src/lib/server/link-check';
import { runPresendChecks, audienceStats } from '../src/lib/server/presend-checks';
import { recipientsForList } from '../src/lib/server/segments';
import { actions as compose } from '../src/routes/compose/+page.server';
import { POST as checksPOST } from '../src/routes/compose/checks/+server';
import { POST as apiChecks } from '../src/routes/api/v1/campaigns/[id]/checks/+server';
import { generateApiKey } from '../src/lib/server/api-keys';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), POSTMARK_TOKEN: 'test', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);

// ------------------------------------------------------------------ pure rules

describe('links', () => {
	it('flags each placeholder / fake URL', () => {
		for (const href of [
			'https://your-link-here',
			'https://example.com/page',
			'http://www.example.org',
			'#',
			'',
			'http://',
			'https:///path',
			'http://localhost:5173/x',
			'https://127.0.0.1/',
			'https://ourco.example/TODO',
			'https://ourco.example/[link]',
			'/relative/path',
			'https://intranet/'
		]) {
			expect(placeholderReason(href), href).not.toBeNull();
		}
	});
	it('passes real links and merge-tag links', () => {
		for (const href of ['https://ourco.example/pricing?utm_source=x', 'http://go.ourco.example/book/alan-hartley/', '{{field:report_url}}', 'https://todo-app.com/']) {
			expect(placeholderReason(href), href).toBeNull();
		}
	});
	it('extracts anchors, skipping unsubscribe / mailto / tel', () => {
		const html = `<a href="https://a.com/x?y=1&amp;z=2">A</a><a href="%%UNSUB_URL%%">U</a><a href="mailto:x@y.example.net">M</a><a href='tel:123'>T</a><a href="https://your-link-here"><img src="x.png"></a>`;
		expect(extractLinks(html)).toEqual([
			{ href: 'https://a.com/x?y=1&z=2', text: 'A' },
			{ href: 'https://your-link-here', text: '[image]' }
		]);
	});
	it('blocks placeholders (campaign 47: an image linked to your-link-here)', () => {
		const html = `<a href="https://your-link-here"><img src="https://x.com/a.png" alt="hero"></a><a href="https://ourco.example">ok</a>`;
		const c = byId(linkChecks(extractLinks(html)), 'links.placeholder')!;
		expect(c.level).toBe('block');
		expect(c.items![0]).toContain('your-link-here');
	});
	it('warns on duplicate links with different UTMs', () => {
		const links = [
			{ href: 'https://ourco.example/p?utm_source=email&utm_campaign=a', text: '' },
			{ href: 'https://ourco.example/p?utm_campaign=b&utm_source=email', text: '' },
			{ href: 'https://ourco.example/q?utm_source=email', text: '' },
			{ href: 'https://ourco.example/q?utm_source=email', text: '' }
		];
		const c = byId(linkChecks(links), 'links.utm')!;
		expect(c.level).toBe('warn');
		expect(c.items).toHaveLength(1);
		expect(c.items![0]).toContain('https://ourco.example/p');
		expect(byId(linkChecks(links.slice(2)), 'links.utm')!.level).toBe('pass');
	});
});

describe('images', () => {
	const html = `<img src="https://app.test/img/a.png" alt="Logo" width="200"><img src="https://x.com/b.png" alt=""><img src="https://x.com/c.png" alt="c" style="width:100%">`;
	it('reads src / alt / width (attribute or style)', () => {
		expect(extractImages(html)).toEqual([
			{ src: 'https://app.test/img/a.png', alt: 'Logo', width: '200' },
			{ src: 'https://x.com/b.png', alt: '', width: null },
			{ src: 'https://x.com/c.png', alt: 'c', width: '100%' }
		]);
	});
	it('missing alt, no width, over 1 MB and image-only', () => {
		const sizes = new Map([['https://app.test/img/a.png', 2 * 1024 * 1024]]);
		const checks = imageChecks(extractImages(html), 'Short text', sizes);
		expect(byId(checks, 'images.alt')!.level).toBe('warn');
		expect(byId(checks, 'images.width')!.items).toEqual(['https://x.com/b.png']);
		expect(byId(checks, 'images.size')!.items![0]).toContain('2.0 MB');
		expect(byId(checks, 'images.text')!.level).toBe('warn');
	});
	it('passes a text-rich email with good images', () => {
		const checks = imageChecks(extractImages('<img src="https://x.com/a.png" alt="a" width="100">'), 'x'.repeat(300), new Map([['https://x.com/a.png', 1000]]));
		expect(checks.every((c) => c.level === 'pass')).toBe(true);
	});
});

describe('merge tags', () => {
	it('finds unknown tags (also percent-encoded, Mailchimp style) and known ones with fallbacks', () => {
		const r = findMergeTags('Hi {{firstname}}', '', '<p>{{first_name}} {{company.name|your team}} {{field:tier}} {{#if tag:hot}}x{{/if}} *|FNAME|* <a href="https://a.com/?n=%7B%7Bnmae%7D%7D">l</a> {{email}}</p>');
		expect(r.unknown.sort()).toEqual(['*|FNAME|*', '{{firstname}}', '{{nmae}}'].sort());
		expect(r.used).toEqual([
			{ key: 'first_name', fallback: 'there' },
			{ key: 'company.name', fallback: 'your team' },
			{ key: 'field:tier', fallback: null },
			{ key: 'email', fallback: null }
		]);
		expect(byId(mergeTagChecks(r.unknown, null), 'content.merge_unknown')!.level).toBe('block');
	});
	it('coverage maths: 3 of 8 without a first name = 38%', () => {
		const recipients = [
			...Array.from({ length: 5 }, () => ({ first_name: 'Ann', meta: '{"tier":"gold"}' })),
			{ first_name: '' },
			{ first_name: null, meta: '{"tier":""}' },
			{ first_name: '   ' }
		];
		const rows = mergeTagCoverage(
			[
				{ key: 'first_name', fallback: 'there' },
				{ key: 'field:tier', fallback: null },
				{ key: 'email', fallback: null }
			],
			recipients
		);
		expect(rows).toEqual([
			{ key: 'first_name', fallback: 'there', missing: 3, total: 8, pct: 38 },
			{ key: 'field:tier', fallback: null, missing: 3, total: 8, pct: 38 }
		]);
		const checks = mergeTagChecks([], rows);
		expect(byId(checks, 'content.merge.first_name')).toMatchObject({ level: 'warn', title: '{{first_name}}: 38% of recipients (3 of 8) have no first name' });
		expect(byId(checks, 'content.merge.field:tier')!.level).toBe('warn');
	});
	it('a fallback tag under the threshold passes; a full one passes; an empty audience is 0%', () => {
		const rows = mergeTagCoverage([{ key: 'first_name', fallback: 'there' }], [{ first_name: '' }, ...Array.from({ length: 9 }, () => ({ first_name: 'A' }))]);
		expect(rows[0].pct).toBe(10);
		expect(mergeTagChecks([], rows)[1].level).toBe('pass');
		expect(mergeTagCoverage([{ key: 'last_name', fallback: null }], [])[0]).toMatchObject({ missing: 0, total: 0, pct: 0 });
		expect(mergeTagCoverage([{ key: 'company.name', fallback: null }], [{ companyFields: { name: 'Acme' } }, { companyFields: null }])[0].pct).toBe(50);
	});
});

describe('content', () => {
	const base = { subject: 'October update', preheader: 'What we shipped', html: '<p>Hi</p><a href="%%UNSUB_URL%%">u</a><p>Ourco, 123 Main St, Springfield, CA 91101</p>', contentText: 'Hi', mailingAddress: null };
	it('passes a clean email', () => {
		expect(contentChecks(base).every((c) => c.level === 'pass')).toBe(true);
	});
	it('subject empty = block, over 80 = warn; no preheader = warn', () => {
		expect(byId(contentChecks({ ...base, subject: '  ' }), 'content.subject')!.level).toBe('block');
		expect(byId(contentChecks({ ...base, subject: 'x'.repeat(81) }), 'content.subject')!.level).toBe('warn');
		expect(byId(contentChecks({ ...base, preheader: '' }), 'content.preheader')!.level).toBe('warn');
	});
	it('no unsubscribe link in the body = block', () => {
		expect(byId(contentChecks({ ...base, html: '<p>Hi</p>' }), 'content.unsubscribe')!.level).toBe('block');
	});
	it('physical address: the Settings value, else any address-like line', () => {
		expect(byId(contentChecks({ ...base, html: '<a href="%%UNSUB_URL%%">u</a>' }), 'content.address')!.level).toBe('warn');
		expect(byId(contentChecks({ ...base, mailingAddress: '123 Main St, Springfield\nCA 91101' }), 'content.address')!.level).toBe('pass');
		expect(byId(contentChecks({ ...base, mailingAddress: 'PO Box 9, Altadena' }), 'content.address')!.level).toBe('warn');
		expect(looksLikeAddress('P.O. Box 12')).toBe(true);
		expect(looksLikeAddress('Thanks for reading')).toBe(false);
	});
	it('spammy wording and shouting warn (never block)', () => {
		const c = byId(contentChecks({ ...base, subject: 'ACT NOW FOR YOUR FREE GIFT', contentText: 'Click here!!! Guaranteed results. AMAZING SAVINGS TODAY' }), 'content.spammy')!;
		expect(c.level).toBe('warn');
		expect(c.items).toEqual(expect.arrayContaining(['Subject is mostly capital letters', 'Repeated exclamation marks (!!)', '“act now”', '“click here”']));
		expect(spamPhrases('No urgency here')).toEqual([]);
		expect(isShouting('SEO tips for you')).toBe(false);
	});
});

describe('audience', () => {
	it('no recipients = block; thresholds for bounces, last send, cold', () => {
		expect(audienceChecks({ recipients: 0, excludedBounced: 0, pastBounce: 0, lastSend: null, neverEngaged: 0 })[0].level).toBe('block');
		const bad = audienceChecks({ recipients: 100, excludedBounced: 7, pastBounce: 3, lastSend: { campaignId: 4, subject: 'Prev', sent: 100, bounced: 6 }, neverEngaged: 31 });
		expect(byId(bad, 'audience.bounced')).toMatchObject({ level: 'warn', href: '/deliverability' });
		expect(byId(bad, 'audience.bounced')!.detail).toContain('7 bounced or suppressed members are left out');
		expect(byId(bad, 'audience.last_bounce')).toMatchObject({ level: 'warn', href: '/deliverability' });
		expect(byId(bad, 'audience.cold')!.level).toBe('warn');
		const ok = audienceChecks({ recipients: 100, excludedBounced: 0, pastBounce: 2, lastSend: { campaignId: 4, subject: 'Prev', sent: 100, bounced: 5 }, neverEngaged: 30 });
		expect(ok.every((c) => c.level === 'pass')).toBe(true);
	});
	it('summarize counts levels', () => {
		expect(summarize([{ id: 'a', category: 'links', level: 'block', title: '' }, { id: 'b', category: 'links', level: 'pass', title: '' }])).toMatchObject({ blocks: 1, warns: 0, passes: 1 });
	});
});

// ------------------------------------------------------------------ SSRF guard + link check

describe('SSRF guard', () => {
	it('refuses non-public targets', () => {
		for (const u of [
			'ftp://ok.com/',
			'file:///etc/passwd',
			'http://localhost/',
			'http://foo.localhost/',
			'http://127.0.0.1/',
			'http://2130706433/',
			'http://0x7f.0.0.1/',
			'http://10.1.2.3/',
			'http://172.16.0.1/',
			'http://192.168.1.1/',
			'http://169.254.169.254/latest/meta-data',
			'http://100.64.0.1/',
			'http://0.0.0.0/',
			'http://[::1]/',
			'http://[fd00::1]/',
			'https://ok.com:8080/',
			'https://user:pw@ok.example.com/',
			'http://router/',
			'http://db.internal/',
			'http://printer.local/'
		]) {
			expect(ssrfGuard(u).ok, u).toBe(false);
		}
	});
	it('allows public http(s) hosts', () => {
		for (const u of ['https://ok.com/', 'http://ok.com/book/', 'https://8.8.8.8/', 'https://ok.com:443/x']) expect(ssrfGuard(u).ok, u).toBe(true);
	});
	it('spots login pages', () => {
		expect(looksLikeLogin('https://app.x.com/login?next=/a')).toBe(true);
		expect(looksLikeLogin('https://accounts.google.com/o/oauth2')).toBe(true);
		expect(looksLikeLogin('https://ourco.example/blog/logins-explained')).toBe(false);
	});
});

describe('checkLinks', () => {
	it('HEAD then GET, follows redirects through the guard, reports 404 / login / errors', async () => {
		const calls: string[] = [];
		const fetcher = async (u: string, init: RequestInit) => {
			calls.push(`${init.method} ${u}`);
			if (u === 'https://ok.com/') return new Response(null, { status: 200 });
			if (u === 'https://gone.com/') return new Response(null, { status: 404 });
			if (u === 'https://nohead.com/') return new Response(null, { status: init.method === 'HEAD' ? 405 : 200 });
			if (u === 'https://app.com/dash') return new Response(null, { status: 302, headers: { location: '/login?next=dash' } });
			if (u === 'https://app.com/login?next=dash') return new Response(null, { status: 200 });
			if (u === 'https://sneaky.com/') return new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/' } });
			if (u === 'https://slow.com/') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
			return new Response(null, { status: 500 });
		};
		const { probes } = await checkLinks(
			['https://ok.com/', 'https://gone.com/', 'https://nohead.com/', 'https://app.com/dash', 'https://sneaky.com/', 'https://slow.com/', 'mailto:x@y.example.net', 'https://ok.com/'],
			fetcher
		);
		expect(probes).toHaveLength(6);
		expect(calls).not.toContain('HEAD http://169.254.169.254/');
		expect(calls).toContain('GET https://nohead.com/');
		const checks = linkProbeChecks(probes, 0);
		expect(byId(checks, 'links.live_broken')).toMatchObject({ level: 'block', items: ['https://gone.com/ — 404'] });
		expect(byId(checks, 'links.live_login')!.items![0]).toContain('https://app.com/login?next=dash');
		const err = byId(checks, 'links.live_error')!;
		expect(err.level).toBe('warn');
		expect(err.items!.join('\n')).toContain('blocked: private address');
		expect(err.items!.join('\n')).toContain('timed out');
	});
	it('checks at most 30 links', async () => {
		const urls = Array.from({ length: 35 }, (_, i) => `https://s${i}.com/`);
		const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
		const { probes, skipped } = await checkLinks(urls, fetcher);
		expect(probes).toHaveLength(LINK_CHECK_MAX);
		expect(skipped).toBe(5);
		expect(fetcher).toHaveBeenCalledTimes(30);
	});
});

// ------------------------------------------------------------------ D1: audience, send gate, endpoints

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return fd;
}
function actionEvent(fields: Record<string, string>) {
	const url = new URL('https://app.test/compose?/send');
	return { platform: { env: platformEnv }, params: {}, url, request: new Request(url, { method: 'POST', body: form(fields) }) } as any;
}
async function run(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}

const para = (text: string, href?: string) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', href }] } : {}) }] });
const goodBody = JSON.stringify([para('A real update with plenty of words. '.repeat(8)), para('Read more', 'https://ourco.example/blog')]);
const badBody = JSON.stringify([para('Hi {{firstname}}'), para('Click', 'https://your-link-here')]);

let listId: number;
let ids: number[];
beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockResolvedValue({ accepted: 1, failed: 0, firstError: null });
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM api_keys')
	]);
	listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	ids = [];
	for (const [email, first, sub] of [
		['a@x.example.net', 'Ann', 1],
		['b@x.example.net', '', 1],
		['c@x.example.net', 'Cy', 1],
		['d@x.example.net', 'Di', 1],
		['gone@x.example.net', 'G', 0]
	] as const) {
		const id = (await db.prepare('INSERT INTO contacts (email, first_name, subscribed) VALUES (?, ?, ?) RETURNING id').bind(email, first, sub).first<{ id: number }>())!.id;
		ids.push(id);
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, id).run();
	}
});

describe('audience stats on D1', () => {
	it('counts past bounces, excluded suppressed members, last send bounce rate and cold recipients', async () => {
		const prev = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, sent_at) VALUES ('Prev', 'x', 'x', 'a@b.example.net', 'sent', ?, datetime('now','-2 days')) RETURNING id")
			.bind(listId)
			.first<{ id: number }>())!.id;
		const rec: number[] = [];
		for (const [i, id] of ids.entries()) {
			rec.push((await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted') RETURNING id").bind(prev, id, `${i}@x`).first<{ id: number }>())!.id);
		}
		// b bounced (still subscribed), gone hard-bounced and was unsubscribed, a opened.
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail) VALUES (?, ?, ?, 'bounce', '{}')").bind(prev, rec[1], ids[1]).run();
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail) VALUES (?, ?, ?, 'bounce', '{}')").bind(prev, rec[4], ids[4]).run();
		await db.prepare("INSERT INTO unsubscribes (contact_id, email, reason) VALUES (?, 'gone@x.example.net', 'HardBounce')").bind(ids[4]).run();
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, 'open')").bind(prev, rec[0], ids[0]).run();

		const recipients = await recipientsForList(db, listId);
		const s = await audienceStats(db, listId, recipients);
		expect(s).toEqual({ recipients: 4, excludedBounced: 1, pastBounce: 1, lastSend: { campaignId: prev, subject: 'Prev', sent: 5, bounced: 2 }, neverEngaged: 3 });
		// Re-checking that campaign itself skips it as "last send".
		expect((await audienceStats(db, listId, recipients, prev)).lastSend).toBeNull();
	});

	it('runPresendChecks: coverage against the real audience', async () => {
		const r = await runPresendChecks(db, { subject: 'Hi', preheader: 'p', body: { blocks: null, md: 'Hello {{first_name}}, ' + 'words '.repeat(50) }, templateId: null, listId });
		expect(byId(r.checks, 'content.merge.first_name')!.title).toBe('{{first_name}}: 25% of recipients (1 of 4) have no first name');
		expect(byId(r.checks, 'audience.count')!.title).toBe('4 recipients');
		expect(r.linksChecked).toBe(false);
	});
});

describe('compose send: a block needs "Send anyway" (server-side)', () => {
	const base = { subject: 'Hello', from: 'alan@ourco.example', preheader: 'p' };

	it('refuses without the tick and sends nothing', async () => {
		const r = await run(compose.send!, actionEvent({ ...base, body_blocks: badBody, list_id: String(listId) }));
		expect(r.result?.status).toBe(400);
		expect(r.result?.data.error).toContain('blocking problem');
		expect(r.result?.data.checks.blocks).toBe(2);
		expect(spies.sendCampaignEmail).not.toHaveBeenCalled();
		expect((await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>())!.n).toBe(0);
	});

	it('refuses a schedule too', async () => {
		const when = new Date(Date.now() + 3600_000).toISOString();
		const r = await run(compose.send!, actionEvent({ ...base, body_blocks: badBody, list_id: String(listId), schedule_at: when }));
		expect(r.result?.status).toBe(400);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first<{ n: number }>())!.n).toBe(0);
	});

	it('sends with send_anyway=1', async () => {
		const r = await run(compose.send!, actionEvent({ ...base, body_blocks: badBody, list_id: String(listId), send_anyway: '1' }));
		expect(r.redirect).toMatch(/^\/campaign\/\d+$/);
		expect(spies.sendCampaignEmail).toHaveBeenCalledTimes(1);
	});

	it('warnings alone never block', async () => {
		const r = await run(compose.send!, actionEvent({ subject: 'Hello', from: 'alan@ourco.example', body_blocks: goodBody, list_id: String(listId) }));
		expect(r.redirect).toMatch(/^\/campaign\/\d+$/);
	});
});

describe('endpoints', () => {
	it('POST /compose/checks returns the report', async () => {
		const url = new URL('https://app.test/compose/checks');
		const res = await checksPOST({ platform: { env: platformEnv }, url, request: new Request(url, { method: 'POST', body: form({ subject: 'Hi', body_blocks: badBody, list_id: String(listId) }) }) } as any);
		const body = await res.json<any>();
		expect(body.blocks).toBe(2);
		expect(body.checks.map((c: Check) => c.id)).toContain('links.placeholder');
	});

	async function key(scope: string) {
		const k = await generateApiKey();
		await db.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)').bind('t', k.tokenHash, k.prefix, k.last4, scope).run();
		return k.token;
	}
	function apiEv(id: string, token?: string, body?: string) {
		const url = new URL(`https://app.test/api/v1/campaigns/${id}/checks`);
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (token) headers.authorization = `Bearer ${token}`;
		return { platform: { env }, url, params: { id }, request: new Request(url, { method: 'POST', headers, body }) } as any;
	}

	it('POST /api/v1/campaigns/:id/checks — auth, 404, 400, data', async () => {
		const id = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, body_blocks) VALUES ('Draft', 'x', 'x', 'a@b.example.net', 'draft', ?, ?) RETURNING id")
			.bind(listId, badBody)
			.first<{ id: number }>())!.id;
		expect((await apiChecks(apiEv(String(id)))).status).toBe(401);
		const read = await key('read');
		expect((await apiChecks(apiEv('999999', read))).status).toBe(404);
		expect((await apiChecks(apiEv('abc', read))).status).toBe(400);
		expect((await apiChecks(apiEv(String(id), read, '{"check_links":"yes"}'))).status).toBe(400);
		const res = await apiChecks(apiEv(String(id), read));
		expect(res.status).toBe(200);
		const { data } = await res.json<any>();
		expect(data).toMatchObject({ campaign_id: id, blocks: 2, links_checked: false });
		expect(byId(data.checks, 'content.merge_unknown')!.items).toEqual(['{{firstname}}']);
		expect((await apiChecks(apiEv(String(id), await key('campaigns:draft')))).status).toBe(403);
	});
});

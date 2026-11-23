import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';

// #481: public newsletter archive — index, issue pages, RSS, publishing, auto-publish, and the
// no-leak rules. Sends are mocked; the scheduler and routes are real.
const spies = vi.hoisted(() => ({ sendCampaignEmail: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: spies.sendCampaignEmail }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { GET as feedGET } from '../src/routes/newsletter/feed.xml/+server';
import { actions as compose } from '../src/routes/compose/+page.server';
import { actions as campaignPage } from '../src/routes/campaign/[id]/+page.server';
import { actions as campaignsList } from '../src/routes/campaigns/+page.server';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import {
	publishIssue,
	unpublishIssue,
	freeSlug,
	saveArchiveSettings,
	issueContentHtml,
	firstImage,
	issueTeaser,
	renderWebTemplatePreview
} from '../src/lib/server/newsletter-archive';
import { archiveSlugBase, subjectSlug } from '../src/lib/newsletter-archive';
import { renderPageHtml } from '../src/lib/blocks';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), POSTMARK_TOKEN: 'test', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const cfg = { token: 't', secret: 'test-secret', baseUrl: 'https://app.test', stream: 'broadcast' };
const admin = { id: 1, login: 'ourco-admin', role: 'admin' };
const member = { id: 2, login: 'pat', role: 'member' };

const id = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;

function getEvent(path: string, params: Record<string, string> = {}) {
	const url = new URL(`https://app.test${path}`);
	return { platform: { env: platformEnv }, params, url, locals: {}, request: new Request(url) } as any;
}
function actionEvent(path: string, action: string, fields: [string, string][], params: Record<string, string> = {}, user: unknown = admin) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test${path}?/${action}`);
	return { platform: { env: platformEnv }, params, url, locals: { user }, request: new Request(url, { method: 'POST', body: fd }) } as any;
}
async function run(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}
/** Status + body of a public GET (error() → its status). */
async function get(handler: (e: any) => Response | Promise<Response>, path: string, params: Record<string, string> = {}) {
	try {
		const res = await handler(getEvent(path, params));
		return { status: res.status, body: await res.text(), headers: res.headers };
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, body: '', headers: new Headers() };
		throw err;
	}
}

let listId: number;
let contactId: number;

async function campaign(o: {
	subject?: string;
	status?: string;
	list?: number | null;
	sent_at?: string;
	body_md?: string;
	body_blocks?: string | null;
	body_html?: string;
	preheader?: string | null;
	automation_id?: number | null;
	template_id?: number | null;
}) {
	return id(
		`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, list_id, from_email, status, sent_at, preheader, automation_id, template_id)
		 VALUES (?, ?, ?, ?, ?, 'alan@ourco.example', ?, ?, ?, ?, ?) RETURNING id`,
		o.subject ?? 'Hello world',
		o.body_md ?? 'Hi {{first_name}}, the news.',
		o.body_blocks ?? null,
		o.body_html ?? '<p>email</p>',
		o.list === undefined ? listId : o.list,
		o.status ?? 'sent',
		o.sent_at ?? '2026-10-14 15:00:00',
		o.preheader ?? 'A teaser',
		o.automation_id ?? null,
		o.template_id ?? null
	);
}

async function enable(extra: Partial<Parameters<typeof saveArchiveSettings>[1]> = {}) {
	expect(
		await saveArchiveSettings(db, {
			enabled: true,
			title: 'Newsletter',
			intro: '',
			subscribeUrl: 'https://ourco.example/subscribe',
			templateId: null,
			indexable: true,
			autoGroups: [],
			...extra
		})
	).toBeNull();
}

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendCampaignEmail.mockImplementation(async (_db: unknown, o: { recipients: unknown[] }) => ({ accepted: o.recipients.length, failed: 0, firstError: null }));
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM templates WHERE kind = 'web'"),
		db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%' OR key IN ('mailing_address', 'logo_key')")
	]);
	contactId = await id("INSERT INTO contacts (email, first_name, subscribed) VALUES ('ann@example.com', 'Ann', 1) RETURNING id");
	listId = await id("INSERT INTO lists (name, kind) VALUES ('Secret VIP list', 'list') RETURNING id");
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, contactId).run();
});

describe('slugs', () => {
	it('YYYY-MM-DD-<subject-slug>, merge tags and accents dropped', () => {
		expect(archiveSlugBase('2026-10-14 15:00:00', 'Café news, {{first_name}}!')).toBe('2026-10-14-cafe-news');
		expect(subjectSlug('')).toBe('issue');
	});

	it('is set once and kept across remove / re-publish; collisions get -2, -3', async () => {
		const a = await campaign({ subject: 'Weekly notes' });
		const b = await campaign({ subject: 'Weekly notes' });
		const c = await campaign({ subject: 'Weekly notes' });
		const ra = await publishIssue(db, a);
		const rb = await publishIssue(db, b);
		const rc = await publishIssue(db, c);
		expect([ra, rb, rc].map((r) => (r.ok ? r.slug : r.error))).toEqual(['2026-10-14-weekly-notes', '2026-10-14-weekly-notes-2', '2026-10-14-weekly-notes-3']);
		await unpublishIssue(db, b);
		await db.prepare("UPDATE campaigns SET subject = 'Renamed' WHERE id = ?").bind(b).run();
		const again = await publishIssue(db, b);
		expect(again.ok && again.slug).toBe('2026-10-14-weekly-notes-2');
	});

	it('#484: a long subject publishes, and a second one with the same subject gets -2', async () => {
		const subject = "BOO! 👻 Thanks for Attending the Claude User's Meetup Pasadena, Unofficial";
		const base = archiveSlugBase('2026-10-14 15:00:00', subject);
		expect(new TextEncoder().encode(`${base}-%`).length).toBeGreaterThan(50); // past D1's LIKE cap
		const a = await campaign({ subject });
		const b = await campaign({ subject });
		const ra = await publishIssue(db, a);
		const rb = await publishIssue(db, b);
		expect([ra, rb].map((r) => (r.ok ? r.slug : r.error))).toEqual([base, `${base}-2`]);
	});

	it('#484: freeSlug issues no LIKE / GLOB (miniflare does not enforce the D1 pattern cap)', async () => {
		const sql: string[] = [];
		const spy = new Proxy(db, {
			get(target, prop) {
				if (prop === 'prepare') return (q: string) => (sql.push(q), target.prepare(q));
				const v = (target as any)[prop];
				return typeof v === 'function' ? v.bind(target) : v;
			}
		});
		await campaign({ subject: 'Weekly notes' });
		await publishIssue(db, await campaign({ subject: 'Weekly notes' }));
		expect(await freeSlug(spy, '2026-10-14-weekly-notes')).toBe('2026-10-14-weekly-notes-2');
		expect(sql.length).toBeGreaterThan(0);
		for (const q of sql) expect(q).not.toMatch(/\b(LIKE|GLOB)\b/i);
	});

	it('only sent broadcasts can be published', async () => {
		const draft = await campaign({ status: 'draft' });
		const direct = await campaign({ list: null });
		const scheduled = await campaign({ status: 'scheduled' });
		const autoId = await id("INSERT INTO automations (name, status) VALUES ('Nurture', 'active') RETURNING id");
		const step = await campaign({ automation_id: autoId, list: null });
		for (const cid of [draft, direct, scheduled, step]) expect((await publishIssue(db, cid)).ok).toBe(false);
	});
});

describe('public pages', () => {
	it('404 for everything while the archive is off', async () => {
		const c = await campaign({});
		const r = await publishIssue(db, c);
		expect((await get(indexGET, '/newsletter')).status).toBe(404);
		expect((await get(issueGET, `/newsletter/${r.ok && r.slug}`, { slug: r.ok ? r.slug : '' })).status).toBe(404);
		expect((await get(feedGET, '/newsletter/feed.xml')).status).toBe(404);
	});

	it('the index lists only published, sent broadcasts, newest first; cached 5 minutes', async () => {
		await enable();
		const older = await campaign({ subject: 'Older issue', sent_at: '2025-12-01 10:00:00' });
		const newer = await campaign({ subject: 'Newer issue', sent_at: '2026-10-01 10:00:00' });
		await campaign({ subject: 'Never published' });
		const draft = await campaign({ subject: 'Draft forced', status: 'draft' });
		const direct = await campaign({ subject: 'Direct forced', list: null });
		await publishIssue(db, older);
		await publishIssue(db, newer);
		// Even with the columns set by hand, a draft / 1:1 row never shows.
		await db
			.prepare("UPDATE campaigns SET archive_slug = '2026-01-01-x' || id, archive_published_at = datetime('now') WHERE id IN (?, ?)")
			.bind(draft, direct)
			.run();
		const res = await get(indexGET, '/newsletter');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=300');
		expect(res.body.indexOf('Newer issue')).toBeGreaterThan(-1);
		expect(res.body.indexOf('Newer issue')).toBeLessThan(res.body.indexOf('Older issue'));
		expect(res.body).toContain('A teaser');
		expect(res.body).toContain('>2026<');
		expect(res.body).toContain('>2025<');
		for (const s of ['Never published', 'Draft forced', 'Direct forced']) expect(res.body).not.toContain(s);
		expect((await get(indexGET, '/newsletter?page=9')).status).toBe(404);
	});

	it('issue page: 200 when published; 404 when unpublished, unsent or unknown', async () => {
		await enable();
		const c = await campaign({ subject: 'The issue' });
		const r = await publishIssue(db, c);
		const slug = r.ok ? r.slug : '';
		const ok = await get(issueGET, `/newsletter/${slug}`, { slug });
		expect(ok.status).toBe(200);
		expect(ok.body).toContain('<h1 class="nl-title">The issue</h1>');
		expect(ok.body).toContain(`<link rel="canonical" href="https://app.test/newsletter/${slug}">`);
		expect(ok.body).toContain('<meta name="description" content="A teaser">');
		expect(ok.body).not.toContain('noindex');
		expect(ok.body).toContain('Get the next one in your inbox');

		await unpublishIssue(db, c);
		expect((await get(issueGET, `/newsletter/${slug}`, { slug })).status).toBe(404);
		await publishIssue(db, c);
		await db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").bind(c).run();
		expect((await get(issueGET, `/newsletter/${slug}`, { slug })).status).toBe(404);
		expect((await get(issueGET, '/newsletter/2026-10-14-nope', { slug: '2026-10-14-nope' })).status).toBe(404);
		expect((await get(issueGET, '/newsletter/x', { slug: 'x' })).status).toBe(404);
	});

	it('noindex when search engines are not allowed; prev / next links', async () => {
		await enable({ indexable: false });
		const a = await campaign({ subject: 'First', sent_at: '2026-01-01 10:00:00' });
		const b = await campaign({ subject: 'Second', sent_at: '2026-02-01 10:00:00' });
		const c = await campaign({ subject: 'Third', sent_at: '2026-03-01 10:00:00' });
		for (const x of [a, b, c]) await publishIssue(db, x);
		const res = await get(issueGET, '/newsletter/2026-02-01-second', { slug: '2026-02-01-second' });
		expect(res.body).toContain('<meta name="robots" content="noindex">');
		expect(res.body).toContain('href="/newsletter/2026-01-01-first"');
		expect(res.body).toContain('href="/newsletter/2026-03-01-third"');
	});

	it('RSS 2.0 with escaped titles', async () => {
		await enable({ title: 'News & <notes>' });
		const c = await campaign({ subject: 'Q&A: "tips" <and> tricks', preheader: 'Fish & chips' });
		await publishIssue(db, c);
		const res = await get(feedGET, '/newsletter/feed.xml');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/rss+xml');
		expect(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(res.body).toContain('<rss version="2.0"');
		expect(res.body).toContain('<title>News &amp; &lt;notes&gt;</title>');
		expect(res.body).toContain('<title>Issue 1 · Q&amp;A: &quot;tips&quot; &lt;and&gt; tricks</title>');
		expect(res.body).toContain('<description>Fish &amp; chips</description>');
		expect(res.body).toContain('<link>https://app.test/newsletter/2026-10-14-q-a-tips-and-tricks</link>');
		// Well-formed: no raw '&' that isn't an entity, tags balanced.
		expect(/&(?!(amp|lt|gt|quot|apos);)/.test(res.body)).toBe(false);
		expect(res.body.match(/<item>/g)!.length).toBe(res.body.match(/<\/item>/g)!.length);
	});
});

describe('content', () => {
	const para = (text: string, extra: object = {}) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text }], ...extra });

	it('blocks render through the page renderer (images, buttons, sections, columns)', () => {
		const blocks = [
			{ id: 'h', type: 'heading', level: 2, text: 'Big news' },
			{ id: 'i', type: 'image', src: 'https://cdn.test/a.png', alt: 'A' },
			{ id: 'b', type: 'button', label: 'Read more', href: 'https://ourco.example/post', align: 'left' },
			{ id: 's', type: 'section', bg: '#066971', padding: 'md', width: 'inset', align: 'left', blocks: [para('Inside a section')] },
			{ id: 'c', type: 'columns', cells: [[para('Left')], [para('Right')]] },
			{ id: 'q', type: 'quote', content: [{ type: 'text', text: 'Quoted' }] },
			{ id: 'd', type: 'divider' }
		];
		const html = issueContentHtml({ body_blocks: JSON.stringify(blocks), body_md: 'ignored', body_html: '', from_email: 'alan@ourco.example', template_kind: null });
		for (const s of ['<h2>Big news</h2>', 'src="https://cdn.test/a.png"', 'class="btn"', 'class="b-sec inset"', 'class="cols cols-2"', '<blockquote>', '<hr>'])
			expect(html).toContain(s);
		expect(html).not.toContain('ignored');
	});

	it('markdown campaigns render the markdown', () => {
		const html = issueContentHtml({ body_blocks: null, body_md: '## Title\n\nSome **bold** text.', body_html: '', from_email: 'a@b.example.net', template_kind: 'builder' });
		expect(html).toContain('<h2>Title</h2>');
		expect(html).toContain('<strong>bold</strong>');
	});

	it('raw-HTML template campaigns fall back to the stored email in a sandboxed iframe', () => {
		const html = issueContentHtml({ body_blocks: null, body_md: '[HTML template: X]', body_html: '<html><body><h1>Email body</h1></body></html>', from_email: 'a@b.example.net', template_kind: 'html' });
		expect(html).toContain('<iframe class="nl-frame"');
		expect(html).toContain('sandbox=""');
		expect(html).toContain('srcdoc="');
		expect(html).toContain('&lt;h1&gt;Email body&lt;/h1&gt;');
	});

	it('personal merge tags use their fallbacks or vanish cleanly', () => {
		const md = 'Hi {{first_name}},\n\nHello {{last_name}}, welcome to {{company.name|your team}}. Field: [{{field:plan}}] {{email}}.';
		const html = issueContentHtml({ body_blocks: null, body_md: md, body_html: '', from_email: 'a@b.example.net', template_kind: null });
		expect(html).toContain('Hi there,');
		expect(html).toContain('Hello, welcome to your team.');
		expect(html).toContain('Field: []');
		expect(html).not.toContain('{{');
	});

	it('conditional blocks: only what an anonymous reader would see', () => {
		const blocks = [para('For everyone'), para('Hot only', { visibility: { kind: 'tag', name: 'hot' } }), para('Not VIP', { visibility: { kind: 'no-tag', name: 'vip' } })];
		const html = issueContentHtml({ body_blocks: JSON.stringify(blocks), body_md: '', body_html: '', from_email: 'a@b.example.net', template_kind: null });
		expect(html).toContain('For everyone');
		expect(html).toContain('Not VIP');
		expect(html).not.toContain('Hot only');
	});

	it('NO LEAKS: unsubscribe links / tokens, tracking, recipient data, stats, From, list and automation names', async () => {
		await enable();
		const autoId = await id("INSERT INTO automations (name, status) VALUES ('Secret nurture flow', 'active') RETURNING id");
		const md = [
			'Hi {{first_name}} ({{email}}),',
			'',
			'Write to alan@ourco.example or [mail me](mailto:alan@ourco.example).',
			'',
			'[Unsubscribe](%%UNSUB_URL%%) · [Manage preferences](https://app.test/unsubscribe?t=abc.def) · [tracked](https://click.pstmrk.it/abc)',
			'',
			'![](https://track.example/open.gif?u=1)'
		].join('\n');
		const c = await campaign({ subject: 'Leak test', body_md: md });
		// Recipient data + stats on the campaign that must never reach the page.
		const rid = await id(
			"INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@example.com', 'msg-1', 'accepted') RETURNING id",
			c,
			contactId
		);
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, type, recorded_at) VALUES (?, ?, 'open', datetime('now'))").bind(c, rid).run();
		await db.prepare('UPDATE campaigns SET recipient_count = 4242, automation_id = NULL WHERE id = ?').bind(c).run();
		const r = await publishIssue(db, c);
		const slug = r.ok ? r.slug : '';
		// The subscribe box's own copy ("Unsubscribe anytime.") isn't a leak.
		const own = (b: string) => b.replace("One email when there's something worth sharing. Unsubscribe anytime.", '');
		const page = own((await get(issueGET, `/newsletter/${slug}`, { slug })).body);
		const index = own((await get(indexGET, '/newsletter')).body);
		const feed = (await get(feedGET, '/newsletter/feed.xml')).body;
		for (const body of [page, index, feed]) {
			for (const bad of [
				'%%UNSUB_URL%%',
				'/unsubscribe',
				'Unsubscribe',
				'preferences',
				't=abc',
				'pstmrk',
				'open.gif',
				'ann@example.com',
				'Ann',
				'4242',
				'alan@ourco.example',
				'Secret VIP list',
				'Secret nurture flow',
				'msg-1',
				'{{'
			])
				expect(body, bad).not.toContain(bad);
		}
		expect(page).toContain('Hi there');
		void autoId;
	});

	it('the HTML fallback drops the email footer, signature and permission reminder', () => {
		const email = `<html><body><div class="email"><p>Body</p><div class="signature">sig</div></div><div class="footer">
You're receiving this email because: Joined Secret VIP list<br>Don't want these emails? <a href="%%UNSUB_URL%%">Unsubscribe here</a>.
</div><img src="https://x.test/p.gif" width="1" height="1"></body></html>`;
		const html = issueContentHtml({ body_blocks: null, body_md: '', body_html: email, from_email: 'a@b.example.net', template_kind: 'html' });
		for (const bad of ['Secret VIP list', 'UNSUB', 'Unsubscribe', 'p.gif']) expect(html).not.toContain(bad);
		expect(html).toContain('Body');
	});
});

describe('thumbnails and teasers', () => {
	const img = (src: string, extra: object = {}) => ({ id: Math.random().toString(36).slice(2), type: 'image', src, alt: '', ...extra });
	const para = (text: string) => ({ id: Math.random().toString(36).slice(2), type: 'paragraph', content: [{ type: 'text', text }] });
	const row = (o: { body_blocks?: unknown[]; body_md?: string; template_kind?: string | null }) => ({
		body_blocks: o.body_blocks ? JSON.stringify(o.body_blocks) : null,
		body_md: o.body_md ?? null,
		from_email: 'alan@ourco.example',
		template_kind: o.template_kind ?? null
	});

	it('the thumbnail skips a logo chip and picks the first real photo', () => {
		const blocks = [img('https://cdn.test/brand.png', { style: 'chip' }), para('Hello'), img('https://cdn.test/photo.jpg')];
		expect(firstImage(JSON.stringify(blocks), null)).toBe('https://cdn.test/photo.jpg');
	});

	it('only logos / icons / small images: no thumbnail', () => {
		const blocks = [
			img('https://cdn.test/brand.png', { style: 'chip' }),
			img('https://cdn.test/app-logo.png'),
			img('https://cdn.test/icons/star.png'),
			img('https://cdn.test/favicon-32.png'),
			img('https://cdn.test/badge.png', { width: 120 }),
			img('https://cdn.test/wordmark.png', { beside: 'Ourco' })
		];
		expect(firstImage(JSON.stringify(blocks), null)).toBeNull();
		expect(firstImage(JSON.stringify([img('https://cdn.test/logo.svg')]), null)).toBeNull();
		// Markdown: the same icon rule.
		expect(firstImage(null, '![](https://cdn.test/img/logo-dark.png)\n\n![Hero](https://cdn.test/hero.jpg)')).toBe('https://cdn.test/hero.jpg');
		expect(firstImage(null, '![](https://cdn.test/img/logo-dark.png)')).toBeNull();
	});

	it('an image inside a section (or columns) is found, in document order', () => {
		const sec = (blocks: unknown[]) => ({ id: 's' + Math.random(), type: 'section', bg: '#066971', padding: 'md', width: 'inset', align: 'left', blocks });
		const hero = sec([img('https://cdn.test/logo.png', { style: 'chip' }), para('Issue 12')]);
		const body = sec([{ id: 'c', type: 'columns', cells: [[para('Left')], [img('https://cdn.test/nested.jpg', { width: 400 })]] }]);
		expect(firstImage(JSON.stringify([hero, body, img('https://cdn.test/later.jpg')]), null)).toBe('https://cdn.test/nested.jpg');
	});

	it('no preheader: the teaser is the opening text, merge tags resolved, cut on a word with an ellipsis', async () => {
		const long = 'This month we rebuilt the onboarding flow from scratch and measured every step of it, so here is what changed, what we learned, and what is coming next for everyone.';
		const t = issueTeaser(
			row({
				body_blocks: [
					{ id: 'h', type: 'heading', level: 2, text: 'October notes' },
					{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mergeTag', tag: 'first_name' }, { type: 'text', text: ', ' }] },
					para(long)
				]
			})
		);
		expect(t.startsWith('October notes. Hi there, This month we rebuilt')).toBe(true);
		expect(t.endsWith('…')).toBe(true);
		expect([...t].length).toBeLessThanOrEqual(161);
		expect(t).not.toContain('{{');
		expect(t.slice(0, -1)).toBe(t.slice(0, -1).trimEnd());
		expect(long).toContain(t.slice('October notes. Hi there, '.length, -1)); // whole words only
		// Markdown: tags fall back or vanish; links keep their text; images and unsubscribe links go.
		expect(issueTeaser(row({ body_md: '## Big *news*\n\nHello {{last_name}}, read [the post](https://x.test/p). ![](https://x.test/a.png) [Unsubscribe](%%UNSUB_URL%%)' }))).toBe(
			'Big news. Hello, read the post.'
		);
		expect(issueTeaser(row({ body_md: '[HTML template: X]', template_kind: 'html' }))).toBe('');

		// On the index card and the issue page's meta description.
		await enable();
		const c = await campaign({ subject: 'No preheader', preheader: '', body_md: 'Hi {{first_name}}, short and sweet.' });
		const r = await publishIssue(db, c);
		const slug = r.ok ? r.slug : '';
		expect((await get(indexGET, '/newsletter')).body).toContain('<p>Hi there, short and sweet.</p>');
		expect((await get(issueGET, `/newsletter/${slug}`, { slug })).body).toContain('<meta name="description" content="Hi there, short and sweet.">');
	});
});

describe('web template', () => {
	it('the content area is substituted: header blocks before, footer blocks after', async () => {
		await enable();
		const blocks = [
			{ id: 'h', type: 'paragraph', content: [{ type: 'text', text: 'TEMPLATE HEADER' }] },
			{ id: 'c', type: 'content' },
			{ id: 'f', type: 'paragraph', content: [{ type: 'text', text: 'TEMPLATE FOOTER' }] }
		];
		const tid = await id("INSERT INTO templates (name, kind, blocks, canvas) VALUES ('Web', 'web', ?, ?) RETURNING id", JSON.stringify(blocks), JSON.stringify({ width: 760, link: '#ce423b' }));
		await enable({ templateId: tid });
		const c = await campaign({ subject: 'Substituted', body_md: 'ISSUE BODY' });
		const r = await publishIssue(db, c);
		const slug = r.ok ? r.slug : '';
		const body = (await get(issueGET, `/newsletter/${slug}`, { slug })).body;
		const [h, i, f] = ['TEMPLATE HEADER', 'ISSUE BODY', 'TEMPLATE FOOTER'].map((s) => body.indexOf(s));
		expect(h).toBeGreaterThan(-1);
		expect(h).toBeLessThan(i);
		expect(i).toBeLessThan(f);
		expect(body).toContain('<header class="nl-head">');
		expect(body).toContain('--nl-width:760px');
		expect(body).toContain('--nl-link:#ce423b');
		expect(body).toContain('prefers-color-scheme: dark');
		// The index uses the same template around the list.
		const index = (await get(indexGET, '/newsletter')).body;
		expect(index).toContain('TEMPLATE HEADER');
		expect(index).toContain('Substituted');
	});

	it('a content area inside a section is filled in place; preview renders a sample issue', () => {
		const blocks = [{ id: 's', type: 'section', bg: '#f5f3ed', padding: 'md', width: 'inset', align: 'left', blocks: [{ id: 'c', type: 'content' }] }];
		const html = renderWebTemplatePreview(blocks as never, {});
		expect(html).toMatch(/<section class="b-sec inset"[^>]*>[\s\S]*A sample issue title[\s\S]*<\/section>/);
	});

	it('the built-in default has the logo header and the mailing address footer', async () => {
		await enable();
		await db.prepare("INSERT INTO app_state (key, value) VALUES ('mailing_address', 'Ourco Inc\n123 Main St')").run();
		// #595: the header logo is the install's own Branding upload (none = no logo).
		await db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('logo_key', 'branding/logo-0123456789abcdef.png')").run();
		const c = await campaign({});
		const pub = await publishIssue(db, c);
		const body = (await get(indexGET, '/newsletter')).body;
		expect(body).toMatch(/<header class="nl-head">[\s\S]*<img src="https:\/\/[^"]+"/);
		expect(body).toContain('123 Main St');
		// #498: "← All newsletters" shows on issue pages only.
		expect(body).not.toContain('All newsletters');
		const slug = pub.ok ? pub.slug : '';
		expect((await get(issueGET, `/newsletter/${slug}`, { slug })).body).toContain('All newsletters');
	});

	it('hosted pages render exactly as before (content blocks stay empty)', () => {
		const html = renderPageHtml('T', [{ id: 'c', type: 'content' } as never, { id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'x' }] } as never]);
		expect(html).toContain('<main class="page">');
		expect(html).toContain('<p>x</p>');
		expect(html).not.toContain('%%CONTENT_AREA%%');
	});
});

describe('publishing', () => {
	it('compose: "Publish after sending" publishes an immediate send', async () => {
		const r = await run(
			compose.send!,
			actionEvent('/compose', 'send', [
				['subject', 'Sent now'],
				['from', 'alan@ourco.example'],
				['preheader', 'Teaser'],
				['body_md', 'Some real content for the issue, long enough to read.'],
				['include_id', String(listId)],
				['send_anyway', '1'],
				['archive_after_send', '1']
			])
		);
		const cid = Number(r.redirect!.match(/\/campaign\/(\d+)/)![1]);
		const row = await db.prepare('SELECT status, archive_slug, archive_published_at, preheader FROM campaigns WHERE id = ?').bind(cid).first<any>();
		expect(row.status).toBe('sent');
		expect(row.archive_published_at).not.toBeNull();
		expect(row.archive_slug).toMatch(/^\d{4}-\d{2}-\d{2}-sent-now$/);
		expect(row.preheader).toBe('Teaser');
	});

	it('compose: the checkbox is ignored for a member', async () => {
		const r = await run(
			compose.send!,
			actionEvent(
				'/compose',
				'send',
				[
					['subject', 'Member send'],
					['from', 'alan@ourco.example'],
					['body_md', 'Some real content for the issue, long enough to read.'],
					['include_id', String(listId)],
					['send_anyway', '1'],
					['archive_after_send', '1']
				],
				{},
				member
			)
		);
		const cid = Number(r.redirect!.match(/\/campaign\/(\d+)/)![1]);
		expect((await db.prepare('SELECT archive_published_at FROM campaigns WHERE id = ?').bind(cid).first<any>()).archive_published_at).toBeNull();
	});

	it('compose: a scheduled send publishes when the scheduler sends it', async () => {
		const when = new Date(Date.now() + 3600_000).toISOString();
		const r = await run(
			compose.send!,
			actionEvent('/compose', 'send', [
				['subject', 'Scheduled issue'],
				['from', 'alan@ourco.example'],
				['body_md', 'Some real content for the issue, long enough to read.'],
				['include_id', String(listId)],
				['send_anyway', '1'],
				['schedule_at', when],
				['archive_after_send', '1']
			])
		);
		const cid = Number(r.redirect!.match(/\/campaign\/(\d+)/)![1]);
		expect((await db.prepare('SELECT archive_published_at FROM campaigns WHERE id = ?').bind(cid).first<any>()).archive_published_at).toBeNull();
		await db.prepare("UPDATE campaigns SET scheduled_at = datetime('now', '-1 minute') WHERE id = ?").bind(cid).run();
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		const row = await db.prepare('SELECT status, archive_published_at FROM campaigns WHERE id = ?').bind(cid).first<any>();
		expect(row.status).toBe('sent');
		expect(row.archive_published_at).not.toBeNull();
	});

	it('auto-publish groups: a scheduled broadcast to an auto group publishes itself; others do not', async () => {
		const other = await id("INSERT INTO lists (name, kind) VALUES ('Other', 'list') RETURNING id");
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(other, contactId).run();
		await enable({ autoGroups: [listId] });
		const mk = (lid: number) =>
			id(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, scheduled_at)
				 VALUES ('Auto', 'x', '<p>x</p>', ?, 'alan@ourco.example', 'scheduled', datetime('now', '-1 minute')) RETURNING id`,
				lid
			);
		const yes = await mk(listId);
		const no = await mk(other);
		await processScheduledCampaigns(db, cfg);
		const pub = async (cid: number) => (await db.prepare('SELECT archive_published_at FROM campaigns WHERE id = ?').bind(cid).first<any>()).archive_published_at;
		expect(await pub(yes)).not.toBeNull();
		expect(await pub(no)).toBeNull();
	});

	it('campaign page publish / remove are admin-only (member → 403)', async () => {
		const c = await campaign({});
		const m = await run(campaignPage.archivePublish!, actionEvent(`/campaign/${c}`, 'archivePublish', [], { id: String(c) }, member));
		expect(m.result.status).toBe(403);
		const mr = await run(campaignPage.archiveRemove!, actionEvent(`/campaign/${c}`, 'archiveRemove', [], { id: String(c) }, member));
		expect(mr.result.status).toBe(403);
		const bulk = await run(campaignsList.archiveBulk!, actionEvent('/campaigns', 'archiveBulk', [['op', 'publish'], ['id', String(c)]], {}, member));
		expect(bulk.result.status).toBe(403);
		expect((await db.prepare('SELECT archive_published_at FROM campaigns WHERE id = ?').bind(c).first<any>()).archive_published_at).toBeNull();

		const a = await run(campaignPage.archivePublish!, actionEvent(`/campaign/${c}`, 'archivePublish', [], { id: String(c) }, admin));
		expect(a.result).toMatchObject({ archived: true });
		const draft = await campaign({ status: 'draft' });
		const b = await run(campaignsList.archiveBulk!, actionEvent('/campaigns', 'archiveBulk', [['op', 'remove'], ['id', String(c)], ['id', String(draft)]], {}, admin));
		expect(b.result.archiveDone).toEqual({ op: 'remove', changed: 1, skipped: 0 });
	});
});

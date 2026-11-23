import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';

// #483: the web-only version of a newsletter archive issue — title, teaser and body that the
// archive pages prefer, without ever changing the sent email.
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: vi.fn(), suppress: vi.fn() }));

import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { GET as feedGET } from '../src/routes/newsletter/feed.xml/+server';
import { GET as apiGET } from '../src/routes/api/v1/newsletter/+server';
import { load as editorLoad, actions as editor } from '../src/routes/campaign/[id]/archive/+page.server';
import { GET as previewGET, POST as previewPOST } from '../src/routes/campaign/[id]/archive/preview/+server';
import { publishIssue, saveArchiveSettings, listIssues, saveWebVersion } from '../src/lib/server/newsletter-archive';
import { generateApiKey, sha256Hex } from '../src/lib/server/api-keys';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const admin = { id: 1, login: 'ourco-admin', role: 'admin' };
const member = { id: 2, login: 'pat', role: 'member' };

const id = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;

function event(path: string, o: { params?: Record<string, string>; user?: unknown; fields?: [string, string][]; headers?: Record<string, string> } = {}) {
	const url = new URL(`https://app.test${path}`);
	let request = new Request(url, { headers: o.headers });
	if (o.fields) {
		const fd = new FormData();
		for (const [k, v] of o.fields) fd.append(k, v);
		request = new Request(url, { method: 'POST', body: fd, headers: o.headers });
	}
	return { platform: { env: platformEnv }, params: o.params ?? {}, url, locals: { user: o.user }, request } as any;
}
async function status(fn: () => unknown): Promise<{ status: number; value?: any }> {
	try {
		const v: any = await fn();
		if (v instanceof Response) return { status: v.status, value: await v.text() };
		return { status: v?.status ?? 200, value: v };
	} catch (err) {
		if (isHttpError(err)) return { status: err.status };
		throw err;
	}
}
async function page(handler: (e: any) => Response | Promise<Response>, path: string, params: Record<string, string> = {}) {
	const r = await status(() => handler(event(path, { params })));
	return { status: r.status, body: (r.value as string) ?? '' };
}

let listId: number;

async function campaign(o: { subject?: string; body_md?: string; body_blocks?: string | null; body_html?: string; preheader?: string | null; list?: number | null; automation_id?: number | null; template_id?: number | null; sent_at?: string } = {}) {
	return id(
		`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, list_id, from_email, status, sent_at, preheader, automation_id, template_id)
		 VALUES (?, ?, ?, ?, ?, 'alan@ourco.example', 'sent', ?, ?, ?, ?) RETURNING id`,
		o.subject ?? 'Event recap',
		o.body_md ?? 'Sorry you couldn’t make it, {{first_name}}! Here is the recap.',
		o.body_blocks ?? null,
		o.body_html ?? '<p>email</p>',
		o.list === undefined ? listId : o.list,
		o.sent_at ?? '2026-10-14 15:00:00',
		o.preheader === undefined ? 'Email preheader' : o.preheader,
		o.automation_id ?? null,
		o.template_id ?? null
	);
}

const p = (text: string, marks?: unknown[]) => ({ id: crypto.randomUUID(), type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const img = (src: string) => ({ id: crypto.randomUUID(), type: 'image', src, alt: 'Photo' });

function saveFields(o: { title?: string; teaser?: string; blocks?: unknown[]; mode?: string }): [string, string][] {
	return [
		['title', o.title ?? ''],
		['teaser', o.teaser ?? ''],
		['body_mode', o.mode ?? 'blocks'],
		['body_blocks', JSON.stringify(o.blocks ?? [])]
	];
}
const save = (cid: number, o: Parameters<typeof saveFields>[0], user: unknown = admin) =>
	status(() => editor.save(event(`/campaign/${cid}/archive?/save`, { params: { id: String(cid) }, user, fields: saveFields(o) })));

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM lists'),
		db.prepare("DELETE FROM templates WHERE kind IN ('web', 'html')"),
		db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%'")
	]);
	listId = await id("INSERT INTO lists (name, kind) VALUES ('Members', 'list') RETURNING id");
	expect(
		await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] })
	).toBeNull();
});

describe('rendering', () => {
	it('without an override the page renders the email; with one, the web title, teaser and body', async () => {
		const cid = await campaign();
		const pub = await publishIssue(db, cid);
		const slug = pub.ok ? pub.slug : '';
		const before = await page(issueGET, `/newsletter/${slug}`, { slug });
		expect(before.status).toBe(200);
		expect(before.body).toContain('Sorry you couldn’t make it');
		expect(before.body).toContain('<title>Issue 1 · Event recap | Newsletter</title>');
		expect(before.body).toContain('content="Email preheader"');

		expect((await save(cid, { title: 'What happened at the meetup', teaser: 'The recap for everyone.', blocks: [p('Here is the recap.')] })).status).toBe(200);
		const after = await page(issueGET, `/newsletter/${slug}`, { slug });
		expect(after.body).toContain('<h1 class="nl-title">What happened at the meetup</h1>');
		expect(after.body).toContain('content="The recap for everyone."');
		expect(after.body).toContain('Here is the recap.');
		expect(after.body).not.toContain('Sorry you couldn');
		// The slug never changes with the title.
		expect((await db.prepare('SELECT archive_slug FROM campaigns WHERE id = ?').bind(cid).first<{ archive_slug: string }>())!.archive_slug).toBe(slug);
	});

	it('a blank title / teaser falls back to the subject / preheader', async () => {
		const cid = await campaign();
		await publishIssue(db, cid);
		await save(cid, { title: '   ', teaser: '', blocks: [p('Web body.')] });
		const [i] = await listIssues(db, { limit: 5, offset: 0 });
		expect(i.subject).toBe('Event recap');
		expect(i.teaser).toBe('Email preheader');
		expect(i.edited).toBe(true);
	});

	it('the index, feed, teaser, thumbnail, prev/next and the API use the override', async () => {
		const older = await campaign({ subject: 'Older issue', sent_at: '2026-10-01 10:00:00', body_md: '![x](https://cdn.test/email.jpg)\n\nOld text.' });
		const newer = await campaign({ subject: 'Newer issue', sent_at: '2026-10-20 10:00:00', preheader: null });
		await publishIssue(db, older);
		const np = await publishIssue(db, newer);
		await save(older, { title: 'Older, for the web', teaser: 'Web teaser', blocks: [img('https://cdn.test/web.jpg'), p('Web text.')] });
		// No teaser override and no preheader: the opening text of the web body.
		await save(newer, { blocks: [p('Opening line of the web version.')] });

		const index = await page(indexGET, '/newsletter');
		expect(index.body).toContain('Older, for the web');
		expect(index.body).toContain('Web teaser');
		expect(index.body).toContain('https://cdn.test/web.jpg');
		expect(index.body).not.toContain('email.jpg');
		expect(index.body).toContain('Opening line of the web version.');

		const feed = await page(feedGET, '/newsletter/feed.xml');
		expect(feed.body).toContain('<title>Issue 1 · Older, for the web</title>');
		expect(feed.body).toContain('<description>Web teaser</description>');

		const slug = np.ok ? np.slug : '';
		const issue = await page(issueGET, `/newsletter/${slug}`, { slug });
		expect(issue.body).toContain('Older, for the web'); // the previous-issue link
		expect(issue.body).not.toContain('>Older issue<');

		const { token } = await generateApiKey();
		await db.prepare("INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, 'dk', 'x', 'read')").bind(await sha256Hex(token)).run();
		const res = await apiGET(event('/api/v1/newsletter', { headers: { Authorization: `Bearer ${token}` } }));
		const body = (await res.json()) as { data: any[] };
		const o = body.data.find((d) => d.id === older);
		expect(o).toMatchObject({ title: 'Older, for the web', teaser: 'Web teaser', subject: 'Older issue', edited_for_web: true });
	});

	it('NO LEAKS from the override: merge tags, unsubscribe / preference links, tracking, the From address', async () => {
		const cid = await campaign();
		const pub = await publishIssue(db, cid);
		const slug = pub.ok ? pub.slug : '';
		await save(cid, {
			title: 'Hi {{first_name}} {{last_name}}',
			teaser: 'For {{email}}',
			blocks: [
				p('Hello {{first_name}}, write to alan@ourco.example.'),
				p('Unsubscribe', [{ type: 'link', href: '%%UNSUB_URL%%' }]),
				p('Preferences', [{ type: 'link', href: 'https://app.test/unsubscribe?t=abc' }]),
				p('Tracked', [{ type: 'link', href: 'https://click.pstmrk.it/abc' }]),
				{ ...p('VIPs only'), visibility: { kind: 'tag', name: 'vip' } }
			]
		});
		const { body } = await page(issueGET, `/newsletter/${slug}`, { slug });
		expect(body).toContain('Hi there');
		expect(body).not.toMatch(/\{\{|%%UNSUB|unsubscribe\?t=|pstmrk|alan@ourco\.example|VIPs only/i);
		const feed = await page(feedGET, '/newsletter/feed.xml');
		expect(feed.body).not.toMatch(/\{\{|alan@ourco/);
	});
});

describe('saving and reset', () => {
	it('saving never touches the email columns; reset clears every override', async () => {
		const cid = await campaign({ body_blocks: JSON.stringify([p('Email body')]) });
		const cols = 'subject, preheader, body_blocks, body_md, body_html, status, sent_at';
		const before = await db.prepare(`SELECT ${cols} FROM campaigns WHERE id = ?`).bind(cid).first();
		await save(cid, { title: 'Web title', teaser: 'Web teaser', blocks: [p('Web body')] });
		expect(await db.prepare(`SELECT ${cols} FROM campaigns WHERE id = ?`).bind(cid).first()).toEqual(before);
		const saved = await db.prepare('SELECT archive_title, archive_teaser, archive_blocks, archive_edited_at FROM campaigns WHERE id = ?').bind(cid).first<any>();
		expect(saved.archive_title).toBe('Web title');
		expect(JSON.parse(saved.archive_blocks)[0].content[0].text).toBe('Web body');
		expect(saved.archive_edited_at).toBeTruthy();

		const r = await status(() => editor.reset(event(`/campaign/${cid}/archive?/reset`, { params: { id: String(cid) }, user: admin, fields: [] })));
		expect(r.status).toBe(200);
		expect(await db.prepare('SELECT archive_title, archive_teaser, archive_blocks, archive_edited_at FROM campaigns WHERE id = ?').bind(cid).first()).toEqual({
			archive_title: null,
			archive_teaser: null,
			archive_blocks: null,
			archive_edited_at: null
		});
		expect(await db.prepare(`SELECT ${cols} FROM campaigns WHERE id = ?`).bind(cid).first()).toEqual(before);
	});

	it('validates the lengths and sanitises the blocks', async () => {
		const cid = await campaign();
		expect((await save(cid, { title: 'x'.repeat(201) })).status).toBe(400);
		expect((await save(cid, { teaser: 'x'.repeat(301) })).status).toBe(400);
		expect((await save(cid, { title: 'x'.repeat(200), teaser: 'y'.repeat(300), blocks: [{ type: 'script', html: '<script>' }, img('javascript:alert(1)'), p('ok')] })).status).toBe(200);
		const row = await db.prepare('SELECT archive_blocks FROM campaigns WHERE id = ?').bind(cid).first<{ archive_blocks: string }>();
		expect(row!.archive_blocks).not.toMatch(/script|javascript:/);
	});

	it('the editor seeds from saved blocks, else the email blocks, else the markdown', async () => {
		const md = await campaign();
		const l1 = (await editorLoad(event(`/campaign/${md}/archive`, { params: { id: String(md) }, user: admin }))) as any;
		expect(l1.issue.blocks).toBeNull();
		expect(l1.issue.bodyMd).toContain('Sorry you couldn');
		expect(l1.issue.defaultTeaser).toBe('Email preheader');
		await saveWebVersion(db, md, { title: '', teaser: '', blocks: [p('Saved web')] as any });
		const l2 = (await editorLoad(event(`/campaign/${md}/archive`, { params: { id: String(md) }, user: admin }))) as any;
		expect(l2.issue.blocks[0].content[0].text).toBe('Saved web');
		expect(l2.issue.editedAt).toBeTruthy();
	});
});

describe('raw-HTML template campaigns', () => {
	it('keep the email layout until "Start from blank"; blank blocks replace it', async () => {
		const tpl = await id("INSERT INTO templates (name, kind, html) VALUES ('Raw', 'html', '<html></html>') RETURNING id");
		const cid = await campaign({ template_id: tpl, body_md: '', body_html: '<p>RAW EMAIL LAYOUT</p>' });
		const pub = await publishIssue(db, cid);
		const slug = pub.ok ? pub.slug : '';
		const l = (await editorLoad(event(`/campaign/${cid}/archive`, { params: { id: String(cid) }, user: admin }))) as any;
		expect(l.issue.htmlOnly).toBe(true);
		expect(l.issue.blocks).toBeNull();

		// Title + teaser only: the iframe stays.
		await save(cid, { title: 'Web title', mode: 'original' });
		let body = (await page(issueGET, `/newsletter/${slug}`, { slug })).body;
		expect(body).toContain('Web title');
		expect(body).toContain('<iframe class="nl-frame"');

		// Start from blank: an empty body, no iframe (the page CSS always has a .nl-frame rule).
		await save(cid, { title: 'Web title', mode: 'blocks', blocks: [] });
		body = (await page(issueGET, `/newsletter/${slug}`, { slug })).body;
		expect(body).not.toContain('<iframe');
		expect(body).not.toContain('RAW EMAIL LAYOUT');
		const l2 = (await editorLoad(event(`/campaign/${cid}/archive`, { params: { id: String(cid) }, user: admin }))) as any;
		expect(l2.issue.blank).toBe(true);
	});
});

describe('access', () => {
	it('a member gets 403 on the editor, its actions and the preview', async () => {
		const cid = await campaign();
		const params = { id: String(cid) };
		expect((await status(() => editorLoad(event(`/campaign/${cid}/archive`, { params, user: member })))).status).toBe(403);
		expect((await save(cid, { title: 'x' }, member)).status).toBe(403);
		expect((await status(() => editor.reset(event(`/campaign/${cid}/archive?/reset`, { params, user: member, fields: [] })))).status).toBe(403);
		expect((await status(() => previewGET(event(`/campaign/${cid}/archive/preview`, { params, user: member })))).status).toBe(403);
	});

	it('an automation email or a 1:1 send gets 404', async () => {
		const autoId = await id("INSERT INTO automations (name, status) VALUES ('Nurture', 'active') RETURNING id");
		const step = await campaign({ automation_id: autoId, list: null });
		const direct = await campaign({ list: null });
		for (const cid of [step, direct]) {
			const params = { id: String(cid) };
			expect((await status(() => editorLoad(event(`/campaign/${cid}/archive`, { params, user: admin })))).status).toBe(404);
			expect((await save(cid, { title: 'x' })).status).toBe(404);
			expect((await status(() => previewGET(event(`/campaign/${cid}/archive/preview`, { params, user: admin })))).status).toBe(404);
		}
	});

	it('preview works unpublished and with the archive off, never indexed, and shows unsaved edits', async () => {
		const cid = await campaign();
		await saveArchiveSettings(db, { enabled: false, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] });
		const params = { id: String(cid) };
		const saved = await previewGET(event(`/campaign/${cid}/archive/preview`, { params, user: admin }));
		expect(saved.status).toBe(200);
		expect(saved.headers.get('X-Robots-Tag')).toBe('noindex');
		const html = await saved.text();
		expect(html).toContain('<meta name="robots" content="noindex">');
		expect(html).toContain('Sorry you couldn’t make it');
		const draft = await previewPOST(event(`/campaign/${cid}/archive/preview`, { params, user: admin, fields: saveFields({ title: 'Unsaved title', blocks: [p('Unsaved body')] }) }));
		const dh = await draft.text();
		expect(dh).toContain('Unsaved title');
		expect(dh).toContain('Unsaved body');
		// The preview saved nothing.
		expect((await db.prepare('SELECT archive_edited_at FROM campaigns WHERE id = ?').bind(cid).first<any>()).archive_edited_at).toBeNull();
	});
});

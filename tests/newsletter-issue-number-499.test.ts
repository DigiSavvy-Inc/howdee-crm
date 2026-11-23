import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';

// #499: newsletter archive issue numbers — assigned on first publish, kept on re-publish,
// editable on the archive edit page, shown on the index, issue page, feed and API.
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: vi.fn(), suppress: vi.fn() }));

import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { GET as feedGET } from '../src/routes/newsletter/feed.xml/+server';
import { GET as apiGET } from '../src/routes/api/v1/newsletter/+server';
import { actions as editor, load as editorLoad } from '../src/routes/campaign/[id]/archive/+page.server';
import { actions as campaignsActions } from '../src/routes/campaigns/+page.server';
import { parseIssueNumber, publishIssue, publishedForAdmin, saveArchiveSettings, unpublishIssue } from '../src/lib/server/newsletter-archive';
import { generateApiKey, sha256Hex } from '../src/lib/server/api-keys';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const admin = { id: 1, login: 'ourco-admin', role: 'admin' };

const id = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
const num = async (cid: number) =>
	(await db.prepare('SELECT archive_number AS n FROM campaigns WHERE id = ?').bind(cid).first<{ n: number | null }>())!.n;

function event(path: string, o: { params?: Record<string, string>; user?: unknown; fields?: [string, string][]; headers?: Record<string, string> } = {}) {
	const url = new URL(`https://app.test${path}`);
	let request = new Request(url, { headers: o.headers });
	if (o.fields) {
		const fd = new FormData();
		for (const [k, v] of o.fields) fd.append(k, v);
		request = new Request(url, { method: 'POST', body: fd, headers: { ...o.headers, Origin: 'https://app.test' } });
	}
	return { platform: { env: platformEnv }, params: o.params ?? {}, url, locals: { user: o.user }, request, cookies: { get: () => undefined, set: () => {} } } as any;
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
async function campaign(subject: string, sent_at: string) {
	return id(
		`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at, preheader)
		 VALUES (?, 'Hello there.', '<p>email</p>', ?, 'alan@ourco.example', 'sent', ?, 'Pre') RETURNING id`,
		subject,
		listId,
		sent_at
	);
}

const saveNumber = (cid: number, number: string, extra: [string, string][] = []) =>
	status(() =>
		editor.save(
			event(`/campaign/${cid}/archive?/save`, {
				params: { id: String(cid) },
				user: admin,
				fields: [['number', number], ...extra]
			})
		)
	);

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

describe('auto-assign', () => {
	it('first publish takes MAX + 1; re-publish keeps the number', async () => {
		const a = await campaign('A', '2026-10-01 10:00:00');
		const b = await campaign('B', '2026-10-02 10:00:00');
		await publishIssue(db, a);
		await publishIssue(db, b);
		expect(await num(a)).toBe(1);
		expect(await num(b)).toBe(2);
		expect(await unpublishIssue(db, a)).toBe(true);
		expect(await num(a)).toBe(1);
		await publishIssue(db, a);
		expect(await num(a)).toBe(1);
		const c = await campaign('C', '2026-10-03 10:00:00');
		await publishIssue(db, c);
		expect(await num(c)).toBe(3);
	});

	it('bulk publish numbers in sent order, oldest first', async () => {
		const newest = await campaign('Newest', '2026-10-20 10:00:00');
		const oldest = await campaign('Oldest', '2026-10-01 10:00:00');
		const middle = await campaign('Middle', '2026-10-10 10:00:00');
		const r = await status(() =>
			campaignsActions.archiveBulk(
				event('/campaigns?/archiveBulk', {
					user: admin,
					fields: [['op', 'publish'], ['id', String(newest)], ['id', String(middle)], ['id', String(oldest)]]
				})
			)
		);
		expect(r.value.archiveDone).toMatchObject({ changed: 3, skipped: 0 });
		expect([await num(oldest), await num(middle), await num(newest)]).toEqual([1, 2, 3]);
	});
});

describe('manual edit', () => {
	it('parses blank, positive whole numbers only', () => {
		expect(parseIssueNumber('')).toEqual({ ok: true, number: null });
		expect(parseIssueNumber(' 12 ')).toEqual({ ok: true, number: 12 });
		for (const bad of ['0', '-3', '1.5', 'abc', '1e3']) expect(parseIssueNumber(bad).ok).toBe(false);
	});

	it('saves, validates uniqueness and positivity, blank clears, and a number-only save makes no web version', async () => {
		const a = await campaign('First one', '2026-10-01 10:00:00');
		const b = await campaign('Second one', '2026-10-02 10:00:00');
		await publishIssue(db, a);
		await publishIssue(db, b);

		const loaded: any = await editorLoad(event(`/campaign/${a}/archive`, { params: { id: String(a) }, user: admin }));
		expect(loaded.issue.number).toBe(1);

		const taken = await saveNumber(b, '1', [['web_changed', '0']]);
		expect(taken.status).toBe(400);
		expect(taken.value.data.error).toBe("Issue 1 is already used by 'First one'.");
		expect(await num(b)).toBe(2);

		const zero = await saveNumber(b, '0', [['web_changed', '0']]);
		expect(zero.status).toBe(400);
		expect(zero.value.data.error).toMatch(/positive whole number/);

		expect((await saveNumber(b, '12', [['web_changed', '0']])).status).toBe(200);
		expect(await num(b)).toBe(12);
		const row = await db.prepare('SELECT archive_edited_at FROM campaigns WHERE id = ?').bind(b).first<{ archive_edited_at: string | null }>();
		expect(row!.archive_edited_at).toBeNull();

		expect((await saveNumber(b, '', [['web_changed', '0']])).status).toBe(200);
		expect(await num(b)).toBeNull();

		// The next publish goes after the highest number in use.
		await saveNumber(a, '40', [['web_changed', '0']]);
		const c = await campaign('Third', '2026-10-03 10:00:00');
		await publishIssue(db, c);
		expect(await num(c)).toBe(41);
	});
});

describe('display', () => {
	it('index, issue page, feed, API and the Settings list show the number', async () => {
		const a = await campaign('Numbered issue', '2026-10-01 10:00:00');
		const b = await campaign('Unnumbered issue', '2026-10-02 10:00:00');
		const pa = await publishIssue(db, a);
		const pb = await publishIssue(db, b);
		await saveNumber(a, '12', [['web_changed', '0']]);
		await saveNumber(b, '', [['web_changed', '0']]);

		const index = await page(indexGET, '/newsletter');
		expect(index.body).toMatch(/<time datetime="2026-10-01">Issue 12 · [^<]+<\/time><h3>Numbered issue<\/h3>/);
		expect(index.body).not.toMatch(/Issue \d+ · [^<]+<\/time><h3>Unnumbered issue/);

		const slug = pa.ok ? pa.slug : '';
		const issue = await page(issueGET, `/newsletter/${slug}`, { slug });
		expect(issue.body).toContain('<title>Issue 12 · Numbered issue | Newsletter</title>');
		expect(issue.body).toContain('<span class="nl-num">Issue 12</span>');
		const slugB = pb.ok ? pb.slug : '';
		const plain = await page(issueGET, `/newsletter/${slugB}`, { slug: slugB });
		expect(plain.body).toContain('<title>Unnumbered issue | Newsletter</title>');
		expect(plain.body).not.toContain('nl-num');

		const feed = await page(feedGET, '/newsletter/feed.xml');
		expect(feed.body).toContain('<title>Issue 12 · Numbered issue</title>');
		expect(feed.body).toContain('<title>Unnumbered issue</title>');

		const { token } = await generateApiKey();
		await db.prepare("INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, 'dk', 'x', 'read')").bind(await sha256Hex(token)).run();
		const res = await apiGET(event('/api/v1/newsletter', { headers: { Authorization: `Bearer ${token}` } }));
		const body = (await res.json()) as { data: any[] };
		expect(body.data.find((d) => d.id === a).number).toBe(12);
		expect(body.data.find((d) => d.id === b).number).toBeNull();

		const admin = await publishedForAdmin(db);
		expect(admin.find((r) => r.id === a)!.number).toBe(12);
	});
});

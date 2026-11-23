import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #498: a web template block can be limited to issue pages or the archive list ("Show on").
vi.mock('../src/lib/server/send', () => ({ sendCampaignEmail: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: vi.fn(), suppress: vi.fn() }));

import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { renderBlocksEmailHtml, renderPageBlocks, sanitizeBlocks, type Block } from '../src/lib/blocks';
import { defaultWebTemplateBlocks, publishIssue, renderWebTemplatePreview, saveArchiveSettings } from '../src/lib/server/newsletter-archive';

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };

const p = (text: string, showOn?: unknown) =>
	({ id: crypto.randomUUID(), type: 'paragraph', content: [{ type: 'text', text }], ...(showOn !== undefined ? { showOn } : {}) }) as Block;

describe('sanitiser', () => {
	it('keeps a valid showOn and drops junk', () => {
		const out = sanitizeBlocks([p('a', 'issue'), p('b', 'index'), p('c', 'nope'), p('d', 1), { id: 'c1', type: 'content', showOn: 'issue' }]);
		expect(out.map((b) => b.showOn)).toEqual(['issue', 'index', undefined, undefined, undefined]);
	});
});

describe('renderPageBlocks', () => {
	const doc = (): Block[] =>
		sanitizeBlocks([
			p('ISSUE-TOP', 'issue'),
			p('INDEX-TOP', 'index'),
			p('ALL-TOP'),
			{ id: 's1', type: 'section', bg: '#ffffff', padding: 'md', width: 'inset', blocks: [p('ISSUE-SEC', 'issue'), p('INDEX-SEC', 'index')] },
			{ id: 'c1', type: 'columns', cells: [[p('ISSUE-COL', 'issue')], [p('INDEX-COL', 'index')]] },
			{ id: 's2', type: 'section', bg: '#ffffff', padding: 'md', width: 'inset', showOn: 'issue', blocks: [p('IN-ISSUE-SECTION')] }
		]);

	it("page 'index' leaves out issue-only blocks, top level and nested", () => {
		const html = renderPageBlocks(doc(), undefined, { page: 'index' });
		for (const s of ['INDEX-TOP', 'ALL-TOP', 'INDEX-SEC', 'INDEX-COL']) expect(html).toContain(s);
		for (const s of ['ISSUE-TOP', 'ISSUE-SEC', 'ISSUE-COL', 'IN-ISSUE-SECTION']) expect(html).not.toContain(s);
	});

	it("page 'issue' leaves out archive-list-only blocks", () => {
		const html = renderPageBlocks(doc(), undefined, { page: 'issue' });
		for (const s of ['ISSUE-TOP', 'ALL-TOP', 'ISSUE-SEC', 'ISSUE-COL', 'IN-ISSUE-SECTION']) expect(html).toContain(s);
		for (const s of ['INDEX-TOP', 'INDEX-SEC', 'INDEX-COL']) expect(html).not.toContain(s);
	});

	it('no option renders everything', () => {
		const html = renderPageBlocks(doc());
		for (const s of ['ISSUE-TOP', 'INDEX-TOP', 'ALL-TOP', 'ISSUE-SEC', 'INDEX-SEC', 'ISSUE-COL', 'INDEX-COL', 'IN-ISSUE-SECTION']) expect(html).toContain(s);
	});

	it('email rendering ignores showOn', () => {
		const html = renderBlocksEmailHtml(doc());
		for (const s of ['ISSUE-TOP', 'INDEX-TOP', 'ISSUE-SEC', 'INDEX-COL']) expect(html).toContain(s);
		const plain = p('X');
		expect(renderBlocksEmailHtml([{ ...plain, showOn: 'issue' }])).toBe(renderBlocksEmailHtml([plain]));
	});
});

describe('newsletter archive pages', () => {
	const id = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
	const event = (path: string, params: Record<string, string> = {}) => {
		const url = new URL(`https://app.test${path}`);
		return { platform: { env: platformEnv }, params, url, locals: {}, request: new Request(url) } as any;
	};

	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM campaign_audiences'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare('DELETE FROM lists'),
			db.prepare("DELETE FROM templates WHERE kind = 'web'"),
			db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%'")
		]);
	});

	async function setup(blocks: unknown[]) {
		const listId = await id("INSERT INTO lists (name, kind) VALUES ('Members', 'list') RETURNING id");
		const tid = await id("INSERT INTO templates (name, kind, blocks) VALUES ('Web', 'web', ?) RETURNING id", JSON.stringify(blocks));
		expect(
			await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: tid, indexable: true, autoGroups: [] })
		).toBeNull();
		const cid = await id(
			`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at)
			 VALUES ('Event recap', 'Hello there.', '<p>x</p>', ?, 'alan@ourco.example', 'sent', '2026-10-14 15:00:00') RETURNING id`,
			listId
		);
		const pub = await publishIssue(db, cid);
		return pub.ok ? pub.slug : '';
	}

	it('the archive list lacks the issue-only block and the issue page has it', async () => {
		const slug = await setup([p('BACK-LINK', 'issue'), p('BIG-INTRO', 'index'), { id: 'c', type: 'content' }, p('FOOTER-ALL')]);
		const index = await (await indexGET(event('/newsletter'))).text();
		expect(index).not.toContain('BACK-LINK');
		expect(index).toContain('BIG-INTRO');
		expect(index).toContain('FOOTER-ALL');
		const issue = await (await issueGET(event(`/newsletter/${slug}`, { slug }))).text();
		expect(issue).toContain('BACK-LINK');
		expect(issue).not.toContain('BIG-INTRO');
		expect(issue).toContain('FOOTER-ALL');
	});

	it('the template preview renders as an issue page', () => {
		const html = renderWebTemplatePreview([p('BACK-LINK', 'issue'), p('BIG-INTRO', 'index'), { id: 'c', type: 'content' } as Block], {});
		expect(html).toContain('BACK-LINK');
		expect(html).not.toContain('BIG-INTRO');
	});

	it('the default template limits "← All newsletters" to issue pages', () => {
		const blocks = defaultWebTemplateBlocks({ logoUrl: 'https://app.test/logo.png', logoAlt: 'Logo', mailingAddress: null, archiveUrl: 'https://app.test/newsletter' });
		const back = blocks.find((b) => b.type === 'paragraph' && JSON.stringify(b).includes('All newsletters'));
		expect(back?.showOn).toBe('issue');
	});
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { issueTeaser, publishIssue, renderWebTemplatePreview, saveArchiveSettings, scrubPublicHtml } from '../src/lib/server/newsletter-archive';
import { PAGE_TOC_CSS, type Block } from '../src/lib/blocks';
import { TOOLS, runTool } from '../src/lib/server/ai/tools';
import type { ToolContext } from '../src/lib/server/ai/tools/types';
import { BODY_PROPS, blocksArg, sectionList } from '../src/lib/server/ai/tools/draft-body';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';
import help from '../src/lib/components/HelpPanel.svelte?raw';

// #560: the CRM side of the table of contents block (package 0.3.0). The package tests its
// renderers; these cover the archive's own document (it embeds PAGE_CSS itself, so it must
// add PAGE_TOC_CSS) and the assistant's body tools.

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), SESSION_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' };
const t = (text: string) => [{ type: 'text', text }];
const h = (id: string, text: string, level = 2) => ({ id, type: 'heading', level, content: t(text) }) as Block;
const p = (id: string, text: string) => ({ id, type: 'paragraph', content: t(text) }) as Block;
const TOC = { id: 'toc', type: 'toc', levels: [2], title: 'In this issue' } as Block;
const TOC_RULE = '.b-toc {';

describe('newsletter archive pages', () => {
	it('a web template with a toc gets the toc CSS and heading anchors', () => {
		const html = renderWebTemplatePreview([TOC, h('a', 'Getting started'), h('b', 'Next steps'), { id: 'c', type: 'content' } as Block], {});
		expect(html).toContain(PAGE_TOC_CSS);
		expect(html).toContain('<nav class="b-toc" aria-label="Table of contents"><p class="b-toc-title">In this issue</p>');
		expect(html).toContain('<a href="#getting-started">Getting started</a>');
		expect(html).toContain('<h2 id="getting-started">Getting started</h2>');
		expect(html).toContain('<h2 id="next-steps">Next steps</h2>');
		expect(html.indexOf('.b-toc {')).toBeGreaterThan(html.indexOf('.page {')); // after PAGE_CSS
	});

	it('without a toc the page is unchanged: no toc CSS, no heading ids', () => {
		const html = renderWebTemplatePreview([h('a', 'Getting started'), { id: 'c', type: 'content' } as Block], {});
		expect(html).not.toContain(TOC_RULE);
		expect(html).toContain('<h2>Getting started</h2>');
	});

	describe('issue page', () => {
		let listId: number;
		const get = async (slug: string) => {
			const url = new URL(`https://app.test/newsletter/${slug}`);
			try {
				const res = await issueGET({ platform: { env: platformEnv }, params: { slug }, url, locals: {}, request: new Request(url) } as any);
				return { status: res.status, body: await res.text() };
			} catch (err) {
				if (isHttpError(err)) return { status: err.status, body: '' };
				throw err;
			}
		};
		const publish = async (subject: string, blocks: Block[]) => {
			const row = await db
				.prepare(
					`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, list_id, from_email, status, sent_at, preheader)
					 VALUES (?, 'x', ?, '<p>email</p>', ?, 'alan@ourco.example', 'sent', '2026-11-10 15:00:00', 'Teaser') RETURNING id`
				)
				.bind(subject, JSON.stringify(blocks), listId)
				.first<{ id: number }>();
			const r = await publishIssue(db, row!.id);
			expect(r.ok).toBe(true);
			return r.ok ? r.slug : '';
		};

		beforeEach(async () => {
			await db.batch([
				db.prepare('DELETE FROM campaigns'),
				db.prepare('DELETE FROM lists'),
				db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%'")
			]);
			listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Readers', 'list') RETURNING id").first<{ id: number }>())!.id;
			expect(
				await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] })
			).toBeNull();
		});

		it("lists the issue's headings with working anchors and the toc CSS", async () => {
			const slug = await publish('With contents', [TOC, h('a', 'Hello {{first_name}}'), p('x', 'Body'), h('b', 'The news')]);
			const { status, body } = await get(slug);
			expect(status).toBe(200);
			expect(body).toContain(PAGE_TOC_CSS);
			expect(body).toContain('<h2 id="hello">Hello there</h2>');
			expect(body).toContain('<a href="#hello">Hello there</a>');
			expect(body).toContain('<a href="#the-news">The news</a>');
			expect(body).toContain('<h2 id="the-news">The news</h2>');
		});

		it('an issue without a toc renders as before', async () => {
			const slug = await publish('Plain', [h('a', 'The news'), p('x', 'Body')]);
			const { status, body } = await get(slug);
			expect(status).toBe(200);
			expect(body).not.toContain(TOC_RULE);
			expect(body).toContain('<h2>The news</h2>');
		});

		it('keeps toc entries whose slug reads like a private link (preferences, unsubscribe)', async () => {
			const slug = await publish('Housekeeping', [TOC, h('a', 'Manage preferences'), p('x', 'Body'), h('b', 'How to unsubscribe')]);
			const { status, body } = await get(slug);
			expect(status).toBe(200);
			expect(body).toContain('<a href="#manage-preferences">Manage preferences</a>');
			expect(body).toContain('<a href="#how-to-unsubscribe">How to unsubscribe</a>');
			expect(body).toContain('<h2 id="manage-preferences">Manage preferences</h2>');
			expect(body).toContain('<h2 id="how-to-unsubscribe">How to unsubscribe</h2>');
		});
	});
});

describe('private-link scrub and in-page fragments', () => {
	it('still removes private links, including ones with a fragment after a path', () => {
		const drop = [
			'<a href="https://example.com/unsubscribe">Leave</a>',
			'<a href="/preferences#top">Prefs</a>',
			"<a href='%%UNSUB_URL%%'>Unsub</a>",
			'<a href="https://pstmrk.it/3abc">Tracked</a>',
			'<a href="https://x.test/unsubscribe#a">Frag after path</a>',
			'<a class="x" href = "mailto:unsubscribe@example.com">Mail</a>'
		];
		for (const a of drop) expect(scrubPublicHtml(`<p>${a}</p>`, null)).toBe('<p></p>');
		expect(scrubPublicHtml('<p><a href="/preferences">Open', null)).toBe('<p><a>Open');
	});

	it('keeps links that are only an in-page fragment, in either quote style', () => {
		for (const a of ['<a href="#manage-preferences">Manage preferences</a>', "<a href='#how-to-unsubscribe'>How to unsubscribe</a>", '<a href=" #manage-preferences">x</a>']) {
			expect(scrubPublicHtml(`<p>${a}</p>`, null)).toBe(`<p>${a}</p>`);
		}
	});

	it('the teaser keeps fragment-link text and still drops private-link text', () => {
		const md = (body: string) => issueTeaser({ body_blocks: null, body_md: body, from_email: null, template_kind: null } as any);
		expect(md('See [Manage preferences](#manage-preferences) below.')).toBe('See Manage preferences below.');
		expect(md('See [Manage preferences](https://x.test/preferences) below.')).toBe('See below.');
		const blocks = JSON.stringify([
			{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Jump to ' }, { type: 'text', text: 'Unsubscribe help', marks: [{ type: 'link', href: '#unsubscribe-help' }] }] }
		]);
		expect(issueTeaser({ body_blocks: blocks, body_md: '', from_email: null, template_kind: null } as any)).toBe('Jump to Unsubscribe help');
	});
});

describe('assistant body tools', () => {
	it('tell the model about the toc block and that its list is automatic', () => {
		expect(BODY_PROPS.body_blocks.description).toContain("type: 'toc', levels: [2]");
		expect(BODY_PROPS.body_blocks.description).toMatch(/built automatically/);
	});

	it('sanitise a toc block: levels cleaned, title trimmed, unknown keys dropped', () => {
		const blocks = blocksArg({ body_blocks: [{ type: 'toc', levels: [3, 2, 9], title: '  In  this email ', entries: ['x'] }, h('a', 'One')] })!;
		expect(blocks[0]).toMatchObject({ type: 'toc', levels: [2, 3], title: 'In this email' });
		expect(blocks[0]).not.toHaveProperty('entries');
	});

	it('a toc alone is empty as a whole body but content as an inserted part', () => {
		expect(() => blocksArg({ body_blocks: [{ type: 'toc', levels: [2] }] })).toThrow(/empty/);
		expect(blocksArg({ body_blocks: [{ type: 'toc', levels: [2] }] }, { part: true })).toHaveLength(1);
		expect(() => blocksArg({ body_blocks: [{ type: 'spacer' }] }, { part: true })).toThrow(/empty/);
	});

	it('get_draft_sections describes a toc instead of an empty line', () => {
		const [row] = sectionList([{ id: 't', type: 'toc', levels: [2, 3], title: 'Contents' } as Block]);
		expect(row).toMatchObject({ index: 0, type: 'toc' });
		expect(row.text).toBe('Table of contents “Contents”: jump links to the H2, H3 headings, built automatically');
	});

	describe('on a real draft', () => {
		let ctx: ToolContext;
		beforeAll(async () => {
			const login = `toc560-${Date.now()}`;
			const uid = (await db.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`).bind(login).first<{ id: number }>())!.id;
			const user = { id: uid, github_login: login, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
			const threadId = await createThread(db, uid, modelInfo('claude-sonnet-5-5')!.id, 'medium', 'test');
			ctx = { db, user, baseUrl: 'https://app.test', now: new Date(), threadId };
		});

		it('rewrite_draft_section inserts a toc that lists the draft headings in the email', async () => {
			const made = await runTool(ctx, 'create_campaign_draft', { subject: 'Toc draft', body_markdown: 'Hi there.\n\n## First part\n\nText.\n\n## Second part\n\nMore.' }, TOOLS, 'tu_1');
			expect(made.ok).toBe(true);
			const id = JSON.parse(made.content).campaign_id as number;
			const r = await runTool(ctx, 'rewrite_draft_section', { campaign_id: id, start: 1, end: 1, body_blocks: [{ type: 'toc', levels: [2], title: 'Inside' }] }, TOOLS, 'tu_2');
			expect(r.ok).toBe(true);
			const c = (await db.prepare('SELECT status, body_blocks, body_html, body_md FROM campaigns WHERE id = ?').bind(id).first<any>())!;
			expect(c.status).toBe('draft');
			const stored = JSON.parse(c.body_blocks) as Block[];
			expect(stored[1]).toMatchObject({ type: 'toc', levels: [2], title: 'Inside' });
			expect(c.body_html).toContain('href="#first-part"');
			expect(c.body_html).toContain('name="second-part"');
			expect(c.body_md).toContain('- [First part](#first-part)');

			const read = await runTool(ctx, 'get_draft_sections', { campaign_id: id }, TOOLS, 'tu_3');
			expect(JSON.parse(read.content).sections[1]).toMatchObject({ type: 'toc', text: expect.stringContaining('Table of contents “Inside”') });
		});
	});
});

describe('help', () => {
	it('explains the table of contents block', () => {
		expect(help).toMatch(/<strong>Table of contents:<\/strong> type <code>\/<\/code>/);
		expect(help).toMatch(/only in some mail clients/);
	});
});

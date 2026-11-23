import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// #531: hosted pages and the assistant's Markdown must never emit live HTML from text.
import { GET as publicGET } from '../src/routes/p/[slug]/+server';
import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { renderBlocksEmailHtml, renderPageBlocks, renderPageHtml, type Block } from '../src/lib/blocks';
import { parseMarkdownPreservingMergeTags, parseMarkdownSafe } from '../src/lib/merge-tags';
import { renderAssistantMarkdown } from '../src/lib/assistant-markdown';
import { issueContentHtml, publishIssue, saveArchiveSettings } from '../src/lib/server/newsletter-archive';
import { PUBLIC_PAGE_CSP } from '../src/lib/server/public-csp';

const db = (env as any).DB as D1Database;
const ev = (slug: string) => ({ platform: { env }, params: { slug }, url: new URL(`https://app.test/p/${slug}`), request: new Request(`https://app.test/p/${slug}`) }) as any;
const textBlock = (md: string) => [{ id: 'a', type: 'text', md }] as unknown as Block[];

/** A live element / attribute an attacker could use: a real tag (not `&lt;img`). */
const LIVE = /<(img|script|iframe|svg|a)\b[^>]*(onerror|onload|javascript:)/i;

describe('hosted pages (#531): legacy text blocks', () => {
	it('escapes raw HTML in a text block (the reported payload)', () => {
		const html = renderPageHtml('T', textBlock('<img src=x onerror=alert(1)>'));
		expect(html).not.toMatch(LIVE);
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	it('escapes block HTML, inline tags and the <code> raw-block trick', () => {
		for (const md of [
			'<script>alert(1)</script>',
			'<div onclick="x()">hi</div>',
			'hello <code>x<img src=x onerror=alert(1)//',
			'a <svg onload=alert(1)> b',
			'<iframe src="javascript:alert(1)"></iframe>'
		]) {
			const html = renderPageBlocks(textBlock(md));
			expect(html, md).not.toMatch(LIVE);
			expect(html, md).not.toMatch(/<(script|div onclick|svg|iframe|img)\b/i);
		}
	});

	it('drops javascript: and data: link / image targets, keeps safe ones', () => {
		const html = renderPageBlocks(
			textBlock('[a](javascript:alert(1)) [b](JaVa\tScRiPt:alert(1)) [c](data:text/html,x) ![d](javascript:x) [ok](https://x.test/p?a=1&b=2) [mail](mailto:a@b.example.net) [rel](/p/other)')
		);
		expect(html).not.toMatch(/javascript:|data:text/i);
		expect(html).toContain('<a href="https://x.test/p?a=1&amp;b=2">ok</a>');
		expect(html).toContain('<a href="mailto:a@b.example.net">mail</a>');
		expect(html).toContain('<a href="/p/other">rel</a>');
	});

	it('keeps merge tags as inert text, even ones holding quotes or <', () => {
		const html = renderPageBlocks(textBlock('Hi {{first_name}} {{#if field:x == "<img src=y onerror=z>"}}A{{/if}} [r]({{field:report_url}})'));
		expect(html).toContain('Hi {{first_name}}');
		expect(html).toContain('href="{{field:report_url}}"');
		expect(html).not.toMatch(LIVE);
		expect(html).toContain('{{#if field:x == &quot;&lt;img src=y onerror=z&gt;&quot;}}');
	});

	it('renders normal Markdown, merge tags and code blocks the same as before', () => {
		for (const md of [
			'Some **bold** and _em_ text with {{first_name}}',
			'## Title\n\n- one\n- two\n\n1. a\n2. b',
			'> quote\n\nline one\nline two',
			'Use `a < b` inline.\n\n```js\nconst a = 1 < 2 && "x";\n```',
			'[link](https://x.test/a) and ![img](https://x.test/i.png "T")',
			'Tom &amp; Jerry & friends &copy; 2026',
			'| a | b |\n| - | - |\n| 1 | 2 |'
		]) {
			expect(parseMarkdownSafe(md), md).toBe(parseMarkdownPreservingMergeTags(md));
		}
	});

	it('leaves the email rendering of the same block as it is', () => {
		const md = 'Hi **there** {{first_name}}';
		expect(renderBlocksEmailHtml(textBlock(md))).toContain(parseMarkdownPreservingMergeTags(md));
	});

	it('/p/[slug] sends a CSP and nosniff, and escapes the payload', async () => {
		await db
			.prepare("INSERT INTO pages (slug, title, blocks, published) VALUES ('xss-531', 'X', ?, 1)")
			.bind(JSON.stringify(textBlock('<img src=x onerror=alert(1)>')))
			.run();
		const res = await publicGET(ev('xss-531'));
		const csp = res.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toBe(PUBLIC_PAGE_CSP);
		expect(csp).not.toContain('frame-ancestors');
		expect(csp).toContain("script-src 'none'");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("style-src 'unsafe-inline'");
		expect(csp).toContain("frame-src 'self'");
		expect(csp).toContain("form-action 'self'");
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		const html = await res.text();
		expect(html).not.toMatch(LIVE);
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});
});

describe('assistant markdown (#531): text after a raw inline tag', () => {
	const r = (md: string) => renderAssistantMarkdown(md, ['https://crm.example.com']);

	it('escapes the reported payload', () => {
		const html = r('hello <code>x<img src=x onerror=alert(1)//');
		expect(html).not.toMatch(LIVE);
		expect(html).not.toContain('<img');
	});

	it('escapes text after <pre>, <kbd> and <script> too', () => {
		for (const tag of ['pre', 'kbd', 'script']) {
			const html = r(`hi <${tag}>x<img src=x onerror=alert(1)// and <b>bold</b>`);
			expect(html, tag).not.toMatch(LIVE);
			expect(html, tag).not.toMatch(/<(img|b|pre|kbd|script)\b/);
		}
	});

	it('normal text still renders (entities, escapes, code)', () => {
		expect(r('a \\*b\\* & c')).toContain('a *b* &amp; c');
		expect(r('`a < b`')).toContain('<code>a &lt; b</code>');
		expect(r('\\<b> stays text')).toContain('&lt;b&gt; stays text');
	});
});

// ---------------------------------------------------------------------------
// Newsletter archive (#531 follow-up): the markdown path, `{{…}}` leftovers, fallbacks
// ---------------------------------------------------------------------------

type IssueInput = Parameters<typeof issueContentHtml>[0];
const issue = (o: Partial<IssueInput>): string =>
	issueContentHtml({ body_blocks: null, body_md: null, body_html: null, from_email: null, template_kind: null, ...o });
const asText = (md: string) => issue({ body_blocks: JSON.stringify(textBlock(md)) });
const asMarkdown = (md: string) => issue({ body_md: md });
const asParagraph = (text: string) => issue({ body_blocks: JSON.stringify([{ id: 'p', type: 'paragraph', content: [{ type: 'text', text }] }]) });
const PATHS = { text: asText, markdown: asMarkdown, paragraph: asParagraph };

/** Live markup as a browser would read it: every tag with its attributes (quoted values kept
 *  whole) → a script-ish element, an `on…` attribute, or a javascript: href / src. */
function liveMarkup(html: string): string | null {
	const tag = /<([a-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/gi;
	const attr = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
	for (const m of html.matchAll(tag)) {
		if (/^(script|svg|iframe|object|embed|math|form)$/i.test(m[1])) return m[0];
		for (const a of m[2].matchAll(attr)) {
			const value = (a[2] ?? '').replace(/^["']|["']$/g, '');
			if (/^on/i.test(a[1]) || (/^(href|src)$/i.test(a[1]) && /^\s*javascript:/i.test(value))) return m[0];
		}
	}
	return null;
}
const LIVE_ANY = { [Symbol.match]: (s: string) => liveMarkup(s) } as unknown as RegExp;

describe('newsletter archive (#531): issue content', () => {
	const payloads = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', 'a <svg onload=alert(1)> b', '[x](javascript:alert(1))'];

	it('markdown and legacy text-block issues show raw HTML as text and drop script links', () => {
		for (const render of [asMarkdown, asText]) {
			for (const p of payloads) {
				const html = render(p);
				expect(html, p).not.toMatch(LIVE_ANY);
				expect(html, p).not.toMatch(/javascript:/i);
			}
			expect(render('<img src=x onerror=alert(1)>')).toContain('&lt;img src=x onerror=alert(1)&gt;');
		}
	});

	it('the shapes the token shield matches leave no live markup (text block, markdown, paragraph)', () => {
		const shapes = [
			'{{#if tag "<img src=x onerror=alert(1)>"}}x{{/if}}', // #if with a payload, matched
			'{{#if <img src=x onerror=alert(1)> {{first_name}}', // its `}}` shared with a merge tag
			'a {{#if "<svg onload=alert(1)>" b', // unclosed
			'{{company.name|<img src=x onerror=alert(1)>}}', // company fallback payload
			'![{{company.name|x" onerror="alert(1)" src="y}}{{first_name}}](https://i.test/a.png)'
		];
		for (const [name, render] of Object.entries(PATHS)) {
			for (const s of shapes) expect(render(s), `${name}: ${s}`).not.toMatch(LIVE_ANY);
		}
		// The malformed #if stays visible, as text.
		expect(asText('{{#if tag "<img src=x onerror=alert(1)>"}}x{{/if}}')).toContain('{{#if tag &quot;&lt;img src=x onerror=alert(1)&gt;&quot;}}x{{/if}}');
		expect(asParagraph('{{#if <img src=x onerror=alert(1)> {{first_name}}')).toContain('{{#if &lt;img src=x onerror=alert(1)&gt; {{first_name}}');
		expect(asText('{{company.name|<img src=x onerror=alert(1)>}}')).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	it('a #if inside a link target cannot break out of the attribute', () => {
		for (const md of [
			'[x](<{{#if a " onclick="alert(1)}}>)',
			'[x](</x/{{first_name}}/{{#if a " onclick="alert(1)}}>)', // the merge pass rewrites the href to #
			'[x](%7B%7B%23if%20%22%20onmouseover%3D%22alert%281%29%7D%7D)', // percent-encoded token
			'[x](%7B%7B%23if%20%22%7D%20onmouseover%3D%22alert%281%29%7D%7D)', // with a single `}`
			'[x]({{first_name}}%7B%7B%23if%20%22%20onmouseover%3D%22alert%281%29%7D%7D)',
			'[l]({{company.url|javascript:alert(1)}})'
		]) {
			for (const render of [asText, asMarkdown]) {
				const html = render(md);
				expect(html, md).not.toMatch(LIVE_ANY);
				expect(html, md).not.toMatch(/javascript:/i);
			}
		}
	});

	it('fallbacks are escaped exactly once; merge tags and valid conditionals still work', () => {
		for (const render of [asText, asMarkdown, asParagraph]) {
			expect(render('Team: {{company.name|"your team"}}')).toContain('Team: &quot;your team&quot;');
			expect(render('By {{company.name|Smith & Co}}')).toContain('By Smith &amp; Co');
			expect(render('Hi {{first_name}}')).toContain('Hi there');
			expect(render('{{#if field:plan == "pro"}}pro{{/if}}tail')).toMatch(/>tail</);
		}
		expect(asMarkdown('{{#if !tag:vip}}public{{else}}vip{{/if}} {{#if field:n > 5}}big{{/if}}end')).toContain('public end');
		// A malformed #if nested in a valid one keeps the structure: the hidden branch stays hidden.
		expect(asMarkdown('{{#if tag:vip}}secret {{#if bad "x"}}x{{/if}} more{{/if}}after')).toBe('<p>after</p>\n');
	});
});

describe('simple formatting tags (#531)', () => {
	it('keeps br / b / em … as rebuilt tags, escapes anything with attributes', () => {
		const html = parseMarkdownSafe('line<br>two <b>bold</b> <em>e</em> <br/> </br> <br onclick=alert(1)> <b style="color:red">s</b> <span>t</span>');
		expect(html).toContain('line<br>two <b>bold</b> <em>e</em> <br> <br>');
		expect(html).toContain('&lt;br onclick=alert(1)&gt;');
		expect(html).toContain('&lt;b style=&quot;color:red&quot;&gt;');
		expect(html).toContain('&lt;span&gt;t&lt;/span&gt;');
		expect(html).not.toMatch(/<(span|br onclick|b style)/);
		expect(parseMarkdownSafe('a\n\n<hr>\n\nb')).toContain('<hr>');
	});

	it('the same on a hosted page and on the archive', () => {
		const md = 'line<br>two <br onclick=alert(1)> <b style="x">s</b> <span>t</span>';
		for (const html of [renderPageHtml('T', textBlock(md)), asText(md), asMarkdown(md)]) {
			expect(html).toContain('line<br>two');
			expect(html).toContain('&lt;br onclick=alert(1)&gt;');
			expect(html).toContain('&lt;span&gt;');
			expect(html).not.toMatch(/<(span|br onclick|b style)/);
		}
	});

	it('email rendering is unchanged: raw HTML passes through', () => {
		expect(parseMarkdownPreservingMergeTags('a <b>x</b> <img src=x>')).toBe('<p>a <b>x</b> <img src=x></p>\n');
	});
});

describe('newsletter routes (#531): CSP + nosniff', () => {
	const archiveEvent = (path: string, params: Record<string, string> = {}) => {
		const url = new URL(`https://app.test${path}`);
		return { platform: { env: { ...(env as any), PUBLIC_BASE_URL: 'https://app.test' } }, params, url, locals: {}, request: new Request(url) } as any;
	};

	it('/newsletter and /newsletter/[slug] send the shared policy and nosniff', async () => {
		expect(
			await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] })
		).toBeNull();
		const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('CSP 531', 'list') RETURNING id").first<{ id: number }>())!.id;
		const c = (await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at) VALUES ('CSP issue', '<img src=x onerror=alert(1)>', '', ?, 'a@b.example.net', 'sent', '2026-10-14 15:00:00') RETURNING id`
			)
			.bind(list)
			.first<{ id: number }>())!.id;
		const pub = await publishIssue(db, c);
		expect(pub.ok).toBe(true);
		const slug = pub.ok ? pub.slug : '';
		for (const res of [await indexGET(archiveEvent('/newsletter')), await issueGET(archiveEvent(`/newsletter/${slug}`, { slug }))]) {
			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Security-Policy')).toBe(PUBLIC_PAGE_CSP);
			expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
			const html = await res.text();
			expect(html).not.toMatch(/<script\b/i);
			expect(html).not.toMatch(LIVE_ANY);
		}
	});
});

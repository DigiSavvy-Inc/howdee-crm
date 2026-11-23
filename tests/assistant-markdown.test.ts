import { describe, it, expect } from 'vitest';
import { renderAssistantMarkdown, safeLink, isNumericColumn } from '../src/lib/assistant-markdown';
import { TOOL_LABELS, toolGroupLabel, toolLabel } from '../src/lib/assistant-view';
import { TOOLS } from '../src/lib/server/ai/tools';

const APP = ['https://crm.example.com'];
const r = (md: string) => renderAssistantMarkdown(md, APP);

describe('assistant markdown (#300): formatting', () => {
	it('renders bold, italic, inline code and paragraphs', () => {
		const html = r('**Opens** went *up* by `12`.\n\nSecond paragraph.');
		expect(html).toContain('<strong>Opens</strong>');
		expect(html).toContain('<em>up</em>');
		expect(html).toContain('<code>12</code>');
		expect(html.match(/<p>/g)?.length).toBe(2);
	});

	it('renders bullet and numbered lists', () => {
		const html = r('- one\n- two\n\n1. first\n2. second');
		expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
		expect(html).toMatch(/<ol>\s*<li>first<\/li>/);
	});

	it('maps h1–h3 to one modest heading', () => {
		const html = r('# Big\n\n## Medium\n\n### Small\n\n#### Tiny');
		expect(html.match(/<h3>/g)?.length).toBe(3);
		expect(html).toContain('<h4>Tiny</h4>');
		expect(html).not.toMatch(/<h[12]>/);
	});

	it('renders a GFM table in a scroll wrapper with numeric columns right-aligned', () => {
		const html = r('| Campaign | Sent | Open rate |\n|---|---|---|\n| Spring | 1,204 | 42.5% |\n| Fall | 980 | — |');
		expect(html).toContain('<div class="md-table"><table>');
		expect(html).toContain('<th>Campaign</th>');
		expect(html).toContain('<th class="md-right">Sent</th>');
		expect(html).toContain('<td class="md-right">42.5%</td>');
		expect(html).toContain('<td>Spring</td>');
	});

	it('keeps an explicit column alignment', () => {
		expect(r('| a | b |\n|:-:|---|\n| x | 1 |')).toContain('<td class="md-center">x</td>');
	});

	it('renders blockquotes, rules and code blocks', () => {
		const html = r('> quoted\n\n---\n\n```js\nconst a = 1 < 2;\n```');
		expect(html).toContain('<blockquote>');
		expect(html).toContain('<hr>');
		expect(html).toContain('<pre><code>const a = 1 &lt; 2;</code></pre>');
	});

	it('returns an empty string for empty text', () => {
		expect(r('')).toBe('');
	});
});

describe('assistant markdown (#300): links', () => {
	it('marks app-relative links as in-app (no new tab)', () => {
		const html = r('See [Spring launch](/campaign/47).');
		expect(html).toContain('<a href="/campaign/47" data-app-link>Spring launch</a>');
		expect(html).not.toContain('target=');
	});

	it('turns absolute URLs on the app origin into in-app paths', () => {
		expect(r('[Ann](https://crm.example.com/contacts/12?tab=1)')).toContain('<a href="/contacts/12?tab=1" data-app-link>Ann</a>');
	});

	it('opens external links in a new tab with noopener noreferrer', () => {
		const html = r('[Postmark](https://postmarkapp.com/docs)');
		expect(html).toContain('href="https://postmarkapp.com/docs"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).not.toContain('data-app-link');
	});

	it('classifies hrefs', () => {
		expect(safeLink('/campaign/1')).toEqual({ href: '/campaign/1', internal: true });
		expect(safeLink('campaign/1')).toEqual({ href: '/campaign/1', internal: true });
		expect(safeLink('https://x.test/a')).toEqual({ href: 'https://x.test/a', internal: false });
		expect(safeLink('//evil.test/a')).toBeNull();
		expect(safeLink('/\\evil.test')).toBeNull();
		expect(safeLink('mailto:a@b.example.net')).toBeNull();
		expect(safeLink(' java\tscript:alert(1)')).toBeNull();
	});
});

describe('assistant markdown (#300): XSS', () => {
	it('escapes <script> blocks', () => {
		const html = r('<script>alert(1)</script>');
		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	it('escapes inline <img onerror>', () => {
		const html = r('Hi <img src=x onerror="alert(1)"> there');
		expect(html).not.toMatch(/<img/i);
		expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
	});

	it('renders javascript: and data: links as plain text', () => {
		for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
			const html = r(`[click me](${href})`);
			expect(html).not.toContain('<a');
			expect(html).toContain('click me');
			expect(html.toLowerCase()).not.toContain('href="javascript');
			expect(html.toLowerCase()).not.toContain('href="data');
		}
	});

	it('never emits an executable href from entity tricks or autolinks', () => {
		const html = r('[x](java&#115;cript:alert(1)) <javascript:alert(1)> foo@bar.example.net');
		expect(html.toLowerCase()).not.toMatch(/href="\s*(javascript|data|mailto):/);
	});

	it('does not render images — the alt text becomes a link or plain text', () => {
		expect(r('![chart](https://cdn.test/c.png)')).toBe('<p><a href="https://cdn.test/c.png" target="_blank" rel="noopener noreferrer">chart</a></p>\n');
		const bad = r('![x" onerror="alert(1)](javascript:alert(1))');
		expect(bad).not.toMatch(/<img|<a/);
	});

	it('escapes HTML inside table cells', () => {
		const html = r('| Name | Opens |\n|---|---|\n| <img src=x onerror=alert(1)> | 3 |\n| <b onclick="x()">Bo</b> | 4 |');
		expect(html).not.toMatch(/<img|<b /);
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).toContain('&lt;b onclick=&quot;x()&quot;&gt;');
	});

	it('escapes quotes in link titles', () => {
		const html = r('[a](https://x.test "t\\" onmouseover=\\"alert(1)")');
		expect(html).not.toMatch(/" onmouseover="/);
	});
});

describe('assistant markdown (#300): streaming', () => {
	it('does not throw on partial tables or fences', () => {
		const full = '| Campaign | Sent |\n|---|---|\n| Spring | 12 |\n\n```\ncode <b>\n```\n\n**done** [link](/campaign/4';
		for (let i = 0; i <= full.length; i++) {
			const out = renderAssistantMarkdown(full.slice(0, i), APP);
			expect(out).not.toContain('<b>');
		}
	});

	it('renders an unfinished fence as code', () => {
		expect(r('```\nunfinished <b>')).toContain('<pre><code>unfinished &lt;b&gt;</code></pre>');
	});
});

describe('isNumericColumn', () => {
	it('detects numbers, percents, money and blanks', () => {
		expect(isNumericColumn(['1,204', '42.5%', '$1,000', '—', ''])).toBe(true);
		expect(isNumericColumn(['12', 'Spring'])).toBe(false);
		expect(isNumericColumn(['', '—'])).toBe(false);
	});
});

describe('tool labels (#300)', () => {
	it('maps tool names to plain labels', () => {
		expect(toolLabel('list_campaigns')).toBe('Looked up campaigns');
		expect(toolLabel('get_campaign_engagement')).toBe('Checked engagement');
		expect(toolLabel('some_new_tool')).toBe('Used some new tool');
	});

	it('has a label for every read tool', () => {
		const missing = TOOLS.filter((t) => t.tier === 'read' && !TOOL_LABELS[t.name]).map((t) => t.name);
		expect(missing).toEqual([]);
	});

	it('has a label for every write tool (#301)', () => {
		// Derived from the registry: every write/approve tool must carry a label, however many exist.
		const writes = TOOLS.filter((t) => t.tier === 'write' || t.tier === 'approve');
		expect(writes.length).toBeGreaterThan(0);
		expect(TOOLS.every((t) => ['read', 'write', 'approve'].includes(t.tier))).toBe(true);
		expect(writes.filter((t) => !TOOL_LABELS[t.name]).map((t) => t.name)).toEqual([]);
		expect(toolLabel('add_tag')).toBe('Tagged contacts');
		expect(toolLabel('move_pipeline_card')).toBe('Moved a deal');
		expect(toolLabel('create_campaign_draft')).toBe('Drafted a campaign'); // #309
		expect(toolLabel('reorder_automation_steps')).toBe('Reordered steps');
	});

	it('labels a group of tool calls', () => {
		expect(toolGroupLabel([{ status: 'ok' }, { status: 'error' }, { status: 'ok' }])).toBe('Looked at 3 things');
		expect(toolGroupLabel([{ status: 'ok' }, { status: 'running' }])).toBe('Looking at 2 things…');
	});
});

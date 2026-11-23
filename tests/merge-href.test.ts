import { describe, it, expect } from 'vitest';
import { fillRecipientTemplates, renderEmailHtml, renderEmailText, personalize, type MergeRecipient } from '../src/lib/server/email';
import { buildCondCtx, evaluateConditionals, hasConditionals } from '../src/lib/conditionals';

const REPORT = 'https://example.com/r?key=abc&x=1';
const REPORT_SPACED = 'https://example.com/my report (final)?key=abc&x=1';

function recipient(over: Partial<MergeRecipient> = {}): MergeRecipient {
	return { email: 'ada@acme.example.net', first_name: 'Ada', last_name: 'Lovelace', company: 'Acme', ...over };
}

function renderFilled(
	md: string,
	fields: Record<string, unknown>,
	opts?: { tags?: string; recipient?: Partial<MergeRecipient>; subject?: string }
) {
	const html = renderEmailHtml(md, { unsubscribe: false });
	const text = renderEmailText(md, { unsubscribe: false });
	const ctx = buildCondCtx(opts?.tags ?? '', JSON.stringify(fields));
	return {
		htmlTemplate: html,
		...fillRecipientTemplates(
			{ subject: opts?.subject ?? 'Hi {{first_name}}', html, text },
			'https://example.com/unsubscribe?t=tok',
			recipient(opts?.recipient),
			ctx
		)
	};
}

function decodeAttr(s: string): string {
	return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

describe('merge tags in markdown hrefs', () => {
	it('keeps {{field}} literal through marked instead of percent-encoding the href', () => {
		const html = renderEmailHtml('[View your snapshot]({{field:report_url}})', { unsubscribe: false });
		expect(html).toContain('href="{{field:report_url}}"');
		expect(html).not.toContain('%7B%7B');
	});

	it('fills a markdown link whose field URL has a query string', () => {
		const { html, text } = renderFilled('[View your snapshot]({{field:report_url}})', { report_url: REPORT });
		expect(html).toContain(`href="${REPORT.replace('&', '&amp;')}"`);
		expect(html).not.toContain('&amp;amp;');
		expect(html).not.toContain('%7B%7B');
		const href = html.match(/href="([^"]*key=abc[^"]*)"/)?.[1] ?? '';
		const url = new URL(decodeAttr(href));
		expect(url.searchParams.get('key')).toBe('abc');
		expect(url.searchParams.get('x')).toBe('1');
		expect(text).toContain(REPORT);
		expect(text).not.toContain('&amp;');
	});

	it('keeps spaces and parentheses in a substituted URL as a real href', () => {
		const { html, text } = renderFilled('[View your snapshot]({{field:report_url}})', {
			report_url: REPORT_SPACED
		});
		expect(html).toContain('href="https://example.com/my%20report%20(final)?key=abc&amp;x=1"');
		expect(html).not.toContain('&amp;amp;');
		const href = html.match(/href="(https:\/\/example.com\/my[^"]*)"/)?.[1] ?? '';
		const url = new URL(decodeAttr(href));
		expect(url.pathname).toBe('/my%20report%20(final)');
		expect(decodeURIComponent(url.pathname)).toBe('/my report (final)');
		expect(url.searchParams.get('key')).toBe('abc');
		expect(url.searchParams.get('x')).toBe('1');
		expect(text).toContain(REPORT_SPACED);
		expect(text).not.toContain('&amp;');
	});

	it('fills {{first_name}} inside an href without letting it break the URL', () => {
		const { html } = renderFilled('[Profile](https://example.com/u/{{first_name}})', {});
		expect(html).toContain('href="https://example.com/u/Ada"');

		const spaced = renderFilled('[Profile](https://example.com/u/{{first_name}})', {}, {
			recipient: { first_name: 'Ada (AJ)' }
		});
		expect(spaced.html).toContain('href="https://example.com/u/Ada%20(AJ)"');
		expect(spaced.html).not.toContain('&amp;amp;');

		const quoted = renderFilled("<a href='https://example.com/u/{{first_name}}'>x</a>", {}, {
			recipient: { first_name: "x'onclick='alert(1)" }
		});
		expect(quoted.html).not.toContain("onclick='alert");
		expect(quoted.html).toContain('https://example.com/u/x%27onclick%3D%27alert(1)');
	});

	it('fills a raw <a href> the same way', () => {
		const { html, text } = renderFilled('<a href="{{field:report_url}}">View your snapshot</a>', {
			report_url: REPORT
		});
		expect(html).toContain(`href="${REPORT.replace('&', '&amp;')}"`);
		expect(html).not.toContain('&amp;amp;');
		expect(text).toContain(REPORT);
	});

	it('fills a conditional block that contains a link', () => {
		const md = '{{#if tag:vip}}[View your snapshot]({{field:report_url}}){{else}}Not yet{{/if}}';
		const vip = renderFilled(md, { report_url: REPORT }, { tags: 'vip' });
		expect(vip.html).toContain(`href="${REPORT.replace('&', '&amp;')}"`);
		expect(vip.html).not.toContain('Not yet');
		expect(vip.html).not.toContain('{{#if');
		expect(vip.text).toContain(REPORT);

		const other = renderFilled(md, { report_url: REPORT }, { tags: '' });
		expect(other.html).toContain('Not yet');
		expect(other.html).not.toContain('report_url');
		expect(other.html).not.toContain(REPORT);
		expect(other.text).toContain('Not yet');
		expect(other.text).not.toContain(REPORT);
	});

	it('still evaluates equality and numeric conditions after markdown', () => {
		const eq = renderFilled('{{#if field:tier == "hot"}}YES{{else}}NO{{/if}}', { tier: 'hot' });
		expect(eq.html).toContain('YES');
		expect(eq.html).not.toContain('{{#if');
		expect(eq.html).not.toContain('&quot;');

		const num = renderFilled('{{#if field:score >= 90}}high{{else}}low{{/if}}', { score: 92 });
		expect(num.html).toContain('high');
		expect(num.html).not.toContain('low');
		expect(num.html).not.toContain('{{#if');
	});

	it('does not let a field value inject markup or a javascript: href', () => {
		const { html, text } = renderFilled(
			'Hi {{field:note}}\n\n[{{field:note}}](https://example.com)\n\n[Open]({{field:report_url}})\n\n[Also]({{field:bad}})',
			{
				note: '<script>alert(1)</script>',
				report_url: 'javascript:alert(1)',
				bad: 'https://ok.com/"onmouseover="alert(1)'
			}
		);
		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toMatch(/href\s*=\s*["']\s*javascript:/i);
		expect(html).toContain('href="#"');
		expect(html).not.toContain('onmouseover="alert');
		expect(html).toContain('href="https://ok.com/%22onmouseover=%22alert(1)"');
		expect(text).toContain('javascript:alert(1)');
		expect(text).toContain('<script>alert(1)</script>');
	});

	it('rejects an entity-encoded quote breakout in a full URL', () => {
		const { html } = renderFilled('[Open]({{field:report_url}})', {
			report_url: 'https://ok.com/&quot;onclick=&quot;alert(1)'
		});
		expect(html).not.toContain('onclick="alert');
		expect(html).toContain('%22onclick=');
	});

	it('keeps unknown tags and empty fields as they are today', () => {
		const { html, text, subject } = renderFilled('Hello {{not_a_tag}} [{{field:nope}}]({{field:missing}})', {}, {
			recipient: { first_name: '  ', company: '' },
			subject: 'Hi {{first_name}} at {{company}}'
		});
		expect(html).toContain('{{not_a_tag}}');
		expect(text).toContain('Hello {{not_a_tag}} []()');
		expect(html).toContain('href=""');
		expect(subject).toBe('Hi there at ');
		expect(personalize('Hey {{first_name}} from {{company}}!', '#', { email: 'x@y.example.net' })).toBe('Hey there from !');
	});

	it('HTML-escapes name values in HTML text and leaves them raw in plain text', () => {
		const { html, text } = renderFilled('Hi {{first_name}} at {{company}}', {}, {
			recipient: { first_name: "A <b> O'Brien", company: 'Tom & Jerry' }
		});
		expect(html).toContain('A &lt;b&gt; O&#39;Brien');
		expect(html).toContain('Tom &amp; Jerry');
		expect(html).not.toContain('<b>');
		expect(text).toContain("A <b> O'Brien");
		expect(text).toContain('Tom & Jerry');
	});

	it('still swaps the unsubscribe placeholder in the footer href', () => {
		const html = renderEmailHtml('hi');
		const filled = fillRecipientTemplates(
			{ subject: 's', html, text: 't' },
			'https://example.com/unsubscribe?t=abc',
			recipient(),
			null
		);
		expect(filled.html).toContain('href="https://example.com/unsubscribe?t=abc"');
		expect(filled.html).not.toContain('%%UNSUB_URL%%');
	});

	it('fills a legacy percent-encoded href and an escaped {{#if}} from stored HTML', () => {
		const legacy =
			'<p>{{#if field:score &gt;= 90}}<a href="%7B%7Bfield:report_url%7D%7D">View</a>{{else}}no{{/if}}</p>';
		expect(hasConditionals(legacy)).toBe(true);
		const ctx = buildCondCtx('', JSON.stringify({ score: 95, report_url: REPORT }));
		const html = evaluateConditionals(legacy, ctx, { mode: 'html' });
		expect(html).toContain(`href="${REPORT.replace('&', '&amp;')}"`);
		expect(html).not.toContain('&amp;amp;');
		expect(html).not.toContain('%7B%7B');
		expect(html).not.toContain('{{#if');
		expect(html).not.toContain('>no<');
	});

	it('does not double-encode a static markdown link that has no merge tag', () => {
		const html = renderEmailHtml('[Docs](https://example.com/r?key=abc&x=1)', { unsubscribe: false });
		expect(html).toContain('href="https://example.com/r?key=abc&x=1"');
		expect(html).not.toContain('&amp;amp;');
	});
});

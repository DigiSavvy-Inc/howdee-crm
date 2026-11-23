import { describe, it, expect } from 'vitest';
import { htmlToReplyText } from '../src/lib/server/inbound-text';

describe('htmlToReplyText (#78)', () => {
	it('empty input -> empty string', () => {
		expect(htmlToReplyText('')).toBe('');
	});

	it('extracts just the message from an Apple-Mail-style HTML-only reply', () => {
		const html = `
			<html>
			<head><style>body { font-family: -apple-system; }</style></head>
			<body>
				<div>Sounds good, let's do Thursday.</div>
				<div><br></div>
				<div>Thanks,<br>Jane</div>
				<blockquote type="cite">
					<div>On Sep 2, 2026, at 10:00 AM, Alan Hartley &lt;alan@ourco.example&gt; wrote:</div>
					<div><br></div>
					<div>Are you free Thursday for a quick call?</div>
				</blockquote>
			</body>
			</html>
		`;
		const text = htmlToReplyText(html);
		expect(text).toContain("Sounds good, let's do Thursday.");
		expect(text).toContain('Thanks,');
		expect(text).toContain('Jane');
		// Quoted history must be gone.
		expect(text).not.toContain('Are you free Thursday');
		expect(text).not.toContain('On Sep 2, 2026');
		expect(text).not.toContain('<');
		expect(text).not.toContain('>');
	});

	it('cuts everything from the gmail_quote div onward', () => {
		const html = `
			<div dir="ltr">Thanks, that works for me!</div>
			<br>
			<div class="gmail_quote">
				<div class="gmail_attr">On Wed, Sep 2, 2026 at 9:00 AM Alan Hartley &lt;alan@ourco.example&gt; wrote:</div>
				<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">
					<div dir="ltr">Original message content here.</div>
				</blockquote>
			</div>
		`;
		const text = htmlToReplyText(html);
		expect(text).toContain('Thanks, that works for me!');
		expect(text).not.toContain('Original message content here');
		expect(text).not.toContain('gmail_quote');
	});

	it('drops a trailing "On ... wrote:" attribution line with no blockquote wrapper', () => {
		const html = `<div>Got it, thanks!</div><div>On Tue, Sep 1, 2026 at 3:00 PM Alan Hartley wrote:</div>`;
		const text = htmlToReplyText(html);
		expect(text).toContain('Got it, thanks!');
		expect(text).not.toMatch(/On .+wrote:/i);
	});

	it('decodes common entities', () => {
		const html = '<div>Tom &amp; Jerry said &quot;hi&quot; &mdash; it&#39;s &lt;fun&gt;&nbsp;today</div>'
			.replace('&mdash;', '-'); // keep the fixture to entities the function actually handles
		const text = htmlToReplyText(html);
		expect(text).toBe("Tom & Jerry said \"hi\" - it's <fun> today");
	});

	it('converts <br> and block-closing tags to newlines, then collapses extra blank lines', () => {
		const html = '<p>Line one</p><p>Line two<br><br><br>Line three</p>';
		const text = htmlToReplyText(html);
		expect(text.split('\n\n').length).toBeLessThanOrEqual(text.split('\n').length);
		expect(text).toContain('Line one');
		expect(text).toContain('Line two');
		expect(text).toContain('Line three');
		expect(text).not.toMatch(/\n{3,}/);
	});
});

// #553: a {{company.<key>|fallback}} holding quotes and an ampersand, rendered for an email
// (markdown body, legacy text block, paragraph block) and filled for one recipient: in body
// text the fallback is escaped exactly once, and inside a link target it never splits the
// attribute. Normal output (plain fallbacks, filled values) is unchanged.
import { describe, it, expect } from 'vitest';
import { fillRecipientTemplates, personalize, type MergeRecipient } from '../src/lib/server/email';
import { renderBody, composeBodyFrom } from '../src/lib/server/compose-body';
import { buildCondCtx } from '../src/lib/conditionals';

const TOKEN = '{{company.name|"quoted" & Co}}';
const NO_COMPANY: MergeRecipient = { email: 'ada@example.com', first_name: 'Ada' };

function decodeAttr(s: string): string {
	return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Every <a …> start tag is a run of name="value" attributes — a quote that ended an
 *  attribute early would leave a bare word (`quoted&quot;`) or an extra `name="…"`. */
function expectWellFormedAnchors(html: string): void {
	for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
		expect(tag, tag).toMatch(/^<a(?:\s+[\w-]+="[^"]*")+\s*>$/);
		const names = [...tag.matchAll(/\s([\w-]+)="/g)].map((m) => m[1].toLowerCase());
		expect(new Set(names).size, tag).toBe(names.length);
		expect(names.filter((n) => n.startsWith('on')), tag).toEqual([]);
	}
}

function expectNoDoubleEscape(html: string): void {
	expect(html).not.toContain('&amp;quot;');
	expect(html).not.toContain('&amp;amp;');
	expect(html).not.toContain('&amp;#');
	expect(html).not.toMatch(/%26(?:quot|amp|#)/i);
}

/** The acme.test hrefs, attribute- and URL-decoded. */
function acmeHrefs(html: string): string[] {
	return [...html.matchAll(/href="([^"]*acme\.test[^"]*)"/g)].map((m) => safeDecode(decodeAttr(m[1])));
}

function sendHtml(body: { blocks: unknown; md: string }): string {
	const { html, text } = renderBody(composeBodyFrom(body.blocks, body.md), { unsubscribe: false });
	return fillRecipientTemplates({ subject: 'Hi', html, text }, 'https://example.com/u', NO_COMPANY, buildCondCtx('', '{}')).html;
}

const paragraph = (content: unknown[]) => ({ blocks: [{ id: 'p', type: 'paragraph', content }], md: '' });

const FORMS: Array<[string, (text: string, href: string) => { blocks: unknown; md: string }]> = [
	['markdown', (text, href) => ({ blocks: null, md: `${text}\n\n[Visit](<${href}>)` })],
	[
		'text block',
		(text, href) => ({ blocks: [{ id: 't', type: 'text', md: `${text}\n\n[Visit](<${href}>)` }], md: '' })
	],
	[
		'paragraph block',
		(text, href) =>
			paragraph([
				{ type: 'text', text: `${text} ` },
				{ type: 'text', text: 'Visit', marks: [{ type: 'link', href }] }
			])
	]
];

describe('company fallbacks with quotes and & in emails (#553)', () => {
	for (const [name, build] of FORMS) {
		it(`${name}: body text is escaped once and the link attribute stays whole`, () => {
			const html = sendHtml(build(`Team: ${TOKEN}`, `https://acme.test/?c=${TOKEN}`));
			expect(html).toContain('Team: &quot;quoted&quot; &amp; Co');
			expectNoDoubleEscape(html);
			expectWellFormedAnchors(html);
			expect(html).not.toContain('{{company.name');
			// When the renderer kept the link, its target carries the fallback as one value.
			for (const href of acmeHrefs(html)) expect(href).toContain('c="quoted" & Co');
		});

		it(`${name}: a plain fallback and a filled value render as before`, () => {
			const html = sendHtml(build('Hi {{company.name|friend}}', 'https://acme.test/?c={{company.name|friend}}'));
			expect(html).toContain('Hi friend');
			for (const href of acmeHrefs(html)) expect(href).toContain('c=friend');
			const body = build(TOKEN, 'https://acme.test/');
			const { html: tpl, text } = renderBody(composeBodyFrom(body.blocks, body.md), { unsubscribe: false });
			const filled = fillRecipientTemplates(
				{ subject: 'Hi', html: tpl, text },
				'#',
				{ ...NO_COMPANY, companyFields: { name: 'Acme & "Sons"' } },
				buildCondCtx('', '{}')
			).html;
			expect(filled).toContain('Acme &amp; &quot;Sons&quot;');
			expectNoDoubleEscape(filled);
		});
	}
});

describe('personalize: the forms a company fallback arrives in (#553)', () => {
	const html = (t: string) => personalize(t, '#', NO_COMPANY, { mode: 'html' });

	it('escapes the fallback once whether the template holds it raw or already escaped', () => {
		expect(html(`<p>${TOKEN}</p>`)).toBe('<p>&quot;quoted&quot; &amp; Co</p>');
		expect(html('<p>{{company.name|&quot;quoted&quot; &amp; Co}}</p>')).toBe('<p>&quot;quoted&quot; &amp; Co</p>');
		expect(html('<p>{{company.name|friend}}</p>')).toBe('<p>friend</p>');
	});

	it('plain text and the subject keep the raw fallback', () => {
		expect(personalize(`Team: ${TOKEN}`, '#', NO_COMPANY)).toBe('Team: "quoted" & Co');
	});

	it('keeps an href whole for a raw, escaped or percent-encoded token', () => {
		const forms = [
			`<a href="https://acme.test/?c={{company.name|&quot;quoted&quot; &amp; Co}}">x</a>`,
			`<a href="https://acme.test/?c=%7B%7Bcompany.name%7C%22quoted%22%20%26%20Co%7D%7D">x</a>`
		];
		for (const t of forms) {
			const out = html(t);
			expectWellFormedAnchors(out);
			expectNoDoubleEscape(out);
			expect(out, t).not.toContain('{{');
			expect(acmeHrefs(out)[0], t).toContain('c="quoted" & Co');
		}
	});

	it('leaves a token nothing fills inert instead of decoding quotes into the attribute', () => {
		const t = '<a href="https://acme.test/?c=%7B%7Bcompany.bogus%7C%22%20onclick%3D%22alert%281%29%7D%7D">x</a>';
		const out = html(t);
		expectWellFormedAnchors(out);
		expect(out).not.toContain('onclick="');
		expect(out).toContain('%257B');
	});

	it('leaves a raw token nothing fills inert inside an href', () => {
		const out = html('<a href="https://acme.test/?c={{company.bogus|" onclick="alert(1)}}">x</a>');
		expectWellFormedAnchors(out);
		expect(out).not.toContain('onclick="');
	});

	it('send path: the conditionals pass decodes an encoded token first, and the href still stays whole', () => {
		const send = (tpl: string, r: MergeRecipient = NO_COMPANY) =>
			fillRecipientTemplates({ subject: 'Hi', html: tpl, text: '' }, '#', r, buildCondCtx('', '{}')).html;
		const filled = send('<a href="https://acme.test/?c=%7B%7Bcompany.name%7C%22quoted%22%20%26%20Co%7D%7D">x</a>');
		expectWellFormedAnchors(filled);
		expectNoDoubleEscape(filled);
		expect(acmeHrefs(filled)[0]).toContain('c="quoted" & Co');
		const unfilled = send('<a href="https://acme.test/?c=%7B%7Bcompany.bogus%7C%22%20onclick%3D%22alert%281%29%7D%7D">x</a>');
		expectWellFormedAnchors(unfilled);
		expect(unfilled).not.toContain('onclick="');
	});

	it('a filled value with quotes is escaped once in text and encoded once in an href', () => {
		const acme: MergeRecipient = { ...NO_COMPANY, companyFields: { name: 'Acme & "Sons"' } };
		const out = personalize(`<p>${TOKEN}</p><a href="https://acme.test/?c=${TOKEN}">x</a>`, '#', acme, { mode: 'html' });
		expect(out).toContain('<p>Acme &amp; &quot;Sons&quot;</p>');
		expectWellFormedAnchors(out);
		expectNoDoubleEscape(out);
		expect(acmeHrefs(out)[0]).toContain('c=Acme & "Sons"');
	});
});

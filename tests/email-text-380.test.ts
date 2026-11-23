import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	looksLikeHtml,
	htmlToText,
	stripHelpdeskMarkers,
	cleanMessageText,
	displayText,
	decodeEntities,
	originalSrcdoc
} from '../src/lib/email-text';
import { pickInboundText } from '../src/lib/server/inbound-text';
import { conversationsFor, replyOriginalHtml } from '../src/lib/server/conversations';
import { campaignReplies } from '../src/lib/server/campaign-read';
import { POST as inbound } from '../src/routes/api/inbound/+server';
import { GET as originalGet } from '../src/routes/api/replies/[id]/original/+server';

const db = (env as any).DB as D1Database;
const messageSource = Object.values(
	import.meta.glob('../src/lib/components/ConversationMessage.svelte', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
)[0];

// An invented helpdesk auto-reply, shaped like the vendor ticket mail that showed up as raw
// HTML (#380): reply marker, <center> wrapper, <style> block, hidden preheader, nested layout
// tables, a logo link, social icons and a click-tracked unsubscribe link.
const HELPDESK = `##- Please type your reply above this line -##
<center class="wrapper" style="width:100%;table-layout:fixed;background-color:#f4f4f4;">
<style type="text/css">.wrapper { width: 100%; } td { font-family: Arial; }</style>
<!-- preheader -->
<div style="display:none;max-height:0;overflow:hidden;">Hidden preheader text &zwnj;&nbsp;&zwnj;</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4" style="border-collapse:collapse;">
  <tr><td align="center" bgcolor="#ffffff" style="padding:20px;">
    <table width="600" bgcolor="#ffffff"><tr><td style="font-size:16px;color:#333333;">
      <a href="https://hosting.example.net"><img src="https://cdn.hosting.example.net/logo.png" alt="Acme Hosting" width="120"></a>
      <p style="margin:0 0 12px;">Hi Sam,</p>
      <p style="margin:0 0 12px;">Thank you for submitting your request. Ticket #12345 has been created &amp; our team will reply soon.</p>
      <p>View it in the <a href="https://support.hosting.example.net/hc/requests/12345" style="color:#0678be">help center</a>.</p>
    </td></tr></table>
  </td></tr>
  <tr><td bgcolor="#f4f4f4" style="padding:10px;">
    <table><tr>
      <td><a href="https://social.example.com/acmehosting"><img src="https://cdn.hosting.example.net/tw.png" alt="Twitter"></a></td>
      <td><a href="https://social.example.org/company/acmehosting"><img src="https://cdn.hosting.example.net/li.png" alt=""></a></td>
    </tr></table>
    <p style="font-size:12px;color:#999999;">&copy; 2026 Acme Hosting Inc &#8212; <a href="https://hosting.example.net/privacy">Privacy</a> | <a href="https://click.hosting.example.net/ls/click?upn=abc123">Unsubscribe</a></p>
  </td></tr>
</table>
</center>`;

describe('looksLikeHtml (#380)', () => {
	it('spots markup', () => {
		expect(looksLikeHtml(HELPDESK)).toBe(true);
		expect(looksLikeHtml('<div>a</div><div>b</div>')).toBe(true);
		expect(looksLikeHtml('<html><p>x</p>')).toBe(true);
	});
	it('leaves ordinary text alone', () => {
		for (const s of ['I <3 this', 'if a < b and b > c', 'Use the <br> tag', 'x <- y', '', null, 'Thanks!\n\n> quoted']) {
			expect(looksLikeHtml(s as string)).toBe(false);
		}
	});
});

describe('htmlToText (#380)', () => {
	it('turns the helpdesk example into readable text', () => {
		const t = displayText(HELPDESK);
		expect(t).toContain('Thank you for submitting your request');
		expect(t).toContain('Ticket #12345 has been created & our team will reply soon.');
		expect(t).toContain('help center (https://support.hosting.example.net/hc/requests/12345)');
		expect(t).toContain('© 2026 Acme Hosting Inc —');
		expect(t).toContain('Privacy (https://hosting.example.net/privacy)');
		expect(t).toContain('Unsubscribe');
		expect(t).not.toContain('click.hosting.example.net'); // tracker URL dropped
		expect(t).not.toContain('<');
		expect(t).not.toContain('style=');
		expect(t).not.toContain('bgcolor');
		expect(t).not.toContain('font-family'); // <style> block dropped
		expect(t).not.toContain('Hidden preheader');
		expect(t).not.toContain('Please type your reply above this line');
		expect(t).not.toContain('.png');
		expect(t).not.toMatch(/\n{3,}/);
		expect(t.split('\n')[0]).toBe('Acme Hosting'); // logo alt only, no URL
	});

	it('decodes named, decimal and hex entities', () => {
		expect(htmlToText('<p>Tom &amp; Jerry&nbsp;&quot;hi&quot; &#39;x&#39; &#x2014; &lt;b&gt;</p>')).toBe(`Tom & Jerry "hi" 'x' — <b>`);
		expect(decodeEntities('&amp;lt;')).toBe('&lt;');
		expect(decodeEntities('&bogus; &#xZZ;')).toBe('&bogus; &#xZZ;');
	});

	it('handles nested tables: cells become spaces, rows lines', () => {
		const t = htmlToText('<table><tr><td>A</td><td><table><tr><td>B1</td><td>B2</td></tr><tr><td>C</td></tr></table></td></tr></table>');
		expect(t.split('\n')).toEqual(['A', 'B1 B2', 'C']);
	});

	it('drops <style>, <script>, <head> and comments', () => {
		const t = htmlToText('<html><head><title>T</title><meta x></head><body><style>p{color:red}</style><script>alert(1)</script><!-- c --><p>Body</p></body></html>');
		expect(t).toBe('Body');
	});

	it('keeps a link URL only when it differs from the text', () => {
		expect(htmlToText('<p><a href="https://example.org/">example.org</a></p>')).toBe('example.org');
		expect(htmlToText('<p><a href="mailto:a@b.example.net">a@b.example.net</a></p>')).toBe('a@b.example.net');
		expect(htmlToText('<p><a href="https://x.example.net/doc">the doc</a></p>')).toBe('the doc (https://x.example.net/doc)');
	});

	it('collapses blank-line runs to one', () => {
		expect(htmlToText('<p>One</p><br><br><br><div></div><p>Two</p>')).toBe('One\n\nTwo');
	});
});

describe('plain text passes through (#380)', () => {
	it('is unchanged', () => {
		const s = 'Hi Sam,\n\nI <3 the new site. Is a < b?\nTom &amp; Jerry stays literal.';
		expect(cleanMessageText(s)).toEqual({ text: s, converted: false });
	});
});

describe('stripHelpdeskMarkers (#380)', () => {
	it.each([
		'##- Please type your reply above this line -##',
		'## Please reply above this line ##',
		'-- Reply above this line --',
		'--- Reply above this line. ---',
		'Please reply above this line',
		'## Please do not write below this line ##',
		'—-—-—-— Reply above this line.'
	])('drops %s', (marker) => {
		expect(stripHelpdeskMarkers(`${marker}\n\nYour ticket is open.`)).toBe('Your ticket is open.');
	});
	it('keeps prose that merely mentions it', () => {
		const s = 'I wrote my reply above this line of text you sent.';
		expect(stripHelpdeskMarkers(s)).toBe(s);
	});
});

describe('pickInboundText (#380)', () => {
	it('prefers StrippedTextReply', () => {
		expect(pickInboundText({ StrippedTextReply: 'Short reply', TextBody: 'Short reply\n\n> quoted', HtmlBody: '<p>x</p>' })).toEqual({
			text: 'Short reply',
			html: null,
			fromHtmlBody: false
		});
	});
	it('then a real TextBody', () => {
		expect(pickInboundText({ StrippedTextReply: '', TextBody: 'Body text', HtmlBody: '<p>x</p>' }).text).toBe('Body text');
	});
	it('converts HtmlBody when the text parts are empty or HTML, keeping the original', () => {
		const r = pickInboundText({ StrippedTextReply: '', TextBody: HELPDESK, HtmlBody: '<div>Real</div><div>reply</div><br>' });
		expect(r).toEqual({ text: 'Real\nreply', html: '<div>Real</div><div>reply</div><br>', fromHtmlBody: true });
	});
	it('converts an HTML text part when there is no HtmlBody', () => {
		const r = pickInboundText({ TextBody: HELPDESK });
		expect(r.text).toContain('Thank you for submitting your request');
		expect(r.html).toBe(HELPDESK.trim());
		expect(r.fromHtmlBody).toBe(false);
	});
});

describe('originalSrcdoc (#380)', () => {
	const html = '<html><head><meta http-equiv="refresh" content="0;url=https://evil"></head><body onload="x()"><script>alert(1)</script><img src="https://cdn.x/a.png" srcset="https://cdn.x/a2.png 2x" alt="A"><td background="https://cdn.x/bg.png">c</td><a href="https://x.example.net" target="_self">x</a></body></html>';
	it('blocks remote images until requested', () => {
		const doc = originalSrcdoc(html);
		expect(doc).not.toContain('https://cdn.x/');
		expect(doc).toContain("img-src data:");
		expect(doc).not.toMatch(/<script/i);
		expect(doc).not.toContain('onload');
		expect(doc).not.toContain('https://evil');
		expect(doc).toContain('<a href="https://x.example.net" target="_blank" rel="noopener noreferrer">');
		const withImages = originalSrcdoc(html, { loadImages: true });
		expect(withImages).toContain('src="https://cdn.x/a.png"');
		expect(withImages).toContain('img-src https: http: data:');
	});
	it('the component renders it in a sandbox="" iframe, lazily', () => {
		const src = String(messageSource);
		const frame = src.slice(src.indexOf('title="Original message"') - 80, src.indexOf('title="Original message"') + 200);
		expect(frame).toContain('sandbox=""');
		expect(frame).toContain('srcdoc={originalSrcdoc(original.html, { loadImages: original.images })}');
		// Only rendered after the toggle opened it and the HTML loaded.
		expect(src).toMatch(/\{#if original\?\.open\}[\s\S]*<iframe[\s\S]*title="Original message"/);
		expect(src).not.toMatch(/\{@html/);
	});
});

describe('ingest + render (#380)', () => {
	beforeEach(async () => {
		await db.batch([db.prepare('DELETE FROM replies'), db.prepare('DELETE FROM contacts')]);
	});

	function ev(body: unknown) {
		return {
			url: new URL('https://app.test/api/inbound?key=k'),
			request: new Request('https://app.test/api/inbound', { method: 'POST', body: JSON.stringify(body) }),
			platform: { env: { DB: db, INBOUND_KEY: 'k', POSTMARK_FROM: 'owner@example.com' } }
		} as any;
	}

	it('stores StrippedTextReply when present, no original', async () => {
		const res = await inbound(ev({ FromFull: { Email: 'ann@x.example.net' }, Subject: 'Re: hi', StrippedTextReply: 'Yes please', TextBody: HELPDESK }));
		expect(res.status).toBe(200);
		const row = await db.prepare('SELECT text, html_body FROM replies').first<{ text: string; html_body: string | null }>();
		expect(row).toEqual({ text: 'Yes please', html_body: null });
	});

	it('stores converted text + the HTML original for an HTML text part', async () => {
		const contact = (await db.prepare("INSERT INTO contacts (email) VALUES ('help@hosting.example.net') RETURNING id").first<{ id: number }>())!.id;
		await inbound(ev({ FromFull: { Email: 'help@hosting.example.net' }, Subject: 'Request received', StrippedTextReply: '', TextBody: HELPDESK }));
		const row = await db.prepare('SELECT id, text, html_body FROM replies').first<{ id: number; text: string; html_body: string }>();
		expect(row!.text).toContain('Thank you for submitting your request');
		expect(row!.text).not.toContain('<');
		expect(row!.html_body).toBe(HELPDESK.trim());
		const [conv] = await conversationsFor(db, contact);
		expect(conv.messages[0].has_original).toBe(true);
		const res = await originalGet({ params: { id: String(row!.id) }, platform: { env: { DB: db } } } as any);
		expect(((await res.json()) as { html: string }).html).toBe(HELPDESK.trim());
	});

	it('cleans rows stored before the fix at render time', async () => {
		const contact = (await db.prepare("INSERT INTO contacts (email) VALUES ('help@hosting.example.net') RETURNING id").first<{ id: number }>())!.id;
		const camp = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('S', 'm', 'h', 'f', 'sent') RETURNING id")
			.first<{ id: number }>())!.id;
		const id = (await db
			.prepare("INSERT INTO replies (contact_id, campaign_id, from_email, subject, text) VALUES (?, ?, 'help@hosting.example.net', 'Re: S', ?) RETURNING id")
			.bind(contact, camp, HELPDESK)
			.first<{ id: number }>())!.id;
		const [conv] = await conversationsFor(db, contact);
		const msg = conv.messages.find((m) => m.reply_id === id)!;
		expect(msg.text).toContain('Thank you for submitting your request');
		expect(msg.text).not.toContain('<center');
		expect(msg.has_original).toBe(true);
		expect(await replyOriginalHtml(db, id)).toBe(HELPDESK);
		const [r] = await campaignReplies(db, camp);
		expect(r.text).toContain('Thank you for submitting your request');
		expect(r.text).not.toContain('bgcolor');
		await db.prepare('DELETE FROM campaigns WHERE id = ?').bind(camp).run();
	});

	it('plain replies have no original', async () => {
		const contact = (await db.prepare("INSERT INTO contacts (email) VALUES ('ann@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const id = (await db
			.prepare("INSERT INTO replies (contact_id, from_email, subject, text) VALUES (?, 'ann@x.example.net', 'Hi', 'I <3 it') RETURNING id")
			.bind(contact)
			.first<{ id: number }>())!.id;
		const [conv] = await conversationsFor(db, contact);
		expect(conv.messages[0]).toMatchObject({ text: 'I <3 it', has_original: false });
		expect(await replyOriginalHtml(db, id)).toBeNull();
		const res = await originalGet({ params: { id: String(id) }, platform: { env: { DB: db } } } as any);
		expect(res.status).toBe(404);
	});
});

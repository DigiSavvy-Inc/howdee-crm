import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { load as formLoad } from '../src/routes/f/[slug]/+page.server';
import { POST as submit } from '../src/routes/f/[slug]/submit/+server';
import { load as thanksLoad } from '../src/routes/f/[slug]/thanks/+page.server';
import { GET as embedJs } from '../src/routes/f/[slug]/embed.js/+server';
import { emptyForm, validateFormSpec, withSettingsOutcome, type FormSpec } from '../src/lib/forms';
import { createForm, getForm, signSubmissionId } from '../src/lib/server/forms';
import {
	cleanOriginLine,
	embedOriginAllowed,
	embedScript,
	fillFormTags,
	formTag,
	frameAncestors,
	hasFormTags,
	iframeSnippet,
	isFormTagToken,
	originProblem,
	rawHtmlSnippet,
	scriptSnippet,
	whereItWorks
} from '../src/lib/form-embed';
import { formContactFromToken } from '../src/lib/server/form-embed';
import { signVisitorToken } from '../src/lib/server/track-token';
import { fillRecipientTemplates } from '../src/lib/server/email';
import { findMergeTags } from '../src/lib/presend-checks';
import { formFrameHeaders } from '../src/lib/server/form-embed';

// #515: Forms share & embed — embed.js, embedded page CSP, {{form:slug}} links, page_url.

const db = (env as any).DB as D1Database;
const SECRET = 'test-secret';
const platformEnv = { ...(env as any), SESSION_SECRET: SECRET, PUBLIC_BASE_URL: 'https://app.test' };
const admin = { id: 1, login: 'ourco-admin', role: 'admin' };

function getEvent(path: string, params: Record<string, string>) {
	const url = new URL(`https://app.test${path}`);
	const headers: Record<string, string> = {};
	return {
		platform: { env: platformEnv },
		params,
		url,
		request: new Request(url),
		setHeaders: (h: Record<string, string>) => Object.assign(headers, h),
		headers
	} as any;
}
function postEvent(path: string, params: Record<string, string>, fields: [string, string][], opts: { json?: boolean; origin?: string } = {}) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test${path}`);
	const headers: Record<string, string> = { origin: opts.origin ?? 'https://app.test', 'cf-connecting-ip': `198.51.100.${Math.floor(Math.random() * 200)}` };
	if (opts.json) headers.accept = 'application/json';
	return { platform: { env: platformEnv }, params, url, request: new Request(url, { method: 'POST', body: fd, headers }) } as any;
}
async function run(fn: (e: any) => unknown, e: any): Promise<{ status?: number; redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (isRedirect(err)) return { redirect: err.location, status: err.status };
		if (isHttpError(err)) return { status: err.status };
		throw err;
	}
}
async function makeForm(name: string, mutate: (s: FormSpec) => FormSpec = (s) => s) {
	const id = await createForm(db, name, admin.id);
	const spec = mutate(withSettingsOutcome(emptyForm(name), [{ type: 'message_md', md: 'Thanks!' }]));
	await db.prepare(`UPDATE forms SET spec = ?, status = 'published' WHERE id = ?`).bind(JSON.stringify(spec), id).run();
	return (await getForm(db, id))!;
}
const withOrigins = (origins: string[]) => (s: FormSpec): FormSpec => ({ ...s, settings: { ...s.settings, allowed_origins: origins } });

describe('allowed origins', () => {
	it('validates and tidies origin lines', () => {
		expect(originProblem('https://example.com')).toBeNull();
		expect(originProblem('http://localhost:8080')).toBeNull();
		expect(originProblem('example.com')).toMatch(/https/);
		expect(originProblem('https://example.com/path')).toMatch(/origin only/);
		expect(originProblem("https://a.com; script-src *")).not.toBeNull();
		expect(cleanOriginLine('HTTPS://Example.com/')).toBe('https://example.com');
		expect(whereItWorks([])).toMatch(/Anywhere/);
		expect(whereItWorks(['https://example.com'])).toMatch(/example\.com/);

		const bad = withOrigins(['https://ok.test', 'not an origin'])(emptyForm('X'));
		expect(validateFormSpec(bad).some((p) => p.path === 'settings.allowed_origins')).toBe(true);
		expect(validateFormSpec(withOrigins(['https://ok.test'])(emptyForm('X'))).some((p) => p.path === 'settings.allowed_origins')).toBe(false);
	});

	it('embedOriginAllowed: empty = anywhere; else the list or the CRM', () => {
		expect(embedOriginAllowed('https://anyone.test', [], 'https://app.test')).toBe(true);
		expect(embedOriginAllowed('https://site.test', ['https://site.test'], 'https://app.test')).toBe(true);
		expect(embedOriginAllowed('https://SITE.test/', ['https://site.test'], 'https://app.test')).toBe(true);
		expect(embedOriginAllowed('https://app.test', ['https://site.test'], 'https://app.test')).toBe(true);
		expect(embedOriginAllowed('https://evil.test', ['https://site.test'], 'https://app.test')).toBe(false);
		expect(embedOriginAllowed('null', ['https://site.test'], 'https://app.test')).toBe(false);
	});

	it('frame-ancestors: self normally; embedded = allowed origins, or * when none', () => {
		expect(frameAncestors(['https://site.test'], false)).toBe("frame-ancestors 'self'");
		expect(frameAncestors([], true)).toBe('frame-ancestors *');
		expect(frameAncestors(['https://site.test', 'junk; x'], true)).toBe("frame-ancestors 'self' https://site.test");
	});
});

describe('embed.js', () => {
	it('is served with JS headers, inlines the same origin check, and 404s an unknown form', async () => {
		const form = await makeForm('Embed Script', withOrigins(['https://site.test']));
		const res = await embedJs(getEvent(`/f/${form.slug}/embed.js`, { slug: form.slug }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
		expect(res.headers.get('cache-control')).toBe('public, max-age=60');
		const src = await res.text();
		expect(src).toContain(embedOriginAllowed.toString());
		expect(src).toContain('"https://site.test"');
		expect(src).toContain('"https://app.test"');
		expect(src).toContain('dsv-form:height');
		expect(src).toContain('e.origin !== CRM');
		expect(src).not.toMatch(/\beval\(|new Function/);

		expect((await embedJs(getEvent('/f/nope/embed.js', { slug: 'nope' }))).status).toBe(404);
	});

	it('the generated script refuses an origin that is not allowed', () => {
		const src = embedScript({ slug: 'x', name: 'X', crmOrigin: 'https://app.test', allowed: ['https://site.test'], keys: ['email'] });
		const run = (origin: string) => {
			const made: unknown[] = [];
			const warned: string[] = [];
			const fakeWindow = {
				location: { origin, href: `${origin}/page`, search: '' },
				addEventListener: () => {}
			};
			const fakeDoc = {
				readyState: 'complete',
				referrer: '',
				querySelectorAll: () => [{ getAttribute: (n: string) => (n === 'data-dsv-form' ? 'x' : null), setAttribute: () => {}, appendChild: (f: unknown) => made.push(f) }],
				createElement: () => ({ style: {}, setAttribute: () => {} }),
				addEventListener: () => {}
			};
			// The script is plain ES5 with no globals beyond window / document / console / URLSearchParams.
			const fn = new Function('window', 'document', 'console', 'URLSearchParams', src);
			fn(fakeWindow, fakeDoc, { warn: (m: string) => warned.push(m) }, URLSearchParams);
			return { made, warned };
		};
		let ok: ReturnType<typeof run> | null = null;
		try {
			ok = run('https://site.test');
		} catch (e) {
			// workerd may refuse `new Function`; the inlined check is covered by the test above.
			if (!/code generation|eval/i.test(String(e))) throw e;
			return;
		}
		expect(ok.made).toHaveLength(1);
		expect((ok.made[0] as { src: string }).src).toMatch(/^https:\/\/app\.test\/f\/x\?embed=1&origin=https%3A%2F%2Fsite\.test&page_url=/);
		const bad = run('https://evil.test');
		expect(bad.made).toHaveLength(0);
		expect(bad.warned[0]).toMatch(/evil\.test/);
	});

	it('escapes U+2028 / U+2029 and < in the inlined values', () => {
		const LS = String.fromCharCode(0x2028);
		const PS = String.fromCharCode(0x2029);
		const src = embedScript({ slug: 'x', name: `A${LS}B${PS}C</script>`, crmOrigin: 'https://app.test', allowed: [], keys: ['email'] });
		expect(src).not.toContain(LS);
		expect(src).not.toContain(PS);
		expect(src).not.toContain('</script>');
		expect(src).toContain('var TITLE = "A\\u2028B\\u2029C\\u003c/script>";');
	});

	it('snippets name the slug, the CRM base and every answer key + the honeypot', async () => {
		const form = await makeForm('Embed Snippets');
		expect(scriptSnippet('https://app.test', form.slug)).toBe(`<div data-dsv-form="${form.slug}"></div>\n<script async src="https://app.test/f/${form.slug}/embed.js"></script>`);
		expect(iframeSnippet('https://app.test', form.slug, 'A "q"', 600)).toContain('height:600px');
		expect(iframeSnippet('https://app.test', form.slug, 'A "q"', 600)).toContain('title="A &quot;q&quot;"');
		const html = rawHtmlSnippet('https://app.test', form.slug, form.spec);
		expect(html).toContain(`<form action="https://app.test/f/${form.slug}/submit" method="post">`);
		expect(html).toContain('name="email"');
		expect(html).toContain('name="_hp_url"');
	});
});

describe('embedded page', () => {
	it('?embed=1 sets frame-ancestors to the allowed origins; the plain page stays self', async () => {
		const form = await makeForm('Embed Page', withOrigins(['https://site.test']));
		const plain = getEvent(`/f/${form.slug}`, { slug: form.slug });
		const p = await run(formLoad, plain);
		expect(p.result.embed).toBeNull();
		expect(plain.headers['content-security-policy']).toBe("frame-ancestors 'self'");

		const e = getEvent(`/f/${form.slug}?embed=1&origin=${encodeURIComponent('https://site.test')}&page_url=${encodeURIComponent('https://site.test/pricing')}`, { slug: form.slug });
		const r = await run(formLoad, e);
		expect(e.headers['content-security-policy']).toBe("frame-ancestors 'self' https://site.test");
		expect(r.result.embed).toEqual({ origin: 'https://site.test', pageUrl: 'https://site.test/pricing', referrer: null });

		// An origin the form doesn't allow isn't trusted as the postMessage target.
		const evil = await run(formLoad, getEvent(`/f/${form.slug}?embed=1&origin=${encodeURIComponent('https://evil.test')}`, { slug: form.slug }));
		expect(evil.result.embed.origin).toBeNull();

		const open = await makeForm('Embed Open');
		const o = getEvent(`/f/${open.slug}?embed=1`, { slug: open.slug });
		await run(formLoad, o);
		expect(o.headers['content-security-policy']).toBe('frame-ancestors *');
	});

	it('the thanks page of an embedded native post is frameable too', async () => {
		const form = await makeForm('Embed Thanks', withOrigins(['https://site.test']));
		const sub = await db.prepare("INSERT INTO form_submissions (form_id, status, answers) VALUES (?, 'anonymous', '{}') RETURNING id").bind(form.id).first<{ id: number }>();
		const s = await signSubmissionId(SECRET, sub!.id);
		const e = getEvent(`/f/${form.slug}/thanks?s=${s}&embed=1`, { slug: form.slug });
		await run(thanksLoad, e);
		expect(e.headers['content-security-policy']).toBe("frame-ancestors 'self' https://site.test");
	});

	it('hooks: /f/* drops X-Frame-Options and keeps the route CSP', () => {
		const res = new Response('x', { headers: { 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' } });
		const out = formFrameHeaders('/f/a', res);
		expect(out.headers.get('x-frame-options')).toBeNull();
		expect(out.headers.get('content-security-policy')).toBe('frame-ancestors *');
		const bare = formFrameHeaders('/f/a/embed.js', new Response('x'));
		expect(bare.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
		const other = formFrameHeaders('/contacts', new Response('x', { headers: { 'x-frame-options': 'DENY' } }));
		expect(other.headers.get('x-frame-options')).toBe('DENY');
	});

	it('records page_url on an embedded submission', async () => {
		const form = await makeForm('Embed Submit', withOrigins(['https://site.test']));
		const res = await submit(
			postEvent(`/f/${form.slug}/submit?embed=1`, { slug: form.slug }, [['email', 'embed1@forms.test'], ['_page_url', 'https://site.test/pricing?x=1']], { json: true })
		);
		expect(res.status).toBe(200);
		const row = await db.prepare('SELECT page_url FROM form_submissions WHERE form_id = ? ORDER BY id DESC').bind(form.id).first<{ page_url: string | null }>();
		expect(row!.page_url).toBe('https://site.test/pricing?x=1');

		// A native post inside the frame keeps embed=1 on its way to the thanks page.
		const native = await submit(postEvent(`/f/${form.slug}/submit?embed=1`, { slug: form.slug }, [['email', 'embed2@forms.test']]));
		expect(native.headers.get('location')).toMatch(/&embed=1$/);
	});
});

describe('{{form:slug}} links', () => {
	it('expands per contact; raw and percent-encoded hrefs', () => {
		expect(hasFormTags('Rate it: {{form:rate-this}}')).toBe(true);
		expect(hasFormTags('nothing here')).toBe(false);
		expect(fillFormTags('<a href="{{form:rate-this}}">Rate</a>', 'https://app.test/', 'tok')).toBe('<a href="https://app.test/f/rate-this?c=tok">Rate</a>');
		expect(fillFormTags('<a href="%7B%7Bform:rate-this%7D%7D">Rate</a>', 'https://app.test', 'tok')).toBe('<a href="https://app.test/f/rate-this?c=tok">Rate</a>');
		expect(fillFormTags('{{form:rate-this}}', 'https://app.test', null)).toBe('https://app.test/f/rate-this');
		expect(formTag('rate-this')).toBe('{{form:rate-this}}');

		const out = fillRecipientTemplates(
			{ subject: 'Hi', html: '<a href="{{form:rate-this}}">Rate {{first_name}}</a>', text: 'Rate: {{form:rate-this}}' },
			'https://app.test/unsubscribe?t=x',
			{ email: 'a@x.test', first_name: 'Ann', formBase: 'https://app.test', formToken: 'tok' },
			null
		);
		expect(out.html).toBe('<a href="https://app.test/f/rate-this?c=tok">Rate Ann</a>');
		expect(out.text).toBe('Rate: https://app.test/f/rate-this?c=tok');
	});

	it('pre-send checks treat it as a known tag', () => {
		expect(isFormTagToken('form:rate-this')).toBe(true);
		expect(findMergeTags('<a href="{{form:rate-this}}">x</a> {{form%3Arate}}').unknown).toEqual([]);
	});

	it('token round trip: a valid token prefills and hides the email; a bad one shows the plain form', async () => {
		const c = await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('rate@forms.test', 1) RETURNING id").first<{ id: number }>();
		const token = await signVisitorToken(SECRET, { c: c!.id });
		expect(await formContactFromToken(db, platformEnv, token)).toEqual({ id: c!.id, email: 'rate@forms.test' });
		expect(await formContactFromToken(db, platformEnv, 'junk')).toBeNull();
		const expired = await signVisitorToken(SECRET, { c: c!.id, exp: Math.floor(Date.now() / 1000) - 10 });
		expect(await formContactFromToken(db, platformEnv, expired)).toBeNull();

		const form = await makeForm('Rate This Issue');
		const good = getEvent(`/f/${form.slug}?c=${encodeURIComponent(token)}`, { slug: form.slug });
		const g = await run(formLoad, good);
		expect(g.result.prefill.email).toBe('rate@forms.test');
		expect(g.result.lockedKey).toBe('email');
		expect(g.result.contactToken).toBe(token);
		expect(good.headers['cache-control']).toBe('private, no-store');

		const bad = await run(formLoad, getEvent(`/f/${form.slug}?c=nope`, { slug: form.slug }));
		expect(bad.result.prefill.email).toBeUndefined();
		expect(bad.result.lockedKey).toBeNull();

		// The submit credits the token's contact, whatever the (hidden) email answer says.
		const res = await submit(postEvent(`/f/${form.slug}/submit`, { slug: form.slug }, [['email', 'someone-else@forms.test'], ['_c', token]], { json: true }));
		expect(res.status).toBe(200);
		const row = await db.prepare('SELECT email, contact_id FROM form_submissions WHERE form_id = ? ORDER BY id DESC').bind(form.id).first<{ email: string; contact_id: number }>();
		expect(row).toEqual({ email: 'rate@forms.test', contact_id: c!.id });
	});
});

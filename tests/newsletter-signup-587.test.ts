import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';

// #587: the newsletter archive's Subscribe popup — the plain (script-free) form renderer, the
// sign-up form setting, the popup markup on the index and issue pages (and the Subscribe URL
// fallback), /newsletter/subscribe (GET + POST), /newsletter/subscribe/thanks, the hooks on both
// hosts, no CRM host in public mode, the reserved slug and the unchanged CSP.

import { handle } from '../src/hooks.server';
import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { GET as subscribeGET, POST as subscribePOST } from '../src/routes/newsletter/subscribe/+server';
import { GET as thanksGET } from '../src/routes/newsletter/subscribe/thanks/+server';
import { actions as settingsActions } from '../src/routes/settings/newsletter/+page.server';
import { getArchiveSettings, publishIssue, saveArchiveSettings, SIGNUP_POPOVER_ID } from '../src/lib/server/newsletter-archive';
import { PLAIN_FIELD_TYPES, PLAIN_FORM_CSS, PLAIN_HONEYPOT_NAME, plainFormProblem, renderPlainForm } from '../src/lib/server/form-plain';
import { HONEYPOT_NAME, RATE_PER_IP } from '../src/lib/server/form-submit';
import { PUBLIC_PAGE_CSP, PUBLIC_PAGE_HEADERS } from '../src/lib/server/public-csp';
import { clearArchivePublicCache, savePublicHost, rotateProxySecret, PROXY_SECRET_HEADER } from '../src/lib/server/archive-public';
import { clearDomainCache } from '../src/lib/server/public-url';
import { createForm, getForm } from '../src/lib/server/forms';
import { blankField, emptyForm, withSettingsOutcome, type FormField, type FormSpec } from '../src/lib/forms';
import { RESERVED_ARCHIVE_SLUGS, validArchiveSlug } from '../src/lib/newsletter-archive';

const db = (env as { DB: D1Database }).DB;
const CRM = 'https://crm.test';
const CRM_HOST = 'crm.test';
const PUB = 'ourco.example';
const platformEnv = () => ({ ...(env as any), PUBLIC_BASE_URL: CRM, SESSION_SECRET: 'secret' });
const admin = { id: 1, login: 'ourco-admin', role: 'admin' };

type Res = { status: number; location: string | null; body: string; headers: Headers };

/** A request through hooks.server.ts, resolved by `route`. */
async function hit(
	url: string,
	route: (e: any) => Response | Promise<Response>,
	opts: { method?: string; headers?: Record<string, string>; form?: [string, string][]; params?: Record<string, string> } = {}
): Promise<Res> {
	let body: FormData | undefined;
	if (opts.form) {
		body = new FormData();
		for (const [k, v] of opts.form) body.append(k, v);
	}
	const event = {
		request: new Request(url, { method: opts.method ?? 'GET', headers: opts.headers, body }),
		url: new URL(url),
		params: opts.params ?? {},
		route: { id: null },
		locals: {} as App.Locals,
		cookies: { get: () => undefined, set() {}, delete() {}, getAll: () => [], serialize: () => '' },
		platform: { env: platformEnv() },
		isDataRequest: false,
		isSubRequest: false
	};
	// Like SvelteKit's own resolve: await the route at once and turn an HttpError into a response.
	// Returning `route(ev)` from an async arrow left a route that throws before its first await
	// (the issue route's slug check) as a rejected promise with no handler for one microtask,
	// which workerd reports as an unhandled rejection.
	const resolve = async (ev: unknown): Promise<Response> => {
		try {
			return await route(ev);
		} catch (e) {
			if (isHttpError(e)) return new Response(e.body.message, { status: e.status });
			throw e;
		}
	};
	try {
		const res = await handle({ event: event as never, resolve: resolve as never } as never);
		return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, location: null, body: '', headers: new Headers() };
		throw e;
	}
}

/** A sign-up POST (multipart, like a browser) from `origin` to `url`. */
const post = (url: string, fields: [string, string][], origin: string, ip = '198.51.100.9', extra: Record<string, string> = {}) =>
	hit(url, subscribePOST, { method: 'POST', form: fields, headers: { origin, 'cf-connecting-ip': ip, ...extra } });

async function reset() {
	await db.batch([
		db.prepare('DELETE FROM form_submissions'),
		db.prepare('DELETE FROM forms'),
		db.prepare('DELETE FROM rate_limits'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare("DELETE FROM contacts WHERE email LIKE '%@signup.test'"),
		db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%' OR key LIKE 'custom_domain%'")
	]);
	clearArchivePublicCache();
	clearDomainCache();
}
beforeEach(reset);
afterEach(reset);

async function makeForm(name: string, edit: (spec: FormSpec) => FormSpec = (s) => s, status = 'published') {
	const id = await createForm(db, name, admin.id);
	const spec = edit(withSettingsOutcome(emptyForm(name), [{ type: 'message_md', md: 'You are **in**.' }]));
	await db.prepare('UPDATE forms SET spec = ?, status = ? WHERE id = ?').bind(JSON.stringify(spec), status, id).run();
	return (await getForm(db, id))!;
}

let slug = '';
/** Archive on with a published issue; `signup` = the chosen form's slug ('' = none). */
async function seed(opts: { signup?: string; subscribeUrl?: string } = {}) {
	const listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id").first<{ id: number }>())!.id;
	const err = await saveArchiveSettings(db, {
		enabled: true,
		title: 'Newsletter',
		intro: '',
		subscribeUrl: opts.subscribeUrl ?? '',
		templateId: null,
		indexable: true,
		autoGroups: [],
		signupForm: opts.signup ?? ''
	});
	expect(err).toBeNull();
	const cid = (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at)
			 VALUES ('Big news', 'Issue body', '<p>Issue body</p>', ?, 'alan@ourco.example', 'sent', '2026-10-14 15:00:00') RETURNING id`
		)
		.bind(listId)
		.first<{ id: number }>())!.id;
	const r = await publishIssue(db, cid);
	expect(r.ok).toBe(true);
	slug = r.ok ? r.slug : '';
}

const field = (type: FormField['type'], key: string, label: string, extra: Partial<FormField> = {}): FormField => ({
	...blankField(type, label),
	key,
	...extra
});

// ---------------------------------------------------------------------------------------

describe('plain renderer', () => {
	const opts = [
		{ value: 'a', label: 'Alpha' },
		{ value: 'b', label: 'Beta' }
	];
	const spec = (fields: FormField[]): FormSpec => ({ ...emptyForm('Join us'), fields });

	it('renders every supported field type as a native control', () => {
		const html = renderPlainForm(
			spec([
				field('email', 'email', 'Email', { required: true, map: { to: 'contact', field: 'email' } }),
				field('short_text', 'first', 'First name', { map: { to: 'contact', field: 'first_name' }, placeholder: 'Ann' }),
				field('long_text', 'about', 'About you'),
				field('phone', 'phone', 'Phone'),
				field('number', 'size', 'Team size'),
				field('url', 'site', 'Website'),
				field('date', 'when', 'Start date'),
				field('select', 'pick', 'Pick one', { options: opts }),
				field('radio', 'role', 'Role', { options: opts, required: true }),
				field('checkboxes', 'likes', 'Likes', { options: opts }),
				field('checkbox', 'beta', 'Join the beta'),
				field('consent', 'ok', 'I agree', { required: true }),
				field('topics', 'topics', 'Topics', { options: [{ value: '7', label: 'Weekly' }] }),
				field('hidden', 'src', ''),
				field('heading', 'h', 'More about you'),
				field('paragraph', 'p', 'Some **bold** words')
			]),
			{ action: '/newsletter/subscribe' }
		);
		expect(html).toContain('<form method="post" action="/newsletter/subscribe"');
		expect(html).toMatch(/<input id="[^"]+" type="email" name="email" autocomplete="email"[^>]* required>/);
		expect(html).toContain('<span class="nl-req" aria-hidden="true"> *</span>');
		expect(html).toMatch(/type="text" name="first" autocomplete="given-name" placeholder="Ann"/);
		expect(html).toMatch(/<textarea [^>]*name="about"/);
		expect(html).toContain('type="tel" name="phone"');
		expect(html).toContain('type="number" name="size"');
		expect(html).toContain('type="url" name="site"');
		expect(html).toContain('type="date" name="when"');
		expect(html).toMatch(/<select [^>]*name="pick"[^>]*><option value="">Choose…<\/option><option value="a">Alpha<\/option>/);
		expect(html).toContain('<input type="radio" name="role" value="a" required>');
		expect(html).toContain('<input type="checkbox" name="likes" value="b">');
		expect(html).toContain('<input type="checkbox" name="beta" value="on">');
		expect(html).toContain('<input type="checkbox" name="ok" value="on" required>');
		expect(html).toContain('<input type="checkbox" name="topics" value="7">');
		expect(html).toContain('<input type="hidden" name="src" value="">');
		expect(html).toContain('<h3 class="nl-form-h">More about you</h3>');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain(`name="${PLAIN_HONEYPOT_NAME}" tabindex="-1"`);
		expect(html).toContain('<button type="submit" class="nl-form-submit">');
		expect(html).toContain('--f-accent:');
		expect(html).not.toMatch(/<script|\son\w+=/i);
	});

	it('honeypot name matches the submit path', () => {
		expect(PLAIN_HONEYPOT_NAME).toBe(HONEYPOT_NAME);
	});

	it('escapes everything from the spec', () => {
		const evil = '"><script>alert(1)</script>';
		const s: FormSpec = {
			...emptyForm(`T ${evil}`),
			intro_md: `Hi <img src=x onerror=alert(1)>`,
			fields: [
				field('select', 'k', `L ${evil}`, { help: `H ${evil}`, placeholder: evil, options: [{ value: evil, label: evil }] }),
				field('paragraph', 'p', `<iframe src="javascript:alert(1)"></iframe>`)
			]
		};
		s.settings = { ...s.settings, submit_label: evil };
		const html = renderPlainForm(s, { action: '/newsletter/subscribe', error: evil });
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<iframe');
		expect(html).toContain('&lt;script&gt;');
	});

	it('autofocus on the first field only', () => {
		const html = renderPlainForm(
			{ ...emptyForm('A'), fields: [field('heading', 'h', 'Hi'), field('email', 'email', 'Email'), field('short_text', 'n', 'Name')] },
			{ action: '/x', autofocus: true }
		);
		expect(html.match(/autofocus/g)).toHaveLength(1);
		expect(html).toMatch(/name="email"[^>]*autofocus/);
	});

	it('refuses multi-page forms, conditional logic and unknown types; accepts the rest', () => {
		const ok = { status: 'published', spec: emptyForm('A') };
		expect(plainFormProblem(ok)).toBeNull();
		expect(plainFormProblem({ ...ok, status: 'draft' })).toMatch(/isn’t published/);
		expect(plainFormProblem({ status: 'published', spec: { ...emptyForm('A'), fields: [...emptyForm('A').fields, field('page_break', 'pb', 'Two')] } })).toMatch(
			/more than one page/
		);
		const logic = field('short_text', 'x', 'X', { show_when: { match: 'all', rules: [{ field: 'email', op: 'not_empty', value: '' }] } as any });
		expect(plainFormProblem({ status: 'published', spec: { ...emptyForm('A'), fields: [...emptyForm('A').fields, logic] } })).toMatch(/conditional logic/);
		const odd = { ...field('short_text', 'y', 'Y'), type: 'signature' as any };
		expect(plainFormProblem({ status: 'published', spec: { ...emptyForm('A'), fields: [odd] } })).toMatch(/can’t show without script/);
		expect(PLAIN_FIELD_TYPES).not.toContain('page_break');
	});
});

describe('setting', () => {
	it('stores a usable published form; refuses with the reason otherwise', async () => {
		const good = await makeForm('Signup Good');
		const draft = await makeForm('Signup Draft', (s) => s, 'draft');
		const paged = await makeForm('Signup Paged', (s) => ({ ...s, fields: [...s.fields, field('page_break', 'pb', 'Page 2')] }));
		const base = { enabled: true, title: 'N', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] };
		expect(await saveArchiveSettings(db, { ...base, signupForm: good.slug })).toBeNull();
		expect((await getArchiveSettings(db)).signupForm).toBe(good.slug);
		expect(await saveArchiveSettings(db, { ...base, signupForm: draft.slug })).toMatch(/isn’t published/);
		expect(await saveArchiveSettings(db, { ...base, signupForm: paged.slug })).toMatch(/more than one page/);
		expect(await saveArchiveSettings(db, { ...base, signupForm: 'no-such-form' })).toMatch(/no longer exists/);
		// Refused saves leave the stored choice; omitting the key keeps it too; '' clears it.
		expect((await getArchiveSettings(db)).signupForm).toBe(good.slug);
		expect(await saveArchiveSettings(db, base)).toBeNull();
		expect((await getArchiveSettings(db)).signupForm).toBe(good.slug);
		expect(await saveArchiveSettings(db, { ...base, signupForm: '' })).toBeNull();
		expect((await getArchiveSettings(db)).signupForm).toBe('');
	});

	it('the Settings action saves signup_form and returns the refusal', async () => {
		const paged = await makeForm('Signup Action', (s) => ({ ...s, fields: [...s.fields, field('page_break', 'pb', 'Page 2')] }));
		const fd = new FormData();
		fd.set('enabled', '1');
		fd.set('title', 'Newsletter');
		fd.set('signup_form', paged.slug);
		const res: any = await settingsActions.save({
			locals: { user: admin },
			platform: { env: platformEnv() },
			request: new Request(`${CRM}/settings/newsletter?/save`, { method: 'POST', body: fd })
		} as any);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/more than one page/);
	});
});

describe('archive pages', () => {
	it('popup markup only when a form is chosen; the bottom box button opens the same popup', async () => {
		const form = await makeForm('Signup Pages');
		await seed({ signup: form.slug, subscribeUrl: 'https://example.com/join' });
		for (const res of [await hit(`${CRM}/newsletter`, indexGET), await hit(`${CRM}/newsletter/${slug}`, issueGET, { params: { slug } })]) {
			expect(res.status).toBe(200);
			expect(res.body).toContain(`<div id="${SIGNUP_POPOVER_ID}" class="nl-pop" popover`);
			expect(res.body).toContain('popovertargetaction="hide">Close</button>');
			expect(res.body.match(new RegExp(`popovertarget="${SIGNUP_POPOVER_ID}">Subscribe</button>`, 'g'))).toHaveLength(2); // top + box
			expect(res.body).toContain('<p class="nl-top-sub">');
			expect(res.body).toContain('href="/newsletter/subscribe"'); // no-popover fallback
			expect(res.body).toContain('@supports selector(:popover-open)');
			expect(res.body).toContain('action="/newsletter/subscribe"');
			expect(res.body).not.toContain('https://example.com/join');
			expect(res.body).not.toMatch(/<script/i);
			expect(res.headers.get('content-security-policy')).toBe(PUBLIC_PAGE_CSP);
		}
	});

	it('no form chosen: no popup, the Subscribe URL link as before', async () => {
		await seed({ subscribeUrl: 'https://example.com/join' });
		for (const res of [await hit(`${CRM}/newsletter`, indexGET), await hit(`${CRM}/newsletter/${slug}`, issueGET, { params: { slug } })]) {
			expect(res.status).toBe(200);
			expect(res.body).not.toContain('popovertarget');
			expect(res.body).not.toContain('class="nl-pop"');
			expect(res.body).not.toContain('nl-top-sub');
			expect(res.body).toContain('<a class="nl-sub-btn" href="https://example.com/join">Subscribe</a>');
		}
	});

	it('the Close button is its own sticky row, not a float that narrows the form', () => {
		const close = PLAIN_FORM_CSS.match(/\.nl-pop-close \{([^}]*)\}/)?.[1] ?? '';
		expect(close).not.toMatch(/float/);
		expect(close).toMatch(/position:sticky; top:0; display:block;/);
		expect(close).toMatch(/margin:-12px -12px 8px auto;/);
		expect(close).toMatch(/min-width:44px; min-height:44px;/);
	});

	it('a chosen form that was unpublished later falls back to the link and 404s the page', async () => {
		const form = await makeForm('Signup Gone');
		await seed({ signup: form.slug, subscribeUrl: 'https://example.com/join' });
		await db.prepare("UPDATE forms SET status = 'draft' WHERE id = ?").bind(form.id).run();
		const res = await hit(`${CRM}/newsletter`, indexGET);
		expect(res.body).not.toContain('popovertarget');
		expect(res.body).toContain('https://example.com/join');
		expect((await hit(`${CRM}/newsletter/subscribe`, subscribeGET)).status).toBe(404);
	});
});

describe('/newsletter/subscribe', () => {
	it('GET: the form page, ?error= message, 404 while off or none chosen', async () => {
		expect((await hit(`${CRM}/newsletter/subscribe`, subscribeGET)).status).toBe(404);
		await seed();
		expect((await hit(`${CRM}/newsletter/subscribe`, subscribeGET)).status).toBe(404); // archive on, no form
		const form = await makeForm('Signup Get');
		expect(await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [], signupForm: form.slug })).toBeNull();
		const page = await hit(`${CRM}/newsletter/subscribe`, subscribeGET);
		expect(page.status).toBe(200);
		expect(page.body).toContain('<h1 class="nl-form-title"');
		expect(page.body).toContain('action="/newsletter/subscribe"');
		expect(page.headers.get('content-security-policy')).toBe(PUBLIC_PAGE_CSP);
		const err = await hit(`${CRM}/newsletter/subscribe?error=rate_limit`, subscribeGET);
		expect(err.body).toContain('Too many submissions');
		expect(err.headers.get('cache-control')).toBe('no-store');
		expect((await hit(`${CRM}/newsletter/subscribe?error=junk`, subscribeGET)).body).toContain('Something went wrong');
		expect((await hit(`${CRM}/newsletter/subscribe?error=constructor`, subscribeGET)).body).toContain('Something went wrong');
		await db.prepare("UPDATE app_state SET value = '0' WHERE key = 'archive_enabled'").run();
		expect((await hit(`${CRM}/newsletter/subscribe`, subscribeGET)).status).toBe(404);
	});

	it('POST on the CRM host: success → thanks; contact added; thanks shows the message', async () => {
		const form = await makeForm('Signup Post');
		await seed({ signup: form.slug });
		const res = await post(`${CRM}/newsletter/subscribe`, [['email', 'ann@signup.test']], CRM);
		expect(res.status).toBe(303);
		expect(res.location).toBe('/newsletter/subscribe/thanks');
		const c = await db.prepare("SELECT subscribed, source FROM contacts WHERE email = 'ann@signup.test'").first<{ subscribed: number; source: string }>();
		expect(c?.subscribed).toBe(1);
		const sub = await db.prepare('SELECT status FROM form_submissions WHERE form_id = ?').bind(form.id).first<{ status: string }>();
		expect(sub?.status).toBe('added');
		const thanks = await hit(`${CRM}/newsletter/subscribe/thanks`, thanksGET);
		expect(thanks.status).toBe(200);
		expect(thanks.body).toContain('<strong>in</strong>');
		expect(thanks.body).toContain('href="/newsletter"');
		expect(thanks.headers.get('content-security-policy')).toBe(PUBLIC_PAGE_CSP);
	});

	it('POST: honeypot → thanks, stored as spam, no contact', async () => {
		const form = await makeForm('Signup Spam');
		await seed({ signup: form.slug });
		const res = await post(`${CRM}/newsletter/subscribe`, [['email', 'bot@signup.test'], [HONEYPOT_NAME, 'http://spam']], CRM);
		expect(res.location).toBe('/newsletter/subscribe/thanks');
		expect(await db.prepare("SELECT id FROM contacts WHERE email = 'bot@signup.test'").first()).toBeNull();
		const sub = await db.prepare('SELECT status FROM form_submissions WHERE form_id = ?').bind(form.id).first<{ status: string }>();
		expect(sub?.status).toBe('spam');
	});

	it('POST: a bad email bounces back with ?error=invalid', async () => {
		const form = await makeForm('Signup Bad');
		await seed({ signup: form.slug });
		const res = await post(`${CRM}/newsletter/subscribe`, [['email', 'not-an-email']], CRM);
		expect(res.status).toBe(303);
		expect(res.location).toBe('/newsletter/subscribe?error=invalid');
	});

	it('POST: rate limited per visitor', async () => {
		const form = await makeForm('Signup Rate');
		await seed({ signup: form.slug });
		for (let i = 0; i < RATE_PER_IP; i++) {
			const r = await post(`${CRM}/newsletter/subscribe`, [['email', 'not-an-email']], CRM, '203.0.113.5');
			expect(r.location).toBe('/newsletter/subscribe?error=invalid');
		}
		const r = await post(`${CRM}/newsletter/subscribe`, [['email', 'rate@signup.test']], CRM, '203.0.113.5');
		expect(r.location).toBe('/newsletter/subscribe?error=rate_limit');
	});

	it('POST: a foreign Origin is refused on the CRM host (CSRF-exempt, origin checked by the form)', async () => {
		const form = await makeForm('Signup Origin');
		await seed({ signup: form.slug });
		const res = await post(`${CRM}/newsletter/subscribe`, [['email', 'o@signup.test']], 'https://evil.test');
		expect(res.status).toBe(303);
		expect(res.location).toBe('/newsletter/subscribe?error=origin');
		expect(await db.prepare("SELECT id FROM contacts WHERE email = 'o@signup.test'").first()).toBeNull();
	});

	it('POST: 404 when no form is chosen', async () => {
		await seed();
		expect((await post(`${CRM}/newsletter/subscribe`, [['email', 'x@signup.test']], CRM)).status).toBe(404);
	});

	it('the thanks page forwards to a redirect outcome without a CRM link', async () => {
		const form = await makeForm('Signup Redirect', (s) => withSettingsOutcome(s, [{ type: 'redirect', url: 'https://example.com/welcome' }]));
		await seed({ signup: form.slug });
		const res = await post(`${CRM}/newsletter/subscribe`, [['email', 'r@signup.test']], CRM);
		expect(res.location).toBe('/newsletter/subscribe/thanks');
		const thanks = await hit(`${CRM}/newsletter/subscribe/thanks`, thanksGET);
		expect(thanks.body).toContain('<meta http-equiv="refresh" content="0; url=https://example.com/welcome">');
		expect(thanks.body).toContain('href="https://example.com/welcome"');
	});
});

describe('public host', () => {
	const leaks = (s: string) => {
		expect(s).not.toContain(CRM_HOST);
		expect(s).not.toContain('crm.myapp.example');
	};

	it('every page renders with no CRM host; root-relative action and links', async () => {
		const form = await makeForm('Signup Public');
		await seed({ signup: form.slug });
		await savePublicHost(db, PUB);
		const pages = [
			await hit(`https://${PUB}/newsletter`, indexGET),
			await hit(`https://${PUB}/newsletter/${slug}`, issueGET, { params: { slug } }),
			await hit(`https://${PUB}/newsletter/subscribe`, subscribeGET),
			await hit(`https://${PUB}/newsletter/subscribe/thanks`, thanksGET)
		];
		for (const p of pages) {
			expect(p.status).toBe(200);
			leaks(p.body);
			expect(p.headers.get('content-security-policy')).toBe(PUBLIC_PAGE_CSP);
			expect(p.headers.get('x-content-type-options')).toBe(PUBLIC_PAGE_HEADERS['X-Content-Type-Options']);
		}
		expect(pages[0].body).toContain('action="/newsletter/subscribe"');
		expect(pages[2].body).toContain('action="/newsletter/subscribe"');
	});

	it('POST on the public host (its own origin) works; a foreign origin is refused', async () => {
		const form = await makeForm('Signup Public Post');
		await seed({ signup: form.slug });
		await savePublicHost(db, PUB);
		const ok = await post(`https://${PUB}/newsletter/subscribe`, [['email', 'pub@signup.test']], `https://${PUB}`);
		expect(ok.status).toBe(303);
		expect(ok.location).toBe('/newsletter/subscribe/thanks');
		expect(await db.prepare("SELECT id FROM contacts WHERE email = 'pub@signup.test'").first()).not.toBeNull();
		const bad = await post(`https://${PUB}/newsletter/subscribe`, [['email', 'pub2@signup.test']], 'https://evil.test');
		expect(bad.location).toBe('/newsletter/subscribe?error=origin');
	});

	it('POST through a proxy (secret): the public origin is allowed', async () => {
		const form = await makeForm('Signup Proxy');
		await seed({ signup: form.slug });
		await savePublicHost(db, PUB);
		const secret = await rotateProxySecret(db);
		const res = await post(`${CRM}/newsletter/subscribe`, [['email', 'proxy@signup.test']], `https://${PUB}`, '198.51.100.20', { [PROXY_SECRET_HEADER]: secret });
		expect(res.location).toBe('/newsletter/subscribe/thanks');
	});

	it('no other path opens up on the public host', async () => {
		await savePublicHost(db, PUB);
		const app = async () => new Response('app');
		expect((await hit(`https://${PUB}/f/anything`, app)).status).toBe(404);
		expect((await hit(`https://${PUB}/f/anything/submit`, app, { method: 'POST', form: [['email', 'x@signup.test']], headers: { origin: `https://${PUB}` } })).status).toBe(404);
		expect((await hit(`https://${PUB}/_app/immutable/x.js`, app)).status).toBe(404);
	});
});

describe('reserved slug', () => {
	it('subscribe (and the other route names) are never an issue slug', () => {
		for (const s of RESERVED_ARCHIVE_SLUGS) expect(validArchiveSlug(s)).toBe(false);
		expect(validArchiveSlug('2026-10-14-big-news')).toBe(true);
	});

	it('/newsletter/subscribe is never served by the issue route', async () => {
		await seed();
		await db.prepare("UPDATE campaigns SET archive_slug = 'subscribe'").run();
		expect((await hit(`${CRM}/newsletter/subscribe`, issueGET, { params: { slug: 'subscribe' } })).status).toBe(404);
	});
});

describe('CSP', () => {
	it('is unchanged', () => {
		expect(PUBLIC_PAGE_CSP).toBe(
			"default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https:; img-src http: https: data:; font-src https: data:; media-src https:; frame-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'"
		);
	});
});

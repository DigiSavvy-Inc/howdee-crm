import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { load as formLoad } from '../src/routes/f/[slug]/+page.server';
import { POST as submit } from '../src/routes/f/[slug]/submit/+server';
import { load as thanksLoad } from '../src/routes/f/[slug]/thanks/+page.server';
import { load as builderLoad, actions as builder } from '../src/routes/forms/[id]/+page.server';
import { actions as newForm } from '../src/routes/forms/new/+page.server';
import { GET as csvGET } from '../src/routes/forms/[id]/submissions.csv/+server';
import { emptyForm, withSettingsOutcome } from '../src/lib/forms';
import { createForm, getForm, signSubmissionId } from '../src/lib/server/forms';

// #509: public form page (published only), the submit endpoint (JSON + native post), the
// thanks page, and the builder's admin-only actions.

const db = (env as any).DB as D1Database;
const platformEnv = { ...(env as any), SESSION_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://app.test' };
const admin = { id: 1, login: 'ourco-admin', role: 'admin' };
const member = { id: 2, login: 'pat', role: 'member' };

function getEvent(path: string, params: Record<string, string>, user: unknown = null) {
	const url = new URL(`https://app.test${path}`);
	const headers: Record<string, string> = {};
	return {
		platform: { env: platformEnv },
		params,
		url,
		locals: { user },
		request: new Request(url),
		setHeaders: (h: Record<string, string>) => Object.assign(headers, h),
		headers
	} as any;
}
function postEvent(path: string, params: Record<string, string>, fields: [string, string][], opts: { json?: boolean; origin?: string; user?: unknown } = {}) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test${path}`);
	const headers: Record<string, string> = { origin: opts.origin ?? 'https://app.test', 'cf-connecting-ip': '198.51.100.7' };
	if (opts.json) headers.accept = 'application/json';
	return { platform: { env: platformEnv }, params, url, locals: { user: opts.user ?? null }, request: new Request(url, { method: 'POST', body: fd, headers }) } as any;
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

async function makeForm(slugName: string, publish: boolean) {
	const id = await createForm(db, slugName, admin.id);
	const spec = withSettingsOutcome(emptyForm(slugName), [{ type: 'message_md', md: 'All done!' }]);
	await db.prepare(`UPDATE forms SET spec = ?, status = ? WHERE id = ?`).bind(JSON.stringify(spec), publish ? 'published' : 'draft', id).run();
	return (await getForm(db, id))!;
}

describe('public form', () => {
	it('a draft 404s; a published form renders with prefill, cache and noindex headers', async () => {
		const draft = await makeForm('Route Draft', false);
		expect((await run(formLoad, getEvent(`/f/${draft.slug}`, { slug: draft.slug }))).status).toBe(404);
		expect((await run(formLoad, getEvent('/f/nope', { slug: 'nope' }))).status).toBe(404);

		const pub = await makeForm('Route Live', true);
		const e = getEvent(`/f/${pub.slug}?email=ann@x.test&utm_source=news&unknown=1`, { slug: pub.slug });
		const { result } = await run(formLoad, e);
		expect(result.spec.title).toBe('Route Live');
		expect(result.prefill).toEqual({ email: 'ann@x.test', utm_source: 'news' });
		expect(e.headers['cache-control']).toBe('public, max-age=300');
		expect(e.headers.etag).toBe(`W/"form-${pub.id}-v${pub.version}"`);
		expect(e.headers['x-robots-tag']).toBe('noindex');
	});

	it('submit: JSON gets the message; a native post 303s to a signed thanks page', async () => {
		const pub = await makeForm('Route Submit', true);
		const res = await submit(postEvent(`/f/${pub.slug}/submit`, { slug: pub.slug }, [['email', 'route1@forms.test']], { json: true }));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(body.message_html).toContain('All done!');

		const native = await submit(postEvent(`/f/${pub.slug}/submit`, { slug: pub.slug }, [['email', 'route2@forms.test'], ['_utm_source', 'x']]));
		expect(native.status).toBe(303);
		const loc = native.headers.get('location')!;
		expect(loc).toMatch(new RegExp(`^/f/${pub.slug}/thanks\\?s=`));
		const s = new URL(`https://app.test${loc}`).searchParams.get('s')!;
		const thanks = await run(thanksLoad, getEvent(loc, { slug: pub.slug }));
		expect(thanks.result.message_html).toContain('All done!');

		// A forged or foreign token → 404.
		expect((await run(thanksLoad, getEvent(`/f/${pub.slug}/thanks?s=1.AAAAAAAAAAAAAAAA`, { slug: pub.slug }))).status).toBe(404);
		const other = await makeForm('Route Other', true);
		expect((await run(thanksLoad, getEvent(`/f/${other.slug}/thanks?s=${s}`, { slug: other.slug }))).status).toBe(404);
	});

	it('the thanks page follows a redirect outcome', async () => {
		const pub = await makeForm('Route Redirect', true);
		const spec = withSettingsOutcome(pub.spec, [{ type: 'redirect', url: 'https://example.com/done' }]);
		await db.prepare('UPDATE forms SET spec = ? WHERE id = ?').bind(JSON.stringify(spec), pub.id).run();
		const sub = await db.prepare("INSERT INTO form_submissions (form_id, status, answers) VALUES (?, 'anonymous', '{}') RETURNING id").bind(pub.id).first<{ id: number }>();
		const s = await signSubmissionId('test-secret', sub!.id);
		const r = await run(thanksLoad, getEvent(`/f/${pub.slug}/thanks?s=${s}`, { slug: pub.slug }));
		expect(r.redirect).toBe('https://example.com/done');
	});

	it('submit: wrong origin 403s, invalid answers bounce back with ?error=', async () => {
		const pub = await makeForm('Route Guard', true);
		const evil = await submit(postEvent(`/f/${pub.slug}/submit`, { slug: pub.slug }, [['email', 'g@forms.test']], { json: true, origin: 'https://evil.test' }));
		expect(evil.status).toBe(403);
		const bad = await submit(postEvent(`/f/${pub.slug}/submit`, { slug: pub.slug }, [['email', 'not-an-email']]));
		expect(bad.status).toBe(303);
		expect(bad.headers.get('location')).toBe(`/f/${pub.slug}?error=invalid`);
		const draft = await makeForm('Route Draft Submit', false);
		expect((await submit(postEvent(`/f/${draft.slug}/submit`, { slug: draft.slug }, [['email', 'd@forms.test']], { json: true }))).status).toBe(404);
	});
});

describe('builder', () => {
	it('members can look but not change; admins save, publish and unpublish', async () => {
		const f = await makeForm('Builder One', false);
		const look = await run(builderLoad, getEvent(`/forms/${f.id}`, { id: String(f.id) }, member));
		expect(look.result.isAdmin).toBe(false);
		expect(look.result.users).toEqual([]);

		const asMember = await run(builder.save!, postEvent(`/forms/${f.id}?/save`, { id: String(f.id) }, [['name', 'x'], ['slug', 'x'], ['spec', '{}']], { user: member }));
		expect(asMember.status).toBe(403);

		const spec = { ...f.spec, title: 'Renamed' };
		const saved = await run(builder.save!, postEvent(`/forms/${f.id}?/save`, { id: String(f.id) }, [['name', 'Builder One'], ['slug', 'builder-one'], ['spec', JSON.stringify(spec)]], { user: admin }));
		expect(saved.result).toMatchObject({ saved: true });
		expect((await getForm(db, f.id))!.spec.title).toBe('Renamed');

		const noEmail = { ...spec, fields: [] };
		const refused = await run(builder.save!, postEvent(`/forms/${f.id}?/save`, { id: String(f.id) }, [['name', 'Builder One'], ['slug', 'builder-one'], ['spec', JSON.stringify(noEmail)]], { user: admin }));
		expect(refused.result.status).toBe(400);
		expect(refused.result.data.problems[0].path).toBe('fields');

		const other = await makeForm('Builder Two', false);
		const taken = await run(builder.save!, postEvent(`/forms/${f.id}?/save`, { id: String(f.id) }, [['name', 'Builder One'], ['slug', other.slug], ['spec', JSON.stringify(spec)]], { user: admin }));
		expect(taken.result.data.problems.some((p: any) => p.path === 'slug')).toBe(true);

		await run(builder.publish!, postEvent(`/forms/${f.id}?/publish`, { id: String(f.id) }, [], { user: admin }));
		const live = (await getForm(db, f.id))!;
		expect(live.status).toBe('published');
		// Saving a published form bumps its version (the page's cache key).
		await run(builder.save!, postEvent(`/forms/${f.id}?/save`, { id: String(f.id) }, [['name', 'Builder One'], ['slug', 'builder-one'], ['spec', JSON.stringify({ ...spec, title: 'Again' })]], { user: admin }));
		expect((await getForm(db, f.id))!.version).toBe(live.version + 1);

		await run(builder.unpublish!, postEvent(`/forms/${f.id}?/unpublish`, { id: String(f.id) }, [], { user: admin }));
		expect((await getForm(db, f.id))!.status).toBe('draft');

		const dup = await run(builder.duplicate!, postEvent(`/forms/${f.id}?/duplicate`, { id: String(f.id) }, [], { user: admin }));
		expect(dup.redirect).toMatch(/^\/forms\/\d+$/);
		const copy = (await getForm(db, Number(dup.redirect!.split('/').pop())))!;
		expect(copy.name).toBe('Builder One (copy)');
		expect(copy.status).toBe('draft');
		expect(copy.slug).not.toBe('builder-one');
	});

	it('new form is admin-only and starts as a draft', async () => {
		expect((await run(newForm.default!, postEvent('/forms/new', {}, [['name', 'Fresh form']], { user: member }))).status).toBe(403);
		const r = await run(newForm.default!, postEvent('/forms/new', {}, [['name', 'Fresh form']], { user: admin }));
		const f = (await getForm(db, Number(r.redirect!.split('/').pop())))!;
		expect(f).toMatchObject({ name: 'Fresh form', slug: 'fresh-form', status: 'draft' });
		expect(f.spec.fields[0].map).toEqual({ to: 'contact', field: 'email' });
	});

	it('CSV needs a session and returns the submissions', async () => {
		const pub = await makeForm('Route CSV', true);
		await submit(postEvent(`/f/${pub.slug}/submit`, { slug: pub.slug }, [['email', 'csvroute@forms.test']], { json: true }));
		expect((await run(csvGET, getEvent(`/forms/${pub.id}/submissions.csv`, { id: String(pub.id) }))).status).toBe(401);
		const res = (await csvGET(getEvent(`/forms/${pub.id}/submissions.csv`, { id: String(pub.id) }, member))) as Response;
		expect(res.headers.get('content-type')).toContain('text/csv');
		expect(await res.text()).toContain('csvroute@forms.test');
	});
});

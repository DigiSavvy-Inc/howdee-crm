import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	BRAND_HREF,
	DEFAULT_APP_NAME,
	DEFAULT_SHORT_NAME,
	brandLinkLabel,
	logoUrlFor
} from '../src/lib/branding';
import {
	buildManifest,
	getBranding,
	unsafeSvg,
	validateBrandingText,
	validateLogoFile
} from '../src/lib/server/branding';
import { swPolicyFor } from '../src/lib/sw-policy';
import { actions } from '../src/routes/settings/+page.server';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { GET as manifestGET } from '../src/routes/manifest.webmanifest/+server';
import { GET as logoGET } from '../src/routes/img/branding/[file]/+server';

// #188: Settings → General → Branding (app name, short name, logo).

const db = (env as any).DB as D1Database;
const admin = { id: 1, role: 'admin' };
const member = { id: 2, role: 'member' };

/** Minimal in-memory R2 stand-in (put/get/delete). */
function fakeBucket() {
	const store = new Map<string, { bytes: ArrayBuffer; type: string }>();
	const bucket = {
		store,
		async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
			store.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? '' });
		},
		async get(key: string) {
			const o = store.get(key);
			if (!o) return null;
			return { body: o.bytes, httpMetadata: { contentType: o.type }, httpEtag: '"e"' };
		},
		async delete(key: string) {
			store.delete(key);
		}
	};
	return bucket;
}

function actionEv(fd: FormData, user: unknown, bucket?: unknown) {
	const url = 'https://crm.test/settings';
	return {
		request: new Request(url, { method: 'POST', body: fd }),
		url: new URL(url),
		platform: { env: { ...(env as any), MEDIA: bucket } },
		locals: { user }
	} as any;
}

function form(fields: Record<string, string>, logo?: File) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	if (logo) fd.set('logo', logo);
	return fd;
}

const PNG = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'logo.png', { type: 'image/png' });

beforeEach(async () => {
	await db.prepare(`DELETE FROM app_state WHERE key IN ('app_name', 'app_short_name', 'logo_key')`).run();
});

describe('validation', () => {
	it('caps the names and maps blank to the default', () => {
		expect(validateBrandingText('  Acme Mail  ', ' Acme ')).toEqual({ ok: true, appName: 'Acme Mail', shortName: 'Acme' });
		expect(validateBrandingText('', '')).toEqual({ ok: true, appName: null, shortName: null });
		expect(validateBrandingText('x'.repeat(40), 'y'.repeat(12)).ok).toBe(true);
		expect(validateBrandingText('x'.repeat(41), '').ok).toBe(false);
		expect(validateBrandingText('', 'y'.repeat(13)).ok).toBe(false);
	});

	it('accepts PNG/SVG/WebP up to 512 KB only', () => {
		expect(validateLogoFile({ type: 'image/png', size: 10 })).toEqual({ ok: true, ext: 'png' });
		expect(validateLogoFile({ type: 'image/svg+xml', size: 10 })).toEqual({ ok: true, ext: 'svg' });
		expect(validateLogoFile({ type: 'image/webp', size: 512 * 1024 })).toEqual({ ok: true, ext: 'webp' });
		expect(validateLogoFile({ type: 'image/webp', size: 512 * 1024 + 1 })).toMatchObject({ ok: false, status: 413 });
		expect(validateLogoFile({ type: 'image/jpeg', size: 10 })).toMatchObject({ ok: false, status: 415 });
		expect(validateLogoFile({ type: 'image/png', size: 0 })).toMatchObject({ ok: false });
	});

	it('flags script-bearing SVGs', () => {
		expect(unsafeSvg('<svg><circle r="4"/></svg>')).toBe(false);
		expect(unsafeSvg('<svg><script>alert(1)</script></svg>')).toBe(true);
		expect(unsafeSvg('<svg onload="x()"></svg>')).toBe(true);
		expect(unsafeSvg('<svg><a href="javascript:x()"/></svg>')).toBe(true);
	});

	it('only builds logo URLs for branding keys', () => {
		expect(logoUrlFor('branding/logo-0123456789abcdef.png')).toBe('/img/branding/logo-0123456789abcdef.png');
		expect(logoUrlFor('../etc/passwd')).toBeNull();
		expect(logoUrlFor(null)).toBeNull();
	});
});

describe('settings round-trip', () => {
	it('defaults when nothing is stored', async () => {
		expect(await getBranding(db)).toEqual({
			appName: DEFAULT_APP_NAME,
			shortName: DEFAULT_SHORT_NAME,
			logoKey: null,
			logoUrl: null
		});
	});

	it('saves names + logo, replaces and removes the logo', async () => {
		const bucket = fakeBucket();
		const res = await actions.saveBranding(actionEv(form({ app_name: 'Acme Mail', app_short_name: 'Acme' }, PNG), admin, bucket));
		expect(res).toEqual({ brandingSaved: true });
		const b = await getBranding(db);
		expect(b.appName).toBe('Acme Mail');
		expect(b.shortName).toBe('Acme');
		expect(b.logoKey).toMatch(/^branding\/logo-[a-f0-9]{16}\.png$/);
		expect(b.logoUrl).toBe(`/img/${b.logoKey}`);
		expect(bucket.store.has(b.logoKey!)).toBe(true);

		// Saving without a file keeps the logo; blank names fall back to defaults.
		await actions.saveBranding(actionEv(form({ app_name: '', app_short_name: '' }), admin, bucket));
		const kept = await getBranding(db);
		expect(kept).toMatchObject({ appName: DEFAULT_APP_NAME, shortName: DEFAULT_SHORT_NAME, logoKey: b.logoKey });

		// A new logo replaces (and deletes) the old object.
		const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'l.svg', { type: 'image/svg+xml' });
		await actions.saveBranding(actionEv(form({}, svg), admin, bucket));
		const next = await getBranding(db);
		expect(next.logoKey).toMatch(/\.svg$/);
		expect(bucket.store.has(b.logoKey!)).toBe(false);

		await actions.removeLogo(actionEv(new FormData(), admin, bucket));
		expect((await getBranding(db)).logoUrl).toBeNull();
		expect(bucket.store.size).toBe(0);
	});

	it('rejects bad input without writing anything', async () => {
		const bucket = fakeBucket();
		const long = (await actions.saveBranding(actionEv(form({ app_name: 'x'.repeat(41) }), admin, bucket))) as any;
		expect(long.status).toBe(400);
		const jpg = new File([new Uint8Array([1, 2])], 'l.jpg', { type: 'image/jpeg' });
		expect(((await actions.saveBranding(actionEv(form({}, jpg), admin, bucket))) as any).status).toBe(415);
		const big = new File([new Uint8Array(512 * 1024 + 1)], 'l.png', { type: 'image/png' });
		expect(((await actions.saveBranding(actionEv(form({}, big), admin, bucket))) as any).status).toBe(413);
		const evil = new File(['<svg><script>x</script></svg>'], 'l.svg', { type: 'image/svg+xml' });
		expect(((await actions.saveBranding(actionEv(form({}, evil), admin, bucket))) as any).status).toBe(400);
		expect(bucket.store.size).toBe(0);
		expect((await getBranding(db)).appName).toBe(DEFAULT_APP_NAME);
	});

	it('is admin-only', async () => {
		const res = (await actions.saveBranding(actionEv(form({ app_name: 'Nope' }), member, fakeBucket()))) as any;
		expect(res.status).toBe(403);
		expect(((await actions.removeLogo(actionEv(new FormData(), member))) as any).status).toBe(403);
		expect((await getBranding(db)).appName).toBe(DEFAULT_APP_NAME);
	});
});

describe('layout load', () => {
	it('exposes branding (defaults without a DB, stored values with one)', async () => {
		const bare = (await layoutLoad({ locals: { authed: false }, depends: () => {} } as any)) as any;
		expect(bare.branding).toMatchObject({ appName: DEFAULT_APP_NAME, shortName: DEFAULT_SHORT_NAME, logoUrl: null });

		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('app_name', 'Acme Mail'), ('logo_key', 'branding/logo-0123456789abcdef.webp')`)
			.run();
		const data = (await layoutLoad({ locals: { authed: true }, platform: { env }, depends: () => {} } as any)) as any;
		expect(data.branding).toEqual({
			appName: 'Acme Mail',
			shortName: DEFAULT_SHORT_NAME,
			logoKey: 'branding/logo-0123456789abcdef.webp',
			logoUrl: '/img/branding/logo-0123456789abcdef.webp'
		});
	});

	it('the header logo links to the dashboard', () => {
		expect(BRAND_HREF).toBe('/');
		expect(brandLinkLabel('Acme Mail')).toBe('Acme Mail — dashboard');
	});
});

describe('manifest', () => {
	async function getManifest() {
		const res = await manifestGET({ locals: {}, platform: { env } } as any);
		expect(res.headers.get('cache-control')).toBe('public, max-age=300');
		expect(res.headers.get('content-type')).toContain('application/manifest+json');
		return (await res.json()) as any;
	}

	it('uses the defaults and bundled icons without a logo', async () => {
		const m = await getManifest();
		expect(m).toMatchObject({ name: DEFAULT_APP_NAME, short_name: DEFAULT_SHORT_NAME, start_url: '/', display: 'standalone' });
		expect(m.icons.map((i: any) => i.src)).toEqual(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']);
	});

	it('uses the uploaded PNG/WebP logo as the icon', async () => {
		await db
			.prepare(
				`INSERT INTO app_state (key, value) VALUES ('app_name', 'Acme Mail'), ('app_short_name', 'Acme'), ('logo_key', 'branding/logo-0123456789abcdef.png')`
			)
			.run();
		const m = await getManifest();
		expect(m.name).toBe('Acme Mail');
		expect(m.short_name).toBe('Acme');
		expect(m.icons).toEqual([{ src: '/img/branding/logo-0123456789abcdef.png', sizes: 'any', type: 'image/png', purpose: 'any' }]);
	});

	it('keeps the bundled icons for an SVG logo', () => {
		const m = buildManifest({
			appName: 'A',
			shortName: 'A',
			logoKey: 'branding/logo-0123456789abcdef.svg',
			logoUrl: '/img/branding/logo-0123456789abcdef.svg'
		});
		expect(m.icons[0].src).toBe('/icons/icon-192.png');
	});

	it('is not cached by the service worker', () => {
		const policy = swPolicyFor({
			url: new URL('https://app.example/manifest.webmanifest'),
			method: 'GET',
			mode: 'cors',
			origin: 'https://app.example',
			precached: () => false
		});
		expect(policy).toBe('passthrough');
	});
});

describe('logo route', () => {
	it('serves branding keys only, with a sandbox CSP for SVG', async () => {
		const bucket = fakeBucket();
		await bucket.put('branding/logo-0123456789abcdef.svg', new TextEncoder().encode('<svg/>').buffer as ArrayBuffer, {
			httpMetadata: { contentType: 'image/svg+xml' }
		});
		const ev = (file: string) => ({ params: { file }, platform: { env: { MEDIA: bucket } } }) as any;
		const res = await logoGET(ev('logo-0123456789abcdef.svg'));
		expect(res.headers.get('content-type')).toBe('image/svg+xml');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		await expect(logoGET(ev('../secret.png'))).rejects.toMatchObject({ status: 404 });
		await expect(logoGET(ev('logo-ffffffffffffffff.png'))).rejects.toMatchObject({ status: 404 });
	});
});
